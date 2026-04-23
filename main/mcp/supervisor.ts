import type { ProblemI18nText, WorkspaceProblem } from '@longrun-ai/kernel/types/problems';
import type { FuncResultContentItem } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import YAML, { isMap, isScalar } from 'yaml';
import { type Dialog } from '../dialog';
import { createLogger } from '../log';
import { DialogPersistence } from '../persistence';
import { reconcileProblemsByPrefix, removeProblemsByPrefix, upsertProblem } from '../problems';
import { getWorkLanguage } from '../runtime/work-language';
import { toolSuccess, type Tool, type ToolArguments, type ToolCallOutput } from '../tool';
import {
  notifyToolAvailabilityRegistryMaybeChanged,
  notifyToolAvailabilityRuntimeLeaseChanged,
} from '../tool-availability-updates';
import { buildMcpManualSpec, type ManualSpec } from '../tools/manual/spec';
import {
  getReminderOwner,
  registerTool,
  registerToolset,
  setToolsetMeta,
  toolsetsRegistry,
  toolsRegistry,
  unregisterTool,
  unregisterToolset,
} from '../tools/registry';
import { measureRenderedTeamMgmtMcpTopicRawChars } from '../tools/team_mgmt-mcp-manual';
import type { McpServerConfig, McpStreamableHttpServerConfig, McpWorkspaceConfig } from './config';
import { parseMcpYaml } from './config';
import {
  emptyMcpToolsetManualByServer,
  parseMcpManualByServer,
  reconcileMcpToolsetManualProblems,
  type McpToolsetManual,
  type McpToolsetManualByServer,
} from './manual-problems';
import {
  extractMcpDiagnosticTextI18n,
  McpSdkClient,
  type McpDiagnosticTextI18n,
  type McpListedTool,
} from './sdk-client';
import { McpServerRuntime } from './server-runtime';
import {
  applyToolNameTransforms,
  decideToolExposure,
  isValidProviderToolName,
  TOOL_NAME_VALIDITY_RULE,
} from './tool-names';

const log = createLogger('mcp/supervisor');

const MCP_YAML_PATH = path.join('.minds', 'mcp.yaml');

const MCP_TOOL_CALL_PROBLEM_PREFIX = 'mcp/tool_call_error/';

type ServerState = {
  serverId: string;
  toolsetName: string;
  configFingerprint: string;
  cfg: McpServerConfig;
  listedTools: readonly McpListedTool[];
  dispatch: McpServerDispatch;
  tools: Tool[];
  ownedToolNames: Set<string>;
  problems: WorkspaceProblem[];
};

const serverStateById: Map<string, ServerState> = new Map();
const toolOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();
const toolsetOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();

export type McpDeclaredServerRuntimeStatus = Readonly<{
  serverId: string;
  transport: 'stdio' | 'streamable_http' | 'invalid' | 'unknown';
  status: 'loaded' | 'temporarily_unavailable' | 'config_invalid' | 'disabled';
  errorText?: string;
}>;

type DeclaredServerRuntimeCatalogEntry = Readonly<{
  transport: 'stdio' | 'streamable_http' | 'invalid' | 'unknown';
  disabled?: boolean;
  configErrorText?: string;
  runtimeErrorText?: string;
}>;

let declaredServerIdsInYamlOrder: string[] = [];
const declaredServerRuntimeCatalogById: Map<string, DeclaredServerRuntimeCatalogEntry> = new Map();

type LeaseReminderMeta = Readonly<{
  kind: 'mcp_lease';
  serverId: string;
}>;

function makeLeaseReminderMeta(serverId: string): LeaseReminderMeta {
  return { kind: 'mcp_lease', serverId };
}

function isLeaseReminderMeta(value: unknown): value is LeaseReminderMeta {
  if (!isRecord(value) || Array.isArray(value)) return false;
  if (value.kind !== 'mcp_lease') return false;
  return typeof value.serverId === 'string' && value.serverId.trim().length > 0;
}

function ensureLeaseReminder(dlg: Dialog, serverId: string): void {
  for (const r of dlg.reminders) {
    if (!r.owner) continue;
    if (r.owner.name !== 'mcpLease') continue;
    const meta = r.meta;
    if (!isLeaseReminderMeta(meta)) continue;
    if (meta.serverId !== serverId) continue;
    return;
  }

  const owner = getReminderOwner('mcpLease');
  const workLanguage = getWorkLanguage();
  const content =
    workLanguage === 'zh'
      ? [
          `已租用 MCP 工具集：${serverId}`,
          '',
          '该 MCP server 被视为非“真正无状态”。当你确认短期内不再需要它时，请释放以回收底层进程/连接：',
          `mcp_release({"serverId":"${serverId}"})`,
        ].join('\n')
      : [
          `MCP toolset leased: ${serverId}`,
          '',
          `This MCP server is treated as non-stateless. When you are confident you won't need it again soon, release it:`,
          `mcp_release({"serverId":"${serverId}"})`,
        ].join('\n');
  dlg.addReminder(content, owner, makeLeaseReminderMeta(serverId));
}

class McpServerDispatch {
  public readonly serverId: string;
  public readonly toolsetName: string;
  public readonly cfg: McpServerConfig;

  private readonly sharedRuntime: McpServerRuntime | undefined;
  private readonly leasesByDialogKey: Map<string, McpServerRuntime> = new Map();
  private readonly leaseInitByDialogKey: Map<string, Promise<McpServerRuntime>> = new Map();
  private readonly canceledLeaseDialogs: Set<string> = new Set();

  private stopRequested: boolean = false;

  constructor(params: {
    serverId: string;
    toolsetName: string;
    cfg: McpServerConfig;
    sharedRuntime?: McpServerRuntime;
  }) {
    this.serverId = params.serverId;
    this.toolsetName = params.toolsetName;
    this.cfg = params.cfg;
    this.sharedRuntime = params.sharedRuntime;
  }

  public hasLeaseForDialog(dialogKey: string): boolean {
    return this.leasesByDialogKey.has(dialogKey) || this.leaseInitByDialogKey.has(dialogKey);
  }

  public releaseLeaseForDialog(dialogKey: string): boolean {
    const init = this.leaseInitByDialogKey.get(dialogKey);
    if (init) {
      this.canceledLeaseDialogs.add(dialogKey);
      // Best-effort: allow the in-flight connect to complete, then immediately stop it.
      void init
        .then((rt) => rt.requestStop({ forceKillAfterMs: 3_000 }))
        .catch(() => {
          // ignore
        });
      this.leaseInitByDialogKey.delete(dialogKey);
    }

    const existing = this.leasesByDialogKey.get(dialogKey);
    if (!existing) return false;
    this.leasesByDialogKey.delete(dialogKey);
    existing.requestStop({ forceKillAfterMs: 3_000 });
    return true;
  }

