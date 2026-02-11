/**
 * Module: agent-priming
 *
 * Best-effort Agent Priming prelude generation for new dialogs.
 */
import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Dialog, RootDialog, SubDialog } from './dialog';
import {
  clearActiveRun,
  computeIdleRunState,
  createActiveRun,
  getStopRequestedReason,
  hasActiveRun,
  setDialogRunState,
} from './dialog-run-state';
import type { ChatMessage } from './llm/client';
import { driveDialogStream, emitSayingEvents } from './llm/driver-entry';
import { log } from './log';
import { getWorkLanguage } from './shared/runtime-language';
import type { LanguageCode } from './shared/types/language';
import type { DialogRunState } from './shared/types/run-state';
import { generateShortId } from './shared/utils/id';
import { formatAssignmentFromSupdialog } from './shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from './shared/utils/time';
import { Team } from './team';

type AgentPrimingCacheEntry = Readonly<{
  createdAt: string;
  workLanguage: LanguageCode;
  shellPolicy: 'specialist_only' | 'no_specialist' | 'self_is_specialist';
  shell:
    | Readonly<{
        kind: 'specialist_tellask';
        specialistId: string;
        tellaskBody: string;
        responseText: string;
        snapshotText: string;
      }>
    | Readonly<{
        kind: 'direct_shell';
        directNoteMarkdown: string;
        snapshotText: string;
      }>;
  vcs: Readonly<
    | {
        kind: 'specialist_session';
        specialistId: string;
        sessionSlug: string;
        round1: Readonly<{
          tellaskBody: string;
          responseText: string;
        }>;
        round2: Readonly<{
          tellaskBody: string;
          responseText: string;
        }>;
        inventoryText: string;
      }
    | {
        kind: 'runtime_inventory';
        round1NoteMarkdown: string;
        round2NoteMarkdown: string;
        inventoryText: string;
      }
  >;
  fbr: Readonly<{
    mentionList: string[];
    tellaskContent: string;
    selfTeaser: string;
    responderAgentId: string;
    effort: number;
    responses: ReadonlyArray<string>;
  }>;
  primingNote: string;
}>;

const BASELINE_ENV_SNAPSHOT_CMD = 'uname -a';
const PRIMING_VCS_SESSION_SLUG = 'rtws-vcs-inventory';

const cacheByAgentId: Map<string, AgentPrimingCacheEntry> = new Map();
const inflightByAgentId: Map<string, Promise<AgentPrimingCacheEntry | null>> = new Map();

type AgentPrimingStopReason = 'user_stop' | 'emergency_stop';

class AgentPrimingInterruptedError extends Error {
  public readonly reason: AgentPrimingStopReason;

  constructor(reason: AgentPrimingStopReason) {
    super(`Agent Priming interrupted: ${reason}`);
    this.name = 'AgentPrimingInterruptedError';
    this.reason = reason;
  }
}

function isAgentPrimingInterruptedError(error: unknown): error is AgentPrimingInterruptedError {
  return error instanceof AgentPrimingInterruptedError;
}

function throwIfAgentPrimingStopped(dlg: Dialog, abortSignal: AbortSignal): void {
  if (!abortSignal.aborted) {
    return;
  }
  const reason = getStopRequestedReason(dlg.id);
  if (reason === 'emergency_stop' || reason === 'user_stop') {
    throw new AgentPrimingInterruptedError(reason);
  }
  throw new AgentPrimingInterruptedError('user_stop');
}

export type AgentPrimingCacheStatus = Readonly<
  { hasCache: false } | { hasCache: true; createdAt: string; ageSeconds: number }
>;

export type AgentPrimingMode = 'do' | 'reuse' | 'skip';

async function emitSayingEventsAndPersist(
  dlg: Dialog,
  content: string,
): Promise<void> {
  await emitSayingEvents(dlg, content);
  const genseq = dlg.activeGenSeqOrUndefined;
  if (
    dlg.generationStarted &&
    typeof genseq === 'number' &&
    Number.isFinite(genseq) &&
    genseq > 0 &&
    content.trim()
  ) {
    try {
      await dlg.persistAgentMessage(content, genseq, 'saying_msg');
    } catch (err: unknown) {
      log.warn('Failed to persist Agent Priming synthetic saying content (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
}

type AgentPrimingSyntheticTellaskCall = Readonly<{
  callId: string;
  mentionList: string[];
  tellaskContent: string;
}>;

async function emitSyntheticTellaskCall(
  dlg: Dialog,
  payload: {
    mentionList: string[];
    tellaskContent: string;
    callId?: string;
  },
): Promise<AgentPrimingSyntheticTellaskCall> {
  const mentionList = payload.mentionList.map((value) => value.trim()).filter((value) => value !== '');
  if (mentionList.length < 1) {
    throw new Error('emitSyntheticTellaskCall requires at least one mention');
  }
  const callId = payload.callId?.trim() ? payload.callId.trim() : `priming-${generateShortId()}`;
  await dlg.callingStart({
    callId,
    mentionList,
    tellaskContent: payload.tellaskContent,
  });
  return {
    callId,
    mentionList,
    tellaskContent: payload.tellaskContent,
  };
}

async function emitUiOnlyMarkdownEventsAndPersist(dlg: Dialog, content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();

  const genseq = dlg.activeGenSeqOrUndefined;
  if (
    dlg.generationStarted &&
    typeof genseq === 'number' &&
    Number.isFinite(genseq) &&
    genseq > 0
  ) {
    try {
      await dlg.persistUiOnlyMarkdown(content, genseq);
    } catch (err: unknown) {
      log.warn('Failed to persist UI-only markdown (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
}

function parseUnifiedTimestamp(value: string): Date | null {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }
  return new Date(year, month - 1, day, hour, minute, second);
}

export function getAgentPrimingCacheStatus(agentId: string): AgentPrimingCacheStatus {
  const entry = cacheByAgentId.get(agentId);
  if (!entry) return { hasCache: false };
  const createdAt = entry.createdAt;
  const parsed = parseUnifiedTimestamp(createdAt);
  const ageSeconds =
    parsed === null ? 0 : Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  return { hasCache: true, createdAt, ageSeconds };
}

export function resolveInheritedSubdialogAgentPrimingMode(
  requestedMode: AgentPrimingMode,
  agentId: string,
): AgentPrimingMode {
  if (requestedMode === 'skip') return 'skip';
  if (requestedMode === 'reuse') return 'reuse';
  const hasCache = cacheByAgentId.has(agentId);
  // "do" without cache means "show it once now"; subdialogs may still reuse once cache appears.
  return hasCache ? 'do' : 'reuse';
}

export function scheduleAgentPrimingForNewDialog(
  dlg: Dialog,
  options: { mode: AgentPrimingMode },
): Promise<void> {
  if (options.mode === 'skip') return Promise.resolve();

  const agentId = dlg.agentId;
  const existing = cacheByAgentId.get(agentId);
  if (options.mode === 'reuse' && existing) {
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(existing));
    return replayAgentPriming(dlg, existing);
  }

  const inflight = inflightByAgentId.get(agentId);
  if (inflight) {
    return inflight.then((entry) => {
      if (options.mode === 'reuse' && entry) {
        dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
        return replayAgentPriming(dlg, entry);
      }
      // mode === 'do': wait for in-flight then run again for this dialog.
      if (options.mode === 'do') {
        return runAgentPrimingLive(dlg)
          .then((next) => {
            cacheByAgentId.set(agentId, next);
          })
          .catch((err: unknown) => {
            if (isAgentPrimingInterruptedError(err)) {
              log.info('Agent Priming interrupted; will retry on next dialog', undefined, {
                agentId,
                reason: err.reason,
              });
            } else {
              log.warn('Agent Priming live run failed; will retry on next dialog', err, {
                agentId,
              });
            }
            return undefined;
          });
      }
      return Promise.resolve();
    });
  }

  const task = runAgentPrimingLive(dlg)
    .then((entry) => {
      cacheByAgentId.set(agentId, entry);
      return entry;
    })
    .catch((err: unknown) => {
      // Best-effort: avoid unhandled rejections; the dialog itself is already marked interrupted.
      if (isAgentPrimingInterruptedError(err)) {
        log.info('Agent Priming interrupted; will retry on next dialog', undefined, {
          agentId,
          reason: err.reason,
        });
      } else {
        log.warn('Agent Priming live run failed; will retry on next dialog', err, { agentId });
      }
      return null;
    })
    .finally(() => {
      inflightByAgentId.delete(agentId);
    });
  inflightByAgentId.set(agentId, task);
  return task.then(() => undefined);
}

function takeFirstNonEmptyLine(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function extractLastAssistantSaying(messages: Array<{ type: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'saying_msg' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'thinking_msg' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
  }
  return '';
}

function extractLastShellCmdResultText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    if (!('type' in msg) || !('name' in msg) || !('content' in msg)) continue;
    const type = (msg as { type: unknown }).type;
    const name = (msg as { name: unknown }).name;
    const content = (msg as { content: unknown }).content;
    if (type !== 'func_result_msg') continue;
    if (name !== 'shell_cmd') continue;
    if (typeof content !== 'string') continue;
    if (!content.trim()) continue;
    return content;
  }
  return null;
}

async function runUnameA(): Promise<string> {
  return await new Promise<string>((resolveUname) => {
    const child = spawn('uname', ['-a'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (buf: Buffer) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf: Buffer) => {
      err += buf.toString();
    });
    child.on('close', (code) => {
      const trimmedOut = out.trim();
      const trimmedErr = err.trim();
      if (code === 0 && trimmedOut) {
        resolveUname(trimmedOut);
        return;
      }
      const fallback = trimmedErr ? trimmedErr : `uname exited with code ${String(code)}`;
      resolveUname(fallback);
    });
    child.on('error', (e) => {
      resolveUname(e instanceof Error ? e.message : String(e));
    });
  });
}

type ExecResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorText?: string;
}>;

async function runCommand(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolveExec) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (buf: Buffer) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf: Buffer) => {
      err += buf.toString();
    });
    child.on('close', (code) => {
      resolveExec({
        ok: code === 0,
        stdout: out.trim(),
        stderr: err.trim(),
        exitCode: code,
      });
    });
    child.on('error', (e) => {
      resolveExec({
        ok: false,
        stdout: out.trim(),
        stderr: err.trim(),
        exitCode: null,
        errorText: e instanceof Error ? e.message : String(e),
      });
    });
  });
}