  public requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.sharedRuntime) {
      this.sharedRuntime.requestStop({ forceKillAfterMs: 3_000 });
    }
    for (const rt of this.leasesByDialogKey.values()) {
      rt.requestStop({ forceKillAfterMs: 3_000 });
    }
    this.leasesByDialogKey.clear();
    for (const [dialogKey, init] of this.leaseInitByDialogKey.entries()) {
      this.canceledLeaseDialogs.add(dialogKey);
      void init
        .then((rt) => rt.requestStop({ forceKillAfterMs: 3_000 }))
        .catch(() => {
          // ignore
        });
    }
    this.leaseInitByDialogKey.clear();
  }

  public async callToolForDialog(
    dlg: Dialog,
    mcpToolName: string,
    args: ToolArguments,
  ): Promise<ToolCallOutput> {
    const serverId = this.serverId;

    const withActionableError = async (fn: () => Promise<unknown>): Promise<ToolCallOutput> => {
      try {
        const raw = await fn();
        const out = await materializeMcpToolCallOutput({
          dlg,
          serverId,
          toolName: mcpToolName,
          raw,
        });
        clearMcpToolCallProblem(serverId);
        return out;
      } catch (err: unknown) {
        const workLanguage = getWorkLanguage();
        const errorText = err instanceof Error ? err.message : String(err);
        upsertMcpToolCallProblem({
          serverId,
          toolName: mcpToolName,
          errorText,
        });
        const msg =
          workLanguage === 'zh'
            ? `MCP 工具调用失败（详见 Problems 面板）：${serverId}.${mcpToolName}: ${errorText}`
            : `MCP tool call failed (see Problems panel): ${serverId}.${mcpToolName}: ${errorText}`;
        const wrapped = new Error(msg);
        // Attach the original error for debugging without relying on ErrorOptions typing.
        (wrapped as unknown as { cause?: unknown }).cause = err;
        throw wrapped;
      }
    };

    if (this.cfg.truelyStateless) {
      const sharedRuntime = this.sharedRuntime;
      if (!sharedRuntime) {
        throw new Error(`MCP server '${this.serverId}' missing shared runtime`);
      }
      return await withActionableError(
        async () => await sharedRuntime.callToolRaw(mcpToolName, args),
      );
    }

    const dialogKey = dlg.id.key();
    const existing = this.leasesByDialogKey.get(dialogKey);
    if (existing) {
      this.attachLeaseReminder(dlg);
      return await withActionableError(async () => await existing.callToolRaw(mcpToolName, args));
    }

    if (this.stopRequested) {
      const oneShot = await this.connectNewLeaseRuntime();
      this.attachLeaseReminder(dlg);
      try {
        return await withActionableError(async () => await oneShot.callToolRaw(mcpToolName, args));
      } finally {
        oneShot.requestStop({ forceKillAfterMs: 3_000 });
      }
    }

    let init = this.leaseInitByDialogKey.get(dialogKey);
    if (!init) {
      this.canceledLeaseDialogs.delete(dialogKey);
      init = (async () => {
        try {
          const rt = await this.connectNewLeaseRuntime();
          this.finalizeLeaseForDialog(dialogKey, rt);
          return rt;
        } catch (err) {
          this.leaseInitByDialogKey.delete(dialogKey);
          this.canceledLeaseDialogs.delete(dialogKey);
          throw err;
        }
      })();
      this.leaseInitByDialogKey.set(dialogKey, init);
    }

    const runtime = await init;
    this.attachLeaseReminder(dlg);
    return await withActionableError(async () => await runtime.callToolRaw(mcpToolName, args));
  }

  private async connectNewLeaseRuntime(): Promise<McpServerRuntime> {
    const serverId = this.serverId;
    const client =
      this.cfg.transport === 'stdio'
        ? await McpSdkClient.connectStdio({
            serverId,
            command: this.cfg.command,
            args: this.cfg.args,
            env: buildChildEnv(this.cfg, serverId),
            cwd: await resolveStdioServerCwd(this.cfg, serverId),
          })
        : await McpSdkClient.connectStreamableHttp({
            serverId,
            url: this.cfg.url,
            headers: buildHttpHeaders(this.cfg, serverId),
            sessionId: this.cfg.sessionId,
          });

    const runtime = new McpServerRuntime({
      serverId: this.serverId,
      toolsetName: this.toolsetName,
      client,
    });

    return runtime;
  }

  public finalizeLeaseForDialog(dialogKey: string, runtime: McpServerRuntime): void {
    this.leaseInitByDialogKey.delete(dialogKey);
    if (this.canceledLeaseDialogs.has(dialogKey)) {
      this.canceledLeaseDialogs.delete(dialogKey);
      runtime.requestStop({ forceKillAfterMs: 3_000 });
      return;
    }
    if (this.stopRequested) {
      runtime.requestStop({ forceKillAfterMs: 3_000 });
      return;
    }
    this.leasesByDialogKey.set(dialogKey, runtime);
    notifyToolAvailabilityRuntimeLeaseChanged(`mcp_lease_acquired:${this.serverId}:${dialogKey}`);
  }

  public attachLeaseReminder(dlg: Dialog): void {
    if (this.cfg.truelyStateless) return;
    ensureLeaseReminder(dlg, this.serverId);
  }
}

export function isMcpToolsetLeasedToDialog(serverId: string, dialogKey: string): boolean {
  const state = serverStateById.get(serverId);
  if (!state) return false;
  return state.dispatch.hasLeaseForDialog(dialogKey);
}

export function releaseMcpToolsetLeaseForDialog(
  serverId: string,
  dialogKey: string,
): { ok: true; released: boolean } | { ok: false; errorText: string } {
  const state = serverStateById.get(serverId);
  if (!state) {
    return { ok: false, errorText: `MCP server '${serverId}' is not loaded` };
  }
  if (state.cfg.truelyStateless) {
    return { ok: true, released: false };
  }
  const released = state.dispatch.releaseLeaseForDialog(dialogKey);
  return { ok: true, released };
}

export function getMcpRuntimeLeasesForDialog(dialogKey: string): ReadonlyArray<{
  serverId: string;
  transport: 'stdio' | 'streamable_http';
}> {
  const leases: Array<{
    serverId: string;
    transport: 'stdio' | 'streamable_http';
  }> = [];
  for (const [serverId, state] of serverStateById.entries()) {
    if (state.cfg.truelyStateless) {
      continue;
    }
    if (!state.dispatch.hasLeaseForDialog(dialogKey)) {
      continue;
    }
    leases.push({
      serverId,
      transport: state.cfg.transport,
    });
  }
  leases.sort((a, b) => a.serverId.localeCompare(b.serverId));
  return leases;
}

export function getMcpDeclaredServerRuntimeStatuses(): readonly McpDeclaredServerRuntimeStatus[] {
  return declaredServerIdsInYamlOrder.map((serverId) => {
    const catalogEntry = declaredServerRuntimeCatalogById.get(serverId);
    if (catalogEntry?.configErrorText) {
      return {
        serverId,
        transport: catalogEntry.transport,
        status: 'config_invalid',
        errorText: catalogEntry.configErrorText,
      };
    }
    if (catalogEntry?.disabled) {
      return {
        serverId,
        transport: catalogEntry.transport,
        status: 'disabled',
      };
    }
    if (serverStateById.has(serverId)) {
      return {
        serverId,
        transport: catalogEntry?.transport ?? 'unknown',
        status: 'loaded',
      };
    }
    return {
      serverId,
      transport: catalogEntry?.transport ?? 'unknown',
      status: 'temporarily_unavailable',
      errorText: catalogEntry?.runtimeErrorText,
    };
  });
}

let mindsDirWatcher: fs.FSWatcher | undefined;
let workspaceWatcher: fs.FSWatcher | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let lastSeenMcpYamlSig: string | undefined;
let reloadChain: Promise<void> = Promise.resolve();
let supervisorStarted = false;

export function startMcpSupervisor(): void {
  if (supervisorStarted) return;
  supervisorStarted = true;

  reloadChain = reloadChain
    .then(async () => await reloadNow('startup'))
    .catch((err) => {
      log.warn('MCP initial load failed', err);
    });

  // Initialize signature baseline (best-effort). This reduces false negatives in polling on filesystems
  // with coarse mtime resolution.
  reloadChain = reloadChain
    .then(async () => {
      const sig = await readMcpYamlSig();
      lastSeenMcpYamlSig = sig;
    })
    .catch((err: unknown) => {
      log.warn('MCP initial signature read failed', err);
    });

  // Best-effort file watch (fast feedback). `.minds/` may be wiped/recreated during a dev session,
  // so watcher setup must be resilient and re-attempted at runtime.
  void ensureMindsDirWatcher('startup');

  // Watch rtws root for `.minds/` create/delete. This improves responsiveness when `.minds/`
  // appears/disappears without requiring a full polling interval.
  try {
    workspaceWatcher = fs.watch('.', { persistent: false }, (_event, filename) => {
      const name = filename ? filename.toString() : '';
      if (name !== '' && name !== path.dirname(MCP_YAML_PATH)) return;
      void ensureMindsDirWatcher('rtws.watch');
      scheduleReload('rtws.watch');
    });
    workspaceWatcher.on('error', () => {
      if (workspaceWatcher) {
        workspaceWatcher.close();
        workspaceWatcher = undefined;
      }
    });
  } catch {
    // ignore; polling still works
  }

  // Polling fallback for reliability (editors that write via rename, platforms where watch misses).
  pollTimer = setInterval(() => {
    void maybePollReload();
    void ensureMindsDirWatcher('poll');
  }, 1500);
}

export function stopMcpSupervisor(): void {
  if (mindsDirWatcher) {
    mindsDirWatcher.close();
    mindsDirWatcher = undefined;
  }
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = undefined;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  lastSeenMcpYamlSig = undefined;
  clearDeclaredServerRuntimeCatalog();
  supervisorStarted = false;
}

export function requestMcpServerRestart(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  return new Promise((resolve) => {
    reloadChain = reloadChain
      .then(async () => {
        try {
          const res = await restartServerNow(serverId);
          resolve(res);
        } catch (err: unknown) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.warn(`MCP server restart failed`, err, { serverId });
          resolve({ ok: false, errorText });
        }
      })
      .catch((err: unknown) => {
        const errorText = err instanceof Error ? err.message : String(err);
        log.warn(`MCP server restart enqueue failed`, err, { serverId });
        resolve({ ok: false, errorText });
      });
  });
}

export function requestMcpServerDisable(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  return new Promise((resolve) => {
    reloadChain = reloadChain
      .then(async () => {
        try {
          const res = await disableServerNow(serverId);
          resolve(res);
        } catch (err: unknown) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.warn(`MCP server disable failed`, err, { serverId });
          resolve({ ok: false, errorText });
        }
      })
      .catch((err: unknown) => {
        const errorText = err instanceof Error ? err.message : String(err);
        log.warn(`MCP server disable enqueue failed`, err, { serverId });
        resolve({ ok: false, errorText });
      });
  });
}

export function requestMcpConfigReload(
  reason: string = 'manual',
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  const normalizedReason = reason.trim() === '' ? 'manual' : reason.trim();
  return new Promise((resolve) => {
    reloadChain = reloadChain
      .then(async () => {
        try {
          await reloadNow(`manual request (${normalizedReason})`);
          resolve({ ok: true });
        } catch (err: unknown) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.warn(`MCP config reload failed`, err, { reason: normalizedReason });
          resolve({ ok: false, errorText });
        }
      })
      .catch((err: unknown) => {
        const errorText = err instanceof Error ? err.message : String(err);
        log.warn(`MCP config reload enqueue failed`, err, { reason: normalizedReason });
        resolve({ ok: false, errorText });
      });
  });
}

async function ensureMindsDirWatcher(reason: string): Promise<void> {
  let st: fs.Stats | null = null;
  try {
    st = await fs.promises.stat(path.dirname(MCP_YAML_PATH));
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // `.minds/` may not exist; treat as normal and ensure watcher is detached.
      if (mindsDirWatcher) {
        mindsDirWatcher.close();
        mindsDirWatcher = undefined;
      }
      return;
    }
    return;
  }

  if (!st.isDirectory()) {
    if (mindsDirWatcher) {
      mindsDirWatcher.close();
      mindsDirWatcher = undefined;
    }
    return;
  }

  if (mindsDirWatcher) return;

  try {
    mindsDirWatcher = fs.watch(
      path.dirname(MCP_YAML_PATH),
      { persistent: false },
      (_event, filename) => {
        if (filename && filename.toString() !== path.basename(MCP_YAML_PATH)) return;
        scheduleReload(`minds.watch (${reason})`);
      },
    );
    mindsDirWatcher.on('error', () => {
      // Directory may be wiped/recreated; drop watcher and let polling recreate it.
      if (mindsDirWatcher) {
        mindsDirWatcher.close();
        mindsDirWatcher = undefined;
      }
    });
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // `.minds/` disappeared between stat and watch; normal in dev.
      return;
    }
    // Non-fatal; polling still works.
    log.warn('Failed to start fs.watch for MCP config; polling only', err);
  }
}

function scheduleReload(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    reloadChain = reloadChain
      .then(async () => await reloadNow(reason))
      .catch((err) => {
        log.warn('MCP reload failed', err);
      });
  }, 200);
}

async function readMcpYamlSig(): Promise<string> {
  try {
    const st = await fs.promises.stat(MCP_YAML_PATH);
    if (!st.isFile()) {
      return `not_file/${st.size}/${st.mtimeMs}/${st.ctimeMs}`;
    }
    return `${st.size}/${st.mtimeMs}/${st.ctimeMs}`;
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      return 'missing';
    }
    return 'error';
  }
}

async function maybePollReload(): Promise<void> {
  const sig = await readMcpYamlSig();
  if (lastSeenMcpYamlSig === undefined) {
    lastSeenMcpYamlSig = sig;
    return;
  }
  if (sig === lastSeenMcpYamlSig) return;
  lastSeenMcpYamlSig = sig;
  scheduleReload('poll');
}

async function reloadNow(reason: string): Promise<void> {
  let rawText: string;
  try {
    rawText = await fs.promises.readFile(MCP_YAML_PATH, 'utf8');
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // Deletion is treated as empty config.
      await applyWorkspaceConfig(
        { version: 1, servers: {} },
        [],
        [],
        [],
        [],
        null,
        `missing file (${reason})`,
      );
      clearWorkspaceConfigProblem();
      await reconcileMcpManualProblemsForRuntime([], null);
      return;
    }
    clearDeclaredServerRuntimeCatalog();
    await reconcileMcpManualProblemsForRuntime([], null);
    upsertWorkspaceConfigProblem(`Failed to read ${MCP_YAML_PATH}: ${String(err)}`);
    return;
  }

  const parsed = parseMcpYaml(rawText);
  if (!parsed.ok) {
    clearDeclaredServerRuntimeCatalog();
    await reconcileMcpManualProblemsForRuntime([], null);
    upsertWorkspaceConfigProblem(parsed.errorText);
    return;
  }

  clearWorkspaceConfigProblem();
  await applyWorkspaceConfig(
    parsed.config,
    parsed.invalidServers,
    parsed.serverIdsInYamlOrder,
    parsed.validServerIdsInYamlOrder,
    parsed.disabledServerIdsInYamlOrder,
    rawText,
    reason,
  );
  await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, rawText);
}