async function runGit(args: string[], cwd: string): Promise<ExecResult> {
  return await runCommand('git', args, cwd);
}

async function isGitRepo(dir: string): Promise<boolean> {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
  return res.ok && res.stdout === 'true';
}

type RtwsRootGitPosition = Readonly<
  | { kind: 'not_git' }
  | { kind: 'repo_root'; topLevelAbsPath: string }
  | { kind: 'repo_subdir'; topLevelAbsPath: string; relFromTopLevel: string }
>;

async function inspectRtwsRootGitPosition(rtws: string): Promise<RtwsRootGitPosition> {
  // Equivalent to comparing:
  // - `git rev-parse --show-toplevel`
  // - `pwd`
  // to determine whether rtws itself is repo root vs a subdirectory of a repo.
  const showTopRes = await runGit(['rev-parse', '--show-toplevel'], rtws);
  if (!showTopRes.ok || !showTopRes.stdout) {
    return { kind: 'not_git' };
  }
  const rtwsAbs = path.resolve(rtws);
  const topLevelAbsPath = path.resolve(showTopRes.stdout);
  if (topLevelAbsPath === rtwsAbs) {
    return { kind: 'repo_root', topLevelAbsPath };
  }
  const relFromTopLevel = path.relative(topLevelAbsPath, rtwsAbs).replace(/\\/g, '/');
  return {
    kind: 'repo_subdir',
    topLevelAbsPath,
    relFromTopLevel: relFromTopLevel || '.',
  };
}

async function listSubmoduleRelPaths(rootDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await runGit(['submodule', 'status', '--recursive'], rootDir);
  if (!res.ok || !res.stdout) return out;
  const lines = res.stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^[+\-U ]?[0-9a-fA-F]+\s+([^\s]+)/);
    if (!m) continue;
    const rel = (m[1] ?? '').trim();
    if (!rel) continue;
    out.add(rel.replace(/\\/g, '/'));
  }
  return out;
}

async function findGitMarkerDirs(rootDir: string): Promise<string[]> {
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.pnpm-store',
    '.yarn',
    '.next',
    'dist',
    'build',
    'out',
    'target',
    '.cache',
  ]);
  const queue: string[] = [rootDir];
  const found = new Set<string>();
  const maxVisited = 20_000;
  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    visited += 1;
    if (visited > maxVisited) break;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const hasGitMarker = entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()));
    if (hasGitMarker) {
      found.add(current);
      if (current !== rootDir) {
        // Treat a nested repo as its own boundary to keep traversal bounded.
        continue;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirs.has(entry.name)) continue;
      const next = path.join(current, entry.name);
      queue.push(next);
    }
  }

  return Array.from(found);
}

type RepoStatusSummary = Readonly<{
  relPath: string;
  branch: string;
  upstream: string;
  remotes: string[];
  dirtyCount: number;
  headShort: string;
  statusError?: string;
}>;

type RtwsGitInventory = Readonly<{
  rootIsRepo: boolean;
  rootGitPosition: RtwsRootGitPosition;
  submoduleRelPaths: string[];
  nestedRepoRelPaths: string[];
  repoStatuses: RepoStatusSummary[];
}>;

async function collectRtwsGitInventory(): Promise<RtwsGitInventory> {
  const rtws = process.cwd();
  const rootGitPosition = await inspectRtwsRootGitPosition(rtws);
  const rootIsRepo = rootGitPosition.kind === 'repo_root';
  const markerDirs = await findGitMarkerDirs(rtws);
  const submoduleSet = rootIsRepo ? await listSubmoduleRelPaths(rtws) : new Set<string>();

  const repoAbsSet = new Set<string>();
  if (rootGitPosition.kind === 'repo_root' || rootGitPosition.kind === 'repo_subdir') {
    repoAbsSet.add(rtws);
  }
  for (const candidate of markerDirs) {
    if (candidate === rtws) continue;
    if (await isGitRepo(candidate)) {
      repoAbsSet.add(candidate);
    }
  }

  const allRepoAbs = Array.from(repoAbsSet).sort();
  const allRepoRel = allRepoAbs.map((abs) => {
    const rel = path.relative(rtws, abs).replace(/\\/g, '/');
    return rel === '' ? '.' : rel;
  });

  const submoduleRelPaths = allRepoRel.filter((rel) => submoduleSet.has(rel));
  const nestedRepoRelPaths = allRepoRel.filter((rel) => rel !== '.' && !submoduleSet.has(rel));

  const repoStatuses: RepoStatusSummary[] = [];
  const maxRepos = 40;
  for (let i = 0; i < Math.min(allRepoAbs.length, maxRepos); i++) {
    const repoAbs = allRepoAbs[i];
    const rel = allRepoRel[i] ?? '.';

    const branchRes = await runGit(['branch', '--show-current'], repoAbs);
    const headRes = await runGit(['rev-parse', '--short', 'HEAD'], repoAbs);
    const upstreamRes = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      repoAbs,
    );
    const remoteRes = await runGit(['remote', '-v'], repoAbs);
    const dirtyRes = await runGit(['status', '--porcelain'], repoAbs);

    const remotes = (() => {
      if (!remoteRes.ok || !remoteRes.stdout) return [] as string[];
      const lines = remoteRes.stdout.split('\n');
      const items = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^([^\s]+)\s+([^\s]+)\s+\((fetch|push)\)$/);
        if (!m) continue;
        const name = m[1] ?? '';
        const url = m[2] ?? '';
        const kind = m[3] ?? '';
        if (!name || !url || !kind) continue;
        items.add(`${name}:${kind}=${url}`);
      }
      return Array.from(items).sort();
    })();

    const dirtyCount = (() => {
      if (!dirtyRes.ok || !dirtyRes.stdout) return 0;
      return dirtyRes.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0).length;
    })();

    const statusErrorParts: string[] = [];
    if (!branchRes.ok) statusErrorParts.push(`branch: ${branchRes.errorText ?? branchRes.stderr}`);
    if (!headRes.ok) statusErrorParts.push(`head: ${headRes.errorText ?? headRes.stderr}`);
    if (!remoteRes.ok) statusErrorParts.push(`remote: ${remoteRes.errorText ?? remoteRes.stderr}`);
    if (!dirtyRes.ok) statusErrorParts.push(`status: ${dirtyRes.errorText ?? dirtyRes.stderr}`);

    repoStatuses.push({
      relPath: rel,
      branch: branchRes.ok && branchRes.stdout ? branchRes.stdout : '(detached-or-unknown)',
      upstream:
        upstreamRes.ok && upstreamRes.stdout ? upstreamRes.stdout : '(no-upstream-or-unavailable)',
      remotes,
      dirtyCount,
      headShort: headRes.ok && headRes.stdout ? headRes.stdout : '(unknown)',
      statusError: statusErrorParts.length > 0 ? statusErrorParts.join('; ') : undefined,
    });
  }

  return {
    rootIsRepo,
    rootGitPosition,
    submoduleRelPaths,
    nestedRepoRelPaths,
    repoStatuses,
  };
}

function formatRtwsGitInventoryRound1(language: LanguageCode, inventory: RtwsGitInventory): string {
  const relationLineZh = (() => {
    if (inventory.rootGitPosition.kind === 'repo_root') {
      return '- rtws 与 git 关系：rtws 本身就是 repo 根路径';
    }
    if (inventory.rootGitPosition.kind === 'repo_subdir') {
      return [
        '- rtws 与 git 关系：rtws 是某个 repo 的子目录（rtws 本身不是 repo 根）',
        `- 上级 repo 顶层：${inventory.rootGitPosition.topLevelAbsPath}`,
        `- rtws 相对上级 repo 路径：${inventory.rootGitPosition.relFromTopLevel}`,
      ].join('\n');
    }
    return '- rtws 与 git 关系：不在任何 git worktree 内';
  })();
  const relationLineEn = (() => {
    if (inventory.rootGitPosition.kind === 'repo_root') {
      return '- rtws vs git: rtws itself is the repo root';
    }
    if (inventory.rootGitPosition.kind === 'repo_subdir') {
      return [
        '- rtws vs git: rtws is a subdirectory inside a repo (rtws itself is not the repo root)',
        `- enclosing repo top-level: ${inventory.rootGitPosition.topLevelAbsPath}`,
        `- rtws path relative to repo root: ${inventory.rootGitPosition.relFromTopLevel}`,
      ].join('\n');
    }
    return '- rtws vs git: not inside any git worktree';
  })();

  if (language === 'zh') {
    const submoduleText =
      inventory.submoduleRelPaths.length < 1
        ? '无'
        : inventory.submoduleRelPaths.map((p) => `- ${p}`).join('\n');
    const nestedText =
      inventory.nestedRepoRelPaths.length < 1
        ? '无'
        : inventory.nestedRepoRelPaths.map((p) => `- ${p}`).join('\n');
    return [
      'VCS 长线诉请 Round-1（rtws 仓库拓扑）',
      '',
      `- 根路径是否 git repo：${inventory.rootIsRepo ? '是' : '否'}`,
      relationLineZh,
      `- submodule 数量：${inventory.submoduleRelPaths.length}`,
      `- 子目录独立 repo 数量：${inventory.nestedRepoRelPaths.length}`,
      '',
      'submodule 列表：',
      submoduleText,
      '',
      '子目录独立 repo 列表：',
      nestedText,
    ].join('\n');
  }

  const submoduleText =
    inventory.submoduleRelPaths.length < 1
      ? 'none'
      : inventory.submoduleRelPaths.map((p) => `- ${p}`).join('\n');
  const nestedText =
    inventory.nestedRepoRelPaths.length < 1
      ? 'none'
      : inventory.nestedRepoRelPaths.map((p) => `- ${p}`).join('\n');
  return [
    'VCS Tellask Session Round-1 (rtws repo topology)',
    '',
    `- Root path is git repo: ${inventory.rootIsRepo ? 'yes' : 'no'}`,
    relationLineEn,
    `- Submodule count: ${inventory.submoduleRelPaths.length}`,
    `- Nested independent repo count: ${inventory.nestedRepoRelPaths.length}`,
    '',
    'Submodule list:',
    submoduleText,
    '',
    'Nested independent repo list:',
    nestedText,
  ].join('\n');
}

function formatRtwsGitInventoryRound2(language: LanguageCode, inventory: RtwsGitInventory): string {
  const rows = inventory.repoStatuses.map((repo, idx) => {
    const remotes = repo.remotes.length < 1 ? '(none)' : repo.remotes.join(', ');
    if (language === 'zh') {
      return [
        `${idx + 1}. repo: ${repo.relPath}`,
        `   - head: ${repo.headShort}`,
        `   - branch: ${repo.branch}`,
        `   - upstream: ${repo.upstream}`,
        `   - dirty: ${repo.dirtyCount > 0 ? `yes (${repo.dirtyCount})` : 'no'}`,
        `   - remotes: ${remotes}`,
        repo.statusError ? `   - errors: ${repo.statusError}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }
    return [
      `${idx + 1}. repo: ${repo.relPath}`,
      `   - head: ${repo.headShort}`,
      `   - branch: ${repo.branch}`,
      `   - upstream: ${repo.upstream}`,
      `   - dirty: ${repo.dirtyCount > 0 ? `yes (${repo.dirtyCount})` : 'no'}`,
      `   - remotes: ${remotes}`,
      repo.statusError ? `   - errors: ${repo.statusError}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  });

  if (language === 'zh') {
    return [
      'VCS 长线诉请 Round-2（每个 repo 的 remote / branch 现状）',
      '',
      rows.length < 1 ? '未发现可报告的 repo。' : rows.join('\n\n'),
    ].join('\n');
  }
  return [
    'VCS Tellask Session Round-2 (remote / branch status per repo)',
    '',
    rows.length < 1 ? 'No repos available to report.' : rows.join('\n\n'),
  ].join('\n');
}

function formatPreludeIntro(
  language: LanguageCode,
  reused: boolean,
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'],
  shellSpecialistId: string | null,
): string {
  if (
    shellPolicy === 'specialist_only' &&
    (!shellSpecialistId || shellSpecialistId.trim() === '')
  ) {
    throw new Error('Missing shell specialist id for specialist_only prelude');
  }
  const shellSpecialistMention =
    shellSpecialistId && shellSpecialistId.trim() ? `@${shellSpecialistId.trim()}` : '';
  const shellPolicyLinesZh: string[] =
    shellPolicy === 'specialist_only'
      ? [
          `规则：此智能体**不执行任何 shell 命令**。所有 shell 命令必须由 shell 专员（${shellSpecialistMention}）执行并回传。`,
          `下面将诉请 shell 专员（${shellSpecialistMention}）仅执行一个低风险命令：\`uname -a\`。`,
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            '本次对话主理人属于 `shell_specialists`，将略去 shell 诉请环节。',
            '由 Dominds 运行时获取标准环境事实（`uname -a` + rtws git 现状），随后进入 `self-route tellask` FBR。',
          ]
        : [
            '本团队未配置 shell 专员。',
            '这是标准支持模式：由 Dominds 运行时主动获取环境事实（`uname -a` + rtws git 现状）并用于后续 FBR。',
            '规则：此智能体仍然不得自行执行任意 shell 命令。',
          ];

  const shellPolicyLinesEn: string[] =
    shellPolicy === 'specialist_only'
      ? [
          `Rule: this agent must **not run any shell commands**. All shell commands must be executed by the shell specialist (${shellSpecialistMention}) and returned.`,
          `Next, we Tellask the shell specialist (${shellSpecialistMention}) to run one low-risk command only: \`uname -a\`.`,
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            'The dialog owner is a member of `shell_specialists`, so we skip the shell Tellask step.',
            'Dominds runtime collects standard environment facts (`uname -a` + rtws git state), then we enter `self-route tellask` FBR.',
          ]
        : [
            'This team has no configured shell specialist.',
            'This is a standard support mode: Dominds runtime proactively collects environment facts (`uname -a` + rtws git state) for FBR.',
            'Rule: this agent still must not run arbitrary shell commands directly.',
          ];

  if (language === 'zh') {
    return reused
      ? [
          '## Prelude：智能体启动（复用缓存）',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR + 综合提炼”变成体感（引导祂做给自己看）。',
          '关键时序：`self-route tellask` 只表示发起；必须等待 FBR 支线回贴返回后，才在主线做综合决策。',
          '本次对话复用了本进程内缓存：未重复执行命令。',
          '',
          ...shellPolicyLinesZh,
          '',
        ].join('\n')
      : [
          '## Prelude：智能体启动',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR + 综合提炼”变成体感（引导祂做给自己看）。',
          '关键时序：`self-route tellask` 只表示发起；必须等待 FBR 支线回贴返回后，才在主线做综合决策。',
          '',
          ...shellPolicyLinesZh,
          '',
        ].join('\n');
  }
  return reused
    ? [
        '## Prelude: Agent Priming (Reused)',
        '',
        'This prelude makes Tellask + return + FBR + distillation feel real (guiding the agent to show it to itself).',
        'Critical timing: `self-route tellask` is initiation only; mainline distillation/decision happens only after FBR sideline feedback returns.',
        'This dialog reused the in-process cache (no commands were re-run).',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n')
    : [
        '## Prelude: Agent Priming',
        '',
        'This prelude makes Tellask + return + FBR + distillation feel real (guiding the agent to show it to itself).',
        'Critical timing: `self-route tellask` is initiation only; mainline distillation/decision happens only after FBR sideline feedback returns.',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n');
}

function formatShellTellaskBody(language: LanguageCode, shellSpecialistId: string): string {
  const shellSpecialistMention = `@${shellSpecialistId.trim()}`;
  if (language === 'zh') {
    return [
      `你是 shell 专员（${shellSpecialistMention}）：请代我执行 \`uname -a\` 获取当前运行环境的基本信息。`,
      '',
      '背景规则：对话主理人不得执行任何 shell 命令；所有 shell 命令必须通过你执行并回传。',
      '请不要建议我“自己在本地跑一下”。',
      '收到回传后，我会基于该环境信息发起一次 `self-route tellask` 扪心自问（FBR），先等待该次 FBR 的全部支线回贴，再在主线做综合提炼并形成一条可复用的“智能体启动（Agent Priming）”笔记。',
      '',
      '要求：',
      '- 通过 shell 工具执行：uname -a（只执行这一条）',
      '- 原样返回输出（不要改写/解释）',
      '- 若命令不可用/失败：返回错误信息，并给出一个安全的替代命令',
      '',
      '输出格式：优先只给出原始输出，其次才是必要的简短说明。',
    ].join('\n');
  }
  return [
    `You are the shell specialist (${shellSpecialistMention}): please run \`uname -a\` on my behalf to capture the basic runtime environment.`,
    '',
    'Rule: the dialog owner must not run any shell commands; all shell commands must be executed by you and returned.',
    'Do not suggest that I “just run it locally”.',
    'After I receive your output, I will initiate `self-route tellask` Fresh Boots Reasoning (FBR) on this environment, wait for all feedback from that FBR run, then distill a reusable “Agent Priming” note in mainline.',
    '',
    'Requirements:',
    '- Use shell tools to run exactly: uname -a (and only this command)',
    '- Return the raw output verbatim (no paraphrase)',
    '- If the command fails: include the error and suggest one safe alternative command',
    '',
    'Output format: prefer raw output only; keep any explanation minimal.',
  ].join('\n');
}

function formatVcsSessionRound1TellaskBody(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      `这是同一长线诉请（session: ${PRIMING_VCS_SESSION_SLUG}）的 Round-1，请你只做仓库拓扑盘点。`,
      '',
      '在当前 rtws 中确认：',
      '- 根路径是否是 git repo',
      '- 是否存在 submodule（给出路径列表）',
      '- 是否存在子目录独立 repo（给出路径列表）',
      '',
      '要求：',
      '- 只使用 git / find 命令采集事实；不要用 python/node/perl 等脚本探测',
      '- 建议命令：`git rev-parse --is-inside-work-tree`、`git submodule status --recursive`、`find . -name .git`',
      '- 仅做事实盘点，不做下一步建议',
      '- 输出必须短且结构化，便于我在 Round-2 继续诉请',
    ].join('\n');
  }
  return [
    `This is Round-1 of the same Tellask Session (${PRIMING_VCS_SESSION_SLUG}); do topology inventory only.`,
    '',
    'In the current rtws, confirm:',
    '- whether the root path is a git repo',
    '- whether submodules exist (with path list)',
    '- whether nested independent repos exist (with path list)',
    '',
    'Requirements:',
    '- use git/find commands only; do not use python/node/perl scripts for discovery',
    '- suggested commands: `git rev-parse --is-inside-work-tree`, `git submodule status --recursive`, `find . -name .git`',
    '- facts only, no next-step suggestions',
    '- keep output short and structured so I can continue in Round-2',
  ].join('\n');
}

function formatVcsSessionRound2TellaskBody(language: LanguageCode, round1Response: string): string {
  const round1Anchor = takeFirstNonEmptyLine(round1Response) ?? '(empty)';
  if (language === 'zh') {
    return [
      `这是同一长线诉请（session: ${PRIMING_VCS_SESSION_SLUG}）的 Round-2。Round-1 已结束，本轮是新的续推诉请。`,
      `Round-1 摘要锚点：${round1Anchor}`,
      '',
      '请继续确认 Round-1 涉及到的每一个 repo：',
      '- remote（fetch/push）现状',
      '- 当前 branch / upstream 现状',
      '- 工作区是否脏（可给简要计数）',
      '',
      '要求：',
      '- 只使用 git 命令逐 repo 采集，不要用 python/node/perl',
      '- 建议命令：`git -C <repo> remote -v`、`git -C <repo> branch --show-current`、`git -C <repo> rev-parse --abbrev-ref --symbolic-full-name @{upstream}`、`git -C <repo> status --porcelain`',
      '- 覆盖全部 repo；缺失时明确写 unavailable',
      '- 输出保持结构化与简短，不扩展到修复建议',
    ].join('\n');
  }
  return [
    `This is Round-2 of the same Tellask Session (${PRIMING_VCS_SESSION_SLUG}). Round-1 is closed; this is a new continuation Tellask.`,
    `Round-1 anchor: ${round1Anchor}`,
    '',
    'For every repo covered by Round-1, continue with:',
    '- remote status (fetch/push)',
    '- current branch / upstream status',
    '- whether working tree is dirty (brief count is enough)',
    '',
    'Requirements:',
    '- use git commands repo-by-repo; do not use python/node/perl scripts',
    '- suggested commands: `git -C <repo> remote -v`, `git -C <repo> branch --show-current`, `git -C <repo> rev-parse --abbrev-ref --symbolic-full-name @{upstream}`, `git -C <repo> status --porcelain`',
    '- cover all repos; mark unavailable when missing',
    '- keep output structured and short; do not expand into fix proposals',
  ].join('\n');
}

function formatRuntimeVcsRoundNote(language: LanguageCode, round: 1 | 2, content: string): string {
  if (language === 'zh') {
    return [
      `由 Dominds 运行时执行 VCS 盘点 Round-${round}（标准模式，非降级）：`,
      '',
      content,
      '',
    ].join('\n');
  }
  return [
    `Dominds runtime VCS inventory Round-${round} (standard mode, not degraded):`,
    '',
    content,
    '',
  ].join('\n');
}

function formatFbrSelfTeaser(language: LanguageCode): string {
  if (language === 'zh') {
    return '（我会先等待该次 FBR 的全部支线反馈返回；在收齐前不做最终行动决策。收齐后再综合提炼，并在主线对话中输出一条可复用的“智能体启动（Agent Priming）”笔记。）';
  }
  return '(I will first wait for all feedback from this FBR run and will not finalize next-action decisions before that. After all feedback returns, I will distill it into a reusable “Agent Priming” note in mainline.)';
}

function formatFbrTellaskBody(
  language: LanguageCode,
  snapshotText: string,
  options: { fbrEffort: number },
): string {
  const effortLineZh =
    options.fbrEffort >= 1
      ? '对话设定：你现在是被唤起的一份“初心自我”。术语映射：在本 FBR 支线中，你是被诉请者（tellaskee，初心自我）；诉请者（tellasker）就是外表自我（当前主线）。同一轮里还会有其他“初心自我”并行给出草稿（彼此没有稳定映射关系，不要当作固定身份）。外表自我会在收齐全部回贴后再统一决策；你只需给出这一份独立分析，不要替外表自我下最终行动决策。'
      : '对话设定：当前成员未启用 FBR（无并行“初心自我”草稿）。';
  const effortLineEn =
    options.fbrEffort >= 1
      ? 'Conversation setup: you are one awakened “fresh-boots self.” Terminology mapping: in this FBR sideline, you are the tellaskee (the fresh-boots self), and the tellasker is the outer self (current mainline). In this same round, other fresh-boots selves also provide parallel drafts (no stable mapping—do not treat them as fixed identities). The outer self will make unified decisions only after all feedback returns; provide only this one independent draft and do not finalize next-action decisions for the outer self.'
      : 'Conversation setup: FBR is disabled for this member (no parallel fresh-boots drafts).';

  const tellaskBackHintZh = (() => {
    return [
      '提示：如果你还想知道更多系统细节，可在本 FBR 支线对话中用 `tellaskBack` 回问诉请者（tellasker，也就是外表自我/当前主线）。',
      '（当前这次 FBR 请不要真的发起任何诉请；只需说明你会回问什么。）',
    ].join('\n');
  })();

  const tellaskBackHintEn = (() => {
    return [
      'Hint: if you want more system details, ask back in this FBR sideline dialog via `tellaskBack` (to the tellasker, i.e. the outer-self mainline dialog).',
      '(In this FBR run, do not actually emit any tellasks; just state what you would ask back.)',
    ].join('\n');
  })();

  if (language === 'zh') {
    return [
      effortLineZh,
      '',
      tellaskBackHintZh,
      '',
      '请基于下面环境信息回答：',
      '- 在这个环境里要注意些什么？',
      '- 哪些关键上下文仍然缺失？',
      '- 请明确区分：事实依据 / 不确定项 / 建议下一步（供诉请者 tellasker（外表自我）在收齐草稿后综合提炼）。',
      '',
      '环境信息（由诉请者 tellasker（外表自我）提供的当前环境快照）：',
      snapshotText,
    ].join('\n');
  }
  return [
    effortLineEn,
    '',
    tellaskBackHintEn,
    '',
    'Based on the environment info below, answer:',
    '- What should we watch out for in this environment?',
    '- What critical context is still missing?',
    '- Clearly separate: factual evidence / uncertainties / suggested next step (for tellasker / outer-self distillation after all drafts return).',
    '',
    'Environment info (the current snapshot provided by the tellasker / outer self):',
    snapshotText,
  ].join('\n');
}

async function generatePrimingNoteViaMainlineAgent(options: {
  dlg: Dialog;
  shellSnapshotText: string;
  shellResponseText?: string;
  vcsRound1Text?: string;
  vcsRound2Text?: string;
  fbrResponses: ReadonlyArray<{ subdialogId: string; response: string }>;
  fbrMentionList: string[];
  fbrCallId: string;
  assertNotStopped?: () => void;
}): Promise<string> {
  const {
    dlg,
    shellSnapshotText,
    shellResponseText,
    vcsRound1Text,
    vcsRound2Text,
    fbrResponses,
    fbrMentionList,
    fbrCallId,
    assertNotStopped,
  } = options;

  // Trigger a normal drive and rely on driver.ts context assembly.
  // Agent Priming must not trigger Diligence Push (“鞭策”); it should be best-effort
  // one-shot distillation with no keep-going injection.
  const prevDisableDiligencePush = dlg.disableDiligencePush;
  try {
    dlg.disableDiligencePush = true;
    const beforeMsgs = dlg.msgs.length;
    const language = getWorkLanguage();

    // IMPORTANT: include shell snapshot + FBR drafts in the internal prompt itself.
    // - Must be non-persisted (persistMode: 'internal')
    // - Must be robust even if the driver loop iterates (context health remediation)
    // - Must avoid relying on the subdialog-response queue
    const evidenceParts: string[] = [];
    const snapshotTrimmed = shellSnapshotText.trim();
    if (snapshotTrimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['环境快照（来自 `uname -a`）：', snapshotTrimmed].join('\n')
          : ['Environment snapshot (from `uname -a`):', snapshotTrimmed].join('\n'),
      );
    }
    const shellReturnTrimmed =
      typeof shellResponseText === 'string' ? shellResponseText.trim() : '';
    if (shellReturnTrimmed && shellReturnTrimmed !== snapshotTrimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['Shell 反馈（完整回传）：', shellReturnTrimmed].join('\n')
          : ['Shell feedback (full return):', shellReturnTrimmed].join('\n'),
      );
    }
    const vcsRound1Trimmed = typeof vcsRound1Text === 'string' ? vcsRound1Text.trim() : '';
    if (vcsRound1Trimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['VCS Session Round-1 结果：', vcsRound1Trimmed].join('\n')
          : ['VCS session Round-1 result:', vcsRound1Trimmed].join('\n'),
      );
    }
    const vcsRound2Trimmed = typeof vcsRound2Text === 'string' ? vcsRound2Text.trim() : '';
    if (vcsRound2Trimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['VCS Session Round-2 结果：', vcsRound2Trimmed].join('\n')
          : ['VCS session Round-2 result:', vcsRound2Trimmed].join('\n'),
      );
    }

    const maxDrafts = Math.min(6, fbrResponses.length);
    for (let i = 0; i < maxDrafts; i++) {
      const r = fbrResponses[i];
      const trimmed = r.response.trim();
      if (!trimmed) continue;
      const cap = 4000;
      const capped =
        trimmed.length <= cap
          ? trimmed
          : language === 'zh'
            ? `${trimmed.slice(0, cap).trimEnd()}\n\n（已截断：仅显示前 ${cap} 字符）`
            : `${trimmed.slice(0, cap).trimEnd()}\n\n(truncated: first ${cap} chars only)`;

      const fbrLabel = (() => {
        const mentions = fbrMentionList.join(' ').trim();
        const callId = fbrCallId.trim();
        if (mentions && callId) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（mentionList: ${mentions}；callId: ${callId}）`
            : `FBR draft #${i + 1} (mentionList: ${mentions}; callId: ${callId})`;
        }
        if (mentions) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（mentionList: ${mentions}）`
            : `FBR draft #${i + 1} (mentionList: ${mentions})`;
        }
        if (callId) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（callId: ${callId}）`
            : `FBR draft #${i + 1} (callId: ${callId})`;
        }
        return language === 'zh' ? `FBR 草稿 #${i + 1}` : `FBR draft #${i + 1}`;
      })();
      evidenceParts.push([fbrLabel, capped].join('\n'));
    }
    const evidenceBlock = evidenceParts.length > 0 ? evidenceParts.join('\n\n---\n\n') : '';
    if (!evidenceBlock.trim()) {
      throw new Error(
        'Missing evidence for Agent Priming distillation (snapshot + FBR drafts are empty).',
      );
    }

    const internalPrompt =
      language === 'zh'
        ? [
            '你正在进行智能体启动（Agent Priming）的“综合提炼”步骤。',
            '你收到本提示时，意味着该次 `self-route tellask` FBR 的并发回贴已经收齐；本步骤只做综合提炼，不重新发起 FBR。',
            '请基于下方提供的环境快照（以及可选的 `self-route tellask` FBR 草稿），综合提炼出一条可复用的“智能体启动（Agent Priming）笔记”。',
            '',
            '证据材料（仅供综合提炼；不要逐条复述）：',
            evidenceBlock ? evidenceBlock : '（无）',
            '',
            '重要：只提炼“本次运行环境相关”的结论（例如：OS/架构、shell userland 差异、文件系统、端口/防火墙、全局链接/工具链等）。',
            '禁止：输出元话语、推理过程，或复述实现细节（例如 driver/缓存/持久化等）。',
            '若某条结论无法从环境快照或 FBR 草稿中直接支撑，请省略。',
            '',
            '要求：',
            '- 去重并消解冲突，只保留最关键的结论',
            '- 用 6~12 条 bullet points 输出（每条尽量短）',
            '- 只写结论要点；不要输出推理过程，也不要出现“我在考虑/我将要/让我们检查”等元话语',
            '- 必须明确写出：收到回贴代表该轮诉请结束；继续推进必须显式发起下一轮诉请',
          ].join('\n')
        : [
            'You are in the Agent Priming distillation step.',
            'Receiving this prompt means feedback from this `self-route tellask` FBR run has already been collected; this step is distillation only, not another FBR initiation.',
            'Based on the environment snapshot (and optional `self-route tellask` FBR drafts) below, distill a reusable “Agent Priming note”.',
            '',
            'Evidence (for distillation only; do not repeat draft-by-draft):',
            evidenceBlock ? evidenceBlock : '(empty)',
            '',
            'Important: output only conclusions about this runtime environment (e.g., OS/arch, shell userland differences, filesystem behavior, ports/firewall, global links/toolchain).',
            'Do NOT include meta talk, reasoning narration, or implementation details (e.g. driver/caching/persistence).',
            'If a point is not directly supported by the environment snapshot or the FBR drafts, omit it.',
            '',
            'Requirements:',
            '- Dedupe and reconcile conflicts; keep only the key conclusions',
            '- Output 6–12 concise bullet points',
            '- Conclusion bullets only; no reasoning narration or meta talk (e.g. “I think / I will / let’s inspect”)',
            '- Explicitly include this rule: a delivered response closes the current Tellask round; continuation requires a new explicit Tellask',
          ].join('\n');

    // IMPORTANT: this is an internal (non-persisted) prompt. driver.ts will inject it into
    // the LLM context for this drive only, without polluting dialog history.
    assertNotStopped?.();
    await driveDialogStream(
      dlg,
      {
        content: internalPrompt,
        msgId: generateShortId(),
        grammar: 'markdown',
        persistMode: 'internal',
        skipTaskdoc: true,
      },
      true,
    );
    assertNotStopped?.();
    const afterMsgs = dlg.msgs.length;
    if (afterMsgs <= beforeMsgs) {
      throw new Error('Agent Priming distillation produced no new messages.');
    }
    const saying = extractLastAssistantSaying(dlg.msgs).trim();
    if (!saying) {
      throw new Error('Agent Priming distillation produced empty output.');
    }
    return saying;
  } finally {
    dlg.disableDiligencePush = prevDisableDiligencePush;
  }
}