async function restartServerNow(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  let removedPlaceholder = false;
  const notifyPlaceholderRemovalOnFailure = (trigger: string): void => {
    if (!removedPlaceholder) return;
    notifyToolAvailabilityRegistryMaybeChanged({
      reason: 'registry_changed',
      trigger,
    });
  };

  let rawText: string;
  try {
    rawText = await fs.promises.readFile(MCP_YAML_PATH, 'utf8');
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // Deletion is treated as empty config, so restart cannot proceed.
      clearWorkspaceConfigProblem();
      await reconcileMcpManualProblemsForRuntime([], null);
      return { ok: false, errorText: `Cannot restart '${serverId}': ${MCP_YAML_PATH} is missing` };
    }
    await reconcileMcpManualProblemsForRuntime([], null);
    upsertWorkspaceConfigProblem(`Failed to read ${MCP_YAML_PATH}: ${String(err)}`);
    return { ok: false, errorText: `Failed to read ${MCP_YAML_PATH}: ${String(err)}` };
  }

  let activeRawText = rawText;
  let parsed = parseMcpYaml(activeRawText);
  if (!parsed.ok) {
    await reconcileMcpManualProblemsForRuntime([], null);
    upsertWorkspaceConfigProblem(parsed.errorText);
    return { ok: false, errorText: parsed.errorText };
  }

  clearWorkspaceConfigProblem();

  const disabledServer =
    parsed.serverIdsInYamlOrder.includes(serverId) &&
    parsed.invalidServers.every((s) => s.serverId !== serverId) &&
    parsed.config.servers[serverId] === undefined;
  if (disabledServer) {
    const enableRes = setServerEnabledInMcpYaml(rawText, serverId, true);
    if (!enableRes.ok) {
      await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, rawText);
      return { ok: false, errorText: enableRes.errorText };
    }
    if (enableRes.changed) {
      await fs.promises.writeFile(MCP_YAML_PATH, enableRes.rawText, 'utf8');
      lastSeenMcpYamlSig = await readMcpYamlSig();
      removedPlaceholder = unregisterMcpToolsetPlaceholder(serverId) || removedPlaceholder;
    }
    activeRawText = enableRes.rawText;
    parsed = parseMcpYaml(activeRawText);
    if (!parsed.ok) {
      clearDeclaredServerRuntimeCatalog();
      await reconcileMcpManualProblemsForRuntime([], null);
      upsertWorkspaceConfigProblem(parsed.errorText);
      notifyPlaceholderRemovalOnFailure(`mcp:restart:${serverId}:parse-failed`);
      return { ok: false, errorText: parsed.errorText };
    }
    clearWorkspaceConfigProblem();
  }

  const invalid = parsed.invalidServers.find((s) => s.serverId === serverId);
  if (invalid) {
    replaceDeclaredServerRuntimeCatalog(
      parsed.config,
      parsed.invalidServers,
      parsed.serverIdsInYamlOrder,
      parsed.disabledServerIdsInYamlOrder,
    );
    await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, activeRawText);
    upsertMcpServerConfigInvalidProblem(serverId, invalid.errorText);
    notifyPlaceholderRemovalOnFailure(`mcp:restart:${serverId}:config-invalid`);
    return { ok: false, errorText: invalid.errorText };
  }

  const serverCfg = parsed.config.servers[serverId];
  if (!serverCfg) {
    await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, activeRawText);
    notifyPlaceholderRemovalOnFailure(`mcp:restart:${serverId}:not-configured`);
    return {
      ok: false,
      errorText: `MCP server '${serverId}' is not configured in ${MCP_YAML_PATH}`,
    };
  }

  const desiredToolsetName = serverId;
  const fingerprint = fingerprintServerConfig(serverCfg);
  const existing = serverStateById.get(serverId);
  const runtimeLeaseChanged = existing !== undefined;
  replaceDeclaredServerRuntimeCatalog(
    parsed.config,
    parsed.invalidServers,
    parsed.serverIdsInYamlOrder,
    parsed.disabledServerIdsInYamlOrder,
  );
  if (!existing) {
    removedPlaceholder = unregisterMcpToolsetPlaceholder(serverId) || removedPlaceholder;
  }

  const res = await tryBuildServerState(serverCfg, desiredToolsetName, fingerprint);
  if (!res.ok) {
    await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, activeRawText);
    upsertDeclaredServerRuntimeError(serverId, res.errorText);
    upsertMcpServerRuntimeUnavailableProblem(serverId, res.errorText, res.detailTextI18n);
    notifyPlaceholderRemovalOnFailure(`mcp:restart:${serverId}:runtime-unavailable`);
    return { ok: false, errorText: res.errorText };
  }

  clearDeclaredServerRuntimeError(serverId);
  removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);

  if (existing) {
    stopLoadedServer(serverId);
  }

  registerServer(res.state);
  serverStateById.set(serverId, res.state);
  reconcileProblemsByPrefix(problemPrefixForServer(serverId), res.state.problems);
  reorderMcpToolsetsInRegistry(parsed.serverIdsInYamlOrder);
  await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, activeRawText);
  notifyToolAvailabilityRegistryMaybeChanged({
    reason: 'registry_changed',
    trigger: `mcp:restart:${serverId}`,
  });
  if (runtimeLeaseChanged) {
    notifyToolAvailabilityRuntimeLeaseChanged(`mcp:restart:${serverId}`);
  }
  return { ok: true };
}

async function disableServerNow(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  const stoppedExisting = stopLoadedServer(serverId);

  let rawText: string;
  try {
    rawText = await fs.promises.readFile(MCP_YAML_PATH, 'utf8');
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (stoppedExisting) {
      notifyToolAvailabilityRegistryMaybeChanged({
        reason: 'registry_changed',
        trigger: `mcp:disable:${serverId}:read-failed`,
      });
      notifyToolAvailabilityRuntimeLeaseChanged(`mcp:disable:${serverId}:read-failed`);
    }
    if (code === 'ENOENT') {
      return { ok: false, errorText: `Cannot disable '${serverId}': ${MCP_YAML_PATH} is missing` };
    }
    return { ok: false, errorText: `Failed to read ${MCP_YAML_PATH}: ${String(err)}` };
  }

  const disableRes = setServerEnabledInMcpYaml(rawText, serverId, false);
  if (!disableRes.ok) {
    if (stoppedExisting) {
      notifyToolAvailabilityRegistryMaybeChanged({
        reason: 'registry_changed',
        trigger: `mcp:disable:${serverId}:disable-failed`,
      });
      notifyToolAvailabilityRuntimeLeaseChanged(`mcp:disable:${serverId}:disable-failed`);
    }
    return { ok: false, errorText: disableRes.errorText };
  }

  if (disableRes.changed) {
    await fs.promises.writeFile(MCP_YAML_PATH, disableRes.rawText, 'utf8');
    lastSeenMcpYamlSig = await readMcpYamlSig();
  }

  const parsed = parseMcpYaml(disableRes.rawText);
  if (!parsed.ok) {
    clearDeclaredServerRuntimeCatalog();
    await reconcileMcpManualProblemsForRuntime([], null);
    upsertWorkspaceConfigProblem(parsed.errorText);
    if (stoppedExisting) {
      notifyToolAvailabilityRegistryMaybeChanged({
        reason: 'registry_changed',
        trigger: `mcp:disable:${serverId}:parse-failed`,
      });
      notifyToolAvailabilityRuntimeLeaseChanged(`mcp:disable:${serverId}:parse-failed`);
    }
    return { ok: false, errorText: parsed.errorText };
  }

  clearWorkspaceConfigProblem();
  await applyWorkspaceConfig(
    parsed.config,
    parsed.invalidServers,
    parsed.serverIdsInYamlOrder,
    parsed.validServerIdsInYamlOrder,
    parsed.disabledServerIdsInYamlOrder,
    disableRes.rawText,
    `mcp_disable:${serverId}`,
  );
  await reconcileMcpManualProblemsForRuntime(parsed.serverIdsInYamlOrder, disableRes.rawText);
  if (stoppedExisting) {
    notifyToolAvailabilityRuntimeLeaseChanged(`mcp:disable:${serverId}`);
  }
  return { ok: true };
}

function setServerEnabledInMcpYaml(
  rawText: string,
  serverId: string,
  enabled: boolean,
): { ok: true; rawText: string; changed: boolean } | { ok: false; errorText: string } {
  const doc = YAML.parseDocument(rawText, { prettyErrors: true });
  if (doc.errors.length > 0) {
    return { ok: false, errorText: doc.errors.map((e) => String(e)).join('\n') };
  }

  const parsed: unknown = doc.toJS();
  if (!isRecord(parsed)) {
    return { ok: false, errorText: `Invalid mcp.yaml: expected object at mcp.yaml root` };
  }
  if (parsed.version !== 1) {
    return { ok: false, errorText: `Invalid mcp.yaml: expected version: 1` };
  }

  const servers = parsed.servers;
  const server = isRecord(servers) ? servers[serverId] : undefined;
  if (!isRecord(server)) {
    return {
      ok: false,
      errorText: `MCP server '${serverId}' is not configured in ${MCP_YAML_PATH}`,
    };
  }

  const currentEnabled = server.enabled;
  if (currentEnabled !== undefined && typeof currentEnabled !== 'boolean') {
    return {
      ok: false,
      errorText: `Invalid mcp.yaml: servers.${serverId}.enabled must be a boolean`,
    };
  }
  if (currentEnabled === enabled) {
    return { ok: true, rawText, changed: false };
  }

  const serverNode = doc.getIn(['servers', serverId], true);
  if (!isMap(serverNode)) {
    return {
      ok: false,
      errorText: `Invalid mcp.yaml: servers.${serverId} must be an object`,
    };
  }

  const existingEnabledPair = serverNode.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === 'enabled',
  );
  if (existingEnabledPair) {
    existingEnabledPair.value = doc.createNode(enabled);
  } else {
    serverNode.items.unshift(doc.createPair('enabled', enabled));
  }
  return { ok: true, rawText: String(doc), changed: true };
}

function stopLoadedServer(serverId: string): boolean {
  const existing = serverStateById.get(serverId);
  if (!existing) return false;
  unregisterServer(existing);
  existing.dispatch.requestStop();
  serverStateById.delete(serverId);
  reconcileProblemsByPrefix(problemPrefixForServer(serverId), []);
  return true;
}

async function reconcileMcpManualProblemsForRuntime(
  serverIdsInYamlOrder: ReadonlyArray<string>,
  rawText: string | null,
): Promise<void> {
  const manualInfo =
    rawText === null ? emptyMcpToolsetManualByServer() : parseMcpManualByServer(rawText);
  await reconcileMcpToolsetManualProblems({
    serverIds: serverIdsInYamlOrder,
    manualInfo,
    measureRenderedWorkspaceMcpTopicRawChars: measureRenderedTeamMgmtMcpTopicRawChars,
    workspaceManualPath: MCP_YAML_PATH,
  });
}

function upsertWorkspaceConfigProblem(errorText: string): void {
  upsertProblem({
    kind: 'mcp_workspace_config_error',
    source: 'mcp',
    id: 'mcp/workspace_config_error',
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: 'MCP rtws config error',
    messageI18n: {
      en: 'MCP rtws config error',
      zh: 'MCP rtws 配置错误',
    },
    detail: { filePath: MCP_YAML_PATH, errorText },
  });
}

function clearWorkspaceConfigProblem(): void {
  removeProblemsByPrefix('mcp/workspace_config_error');
}

function upsertMcpServerConfigInvalidProblem(
  serverId: string,
  errorText: string,
  detailTextI18n?: ProblemI18nText,
): void {
  upsertProblem({
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${problemPrefixForServer(serverId)}server_error`,
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${serverId}' failed to parse config`,
    messageI18n: {
      en: `MCP server '${serverId}' failed to parse config`,
      zh: `MCP server '${serverId}' 解析配置失败`,
    },
    detailTextI18n,
    detail: { serverId, errorText },
  });
}

function upsertMcpServerRuntimeUnavailableProblem(
  serverId: string,
  errorText: string,
  detailTextI18n?: ProblemI18nText,
): void {
  upsertProblem({
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${problemPrefixForServer(serverId)}server_error`,
    severity: 'info',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${serverId}' is currently unavailable`,
    messageI18n: {
      en: `MCP server '${serverId}' is currently unavailable`,
      zh: `MCP server '${serverId}' 当前不可用`,
    },
    detailTextI18n,
    detail: { serverId, errorText },
  });
}

function upsertMcpToolCallProblem(args: {
  serverId: string;
  toolName: string;
  errorText: string;
}): void {
  const workLanguage = getWorkLanguage();
  const normalizedErrorText =
    args.errorText.length > 10_000 ? `${args.errorText.slice(0, 10_000)}…` : args.errorText;
  const hintLines =
    workLanguage === 'zh'
      ? [
          '建议排查：',
          `- 如果需要全局重建该 MCP server，直接调用 mcp_restart({"serverId":"${args.serverId}"})；它成功后会清理旧 runtime 的全部 lease`,
          `- 如果只想丢弃当前对话的连接，再调用 mcp_release({"serverId":"${args.serverId}"})`,
          `- 重新打开/关闭浏览器窗口，避免 Playwright persistent context 残留`,
          `- 查看 ${MCP_YAML_PATH} 是否已加载且配置正确（Problems 面板 / 后端日志）`,
        ]
      : [
          'Suggested checks:',
          `- To rebuild this MCP server globally, call mcp_restart({"serverId":"${args.serverId}"}) directly; a successful restart clears all leases on the old runtime`,
          `- To discard only this dialog's connection, call mcp_release({"serverId":"${args.serverId}"})`,
          `- Close/reopen browser windows to avoid leftover Playwright persistent contexts`,
          `- Verify ${MCP_YAML_PATH} is loaded and valid (Problems panel / backend logs)`,
        ];

  upsertProblem({
    kind: 'generic_problem',
    source: 'system',
    id: `${MCP_TOOL_CALL_PROBLEM_PREFIX}${sanitizePathSegment(args.serverId)}`,
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message:
      workLanguage === 'zh'
        ? `MCP 工具调用失败：${args.serverId}.${args.toolName}`
        : `MCP tool call failed: ${args.serverId}.${args.toolName}`,
    detail: {
      text: [
        `serverId=${args.serverId}`,
        `toolName=${args.toolName}`,
        '',
        'error:',
        normalizedErrorText,
        '',
        ...hintLines,
      ].join('\n'),
    },
  });
}

function clearMcpToolCallProblem(serverId: string): void {
  removeProblemsByPrefix(`${MCP_TOOL_CALL_PROBLEM_PREFIX}${sanitizePathSegment(serverId)}`);
}