function buildCoursePrefixMsgs(entry: AgentPrimingCacheEntry): ChatMessage[] {
  const language = entry.workLanguage;
  const header = (() => {
    if (language === 'zh') {
      if (entry.shellPolicy === 'specialist_only') {
        return '智能体启动（Agent Priming）上下文：本进程在对话创建时已真实跑通一次“诉请（shell 专员）+ 回传 + `self-route tellask` FBR + 综合提炼”，并遵循“发起 FBR → 等待回贴 → 综合决策”的时序。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      if (entry.shellPolicy === 'no_specialist') {
        return '智能体启动（Agent Priming）上下文：本进程在对话创建时已获取环境快照并完成一次 `self-route tellask` FBR + 综合提炼（无 shell 专员；不得执行任意 shell 命令），并遵循“发起 FBR → 等待回贴 → 综合决策”的时序。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      return '智能体启动（Agent Priming）上下文：本进程在对话创建时已获取环境快照并完成一次 `self-route tellask` FBR + 综合提炼，并遵循“发起 FBR → 等待回贴 → 综合决策”的时序。以下为压缩转录，作为每一程对话的开头上下文注入。';
    }

    if (entry.shellPolicy === 'specialist_only') {
      return 'Agent Priming context: this process already ran a real Tellask (shell specialist) + return + `self-route tellask` FBR + distillation at dialog creation, following the timing contract “initiate FBR -> wait for feedback -> synthesize/decide”. The condensed transcript below is injected at the start of each course.';
    }
    if (entry.shellPolicy === 'no_specialist') {
      return 'Agent Priming context: this process captured an environment snapshot and ran `self-route tellask` FBR + distillation at dialog creation (no shell specialist; do not run arbitrary shell commands), following the timing contract “initiate FBR -> wait for feedback -> synthesize/decide”. The condensed transcript below is injected at the start of each course.';
    }
    return 'Agent Priming context: this process captured an environment snapshot and ran `self-route tellask` FBR + distillation at dialog creation, following the timing contract “initiate FBR -> wait for feedback -> synthesize/decide”. The condensed transcript below is injected at the start of each course.';
  })();

  const shellSnapshotLabel =
    language === 'zh'
      ? 'Shell 环境快照（当前 Dominds 运行时；来自 `uname -a`）'
      : 'Shell environment snapshot (current Dominds runtime; `uname -a`)';
  const shellSnapshot = entry.shell.snapshotText.trim()
    ? entry.shell.snapshotText.trim()
    : language === 'zh'
      ? '（无）'
      : '(empty)';
  const vcsInventoryLabel = language === 'zh' ? 'VCS 现状盘点（rtws）' : 'VCS inventory (rtws)';
  const vcsInventory = entry.vcs.inventoryText.trim()
    ? entry.vcs.inventoryText.trim()
    : language === 'zh'
      ? '（无）'
      : '(empty)';

  const effort = Math.max(0, Math.floor(entry.fbr.effort));
  const fbrLabel =
    language === 'zh'
      ? 'FBR 输出（摘要；主线在收齐回贴后综合）'
      : 'FBR outputs (summary; synthesized after all feedback is collected)';
  const previewCap = Math.min(entry.fbr.responses.length, Math.max(0, Math.min(6, effort)));
  const previewResponses = previewCap > 0 ? entry.fbr.responses.slice(0, previewCap) : [];
  const blocks: string[] = [];
  for (let i = 0; i < previewResponses.length; i++) {
    const raw = previewResponses[i] ?? '';
    const trimmed = raw.trim();
    const cap = 4000;
    const capped =
      trimmed.length <= cap
        ? trimmed
        : language === 'zh'
          ? `${trimmed.slice(0, cap).trimEnd()}\n\n（已截断：仅显示前 ${cap} 字符）`
          : `${trimmed.slice(0, cap).trimEnd()}\n\n(truncated: first ${cap} chars only)`;
    blocks.push(
      language === 'zh'
        ? [`### FBR 草稿 #${i + 1}`, '', capped || '（无）'].join('\n')
        : [`### FBR draft #${i + 1}`, '', capped || '(empty)'].join('\n'),
    );
  }
  const fbrPreview =
    effort < 1
      ? language === 'zh'
        ? '（已跳过：已禁用）'
        : '(skipped: disabled)'
      : blocks.length < 1
        ? language === 'zh'
          ? '（无）'
          : '(empty)'
        : blocks.join('\n\n---\n\n');

  const priming = entry.primingNote.trim();

  const out: ChatMessage[] = [
    { type: 'transient_guide_msg', role: 'assistant', content: header },
    {
      type: 'environment_msg',
      role: 'user',
      content: `${shellSnapshotLabel}:\n\n${shellSnapshot}`,
    },
    {
      type: 'environment_msg',
      role: 'user',
      content: `${vcsInventoryLabel}:\n\n${vcsInventory}`,
    },
    {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh' ? `${fbrLabel}:\n\n${fbrPreview}` : `${fbrLabel}:\n\n${fbrPreview}`,
    },
  ];

  if (entry.shell.kind === 'specialist_tellask') {
    const fullReturn = entry.shell.responseText.trim();
    const snapshot = entry.shell.snapshotText.trim();
    if (fullReturn && fullReturn !== snapshot) {
      out.push({
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `Shell 反馈（完整回传）：\n\n${fullReturn}`
            : `Shell feedback (full return):\n\n${fullReturn}`,
      });
    }
  }

  if (priming) {
    out.push({
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `智能体启动（Agent Priming）笔记（综合提炼）：\n\n${priming}`
          : `Agent Priming note (distilled):\n\n${priming}`,
    });
  }

  return out;
}

async function replayAgentPriming(dlg: Dialog, entry: AgentPrimingCacheEntry): Promise<void> {
  const hadActiveRunBefore = hasActiveRun(dlg.id);
  const primingAbortSignal = createActiveRun(dlg.id);
  const ownsActiveRun = !hadActiveRunBefore;
  const assertNotStopped = (): void => {
    throwIfAgentPrimingStopped(dlg, primingAbortSignal);
  };
  const release = await dlg.acquire();
  let interruptedRunState: DialogRunState | null = null;
  try {
    const language = getWorkLanguage();
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    await setDialogRunState(dlg.id, { kind: 'proceeding' });
    assertNotStopped();

    // Phase 1: shell ask (and optional prelude intro)
    let shellCallId: string | null = null;
    let shellMentionList: string[] | null = null;
    try {
      assertNotStopped();
      await dlg.notifyGeneratingStart();
      await emitUiOnlyMarkdownEventsAndPersist(
        dlg,
        formatPreludeIntro(
          language,
          true,
          entry.shellPolicy,
          entry.shell.kind === 'specialist_tellask' ? entry.shell.specialistId : null,
        ),
      );

      if (entry.shell.kind === 'specialist_tellask') {
        const shellCall = await emitSyntheticTellaskCall(dlg, {
          mentionList: [`@${entry.shell.specialistId}`],
          tellaskContent: entry.shell.tellaskBody,
        });
        shellCallId = shellCall.callId;
        shellMentionList = shellCall.mentionList;
      } else {
        await emitSayingEventsAndPersist(dlg, entry.shell.directNoteMarkdown);
      }
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    // Phase 2: shell response (separate bubble)
    if (entry.shell.kind === 'specialist_tellask' && shellCallId && shellMentionList) {
      assertNotStopped();
      await dlg.receiveTeammateResponse(
        entry.shell.specialistId,
        shellMentionList,
        entry.shell.tellaskBody,
        'completed',
        dlg.id,
        {
          response: entry.shell.responseText,
          agentId: entry.shell.specialistId,
          callId: shellCallId,
          originMemberId: dlg.agentId,
        },
      );
    }

    // Phase 2.5: VCS long-session drill (two rounds)
    if (entry.vcs.kind === 'specialist_session') {
      let round1CallId: string | null = null;
      let round1MentionList: string[] | null = null;
      let round2CallId: string | null = null;
      let round2MentionList: string[] | null = null;

      try {
        assertNotStopped();
        await dlg.notifyGeneratingStart();
        const round1 = await emitSyntheticTellaskCall(dlg, {
          mentionList: [`@${entry.vcs.specialistId}`],
          tellaskContent: entry.vcs.round1.tellaskBody,
        });
        round1CallId = round1.callId;
        round1MentionList = round1.mentionList;
      } finally {
        try {
          await dlg.notifyGeneratingFinish();
        } catch (_finishErr) {
          // best-effort
        }
      }

      if (round1CallId && round1MentionList) {
        assertNotStopped();
        await dlg.receiveTeammateResponse(
          entry.vcs.specialistId,
          round1MentionList,
          entry.vcs.round1.tellaskBody,
          'completed',
          dlg.id,
          {
            response: entry.vcs.round1.responseText,
            agentId: entry.vcs.specialistId,
            callId: round1CallId,
            originMemberId: dlg.agentId,
          },
        );
      }

      try {
        assertNotStopped();
        await dlg.notifyGeneratingStart();
        const round2 = await emitSyntheticTellaskCall(dlg, {
          mentionList: [`@${entry.vcs.specialistId}`],
          tellaskContent: entry.vcs.round2.tellaskBody,
        });
        round2CallId = round2.callId;
        round2MentionList = round2.mentionList;
      } finally {
        try {
          await dlg.notifyGeneratingFinish();
        } catch (_finishErr) {
          // best-effort
        }
      }

      if (round2CallId && round2MentionList) {
        assertNotStopped();
        await dlg.receiveTeammateResponse(
          entry.vcs.specialistId,
          round2MentionList,
          entry.vcs.round2.tellaskBody,
          'completed',
          dlg.id,
          {
            response: entry.vcs.round2.responseText,
            agentId: entry.vcs.specialistId,
            callId: round2CallId,
            originMemberId: dlg.agentId,
          },
        );
      }
    } else {
      try {
        assertNotStopped();
        await dlg.notifyGeneratingStart();
        await emitSayingEventsAndPersist(dlg, entry.vcs.round1NoteMarkdown);
      } finally {
        try {
          await dlg.notifyGeneratingFinish();
        } catch (_finishErr) {
          // best-effort
        }
      }
      try {
        assertNotStopped();
        await dlg.notifyGeneratingStart();
        await emitSayingEventsAndPersist(dlg, entry.vcs.round2NoteMarkdown);
      } finally {
        try {
          await dlg.notifyGeneratingFinish();
        } catch (_finishErr) {
          // best-effort
        }
      }
    }

    // Phase 3: FBR ask (call bubble)
    let fbrCallId: string | null = null;
    let fbrMentionList: string[] | null = null;
    const effort = Math.max(0, Math.floor(entry.fbr.effort));
    if (effort >= 1 && entry.fbr.responses.length > 0) {
      try {
        assertNotStopped();
        await dlg.notifyGeneratingStart();
        const fbrCallBody = [entry.fbr.selfTeaser, '', entry.fbr.tellaskContent].join('\n');
        const fbrCall = await emitSyntheticTellaskCall(dlg, {
          mentionList: ['@self'],
          tellaskContent: fbrCallBody,
        });
        fbrCallId = fbrCall.callId;
        fbrMentionList = fbrCall.mentionList;
      } finally {
        try {
          await dlg.notifyGeneratingFinish();
        } catch (_finishErr) {
          // best-effort
        }
      }

      // Phase 4: FBR responses (separate bubbles, in stable index order)
      if (fbrCallId && fbrMentionList) {
        const normalized = Math.max(1, effort);
        const responses = entry.fbr.responses.slice(0, normalized);
        for (let i = 0; i < responses.length; i++) {
          assertNotStopped();
          const raw = responses[i] ?? '';
          await dlg.receiveTeammateResponse(
            entry.fbr.responderAgentId,
            fbrMentionList,
            entry.fbr.tellaskContent,
            'completed',
            dlg.id,
            {
              response: raw,
              agentId: entry.fbr.responderAgentId,
              callId: fbrCallId,
              originMemberId: dlg.agentId,
            },
          );
        }
      }
    }

    // Phase 5: summary bubble
    try {
      assertNotStopped();
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, entry.primingNote);
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }
  } catch (err) {
    if (isAgentPrimingInterruptedError(err)) {
      interruptedRunState = {
        kind: 'interrupted',
        reason: { kind: err.reason },
      };
      log.info('Agent Priming replay interrupted by stop request', undefined, {
        dialogId: dlg.id.valueOf(),
        reason: err.reason,
      });
    } else {
      log.warn('Agent Priming replay failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
    }
  } finally {
    try {
      if (interruptedRunState) {
        await setDialogRunState(dlg.id, interruptedRunState);
      } else {
        let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
        try {
          nextIdle = await computeIdleRunState(dlg);
        } catch (err: unknown) {
          log.warn(
            'Failed to compute idle runState after Agent Priming replay; falling back',
            err,
            {
              dialogId: dlg.id.valueOf(),
            },
          );
        }
        await setDialogRunState(dlg.id, nextIdle);
      }
    } finally {
      if (ownsActiveRun) {
        clearActiveRun(dlg.id);
      }
      release();
    }
  }
}

async function runAgentPrimingLive(dlg: Dialog): Promise<AgentPrimingCacheEntry> {
  const createdAt = formatUnifiedTimestamp(new Date());
  const language = getWorkLanguage();
  const hadActiveRunBefore = hasActiveRun(dlg.id);
  const primingAbortSignal = createActiveRun(dlg.id);
  const ownsActiveRun = !hadActiveRunBefore;
  const assertNotStopped = (): void => {
    throwIfAgentPrimingStopped(dlg, primingAbortSignal);
  };
  const prevDisableDiligencePush = dlg.disableDiligencePush;
  // Agent Priming is a bounded bootstrap routine; no keep-going injection should appear
  // during the priming lifecycle (including any auto-revive drives triggered by subdialog replies).
  dlg.disableDiligencePush = true;
  let fatalRunState: DialogRunState | null = null;
  let shellPolicy: AgentPrimingCacheEntry['shellPolicy'] = 'no_specialist';
  let specialistId: string | null = null;
  let shellTellaskBody = '';
  let shellResponseText = '';
  let snapshotText = '';
  let directNoteMarkdown = '';
  let vcsRound1Body = '';
  let vcsRound2Body = '';
  let vcsRound1ResponseText = '';
  let vcsRound2ResponseText = '';
  let vcsEvidenceRound1Text = '';
  let vcsEvidenceRound2Text = '';
  let vcsRound1NoteMarkdown = '';
  let vcsRound2NoteMarkdown = '';
  let vcsInventoryText = '';
  let fbrCallBody = '';
  let selfTeaser = '';
  let fbrEffort = 0;
  const fbrResponsesForCache: string[] = [];
  const fbrResponsesForInjection: Array<{ subdialogId: string; response: string }> = [];
  try {
    await setDialogRunState(dlg.id, { kind: 'proceeding' });
    assertNotStopped();

    const team = await Team.load();
    assertNotStopped();
    const member = team.getMember(dlg.agentId);
    const specialists = team.shellSpecialists
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const selfIsShellSpecialist = specialists.includes(dlg.agentId);
    specialistId = specialists.find((s) => s !== dlg.agentId) ?? null;
    shellPolicy =
      specialists.length < 1
        ? 'no_specialist'
        : selfIsShellSpecialist
          ? 'self_is_specialist'
          : 'specialist_only';

    let shellCallId: string | null = null;
    let shellMentionList: string[] | null = null;
    let shellTellaskBodyForSubdialog: string | null = null;

    // Phase 1: shell ask (and optional prelude intro)
    if (shellPolicy === 'specialist_only' && specialistId !== null) {
      shellTellaskBody = formatShellTellaskBody(language, specialistId);
      assertNotStopped();
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitUiOnlyMarkdownEventsAndPersist(
            dlg,
            formatPreludeIntro(language, false, shellPolicy, specialistId),
          );

          const call = await emitSyntheticTellaskCall(dlg, {
            mentionList: [`@${specialistId}`],
            tellaskContent: shellTellaskBody,
          });
          shellCallId = call.callId;
          shellMentionList = call.mentionList;
          shellTellaskBodyForSubdialog = call.tellaskContent;
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });
    } else {
      // Either no shell specialist is configured, or the dialog owner is itself a shell specialist.
      // In both cases we skip the shell Tellask step and let the runtime capture a baseline snapshot.
      // Keep it safe and deterministic: no network, no writes.
      const unameOutput = await runUnameA();
      assertNotStopped();
      shellResponseText = unameOutput;
      snapshotText = unameOutput;
      const directNote = (() => {
        if (shellPolicy === 'self_is_specialist') {
          return language === 'zh'
            ? ['由 Dominds 运行时执行：`uname -a`', '', '```console', unameOutput, '```', ''].join(
                '\n',
              )
            : ['Dominds runtime ran: `uname -a`', '', '```console', unameOutput, '```', ''].join(
                '\n',
              );
        }
        return language === 'zh'
          ? [
              '未配置 shell 专员：由 Dominds 运行时仅执行基线命令 `uname -a` 以获取环境快照。',
              '约束：后续**不得执行任意 shell 命令**；只能通过文件读写等非 shell 工具推进。',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n')
          : [
              'No shell specialist configured: Dominds runtime ran only the baseline command `uname -a` to capture an environment snapshot.',
              'Constraint: do **not** run arbitrary shell commands; proceed only with non-shell tools like file read/write.',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n');
      })();
      directNoteMarkdown = directNote;

      assertNotStopped();
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitUiOnlyMarkdownEventsAndPersist(
            dlg,
            formatPreludeIntro(language, false, shellPolicy, specialistId),
          );
          await emitSayingEventsAndPersist(dlg, directNoteMarkdown);
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });
    }

    // Phase 2: shell response (separate bubble)
    if (
      shellPolicy === 'specialist_only' &&
      specialistId !== null &&
      shellCallId &&
      shellMentionList
    ) {
      const ensuredSpecialistId = specialistId;
      const ensuredShellCallId = shellCallId;
      const ensuredShellMentionList = shellMentionList;
      const tellaskBody = shellTellaskBodyForSubdialog ?? shellTellaskBody;
      assertNotStopped();
      const sub = await dlg.withLock(async () => {
        return await dlg.createSubDialog(
          ensuredSpecialistId,
          ensuredShellMentionList,
          tellaskBody,
          {
            originMemberId: dlg.agentId,
            callerDialogId: dlg.id.selfId,
            callId: ensuredShellCallId,
            collectiveTargets: [ensuredSpecialistId],
          },
        );
      });

      const initPrompt = formatAssignmentFromSupdialog({
        fromAgentId: dlg.agentId,
        toAgentId: sub.agentId,
        mentionList: ensuredShellMentionList,
        tellaskContent: tellaskBody,
        language,
        collectiveTargets: [ensuredSpecialistId],
      });

      await driveDialogStream(
        sub,
        { content: initPrompt, msgId: generateShortId(), grammar: 'markdown', skipTaskdoc: true },
        true,
      );
      assertNotStopped();

      shellResponseText = extractLastAssistantSaying(sub.msgs);
      const toolResult = extractLastShellCmdResultText(sub.msgs);
      snapshotText = toolResult ? toolResult : shellResponseText;
      if (!snapshotText.trim()) {
        // Specialist produced no usable output (misconfigured tools, provider issues, etc.).
        // Fall back to a runtime-executed `uname -a` so we can still proceed to FBR.
        snapshotText = await runUnameA();
        assertNotStopped();
      }

      assertNotStopped();
      await dlg.withLock(async () => {
        await dlg.receiveTeammateResponse(
          ensuredSpecialistId,
          ensuredShellMentionList,
          tellaskBody,
          'completed',
          sub.id,
          {
            response: shellResponseText,
            agentId: ensuredSpecialistId,
            callId: ensuredShellCallId,
            originMemberId: dlg.agentId,
          },
        );
      });
    }

    // Phase 2.5: VCS tellask-session drill (two rounds) or runtime inventory.
    if (shellPolicy === 'specialist_only' && specialistId !== null) {
      const ensuredSpecialistId = specialistId;
      try {
        vcsRound1Body = formatVcsSessionRound1TellaskBody(language);
        let round1CallId = '';
        let round1MentionList: string[] = [];
        let round1TellaskBodyForSubdialog = '';

        await dlg.withLock(async () => {
          try {
            await dlg.notifyGeneratingStart();
            const call = await emitSyntheticTellaskCall(dlg, {
              mentionList: [`@${ensuredSpecialistId}`],
              tellaskContent: vcsRound1Body,
            });
            round1CallId = call.callId;
            round1MentionList = call.mentionList;
            round1TellaskBodyForSubdialog = call.tellaskContent;
          } finally {
            try {
              await dlg.notifyGeneratingFinish();
            } catch (_finishErr) {
              // best-effort
            }
          }
        });

        assertNotStopped();
        const round1Sub = await dlg.withLock(async () => {
          return await dlg.createSubDialog(
            ensuredSpecialistId,
            round1MentionList,
            round1TellaskBodyForSubdialog || vcsRound1Body,
            {
              originMemberId: dlg.agentId,
              callerDialogId: dlg.id.selfId,
              callId: round1CallId,
              sessionSlug: PRIMING_VCS_SESSION_SLUG,
              collectiveTargets: [ensuredSpecialistId],
            },
          );
        });

        const rootDialog =
          dlg instanceof RootDialog ? dlg : dlg instanceof SubDialog ? dlg.rootDialog : undefined;
        if (rootDialog) {
          assertNotStopped();
          rootDialog.registerSubdialog(round1Sub);
          await rootDialog.saveSubdialogRegistry();
        }

        const round1Prompt = formatAssignmentFromSupdialog({
          fromAgentId: dlg.agentId,
          toAgentId: round1Sub.agentId,
          mentionList: round1MentionList,
          tellaskContent: round1TellaskBodyForSubdialog || vcsRound1Body,
          language,
          collectiveTargets: [ensuredSpecialistId],
        });
        await driveDialogStream(
          round1Sub,
          {
            content: round1Prompt,
            msgId: generateShortId(),
            grammar: 'markdown',
            skipTaskdoc: true,
          },
          true,
        );
        assertNotStopped();
        vcsRound1ResponseText = extractLastAssistantSaying(round1Sub.msgs).trim();
        if (!vcsRound1ResponseText) {
          throw new Error('Specialist VCS session round-1 returned empty output');
        }

        assertNotStopped();
        await dlg.withLock(async () => {
          await dlg.receiveTeammateResponse(
            ensuredSpecialistId,
            round1MentionList,
            round1TellaskBodyForSubdialog || vcsRound1Body,
            'completed',
            round1Sub.id,
            {
              response: vcsRound1ResponseText,
              agentId: ensuredSpecialistId,
              callId: round1CallId,
              originMemberId: dlg.agentId,
            },
          );
        });

        vcsRound2Body = formatVcsSessionRound2TellaskBody(language, vcsRound1ResponseText);
        let round2CallId = '';
        let round2MentionList: string[] = [];
        let round2TellaskBodyForSubdialog = '';
        await dlg.withLock(async () => {
          try {
            await dlg.notifyGeneratingStart();
            const call = await emitSyntheticTellaskCall(dlg, {
              mentionList: [`@${ensuredSpecialistId}`],
              tellaskContent: vcsRound2Body,
            });
            round2CallId = call.callId;
            round2MentionList = call.mentionList;
            round2TellaskBodyForSubdialog = call.tellaskContent;
          } finally {
            try {
              await dlg.notifyGeneratingFinish();
            } catch (_finishErr) {
              // best-effort
            }
          }
        });

        const round2Prompt = formatAssignmentFromSupdialog({
          fromAgentId: dlg.agentId,
          toAgentId: round1Sub.agentId,
          mentionList: round2MentionList,
          tellaskContent: round2TellaskBodyForSubdialog || vcsRound2Body,
          language,
          collectiveTargets: [ensuredSpecialistId],
        });
        await driveDialogStream(
          round1Sub,
          {
            content: round2Prompt,
            msgId: generateShortId(),
            grammar: 'markdown',
            skipTaskdoc: true,
          },
          true,
        );
        assertNotStopped();
        vcsRound2ResponseText = extractLastAssistantSaying(round1Sub.msgs).trim();
        if (!vcsRound2ResponseText) {
          throw new Error('Specialist VCS session round-2 returned empty output');
        }

        assertNotStopped();
        await dlg.withLock(async () => {
          await dlg.receiveTeammateResponse(
            ensuredSpecialistId,
            round2MentionList,
            round2TellaskBodyForSubdialog || vcsRound2Body,
            'completed',
            round1Sub.id,
            {
              response: vcsRound2ResponseText,
              agentId: ensuredSpecialistId,
              callId: round2CallId,
              originMemberId: dlg.agentId,
            },
          );
        });

        vcsInventoryText = [vcsRound1ResponseText, '', vcsRound2ResponseText].join('\n');
      } catch (err) {
        log.warn(
          'VCS tellask-session drill via shell specialist failed; fallback to runtime inventory',
          err,
          {
            dialogId: dlg.id.valueOf(),
            specialistId: ensuredSpecialistId,
          },
        );
      }
    }

    const runtimeInventory = await collectRtwsGitInventory();
    assertNotStopped();
    const runtimeRound1Text = formatRtwsGitInventoryRound1(language, runtimeInventory);
    const runtimeRound2Text = formatRtwsGitInventoryRound2(language, runtimeInventory);
    const runtimeInventoryText = [runtimeRound1Text, '', runtimeRound2Text].join('\n');

    if (
      shellPolicy === 'specialist_only' &&
      specialistId !== null &&
      vcsRound1ResponseText.trim() &&
      vcsRound2ResponseText.trim()
    ) {
      // Keep teammate replies as collaboration transcript, but use runtime-verified
      // inventory as canonical facts for downstream FBR/distillation evidence.
      vcsEvidenceRound1Text = runtimeRound1Text;
      vcsEvidenceRound2Text = runtimeRound2Text;
      vcsInventoryText = runtimeInventoryText;
    } else {
      vcsRound1ResponseText = runtimeRound1Text;
      vcsRound2ResponseText = runtimeRound2Text;
      vcsEvidenceRound1Text = runtimeRound1Text;
      vcsEvidenceRound2Text = runtimeRound2Text;
      vcsRound1NoteMarkdown = formatRuntimeVcsRoundNote(language, 1, vcsRound1ResponseText);
      vcsRound2NoteMarkdown = formatRuntimeVcsRoundNote(language, 2, vcsRound2ResponseText);
      vcsInventoryText = runtimeInventoryText;

      assertNotStopped();
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitSayingEventsAndPersist(dlg, vcsRound1NoteMarkdown);
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });

      assertNotStopped();
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitSayingEventsAndPersist(dlg, vcsRound2NoteMarkdown);
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });
    }

    const fbrSnapshotText = [
      snapshotText.trim() ? snapshotText.trim() : '',
      vcsInventoryText.trim() ? vcsInventoryText.trim() : '',
    ]
      .filter((part) => part !== '')
      .join('\n\n---\n\n');

    const rawFbrEffort = member ? member.fbr_effort : undefined;
    fbrEffort = (() => {
      if (typeof rawFbrEffort !== 'number' || !Number.isFinite(rawFbrEffort)) return 3;
      const n = Math.floor(rawFbrEffort);
      if (n < 0) return 0;
      if (n > 100) {
        throw new Error('Invalid fbr_effort: must be <= 100');
      }
      return n;
    })();

    fbrCallBody = formatFbrTellaskBody(
      language,
      fbrSnapshotText.trim() ? fbrSnapshotText : snapshotText,
      { fbrEffort },
    );
    selfTeaser = formatFbrSelfTeaser(language);
    let fbrCallId: string | null = null;
    let fbrMentionList: string[] | null = null;

    // Phase 3: FBR ask (call bubble)
    if (fbrEffort >= 1) {
      assertNotStopped();
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitUiOnlyMarkdownEventsAndPersist(dlg, selfTeaser);
          const fbrCall = await emitSyntheticTellaskCall(dlg, {
            mentionList: ['@self'],
            tellaskContent: fbrCallBody,
          });
          fbrCallId = fbrCall.callId;
          fbrMentionList = fbrCall.mentionList;
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });

      // Phase 4: FBR responses (separate bubbles; order is not meaningful)
      if (!fbrCallId || !fbrMentionList) {
        throw new Error('Missing FBR callId/mentionList');
      }
      const ensuredFbrCallId = fbrCallId;
      const ensuredFbrMentionList = fbrMentionList;

      const perInstance = Array.from({ length: fbrEffort }, (_, idx) => idx + 1);
      const created = await Promise.all(
        perInstance.map(async (i) => {
          assertNotStopped();
          const instanceBody =
            fbrEffort > 1
              ? [
                  fbrCallBody,
                  '',
                  language === 'zh'
                    ? '提示：请尽量提供与其它 FBR 草稿不同的视角（例如安全/限制/可验证性/风险点）。'
                    : 'Hint: try to provide a distinct angle vs other FBR drafts (e.g. security/constraints/verifiability/risk).',
                ].join('\n')
              : fbrCallBody;

          assertNotStopped();
          const sub = await dlg.withLock(async () => {
            return await dlg.createSubDialog(
              dlg.agentId,
              ensuredFbrMentionList,
              instanceBody,
              {
                originMemberId: dlg.agentId,
                callerDialogId: dlg.id.selfId,
                callId: ensuredFbrCallId,
                collectiveTargets: [dlg.agentId],
              },
            );
          });

          const initPrompt = formatAssignmentFromSupdialog({
            fromAgentId: dlg.agentId,
            toAgentId: sub.agentId,
            mentionList: ensuredFbrMentionList,
            tellaskContent: instanceBody,
            language,
            collectiveTargets: [dlg.agentId],
          });

          await driveDialogStream(
            sub,
            {
              content: initPrompt,
              msgId: generateShortId(),
              grammar: 'markdown',
              skipTaskdoc: true,
            },
            true,
          );
          assertNotStopped();

          const responseText = extractLastAssistantSaying(sub.msgs);
          return { sub, responseText };
        }),
      );
      assertNotStopped();

      for (const r of created) {
        assertNotStopped();
        const responseText = r.responseText;
        fbrResponsesForCache.push(responseText);
        fbrResponsesForInjection.push({ subdialogId: r.sub.id.selfId, response: responseText });
        await dlg.withLock(async () => {
          await dlg.receiveTeammateResponse(
            dlg.agentId,
            ensuredFbrMentionList,
            fbrCallBody,
            'completed',
            r.sub.id,
            {
              response: responseText,
              agentId: dlg.agentId,
              callId: ensuredFbrCallId,
              originMemberId: dlg.agentId,
            },
          );
        });
      }
    }

    if (!fbrCallId || !fbrMentionList) {
      if (fbrEffort >= 1) {
        throw new Error('Missing FBR callId/mentionList for Agent Priming distillation.');
      }
      // FBR disabled (fbr_effort == 0): distill from shell snapshot only.
      fbrCallId = '';
      fbrMentionList = ['@self'];
    }
    const primingNote = await generatePrimingNoteViaMainlineAgent({
      dlg,
      shellSnapshotText: snapshotText,
      shellResponseText: shellResponseText,
      vcsRound1Text: vcsEvidenceRound1Text,
      vcsRound2Text: vcsEvidenceRound2Text,
      fbrResponses: fbrResponsesForInjection,
      fbrMentionList,
      fbrCallId: fbrCallId,
      assertNotStopped,
    });
    assertNotStopped();

    const entry: AgentPrimingCacheEntry = {
      createdAt,
      workLanguage: language,
      shellPolicy,
      shell:
        shellPolicy === 'specialist_only' && specialistId !== null
          ? {
              kind: 'specialist_tellask',
              specialistId,
              tellaskBody: shellTellaskBody,
              responseText: shellResponseText,
              snapshotText,
            }
          : {
              kind: 'direct_shell',
              directNoteMarkdown,
              snapshotText,
            },
      vcs:
        shellPolicy === 'specialist_only' &&
        specialistId !== null &&
        vcsRound1ResponseText.trim() &&
        vcsRound2ResponseText.trim()
          ? {
              kind: 'specialist_session',
              specialistId,
              sessionSlug: PRIMING_VCS_SESSION_SLUG,
              round1: {
                tellaskBody: vcsRound1Body || formatVcsSessionRound1TellaskBody(language),
                responseText: vcsRound1ResponseText,
              },
              round2: {
                tellaskBody:
                  vcsRound2Body ||
                  formatVcsSessionRound2TellaskBody(language, vcsRound1ResponseText),
                responseText: vcsRound2ResponseText,
              },
              inventoryText: vcsInventoryText,
            }
          : {
              kind: 'runtime_inventory',
              round1NoteMarkdown:
                vcsRound1NoteMarkdown ||
                formatRuntimeVcsRoundNote(language, 1, vcsRound1ResponseText),
              round2NoteMarkdown:
                vcsRound2NoteMarkdown ||
                formatRuntimeVcsRoundNote(language, 2, vcsRound2ResponseText),
              inventoryText: vcsInventoryText,
            },
      fbr: {
        mentionList: fbrMentionList,
        tellaskContent: fbrCallBody,
        selfTeaser,
        responderAgentId: dlg.agentId,
        effort: fbrEffort,
        responses: fbrResponsesForCache,
      },
      primingNote,
    };

    await dlg.withLock(async () => {
      dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    });
    return entry;
  } catch (err) {
    if (isAgentPrimingInterruptedError(err)) {
      fatalRunState = {
        kind: 'interrupted',
        reason: { kind: err.reason },
      };
      log.info('Agent Priming live run interrupted by stop request', undefined, {
        dialogId: dlg.id.valueOf(),
        reason: err.reason,
      });
      throw err;
    }

    const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const errTextTrimmed = errText.trim().slice(0, 4000);
    fatalRunState = {
      kind: 'interrupted',
      reason: { kind: 'system_stop', detail: `Agent Priming failed: ${errTextTrimmed}` },
    };
    log.warn('Agent Priming live run failed (fatal)', err, { dialogId: dlg.id.valueOf() });
    const msg =
      language === 'zh'
        ? [
            '错误：智能体启动（Agent Priming）失败；无法继续对话。',
            '',
            '根因（详细信息）：',
            '```text',
            errTextTrimmed,
            '```',
          ].join('\n')
        : [
            'Error: Agent Priming failed; cannot continue this dialog.',
            '',
            'Root cause (details):',
            '```text',
            errTextTrimmed,
            '```',
          ].join('\n');
    try {
      await dlg.withLock(async () => {
        await dlg.notifyGeneratingStart();
        await emitSayingEventsAndPersist(dlg, msg);
        await dlg.notifyGeneratingFinish();
      });
    } catch (_emitErr) {
      // best-effort
    }
    throw err;
  } finally {
    dlg.disableDiligencePush = prevDisableDiligencePush;
    try {
      if (fatalRunState) {
        await setDialogRunState(dlg.id, fatalRunState);
      } else {
        let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
        try {
          nextIdle = await computeIdleRunState(dlg);
        } catch (err: unknown) {
          log.warn(
            'Failed to compute idle runState after Agent Priming live run; falling back',
            err,
            {
              dialogId: dlg.id.valueOf(),
            },
          );
        }
        await setDialogRunState(dlg.id, nextIdle);
      }
    } finally {
      if (ownsActiveRun) {
        clearActiveRun(dlg.id);
      }
    }
  }
}