async function applyWorkspaceConfig(
  config: McpWorkspaceConfig,
  invalidServers: ReadonlyArray<{ serverId: string; errorText: string }>,
  serverIdsInYamlOrder: ReadonlyArray<string>,
  validServerIdsInYamlOrder: ReadonlyArray<string>,
  disabledServerIdsInYamlOrder: ReadonlyArray<string>,
  rawText: string | null,
  reason: string,
): Promise<void> {
  log.info(`Applying MCP rtws config (${reason})`);
  replaceDeclaredServerRuntimeCatalog(
    config,
    invalidServers,
    serverIdsInYamlOrder,
    disabledServerIdsInYamlOrder,
  );
  let runtimeLeaseChanged = false;

  const invalidIds = new Set(invalidServers.map((s) => s.serverId));
  const desiredIds = new Set([...Object.keys(config.servers), ...invalidIds]);
  const declaredIds = new Set(serverIdsInYamlOrder);

  // Remove deleted servers first.
  for (const [serverId, state] of serverStateById.entries()) {
    if (desiredIds.has(serverId)) continue;
    unregisterServer(state);
    state.dispatch.requestStop();
    runtimeLeaseChanged = true;
    serverStateById.delete(serverId);
    reconcileProblemsByPrefix(problemPrefixForServer(serverId), []);
  }

  // Remove disabled/deleted MCP placeholders that are no longer declared.
  for (const [toolsetName, owner] of Array.from(toolsetOwnerByName.entries())) {
    if (owner.kind !== 'mcp') continue;
    if (declaredIds.has(owner.serverId)) continue;
    unregisterToolset(toolsetName);
    toolsetOwnerByName.delete(toolsetName);
  }

  // Surface invalid server config errors (while keeping last-known-good runtimes registered).
  for (const s of invalidServers) {
    unregisterMcpToolsetPlaceholder(s.serverId);
    upsertMcpServerConfigInvalidProblem(s.serverId, s.errorText);
  }

  // Apply desired servers independently (deterministic order).
  for (const serverId of validServerIdsInYamlOrder) {
    const serverCfg = config.servers[serverId];
    if (!serverCfg) continue;

    const desiredToolsetName = serverId;
    const fingerprint = fingerprintServerConfig(serverCfg);
    const existing = serverStateById.get(serverId);

    if (!existing || existing.configFingerprint !== fingerprint) {
      if (!existing) {
        unregisterMcpToolsetPlaceholder(serverId);
      }
      const res = await tryBuildServerState(serverCfg, desiredToolsetName, fingerprint);
      if (!res.ok) {
        upsertDeclaredServerRuntimeError(serverId, res.errorText);
        // Keep last-known-good registration, but surface per-server error.
        upsertMcpServerRuntimeUnavailableProblem(serverId, res.errorText, res.detailTextI18n);
        continue;
      }

      // Successful start: replace old runtime/tools.
      clearDeclaredServerRuntimeError(serverId);
      removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);
      if (existing) {
        unregisterServer(existing);
        existing.dispatch.requestStop();
        runtimeLeaseChanged = true;
      }
      registerServer(res.state);
      serverStateById.set(serverId, res.state);
      reconcileProblemsByPrefix(problemPrefixForServer(serverId), res.state.problems);
      continue;
    }

    // Config unchanged, but recompute desired tool registration to:
    // - auto-clear disappeared problems
    // - re-attempt registering tools that were previously skipped due to collisions
    clearDeclaredServerRuntimeError(serverId);
    removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);
    const rebuilt = buildToolsForServer(serverCfg, existing.dispatch, existing.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: desiredToolsetName,
      configFingerprint: fingerprint,
      cfg: existing.cfg,
      listedTools: existing.listedTools,
      dispatch: existing.dispatch,
      tools: rebuilt.tools,
      ownedToolNames: rebuilt.ownedToolNames,
      problems: rebuilt.problems,
    };

    const sameTools = setsEqual(existing.ownedToolNames, next.ownedToolNames);
    if (!sameTools) {
      unregisterServer(existing);
      registerServer(next);
      serverStateById.set(serverId, next);
    }

    reconcileProblemsByPrefix(problemPrefixForServer(serverId), next.problems);
  }

  // Second pass: after all adds/updates, re-run collision resolution so earlier servers can pick up
  // tools that become available due to later server changes in the same reload cycle.
  for (let i = 0; i < 2; i++) {
    const changed = reconcileCollisionDependentRegistrations(config, validServerIdsInYamlOrder);
    if (!changed) break;
  }

  const manualInfo =
    rawText === null ? emptyMcpToolsetManualByServer() : parseMcpManualByServer(rawText);
  for (const serverId of disabledServerIdsInYamlOrder) {
    reconcileProblemsByPrefix(problemPrefixForServer(serverId), []);
    registerDisabledServerToolset(serverId, manualInfo);
  }

  reorderMcpToolsetsInRegistry(serverIdsInYamlOrder);
  notifyToolAvailabilityRegistryMaybeChanged({
    reason: 'registry_changed',
    trigger: `mcp:apply-workspace-config:${reason}`,
  });
  if (runtimeLeaseChanged) {
    notifyToolAvailabilityRuntimeLeaseChanged(`mcp:apply-workspace-config:${reason}`);
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function clearDeclaredServerRuntimeCatalog(): void {
  declaredServerIdsInYamlOrder = [];
  declaredServerRuntimeCatalogById.clear();
}

function replaceDeclaredServerRuntimeCatalog(
  config: McpWorkspaceConfig,
  invalidServers: ReadonlyArray<{ serverId: string; errorText: string }>,
  serverIdsInYamlOrder: ReadonlyArray<string>,
  disabledServerIdsInYamlOrder: ReadonlyArray<string>,
): void {
  const previousRuntimeErrors = new Map<string, string>();
  for (const [serverId, entry] of declaredServerRuntimeCatalogById.entries()) {
    if (typeof entry.runtimeErrorText === 'string' && entry.runtimeErrorText.trim() !== '') {
      previousRuntimeErrors.set(serverId, entry.runtimeErrorText);
    }
  }

  declaredServerIdsInYamlOrder = [...serverIdsInYamlOrder];
  declaredServerRuntimeCatalogById.clear();
  const disabledIds = new Set(disabledServerIdsInYamlOrder);

  for (const serverId of serverIdsInYamlOrder) {
    if (disabledIds.has(serverId)) {
      declaredServerRuntimeCatalogById.set(serverId, {
        transport: 'unknown',
        disabled: true,
      });
      continue;
    }
    const cfg = config.servers[serverId];
    if (!cfg) continue;
    declaredServerRuntimeCatalogById.set(serverId, {
      transport: cfg.transport,
      runtimeErrorText: previousRuntimeErrors.get(serverId),
    });
  }

  for (const invalid of invalidServers) {
    declaredServerRuntimeCatalogById.set(invalid.serverId, {
      transport: 'invalid',
      configErrorText: invalid.errorText,
    });
  }
}

function upsertDeclaredServerRuntimeError(serverId: string, errorText: string): void {
  const current = declaredServerRuntimeCatalogById.get(serverId);
  declaredServerRuntimeCatalogById.set(serverId, {
    transport: current?.transport ?? 'unknown',
    configErrorText: current?.configErrorText,
    runtimeErrorText: errorText,
  });
}

function clearDeclaredServerRuntimeError(serverId: string): void {
  const current = declaredServerRuntimeCatalogById.get(serverId);
  if (!current || current.runtimeErrorText === undefined) return;
  declaredServerRuntimeCatalogById.set(serverId, {
    transport: current.transport,
    configErrorText: current.configErrorText,
  });
}

function reconcileCollisionDependentRegistrations(
  config: McpWorkspaceConfig,
  serverIds: readonly string[],
): boolean {
  let changedAny = false;

  for (const serverId of serverIds) {
    const serverCfg = config.servers[serverId];
    if (!serverCfg) continue;
    const fingerprint = fingerprintServerConfig(serverCfg);
    const existing = serverStateById.get(serverId);
    if (!existing) continue;
    if (existing.configFingerprint !== fingerprint) continue; // handled by spawn/update path

    const rebuilt = buildToolsForServer(serverCfg, existing.dispatch, existing.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: existing.toolsetName,
      configFingerprint: fingerprint,
      cfg: existing.cfg,
      listedTools: existing.listedTools,
      dispatch: existing.dispatch,
      tools: rebuilt.tools,
      ownedToolNames: rebuilt.ownedToolNames,
      problems: rebuilt.problems,
    };

    const sameTools = setsEqual(existing.ownedToolNames, next.ownedToolNames);
    if (!sameTools) {
      unregisterServer(existing);
      registerServer(next);
      serverStateById.set(serverId, next);
      changedAny = true;
    }

    reconcileProblemsByPrefix(problemPrefixForServer(serverId), next.problems);
  }

  return changedAny;
}
function registerServer(state: ServerState): void {
  for (const t of state.tools) {
    registerTool(t);
    toolOwnerByName.set(t.name, { kind: 'mcp', serverId: state.serverId });
  }
  registerToolset(state.toolsetName, state.tools);
  const manualSpec = state.cfg.manual?.contentFile
    ? buildMcpManualSpec(state.cfg.manual.contentFile)
    : undefined;
  setToolsetMeta(state.toolsetName, {
    source: 'mcp',
    descriptionI18n: {
      en: `MCP server: ${state.serverId}`,
      zh: `MCP 服务器：${state.serverId}`,
    },
    ...(manualSpec !== undefined ? { manualSpec } : {}),
  });
  toolsetOwnerByName.set(state.toolsetName, { kind: 'mcp', serverId: state.serverId });
}

function registerDisabledServerToolset(
  serverId: string,
  manualInfo: McpToolsetManualByServer,
): void {
  const existingToolset = toolsetsRegistry.get(serverId);
  const existingOwner = toolsetOwnerByName.get(serverId);
  if (existingToolset && (!existingOwner || existingOwner.serverId !== serverId)) {
    upsertMcpServerConfigInvalidProblem(serverId, `Toolset name collision: ${serverId}`);
    return;
  }

  registerToolset(serverId, []);
  const manual = manualInfo.manualByServerId.get(serverId);
  const manualSpec: ManualSpec = manual?.contentFile
    ? buildMcpManualSpec(manual.contentFile)
    : {
        topics: ['index'],
        warnOnMissing: false,
        includeSchemaToolsSection: false,
      };
  const inlineManual = manual ? renderInlineMcpToolsetManual(manual) : '';
  const disabledNoticeEn = [
    `This MCP server is configured but disabled in \`.minds/mcp.yaml\` (\`enabled: false\`).`,
    `It intentionally exposes zero tools until an MCP administrator enables it with \`mcp_restart({"serverId":"${serverId}"})\`.`,
    inlineManual,
  ]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
  const disabledNoticeZh = [
    `该 MCP server 已在 \`.minds/mcp.yaml\` 中配置，但当前为禁用状态（\`enabled: false\`）。`,
    `它会刻意暴露为 0 工具的 toolset；需要 MCP 排障/管理员用 \`mcp_restart({"serverId":"${serverId}"})\` 启用后才会加载工具。`,
    inlineManual,
  ]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
  setToolsetMeta(serverId, {
    source: 'mcp',
    descriptionI18n: {
      en: `MCP server: ${serverId} (disabled)`,
      zh: `MCP 服务器：${serverId}（已禁用）`,
    },
    manualNoticeI18n: {
      en: disabledNoticeEn,
      zh: disabledNoticeZh,
    },
    ...(manualSpec !== undefined ? { manualSpec } : {}),
  });
  toolsetOwnerByName.set(serverId, { kind: 'mcp', serverId });
}

function renderInlineMcpToolsetManual(manual: McpToolsetManual): string {
  const parts: string[] = [];
  if (manual.content) {
    parts.push(manual.content);
  }
  for (const section of manual.sections) {
    parts.push(`#### ${section.title}\n\n${section.content}`);
  }
  return parts.join('\n\n');
}

function unregisterMcpToolsetPlaceholder(serverId: string): boolean {
  if (serverStateById.has(serverId)) return false;
  const owner = toolsetOwnerByName.get(serverId);
  if (owner?.kind !== 'mcp' || owner.serverId !== serverId) return false;
  const tools = toolsetsRegistry.get(serverId);
  if (tools && tools.length > 0) return false;
  unregisterToolset(serverId);
  toolsetOwnerByName.delete(serverId);
  return true;
}

function unregisterServer(state: ServerState): void {
  // Unregister toolset first so Team.Member.listTools doesn't resolve stale tools.
  if (toolsetOwnerByName.get(state.toolsetName)?.serverId === state.serverId) {
    unregisterToolset(state.toolsetName);
    toolsetOwnerByName.delete(state.toolsetName);
  }
  for (const toolName of state.ownedToolNames) {
    if (toolOwnerByName.get(toolName)?.serverId !== state.serverId) continue;
    unregisterTool(toolName);
    toolOwnerByName.delete(toolName);
  }
}

function reorderMcpToolsetsInRegistry(serverIdsInYamlOrder: ReadonlyArray<string>): void {
  const desiredToolsetNames = serverIdsInYamlOrder;

  const currentEntries = Array.from(toolsetsRegistry.entries());
  const nonMcpEntries: Array<[string, Tool[]]> = [];
  const mcpToolsetsByName = new Map<string, Tool[]>();
  const mcpToolsetNamesInCurrentOrder: string[] = [];

  for (const [toolsetName, tools] of currentEntries) {
    const owner = toolsetOwnerByName.get(toolsetName);
    if (owner?.kind === 'mcp') {
      mcpToolsetsByName.set(toolsetName, tools);
      mcpToolsetNamesInCurrentOrder.push(toolsetName);
      continue;
    }
    nonMcpEntries.push([toolsetName, tools]);
  }

  const reordered: Array<[string, Tool[]]> = [...nonMcpEntries];
  const placed = new Set<string>();

  for (const toolsetName of desiredToolsetNames) {
    const tools = mcpToolsetsByName.get(toolsetName);
    if (!tools) continue;
    reordered.push([toolsetName, tools]);
    placed.add(toolsetName);
  }

  for (const toolsetName of mcpToolsetNamesInCurrentOrder) {
    if (placed.has(toolsetName)) continue;
    const tools = mcpToolsetsByName.get(toolsetName);
    if (!tools) continue;
    reordered.push([toolsetName, tools]);
  }

  toolsetsRegistry.clear();
  for (const [toolsetName, tools] of reordered) {
    toolsetsRegistry.set(toolsetName, tools);
  }
}

async function tryBuildServerState(
  cfg: McpServerConfig,
  toolsetName: string,
  fingerprint: string,
): Promise<
  | { ok: true; state: ServerState }
  | { ok: false; errorText: string; detailTextI18n?: McpDiagnosticTextI18n }
> {
  const serverId = cfg.serverId;

  // Toolset-name collisions should prevent committing this server.
  const existingToolset = toolsetsRegistry.get(toolsetName);
  const existingOwner = toolsetOwnerByName.get(toolsetName);
  if (existingToolset && (!existingOwner || existingOwner.serverId !== serverId)) {
    return { ok: false, errorText: `Toolset name collision: ${toolsetName}` };
  }

  let client: McpSdkClient | undefined;
  let sharedRuntime: McpServerRuntime | undefined;
  try {
    client =
      cfg.transport === 'stdio'
        ? await McpSdkClient.connectStdio({
            serverId,
            command: cfg.command,
            args: cfg.args,
            env: buildChildEnv(cfg, serverId),
            cwd: await resolveStdioServerCwd(cfg, serverId),
          })
        : await McpSdkClient.connectStreamableHttp({
            serverId,
            url: cfg.url,
            headers: buildHttpHeaders(cfg, serverId),
            sessionId: cfg.sessionId,
          });

    const listedTools = await client.listTools();
    if (cfg.truelyStateless) {
      sharedRuntime = new McpServerRuntime({ serverId, toolsetName, client });
      client = undefined;
    } else {
      await client.close();
      client = undefined;
    }

    const dispatch = new McpServerDispatch({ serverId, toolsetName, cfg, sharedRuntime });
    const build = buildToolsForServer(cfg, dispatch, listedTools);

    const state: ServerState = {
      serverId,
      toolsetName,
      configFingerprint: fingerprint,
      cfg,
      listedTools,
      dispatch,
      tools: build.tools,
      ownedToolNames: build.ownedToolNames,
      problems: build.problems,
    };
    return { ok: true, state };
  } catch (err: unknown) {
    if (sharedRuntime) {
      sharedRuntime.requestStop({ forceKillAfterMs: 3_000 });
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    return {
      ok: false,
      errorText: err instanceof Error ? err.message : String(err),
      detailTextI18n: extractMcpDiagnosticTextI18n(err),
    };
  }
}

function buildToolsForServer(
  cfg: McpServerConfig,
  dispatch: McpServerDispatch,
  listedTools: readonly McpListedTool[],
): { tools: Tool[]; ownedToolNames: Set<string>; problems: WorkspaceProblem[] } {
  const serverId = cfg.serverId;
  const problems: WorkspaceProblem[] = [];
  const tools: Tool[] = [];
  const ownedToolNames = new Set<string>();
  const seenDomindsNames = new Set<string>();

  for (const tool of listedTools) {
    const originalName = tool.name;

    if (!isValidProviderToolName(originalName)) {
      log.warn(`Rejecting MCP tool with invalid name`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_invalid_name',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_invalid_name/${originalName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name is invalid and was rejected`,
        detail: { serverId, toolName: originalName, rule: TOOL_NAME_VALIDITY_RULE },
      });
      continue;
    }

    const exposure = decideToolExposure(originalName, cfg.tools);
    if (exposure.kind === 'blacklisted') {
      log.warn(`MCP tool not registered (blacklisted)`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_blacklisted',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_blacklisted/${originalName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool was excluded by blacklist`,
        detail: { serverId, toolName: originalName, pattern: exposure.pattern },
      });
      continue;
    }
    if (exposure.kind === 'not_whitelisted') {
      log.warn(`MCP tool not registered (not whitelisted)`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_not_whitelisted',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_not_whitelisted/${originalName}`,
        severity: 'info',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool was excluded by whitelist-only mode`,
        detail: { serverId, toolName: originalName, pattern: exposure.pattern },
      });
      continue;
    }

    const domindsName = applyToolNameTransforms(originalName, cfg.transform);
    if (!isValidProviderToolName(domindsName)) {
      log.warn(`Rejecting MCP tool after transforms due to invalid Dominds tool name`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_invalid_name',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_invalid_name/${originalName}/transformed`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `Dominds tool name produced by transforms is invalid and was rejected`,
        detail: { serverId, toolName: domindsName, rule: TOOL_NAME_VALIDITY_RULE },
      });
      continue;
    }

    if (seenDomindsNames.has(domindsName)) {
      log.warn(`Skipping MCP tool due to within-server name collision`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_collision',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_collision/${domindsName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name collision (after transforms)`,
        detail: { serverId, toolName: originalName, domindsToolName: domindsName },
      });
      continue;
    }

    const existingTool = toolsRegistry.get(domindsName);
    const existingOwner = toolOwnerByName.get(domindsName);
    const canReplace = existingOwner?.serverId === serverId;
    if (existingTool && !canReplace) {
      log.warn(`Skipping MCP tool due to global name collision`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_collision',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_collision/${domindsName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name collision with existing tool`,
        detail: { serverId, toolName: originalName, domindsToolName: domindsName },
      });
      continue;
    }

    const func: Tool = {
      type: 'func',
      name: domindsName,
      description: tool.description,
      parameters: tool.inputSchema,
      argsValidation: 'passthrough',
      call: async (dlg, _caller, args: ToolArguments) => {
        return await dispatch.callToolForDialog(dlg, originalName, args);
      },
    };
    tools.push(func);
    ownedToolNames.add(domindsName);
    seenDomindsNames.add(domindsName);
  }

  return { tools, ownedToolNames, problems };
}

function buildChildEnv(cfg: McpServerConfig, serverId: string): Record<string, string> {
  if (cfg.transport !== 'stdio') {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  for (const [k, v] of Object.entries(cfg.env)) {
    switch (v.kind) {
      case 'literal':
        env[k] = v.value;
        break;
      case 'from_env': {
        const val = process.env[v.env];
        if (val === undefined) {
          throw new Error(
            `MCP server '${serverId}' missing required host env var '${v.env}' (for env.${k})`,
          );
        }
        env[k] = val;
        break;
      }
      default: {
        const _exhaustive: never = v;
        throw new Error(`Invalid env mapping kind: ${String(_exhaustive)}`);
      }
    }
  }
  return env;
}

async function resolveStdioServerCwd(cfg: McpServerConfig, serverId: string): Promise<string> {
  if (cfg.transport !== 'stdio') {
    throw new Error(`MCP server '${serverId}' resolveStdioServerCwd requires stdio transport`);
  }
  const baseCwd = path.resolve(process.cwd());
  const resolved = cfg.cwd === undefined ? baseCwd : path.resolve(baseCwd, cfg.cwd);
  try {
    const st = await fs.promises.stat(resolved);
    if (!st.isDirectory()) {
      throw new Error(`MCP server '${serverId}' cwd is not a directory: ${resolved}`);
    }
    return resolved;
  } catch (err: unknown) {
    if (isRecord(err) && 'code' in err && err.code === 'ENOENT') {
      const source = cfg.cwd === undefined ? '<process.cwd()>' : cfg.cwd;
      throw new Error(`MCP server '${serverId}' cwd does not exist: ${source} -> ${resolved}`);
    }
    throw err;
  }
}

function fingerprintServerConfig(cfg: McpServerConfig): string {
  const obj =
    cfg.transport === 'stdio'
      ? {
          truelyStateless: cfg.truelyStateless,
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          cwd: cfg.cwd ?? null,
          env: sortedEntries(cfg.env),
          tools: cfg.tools,
          transform: cfg.transform,
        }
      : {
          truelyStateless: cfg.truelyStateless,
          transport: cfg.transport,
          url: cfg.url,
          headers: sortedEntries(cfg.headers),
          sessionId: cfg.sessionId ?? null,
          tools: cfg.tools,
          transform: cfg.transform,
        };
  return JSON.stringify(obj);
}

function problemPrefixForServer(serverId: string): string {
  return `mcp/server/${serverId}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return 'unnamed';
  return trimmed.replace(/[^0-9A-Za-z._-]/g, '_');
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('data:')) return trimmed;
  const idx = trimmed.indexOf('base64,');
  if (idx < 0) return trimmed;
  return trimmed.slice(idx + 'base64,'.length);
}

function mimeTypeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}

function stringifyMcpToolCallResultSafe(value: unknown): string {
  if (!isRecord(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if ('content' in value) {
    const content = value.content;
    if (!Array.isArray(content)) {
      return JSON.stringify(value);
    }
    const parts: string[] = [];
    for (const item of content) {
      if (isRecord(item) && !Array.isArray(item)) {
        const t = item.type;
        if (t === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
          continue;
        }
        if (t === 'image') {
          const mimeType = typeof item.mimeType === 'string' ? item.mimeType : 'unknown';
          const data = item.data;
          const dataSize = typeof data === 'string' ? data.length : 0;
          parts.push(
            JSON.stringify({
              type: 'image',
              mimeType,
              data: `[omitted base64; length=${dataSize}]`,
            }),
          );
          continue;
        }
      }
      parts.push(JSON.stringify(item));
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined;
    return JSON.stringify(value);
  }

  if ('toolResult' in value) {
    return JSON.stringify(value.toolResult);
  }

  return JSON.stringify(value);
}

async function materializeMcpToolCallOutput(params: {
  dlg: Dialog;
  serverId: string;
  toolName: string;
  raw: unknown;
}): Promise<ToolCallOutput> {
  const rawValue = params.raw;
  if (!isRecord(rawValue) || Array.isArray(rawValue)) {
    return toolSuccess(String(rawValue));
  }

  const maybeContent = rawValue.content;
  if (!Array.isArray(maybeContent)) {
    return toolSuccess(stringifyMcpToolCallResultSafe(rawValue));
  }

  const eventsBase = DialogPersistence.getDialogEventsPath(params.dlg.id, params.dlg.status);

  const contentItems: FuncResultContentItem[] = [];
  const displayLines: string[] = [];

  for (const item of maybeContent) {
    if (!isRecord(item) || Array.isArray(item)) {
      displayLines.push(JSON.stringify(item));
      continue;
    }

    const t = item.type;
    if (t === 'text' && typeof item.text === 'string') {
      const text = item.text;
      contentItems.push({ type: 'input_text', text });
      if (text.trim() !== '') {
        displayLines.push(text);
      }
      continue;
    }

    if (t === 'image') {
      const mimeType =
        typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream';
      const rawData = typeof item.data === 'string' ? item.data : '';
      const base64 = stripDataUrlPrefix(rawData);
      const bytes = Buffer.from(base64, 'base64');
      if (base64.trim() !== '' && bytes.length === 0) {
        displayLines.push(`[image decode failed: ${mimeType}]`);
        continue;
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = mimeTypeToExt(mimeType);
      const relPath = path.posix.join(
        'artifacts',
        'mcp',
        sanitizePathSegment(params.serverId),
        sanitizePathSegment(params.toolName),
        `${ts}-${randomUUID()}.${ext}`,
      );
      const absPath = path.join(eventsBase, ...relPath.split('/'));
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, bytes);

      contentItems.push({
        type: 'input_image',
        mimeType,
        byteLength: bytes.length,
        artifact: {
          rootId: params.dlg.id.rootId,
          selfId: params.dlg.id.selfId,
          status: params.dlg.status,
          relPath,
        },
      });
      displayLines.push(`[image saved: ${mimeType}, ${bytes.length} bytes]`);
      continue;
    }

    displayLines.push(JSON.stringify(item));
  }

  const content = displayLines.join('\n').trim();
  return toolSuccess(
    content !== '' ? content : stringifyMcpToolCallResultSafe(rawValue),
    contentItems.length > 0 ? contentItems : undefined,
  );
}

export function buildHttpHeaders(
  cfg: McpStreamableHttpServerConfig,
  serverId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) {
    switch (v.kind) {
      case 'literal':
        headers[k] = v.value;
        break;
      case 'from_env': {
        const val = process.env[v.env];
        if (val === undefined) {
          throw new Error(
            `MCP server '${serverId}' missing required host env var '${v.env}' (for headers.${k})`,
          );
        }
        headers[k] = `${v.prefix}${val}`;
        break;
      }
      default: {
        const _exhaustive: never = v;
        throw new Error(`Invalid header mapping kind: ${String(_exhaustive)}`);
      }
    }
  }
  return headers;
}

function sortedEntries<T extends { kind: string }>(
  obj: Record<string, T>,
): ReadonlyArray<readonly [string, T]> {
  return Object.entries(obj)
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}
