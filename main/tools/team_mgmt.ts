/**
 * Module: tools/team_mgmt
 *
 * Team management tooling scoped strictly to `.minds/**`.
 *
 * Goals:
 * - Allow a dedicated team manager (e.g. a shadow/hidden member) to manage `.minds/` without granting
 *   broad rtws (runtime workspace) permissions (e.g. `ws_mod`).
 * - Enforce static scoping to `.minds/**` and reject anything outside that subtree.
 */

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { WorkspaceProblem, WorkspaceProblemRecord } from '@longrun-ai/kernel/types/problems';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { registerEnabledAppsToolProxies } from '../apps/runtime';
import type { ChatMessage, ModelParamOption, ProviderConfig } from '../llm/client';
import { LlmConfig, readBuiltinDefaultsYamlRaw } from '../llm/client';
import type { LlmStreamReceiver } from '../llm/gen';
import { getLlmGenerator } from '../llm/gen/registry';
import { createLogger } from '../log';
import { parseMcpYaml } from '../mcp/config';
import { mcpWorkspaceManualProblemPrefix } from '../mcp/manual-problems';
import { requestMcpConfigReload } from '../mcp/supervisor';
import { validateAllPrimingScriptsInRtws } from '../priming';
import {
  clearProblems,
  getProblemsSnapshot,
  listProblems,
  reconcileProblemsByPrefix,
} from '../problems';
import { Team } from '../team';
import { notifyTeamConfigUpdated } from '../team-config-updates';
import type { FuncTool, Tool, ToolArguments, ToolCallOutput } from '../tool';
import { toolFailure, toolSuccess } from '../tool';
import { listDirTool, mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from './fs';
import { truncateInlineText } from './output-limit';
import { getToolsetMeta, listToolsets } from './registry';
import {
  ripgrepCountTool,
  ripgrepFilesTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
  ripgrepSnippetsTool,
} from './ripgrep';
import {
  readMcpToolsetMappingSnapshot,
  renderMcpToolsetManualDetailsSection,
  renderMcpToolsetMappingSection,
  renderMcpToolsetSetupGuideSection,
} from './team_mgmt-mcp-manual';
import {
  applyFileModificationTool,
  overwriteEntireFileTool,
  prepareFileAppendTool,
  prepareFileBlockReplaceTool,
  prepareFileInsertAfterTool,
  prepareFileInsertBeforeTool,
  prepareFileRangeEditTool,
  readFileTool,
} from './txt';

const MINDS_ALLOW = ['.minds/**'] as const;
const MINDS_DIR = '.minds';
const TEAM_YAML_REL = `${MINDS_DIR}/team.yaml`;
const RTWS_APP_YAML_REL = `${MINDS_DIR}/app.yaml`;
const APP_LOCK_YAML_REL = `${MINDS_DIR}/app-lock.yaml`;
const TEAM_YAML_PROBLEM_PREFIX = 'team/team_yaml_error/';
const MCP_YAML_REL = `${MINDS_DIR}/mcp.yaml`;
const MCP_WORKSPACE_PROBLEM_PREFIX = 'mcp/workspace_config_error';
const MCP_SERVER_PROBLEM_PREFIX = 'mcp/server/';
const log = createLogger('tools/team_mgmt');

function ok(result: string, messages?: ChatMessage[]): ToolCallOutput {
  void messages;
  return toolSuccess(result);
}

function fail(result: string, messages?: ChatMessage[]): ToolCallOutput {
  void messages;
  return toolFailure(result);
}

function toolCallOutputToString(output: ToolCallOutput): string {
  return output.content;
}

const TEAM_MGMT_LIST_PROVIDERS_HARD_MAX_PROVIDERS = 80;
const TEAM_MGMT_LIST_MODELS_HARD_MAX_MODELS = 80;
const TEAM_MGMT_LIST_MODELS_HARD_MAX_MODELS_PER_PROVIDER = 20;
const TEAM_MGMT_LIST_MODELS_HARD_MAX_PARAMS = 40;
const TEAM_MGMT_PROBLEM_MESSAGE_CHAR_LIMIT = 220;
const TEAM_MGMT_PROBLEM_DETAIL_CHAR_LIMIT = 1400;
const TEAM_MGMT_RENDERED_PROBLEM_LIMIT = 40;
const TEAM_MGMT_MODELS_TEXT_CHAR_LIMIT = 240;
const TEAM_MGMT_REMOVED_PROBLEM_ID_LIMIT = 50;

function truncateProblemTextBlock(text: string): string {
  return truncateInlineText(text, TEAM_MGMT_PROBLEM_DETAIL_CHAR_LIMIT);
}

function limitProblemsForRender<T>(items: readonly T[]): Readonly<{ shown: T[]; omitted: number }> {
  const shown = items.slice(0, TEAM_MGMT_RENDERED_PROBLEM_LIMIT);
  return { shown, omitted: Math.max(0, items.length - shown.length) };
}

function formatProblemOmittedNotice(language: LanguageCode, omitted: number): string {
  return language === 'zh'
    ? `（为避免输出过长，其余 ${omitted} 条问题未在本次结果中展开；可配合更精确过滤条件继续查看）\n`
    : `(omitted ${omitted} additional problem(s) from this response to keep the output bounded; refine filters to inspect them)\n`;
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function normalizeFileWriteBody(inputBody: string): {
  normalizedBody: string;
  addedTrailingNewlineToContent: boolean;
} {
  if (inputBody === '' || inputBody.endsWith('\n')) {
    return { normalizedBody: inputBody, addedTrailingNewlineToContent: false };
  }
  return { normalizedBody: `${inputBody}\n`, addedTrailingNewlineToContent: true };
}

function isEmptyLine(line: string): boolean {
  return line.trim() === '';
}

function lintTeamYamlStyle(raw: string): string[] {
  const out: string[] = [];
  const lines = raw.split(/\r?\n/);
  // 1) File should end with exactly one trailing newline (split leaves last empty).
  if (raw !== '' && !raw.endsWith('\n')) {
    out.push('- team.yaml should end with a trailing newline.');
  }

  // 2) Warn about large runs of blank lines (prefer single blank line between blocks).
  let maxBlankRun = 0;
  let cur = 0;
  for (const line of lines) {
    if (isEmptyLine(line)) {
      cur++;
      maxBlankRun = Math.max(maxBlankRun, cur);
    } else {
      cur = 0;
    }
  }
  if (maxBlankRun >= 3) {
    out.push(
      '- team.yaml has 3+ consecutive blank lines; prefer a single blank line between blocks.',
    );
  }

  // 3) Warn if there is no blank line separating adjacent top-level member blocks.
  // This is a best-effort heuristic: we treat "  <id>:" (2-space indent) as a member key.
  const memberKeyRe = /^  [A-Za-z0-9_-]+:\s*$/;
  let prevMemberLine: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!memberKeyRe.test(line)) continue;
    if (prevMemberLine !== null) {
      const between = lines.slice(prevMemberLine + 1, i);
      const hasBlank = between.some((l) => isEmptyLine(l));
      if (!hasBlank) {
        out.push(
          `- team.yaml: members blocks should be separated by a blank line (between lines ${prevMemberLine + 1} and ${i + 1}).`,
        );
      }
    }
    prevMemberLine = i;
  }

  return out;
}

async function lintTeamYamlStyleProblems(): Promise<void> {
  const stylePrefix = TEAM_YAML_PROBLEM_PREFIX + 'style/';
  const cwd = path.resolve(process.cwd());
  const teamYamlAbs = path.resolve(cwd, TEAM_YAML_REL);
  try {
    const st = await fs.stat(teamYamlAbs);
    if (!st.isFile()) {
      reconcileProblemsByPrefix(stylePrefix, []);
      return;
    }
  } catch (err: unknown) {
    if (isFsErrWithCode(err) && err.code === 'ENOENT') {
      reconcileProblemsByPrefix(stylePrefix, []);
      return;
    }
    throw err;
  }

  const raw = await fs.readFile(teamYamlAbs, 'utf8');
  const warnings = lintTeamYamlStyle(raw);
  if (warnings.length === 0) {
    reconcileProblemsByPrefix(stylePrefix, []);
    return;
  }

  const now = formatUnifiedTimestamp(new Date());
  reconcileProblemsByPrefix(stylePrefix, [
    {
      kind: 'team_workspace_config_error',
      source: 'team',
      id: stylePrefix + 'formatting',
      severity: 'warning',
      timestamp: now,
      message: `Style warnings in ${TEAM_YAML_REL}.`,
      messageI18n: {
        en: `Style warnings in ${TEAM_YAML_REL}.`,
        zh: `${TEAM_YAML_REL} 存在风格警告。`,
      },
      detailTextI18n: {
        en: warnings.join('\n'),
        zh: warnings
          .join('\n')
          .replace(
            /- team\.yaml has 3\+ consecutive blank lines; prefer a single blank line between blocks\./g,
            '- team.yaml 出现了连续 3 行以上空行；建议块与块之间只保留 1 个空行。',
          )
          .replace(
            /- team\.yaml: members blocks should be separated by a blank line \(between lines (\d+) and (\d+)\)\./g,
            '- team.yaml：成员块之间建议用一个空行分隔（位于第 $1 行与第 $2 行之间）。',
          ),
      },
      detail: { filePath: TEAM_YAML_REL, errorText: warnings.join('\n') },
    },
  ]);
}

function countLogicalLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

function normalizePathToken(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function toMindsRelativePath(raw: string): string {
  const token = normalizePathToken(raw);
  if (token === '' || token === '.') return MINDS_DIR;
  if (token === MINDS_DIR) return MINDS_DIR;
  if (token.startsWith(`${MINDS_DIR}/`)) return token;
  if (token.startsWith(`./${MINDS_DIR}/`)) return token.slice(2);
  if (token.startsWith(`./${MINDS_DIR}`)) return token.slice(2);
  return `${MINDS_DIR}/${token.replace(/^\.\/+/, '')}`;
}

function ensureMindsScopedPath(rel: string): { rel: string; abs: string } {
  const cwd = path.resolve(process.cwd());
  const mindsAbs = path.resolve(cwd, MINDS_DIR);
  const abs = path.resolve(cwd, rel);
  const isInside = abs === mindsAbs || abs.startsWith(mindsAbs + path.sep);
  if (!isInside) {
    throw new Error(`Path must be within ${MINDS_DIR}/`);
  }
  return { rel: path.relative(cwd, abs).replace(/\\/g, '/'), abs };
}

function getUserLang(dlg: { getLastUserLanguageCode(): LanguageCode }): LanguageCode {
  try {
    return dlg.getLastUserLanguageCode();
  } catch {
    return 'en';
  }
}

function makeMindsOnlyAccessMember(caller: Team.Member): Team.Member {
  return new Team.Member({
    id: caller.id,
    name: caller.name,
    read_dirs: [...MINDS_ALLOW],
    write_dirs: [...MINDS_ALLOW],
    internal_allow_minds: true,
  });
}

function isSuccessfulYamlToolResult(output: string, mode: string): boolean {
  return output.includes('status: ok') && output.includes(`mode: ${mode}`);
}

function decodeYamlSingleQuoted(value: string): string {
  return value.replace(/''/g, "'");
}

function extractPathFromYamlToolOutput(output: string): string | null {
  const match = output.match(/(?:^|\n)path: '((?:[^']|'')+)'/);
  if (!match || typeof match[1] !== 'string') return null;
  return decodeYamlSingleQuoted(match[1]);
}

async function refreshDerivedStateAfterTeamMgmtWrite(params: {
  relPaths: ReadonlyArray<string>;
  trigger: string;
}): Promise<void> {
  const affected = params.relPaths.map((relPath) => toMindsRelativePath(relPath));
  if (affected.length === 0) return;

  const touchesTarget = (targetRel: string): boolean =>
    affected.some(
      (relPath) =>
        relPath === targetRel ||
        relPath === MINDS_DIR ||
        targetRel.startsWith(`${relPath}/`) ||
        relPath.startsWith(`${targetRel}/`),
    );

  const touchesTeam = touchesTarget(TEAM_YAML_REL);
  const touchesApps = touchesTarget(RTWS_APP_YAML_REL) || touchesTarget(APP_LOCK_YAML_REL);
  const touchesMcp = touchesTarget(MCP_YAML_REL);
  if (!touchesTeam && !touchesApps && !touchesMcp) return;

  const rtwsRootAbs = process.cwd();
  if (touchesApps) {
    try {
      await registerEnabledAppsToolProxies({ rtwsRootAbs });
    } catch (err: unknown) {
      log.warn('Failed to refresh enabled apps after team_mgmt write', err);
    }
  }

  if (touchesMcp) {
    try {
      const reloadRes = await requestMcpConfigReload(`team_mgmt/${params.trigger}`);
      if (!reloadRes.ok) {
        log.warn(`Failed to reload MCP after team_mgmt write: ${reloadRes.errorText}`);
      }
    } catch (err: unknown) {
      log.warn('Failed to request MCP reload after team_mgmt write', err);
    }
  }

  if (touchesTeam || touchesApps || touchesMcp) {
    try {
      await Team.load();
    } catch (err: unknown) {
      log.warn('Failed to refresh team problems after team_mgmt write', err);
    }
  }

  if (touchesTeam) {
    try {
      await lintTeamYamlStyleProblems();
    } catch (err: unknown) {
      log.warn('Failed to refresh team.yaml style problems after team_mgmt write', err);
    }
    notifyTeamConfigUpdated(`team_mgmt/${params.trigger}`);
  }
}

export function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const flush = (): void => {
    if (current === '') return;
    args.push(current);
    current = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? '';
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (!inSingle && ch === '\\') {
      escape = true;
      continue;
    }
    if (!inDouble && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (!inDouble && ch === "'" && inSingle) {
      inSingle = false;
      continue;
    }
    if (!inSingle && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (!inSingle && ch === '"' && inDouble) {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return args;
}

type FsErrWithCode = { code?: unknown };

function isFsErrWithCode(err: unknown): err is FsErrWithCode {
  return typeof err === 'object' && err !== null && 'code' in err;
}

type MindsDirState =
  | { kind: 'present' }
  | { kind: 'missing' }
  | { kind: 'not_directory'; abs: string };

async function getMindsDirState(): Promise<MindsDirState> {
  const cwd = path.resolve(process.cwd());
  const abs = path.resolve(cwd, MINDS_DIR);
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return { kind: 'not_directory', abs };
    return { kind: 'present' };
  } catch (err: unknown) {
    if (isFsErrWithCode(err) && err.code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
}

function formatMindsMissingNotice(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      `注意：当前 rtws（运行时工作区）未初始化 \`${MINDS_DIR}/\`（这是正常情况）。`,
      `因此当前在 \`${MINDS_DIR}/\` 下没有可读取/可列出的团队配置。`,
      ``,
      `如果要初始化团队配置，请先创建目录：\`team_mgmt_mk_dir({ \"path\": \"${MINDS_DIR}\", \"parents\": true })\`。`,
    ].join('\n');
  }
  return [
    `Note: \`${MINDS_DIR}/\` is not present in this rtws (runtime workspace) (this is normal).`,
    `So there is currently no team configuration to read/list under \`${MINDS_DIR}/\`.`,
    ``,
    `If you want to initialize team configuration, create the directory first: \`team_mgmt_mk_dir({ \"path\": \"${MINDS_DIR}\", \"parents\": true })\`.`,
  ].join('\n');
}

async function ensureMindsRootDirExists(): Promise<void> {
  const cwd = path.resolve(process.cwd());
  const abs = path.resolve(cwd, MINDS_DIR);
  await fs.mkdir(abs, { recursive: true });
}

type TeamConfigProblem = Extract<WorkspaceProblemRecord, { source: 'team' }>;

function listTeamYamlProblems(
  problems: ReadonlyArray<WorkspaceProblemRecord>,
): TeamConfigProblem[] {
  const out: TeamConfigProblem[] = [];
  for (const p of problems) {
    if (p.source !== 'team') continue;
    if (p.id.startsWith(TEAM_YAML_PROBLEM_PREFIX)) {
      out.push(p);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

type McpConfigProblem = Extract<WorkspaceProblemRecord, { source: 'mcp' }>;

function listMcpYamlProblems(problems: ReadonlyArray<WorkspaceProblemRecord>): McpConfigProblem[] {
  const out: McpConfigProblem[] = [];
  for (const p of problems) {
    if (p.source !== 'mcp') continue;
    if (
      p.id.startsWith(MCP_WORKSPACE_PROBLEM_PREFIX) ||
      p.id.startsWith(mcpWorkspaceManualProblemPrefix()) ||
      p.id.startsWith(MCP_SERVER_PROBLEM_PREFIX)
    ) {
      out.push(p);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function splitProblemsByLifecycle<TProblem extends WorkspaceProblemRecord>(
  problems: ReadonlyArray<TProblem>,
): {
  active: TProblem[];
  resolved: TProblem[];
} {
  const active: TProblem[] = [];
  const resolved: TProblem[] = [];
  for (const problem of problems) {
    if (problem.resolved === true) {
      resolved.push(problem);
      continue;
    }
    active.push(problem);
  }
  return { active, resolved };
}

function getWorkspaceProblemPath(problem: WorkspaceProblemRecord): string | null {
  switch (problem.kind) {
    case 'team_workspace_config_error':
    case 'mcp_workspace_config_error':
      return problem.detail.filePath;
    case 'mcp_server_error':
    case 'mcp_tool_collision':
    case 'mcp_tool_blacklisted':
    case 'mcp_tool_not_whitelisted':
    case 'mcp_tool_invalid_name':
    case 'llm_provider_rejected_request':
    case 'generic_problem':
      return null;
  }
}

function getProblemUpdatedAt(problem: WorkspaceProblemRecord): string {
  if (
    problem.resolved === true &&
    typeof problem.resolvedAt === 'string' &&
    problem.resolvedAt !== ''
  ) {
    return problem.resolvedAt;
  }
  return problem.timestamp;
}

const TEAM_MGMT_PROBLEM_SOURCES = ['team', 'mcp', 'llm', 'system'] as const;
type TeamMgmtProblemSource = (typeof TEAM_MGMT_PROBLEM_SOURCES)[number];
const TEAM_MGMT_PROBLEM_STATUS = ['all', 'active', 'resolved'] as const;
type TeamMgmtProblemStatus = (typeof TEAM_MGMT_PROBLEM_STATUS)[number];

function isTeamMgmtProblemSource(value: string): value is TeamMgmtProblemSource {
  return (TEAM_MGMT_PROBLEM_SOURCES as readonly string[]).includes(value);
}

function isTeamMgmtProblemStatus(value: string): value is TeamMgmtProblemStatus {
  return (TEAM_MGMT_PROBLEM_STATUS as readonly string[]).includes(value);
}

function parseTeamMgmtProblemSourceArg(value: unknown): TeamMgmtProblemSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isTeamMgmtProblemSource(value)) {
    throw new Error(`Invalid source (expected one of: ${TEAM_MGMT_PROBLEM_SOURCES.join(', ')})`);
  }
  return value;
}

function parseTeamMgmtProblemStatusArg(
  value: unknown,
  defaultStatus: TeamMgmtProblemStatus,
): TeamMgmtProblemStatus {
  if (value === undefined) return defaultStatus;
  if (typeof value !== 'string' || !isTeamMgmtProblemStatus(value)) {
    throw new Error(`Invalid status (expected one of: ${TEAM_MGMT_PROBLEM_STATUS.join(', ')})`);
  }
  return value;
}

function parseTeamMgmtProblemPathArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid path (expected non-empty string)');
  }
  const rel = toMindsRelativePath(value.trim());
  ensureMindsScopedPath(rel);
  return rel;
}

function parseTeamMgmtProblemIdArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid problem_id (expected non-empty string)');
  }
  return value.trim();
}

function parseOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${fieldName} (expected positive integer)`);
  }
  return value;
}

function formatProblemDetailLines(
  problem: WorkspaceProblemRecord,
  language: LanguageCode,
): string[] {
  const lines: string[] = [
    `- [${problem.severity}] ${problem.id}: ${truncateInlineText(problem.messageI18n?.[language] ?? problem.message, TEAM_MGMT_PROBLEM_MESSAGE_CHAR_LIMIT)}`,
    `  updated: ${getProblemUpdatedAt(problem)}`,
  ];
  if (problem.resolved === true && problem.resolvedAt) {
    lines.push(`  resolved: ${problem.resolvedAt}`);
  }
  const problemPath = getWorkspaceProblemPath(problem);
  if (problemPath !== null) {
    lines.push(`  file: ${problemPath}`);
  }
  switch (problem.kind) {
    case 'team_workspace_config_error':
    case 'mcp_workspace_config_error':
      lines.push(
        '  ' +
          truncateProblemTextBlock(problem.detailTextI18n?.[language] ?? problem.detail.errorText)
            .split('\n')
            .join('\n  '),
      );
      break;
    case 'mcp_server_error':
      lines.push(`  server: ${problem.detail.serverId}`);
      lines.push(
        '  ' +
          truncateProblemTextBlock(problem.detailTextI18n?.[language] ?? problem.detail.errorText)
            .split('\n')
            .join('\n  '),
      );
      break;
    case 'mcp_tool_collision':
      lines.push(`  server: ${problem.detail.serverId}`);
      lines.push(`  tool: ${problem.detail.toolName}`);
      lines.push(`  conflicts_with: ${problem.detail.domindsToolName}`);
      break;
    case 'mcp_tool_blacklisted':
    case 'mcp_tool_not_whitelisted':
      lines.push(`  server: ${problem.detail.serverId}`);
      lines.push(`  tool: ${problem.detail.toolName}`);
      lines.push(`  pattern: ${problem.detail.pattern}`);
      break;
    case 'mcp_tool_invalid_name':
      lines.push(`  server: ${problem.detail.serverId}`);
      lines.push(`  tool: ${problem.detail.toolName}`);
      lines.push(`  rule: ${problem.detail.rule}`);
      break;
    case 'llm_provider_rejected_request':
      lines.push(`  dialog: ${problem.detail.dialogId}`);
      lines.push(`  provider: ${problem.detail.provider}`);
      lines.push(
        '  ' +
          truncateProblemTextBlock(problem.detailTextI18n?.[language] ?? problem.detail.errorText)
            .split('\n')
            .join('\n  '),
      );
      break;
    case 'generic_problem':
      lines.push(
        '  ' +
          truncateProblemTextBlock(problem.detailTextI18n?.[language] ?? problem.detail.text)
            .split('\n')
            .join('\n  '),
      );
      break;
  }
  return lines;
}

function formatResolvedProblemsHint(params: {
  language: LanguageCode;
  source?: TeamMgmtProblemSource;
  path?: string;
}): string {
  const args: string[] = [];
  if (params.source !== undefined) {
    args.push(`source: "${params.source}"`);
  }
  if (params.path !== undefined) {
    const shortPath = params.path.startsWith(`${MINDS_DIR}/`)
      ? params.path.slice(MINDS_DIR.length + 1)
      : params.path;
    args.push(`path: "${shortPath}"`);
  }
  const call =
    args.length > 0
      ? `team_mgmt_clear_problems({ ${args.join(', ')} })`
      : 'team_mgmt_clear_problems({})';
  return params.language === 'zh'
    ? `这些问题已经解决，但仍作为历史项保留在 Problems 面板中；如需清理残留，可执行 \`${call}\`。`
    : `These issues are already resolved but still retained as Problems history; clear them with \`${call}\` if you want to remove the residue.`;
}

type ModelCheckResult = { model: string; status: 'pass' | 'fail'; details?: string };

function formatModelCheckResult(r: ModelCheckResult): string {
  if (r.status === 'pass') return `- ${r.model}: ✅ ok`;
  return `- ${r.model}: ❌ ${r.details ?? 'failed'}`;
}

type RtwsLlmProvidersLoadResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'present'; providers: Record<string, ProviderConfig> };

function escapeRegexChar(ch: string): string {
  // Escape characters with special meaning in JS RegExp patterns.
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function wildcardMatch(value: string, pattern: string): boolean {
  const p = pattern.trim() === '' ? '*' : pattern.trim();
  let re = '^';
  for (const ch of p) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRegexChar(ch);
  }
  re += '$';
  return new RegExp(re).test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isEnvVarConfigured(envVar: string): boolean {
  const raw = process.env[envVar];
  return typeof raw === 'string' && raw.trim().length > 0;
}

function getProviderModelsForListing(providerCfg: ProviderConfig): Record<string, unknown> {
  const rec = providerCfg as unknown as Record<string, unknown>;
  const modelsUnknown = rec['models'];
  if (typeof modelsUnknown !== 'object' || modelsUnknown === null) return {};
  if (Array.isArray(modelsUnknown)) return {};
  return modelsUnknown as Record<string, unknown>;
}

function formatProviderEnvStatusLine(providerCfg: ProviderConfig): string {
  const envVar = providerCfg.apiKeyEnvVar;
  const configured = isEnvVarConfigured(envVar);
  if (configured) return `apiKeyEnvVar: ${envVar} (configured)`;
  if (providerCfg.apiType === 'codex') {
    return `apiKeyEnvVar: ${envVar} (not set; may still work for codex via default ~/.codex)`;
  }
  return `apiKeyEnvVar: ${envVar} (NOT set)`;
}

function listModelIds(models: Record<string, unknown>, maxModels: number): string {
  const ids = Object.keys(models).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) return '(none)';
  const max = maxModels > 0 ? maxModels : 30;
  const head = ids.slice(0, max);
  return truncateInlineText(
    `${head.join(', ')}${ids.length > head.length ? ', ...' : ''}`,
    TEAM_MGMT_MODELS_TEXT_CHAR_LIMIT,
  );
}

async function loadBuiltinLlmProviders(): Promise<Record<string, ProviderConfig>> {
  const raw = await readBuiltinDefaultsYamlRaw();
  const parsed: unknown = YAML.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid defaults.yaml');
  }
  const rec = parsed as Record<string, unknown>;
  const providersUnknown = rec['providers'];
  if (typeof providersUnknown !== 'object' || providersUnknown === null) {
    throw new Error('Invalid defaults.yaml (missing providers)');
  }
  return providersUnknown as Record<string, ProviderConfig>;
}

async function loadRtwsLlmProviders(): Promise<RtwsLlmProvidersLoadResult> {
  const cfgPath = `${MINDS_DIR}/llm.yaml`;
  try {
    await fs.access(cfgPath);
  } catch (err: unknown) {
    if (isFsErrWithCode(err) && err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'invalid', error: 'Invalid llm.yaml (expected root object)' };
    }
    const rec = parsed as Record<string, unknown>;
    const providersUnknown = rec['providers'];
    if (typeof providersUnknown !== 'object' || providersUnknown === null) {
      return { kind: 'invalid', error: 'Invalid llm.yaml (missing providers object)' };
    }
    return { kind: 'present', providers: providersUnknown as Record<string, ProviderConfig> };
  } catch (err: unknown) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
}

function formatModelInfoSummary(info: unknown): string {
  if (typeof info !== 'object' || info === null) return '';
  const rec = info as Record<string, unknown>;
  const parts: string[] = [];
  const nameUnknown = rec['name'];
  if (isNonEmptyString(nameUnknown)) parts.push(`name=${nameUnknown}`);
  const contextLengthUnknown = rec['context_length'];
  if (typeof contextLengthUnknown === 'number') parts.push(`ctx=${contextLengthUnknown}`);
  const inputLengthUnknown = rec['input_length'];
  if (typeof inputLengthUnknown === 'number') parts.push(`in=${inputLengthUnknown}`);
  const outputLengthUnknown = rec['output_length'];
  if (typeof outputLengthUnknown === 'number') parts.push(`out=${outputLengthUnknown}`);
  const optimalMaxTokensUnknown = rec['optimal_max_tokens'];
  if (typeof optimalMaxTokensUnknown === 'number')
    parts.push(`optimal_max_tokens=${optimalMaxTokensUnknown}`);
  const criticalMaxTokensUnknown = rec['critical_max_tokens'];
  if (typeof criticalMaxTokensUnknown === 'number')
    parts.push(`critical_max_tokens=${criticalMaxTokensUnknown}`);
  const contextWindowUnknown = rec['context_window'];
  if (isNonEmptyString(contextWindowUnknown)) parts.push(`context_window=${contextWindowUnknown}`);
  return parts.join(' ');
}

function formatModelParamOptionLine(
  paramName: string,
  opt: ModelParamOption,
  language: LanguageCode,
): string {
  const extras: string[] = [];
  if (opt.prominent === true) extras.push(language === 'zh' ? 'prominent' : 'prominent');
  switch (opt.type) {
    case 'number': {
      const range = `${opt.min ?? ''}..${opt.max ?? ''}`.trim();
      if (range !== '..') extras.push(range);
      if (typeof opt.default === 'number') extras.push(`default=${opt.default}`);
      break;
    }
    case 'integer': {
      const range = `${opt.min ?? ''}..${opt.max ?? ''}`.trim();
      if (range !== '..') extras.push(range);
      if (typeof opt.default === 'number') extras.push(`default=${opt.default}`);
      break;
    }
    case 'boolean': {
      if (typeof opt.default === 'boolean')
        extras.push(`default=${opt.default ? 'true' : 'false'}`);
      break;
    }
    case 'string': {
      if (typeof opt.default === 'string') extras.push(`default=${opt.default}`);
      break;
    }
    case 'string_array': {
      if (Array.isArray(opt.default) && opt.default.every((v) => typeof v === 'string')) {
        extras.push(`default=[${opt.default.join(',')}]`);
      }
      break;
    }
    case 'record_number': {
      if (typeof opt.default === 'object' && opt.default !== null) {
        const entries = Object.entries(opt.default).filter(([, v]) => typeof v === 'number');
        if (entries.length > 0) {
          extras.push(
            `default={${entries
              .slice(0, 6)
              .map(([k, v]) => `${k}:${v}`)
              .join(',')}}`,
          );
        }
      }
      break;
    }
    case 'enum': {
      extras.push(opt.values.join('|'));
      if (typeof opt.default === 'string') extras.push(`default=${opt.default}`);
      break;
    }
    default: {
      const _exhaustive: never = opt;
      throw new Error(`Unhandled ModelParamOption: ${String(_exhaustive)}`);
    }
  }

  const desc = opt.description.trim();
  const descShort = desc.length > 180 ? `${desc.slice(0, 180)}…` : desc;
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `- \`${paramName}\`: \`${opt.type}\`${suffix}${descShort ? ` — ${descShort}` : ''}`;
}

export const teamMgmtCheckProviderTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_check_provider',
  description: 'Validate an LLM provider configuration (and optionally test models).',
  descriptionI18n: {
    en: 'Validate an LLM provider configuration (and optionally test models).',
    zh: '校验 LLM provider 配置（可选对模型做实际连通性测试）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['provider_key'],
    properties: {
      provider_key: { type: 'string' },
      model: { type: 'string' },
      all_models: { type: 'boolean' },
      live: { type: 'boolean' },
      max_models: { type: 'integer' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const providerKeyValue = args['provider_key'];
      const providerKey = typeof providerKeyValue === 'string' ? providerKeyValue.trim() : '';
      if (!providerKey) throw new Error('Provider key required');

      const modelValue = args['model'];
      const model =
        typeof modelValue === 'string' && modelValue.trim() !== '' ? modelValue.trim() : undefined;

      const allModelsValue = args['all_models'];
      const allModels = allModelsValue === true ? true : false;
      if (allModelsValue !== undefined && typeof allModelsValue !== 'boolean') {
        throw new Error('Invalid all_models (expected boolean)');
      }

      const liveValue = args['live'];
      const live = liveValue === true ? true : false;
      if (liveValue !== undefined && typeof liveValue !== 'boolean') {
        throw new Error('Invalid live (expected boolean)');
      }

      const maxModelsValue = args['max_models'];
      if (maxModelsValue !== undefined && (!isInteger(maxModelsValue) || maxModelsValue <= 0)) {
        throw new Error('Invalid max_models (expected positive integer)');
      }
      const maxModels = isInteger(maxModelsValue) && maxModelsValue > 0 ? maxModelsValue : 10;

      if (model !== undefined && allModels) {
        throw new Error('Use either `model` or `all_models` (not both)');
      }

      const llmCfg = await LlmConfig.load();
      const providerCfg = llmCfg.getProvider(providerKey);
      if (!providerCfg) {
        const msg =
          language === 'zh'
            ? `Provider 不存在：\`${providerKey}\`。请检查 \`.minds/llm.yaml\`（或内置 defaults）。也可先用 \`team_mgmt_list_providers({})\` 查看当前可用 provider keys。`
            : `Provider not found: \`${providerKey}\`. Check \`.minds/llm.yaml\` (or built-in defaults). You can also run \`team_mgmt_list_providers({})\` to see available provider keys.`;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const envVar = providerCfg.apiKeyEnvVar;
      const rawEnvValue = process.env[envVar];
      const envConfigured =
        typeof rawEnvValue === 'string' && rawEnvValue.trim().length > 0 ? true : false;

      const isCodexLike = providerCfg.apiType === 'codex';
      const envStatusLine = envConfigured
        ? `apiKeyEnvVar: ${envVar} (configured)`
        : isCodexLike
          ? `apiKeyEnvVar: ${envVar} (not set; may still work for codex via default ~/.codex)`
          : `apiKeyEnvVar: ${envVar} (NOT set)`;

      const models = Object.keys(providerCfg.models);
      const modelHeader =
        models.length > 0
          ? `models: ${models.slice(0, 30).join(', ')}${models.length > 30 ? ', ...' : ''}`
          : 'models: (none)';

      if (!envConfigured && !isCodexLike) {
        const msg =
          language === 'zh'
            ? [
                fmtHeader('Provider 校验失败'),
                fmtList([
                  `provider: \`${providerKey}\` (apiType: \`${providerCfg.apiType}\`)`,
                  envStatusLine,
                  '该 provider 的环境变量未配置，强烈建议先配置 env var 再修改 team 配置。',
                ]),
              ].join('')
            : [
                fmtHeader('Provider Check Failed'),
                fmtList([
                  `provider: \`${providerKey}\` (apiType: \`${providerCfg.apiType}\`)`,
                  envStatusLine,
                  'Provider env var is not configured. Configure it before changing team config to avoid bricking.',
                ]),
              ].join('');
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const modelsToCheck =
        model !== undefined ? [model] : allModels ? models : models.length > 0 ? [models[0]] : [];

      if (model !== undefined && !Object.prototype.hasOwnProperty.call(providerCfg.models, model)) {
        const msg =
          language === 'zh'
            ? `Model 不存在：\`${model}\` 不在 provider \`${providerKey}\` 的 models 列表中。请先更新 \`.minds/llm.yaml\` 或选择一个已配置的 model key。也可用 \`team_mgmt_list_models({ provider_pattern: \"${providerKey}\", model_pattern: \"*\" })\` 查看该 provider 下已有模型。`
            : `Model not found: \`${model}\` is not in provider \`${providerKey}\` models. Update \`.minds/llm.yaml\` or choose a configured model key. You can also run \`team_mgmt_list_models({ provider_pattern: \"${providerKey}\", model_pattern: \"*\" })\` to see configured models under that provider.`;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const results: ModelCheckResult[] = [];
      if (live && modelsToCheck.length > 0) {
        const llmGen = getLlmGenerator(providerCfg.apiType);
        if (!llmGen) {
          const msg =
            language === 'zh'
              ? `该 provider 的生成器不存在：apiType=\`${providerCfg.apiType}\`。`
              : `LLM generator not found for apiType=\`${providerCfg.apiType}\`.`;
          return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }

        const modelsLimited =
          allModels && modelsToCheck.length > maxModels
            ? modelsToCheck.slice(0, maxModels)
            : modelsToCheck;

        for (const modelKey of modelsLimited) {
          const agent = new Team.Member({
            id: 'team_mgmt_checker',
            name: 'TeamMgmtChecker',
            provider: providerKey,
            model: modelKey,
            model_params: {
              max_tokens: 16,
              openai: { temperature: 0 },
              anthropic: { temperature: 0 },
            },
          });

          let out = '';
          let sawFuncCall = false;
          const receiver: LlmStreamReceiver = {
            thinkingStart: async () => {},
            thinkingChunk: async (_chunk: string) => {},
            thinkingFinish: async () => {},
            sayingStart: async () => {},
            sayingChunk: async (chunk: string) => {
              out += chunk;
            },
            sayingFinish: async () => {},
            funcCall: async (_callId: string, _name: string, _args: string) => {
              sawFuncCall = true;
            },
          };

          const context: ChatMessage[] = [
            { type: 'environment_msg', role: 'user', content: 'ping' },
          ];
          const systemPrompt = 'Connectivity check: reply with a short confirmation (e.g. "ok").';

          try {
            await llmGen.genToReceiver(
              providerCfg,
              agent,
              systemPrompt,
              [],
              {
                dialogSelfId: 'team-mgmt-connectivity-check',
                dialogRootId: 'team-mgmt-connectivity-check',
              },
              context,
              receiver,
              0,
            );
            const details =
              out.trim().length > 0
                ? out.trim().slice(0, 120)
                : sawFuncCall
                  ? 'provider-native tool call emitted'
                  : undefined;
            results.push({ model: modelKey, status: 'pass', details });
          } catch (err: unknown) {
            const details = err instanceof Error ? err.message : String(err);
            results.push({ model: modelKey, status: 'fail', details: details.slice(0, 200) });
          }
        }

        if (allModels && modelsToCheck.length > modelsLimited.length) {
          results.push({
            model: `(skipped ${modelsToCheck.length - modelsLimited.length} models)`,
            status: 'pass',
            details: `use max_models to adjust`,
          });
        }
      }

      const headerTitle = language === 'zh' ? 'Provider 校验结果' : 'Provider Check';
      const lines: string[] = [];
      lines.push(fmtHeader(headerTitle));
      lines.push(
        fmtList([
          `provider: \`${providerKey}\` (apiType: \`${providerCfg.apiType}\`)`,
          envStatusLine,
          modelHeader,
          live
            ? 'live: true (performed a real generation call)'
            : 'live: false (config/env validation only)',
        ]),
      );

      if (!envConfigured && isCodexLike) {
        const caution =
          language === 'zh'
            ? '注意：codex provider 在某些环境下可能仍可工作，但为了稳定性，建议配置对应 env var（通常是 CODEX_HOME）。'
            : 'Note: codex may still work without the env var, but for stability you should configure it (usually CODEX_HOME).';
        lines.push(caution + '\n');
      }

      if (live && results.length > 0) {
        const title = language === 'zh' ? '模型连通性（live）' : 'Model Connectivity (live)';
        lines.push(fmtHeader(title));
        lines.push(results.map(formatModelCheckResult).join('\n') + '\n');
      } else if (!live) {
        const hint =
          language === 'zh'
            ? `提示：如需做真实连通性测试，设置 \`live: true\`。例如：\`team_mgmt_check_provider({ provider_key: \"${providerKey}\", model: \"<modelKey>\", all_models: false, live: true })\``
            : `Tip: to perform a real connectivity test, set \`live: true\`. Example: \`team_mgmt_check_provider({ provider_key: \"${providerKey}\", model: \"<modelKey>\", all_models: false, live: true })\``;
        lines.push(hint + '\n');
      }

      const content = lines.join('');
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtListProvidersTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_list_providers',
  description:
    'List built-in and rtws LLM providers, their env-var readiness, and configured models.',
  descriptionI18n: {
    en: 'List built-in and rtws LLM providers, their env-var readiness, and configured models.',
    zh: '列出内置与 rtws（运行时工作区）LLM providers，并显示 env var 是否已配置、以及该 provider 下有哪些模型。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider_pattern: { type: 'string' },
      include_builtin: { type: 'boolean' },
      include_rtws: { type: 'boolean' },
      show_models: { type: 'boolean' },
      max_models: { type: 'integer' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const providerPatternValue = args['provider_pattern'];
      const providerPattern =
        typeof providerPatternValue === 'string' && providerPatternValue.trim() !== ''
          ? providerPatternValue.trim()
          : '*';

      const includeBuiltinValue = args['include_builtin'];
      const includeBuiltin =
        includeBuiltinValue === undefined ? true : includeBuiltinValue === true;
      if (includeBuiltinValue !== undefined && typeof includeBuiltinValue !== 'boolean') {
        throw new Error('Invalid include_builtin (expected boolean)');
      }

      const includeRtwsValue = args['include_rtws'];
      const includeRtws = includeRtwsValue === undefined ? true : includeRtwsValue === true;
      if (includeRtwsValue !== undefined && typeof includeRtwsValue !== 'boolean') {
        throw new Error('Invalid include_rtws (expected boolean)');
      }

      const showModelsValue = args['show_models'];
      const showModels = showModelsValue === undefined ? true : showModelsValue === true;
      if (showModelsValue !== undefined && typeof showModelsValue !== 'boolean') {
        throw new Error('Invalid show_models (expected boolean)');
      }

      const maxModelsValue = args['max_models'];
      const requestedMaxModels =
        isInteger(maxModelsValue) && maxModelsValue > 0 ? maxModelsValue : 30;
      const maxModels = Math.min(
        requestedMaxModels,
        TEAM_MGMT_LIST_MODELS_HARD_MAX_MODELS_PER_PROVIDER,
      );
      if (maxModelsValue !== undefined && (!isInteger(maxModelsValue) || maxModelsValue <= 0)) {
        throw new Error('Invalid max_models (expected positive integer)');
      }

      const builtinProviders = includeBuiltin ? await loadBuiltinLlmProviders() : {};
      const rtwsProvidersResult = includeRtws
        ? await loadRtwsLlmProviders()
        : { kind: 'missing' as const };
      const rtwsProviders =
        rtwsProvidersResult.kind === 'present' ? rtwsProvidersResult.providers : {};

      const contentLines: string[] = [];
      const title = language === 'zh' ? 'LLM Provider 列表' : 'LLM Providers';
      contentLines.push(fmtHeader(title));
      contentLines.push(
        language === 'zh'
          ? '说明：rtws（运行时工作区）`.minds/llm.yaml` 的同名 provider key 会覆盖内置 defaults。\n'
          : 'Note: rtws (runtime workspace) `.minds/llm.yaml` overrides built-in defaults when provider keys match.\n',
      );

      if (includeRtws) {
        contentLines.push(
          fmtSubHeader(language === 'zh' ? 'rtws（.minds/llm.yaml）' : 'rtws (.minds/llm.yaml)'),
        );
        if (rtwsProvidersResult.kind === 'missing') {
          contentLines.push(
            language === 'zh'
              ? `（未发现 \`${MINDS_DIR}/llm.yaml\`；仅列出内置 defaults）\n`
              : `(\`${MINDS_DIR}/llm.yaml\` not found; showing built-in defaults only)\n`,
          );
        } else if (rtwsProvidersResult.kind === 'invalid') {
          contentLines.push(
            language === 'zh'
              ? `（解析失败：${rtwsProvidersResult.error}）\n`
              : `(Parse failed: ${rtwsProvidersResult.error})\n`,
          );
        } else {
          const keys = Object.keys(rtwsProviders).sort((a, b) => a.localeCompare(b));
          if (keys.length === 0) {
            contentLines.push(language === 'zh' ? '(空)\n' : '(empty)\n');
          } else {
            const items: string[] = [];
            let omittedCount = 0;
            for (const providerKey of keys) {
              if (!wildcardMatch(providerKey, providerPattern)) continue;
              if (items.length >= TEAM_MGMT_LIST_PROVIDERS_HARD_MAX_PROVIDERS) {
                omittedCount++;
                continue;
              }
              const providerCfg = rtwsProviders[providerKey];
              const envLine = formatProviderEnvStatusLine(providerCfg);
              const overridesBuiltin = Object.prototype.hasOwnProperty.call(
                builtinProviders,
                providerKey,
              );
              const models = getProviderModelsForListing(providerCfg);
              const modelCount = Object.keys(models).length;
              const modelsText = showModels ? listModelIds(models, maxModels) : '';
              const modelsSuffix = showModels
                ? `models(${modelCount}): ${modelsText}`
                : `models(${modelCount})`;
              items.push(
                `\`${providerKey}\` (apiType: \`${providerCfg.apiType}\`) — ${envLine} — ${modelsSuffix}${
                  overridesBuiltin
                    ? language === 'zh'
                      ? ' — 覆盖内置 defaults'
                      : ' — overrides built-in'
                    : ''
                }`,
              );
            }
            contentLines.push(fmtList(items));
            if (omittedCount > 0) {
              contentLines.push(
                language === 'zh'
                  ? `（其余 ${omittedCount} 个 provider 未展示；请改用 provider_pattern 缩小范围）\n`
                  : `(omitted ${omittedCount} additional provider(s); narrow with provider_pattern to inspect them)\n`,
              );
            }
          }
        }
      }

      if (includeBuiltin) {
        contentLines.push(
          fmtSubHeader(
            language === 'zh'
              ? '内置（dominds/main/llm/defaults.yaml）'
              : 'Built-in (dominds/main/llm/defaults.yaml)',
          ),
        );
        const keys = Object.keys(builtinProviders).sort((a, b) => a.localeCompare(b));
        if (keys.length === 0) {
          contentLines.push(language === 'zh' ? '(空)\n' : '(empty)\n');
        } else {
          const items: string[] = [];
          let omittedCount = 0;
          for (const providerKey of keys) {
            if (!wildcardMatch(providerKey, providerPattern)) continue;
            if (items.length >= TEAM_MGMT_LIST_PROVIDERS_HARD_MAX_PROVIDERS) {
              omittedCount++;
              continue;
            }
            const providerCfg = builtinProviders[providerKey];
            const envLine = formatProviderEnvStatusLine(providerCfg);
            const overriddenByRtws =
              rtwsProvidersResult.kind === 'present' &&
              Object.prototype.hasOwnProperty.call(rtwsProviders, providerKey);
            const models = getProviderModelsForListing(providerCfg);
            const modelCount = Object.keys(models).length;
            const modelsText = showModels ? listModelIds(models, maxModels) : '';
            const modelsSuffix = showModels
              ? `models(${modelCount}): ${modelsText}`
              : `models(${modelCount})`;
            items.push(
              `\`${providerKey}\` (apiType: \`${providerCfg.apiType}\`) — ${envLine} — ${modelsSuffix}${
                overriddenByRtws
                  ? language === 'zh'
                    ? ' — 被 rtws 覆盖'
                    : ' — overridden by rtws'
                  : ''
              }`,
            );
          }
          contentLines.push(fmtList(items));
          if (omittedCount > 0) {
            contentLines.push(
              language === 'zh'
                ? `（其余 ${omittedCount} 个 provider 未展示；请改用 provider_pattern 缩小范围）\n`
                : `(omitted ${omittedCount} additional provider(s); narrow with provider_pattern to inspect them)\n`,
            );
          }
        }
      }

      const content = contentLines.join('');
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

type ListModelsSource = 'effective' | 'builtin' | 'rtws';

export const teamMgmtListModelsTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_list_models',
  description:
    'List models filtered by provider/model wildcard, and show model info + provider model-parameter options.',
  descriptionI18n: {
    en: 'List models filtered by provider/model wildcard, and show model info + provider model-parameter options.',
    zh: '按 provider/model 通配符过滤列出模型，并展示模型信息与该 provider 的 model_param_options（模型参数说明）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', enum: ['effective', 'builtin', 'rtws'] },
      provider_pattern: { type: 'string' },
      model_pattern: { type: 'string' },
      include_param_options: { type: 'boolean' },
      max_models: { type: 'integer' },
      max_models_per_provider: { type: 'integer' },
      max_params: { type: 'integer' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const sourceValue = args['source'];
      const source: ListModelsSource =
        sourceValue === 'builtin' || sourceValue === 'rtws' || sourceValue === 'effective'
          ? sourceValue
          : 'effective';
      if (sourceValue !== undefined && typeof sourceValue !== 'string') {
        throw new Error('Invalid source (expected string)');
      }

      const providerPatternValue = args['provider_pattern'];
      const providerPattern =
        typeof providerPatternValue === 'string' && providerPatternValue.trim() !== ''
          ? providerPatternValue.trim()
          : '*';

      const modelPatternValue = args['model_pattern'];
      const modelPattern =
        typeof modelPatternValue === 'string' && modelPatternValue.trim() !== ''
          ? modelPatternValue.trim()
          : '*';

      const includeParamOptionsValue = args['include_param_options'];
      const includeParamOptions =
        includeParamOptionsValue === undefined ? true : includeParamOptionsValue === true;
      if (includeParamOptionsValue !== undefined && typeof includeParamOptionsValue !== 'boolean') {
        throw new Error('Invalid include_param_options (expected boolean)');
      }

      const maxModelsValue = args['max_models'];
      const requestedMaxModels =
        isInteger(maxModelsValue) && maxModelsValue > 0 ? maxModelsValue : 200;
      const maxModels = Math.min(requestedMaxModels, TEAM_MGMT_LIST_MODELS_HARD_MAX_MODELS);
      if (maxModelsValue !== undefined && (!isInteger(maxModelsValue) || maxModelsValue <= 0)) {
        throw new Error('Invalid max_models (expected positive integer)');
      }

      const maxModelsPerProviderValue = args['max_models_per_provider'];
      const requestedMaxModelsPerProvider =
        isInteger(maxModelsPerProviderValue) && maxModelsPerProviderValue > 0
          ? maxModelsPerProviderValue
          : 50;
      const maxModelsPerProvider = Math.min(
        requestedMaxModelsPerProvider,
        TEAM_MGMT_LIST_MODELS_HARD_MAX_MODELS_PER_PROVIDER,
      );
      if (
        maxModelsPerProviderValue !== undefined &&
        (!isInteger(maxModelsPerProviderValue) || maxModelsPerProviderValue <= 0)
      ) {
        throw new Error('Invalid max_models_per_provider (expected positive integer)');
      }

      const maxParamsValue = args['max_params'];
      const requestedMaxParams =
        isInteger(maxParamsValue) && maxParamsValue > 0 ? maxParamsValue : 80;
      const maxParams = Math.min(requestedMaxParams, TEAM_MGMT_LIST_MODELS_HARD_MAX_PARAMS);
      if (maxParamsValue !== undefined && (!isInteger(maxParamsValue) || maxParamsValue <= 0)) {
        throw new Error('Invalid max_params (expected positive integer)');
      }

      let providers: Record<string, ProviderConfig> = {};
      let sourceLabel = source;
      if (source === 'effective') {
        const cfg = await LlmConfig.load();
        providers = cfg.providers;
      } else if (source === 'builtin') {
        providers = await loadBuiltinLlmProviders();
      } else {
        const rtws = await loadRtwsLlmProviders();
        if (rtws.kind === 'missing') {
          const msg =
            language === 'zh'
              ? `未发现 \`${MINDS_DIR}/llm.yaml\`，无法列出 source=rtws 的 models。`
              : `\`${MINDS_DIR}/llm.yaml\` not found; cannot list models for source=rtws.`;
          return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
        if (rtws.kind === 'invalid') {
          const msg =
            language === 'zh'
              ? `解析 \`${MINDS_DIR}/llm.yaml\` 失败：${rtws.error}`
              : `Failed to parse \`${MINDS_DIR}/llm.yaml\`: ${rtws.error}`;
          return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
        providers = rtws.providers;
        sourceLabel = 'rtws';
      }

      const providerKeys = Object.keys(providers).sort((a, b) => a.localeCompare(b));
      const lines: string[] = [];
      lines.push(fmtHeader(language === 'zh' ? 'LLM 模型列表' : 'LLM Models'));
      lines.push(
        fmtList([
          `source: \`${sourceLabel}\``,
          `provider_pattern: \`${providerPattern}\``,
          `model_pattern: \`${modelPattern}\``,
          `effective_max_models: ${maxModels}`,
          `effective_max_models_per_provider: ${maxModelsPerProvider}`,
          `effective_max_params: ${maxParams}`,
        ]),
      );

      let totalListed = 0;
      let providerMatched = 0;
      for (const providerKey of providerKeys) {
        if (!wildcardMatch(providerKey, providerPattern)) continue;
        const providerCfg = providers[providerKey];
        providerMatched++;

        const envLine = formatProviderEnvStatusLine(providerCfg);
        const models = getProviderModelsForListing(providerCfg);
        const modelIds = Object.keys(models).sort((a, b) => a.localeCompare(b));
        const matchedModelIds = modelIds.filter((m) => wildcardMatch(m, modelPattern));

        lines.push(fmtSubHeader(`provider: ${providerKey}`));
        lines.push(
          fmtList([
            `apiType: \`${providerCfg.apiType}\``,
            envLine,
            `models_total: ${modelIds.length}`,
            `models_matched: ${matchedModelIds.length}`,
          ]),
        );

        if (matchedModelIds.length === 0) {
          lines.push(language === 'zh' ? '(无匹配模型)\n' : '(no matching models)\n');
          continue;
        }

        const perProviderLimit =
          maxModelsPerProvider > 0 ? maxModelsPerProvider : matchedModelIds.length;
        const remainingGlobal =
          maxModels > 0 ? Math.max(0, maxModels - totalListed) : matchedModelIds.length;
        const limit = Math.min(perProviderLimit, remainingGlobal, matchedModelIds.length);
        const toShow = matchedModelIds.slice(0, limit);

        const modelLines: string[] = [];
        for (const modelKey of toShow) {
          const infoUnknown = models[modelKey];
          const summary = formatModelInfoSummary(infoUnknown);
          modelLines.push(summary ? `\`${modelKey}\` — ${summary}` : `\`${modelKey}\``);
        }
        lines.push(fmtList(modelLines));
        totalListed += toShow.length;

        if (limit < matchedModelIds.length) {
          const skipped = matchedModelIds.length - limit;
          lines.push(
            language === 'zh'
              ? `（该 provider 省略 ${skipped} 个模型；可调大 max_models_per_provider / max_models）\n`
              : `(skipped ${skipped} models for this provider; raise max_models_per_provider / max_models)\n`,
          );
        }

        if (maxModels > 0 && totalListed >= maxModels) {
          lines.push(
            language === 'zh'
              ? `（达到 max_models=${maxModels} 上限，已停止列出更多模型）\n`
              : `(hit max_models=${maxModels} limit; stopped listing more models)\n`,
          );
          break;
        }

        if (includeParamOptions) {
          const mpo = providerCfg.model_param_options;
          const general = mpo ? mpo.general : undefined;
          let specific: Record<string, ModelParamOption> | undefined;
          if (mpo) {
            if (providerCfg.apiType === 'codex') specific = mpo.codex;
            else if (
              providerCfg.apiType === 'openai' ||
              providerCfg.apiType === 'openai-compatible'
            )
              specific = mpo.openai;
            else if (providerCfg.apiType === 'anthropic') specific = mpo.anthropic;
            else specific = undefined;
          }

          lines.push(
            fmtSubHeader(
              language === 'zh' ? 'model_param_options（模型参数说明）' : 'model_param_options',
            ),
          );
          if (!general && !specific) {
            lines.push(language === 'zh' ? '(未配置)\n' : '(not configured)\n');
          } else {
            if (general) {
              const keys = Object.keys(general).sort((a, b) => a.localeCompare(b));
              const limited = maxParams > 0 ? keys.slice(0, maxParams) : keys;
              const items = limited.map((k) => formatModelParamOptionLine(k, general[k], language));
              lines.push(fmtSubHeader(language === 'zh' ? 'general（通用）' : 'general'));
              lines.push(items.join('\n') + '\n');
              if (limited.length < keys.length) {
                lines.push(
                  language === 'zh'
                    ? `（general 省略 ${keys.length - limited.length} 个参数；可调大 max_params）\n`
                    : `(general skipped ${keys.length - limited.length} params; raise max_params)\n`,
                );
              }
            }

            if (specific) {
              const keys = Object.keys(specific).sort((a, b) => a.localeCompare(b));
              const limited = maxParams > 0 ? keys.slice(0, maxParams) : keys;
              const items = limited.map((k) =>
                formatModelParamOptionLine(k, specific[k], language),
              );
              lines.push(
                fmtSubHeader(
                  language === 'zh'
                    ? `${providerCfg.apiType}（provider 专有）`
                    : `${providerCfg.apiType}`,
                ),
              );
              lines.push(items.join('\n') + '\n');
              if (limited.length < keys.length) {
                lines.push(
                  language === 'zh'
                    ? `（${providerCfg.apiType} 省略 ${keys.length - limited.length} 个参数；可调大 max_params）\n`
                    : `(${providerCfg.apiType} skipped ${keys.length - limited.length} params; raise max_params)\n`,
                );
              }
            }
          }
        }
      }

      if (providerMatched === 0) {
        lines.push(language === 'zh' ? '（没有匹配的 provider）\n' : '(no matching providers)\n');
      }

      const summaryTitle = language === 'zh' ? 'Summary' : 'Summary';
      lines.push(
        fmtSubHeader(summaryTitle) +
          fmtList([`providers_matched: ${providerMatched}`, `models_listed: ${totalListed}`]),
      );

      const content = lines.join('');
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtListDirTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_list_dir',
  description: `List directory contents under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `List directory contents under ${MINDS_DIR}/.`,
    zh: `列出 ${MINDS_DIR}/ 下的目录内容。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const rel = toMindsRelativePath(typeof pathValue === 'string' ? pathValue : '.');
      ensureMindsScopedPath(rel);

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await listDirTool.call(dlg, proxyCaller, { path: rel });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtReadFileTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_read_file',
  description: `Read a text file under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Read a text file under ${MINDS_DIR}/.`,
    zh: `读取 ${MINDS_DIR}/ 下的文本文件。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string' },
      range: { type: 'string' },
      max_lines: { type: 'integer' },
      show_linenos: { type: 'boolean' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) throw new Error('Path required');
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const rangeValue = args['range'];
      const range =
        rangeValue === undefined
          ? undefined
          : typeof rangeValue === 'string'
            ? rangeValue
            : undefined;
      if (rangeValue !== undefined && typeof rangeValue !== 'string') {
        throw new Error('Invalid range (expected string)');
      }

      const maxLinesValue = args['max_lines'];
      const maxLines =
        typeof maxLinesValue === 'number' && Number.isInteger(maxLinesValue)
          ? maxLinesValue
          : undefined;
      if (
        maxLinesValue !== undefined &&
        (typeof maxLinesValue !== 'number' || !Number.isInteger(maxLinesValue))
      ) {
        throw new Error('Invalid max_lines (expected integer)');
      }

      const showLinenosValue = args['show_linenos'];
      const showLinenos =
        showLinenosValue === undefined
          ? undefined
          : typeof showLinenosValue === 'boolean'
            ? showLinenosValue
            : undefined;
      if (showLinenosValue !== undefined && typeof showLinenosValue !== 'boolean') {
        throw new Error('Invalid show_linenos (expected boolean)');
      }

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await readFileTool.call(dlg, proxyCaller, {
        path: rel,
        ...(range ? { range } : {}),
        ...(maxLines !== undefined ? { max_lines: maxLines } : {}),
        ...(showLinenos !== undefined ? { show_linenos: showLinenos } : {}),
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtCreateNewFileTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_create_new_file',
  description: `Create a new file under ${MINDS_DIR}/ (no prepare/apply). Refuses to overwrite existing files.`,
  descriptionI18n: {
    en: `Create a new file under ${MINDS_DIR}/ (no prepare/apply). Refuses to overwrite existing files.`,
    zh: `在 ${MINDS_DIR}/ 下创建一个新文件（不走 prepare/apply）。若文件已存在则拒绝覆写。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    const t =
      language === 'zh'
        ? {
            invalidArgs: (msg: string) => `参数不正确：${msg}`,
            fileExists: '文件已存在，拒绝创建。',
            notAFile: '路径已存在但不是文件（可能是目录），拒绝创建。',
            nextOverwrite:
              '下一步：先用 team_mgmt_read_file 获取 total_lines/size_bytes，然后再调用 team_mgmt_overwrite_entire_file 覆盖写入。',
            ok: '已创建新文件。',
          }
        : {
            invalidArgs: (msg: string) => `Invalid args: ${msg}`,
            fileExists: 'File already exists; refusing to create.',
            notAFile: 'Path exists but is not a file (e.g. a directory); refusing to create.',
            nextOverwrite:
              'Next: call team_mgmt_read_file to get total_lines/size_bytes, then use team_mgmt_overwrite_entire_file to overwrite.',
            ok: 'Created new file.',
          };

    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: create_new_file`,
            `error: INVALID_ARGS`,
            `summary: ${yamlQuote(t.invalidArgs('Path required'))}`,
          ].join('\n'),
        );
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const rel = toMindsRelativePath(rawPath);
      const { abs } = ensureMindsScopedPath(rel);
      if (rel === MINDS_DIR) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: create_new_file`,
            `path: ${yamlQuote(rel)}`,
            `error: NOT_A_FILE`,
            `summary: ${yamlQuote(t.notAFile)}`,
          ].join('\n'),
        );
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const contentValue = args['content'];
      if (contentValue !== undefined && typeof contentValue !== 'string') {
        throw new Error('Invalid content (expected string)');
      }
      const initialContent = typeof contentValue === 'string' ? contentValue : '';

      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) {
          const out = formatYamlCodeBlock(
            [
              `status: error`,
              `mode: create_new_file`,
              `path: ${yamlQuote(rel)}`,
              `error: NOT_A_FILE`,
              `summary: ${yamlQuote(t.notAFile)}`,
            ].join('\n'),
          );
          return fail(out, [{ type: 'environment_msg', role: 'user', content: out }]);
        }

        const out = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: create_new_file`,
            `path: ${yamlQuote(rel)}`,
            `error: FILE_EXISTS`,
            `summary: ${yamlQuote(t.fileExists)}`,
            `next: ${yamlQuote(t.nextOverwrite)}`,
          ].join('\n'),
        );
        return fail(out, [{ type: 'environment_msg', role: 'user', content: out }]);
      } catch (err: unknown) {
        if (!isFsErrWithCode(err) || err.code !== 'ENOENT') throw err;
      }

      const { normalizedBody, addedTrailingNewlineToContent } =
        normalizeFileWriteBody(initialContent);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, normalizedBody, 'utf8');

      const newTotalBytes = Buffer.byteLength(normalizedBody, 'utf8');
      const newTotalLines = countLogicalLines(normalizedBody);
      const normalizedNewlineAdded = addedTrailingNewlineToContent && normalizedBody !== '';
      const summary =
        language === 'zh'
          ? `${t.ok} path=${rel}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`
          : `${t.ok} path=${rel}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`;
      const out = formatYamlCodeBlock(
        [
          `status: ok`,
          `mode: create_new_file`,
          `path: ${yamlQuote(rel)}`,
          `new_total_lines: ${newTotalLines}`,
          `new_total_bytes: ${newTotalBytes}`,
          `normalized_trailing_newline_added: ${normalizedNewlineAdded}`,
          `summary: ${yamlQuote(summary)}`,
        ].join('\n'),
      );
      await refreshDerivedStateAfterTeamMgmtWrite({
        relPaths: [rel],
        trigger: 'create_new_file',
      });
      return ok(out, [{ type: 'environment_msg', role: 'user', content: out }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      const out = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: create_new_file`,
          `error: FAILED`,
          `summary: ${yamlQuote(msg)}`,
        ].join('\n'),
      );
      return fail(out, [{ type: 'environment_msg', role: 'user', content: out }]);
    }
  },
};

export const teamMgmtOverwriteEntireFileTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_overwrite_entire_file',
  description: `Overwrite an existing file under ${MINDS_DIR}/ (writes immediately; guarded).`,
  descriptionI18n: {
    en: `Overwrite an existing file under ${MINDS_DIR}/ (writes immediately; guarded).`,
    zh: `整体覆盖写入 ${MINDS_DIR}/ 下的已存在文件（直接写盘，带护栏）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'known_old_total_lines', 'known_old_total_bytes', 'content'],
    properties: {
      path: { type: 'string' },
      known_old_total_lines: { type: 'integer' },
      known_old_total_bytes: { type: 'integer' },
      content_format: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) throw new Error('Path required');

      const knownLinesValue = args['known_old_total_lines'];
      if (typeof knownLinesValue !== 'number' || !Number.isInteger(knownLinesValue)) {
        throw new Error(
          language === 'zh'
            ? 'known_old_total_lines 需要为整数。'
            : 'known_old_total_lines must be an integer.',
        );
      }
      const knownBytesValue = args['known_old_total_bytes'];
      if (typeof knownBytesValue !== 'number' || !Number.isInteger(knownBytesValue)) {
        throw new Error(
          language === 'zh'
            ? 'known_old_total_bytes 需要为整数。'
            : 'known_old_total_bytes must be an integer.',
        );
      }
      const contentValue = args['content'];
      if (typeof contentValue !== 'string') {
        throw new Error(language === 'zh' ? 'content 需要为字符串。' : 'content must be a string.');
      }
      const contentFormatValue = args['content_format'];
      const contentFormat =
        contentFormatValue === undefined
          ? undefined
          : typeof contentFormatValue === 'string'
            ? contentFormatValue
            : undefined;
      if (contentFormatValue !== undefined && typeof contentFormatValue !== 'string') {
        throw new Error(
          language === 'zh' ? 'content_format 需要为字符串。' : 'content_format must be a string.',
        );
      }

      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await overwriteEntireFileTool.call(dlg, proxyCaller, {
        path: rel,
        known_old_total_lines: knownLinesValue,
        known_old_total_bytes: knownBytesValue,
        content: contentValue,
        ...(contentFormat ? { content_format: contentFormat } : {}),
      });
      const result = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(result, 'overwrite_entire_file')) {
        await refreshDerivedStateAfterTeamMgmtWrite({
          relPaths: [rel],
          trigger: 'overwrite_entire_file',
        });
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPrepareFileAppendTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_prepare_file_append',
  description: `Prepare an append-to-EOF modification under ${MINDS_DIR}/ (does not write yet).`,
  descriptionI18n: {
    en: `Prepare an append-to-EOF modification under ${MINDS_DIR}/ (does not write yet).`,
    zh: `规划 ${MINDS_DIR}/ 下“末尾追加”修改（不会立刻写入）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string' },
      create: { type: 'boolean' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) throw new Error('Path required');

      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);

      const createValue = args['create'];
      const create = createValue === undefined ? undefined : createValue === true ? true : false;
      if (createValue !== undefined && typeof createValue !== 'boolean') {
        throw new Error('Invalid create (expected boolean)');
      }
      const existingHunkIdValue = args['existing_hunk_id'];
      const existingHunkId =
        existingHunkIdValue === undefined
          ? undefined
          : typeof existingHunkIdValue === 'string'
            ? existingHunkIdValue
            : undefined;
      if (existingHunkIdValue !== undefined && typeof existingHunkIdValue !== 'string') {
        throw new Error('Invalid existing_hunk_id (expected string)');
      }
      const contentValue = args['content'];
      if (typeof contentValue !== 'string') throw new Error('Invalid content (expected string)');

      const output = await prepareFileAppendTool.call(dlg, proxyCaller, {
        path: rel,
        ...(create !== undefined ? { create } : {}),
        ...(existingHunkId ? { existing_hunk_id: existingHunkId } : {}),
        content: contentValue,
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPrepareInsertAfterTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_prepare_file_insert_after',
  description: `Prepare an insertion after an anchor under ${MINDS_DIR}/ (does not write yet).`,
  descriptionI18n: {
    en: `Prepare an insertion after an anchor under ${MINDS_DIR}/ (does not write yet).`,
    zh: `按锚点规划 ${MINDS_DIR}/ 下“在其后插入”修改（不会立刻写入）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'anchor', 'content'],
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const anchorValue = args['anchor'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      const anchor = typeof anchorValue === 'string' ? anchorValue : '';
      if (!rawPath) throw new Error('Path required');
      if (!anchor) throw new Error('Anchor is required');

      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);

      const occurrenceValue = args['occurrence'];
      if (
        occurrenceValue !== undefined &&
        typeof occurrenceValue !== 'number' &&
        typeof occurrenceValue !== 'string'
      ) {
        throw new Error("Invalid occurrence (expected integer or 'last')");
      }

      const matchValue = args['match'];
      if (matchValue !== undefined && typeof matchValue !== 'string') {
        throw new Error("Invalid match (expected 'contains'|'equals')");
      }

      const existingHunkIdValue = args['existing_hunk_id'];
      if (existingHunkIdValue !== undefined && typeof existingHunkIdValue !== 'string') {
        throw new Error('Invalid existing_hunk_id (expected string)');
      }

      const contentValue = args['content'];
      if (typeof contentValue !== 'string') throw new Error('Invalid content (expected string)');

      const output = await prepareFileInsertAfterTool.call(dlg, proxyCaller, {
        path: rel,
        anchor,
        ...(occurrenceValue !== undefined ? { occurrence: occurrenceValue } : {}),
        ...(matchValue !== undefined ? { match: matchValue } : {}),
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        content: contentValue,
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPrepareInsertBeforeTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_prepare_file_insert_before',
  description: `Prepare an insertion before an anchor under ${MINDS_DIR}/ (does not write yet).`,
  descriptionI18n: {
    en: `Prepare an insertion before an anchor under ${MINDS_DIR}/ (does not write yet).`,
    zh: `按锚点规划 ${MINDS_DIR}/ 下“在其前插入”修改（不会立刻写入）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'anchor', 'content'],
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const anchorValue = args['anchor'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      const anchor = typeof anchorValue === 'string' ? anchorValue : '';
      if (!rawPath) throw new Error('Path required');
      if (!anchor) throw new Error('Anchor is required');

      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);

      const occurrenceValue = args['occurrence'];
      if (
        occurrenceValue !== undefined &&
        typeof occurrenceValue !== 'number' &&
        typeof occurrenceValue !== 'string'
      ) {
        throw new Error("Invalid occurrence (expected integer or 'last')");
      }

      const matchValue = args['match'];
      if (matchValue !== undefined && typeof matchValue !== 'string') {
        throw new Error("Invalid match (expected 'contains'|'equals')");
      }

      const existingHunkIdValue = args['existing_hunk_id'];
      if (existingHunkIdValue !== undefined && typeof existingHunkIdValue !== 'string') {
        throw new Error('Invalid existing_hunk_id (expected string)');
      }

      const contentValue = args['content'];
      if (typeof contentValue !== 'string') throw new Error('Invalid content (expected string)');

      const output = await prepareFileInsertBeforeTool.call(dlg, proxyCaller, {
        path: rel,
        anchor,
        ...(occurrenceValue !== undefined ? { occurrence: occurrenceValue } : {}),
        ...(matchValue !== undefined ? { match: matchValue } : {}),
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        content: contentValue,
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPrepareBlockReplaceTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_prepare_file_block_replace',
  description: `Prepare a block replacement between anchors in a file under ${MINDS_DIR}/ (does not write yet).`,
  descriptionI18n: {
    en: `Prepare a block replacement between anchors in a file under ${MINDS_DIR}/ (does not write yet).`,
    zh: `按锚点规划 ${MINDS_DIR}/ 下文件的块替换（不会立刻写入）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'start_anchor', 'end_anchor', 'content'],
    properties: {
      path: { type: 'string' },
      start_anchor: { type: 'string' },
      end_anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      include_anchors: { type: 'boolean' },
      match: { type: 'string' },
      require_unique: { type: 'boolean' },
      strict: { type: 'boolean' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const startAnchorValue = args['start_anchor'];
      const endAnchorValue = args['end_anchor'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      const startAnchor = typeof startAnchorValue === 'string' ? startAnchorValue : '';
      const endAnchor = typeof endAnchorValue === 'string' ? endAnchorValue : '';
      if (!rawPath) throw new Error('Path required');
      if (!startAnchor || !endAnchor) throw new Error('start_anchor and end_anchor are required');

      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);

      const occurrenceValue = args['occurrence'];
      if (
        occurrenceValue !== undefined &&
        typeof occurrenceValue !== 'number' &&
        typeof occurrenceValue !== 'string'
      ) {
        throw new Error("Invalid occurrence (expected integer or 'last')");
      }
      const includeAnchorsValue = args['include_anchors'];
      if (includeAnchorsValue !== undefined && typeof includeAnchorsValue !== 'boolean') {
        throw new Error('Invalid include_anchors (expected boolean)');
      }
      const matchValue = args['match'];
      if (matchValue !== undefined && typeof matchValue !== 'string') {
        throw new Error("Invalid match (expected 'contains'|'equals')");
      }
      const requireUniqueValue = args['require_unique'];
      if (requireUniqueValue !== undefined && typeof requireUniqueValue !== 'boolean') {
        throw new Error('Invalid require_unique (expected boolean)');
      }
      const strictValue = args['strict'];
      if (strictValue !== undefined && typeof strictValue !== 'boolean') {
        throw new Error('Invalid strict (expected boolean)');
      }
      const existingHunkIdValue = args['existing_hunk_id'];
      if (existingHunkIdValue !== undefined && typeof existingHunkIdValue !== 'string') {
        throw new Error('Invalid existing_hunk_id (expected string)');
      }
      const contentValue = args['content'];
      if (typeof contentValue !== 'string') throw new Error('Invalid content (expected string)');

      const output = await prepareFileBlockReplaceTool.call(dlg, proxyCaller, {
        path: rel,
        start_anchor: startAnchor,
        end_anchor: endAnchor,
        ...(occurrenceValue !== undefined ? { occurrence: occurrenceValue } : {}),
        ...(includeAnchorsValue !== undefined ? { include_anchors: includeAnchorsValue } : {}),
        ...(matchValue !== undefined ? { match: matchValue } : {}),
        ...(requireUniqueValue !== undefined ? { require_unique: requireUniqueValue } : {}),
        ...(strictValue !== undefined ? { strict: strictValue } : {}),
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        content: contentValue,
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPrepareFileRangeEditTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_prepare_file_range_edit',
  description: `Prepare a single-file modification under ${MINDS_DIR}/ (does not write yet).`,
  descriptionI18n: {
    en: `Prepare a single-file modification under ${MINDS_DIR}/ (does not write yet).`,
    zh: `按行号范围规划 ${MINDS_DIR}/ 下的单文件修改（不会立刻写入）。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'range'],
    properties: {
      path: { type: 'string' },
      range: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const pathValue = args['path'];
      const rangeValue = args['range'];
      const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
      const rangeSpec = typeof rangeValue === 'string' ? rangeValue.trim() : '';
      if (!filePath) throw new Error('Path required');
      if (!rangeSpec) throw new Error('Range required (e.g. 10~20 or ~)');

      const existingHunkIdValue = args['existing_hunk_id'];
      if (existingHunkIdValue !== undefined && typeof existingHunkIdValue !== 'string') {
        throw new Error('Invalid existing_hunk_id (expected string)');
      }

      const contentValue = args['content'];
      if (contentValue !== undefined && typeof contentValue !== 'string') {
        throw new Error('Invalid content (expected string)');
      }

      const rel = toMindsRelativePath(filePath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await prepareFileRangeEditTool.call(dlg, proxyCaller, {
        path: rel,
        range: rangeSpec,
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        ...(typeof contentValue === 'string' ? { content: contentValue } : {}),
      });
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtApplyFileModificationTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_apply_file_modification',
  description: `Apply a previously planned file modification under ${MINDS_DIR}/ by hunk id.`,
  descriptionI18n: {
    en: `Apply a previously planned file modification under ${MINDS_DIR}/ by hunk id.`,
    zh: `按 hunk id 应用之前规划的 ${MINDS_DIR}/ 下的单文件修改。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['hunk_id'],
    properties: { hunk_id: { type: 'string' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const hunkIdValue = args['hunk_id'];
      const id = typeof hunkIdValue === 'string' ? hunkIdValue.trim() : '';
      if (!id) throw new Error('Hunk id required (e.g. a1b2c3d4)');
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await applyFileModificationTool.call(dlg, proxyCaller, { hunk_id: id });
      const content = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(content, 'apply_file_modification')) {
        const relPath = extractPathFromYamlToolOutput(content);
        if (relPath) {
          await refreshDerivedStateAfterTeamMgmtWrite({
            relPaths: [relPath],
            trigger: 'team_mgmt_apply_file_modification',
          });
        }
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtMkDirTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_mk_dir',
  description: `Create a directory under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Create a directory under ${MINDS_DIR}/.`,
    zh: `创建 ${MINDS_DIR}/ 下目录。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' }, parents: { type: 'boolean' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }
      await ensureMindsRootDirExists();

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) throw new Error('Path required');
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const parentsValue = args['parents'];
      const parents = parentsValue === undefined ? undefined : parentsValue === true ? true : false;
      if (parentsValue !== undefined && typeof parentsValue !== 'boolean') {
        throw new Error('Invalid parents (expected boolean)');
      }
      const toolArgs: ToolArguments =
        parents === undefined ? { path: rel } : { path: rel, parents };
      const output = await mkDirTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtMoveFileTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_move_file',
  description: `Move/rename a file under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Move/rename a file under ${MINDS_DIR}/.`,
    zh: `移动/重命名 ${MINDS_DIR}/ 下文件。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: { from: { type: 'string' }, to: { type: 'string' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const fromValue = args['from'];
      const toValue = args['to'];
      const rawFrom = typeof fromValue === 'string' ? fromValue.trim() : '';
      const rawTo = typeof toValue === 'string' ? toValue.trim() : '';
      if (!rawFrom || !rawTo) throw new Error('From/to required');
      const fromRel = toMindsRelativePath(rawFrom);
      const toRel = toMindsRelativePath(rawTo);
      ensureMindsScopedPath(fromRel);
      ensureMindsScopedPath(toRel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await moveFileTool.call(dlg, proxyCaller, { from: fromRel, to: toRel });
      const content = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(content, 'move_file')) {
        await refreshDerivedStateAfterTeamMgmtWrite({
          relPaths: [fromRel, toRel],
          trigger: 'move_file',
        });
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtMoveDirTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_move_dir',
  description: `Move/rename a directory under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Move/rename a directory under ${MINDS_DIR}/.`,
    zh: `移动/重命名 ${MINDS_DIR}/ 下目录。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: { from: { type: 'string' }, to: { type: 'string' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const fromValue = args['from'];
      const toValue = args['to'];
      const rawFrom = typeof fromValue === 'string' ? fromValue.trim() : '';
      const rawTo = typeof toValue === 'string' ? toValue.trim() : '';
      if (!rawFrom || !rawTo) throw new Error('From/to required');
      const fromRel = toMindsRelativePath(rawFrom);
      const toRel = toMindsRelativePath(rawTo);
      ensureMindsScopedPath(fromRel);
      ensureMindsScopedPath(toRel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await moveDirTool.call(dlg, proxyCaller, { from: fromRel, to: toRel });
      const content = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(content, 'move_dir')) {
        await refreshDerivedStateAfterTeamMgmtWrite({
          relPaths: [fromRel, toRel],
          trigger: 'move_dir',
        });
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRipgrepFilesTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_ripgrep_files',
  description: `Search within ${MINDS_DIR}/ using ripgrep_files.`,
  descriptionI18n: {
    en: `Search within ${MINDS_DIR}/ using ripgrep_files.`,
    zh: `在 ${MINDS_DIR}/ 下用 ripgrep_files 搜索。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      max_files: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const patternValue = args['pattern'];
      const pattern = typeof patternValue === 'string' ? patternValue.trim() : '';
      if (!pattern) throw new Error('Pattern required');

      const pathValue = args['path'];
      const rawPath =
        typeof pathValue === 'string' && pathValue.trim() !== '' ? pathValue.trim() : MINDS_DIR;
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const toolArgs: ToolArguments = { pattern, path: rel };
      const globsValue = args['globs'];
      if (globsValue !== undefined) {
        if (!Array.isArray(globsValue) || !globsValue.every((v) => typeof v === 'string')) {
          throw new Error('Invalid globs (expected string[])');
        }
        toolArgs['globs'] = globsValue;
      }
      const caseValue = args['case'];
      if (caseValue !== undefined) {
        if (typeof caseValue !== 'string') throw new Error('Invalid case (expected string)');
        toolArgs['case'] = caseValue;
      }
      const fixedStringsValue = args['fixed_strings'];
      if (fixedStringsValue !== undefined) {
        if (typeof fixedStringsValue !== 'boolean')
          throw new Error('Invalid fixed_strings (expected boolean)');
        toolArgs['fixed_strings'] = fixedStringsValue;
      }
      const includeHiddenValue = args['include_hidden'];
      if (includeHiddenValue !== undefined) {
        if (typeof includeHiddenValue !== 'boolean')
          throw new Error('Invalid include_hidden (expected boolean)');
        toolArgs['include_hidden'] = includeHiddenValue;
      }
      const followSymlinksValue = args['follow_symlinks'];
      if (followSymlinksValue !== undefined) {
        if (typeof followSymlinksValue !== 'boolean')
          throw new Error('Invalid follow_symlinks (expected boolean)');
        toolArgs['follow_symlinks'] = followSymlinksValue;
      }
      const maxFilesValue = args['max_files'];
      if (maxFilesValue !== undefined) {
        if (typeof maxFilesValue !== 'number' || !Number.isInteger(maxFilesValue))
          throw new Error('Invalid max_files (expected integer)');
        toolArgs['max_files'] = maxFilesValue;
      }

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await ripgrepFilesTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRipgrepSnippetsTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_ripgrep_snippets',
  description: `Search within ${MINDS_DIR}/ using ripgrep_snippets.`,
  descriptionI18n: {
    en: `Search within ${MINDS_DIR}/ using ripgrep_snippets.`,
    zh: `在 ${MINDS_DIR}/ 下用 ripgrep_snippets 搜索。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      context_before: { type: 'integer' },
      context_after: { type: 'integer' },
      max_results: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const patternValue = args['pattern'];
      const pattern = typeof patternValue === 'string' ? patternValue.trim() : '';
      if (!pattern) throw new Error('Pattern required');

      const pathValue = args['path'];
      const rawPath =
        typeof pathValue === 'string' && pathValue.trim() !== '' ? pathValue.trim() : MINDS_DIR;
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const toolArgs: ToolArguments = { pattern, path: rel };
      const globsValue = args['globs'];
      if (globsValue !== undefined) {
        if (!Array.isArray(globsValue) || !globsValue.every((v) => typeof v === 'string')) {
          throw new Error('Invalid globs (expected string[])');
        }
        toolArgs['globs'] = globsValue;
      }
      const caseValue = args['case'];
      if (caseValue !== undefined) {
        if (typeof caseValue !== 'string') throw new Error('Invalid case (expected string)');
        toolArgs['case'] = caseValue;
      }
      const fixedStringsValue = args['fixed_strings'];
      if (fixedStringsValue !== undefined) {
        if (typeof fixedStringsValue !== 'boolean')
          throw new Error('Invalid fixed_strings (expected boolean)');
        toolArgs['fixed_strings'] = fixedStringsValue;
      }
      const contextBeforeValue = args['context_before'];
      if (contextBeforeValue !== undefined) {
        if (typeof contextBeforeValue !== 'number' || !Number.isInteger(contextBeforeValue)) {
          throw new Error('Invalid context_before (expected integer)');
        }
        toolArgs['context_before'] = contextBeforeValue;
      }
      const contextAfterValue = args['context_after'];
      if (contextAfterValue !== undefined) {
        if (typeof contextAfterValue !== 'number' || !Number.isInteger(contextAfterValue)) {
          throw new Error('Invalid context_after (expected integer)');
        }
        toolArgs['context_after'] = contextAfterValue;
      }
      const maxResultsValue = args['max_results'];
      if (maxResultsValue !== undefined) {
        if (typeof maxResultsValue !== 'number' || !Number.isInteger(maxResultsValue)) {
          throw new Error('Invalid max_results (expected integer)');
        }
        toolArgs['max_results'] = maxResultsValue;
      }
      const includeHiddenValue = args['include_hidden'];
      if (includeHiddenValue !== undefined) {
        if (typeof includeHiddenValue !== 'boolean')
          throw new Error('Invalid include_hidden (expected boolean)');
        toolArgs['include_hidden'] = includeHiddenValue;
      }
      const followSymlinksValue = args['follow_symlinks'];
      if (followSymlinksValue !== undefined) {
        if (typeof followSymlinksValue !== 'boolean')
          throw new Error('Invalid follow_symlinks (expected boolean)');
        toolArgs['follow_symlinks'] = followSymlinksValue;
      }

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await ripgrepSnippetsTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRipgrepCountTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_ripgrep_count',
  description: `Count matches within ${MINDS_DIR}/ using ripgrep_count.`,
  descriptionI18n: {
    en: `Count matches within ${MINDS_DIR}/ using ripgrep_count.`,
    zh: `在 ${MINDS_DIR}/ 下用 ripgrep_count 计数。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      max_files: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const patternValue = args['pattern'];
      const pattern = typeof patternValue === 'string' ? patternValue.trim() : '';
      if (!pattern) throw new Error('Pattern required');

      const pathValue = args['path'];
      const rawPath =
        typeof pathValue === 'string' && pathValue.trim() !== '' ? pathValue.trim() : MINDS_DIR;
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const toolArgs: ToolArguments = { pattern, path: rel };
      const globsValue = args['globs'];
      if (globsValue !== undefined) {
        if (!Array.isArray(globsValue) || !globsValue.every((v) => typeof v === 'string')) {
          throw new Error('Invalid globs (expected string[])');
        }
        toolArgs['globs'] = globsValue;
      }
      const caseValue = args['case'];
      if (caseValue !== undefined) {
        if (typeof caseValue !== 'string') throw new Error('Invalid case (expected string)');
        toolArgs['case'] = caseValue;
      }
      const fixedStringsValue = args['fixed_strings'];
      if (fixedStringsValue !== undefined) {
        if (typeof fixedStringsValue !== 'boolean')
          throw new Error('Invalid fixed_strings (expected boolean)');
        toolArgs['fixed_strings'] = fixedStringsValue;
      }
      const includeHiddenValue = args['include_hidden'];
      if (includeHiddenValue !== undefined) {
        if (typeof includeHiddenValue !== 'boolean')
          throw new Error('Invalid include_hidden (expected boolean)');
        toolArgs['include_hidden'] = includeHiddenValue;
      }
      const followSymlinksValue = args['follow_symlinks'];
      if (followSymlinksValue !== undefined) {
        if (typeof followSymlinksValue !== 'boolean')
          throw new Error('Invalid follow_symlinks (expected boolean)');
        toolArgs['follow_symlinks'] = followSymlinksValue;
      }
      const maxFilesValue = args['max_files'];
      if (maxFilesValue !== undefined) {
        if (typeof maxFilesValue !== 'number' || !Number.isInteger(maxFilesValue))
          throw new Error('Invalid max_files (expected integer)');
        toolArgs['max_files'] = maxFilesValue;
      }

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await ripgrepCountTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRipgrepFixedTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_ripgrep_fixed',
  description: `Fixed-string ripgrep within ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Fixed-string ripgrep within ${MINDS_DIR}/.`,
    zh: `在 ${MINDS_DIR}/ 下固定字符串搜索。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['literal'],
    properties: {
      literal: { type: 'string' },
      path: { type: 'string' },
      mode: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      max_files: { type: 'integer' },
      max_results: { type: 'integer' },
      context_before: { type: 'integer' },
      context_after: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const literalValue = args['literal'];
      const literal = typeof literalValue === 'string' ? literalValue.trim() : '';
      if (!literal) throw new Error('Literal required');

      const pathValue = args['path'];
      const rawPath =
        typeof pathValue === 'string' && pathValue.trim() !== '' ? pathValue.trim() : MINDS_DIR;
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const toolArgs: ToolArguments = { literal, path: rel };
      const modeValue = args['mode'];
      if (modeValue !== undefined) {
        if (typeof modeValue !== 'string') throw new Error('Invalid mode (expected string)');
        toolArgs['mode'] = modeValue;
      }
      const caseValue = args['case'];
      if (caseValue !== undefined) {
        if (typeof caseValue !== 'string') throw new Error('Invalid case (expected string)');
        toolArgs['case'] = caseValue;
      }
      const globsValue = args['globs'];
      if (globsValue !== undefined) {
        if (!Array.isArray(globsValue) || !globsValue.every((v) => typeof v === 'string')) {
          throw new Error('Invalid globs (expected string[])');
        }
        toolArgs['globs'] = globsValue;
      }
      const maxFilesValue = args['max_files'];
      if (maxFilesValue !== undefined) {
        if (typeof maxFilesValue !== 'number' || !Number.isInteger(maxFilesValue))
          throw new Error('Invalid max_files (expected integer)');
        toolArgs['max_files'] = maxFilesValue;
      }
      const maxResultsValue = args['max_results'];
      if (maxResultsValue !== undefined) {
        if (typeof maxResultsValue !== 'number' || !Number.isInteger(maxResultsValue))
          throw new Error('Invalid max_results (expected integer)');
        toolArgs['max_results'] = maxResultsValue;
      }
      const contextBeforeValue = args['context_before'];
      if (contextBeforeValue !== undefined) {
        if (typeof contextBeforeValue !== 'number' || !Number.isInteger(contextBeforeValue))
          throw new Error('Invalid context_before (expected integer)');
        toolArgs['context_before'] = contextBeforeValue;
      }
      const contextAfterValue = args['context_after'];
      if (contextAfterValue !== undefined) {
        if (typeof contextAfterValue !== 'number' || !Number.isInteger(contextAfterValue))
          throw new Error('Invalid context_after (expected integer)');
        toolArgs['context_after'] = contextAfterValue;
      }
      const includeHiddenValue = args['include_hidden'];
      if (includeHiddenValue !== undefined) {
        if (typeof includeHiddenValue !== 'boolean')
          throw new Error('Invalid include_hidden (expected boolean)');
        toolArgs['include_hidden'] = includeHiddenValue;
      }
      const followSymlinksValue = args['follow_symlinks'];
      if (followSymlinksValue !== undefined) {
        if (typeof followSymlinksValue !== 'boolean')
          throw new Error('Invalid follow_symlinks (expected boolean)');
        toolArgs['follow_symlinks'] = followSymlinksValue;
      }

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await ripgrepFixedTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRipgrepSearchTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_ripgrep_search',
  description: `Escape hatch ripgrep_search within ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Escape hatch ripgrep_search within ${MINDS_DIR}/.`,
    zh: `在 ${MINDS_DIR}/ 下使用 ripgrep_search 逃生舱。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      rg_args: { type: 'array', items: { type: 'string' } },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const patternValue = args['pattern'];
      const pattern = typeof patternValue === 'string' ? patternValue.trim() : '';
      if (!pattern) throw new Error('Pattern required');

      const pathValue = args['path'];
      const rawPath =
        typeof pathValue === 'string' && pathValue.trim() !== '' ? pathValue.trim() : MINDS_DIR;
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);

      const rgArgsValue = args['rg_args'];
      if (rgArgsValue !== undefined) {
        if (!Array.isArray(rgArgsValue) || !rgArgsValue.every((v) => typeof v === 'string')) {
          throw new Error('Invalid rg_args (expected string[])');
        }
      }

      const toolArgs: ToolArguments = {
        pattern,
        path: rel,
        ...(rgArgsValue !== undefined ? { rg_args: rgArgsValue } : {}),
      };
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await ripgrepSearchTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRmFileTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_rm_file',
  description: `Remove a file under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Remove a file under ${MINDS_DIR}/.`,
    zh: `删除 ${MINDS_DIR}/ 下的文件。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const filePath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!filePath) throw new Error('Path required');
      const rel = toMindsRelativePath(filePath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const output = await rmFileTool.call(dlg, proxyCaller, { path: rel });
      const content = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(content, 'rm_file')) {
        await refreshDerivedStateAfterTeamMgmtWrite({
          relPaths: [rel],
          trigger: 'rm_file',
        });
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRmDirTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_rm_dir',
  description: `Remove a directory under ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Remove a directory under ${MINDS_DIR}/.`,
    zh: `删除 ${MINDS_DIR}/ 下的目录。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
  },
  argsValidation: 'dominds',
  async call(dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const mindsState = await getMindsDirState();
      if (mindsState.kind === 'missing') {
        const msg = formatMindsMissingNotice(language);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (mindsState.kind === 'not_directory') {
        throw new Error(`${MINDS_DIR} exists but is not a directory: ${mindsState.abs}`);
      }

      const pathValue = args['path'];
      const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
      if (!rawPath) throw new Error('Path required');
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const recursiveValue = args['recursive'];
      const recursive =
        recursiveValue === undefined ? undefined : recursiveValue === true ? true : false;
      if (recursiveValue !== undefined && typeof recursiveValue !== 'boolean') {
        throw new Error('Invalid recursive (expected boolean)');
      }
      const toolArgs: ToolArguments =
        recursive === undefined ? { path: rel } : { path: rel, recursive };
      const output = await rmDirTool.call(dlg, proxyCaller, toolArgs);
      const content = toolCallOutputToString(output);
      if (isSuccessfulYamlToolResult(content, 'rm_dir')) {
        await refreshDerivedStateAfterTeamMgmtWrite({
          relPaths: [rel],
          trigger: 'rm_dir',
        });
      }
      return output;
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

function fmtHeader(title: string): string {
  return `# ${title}\n`;
}

function fmtList(items: string[]): string {
  return (
    items
      .filter((s) => s.trim() !== '')
      .map((s) => `- ${s}`)
      .join('\n') + '\n'
  );
}

function fmtCodeBlock(lang: string, lines: string[]): string {
  const body = lines.join('\n');
  return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
}

function fmtSubHeader(title: string): string {
  return `\n## ${title}\n`;
}

function fmtKeyList(keys: readonly string[]): string {
  return keys.map((k) => `\`${k}\``).join(' / ');
}

function isWindowsRuntimeHost(): boolean {
  return process.platform === 'win32';
}

async function loadBuiltinLlmDefaultsText(): Promise<string> {
  const raw = await readBuiltinDefaultsYamlRaw();
  const parsed: unknown = YAML.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return 'Invalid defaults.yaml';
  }
  const rec = parsed as Record<string, unknown>;
  const providersUnknown = rec['providers'];
  if (typeof providersUnknown !== 'object' || providersUnknown === null) {
    return 'Invalid defaults.yaml (missing providers)';
  }
  const providers = providersUnknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const [providerId, pv] of Object.entries(providers)) {
    if (typeof pv !== 'object' || pv === null) continue;
    const provider = pv as Record<string, unknown>;
    const modelsUnknown = provider['models'];
    const modelIds =
      typeof modelsUnknown === 'object' && modelsUnknown !== null
        ? Object.keys(modelsUnknown as Record<string, unknown>)
        : [];
    lines.push(
      `- ${providerId}: ${modelIds.slice(0, 30).join(', ')}${modelIds.length > 30 ? ', ...' : ''}`,
    );
  }
  return lines.join('\n');
}

async function loadBuiltinLlmModelParamOptionsText(): Promise<string> {
  const raw = await readBuiltinDefaultsYamlRaw();
  const parsed: unknown = YAML.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return 'Invalid defaults.yaml';
  }
  const rec = parsed as Record<string, unknown>;
  const providersUnknown = rec['providers'];
  if (typeof providersUnknown !== 'object' || providersUnknown === null) {
    return 'Invalid defaults.yaml (missing providers)';
  }

  const providers = providersUnknown as Record<string, unknown>;
  const lines: string[] = [];

  const summarizeSection = (section: Record<string, unknown>): string => {
    const parts: string[] = [];
    for (const [paramName, paramUnknown] of Object.entries(section)) {
      if (typeof paramUnknown !== 'object' || paramUnknown === null) continue;
      const opt = paramUnknown as Record<string, unknown>;
      const prominent = opt['prominent'] === true;
      const typeUnknown = opt['type'];
      const type = typeof typeUnknown === 'string' ? typeUnknown : undefined;
      const valuesUnknown = opt['values'];
      const values =
        Array.isArray(valuesUnknown) && valuesUnknown.every((v) => typeof v === 'string')
          ? (valuesUnknown as string[])
          : undefined;
      const minUnknown = opt['min'];
      const min = typeof minUnknown === 'number' ? minUnknown : undefined;
      const maxUnknown = opt['max'];
      const max = typeof maxUnknown === 'number' ? maxUnknown : undefined;
      const defaultUnknown = opt['default'];

      const extras: string[] = [];
      if (type) extras.push(type);
      if (values && values.length > 0) extras.push(values.join('|'));
      if (min !== undefined || max !== undefined) {
        extras.push(`${min !== undefined ? min : ''}..${max !== undefined ? max : ''}`.trim());
      }
      if (defaultUnknown !== undefined) {
        let defaultText: string | null = null;
        if (type === 'enum' && typeof defaultUnknown === 'string') {
          defaultText = defaultUnknown;
        } else if (
          (type === 'number' || type === 'integer') &&
          typeof defaultUnknown === 'number'
        ) {
          defaultText = String(defaultUnknown);
        } else if (type === 'boolean' && typeof defaultUnknown === 'boolean') {
          defaultText = defaultUnknown ? 'true' : 'false';
        } else if (type === 'string' && typeof defaultUnknown === 'string') {
          defaultText = defaultUnknown;
        } else if (
          type === 'string_array' &&
          Array.isArray(defaultUnknown) &&
          defaultUnknown.every((v) => typeof v === 'string')
        ) {
          defaultText = (defaultUnknown as string[]).join('|');
        } else if (
          type === 'record_number' &&
          typeof defaultUnknown === 'object' &&
          defaultUnknown
        ) {
          const rec = defaultUnknown as Record<string, unknown>;
          const entries = Object.entries(rec).filter(([, v]) => typeof v === 'number');
          if (entries.length > 0) {
            defaultText = entries
              .slice(0, 6)
              .map(([k, v]) => `${k}=${v}`)
              .join('|');
          }
        }
        if (defaultText) extras.push(`default=${defaultText}`);
      }

      const name = prominent ? `${paramName} [prominent]` : paramName;
      parts.push(extras.length > 0 ? `${name} (${extras.join(', ')})` : name);
    }
    return parts.join(', ');
  };

  for (const [providerId, providerUnknown] of Object.entries(providers)) {
    if (typeof providerUnknown !== 'object' || providerUnknown === null) continue;
    const provider = providerUnknown as Record<string, unknown>;
    const mpoUnknown = provider['model_param_options'];
    if (typeof mpoUnknown !== 'object' || mpoUnknown === null) continue;
    const mpo = mpoUnknown as Record<string, unknown>;

    const sections: string[] = [];
    for (const [sectionName, sectionUnknown] of Object.entries(mpo)) {
      if (typeof sectionUnknown !== 'object' || sectionUnknown === null) continue;
      const section = sectionUnknown as Record<string, unknown>;
      const summary = summarizeSection(section);
      if (!summary) continue;
      sections.push(`${sectionName}: ${summary}`);
    }
    if (sections.length === 0) continue;
    lines.push(`- ${providerId}: ${sections.join(' | ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : '- (none)';
}

export function renderMemberProperties(language: LanguageCode): string {
  const memberKeys = fmtKeyList(Team.TEAM_YAML_MEMBER_KEYS);
  if (language === 'zh') {
    return (
      fmtHeader('成员字段（members.<id>）') +
      fmtList([
        `字段白名单（以当前实现为准）：${memberKeys}`,
        '`name` / `icon` / `gofor` / `nogo`',
        '`gofor`：给其他队友/人类看的诉请速记卡（建议 5 行内），写“什么时候应该找这个队友、可以期待什么帮助/产出”。不要把该成员自己的执行守则、工作模式、验收标准或完整职责文档堆在这里；这些应写入 `.minds/team/<id>/*` 或 `.minds/team/domains/*.md`。支持 string / YAML list / YAML object；object 的 key 完全 freeform（value 必须是 string）。若你写的是 `- 标签: 内容` 这类结构化 list，虽然允许，但 `team_mgmt_validate_team_cfg({})` 会给 warning，建议改成 object；普通路由 bullet 更适合 list。对象的渲染顺序跟 YAML key 写入顺序一致（当前实现/依赖）。',
        '`nogo`：可选的反向路由卡（建议 5 行内），写“不要找这个队友做什么、应改找哪类队友/路径”。它和 `gofor` 一样，是给其他队友/人类看的，不是该成员自己的内部守则清单。支持 string / YAML list / YAML object；object 的 key 完全 freeform（value 必须是 string）。若你写的是 `- 标签: 内容` 这类结构化 list，虽然允许，但 `team_mgmt_validate_team_cfg({})` 会给 warning，建议改成 object。',
        '`provider` / `model` / `model_params`',
        '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
        '`diligence-push-max`：鞭策 上限（number）。也接受兼容别名 `diligence_push_max`，但请优先用 `diligence-push-max`。',
        '`streaming`：是否启用流式输出。注意：若该成员解析后的 provider 的 `apiType` 是 `codex`，则 `streaming: false` 属于配置错误（Codex 仅支持流式）；会在 team 校验与运行期被视为严重问题并中止请求。',
        '`hidden`（影子/隐藏成员：不出现在系统提示的团队目录里，但仍可被诉请）',
        '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs` / `read_file_ext_names` / `write_file_ext_names` / `no_read_file_ext_names` / `no_write_file_ext_names`（冲突规则见 `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })`；read 与 write 是独立控制，别默认 write implies read）',
      ])
    );
  }
  return (
    fmtHeader('Member Properties (members.<id>)') +
    fmtList([
      `Allow-list (per current implementation): ${memberKeys}`,
      '`name` / `icon` / `gofor` / `nogo`',
      '`gofor`: a short routing flashcard (≤ 5 lines) for other teammates/humans. Write when someone should ask this teammate and what help/output to expect. Do not dump the member’s own operating rules, work mode, acceptance bar, or full role spec here; those belong in `.minds/team/<id>/*` or `.minds/team/domains/*.md`. It accepts string / YAML list / YAML object; object keys are fully freeform (values must be strings). If you write a structured list like `- Label: value`, it is still allowed, but `team_mgmt_validate_team_cfg({})` will warn and suggest YAML object form instead; plain routing bullets fit YAML lists better. Object rendering order follows the YAML key order (implementation-dependent).',
      '`nogo`: an optional negative routing card (≤ 5 lines) for other teammates/humans. Write what should not be routed to this teammate and what kind of teammate/path should take it instead. Like `gofor`, this is external routing metadata, not the member’s own internal rule sheet. It accepts string / YAML list / YAML object; object keys are fully freeform (values must be strings). Structured lists are still allowed but YAML object form is preferred for labeled entries.',
      '`provider` / `model` / `model_params`',
      '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
      '`diligence-push-max`: Diligence Push cap (number). Compatibility alias `diligence_push_max` is accepted, but prefer `diligence-push-max`.',
      '`streaming`: whether to enable streaming output. Note: if the member resolves to a provider whose `apiType` is `codex`, then `streaming: false` is a configuration error (Codex is streaming-only); it is treated as a severe issue during validation/runtime and the request will be aborted.',
      '`hidden` (shadow/hidden member: excluded from system-prompt team directory, but callable)',
      '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs` / `read_file_ext_names` / `write_file_ext_names` / `no_read_file_ext_names` / `no_write_file_ext_names`（冲突规则见 `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })`；read 与 write 是独立控制，别默认 write implies read）',
    ])
  );
}

export function renderTeamManual(language: LanguageCode): string {
  const windowsHost = isWindowsRuntimeHost();
  const common = [
    'member_defaults: strongly recommended to set provider/model explicitly (omitting may fall back to built-in defaults)',
    'default_responder: not a hard requirement, but strongly recommended to set explicitly to avoid implicit fallback Dialog Responder selection and cross-run drift',
    'members: per-agent overrides inherit from member_defaults via prototype fallback',
    'after every modification to `.minds/team.yaml`: you must run `team_mgmt_validate_team_cfg({})`; if the output still contains a "Resolved But Not Yet Cleared" section, finish with `team_mgmt_clear_problems({ source: "team", path: "team.yaml" })` before proceeding so runtime state and Problems history stay aligned',
    'when changing provider/model: validate provider exists + env var is configured (use `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false })`)',
    'to discover providers/models: use `team_mgmt_list_providers({})` and `team_mgmt_list_models({ provider_pattern: "*", model_pattern: "*" })`',
    'streaming: Codex providers (apiType=codex) are streaming-only. Setting members.<id>.streaming=false with a Codex provider is a config error and will abort requests.',
    'do not write built-in members (e.g. fuxi/pangu) into `.minds/team.yaml` (define only rtws members)',
    '`shell_specialists`: optional allow-list of member ids permitted to have shell tools. Toolset `os` currently includes shell tools (`shell_cmd`, `stop_daemon`, `get_daemon_output`). If any member has shell tools, that member must be listed in `shell_specialists`; `null`/empty means “no shell specialists”.',
    'hidden: true marks a shadow member (not listed in system prompt)',
  ];
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team.yaml') +
      fmtList([
        '团队定义入口文件是 `.minds/team.yaml`（当前没有 `.minds/team.yml` / `.minds/team.json` 等别名；也不使用 `.minds/team.yaml` 以外的“等效入口”）。',
        '强烈建议显式设置 `member_defaults.provider` 与 `member_defaults.model`：如果省略，可能会使用实现内置的默认值（以当前实现为准），但可移植性/可复现性会变差，也更容易在环境变量未配置时把系统刷成板砖。',
        '`default_responder` 虽然不是技术必填项，但实践上强烈建议显式设置：否则会退回到实现内置的对话主理人选择逻辑（例如按可见成员/内置成员兜底），容易造成跨环境或跨轮次行为漂移。',
        '每次修改 `.minds/team.yaml` 必须运行 `team_mgmt_validate_team_cfg({})`；若输出里还有“已解决但未清理的问题”，继续前可用 `team_mgmt_clear_problems({ source: "team", path: "team.yaml" })` 收尾，避免运行时状态与 Problems 历史脱节。',
        '强烈建议为每个成员配置 `.minds/team/<id>/{persona,knowhow,pitfalls}.*.md` 三类资产，用来明确角色职责、工作边界、正向知识沉淀与负向避坑教训；同一个 `<id>` 必须在 `team.yaml` 的 `members` 里出现，且在 `.minds/team/<id>/` 下存在对应的 mind 文件。',
        '这些 `.minds/team/<id>/*` 文件属于团队对该角色的长期定义资产，默认应保持稳定、稀疏、慢变；它们不是该成员自己的日常经验仓库。成员在工作中积累的日常经验、近期排障线索、短中期可复用笔记，默认应优先沉淀到 `personal_memory`；需要向全队同步的当前有效状态、关键决策、下一步与仍成立阻塞，应写入 Taskdoc `progress` 这一准实时任务公告牌；个人/当前对话短期工作集与临时 bridge 细节则留在 reminders。',
        '如果某成员承担团队管理职责（尤其获得 `team_mgmt`），其 `persona.*.md` 必须明确要求：执行任何团队管理操作前先查看 `man({ "toolsetId": "team_mgmt" })` 的相关章节，并按手册标准做法维护 `.minds/**` 下的团队心智资产（如 `team.yaml`、成员 mind 文件、skills、priming 等）。',
        '“角色归属对象”不等于“写权限”：`.minds/team/<id>/*` 虽然对应某个成员角色，但是否能修改，取决于当前成员是否被授予 `team_mgmt` 或等效团队资产维护权限；“这是你自己的 persona/knowhow/pitfalls” 不等于你可以自己改写它。',
        '典型内容示例（可直接作为起点，按团队语境改写）：\n- `.minds/team/coder/persona.zh.md`\n```markdown\n### 核心身份\n- 专业程序员，负责按规格完成代码开发。\n### 工作边界\n- 不负责需求分析或产品策略决策。\n- 只根据已确认的开发规格进行实现与重构。\n### 交付标准\n- 输出可运行代码，并附关键验证步骤。\n```\n- `.minds/team/coder/knowhow.zh.md`\n```markdown\n- 熟悉本仓库主要模块边界、构建命令与常用验证入口。\n- 优先沿调用链和数据流定位根因，再决定修改点。\n- 遇到接口、配置或契约变更时，要同步检查文档、类型和回归影响。\n```\n- `.minds/team/coder/pitfalls.zh.md`\n```markdown\n- 不要只在症状层打补丁；修改前先定位调用链与数据流。\n- 涉及权限/配置时，不要跳过对应校验工具；若只剩“已解决但未清理的问题”，再用 `team_mgmt_clear_problems(...)` 收尾。\n- 涉及高风险改动时，不要一口气铺开大改；先给最小可审查方案，再逐步扩展。\n- 涉及 agentic 能力规划或开发时，不要不自觉套用传统软件工程里“程序化完善 unhappy path 兜底”的思路。对有智能体在环的业务流程步骤，继续程序化追加 unhappy path 判断，默认应视为负面行为和设计退步，而不是加分项；它不同于仅软件在环的业务流程环节，很容易引入巨量技术债务，而且业务效果往往不理想。此时应优先安排截图视觉确认、语义把关等保留智能体在环特性的兜底路径。\n```\n迁移说明：rtws 成员文件现已优先读取 `knowhow/pitfalls`；只有在新文件名不存在时，才回退接受旧的 `knowledge/lessons`。一旦存在新文件名，就只注入新文件内容，旧文件内容会被忽略。builtin mind 只认 canonical 文件名，不读取旧别名。请尽快完成改名迁移；过渡期之后，未来版本将不再识别 `knowledge/lessons`。\n写法约束：`persona/knowhow/pitfalls` 文件里不要再写与系统提示模板重复的总标题。系统提示模板会自动添加：`## 角色设定` / `## 经验知识` / `## 避坑指南`（英文模板对应 `## Persona` / `## Know-How` / `## Pitfalls`）。',
        '团队机制默认范式是“长期 agent”（long-lived teammates）：`members` 列表表示稳定存在、可随时被诉请的队友，并非“按需子角色/临时 sub-role”。这是产品机制，而非部署/运行偏好。\n如需切换当前由谁执行/扮演，用 CLI/TUI 的 `-m/--member <id>` 显式选择。\n`members.<id>.gofor` 是给其他队友/人类看的“正向诉请路由卡”（建议 5 行内）：写什么时候应该找这个队友、适合把什么问题交给 TA、以及可以期待什么帮助/产出。\n`members.<id>.nogo` 是可选的“反向路由卡”：写哪些事项不要找这个队友、应改找哪类队友/路径。两者都只服务外部路由；不要把该成员自己的执行守则、工作模式、验收标准或完整职责文档堆在这里；这些应写入 `.minds/team/<id>/*` 或 `.minds/team/domains/*.md`。它们都支持三种形态：string（单句）、YAML list（普通 bullet）、YAML object（带标签的结构化摘要，object key 完全 freeform，value 必须是 string）。\n示例（gofor / nogo）：\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      - 适合在发布前需要回归把关时找 TA\n      - 适合让 TA 梳理高风险改动与手工核验点\n      - 可以期待 TA 返回回归结论、风险清单与建议动作\n    nogo:\n      - 不要找 TA 做主实现或新功能开发\n      - 若是产品文案/信息架构问题，应改找对应实现或设计角色\n```\n示例（gofor, object；按 YAML key 顺序渲染，key freeform）：\n```yaml\nmembers:\n  coordinator:\n    name: 协调者\n    gofor:\n      When: 当你需要协调跨成员推进、拆分任务或收口结果时\n      Ask: 让 TA 负责诉请路由、任务拆分与结果集成\n      Returns: 可期待计划主线、委派方案与验收结论\n    nogo:\n      Avoid: 不要把具体实现、测试细节或文档落地直接塞给 TA\n      RouteTo: 这些应改找对应专职队友\n      Note: 若要写该成员自己的执行守则，请改写进 persona/knowhow/pitfalls\n```\n如果你把这类结构化内容写成 `- When: ...` / `- Ask: ...` 或 `- Avoid: ...` / `- RouteTo: ...` 的 YAML list，也仍然允许；但 `team_mgmt_validate_team_cfg({})` 会给 warning，建议改用 object，因为可读性更好。',
        '如何为不同角色指定默认模型：用 `member_defaults.provider/model` 设全局默认；对特定成员在 `members.<id>.provider/model` 里覆盖即可。例如：默认用 `gpt-5.2`，代码编写域成员用 `gpt-5.2-codex`。',
        '模型参数（例如 `reasoning_effort` / `verbosity` / `temperature`）应写在 `member_defaults.model_params.codex.*` 或 `members.<id>.model_params.codex.*` 下（对内置 `codex` provider）。不要把这些参数直接写在 `member_defaults`/`members.<id>` 根上。',
        '若团队需要一个行为接近 stock Codex 的显在队友，可新增如 `members.codex` 这样的成员，保持 `provider: codex`，默认授予 `ws_read` / `ws_mod` / `codex_inspect_and_patch_tools`（除非人类明确要求其他组合），并把该成员 persona 直接写成清晰的角色边界、交付要求与团队规则。即使不是 `provider: codex`，只要目标模型属于 `gpt-5.x` 家族，也默认推荐把 `codex_inspect_and_patch_tools` 叠加在 `ws_read` / `ws_mod` 之上。',
        '重要：Codex provider（`apiType=codex`）仅支持流式输出。若成员解析后的 provider 是 Codex，则 `members.<id>.streaming: false` 属于配置错误，会在校验/运行时作为严重问题上报并中止请求。',
        '`shell_specialists`：可选，列出允许拥有 shell 工具的成员 id（string|string[]|null）。toolset `os` 当前包含 `shell_cmd` / `stop_daemon` / `get_daemon_output`。如某成员获得了 shell 工具，则该成员必须出现在 `shell_specialists`；否则会在 Problems 面板提示。这个问题不会让整个 Team.load() 崩掉，但相关成员可能缺少 shell 能力，仍应修复。',

        '风格提醒：保持 `team.yaml` 的可读性。推荐用空行分隔段落/成员块，避免连续多行空行；每次修改后运行 `team_mgmt_validate_team_cfg({})` 以便在 Problems 面板看到错误与风格提醒。',

        windowsHost
          ? '默认策略（可被用户覆盖）：\n' +
            '1) 新增成员时，`diligence-push-max` 默认设为 `3`（除非用户明确要求其他值）。\n' +
            '2) 切换成员的 LLM `provider/model` 时，默认保留 `ws_read` / `ws_mod` 作为基线；在 Windows 环境下不要配置 `codex_inspect_and_patch_tools`。如需读/探测 rtws，再按需授权 `os` 给少数专员成员。'
          : '默认策略（可被用户覆盖）：\n' +
            '1) 新增成员时，`diligence-push-max` 默认设为 `3`（除非用户明确要求其他值）。\n' +
            '2) 切换成员的 LLM `provider/model` 时，默认保留 `ws_read` / `ws_mod` 作为基线；当目标模型属于 `gpt-5.x` 家族时，在基线上追加 `codex_inspect_and_patch_tools`（而不是替代），除非用户明确要求其他组合。',

        '成员配置通过 prototype 继承 `member_defaults`（省略字段会继承默认值）。',
        '修改 provider/model 前请务必确认该 provider 可用（至少 env var 已配置）。可用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false })` 做检查，避免把系统刷成板砖。',
        '想快速查看有哪些 provider / models / model_param_options：用 `team_mgmt_list_providers({})` 和 `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })`。',
        '不要把内置成员（例如 `fuxi` / `pangu`）的定义写入 `.minds/team.yaml`（这里只定义 rtws（运行时工作区）自己的成员）：内置成员通常带有特殊权限/目录访问边界；重复定义可能引入冲突、权限误配或行为不一致。',
        '`hidden: true` 表示影子/隐藏成员：不会出现在系统提示的团队目录里，但仍然可以通过 tellask-special 函数诉请。',
        '修改文件推荐流程：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` 定位行号；小改动用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` 生成 diff（工具会返回 hunk_id），再用 `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })` 显式确认写入。注意：prepare 只生成内存中的预览，apply 之前不会落盘；此时再次读取文件仍只能读到旧内容。若只是修订同一个尚未落盘的预览，可再次调用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` 覆写；若想基于这次改动继续追加下一笔修改，必须先 apply 当前 hunk，再重新 read/prepare 新的改动。如确实需要整文件覆盖：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` 从 YAML header 获取 total_lines/size_bytes，再用 `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`。',
        '部署/组织建议（可选）：如果你不希望出现显在“团队管理者”，可由一个影子/隐藏成员持有 `team_mgmt` 负责维护 `.minds/**`（尤其 `team.yaml`），由人类在需要时触发其执行（例如初始化/调整权限/更新模型）。Dominds 不强制这种组织方式；你也可以让显在成员拥有 `team_mgmt` 或由人类直接维护文件。',
      ]) +
      fmtSubHeader('Schema Snapshot（自动生成，来自当前解析器白名单）') +
      fmtList([
        `顶层字段（root）：${fmtKeyList(Team.TEAM_YAML_ROOT_KEYS)}`,
        `成员字段（members.<id>）：${fmtKeyList(Team.TEAM_YAML_MEMBER_KEYS)}`,
        `model_params 顶层字段：${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_ROOT_KEYS)}`,
        `model_params.codex 字段：${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_CODEX_KEYS)}`,
        `model_params.openai 字段：${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_OPENAI_KEYS)}`,
        `model_params.anthropic 字段：${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_ANTHROPIC_KEYS)}`,
      ]) +
      '\n' +
      '最小模板：\n' +
      '```yaml\n' +
      '# 这里只放 rtws（运行时工作区）自己的成员；不要把内置成员（例如 fuxi/pangu）写进来。\n' +
      'member_defaults:\n' +
      '  provider: codex\n' +
      '  model: gpt-5.2\n' +
      '\n' +
      'default_responder: primary\n' +
      '\n' +
      'members:\n' +
      '  team_manager:\n' +
      '    hidden: true\n' +
      "    toolsets: ['team_mgmt']\n" +
      '  primary:\n' +
      '    hidden: true\n' +
      '    toolsets:\n' +
      '      - ws_read\n' +
      '      - ws_mod\n' +
      (windowsHost ? '' : '      - codex_inspect_and_patch_tools\n') +
      '  qa_guard:\n' +
      '    name: QA Guard\n' +
      '    gofor:\n' +
      '      - Go to this teammate for pre-release regression gating\n' +
      '      - Ask this teammate to map high-risk changes and manual checks\n' +
      '      - Expect a regression verdict, risk list, and suggested next actions\n' +
      '  coder:\n' +
      '    name: Coder\n' +
      '    provider: codex\n' +
      '    model: gpt-5.2-codex\n' +
      '```\n'
    );
  }
  return (
    fmtHeader('.minds/team.yaml') +
    fmtList(
      common.concat([
        'The team definition entrypoint is `.minds/team.yaml` (no `.minds/team.yml` alias today).',
        '`default_responder` is not technically required, but strongly recommended in practice: without it, runtime falls back to implementation-defined Dialog Responder selection (for example visible-member/built-in fallback), which can drift across environments/runs.',
        'Strongly recommended: for each member, configure `.minds/team/<id>/{persona,knowhow,pitfalls}.*.md` assets to define role ownership, work boundaries, positive knowledge accumulation, and negative lessons/traps. The same `<id>` must exist in `members.<id>` in `team.yaml`.',
        'These `.minds/team/<id>/*` files are the team-defined long-lived assets for that role, and should usually stay stable, sparse, and slow-changing. They are not the member’s everyday experience warehouse. Day-to-day lessons, recent debugging clues, and medium-term reusable personal notes should usually go to `personal_memory`; current effective state, key decisions, next steps, and still-active blockers that the team must synchronize on belong in Taskdoc `progress`, the quasi-real-time task bulletin board; personal/current-dialog short-term working-set and bridge details belong in reminders.',
        'Typical content examples (use as a starting point, then adapt to your team context):\n- `.minds/team/coder/persona.en.md`\n```markdown\n### Core Identity\n- Professional programmer responsible for implementing approved development specs.\n### Work Boundaries\n- Not responsible for requirement discovery or product strategy.\n- Implements/refactors only against confirmed specs.\n### Delivery Standard\n- Deliver runnable code plus key verification steps.\n```\n- `.minds/team/coder/knowhow.en.md`\n```markdown\n- Knows the repo\'s main module boundaries, build commands, and common validation entry points.\n- Prefers tracing call chains and data flow to root cause before choosing an edit point.\n- When interfaces, config, or contracts change, also checks docs, types, and regression impact.\n```\n- `.minds/team/coder/pitfalls.en.md`\n```markdown\n- Do not patch only the symptom layer; trace the call chain and data flow first.\n- After changing permissions/config, do not skip the corresponding validators; if only "Resolved But Not Yet Cleared" remains, finish with `team_mgmt_clear_problems(...)`.\n- For high-risk changes, do not fan out into a big rewrite immediately; start with a minimal reviewable plan before expansion.\n- When planning or building agentic functionality, do not unconsciously import the traditional software-engineering instinct to \"complete\" unhappy paths with more programmatic fallback logic. For agent-in-the-loop business-process steps, adding more procedural unhappy-path branches should be treated as a negative behavior and a design regression by default, not as extra credit; unlike software-only-in-the-loop business-process steps, it often creates large technical debt while still producing weak business outcomes. Prefer screenshot-based visual confirmation, semantic review, or similar fallback paths that preserve the agent-in-the-loop nature of the step instead.\n```\nMigration note: rtws member files now prefer `knowhow/pitfalls`; they only fall back to legacy `knowledge/lessons` when the new filenames do not exist. Once a new filename exists, only the new file content is injected and the legacy file is ignored. Builtin minds only recognize canonical filenames and do not read legacy aliases. Please rename promptly; after the transition period, a future release will stop recognizing `knowledge/lessons`.\nAuthoring rule: do not add top-level titles that duplicate the system prompt wrapper. The system prompt already adds: `## Persona` / `## Know-How` / `## Pitfalls` (zh template: `## 角色设定` / `## 经验知识` / `## 避坑指南`).',
        'The team mechanism default is long-lived agents (long-lived teammates): `members` is a stable roster of callable teammates, not “on-demand sub-roles”. This is a product mechanism, not a deployment preference.\nTo pick who acts, use `-m/--member <id>` in CLI/TUI.\n`members.<id>.gofor` is a positive routing card for other teammates/humans (≤ 5 lines): write when someone should ask this teammate, what kinds of asks fit, and what help/output to expect.\n`members.<id>.nogo` is an optional negative routing card: write what should not be routed to this teammate and what kind of teammate/path should take it instead. Both fields are external routing metadata; do not dump the member’s own operating rules, work mode, acceptance bar, or full role spec here. Those belong in `.minds/team/<id>/*` or `.minds/team/domains/*.md`.\nBoth fields support three shapes: string (single sentence), YAML list (plain bullets), and YAML object (structured labeled summary; object keys are fully freeform and values must be strings).\nExample (`gofor` / `nogo`):\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      - Go to this teammate for pre-release regression gating\n      - Ask this teammate to map high-risk changes and manual checks\n      - Expect a regression verdict, risk list, and recommended next actions\n    nogo:\n      - Do not route net-new feature implementation here\n      - For product copy or information architecture, ask the relevant implementer/designer instead\n```\nExample (object form; rendered in YAML key order, freeform keys):\n```yaml\nmembers:\n  coordinator:\n    name: Coordinator\n    gofor:\n      When: when you need cross-member coordination, task breakdown, or result convergence\n      Ask: route requests, split work, and integrate outcomes\n      Returns: an execution plan, delegation decisions, and acceptance conclusions\n    nogo:\n      Avoid: do not route concrete implementation, test-authoring, or doc-writing directly here\n      RouteTo: send those asks to the relevant specialist teammate instead\n      Note: put the member’s own operating rules in persona/knowhow/pitfalls instead\n```\nIf you write the same structured content as a YAML list like `- When: ...` / `- Ask: ...` or `- Avoid: ...` / `- RouteTo: ...`, it is still accepted, but `team_mgmt_validate_team_cfg({})` will warn and suggest YAML object form for readability.',
        'Per-role default models: set global defaults via `member_defaults.provider/model`, then override `members.<id>.provider/model` per member (e.g. use `gpt-5.2` by default, and `gpt-5.2-codex` for code-writing members).',
        'Model params (e.g. `reasoning_effort` / `verbosity` / `temperature`) must be nested under `member_defaults.model_params.codex.*` or `members.<id>.model_params.codex.*` (for the built-in `codex` provider). Do not put them directly under `member_defaults`/`members.<id>` root.',
        'If you want a visible teammate that behaves close to stock Codex, a practical pattern is to add a member such as `members.codex`, keep `provider: codex`, grant the normal coding toolsets (`ws_read` / `ws_mod` / `codex_inspect_and_patch_tools` unless the human explicitly asks otherwise), and write that teammate persona as clear Dominds-native role boundaries, delivery rules, and team guidance. Even when the teammate does not use `provider: codex`, you should still recommend `codex_inspect_and_patch_tools` for `gpt-5.x` models as an extra inspect-and-patch layer on top of `ws_read` / `ws_mod`.',
        'Style reminder: keep `team.yaml` readable. Prefer single blank lines between sections/member blocks; avoid long runs of blank lines. Run `team_mgmt_validate_team_cfg({})` after edits to surface errors and style warnings in the Problems panel.',
        windowsHost
          ? 'Default policy (override only when requested):\n1) When adding a member, set `diligence-push-max` to `3` unless the user explicitly asks otherwise.\n2) When switching a member’s LLM `provider/model`, keep `ws_read` / `ws_mod` as the baseline; on Windows, do not configure `codex_inspect_and_patch_tools`. If runtime probing is needed, grant `os` only to a small specialist set.'
          : 'Default policy (override only when requested):\n1) When adding a member, set `diligence-push-max` to `3` unless the user explicitly asks otherwise.\n2) When switching a member’s LLM `provider/model`, keep `ws_read` / `ws_mod` as the baseline; when the target model is in the `gpt-5.x` family, add `codex_inspect_and_patch_tools` on top (not as a replacement), unless the user explicitly asks for a different combination.',
        'Deployment/org suggestion (optional): if you do not want a visible team manager, keep `team_mgmt` only on a hidden/shadow member and have a human trigger it when needed; Dominds does not require this organizational setup.',
        'If a member is assigned team-management responsibility (especially by granting `team_mgmt`), that member’s `persona.*.md` must explicitly require reading the relevant `man({ "toolsetId": "team_mgmt" })` chapters before any team-management action, and maintaining `.minds/**` team mind assets by handbook-standard workflow rather than improvising ad hoc edits.',
        'Role ownership is not write permission: even if `.minds/team/<id>/*` belongs to a member role, editing it still depends on whether the current actor holds `team_mgmt` or equivalent team-asset maintenance authority. “This is your own persona/knowhow/pitfalls” does not mean “you may rewrite it yourself”.',
        'Recommended editing workflow: use `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` to find line numbers; for small edits, run `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` to get a diff (the tool returns hunk_id), then confirm with `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })`. Important: prepare only creates an in-memory preview and does not persist anything before apply, so re-reading the file at this point still returns the old content. If you only want to revise the same not-yet-persisted preview, call `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` again; if you want a further edit based on this change, you must apply the current hunk first, then read/prepare the next change. If you truly need a full overwrite: first `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` and read total_lines/size_bytes from the YAML header, then use `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`.',
      ]),
    ) +
    fmtSubHeader('Schema Snapshot (generated from parser allow-list)') +
    fmtList([
      `Root keys: ${fmtKeyList(Team.TEAM_YAML_ROOT_KEYS)}`,
      `members.<id> keys: ${fmtKeyList(Team.TEAM_YAML_MEMBER_KEYS)}`,
      `model_params keys: ${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_ROOT_KEYS)}`,
      `model_params.codex keys: ${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_CODEX_KEYS)}`,
      `model_params.openai keys: ${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_OPENAI_KEYS)}`,
      `model_params.anthropic keys: ${fmtKeyList(Team.TEAM_YAML_MODEL_PARAMS_ANTHROPIC_KEYS)}`,
    ]) +
    '\n' +
    'Minimal template:\n' +
    '```yaml\n' +
    '# Define only rtws members here (do not copy built-in members like fuxi/pangu).\n' +
    'member_defaults:\n' +
    '  provider: codex\n' +
    '  model: gpt-5.2\n' +
    '\n' +
    'default_responder: primary\n' +
    '\n' +
    'members:\n' +
    '  team_manager:\n' +
    '    hidden: true\n' +
    "    toolsets: ['team_mgmt']\n" +
    '  primary:\n' +
    '    hidden: true\n' +
    '    toolsets:\n' +
    '      - ws_read\n' +
    '      - ws_mod\n' +
    (windowsHost ? '' : '      - codex_inspect_and_patch_tools\n') +
    '```\n'
  );
}

export function renderPermissionsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('权限（目录 + 扩展名）') +
      fmtList([
        '目录字段：`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`。',
        '扩展名字段：`read_file_ext_names` / `write_file_ext_names` / `no_read_file_ext_names` / `no_write_file_ext_names`。',
        'deny-list（`no_*`）优先于 allow-list（`*`）。目录与扩展名两个维度都需要通过。',
        '若某维度未配置 allow-list，则该维度默认允许（在 deny-list 不命中的前提下）。这很方便，但也更容易“权限过大”；如需最小权限，建议显式收敛 allow-list 并对敏感目录/扩展名加 deny-list。',
        '`read_dirs` 与 `write_dirs` 是独立控制：不要默认 write implies read（以当前实现的权限检查为准）。',
        '`read_file_ext_names` 与 `write_file_ext_names` 同样是独立控制。',
        '扩展名按文件名后缀精确匹配（大小写不敏感，配置项可写 `ts` 或 `.ts`）。',
        '模式支持 `*` 和 `**`，按“目录范围”语义匹配（按目录/路径前缀范围来理解）。',
        '示例：`dominds/**` 会匹配 `dominds/README.md`、`dominds/main/server.ts`、`dominds/webapp/src/...` 等路径。',
        '示例：`.minds/**` 会匹配 `.minds/team.yaml`、`.minds/team/<id>/persona.zh.md` 等；常用于限制普通成员访问 minds 资产。',
        '`*.tsk/` 是封装差遣牒：只能用函数工具 `change_mind` 维护。任何通用文件工具都无法访问该目录树（硬编码无条件拒绝）。',
        '`.minds/**` 是 rtws（运行时工作区）的“团队配置/记忆/资产”目录：任何通用文件工具都无法访问（硬编码无条件拒绝）。只有专用的 `.minds/` 工具集（例如 `team_mgmt`）可访问它。',
        '在当前内建模型中，`.minds/team/**`、`.minds/team.yaml`、`.minds/skills/**`、`.minds/priming/**` 等团队资产目录，只有持有 `team_mgmt` 的成员才应修改。',
        '`.minds/team/<id>/*` 的“角色归属对象”只表示它描述哪个角色，不构成任何额外写权限。未持有 `team_mgmt` 的成员，即使只是想更新“自己的” persona/knowhow/pitfalls，也应通过回贴建议内容，由具备权限的团队管理者代写。',
        '因此，**不要**为了“重申系统内置限制”而在 `team.yaml` 里机械地添加 `no_read_dirs: [".minds/**"]` / `no_write_dirs: [".minds/**"]`（或出于同类目的添加 `*.tsk/**` deny）。这类条目不增加任何真实约束，只会制造样板噪音，并误导团队管理智能体以为它们是常规必填项。',
        '原则：`team.yaml` 里的权限字段只写**额外**业务约束；系统内置的硬边界由运行时自己保证，不需要也不应重复书写。',
        '说明：如果你在 `team.yaml` 的 allow-list（`read_dirs`/`write_dirs`）里写了 `.minds/**` 或 `*.tsk/**` 试图绕过限制，运行时会忽略并上报 err 级别问题。',
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小权限写法示例（仅示意）',
        'members:',
        '  coder:',
        '    read_dirs: ["dominds/**"]',
        '    write_dirs: ["dominds/**"]',
      ])
    );
  }
  return (
    fmtHeader('Permissions (Directory + Extension)') +
    fmtList([
      'Directory fields: `read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`.',
      'Extension fields: `read_file_ext_names` / `write_file_ext_names` / `no_read_file_ext_names` / `no_write_file_ext_names`.',
      'Deny-lists (`no_*`) override allow-lists (`*`). Both directory and extension dimensions must pass.',
      'If a dimension has no allow-list, that dimension defaults to allow (after deny-list check). This is convenient but can be overly permissive; for least privilege, explicitly narrow allow-lists and deny sensitive directories/extensions.',
      '`read_dirs` and `write_dirs` are controlled independently (do not assume write implies read; follow current implementation).',
      '`read_file_ext_names` and `write_file_ext_names` are also controlled independently.',
      'Extension names are exact suffix matches (case-insensitive; config accepts `ts` or `.ts`).',
      'Patterns support `*` and `**` with directory-scope semantics (think directory/path-range matching).',
      'Example: `dominds/**` matches `dominds/README.md`, `dominds/main/server.ts`, `dominds/webapp/src/...`, etc.',
      'Example: `.minds/**` matches `.minds/team.yaml` and `.minds/team/<id>/persona.*.md`; commonly used to restrict normal members from minds assets.',
      '`*.tsk/` is an encapsulated Taskdoc: it must be maintained via the function tool `change_mind` only. It is hard-denied for all general file tools.',
      '`.minds/**` stores rtws (runtime workspace) team config/memory/assets: it is hard-denied for all general file tools. Only dedicated `.minds/`-scoped toolsets (e.g. `team_mgmt`) may access it.',
      'In the current built-in model, team asset paths such as `.minds/team/**`, `.minds/team.yaml`, `.minds/skills/**`, and `.minds/priming/**` should only be modified by members who hold `team_mgmt`.',
      'The “owner role” of `.minds/team/<id>/*` only tells you which role the asset describes; it does not grant extra write permission. Without `team_mgmt`, a member should not rewrite even “their own” persona/knowhow/pitfalls directly, and should instead hand back suggested content for an authorized team manager to apply.',
      'Therefore, do **not** mechanically restate that built-in hard deny in `team.yaml` with `no_read_dirs: [".minds/**"]` / `no_write_dirs: [".minds/**"]` (or similar `*.tsk/**` deny lines). Those entries add no real constraint, only boilerplate noise, and they incorrectly teach team managers that such lines are standard required practice.',
      'Rule of thumb: permission fields in `team.yaml` should describe only **additional** business-specific constraints. Built-in hard boundaries are enforced by the runtime and should not be redundantly copied into member config.',
      'Note: If you try to whitelist `.minds/**` or `*.tsk/**` via `read_dirs`/`write_dirs`, the runtime ignores it and reports an error-level Problem.',
    ]) +
    fmtCodeBlock('yaml', [
      '# Least-privilege example (illustrative)',
      'members:',
      '  coder:',
      '    read_dirs: ["dominds/**"]',
      '    write_dirs: ["dominds/**"]',
    ])
  );
}

export function renderMindsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team/<id>/*') +
      fmtList([
        '推荐实践（建议默认采用）：每个 `members.<id>` 同时维护 `persona.*.md` / `knowhow.*.md` / `pitfalls.*.md`，把角色设定、正向知识/经验沉淀、负向教训/避坑规则分层管理。',
        '共同去向（按当前实现）：这三类文件会在每次对话开始时按工作语言读取，并分别拼进 system prompt 的 `## 角色设定` / `## 经验知识` / `## 避坑指南` 章节；它们是写给“当前成员智能体自己”看的长期提示，不是给团队管理者/人类旁观者读的人物简介。',
        '硬边界：`persona.*.md` / `knowhow.*.md` / `pitfalls.*.md` 是角色级长期定义资产，更像“角色宪章”，不是成员自己的日常经验仓库。只有稳定职责、长期工作方法、高复用判断原则、持久有效的正反例，才适合写进这些文件。',
        '推荐分流：角色职责/边界/长期方法论 -> `persona/knowhow/pitfalls`；成员个人长期可复用经验与个人工作索引 -> `personal_memory`；需要向全队同步的当前有效状态、关键决策、下一步与仍成立阻塞 -> Taskdoc `progress`（准实时任务公告牌）；个人/当前对话短期工作集、接续包、临时 bridge 细节 -> reminders；团队共享长期约定/不变量 -> `team_memory`。',
        '最小要求：每个 `members.<id>` 建议至少提供 `persona.*.md`。当前实现中，缺失 persona 时会回退到内置默认 persona 文案；缺失或空白的 knowhow/pitfalls 会在系统提示中以本地化的“无”占位显示。',
        'persona.*.md：角色设定（稳定的工作方式与职责）。它会进入该成员的 `role=system` 提示，因此默认应直接写给该智能体本人，使用第二人称“你”来规定职责、边界与工作方式；不要把它写成第三人称人物简介，更不要使用“祂”这类旁白口吻。',
        'knowhow.*.md：正向知识/经验沉淀。它会进入 `## 经验知识`，适合写“当前成员在该职责下反复要用到的稳定事实 / 索引 / 约定 / 判断依据 / 已验证有效的方法”；更偏向帮助该成员复用长期适用的做法，而不是把“最近一次排障过程”或“今天查到的某个链接”原样堆进去。只有当这类材料已经上升为长期适用的方法、索引或判断规则时，才值得写入。',
        'pitfalls.*.md：负向经验教训。它会进入 `## 避坑指南`，适合写“哪些坑不要再踩 / 哪些信号意味着风险 / 出现什么情况时先做什么、不要做什么”；更偏向避坑、防复发和失败模式约束。只有当某个失败案例已经沉淀成长期有效的反例或禁忌时，才适合写入；不要写成任务流水账、会议纪要或第三人称成长故事。',
        '迁移约束（当前实现）：rtws 成员文件读取顺序为 `persona.zh.md -> persona.md`，`knowhow.zh.md -> knowhow.md -> knowledge.zh.md -> knowledge.md`，`pitfalls.zh.md -> pitfalls.md -> lessons.zh.md -> lessons.md`。也就是说，旧名 `knowledge/lessons` 只在新名不存在时才作为 fallback 接受；一旦新文件名存在，就只注入新文件内容。builtin mind 只认 canonical 文件名，不读取旧别名。请尽快迁移改名；过渡期之后，未来版本将不再识别 `knowledge/lessons`。',
        '若该成员承担团队管理职责（尤其获得 `team_mgmt`），其 `persona.*.md` 必须明确写出：执行任何团队管理操作前先查看 `man({ "toolsetId": "team_mgmt" })` 的相关章节，并按手册标准做法维护 `.minds/**` 团队心智资产。',
        '语言选择（按当前实现）：优先读取 `persona.zh.md` / `knowhow.zh.md` / `pitfalls.zh.md` 这类工作语言文件，再按各自 fallback 顺序回退到无语言后缀与旧名兼容文件；不会跨语言回退到另一种语言文件。',
        '标题层级约束：`persona/knowhow/pitfalls` 文件里不要再写重复的总标题。系统提示模板会自动添加：`## 角色设定` / `## 经验知识` / `## 避坑指南`（英文模板对应 `## Persona` / `## Know-How` / `## Pitfalls`）。因此正文通常应从 `###` 小节或普通 bullet 开始，而不是再写 `#` / `##`，也不要再把文件名或这些章节名重复当标题写一遍。',
      ]) +
      fmtCodeBlock('text', [
        '.minds/',
        '  team/',
        '    qa_guard/',
        '      persona.zh.md',
        '      knowhow.zh.md',
        '      pitfalls.zh.md',
      ]) +
      fmtCodeBlock('markdown', [
        '### 核心身份',
        '- 你是专业程序员，负责按规格完成代码开发。',
        '### 工作边界',
        '- 你不负责需求分析或产品策略决策。',
        '- 你只根据已确认的开发规格进行实现与重构。',
        '### 交付标准',
        '- 你要输出可运行代码，并附关键验证步骤。',
      ]) +
      fmtCodeBlock('markdown', [
        '- 熟悉本仓库主要模块边界、构建命令与常用验证入口。',
        '- 优先沿调用链和数据流定位根因，再决定修改点。',
        '- 遇到接口、配置或契约变更时，要同步检查文档、类型和回归影响。',
      ]) +
      fmtCodeBlock('markdown', [
        '- 不要只在症状层打补丁；修改前先定位调用链与数据流。',
        '- 涉及权限/配置时，不要跳过对应校验工具；若只剩“已解决但未清理的问题”，再用 `team_mgmt_clear_problems(...)` 收尾。',
        '- 涉及高风险改动时，不要一口气铺开大改；先给最小可审查方案，再逐步扩展。',
        '- 涉及 agentic 能力规划或开发时，不要不自觉套用传统软件工程里“程序化完善 unhappy path 兜底”的思路。对有智能体在环的业务流程步骤，继续程序化追加 unhappy path 判断，默认应视为负面行为和设计退步，而不是加分项；它不同于仅软件在环的业务流程环节，很容易引入巨量技术债务，而且业务效果往往不理想。此时应优先安排截图视觉确认、语义把关等保留智能体在环特性的兜底路径。',
      ])
    );
  }
  return (
    fmtHeader('.minds/team/<id>/*') +
    fmtList([
      'Recommended default practice: for each `members.<id>`, maintain `persona.*.md` / `knowhow.*.md` / `pitfalls.*.md` together so persona, positive knowledge accumulation, and negative lessons/traps stay layered and maintainable.',
      'Shared destination (current implementation): these three files are read at every dialog start and are spliced into the system prompt as `## Persona` / `## Know-How` / `## Pitfalls`. They are long-lived prompt assets written for the current member agent itself, not operator-facing biographies for a team manager or human observer.',
      'Hard boundary: `persona.*.md` / `knowhow.*.md` / `pitfalls.*.md` are role-level long-lived definition assets, closer to a “role charter” than to a personal notebook. Only stable responsibilities, long-lived working methods, highly reusable judgment rules, and durable positive/negative examples belong here.',
      'Recommended split: role responsibilities/boundaries/long-lived methodology -> `persona/knowhow/pitfalls`; a member’s own long-lived reusable experience and working index -> `personal_memory`; current effective state, key decisions, next steps, and still-active blockers that the team must synchronize on -> Taskdoc `progress` (the quasi-real-time task bulletin board); personal/current-dialog short-term working set, continuation details, and temporary bridge notes -> reminders; team-shared long-lived conventions/invariants -> `team_memory`.',
      'Minimum: for each `members.<id>`, provide at least `persona.*.md`. In the current implementation, a missing persona falls back to built-in default persona text, while missing/blank knowhow and pitfalls render as the localized “none” placeholder.',
      'persona.*.md: persona and operating style. It is injected into that member\'s `role=system` prompt, so write it directly to the agent in second person ("you") when specifying responsibilities, boundaries, and working style; do not turn it into a third-person biography.',
      'knowhow.*.md: positive knowledge / proven know-how. It lands in `## Know-How`, so use it for stable facts, indexes, conventions, decision cues, and validated methods that the member repeatedly reuses in this responsibility. Do not dump raw “latest debugging notes” or a link you found today unless it has already been distilled into a long-lived method, index, or judgment rule.',
      'pitfalls.*.md: negative lessons / anti-traps. It lands in `## Pitfalls`, so prefer “what not to repeat” guidance such as risk signals, failure modes, and heuristics like “if signal X appears -> do / avoid Y -> because Z”. Only promote a failure case here once it has become a durable negative example or warning pattern; do not treat it as a task log, meeting minutes, or a third-person growth narrative.',
      'Migration rule (current implementation): rtws member files read `persona.en.md -> persona.md`, `knowhow.en.md -> knowhow.md -> knowledge.en.md -> knowledge.md`, and `pitfalls.en.md -> pitfalls.md -> lessons.en.md -> lessons.md`. Legacy `knowledge/lessons` are fallback-only: once a new filename exists, only the new file content is injected. Builtin minds only recognize canonical filenames and do not read legacy aliases. Please rename promptly; after the transition period, a future release will stop recognizing `knowledge/lessons`.',
      'If the member carries team-management responsibility (especially with `team_mgmt`), `persona.*.md` must explicitly require reading the relevant `man({ "toolsetId": "team_mgmt" })` chapters before any team-management action, and maintaining `.minds/**` team mind assets by handbook-standard workflow.',
      "Language selection (current implementation): prefer work-language variants such as `persona.en.md` / `knowhow.en.md` / `pitfalls.en.md`, then follow each file kind's fallback order through default-name and legacy-name variants. There is no cross-language fallback to another language-specific file.",
      'Heading rule: do not add top-level titles that duplicate the system prompt wrapper. The system prompt already adds: `## Persona` / `## Know-How` / `## Pitfalls` (zh template: `## 角色设定` / `## 经验知识` / `## 避坑指南`). In practice, bodies should usually start at `###` subsections or plain bullets rather than another `#` / `##`, and should not restate the filename or wrapper title as a heading.',
    ]) +
    fmtCodeBlock('text', [
      '.minds/',
      '  team/',
      '    qa_guard/',
      '      persona.en.md',
      '      knowhow.en.md',
      '      pitfalls.en.md',
    ]) +
    fmtCodeBlock('markdown', [
      '### Core Identity',
      '- You are a professional programmer responsible for implementing approved development specs.',
      '### Work Boundaries',
      '- You are not responsible for requirement discovery or product strategy.',
      '- You implement/refactor only against confirmed specs.',
      '### Delivery Standard',
      '- You deliver runnable code plus key verification steps.',
    ]) +
    fmtCodeBlock('markdown', [
      "- Know the repo's main module boundaries, build commands, and common validation entry points.",
      '- Prefer tracing call chains and data flow to root cause before choosing an edit point.',
      '- When interfaces, config, or contracts change, also check docs, types, and regression impact.',
    ]) +
    fmtCodeBlock('markdown', [
      '- Do not patch only the symptom layer; trace the call chain and data flow first.',
      '- After changing permissions/config, do not skip the corresponding validators; if only "Resolved But Not Yet Cleared" remains, finish with `team_mgmt_clear_problems(...)`.',
      '- For high-risk changes, do not fan out into a big rewrite immediately; start with a minimal reviewable plan before expansion.',
      '- When planning or building agentic functionality, do not unconsciously import the traditional software-engineering instinct to "complete" unhappy paths with more programmatic fallback logic. For agent-in-the-loop business-process steps, adding more procedural unhappy-path branches should be treated as a negative behavior and a design regression by default, not as extra credit; unlike software-only-in-the-loop business-process steps, it often creates large technical debt while still producing weak business outcomes. Prefer screenshot-based visual confirmation, semantic review, or similar fallback paths that preserve the agent-in-the-loop nature of the step instead.',
    ])
  );
}

export function renderSkillsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/skills/*（技能）') +
      fmtList([
        '推荐目录：团队共享技能放在 `.minds/skills/team_shared/<skill-id>/SKILL.cn.md`（英文对齐文件用 `SKILL.en.md`）；个人技能放在 `.minds/skills/individual/<member-id>/<skill-id>/SKILL.cn.md`。',
        '语言选择：Dominds 当前工作语言是 `zh|en`，但 skill 文件后缀采用更通行的 `cn|en`。当工作语言为 `zh` 时优先读取 `SKILL.cn.md`，当工作语言为 `en` 时优先读取 `SKILL.en.md`，两者都可回退到无语言标识的 `SKILL.md`；不会跨语言兜底到另一种语言文件。',
        '可移植优先格式：遵循当前主流 Agent Skills 生态公共子集，使用 `SKILL.md + YAML frontmatter`。最小必备字段是 `name` 与 `description`，正文 markdown 即真正的技能提示词/操作指引。',
        'Dominds 当前实现会把匹配到的 skill 内容直接注入 agent system prompt；因此这里的技能更接近“指导知识包”。这与部分平台的“先只加载 name/description、命中后再延迟加载正文”不同，请控制体量，把长参考资料拆到同目录其它文件并在正文里按需引用。',
        '去向与口吻（按当前实现）：`name` 会成为 skills 小节里的标题，`description` 会作为说明文字显示，正文会原样进入 `Prompt` 区块。因此三者都属于写给“当前成员智能体”的系统提示内容。推荐把 `name` 写成稳定技能名，把 `description` 写成“何时用/何时不用”，把正文写成简洁的操作指引（多用祈使句/第二人称），不要写成 marketplace 营销文案、第三人称人物介绍，或对团队管理者的旁白说明。',
        '标题层级约束：skills 模板已经自动包好 `### Skills（工作技能）` 和每个 skill 的 `#### <name>` 标题。正文通常应从普通 bullet、步骤列表，或至多 `#####` 小节开始；不要在正文里再写 `# <skill-name>` / `## ...` 来重复外层标题结构。',
        '为兼容公开来源，可保留 `allowed-tools` / `user-invocable` / `disable-model-invocation` 字段；但在 Dominds 中：这些字段目前只用于迁移/文档语义，不会自动授予工具权限，也不会改变运行时调度逻辑。',
        '最重要的边界：skill 不是权限系统。真正的工具能力仍由 `.minds/team.yaml` 的 `toolsets` / `tools` 与已安装 Dominds apps 决定。',
        '团队管理职责的智能体可以联网搜索公开 skill 定义（优先官方文档/官方仓库/官方 marketplace 条目），也可以直接基于团队真实操作经验自行总结编写。迁移前必须核对 license、适用场景、是否依赖脚本/外部工具、是否夹带与本团队冲突的人设/权限假设。',
        '对于网络公开来源、并且带脚本/工具调用约束的 skills：默认不要只把文案抄进 `.minds/skills/**` 就上线。推荐路径是把执行能力封装成 Dominds app（专属工具 / toolsets / 工具集手册 / teammates contract），再由 skill 只保留软性指导与对 app/toolset 的引用说明。',
      ]) +
      fmtHeader('建议采用的 SKILL 文件格式') +
      fmtCodeBlock('markdown', [
        '---',
        'name: repo-debugger',
        'description: >',
        '  调试仓库级构建/测试失败的操作指引。适用于 CI 失败、依赖漂移、环境不一致等场景。',
        'allowed-tools:',
        '  - read_file',
        '  - readonly_shell',
        'user-invocable: true',
        'disable-model-invocation: false',
        '---',
        '',
        '##### 入口',
        '- 先确认失败信号与复现入口。',
        '- 若需要 shell，必须使用当前团队已授权的 Dominds 工具/专员，不得把 `allowed-tools` 视为自动授权。',
        '',
        '##### 操作步骤',
        '1. 收集报错与最近变更。',
        '2. 最小化复现。',
        '3. 定位根因并给出验证方案。',
      ]) +
      fmtHeader('公开来源迁移到 Dominds 的字段映射') +
      fmtList([
        '`name` → 直接保留。建议继续使用短 hyphen-case 标识，并与目录名 `<skill-id>` 保持一致。',
        '`description` → 直接保留，但要补足“何时触发/何时不该触发”。这在 GitHub/Codex/skills.sh 生态中本来就是关键触发字段。',
        'SKILL 正文 → 直接作为 Dominds skill 正文；如果正文包含平台专有命令（如 `/skill-name`、`Bash(git add:*)`、Claude 的 `!command` 注入等），迁移时必须改写为 Dominds 可执行语义。',
        '`allowed-tools` → 仅保留为迁移提示。然后把真正需要的能力映射到 Dominds app/toolset 或 `.minds/team.yaml members.<id>.toolsets|tools`。不要把它当运行时授权。',
        '`user-invocable` / `disable-model-invocation` → 目前仅保留为兼容元数据，Dominds 尚未把这两个字段做成调度开关。',
        'Anthropic subagent 的 `tools` / `model` / 子代理身份字段 → 不应直接塞进 Dominds skill。可复用的“指导正文”抽出来做 skill；工具能力改走 Dominds app / toolset / 工具集手册；人设与职责边界改写到 `.minds/team/<id>/persona.*.md`。',
        'GitHub `copilot-instructions.md` / `*.instructions.md` / `AGENTS.md` / `.prompt.md` 这类“纯 markdown 指令文件” → 通常没有完整 skill frontmatter。迁移时要补写 `name` 与 `description`，再把正文整理成真正可复用的操作说明；如果它本质是仓库全局约束而不是技能，应优先放回 persona/knowhow/pitfalls/env/AGENTS，而不是硬转 skill。',
      ]) +
      fmtHeader('团队管理智能体的落地操作步骤') +
      fmtList([
        '1. 联网搜索：优先找官方文档、官方仓库、官方 marketplace/listing（例如 GitHub Copilot Agent Skills、Claude Code skills/subagents、skills.sh 条目）。',
        '2. 识别类型：判断来源到底是标准 SKILL、slash command、subagent、仓库级 custom instructions，还是脚本集合。不是所有 prompt 文件都适合落到 Dominds skills。',
        '3. 提取可移植公共子集：至少提炼出 `name`、`description`、正文操作指引；删掉平台专有 shell 注入、命令占位符、隐式工具假设。',
        '4. 判断是否需要 app 化：只要来源 skill 依赖脚本、外部二进制、MCP、专有工具权限、工具集手册、或希望供多个 app/team 复用，优先走 Dominds app 开发与安装流程，再在 skill 里引用该 app/toolset。',
        '5. 写入 rtws：把纯提示型技能放到 `.minds/skills/team_shared/<skill-id>/SKILL.cn.md` 或个人目录；若团队工作语言需要英文对齐，再补 `SKILL.en.md`。',
        '6. 配置权限：根据 skill 真实需要，更新 `.minds/team.yaml` 的成员 `toolsets` / `tools`，必要时安装/启用对应 Dominds app；不要只写 `allowed-tools` 就结束。',
        '7. 本地化：`cn` 文件作为中文语义基准；`en` 追随 `cn`。若公开来源只有英文，先提炼成符合本团队语义的中文基准，再回写英文对齐版。',
        '8. 验收：用 `dominds read <member-id> --only-prompt` 检查 skill 是否已注入 system prompt，并确认没有把不该暴露的工具/脚本假设写进正文。',
      ]) +
      fmtHeader('从常见官方格式迁移时的判断口诀') +
      fmtList([
        '“只有 `name/description/body` 的标准 SKILL” → 最容易迁移，优先原样改写后落盘。',
        '“带 `allowed-tools` 但无脚本” → 可先作为纯提示 skill 引入，再人工配置 Dominds toolsets。',
        '“带脚本 / Bash allowlist / MCP / 动态注入命令” → 默认走 Dominds app 封装路径，不要只复制 markdown。',
        '“其实是全局仓库约束” → 更可能属于 persona / knowhow / pitfalls / env / AGENTS，不一定应该做成 skill。',
      ])
    );
  }

  return (
    fmtHeader('.minds/skills/* (skills)') +
    fmtList([
      'Recommended layout: team-shared skills live at `.minds/skills/team_shared/<skill-id>/SKILL.cn.md` (with `SKILL.en.md` as the English counterpart); personal skills live at `.minds/skills/individual/<member-id>/<skill-id>/SKILL.cn.md`.',
      'Language selection: Dominds work language is currently `zh|en`, but skill filenames use the more portable `cn|en` suffixes. When work language is `zh`, Dominds prefers `SKILL.cn.md`; when it is `en`, Dominds prefers `SKILL.en.md`; both may fall back to `SKILL.md`. There is no cross-language fallback.',
      'Portable-first format: follow the common Agent Skills subset used by GitHub/Codex/Claude/skills.sh style ecosystems: `SKILL.md + YAML frontmatter`. The minimum required fields are `name` and `description`; the Markdown body is the actual skill prompt/operating guidance.',
      'Current Dominds behavior eagerly injects matched skills into the agent system prompt. That makes a Dominds skill closer to a guidance knowledge pack than to a lazily loaded marketplace artifact. Keep bodies tight, and move long references into sibling files that the body points to.',
      'Destination and tone (current implementation): `name` is rendered as the skill heading, `description` appears as visible description text, and the body is inserted verbatim into the `Prompt` block inside system prompt. Write all three for the current member agent. Use a stable skill name, trigger-oriented description, and concise operating guidance in the body; avoid marketplace sales copy, third-person biographies, or operator-facing narration.',
      'Heading rule: the wrapper already provides `### Skills` and `#### <name>` for each skill. Bodies should usually start with plain bullets, numbered steps, or at most `#####` subsections; do not repeat the outer structure with another `# <skill-name>` / `## ...` inside the body.',
      'For compatibility with public skill sources, Dominds accepts `allowed-tools`, `user-invocable`, and `disable-model-invocation`; however, in Dominds these fields are currently informational only. They do not grant tools and do not change runtime dispatch yet.',
      'The hard boundary: a skill is not a permission system. Real tool access still comes from `.minds/team.yaml` (`toolsets` / `tools`) and installed Dominds apps.',
      'A team-management agent may browse the web for public skill definitions (prefer official docs/repos/marketplace listings), or write skills directly by summarizing the team’s own repeatable operating guidance. Before importing, verify license, applicability, script/tool dependencies, and any hidden persona/permission assumptions.',
      'For public-network skills that rely on scripts or explicit tool contracts: do not ship them by copying Markdown alone. Preferred path: wrap execution capability into a Dominds app (dedicated tools / toolsets / toolset manual / teammate contract), then keep the skill focused on soft guidance and app/toolset references.',
    ]) +
    fmtHeader('Recommended SKILL File Format') +
    fmtCodeBlock('markdown', [
      '---',
      'name: repo-debugger',
      'description: >',
      '  Operating guidance for debugging repository-level build/test failures. Use for CI failures,',
      '  dependency drift, or environment inconsistencies.',
      'allowed-tools:',
      '  - read_file',
      '  - readonly_shell',
      'user-invocable: true',
      'disable-model-invocation: false',
      '---',
      '',
      '##### Entry',
      '- Confirm the failure signal and reproduction path first.',
      '- If shell is required, use only the Dominds tools/specialists actually granted by the team; never treat `allowed-tools` as auto-authorization.',
      '',
      '##### Procedure',
      '1. Gather the error signal and recent changes.',
      '2. Minimize reproduction.',
      '3. Isolate root cause and propose verification.',
    ]) +
    fmtHeader('Field Mapping from Public Skill Formats into Dominds') +
    fmtList([
      '`name` -> keep as-is. Continue using a short hyphen-case identifier and keep it aligned with the directory name `<skill-id>`.',
      '`description` -> keep as-is, but strengthen the “when to use / when not to use” trigger guidance. This is already the critical discovery field in GitHub/Codex/skills.sh ecosystems.',
      'SKILL body -> keep as the Dominds skill body. If it contains platform-specific commands (`/skill-name`, `Bash(git add:*)`, Claude `!command` injection, etc.), rewrite those parts into Dominds-executable semantics.',
      '`allowed-tools` -> informational only in Dominds. Map actual capability needs into a Dominds app/toolset and/or `.minds/team.yaml members.<id>.toolsets|tools`.',
      '`user-invocable` / `disable-model-invocation` -> preserved only as compatibility metadata for now; Dominds does not yet use them as dispatch switches.',
      'Anthropic subagent fields such as `tools`, `model`, or subagent identity -> do not import directly into a Dominds skill. Extract the reusable guidance body into a skill; move tool capability into a Dominds app/toolset/toolset manual; move persona/responsibility boundaries into `.minds/team/<id>/persona.*.md`.',
      'GitHub `copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, and `.prompt.md` files are usually plain Markdown instructions, not complete skills. When converting them, add `name` and `description`, then turn the body into reusable operating guidance. If the content is actually repo-wide policy rather than a skill, keep it in persona/knowhow/pitfalls/env/AGENTS instead of forcing it into `skills`.',
    ]) +
    fmtHeader('Operational Steps for a Team-Management Agent') +
    fmtList([
      '1. Search official sources first: GitHub Copilot Agent Skills docs, Claude Code skills/subagents docs, official repos, and marketplace/listing entries such as skills.sh.',
      '2. Classify the source: is it a standard SKILL, slash command, subagent, repo-wide custom instructions file, or a script bundle? Not every prompt file should become a Dominds skill.',
      '3. Extract the portable core: at minimum keep `name`, `description`, and the operating-guidance body. Remove platform-specific shell injection, command placeholders, and hidden tool assumptions.',
      '4. Decide whether it must become an app: if the source relies on scripts, external binaries, MCP, privileged tools, toolset manuals, or should be reused across multiple apps/teams, prefer the Dominds app path first.',
      '5. Write into the rtws: store pure prompt skills under `.minds/skills/team_shared/<skill-id>/SKILL.cn.md` or the personal directory; add `SKILL.en.md` when an English counterpart is needed.',
      '6. Configure permissions explicitly: update `.minds/team.yaml` member `toolsets` / `tools`, and install/enable the supporting Dominds app when required. Do not stop at `allowed-tools` metadata.',
      '7. Localize deliberately: use the `cn` file as the Chinese semantic baseline, then align `en` to it. If the public source is English-only, distill it into your team’s Chinese baseline first.',
      '8. Verify with `dominds read <member-id> --only-prompt` to confirm the skill is injected and does not claim tools/scripts the member does not actually have.',
    ]) +
    fmtHeader('Fast Triage Rules When Importing Official Formats') +
    fmtList([
      '“Standard SKILL with `name/description/body` only” -> easiest path; usually port directly with light rewriting.',
      '“Has `allowed-tools` but no scripts” -> may enter as a pure prompt skill first, then map real Dominds toolsets manually.',
      '“Has scripts / Bash allowlists / MCP / dynamic command injection” -> default to the Dominds app packaging path; do not just copy the Markdown.',
      '“Actually repo-global policy” -> more likely belongs in persona / knowhow / pitfalls / env / AGENTS than in a skill.',
    ])
  );
}

export function renderPrimingManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/priming/*（启动脚本）') +
      fmtList([
        '目录约定：个人脚本放在 `.minds/priming/individual/<member-id>/<slug>.md`；团队共享脚本放在 `.minds/priming/team_shared/<slug>.md`。',
        '脚本语义（按当前实现）：创建对话时，frontmatter 里的 `reminders` 会先恢复为该对话的提醒状态；随后脚本 records 会被追加进持久化事件流，并尽可能回放成真正的对话历史消息。它不是 system prompt，也不是只读日志，而是可编辑的“起手历史/行为引导层”。',
        '推荐格式：`frontmatter + record 块`。每个 `### record <type>` 对应一个持久化事件（去掉 `ts`），可忠实复原 tool 记录与 call-id 等技术细节。',
        '口吻规则取决于 record 类型，而不是统一写成一种旁白：`human_text_record` 会变成 `role=user` 的 prompting message，应写成“用户/诉请者正在对这个智能体说的话”；`agent_words_record` 会变成 `role=assistant` 的可见回复，应写成“这个智能体已经说出口的话”；`agent_thought_record` 会变成 thinking message，只适合非常克制地承载内部推理痕迹，不适合拿来写通用制度说明。',
        '`func_call_record` / `func_result_record` / tellask 相关 records 属于技术回放层：如果要保留，就应写真实调用名、参数、结果与关联 id，而不是随手写一段 prose 摘要来冒充工具历史。',
        '`ui_only_markdown_record` 以及若干运行时技术 record 会被持久化，但不会转成喂给模型的 chat message；不要指望这类 record 去直接塑造模型行为。',
        '严格约束：不支持 `### user` / `### assistant` 旧写法。',
        '`func_call_record` 使用三反引号 `json`；其余 record 建议使用 6 重反引号 markdown block（避免与正文三反引号冲突）。',
        '建议在 frontmatter 里维护 `title`、`applicableMemberIds` 等元数据；`team_shared` 脚本可用 `applicableMemberIds` 控制适用成员。',
        'frontmatter.reminders 的写法也要遵循 reminder 语义：内容应短小、像工作集提示，不要塞成长文手册；若省略 `scope`，当前实现默认是 `dialog`；只有明确希望后续对话也继续可见时，才使用 `personal` 或 `agent_shared`。',
        '维护原则：允许任意编辑/重写脚本内容，包括新增或改写 assistant 消息，以引导期望行为（而不是拘泥于历史实录）。',
        '每次修改 `.minds/priming/**` 后，建议运行 `team_mgmt_validate_priming_scripts({})` 做格式/路径校验。',
        'WebUI 支持把“当前 course 历史”直接导出为个人启动脚本；导出后应由团队管理者审阅并按团队规范再编辑。',
        '结构层级约束：priming 文件的外层结构以“顶层 frontmatter + 多个 `### record <type>` 块”为准；不要再包一层 `# 启动脚本` / `## 历史` 之类的装饰性章节。真正喂给模型的文本结构，应写在各个 record 自己的 markdown/json block 里。',
        'slug 规范：使用 `[A-Za-z0-9._-]` 路径段，可多级；严禁 `..`、绝对路径或非法字符。',
      ]) +
      fmtCodeBlock('markdown', [
        '---',
        'kind: agent_priming_script',
        'version: 3',
        'title: 代码评审启动',
        'applicableMemberIds:',
        '  - coder',
        '---',
        '',
        '### record human_text_record',
        '``````markdown',
        '---',
        'genseq: 1',
        'msgId: priming-1',
        'grammar: markdown',
        '---',
        '先梳理变更面，再给出最小验证计划。',
        '``````',
        '',
        '### record func_call_record',
        '```json',
        '{',
        '  "type": "func_call_record",',
        '  "genseq": 1,',
        '  "id": "call-1",',
        '  "name": "exec_command",',
        '  "arguments": { "cmd": "git status --short" }',
        '}',
        '```',
      ])
    );
  }

  return (
    fmtHeader('.minds/priming/* (startup scripts)') +
    fmtList([
      'Directory convention: individual scripts live at `.minds/priming/individual/<member-id>/<slug>.md`; team-shared scripts live at `.minds/priming/team_shared/<slug>.md`.',
      'Script semantics (current implementation): at dialog creation, frontmatter `reminders` are restored into dialog reminder state first; then records are appended to the persisted event stream and replayed into dialog history when possible. A priming script is not system prompt text and not a read-only log; it is an editable “startup history / behavior-guidance” asset.',
      'Recommended format: `frontmatter + record blocks`. Each `### record <type>` maps to one persisted event (without `ts`) for faithful replay, including tool records and call-id links.',
      'Tone depends on record type, not on one narrator voice: `human_text_record` becomes a `role=user` prompting message, so write it as what the user is saying to the agent; `agent_words_record` becomes a visible `role=assistant` reply, so write it as words the agent has already said; `agent_thought_record` becomes a thinking message and should be used sparingly, not as a place for general policy prose.',
      '`func_call_record` / `func_result_record` / tellask-related records are technical replay artifacts. Keep real call names, arguments, results, and linked ids if you include them; do not replace them with loose prose summaries.',
      '`ui_only_markdown_record` and several runtime-only technical records persist on disk but do not become chat messages for model context. Do not rely on those record types to steer the model directly.',
      'Strict rule: legacy `### user` / `### assistant` sections are not supported.',
      '`func_call_record` uses triple-backtick `json`; other records should use six-backtick markdown blocks to avoid nested-fence collisions.',
      'Use frontmatter for metadata like `title` and `applicableMemberIds`; for `team_shared`, `applicableMemberIds` narrows applicability.',
      'frontmatter.reminders should follow reminder semantics too: keep them short like working-set prompts rather than mini-manuals. If `scope` is omitted, the current implementation defaults it to `dialog`; use `personal` / `agent_shared` only when you intentionally want later dialogs to keep seeing the reminder.',
      'Maintenance principle: freely edit or fully rewrite scripts, including assistant messages, to shape expected behavior.',
      'After each edit under `.minds/priming/**`, run `team_mgmt_validate_priming_scripts({})` for format/path validation.',
      'WebUI can export current-course history into an individual startup script; team managers should review and refine exported scripts.',
      'Structure rule: the outer file structure is “top-level frontmatter + repeated `### record <type>` blocks”. Do not wrap the script in decorative `# Startup Script` / `## History` headings. The model-facing structure belongs inside each record’s own markdown/json block.',
      'Slug rule: use `[A-Za-z0-9._-]` path segments (nested allowed); reject `..`, absolute paths, and illegal characters.',
    ]) +
    fmtCodeBlock('markdown', [
      '---',
      'kind: agent_priming_script',
      'version: 3',
      'title: Code Review Startup',
      'applicableMemberIds:',
      '  - coder',
      '---',
      '',
      '### record human_text_record',
      '``````markdown',
      '---',
      'genseq: 1',
      'msgId: priming-1',
      'grammar: markdown',
      '---',
      'First map the change surface, then provide a minimum validation plan.',
      '``````',
      '',
      '### record func_call_record',
      '```json',
      '{',
      '  "type": "func_call_record",',
      '  "genseq": 1,',
      '  "id": "call-1",',
      '  "name": "exec_command",',
      '  "arguments": { "cmd": "git status --short" }',
      '}',
      '```',
    ])
  );
}

export function renderEnvManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/env.*.md（运行环境提示）') +
      fmtList([
        '用途：为“当前 rtws 的运行环境”提供一段稳定的介绍文案。Dominds 会将其注入到 agent 的 system prompt 的 `## 运行环境` 章节，注入位置在“团队目录（Team Directory）”之前。',
        '文件位置：写在当前 rtws 的 `.minds/` 下；切换 rtws（例如 `-C ux-rtws`）时，应在对应 rtws 的 `.minds/` 下分别维护。',
        '推荐文件名：`env.zh.md`（中文语义基准）与 `env.en.md`（英文对齐）。',
        '回退规则：优先按工作语言读取 `env.<lang>.md`；如不存在，可回退到 `env.md`（以当前实现为准）。空文件/仅空白会被当作“无提示”。',
        '口吻建议：它虽然进入 system prompt，但职责不是定义人设，而是给当前成员做环境定向。最合适的是简洁、可核实的事实说明，可用中性 bullet，也可用“你当前处于……”这类第二人称 briefing；核心是让成员快速知道自己身处哪个 rtws、有哪些关键路径/入口/端口/约束。',
        '标题层级约束：系统模板已经提供 `## 运行环境` 标题，所以 `env.*.md` 正文通常应从 `###` 小节或普通 bullet 开始；不要再写一层 `# 环境说明` / `## 本 rtws ...` 来重复模板标题。',
        '边界提醒：不要把 `env.*.md` 写成 persona、skill、工具手册或仓库总规范大杂烩；不要在这里重复团队职责边界、长篇流程制度，或凭空编造环境事实。',
        'i18n 约定：`zh` 为语义基准。不要把 `zh` 通过翻译 `en` 来更新；应让 `en` 追随 `zh` 的语义。',
        '管理者提醒：若发现缺失/质量不佳/与实际环境不符，应与人类用户讨论并确认措辞，然后再写入/更新对应的 `env.*.md`（避免“凭空编造”的环境描述）。',
      ]) +
      fmtCodeBlock('text', [
        '示例（片段；请按你的 rtws 真实环境改写）',
        '### 当前 rtws 概况',
        '- 本 rtws 用于 Dominds 自我开发与联调。',
        '- Dominds 程序来源：本机全局 link 的 `dominds`，由 `./dominds/` 构建产物提供。',
        '- WebUI dev/UX：`./dev-server.sh` 使用 `ux-rtws/` 作为 rtws（避免污染根 rtws）。',
      ])
    );
  }
  return (
    fmtHeader('.minds/env.*.md (runtime environment intro)') +
    fmtList([
      'Purpose: provide a stable intro note describing the “current rtws runtime environment”. Dominds injects it into the `## Runtime Environment` section of the agent system prompt, positioned before “Team Directory”.',
      'Location: place it under the current rtws `.minds/`. If you switch rtws (e.g. `-C ux-rtws`), maintain a separate `env.*.md` under that rtws’s `.minds/`.',
      'Recommended filenames: `env.zh.md` (canonical semantics) and `env.en.md` (English aligned to zh).',
      'Fallback behavior: prefer `env.<lang>.md` by working language; if missing, it may fall back to `env.md` (per current implementation). Empty/whitespace-only content is treated as “no intro”.',
      'Tone guidance: although it enters system prompt, its job is environmental orientation rather than persona definition. Prefer concise, verifiable facts in neutral bullets or a brief second-person orientation like “you are currently in...”; the goal is to help the member quickly understand the active rtws, key paths, entrypoints, ports, and constraints.',
      'Heading rule: the system template already provides the `## Runtime Environment` heading, so `env.*.md` bodies should usually start at `###` subsections or plain bullets rather than another `# Environment Notes` / `## This rtws ...` wrapper.',
      'Boundary reminder: do not turn `env.*.md` into a persona file, skill, tool manual, or giant repo-policy dump. Avoid duplicating role rules, long procedures, or speculative environment claims.',
      'i18n rule: `zh` is canonical. Do not update `zh` by translating from `en`; update `en` to match `zh` semantics.',
      'Manager reminder: if the file is missing / inaccurate / low quality, discuss wording with the human user and then write/update `env.*.md` (avoid fabricating environment details).',
    ]) +
    fmtCodeBlock('text', [
      'Example (snippet; tailor to your real rtws)',
      '### Current rtws overview',
      '- This rtws is used for Dominds self-development and integration.',
      '- Program source: a globally linked `dominds` built from `./dominds/`.',
      '- WebUI dev/UX: `./dev-server.sh` uses `ux-rtws/` as rtws (keeps root rtws clean).',
    ])
  );
}

export function renderTroubleshooting(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('排障（症状 → 原因 → 解决步骤）') +
      fmtList([
        '改 provider/model 前总是先做：先用 `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })` 确认 key 是否存在，再运行 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true })` 做可用性检查（env + 可选 live）。',
        '症状：提示“缺少 provider/model” → 原因：`member_defaults` 或成员覆盖缺失 → 步骤：检查 `.minds/team.yaml` 的 `member_defaults.provider/model`（以及 `members.<id>.provider/model` 是否写错）。',
        '症状：提示“Provider not found” → 原因：provider key 未定义/拼写错误/未按预期合并 defaults → 步骤：检查 `.minds/llm.yaml` 的 provider keys，并确认 `.minds/team.yaml` 引用的 key 存在。',
        '症状：提示“Model not found” → 原因：model key 未定义/拼写错误/不在该 provider 下 → 步骤：用 `team_mgmt_list_models({ provider_pattern: \"<providerKey>\", model_pattern: \"*\" })` 查已有模型 key，再修正 `.minds/team.yaml` 引用或补全 `.minds/llm.yaml`。',
        '症状：提示“permission denied / forbidden / not allowed” → 原因：权限规则（目录或扩展名）命中 deny-list 或未被 allow-list 覆盖 → 步骤：用 `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })` 复核规则，并检查该成员的 `*_dirs/no_*_dirs/*_file_ext_names/no_*_file_ext_names` 配置。',
        '症状：`team.yaml` 里引用的 app toolset 缺失 / app 相关能力失效 → 原因：enabled app 未正确安装/启用、apps-host 启动失败，或 app 自身 host 模块/运行时损坏 → 步骤：`team_mgmt_validate_team_cfg({})` 仍然可用；先用它确认具体缺失项，再检查 `.minds/app.yaml`、已启用 apps 解析结果与相关 app 安装路径；必要时让持有 team_mgmt 的团队管理智能体继续用 `team_mgmt_read_file` / `team_mgmt_ripgrep_*` / `man({ "toolsetId": "team_mgmt", "topics": ["toolsets","troubleshooting"] })` 排查。',
        '症状：MCP 不生效 → 原因：mcp 配置错误/服务不可用/被禁用/租用未释放 → 步骤：先运行 `team_mgmt_validate_mcp_cfg({})` 汇总错误。注意：该校验既可能报告永久配置问题，也可能报告“当前服务不可达/未加载”这类暂态问题；若只是 server 临时不可连，服务恢复后重跑通常即可正常。必要时用 `mcp_restart` 启用/重启；要停用时用 `mcp_disable`；只在当前对话确实持有不再需要的 lease 时用 `mcp_release`。',
      ])
    );
  }
  return (
    fmtHeader('Troubleshooting (symptom → cause → steps)') +
    fmtList([
      'Before changing provider/model: use `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })` to confirm keys exist, then run `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true })` for a readiness check (env + optional live).',
      'Symptom: "Missing provider/model" → Cause: missing `member_defaults` or member overrides → Steps: check `.minds/team.yaml` `member_defaults.provider/model` (and `members.<id>.provider/model`).',
      'Symptom: "Provider not found" → Cause: provider key not defined / typo / unexpected merge with defaults → Steps: check `.minds/llm.yaml` provider keys and ensure `.minds/team.yaml` references an existing key.',
      'Symptom: "Model not found" → Cause: model key not defined / typo / not under that provider → Steps: run `team_mgmt_list_models({ provider_pattern: \"<providerKey>\", model_pattern: \"*\" })` and fix `.minds/team.yaml` references or update `.minds/llm.yaml`.',
      'Symptom: "permission denied / forbidden / not allowed" → Cause: permission rules (directory or extension) hit deny-list or are not covered by allow-list → Steps: review `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })` and the member `*_dirs/no_*_dirs/*_file_ext_names/no_*_file_ext_names` config.',
      'Symptom: an app-provided toolset referenced from `team.yaml` is missing / app capability is unavailable → Cause: enabled app not installed/enabled correctly, apps-host startup failure, or a broken app host module/runtime → Steps: `team_mgmt_validate_team_cfg({})` remains available; use it first to identify the missing binding, then inspect `.minds/app.yaml`, enabled-app resolution, and the app install path. The team manager should continue with `team_mgmt_read_file`, `team_mgmt_ripgrep_*`, and `man({ "toolsetId": "team_mgmt", "topics": ["toolsets","troubleshooting"] })`.',
      'Symptom: MCP not working → Cause: bad config / server down / disabled server / leasing issues → Steps: run `team_mgmt_validate_mcp_cfg({})` first. Note: the validator may report both permanent config errors and transient runtime-availability issues; if the server is merely down/unreachable for now, rerunning after recovery will often clear the problem. Then use `mcp_restart` to enable/restart if needed; use `mcp_disable` to disable; call `mcp_release` only when the current dialog actually holds a lease it no longer needs.',
    ])
  );
}

function isLikelyAppToolsetBindingProblem(problem: WorkspaceProblem): boolean {
  if (problem.kind !== 'team_workspace_config_error') return false;
  if (!problem.id.includes('/toolsets/')) return false;
  return (
    problem.detail.errorText.includes('enabled app') ||
    problem.detail.errorText.includes('enabled apps') ||
    problem.detail.errorText.includes('inspect / refresh enabled apps') ||
    problem.detail.errorText.includes('inspect the app install path') ||
    problem.detail.errorText.includes('app is installed/enabled')
  );
}

export async function renderModelParamsManual(language: LanguageCode): Promise<string> {
  const header =
    language === 'zh'
      ? fmtHeader('model_params（成员模型参数）')
      : fmtHeader('model_params (member model parameters)');
  const summary = await loadBuiltinLlmModelParamOptionsText();

  if (language === 'zh') {
    return (
      header +
      fmtList([
        '`model_params` 写在 `.minds/team.yaml` 的 `member_defaults` 或 `members.<id>` 下，用来控制采样/推理/输出风格。',
        '`model_params` 是运行时参数；`model_param_options`（在 `.minds/llm.yaml` 或内置 defaults 中）是文档/说明用途，用来描述可用参数范围（不保证强制校验）。',
        '想查看某个 provider 的“有效配置” `model_param_options`：优先用 `team_mgmt_list_models({ source: \"effective\", provider_pattern: \"<providerKey>\", model_pattern: \"*\", include_param_options: true })`（会把 general + provider 专有参数一起列出）。',
        '常见参数示例（不同 provider 支持不同）：例如 `reasoning_effort`、`verbosity`、`temperature`、`max_tokens` 等。对内置 `codex` provider，这些参数应写在 `model_params.codex.*` 下。',
        '常见坑：不要把 `reasoning_effort` / `verbosity` 直接写在 `member_defaults` 或 `members.<id>` 根上（会被忽略，并会被 team.yaml 校验提示）；应写在 `model_params.codex.*` 下。',
        '`model_param_options.<ns>.<param>.prominent: true`：表示“初始化/团队管理时应显式讨论并选定”的参数。不要依赖 provider/model 的隐含默认值。',
        '`model_param_options.<ns>.<param>.default`：为该参数提供建议默认值；`/setup` 会将其作为预选值展示（仍建议与用户确认是否需要调整）。',
        '最低要求：当 `member_defaults.provider` 选中某 provider 时，至少确保其 prominent=true 的参数在 `member_defaults.model_params.<ns>.*` 下都有明确取值；再进一步讨论是否需要对不同成员（`members.<id>.model_params...`）做差异化。',
        '风险提示：部分参数可能影响成本/延迟/输出稳定性（例如 temperature、max tokens 等）。参数是否透传/是否会被校验或裁剪，以当前实现为准。',
      ]) +
      '\n' +
      '示例：\n' +
      '```yaml\n' +
      'member_defaults:\n' +
      '  provider: codex\n' +
      '  model: gpt-5.2\n' +
      '  model_params:\n' +
      '    codex:\n' +
      '      reasoning_effort: high\n' +
      '      verbosity: low\n' +
      '      temperature: 0\n' +
      '```\n' +
      '\n' +
      '内置 provider 的 `model_param_options` 摘要（来自 `dominds/main/llm/defaults.yaml`）：\n' +
      summary +
      '\n'
    );
  }

  return (
    header +
    fmtList([
      '`model_params` lives in `.minds/team.yaml` under `member_defaults` or `members.<id>` to control sampling/reasoning/output style.',
      '`model_params` is runtime config; `model_param_options` (in `.minds/llm.yaml` or built-in defaults) is documentation-only to describe supported knobs (not guaranteed to be strictly validated).',
      'To inspect a provider’s effective `model_param_options`, prefer `team_mgmt_list_models({ source: \"effective\", provider_pattern: \"<providerKey>\", model_pattern: \"*\", include_param_options: true })` (lists both general and provider-specific options).',
      'Common examples (provider-dependent): e.g. `reasoning_effort`, `verbosity`, `temperature`, `max_tokens`, etc. For the built-in `codex` provider, these go under `model_params.codex.*`.',
      'Common pitfall: do not put `reasoning_effort` / `verbosity` directly under `member_defaults` or `members.<id>` (they are ignored and will be flagged by team.yaml validation); put them under `model_params.codex.*`.',
      '`model_param_options.<ns>.<param>.prominent: true` means “discuss and pick explicitly during bootstrap/team management”. Do not rely on implicit provider/model defaults.',
      '`model_param_options.<ns>.<param>.default` provides a recommended default; `/setup` may preselect it (still discuss with the user if it needs to change).',
      'Minimum: when `member_defaults.provider` selects a provider, ensure all `prominent: true` params are explicitly set under `member_defaults.model_params.<ns>.*`. Then decide if you need per-member overrides (`members.<id>.model_params...`).',
      'Risk note: some knobs may affect cost/latency/output stability (e.g. temperature, max tokens). Whether params are passed through / validated / clamped follows current implementation.',
    ]) +
    '\n' +
    'Example:\n' +
    '```yaml\n' +
    'member_defaults:\n' +
    '  provider: codex\n' +
    '  model: gpt-5.2\n' +
    '  model_params:\n' +
    '    codex:\n' +
    '      reasoning_effort: high\n' +
    '      verbosity: low\n' +
    '      temperature: 0\n' +
    '```\n' +
    '\n' +
    'Built-in provider `model_param_options` summary (from `dominds/main/llm/defaults.yaml`):\n' +
    summary +
    '\n'
  );
}

function renderToolsetCapabilitySummary(
  language: LanguageCode,
  ids: ReadonlyArray<string>,
  toolsetsById: Record<string, Tool[]>,
): string {
  const header =
    language === 'zh' ? fmtSubHeader('工具集能力摘要') : fmtSubHeader('Toolset Capability Summary');
  const lines: string[] = [];

  for (const id of ids) {
    const tools = toolsetsById[id] ?? [];
    const meta = getToolsetMeta(id);
    const source = meta?.source ?? 'dominds';
    const desc = language === 'zh' ? meta?.descriptionI18n?.zh : meta?.descriptionI18n?.en;
    const fallbackDesc =
      source === 'mcp'
        ? language === 'zh'
          ? 'MCP server 映射工具集（能力取决于 server 实际暴露）'
          : 'MCP server-mapped toolset (capabilities depend on exposed server tools)'
        : source === 'app'
          ? language === 'zh'
            ? 'App 工具集（由已安装的 Dominds App 提供）'
            : 'App toolset (provided by an installed Dominds App)'
          : language === 'zh'
            ? '内建工具集（暂无描述）'
            : 'Built-in toolset (no description)';
    const descText = desc && desc.trim() !== '' ? desc : fallbackDesc;
    const previewNames = tools.slice(0, 6).map((t) => `\`${t.name}\``);
    const preview =
      previewNames.length > 0
        ? `${previewNames.join(', ')}${tools.length > previewNames.length ? ', ...' : ''}`
        : language === 'zh'
          ? '无工具'
          : 'no tools';

    if (language === 'zh') {
      const label = source === 'mcp' ? 'MCP' : source === 'app' ? 'App' : '内建';
      lines.push(`\`${id}\`（${label}）：${descText}；tools=${tools.length}（${preview}）`);
    } else {
      const label = source === 'mcp' ? 'MCP' : source === 'app' ? 'App' : 'built-in';
      lines.push(`\`${id}\` (${label}): ${descText}; tools=${tools.length} (${preview})`);
    }
  }

  return header + fmtList(lines);
}

export async function renderToolsets(language: LanguageCode): Promise<string> {
  const windowsHost = isWindowsRuntimeHost();
  const toolsetsById = listToolsets();
  const ids = Object.keys(toolsetsById).filter((id) => id !== 'control');
  const header =
    language === 'zh' ? fmtHeader('已注册 toolsets') : fmtHeader('Registered toolsets');

  const intro =
    language === 'zh'
      ? fmtList([
          '`control`：对话控制类工具属于“内建必备能力”，运行时会自动包含给所有成员；因此不需要（也不建议）在 `members.<id>.toolsets` 里显式列出，本页也默认不展示它。',
          '`diag`：诊断类工具集不应默认授予任何成员；仅当用户明确要求“诊断/排查/验证解析/流式分段”等能力时才添加。',
          '多数情况下推荐用 `members.<id>.toolsets` 做粗粒度授权；`members.<id>.tools` 更适合做少量补充/收敛。',
          windowsHost
            ? '按 provider 选择匹配的 toolsets：默认把 `ws_read` / `ws_mod` 作为通用基线；在 Windows 环境下不要配置 `codex_inspect_and_patch_tools`。如果还需要“读/探测 rtws”，通常再给 `os`（`shell_cmd`）并严格限制在少数专员成员手里。'
            : '按模型/工作形态选择匹配的 toolsets：默认把 `ws_read` / `ws_mod` 作为通用基线；当目标模型属于 `gpt-5.x` 家族时，在基线上追加 `codex_inspect_and_patch_tools`（`apply_patch`、`readonly_shell`），不是替换 `ws_read` / `ws_mod`。如果还需要“读/探测 rtws”，通常要再给 `os`（`shell_cmd`）并严格限制在少数专员成员手里。',
          'MCP toolset 不是静态写死：它由 `.minds/mcp.yaml` 的 `servers.<serverId>` 动态映射而来（toolset 名称 = `serverId`）。下方会展示当前映射快照。',
          '`os` 是 shell 工具集，当前包含 `shell_cmd` / `stop_daemon` / `get_daemon_output`。一旦成员拥有这些工具（包括通过 `os` 获得），其 id 必须出现在顶层 `shell_specialists`。',
          '`mcp_admin` 用于 MCP 运维：`mcp_restart` 启用/重启 server，`mcp_disable` 禁用 server 并保留 0 工具 toolset/手册可见性，`mcp_release` 只释放当前对话 lease；并配有 `env_get` / `env_set` / `env_unset` 便于联调环境变量。',
          '授予 `team_mgmt` 不只是“给工具权限”：一旦某成员承担团队管理职责，其 `persona.*.md` 也必须明确要求在执行团队管理操作前先查看 `man({ "toolsetId": "team_mgmt" })` 相关章节，并按手册标准做法维护 `.minds/**` 团队心智资产。',
          '最佳实践：把 `os`（尤其 `shell_cmd`）只授予具备良好纪律/风控意识的人设成员（例如 “cmdr/ops”），并同步维护 `shell_specialists`。对不具备 shell 工具的成员，系统提示会明确要求其将 shell 执行委派给这类专员，并提供可审查的命令提案与理由。',
          '常见三种模式（示例写在 `.minds/team.yaml` 的 `members.<id>.toolsets` 下）：',
        ])
      : fmtList([
          '`control`: dialog-control tools are intrinsic and automatically included for all members at runtime; you do not need (and should not) list it under `members.<id>.toolsets`. It is omitted from the list below.',
          '`diag`: diagnostics tools should not be granted by default; only add it when the user explicitly asks for diagnostics/troubleshooting/streaming-parse verification.',
          'Typically use `members.<id>.toolsets` for coarse-grained access; use `members.<id>.tools` for a small number of additions/limits.',
          windowsHost
            ? 'Pick toolsets to match the provider: keep `ws_read` / `ws_mod` as the general baseline; on Windows, do not configure `codex_inspect_and_patch_tools`. If you also need to read/probe the rtws, grant `os` (`shell_cmd`) only to a small specialist operator set.'
            : 'Pick toolsets to match the model/work style: keep `ws_read` / `ws_mod` as the general baseline; for models in the `gpt-5.x` family, add `codex_inspect_and_patch_tools` (`apply_patch`, `readonly_shell`) on top rather than replacing `ws_read` / `ws_mod`. If you also need to read/probe the rtws, you typically must grant `os` (`shell_cmd`) and keep it restricted to a small number of specialist operators.',
          'MCP toolsets are not hardcoded: they are dynamically mapped from `.minds/mcp.yaml` `servers.<serverId>` (toolset name = `serverId`). The current mapping snapshot is shown below.',
          '`os` is the shell toolset, currently including `shell_cmd`, `stop_daemon`, and `get_daemon_output`. If a member has any of these tools (including via `os`), that member id must appear in top-level `shell_specialists`.',
          '`mcp_admin` is for MCP operations: `mcp_restart` enables/restarts a server, `mcp_disable` disables a server while keeping its zero-tool toolset/manual visible, and `mcp_release` only releases the current dialog lease; `env_get` / `env_set` / `env_unset` are available for environment debugging.',
          'Granting `team_mgmt` is not just a tool-access change: once a member carries team-management responsibility, that member’s `persona.*.md` must explicitly require reading the relevant `man({ "toolsetId": "team_mgmt" })` chapters before any team-management action, and maintaining `.minds/**` team mind assets by handbook-standard workflow.',
          'Best practice: grant `os` (especially `shell_cmd`) only to a disciplined, risk-aware operator persona (e.g. “cmdr/ops”), and keep `shell_specialists` in sync. For members without shell tools, the system prompt explicitly tells them to delegate shell execution to such a specialist, with a reviewable command proposal and justification.',
          'Three common patterns (in `.minds/team.yaml` under `members.<id>.toolsets`):',
        ]);

  const patterns = fmtCodeBlock('yaml', [
    '# Recommended: explicit allow-list (most common)',
    'toolsets:',
    '  - ws_read',
    '  - ws_mod',
    ...(windowsHost ? [] : ['  - codex_inspect_and_patch_tools']),
    '',
    '# Team manager (explicit, minimal)',
    'toolsets:',
    '  - team_mgmt',
    '',
    '# Operator / DevOps (explicit; higher risk)',
    'toolsets:',
    '  - ws_read',
    '  - ws_mod',
    '  - os',
    '  - mcp_admin',
  ]);

  const ripgrepGuide =
    language === 'zh'
      ? fmtSubHeader('ripgrep 依赖（检测与安装）') +
        fmtList([
          '`ws_read` / `ws_mod` / `team_mgmt_ripgrep_*` 依赖系统可执行 `rg`（ripgrep）。',
          '检测：在终端运行 `rg --version`（返回版本即表示可用）。',
          '安装后请重开终端，再运行 `rg --version` 复核 PATH。',
        ]) +
        fmtCodeBlock('powershell', [
          '# Windows (任选其一)',
          'winget install BurntSushi.ripgrep.MSVC',
          'choco install ripgrep',
          'scoop install ripgrep',
          '',
          '# 检测',
          'rg --version',
        ]) +
        fmtCodeBlock('bash', [
          '# macOS',
          'brew install ripgrep',
          '',
          '# Ubuntu / Debian',
          'sudo apt-get update && sudo apt-get install -y ripgrep',
          '',
          '# Fedora',
          'sudo dnf install -y ripgrep',
          '',
          '# 检测',
          'rg --version',
        ])
      : fmtSubHeader('ripgrep Dependency (Detection & Install)') +
        fmtList([
          '`ws_read` / `ws_mod` / `team_mgmt_ripgrep_*` require system `rg` (ripgrep).',
          'Detect: run `rg --version` in terminal (version output means available).',
          'After install, restart the terminal and re-run `rg --version` to verify PATH.',
        ]) +
        fmtCodeBlock('powershell', [
          '# Windows (pick one)',
          'winget install BurntSushi.ripgrep.MSVC',
          'choco install ripgrep',
          'scoop install ripgrep',
          '',
          '# Detect',
          'rg --version',
        ]) +
        fmtCodeBlock('bash', [
          '# macOS',
          'brew install ripgrep',
          '',
          '# Ubuntu / Debian',
          'sudo apt-get update && sudo apt-get install -y ripgrep',
          '',
          '# Fedora',
          'sudo dnf install -y ripgrep',
          '',
          '# Detect',
          'rg --version',
        ]);

  const list = fmtList(ids.map((id) => `\`${id}\``));
  const capabilitySummary = renderToolsetCapabilitySummary(language, ids, toolsetsById);
  const mcpSnapshot = await readMcpToolsetMappingSnapshot();
  const mcpMapping = renderMcpToolsetMappingSection(language, mcpSnapshot);
  const mcpSetup = renderMcpToolsetSetupGuideSection(language, mcpSnapshot);
  const mcpManualDetails = renderMcpToolsetManualDetailsSection(language, mcpSnapshot);
  return (
    header +
    intro +
    patterns +
    ripgrepGuide +
    '\n' +
    list +
    capabilitySummary +
    mcpMapping +
    mcpSetup +
    mcpManualDetails
  );
}

export async function renderBuiltinDefaults(language: LanguageCode): Promise<string> {
  const header =
    language === 'zh'
      ? fmtHeader('内置 LLM Defaults（摘要）')
      : fmtHeader('Built-in LLM Defaults (summary)');
  const body = await loadBuiltinLlmDefaultsText();

  const explain =
    language === 'zh'
      ? fmtList([
          '这份列表来自 Dominds 内置的 LLM defaults（实现内置）。当你没有在 `.minds/llm.yaml` 里显式覆盖某些 provider/model key 时，这些 defaults 可能会生效（以当前实现的合并规则为准）。',
          '在 `.minds/llm.yaml` 里新增/覆盖 provider key，通常只会影响同名 key 的解析，不表示“禁用其他内置 provider”。建议用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true })` 验证配置。',
        ])
      : fmtList([
          'This list comes from Dominds built-in LLM defaults (implementation-provided). If you do not explicitly override certain provider/model keys in `.minds/llm.yaml`, these defaults may be used (per current merge rules).',
          'Adding/overriding a provider key in `.minds/llm.yaml` typically affects that key only; it does not imply disabling other built-in providers. Use `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true })` to verify.',
        ]);

  return header + explain + '\n' + body + '\n';
}

export const teamMgmtValidatePrimingScriptsTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_validate_priming_scripts',
  description: `Validate startup scripts under ${MINDS_DIR}/priming/.`,
  descriptionI18n: {
    en: `Validate startup scripts under ${MINDS_DIR}/priming/.`,
    zh: `校验 ${MINDS_DIR}/priming/ 下的启动脚本格式与路径约束。`,
  },
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  argsValidation: 'dominds',
  async call(dlg, _caller, _args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const minds = await getMindsDirState();
      if (minds.kind === 'missing') {
        const msg =
          formatMindsMissingNotice(language) +
          (language === 'zh'
            ? `\n\n当前无法校验 \`${MINDS_DIR}/priming/\`。`
            : `\n\nCannot validate \`${MINDS_DIR}/priming/\` yet.`);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (minds.kind === 'not_directory') {
        const msg =
          language === 'zh'
            ? `错误：\`${MINDS_DIR}/\` 存在但不是目录：\`${minds.abs}\``
            : `Error: \`${MINDS_DIR}/\` exists but is not a directory: \`${minds.abs}\``;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const result = await validateAllPrimingScriptsInRtws();
      if (result.checked === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('启动脚本校验') +
              fmtList([`\`${MINDS_DIR}/priming/\` 下未发现脚本文件，无需校验。`])
            : fmtHeader('Startup Script Validation') +
              fmtList([
                `No script files found under \`${MINDS_DIR}/priming/\`; nothing to validate.`,
              ]);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      if (result.failed === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('启动脚本校验通过') +
              fmtList([
                `已检查 ${result.checked} 个脚本：✅ 全部通过`,
                `建议：每次修改 \`${MINDS_DIR}/priming/**\` 后运行本工具。`,
              ])
            : fmtHeader('Startup Script Validation Passed') +
              fmtList([
                `Checked ${result.checked} script(s): ✅ all passed`,
                `Recommendation: run this tool after each change under \`${MINDS_DIR}/priming/**\`.`,
              ]);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const lines: string[] = [];
      for (const issue of result.issues) {
        lines.push(`- ${issue.path}: ${issue.error}`);
      }
      const msg =
        language === 'zh'
          ? fmtHeader('启动脚本校验失败') +
            fmtList([
              `已检查 ${result.checked} 个脚本：❌ ${result.failed} 个失败`,
              '请逐项修复以下错误后再继续。',
            ]) +
            '\n' +
            lines.join('\n')
          : fmtHeader('Startup Script Validation Failed') +
            fmtList([
              `Checked ${result.checked} script(s): ❌ ${result.failed} failed`,
              'Fix the following issues before proceeding.',
            ]) +
            '\n' +
            lines.join('\n');
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `校验失败：${err instanceof Error ? err.message : String(err)}`
          : `Validation failed: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtValidateTeamCfgTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_validate_team_cfg',
  description: `Validate ${TEAM_YAML_REL} and surface issues to the WebUI Problems panel.`,
  descriptionI18n: {
    en: `Validate ${TEAM_YAML_REL} and surface issues to the WebUI Problems panel.`,
    zh: `校验 ${TEAM_YAML_REL}，并将问题上报到 WebUI 的 Problems 面板。`,
  },
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  argsValidation: 'dominds',
  async call(dlg, _caller, _args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const minds = await getMindsDirState();
      if (minds.kind === 'missing') {
        const msg =
          formatMindsMissingNotice(language) +
          (language === 'zh'
            ? `\n\n当前无法校验 \`${TEAM_YAML_REL}\`。`
            : `\n\nCannot validate \`${TEAM_YAML_REL}\` yet.`);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }
      if (minds.kind === 'not_directory') {
        const msg =
          language === 'zh'
            ? `错误：\`${MINDS_DIR}/\` 存在但不是目录：\`${minds.abs}\``
            : `Error: \`${MINDS_DIR}/\` exists but is not a directory: \`${minds.abs}\``;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const cwd = path.resolve(process.cwd());
      const teamYamlAbs = path.resolve(cwd, TEAM_YAML_REL);
      try {
        const st = await fs.stat(teamYamlAbs);
        if (!st.isFile()) {
          const msg =
            language === 'zh'
              ? `错误：\`${TEAM_YAML_REL}\` 存在但不是文件。`
              : `Error: \`${TEAM_YAML_REL}\` exists but is not a file.`;
          return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
      } catch (err: unknown) {
        if (isFsErrWithCode(err) && err.code === 'ENOENT') {
          const msg =
            language === 'zh'
              ? `未发现 \`${TEAM_YAML_REL}\`，无需校验。`
              : `\`${TEAM_YAML_REL}\` not found; nothing to validate.`;
          return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
        throw err;
      }

      // Team.load() keeps returning a Team object and publishes team.yaml issues to the Problems
      // panel, but strict member errors can still omit specific members.
      await Team.load();

      // Non-blocking style lint (keeps team.yaml readable).
      await lintTeamYamlStyleProblems();

      const snapshot = getProblemsSnapshot();
      const teamProblems = listTeamYamlProblems(snapshot.problems);
      const { active: activeTeamProblems, resolved: resolvedTeamProblems } =
        splitProblemsByLifecycle(teamProblems);
      const renderedActiveTeamProblems = limitProblemsForRender(activeTeamProblems);
      const renderedResolvedTeamProblems = limitProblemsForRender(resolvedTeamProblems);

      if (activeTeamProblems.length === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('team.yaml 校验通过') +
              fmtList([
                `\`${TEAM_YAML_REL}\`：✅ 未检测到问题`,
                '提示：每次修改 team.yaml 后都应运行本工具，避免“坏成员配置被静默跳过”。',
                resolvedTeamProblems.length > 0
                  ? formatResolvedProblemsHint({
                      language,
                      source: 'team',
                      path: TEAM_YAML_REL,
                    })
                  : '',
              ])
            : fmtHeader('team.yaml Validation Passed') +
              fmtList([
                `\`${TEAM_YAML_REL}\`: ✅ no issues detected`,
                'Tip: run this after every team.yaml change to avoid silent omission of broken members.',
                resolvedTeamProblems.length > 0
                  ? formatResolvedProblemsHint({
                      language,
                      source: 'team',
                      path: TEAM_YAML_REL,
                    })
                  : '',
              ]);
        const resolvedBlock =
          renderedResolvedTeamProblems.shown.length > 0
            ? fmtSubHeader(
                language === 'zh' ? '已解决但未清理的问题' : 'Resolved But Not Yet Cleared',
              ) +
              renderedResolvedTeamProblems.shown
                .flatMap((p) => formatProblemDetailLines(p, language))
                .join('\n') +
              '\n' +
              (renderedResolvedTeamProblems.omitted > 0
                ? formatProblemOmittedNotice(language, renderedResolvedTeamProblems.omitted)
                : '')
            : '';
        const content = msg + resolvedBlock;
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const issueLines = renderedActiveTeamProblems.shown.flatMap((p) =>
        formatProblemDetailLines(p, language),
      );

      const hasAppToolsetBindingProblem = activeTeamProblems.some(isLikelyAppToolsetBindingProblem);
      const followUpLines =
        language === 'zh'
          ? [
              '说明：`team_mgmt_validate_team_cfg({})` / `team_mgmt_validate_mcp_cfg({})` / `man({ "toolsetId": "team_mgmt" })` 等团队管理校验工具应继续可用；不要因为相关 app/toolset 出错就停止排查。',
              hasAppToolsetBindingProblem
                ? '建议排查顺序：1) 先保留并阅读本校验输出；2) 用 `team_mgmt_read_file({ path: "app.yaml" })` 检查 `.minds/app.yaml` 依赖声明；3) 再结合 `man({ "toolsetId": "team_mgmt", "topics": ["toolsets","troubleshooting"] })` 核对该 toolset 是否应来自 enabled app，以及 app 安装/启用/宿主路径是否损坏。'
                : '建议：继续用 `man({ "toolsetId": "team_mgmt", "topics": ["team","toolsets","troubleshooting"] })`、`team_mgmt_read_file`、`team_mgmt_ripgrep_*` 缩小范围，再修复后重新运行本校验工具。',
            ]
          : [
              'Note: team-management validation tools such as `team_mgmt_validate_team_cfg({})`, `team_mgmt_validate_mcp_cfg({})`, and `man({ "toolsetId": "team_mgmt" })` should remain usable; do not stop investigation just because a related app/toolset is failing.',
              hasAppToolsetBindingProblem
                ? 'Suggested triage order: 1) keep and read this validation output; 2) inspect `.minds/app.yaml` via `team_mgmt_read_file({ path: "app.yaml" })`; 3) use `man({ "toolsetId": "team_mgmt", "topics": ["toolsets","troubleshooting"] })` to confirm whether the missing toolset should come from an enabled app, then verify app install/enable state and host path integrity.'
                : 'Suggestion: continue with `man({ "toolsetId": "team_mgmt", "topics": ["team","toolsets","troubleshooting"] })`, `team_mgmt_read_file`, and `team_mgmt_ripgrep_*` to narrow scope, then re-run this validator after fixes.',
            ];
      const resolvedIssueBlock =
        renderedResolvedTeamProblems.shown.length > 0
          ? fmtSubHeader(
              language === 'zh' ? '已解决但未清理的问题' : 'Resolved But Not Yet Cleared',
            ) +
            fmtList([
              formatResolvedProblemsHint({
                language,
                source: 'team',
                path: TEAM_YAML_REL,
              }),
            ]) +
            renderedResolvedTeamProblems.shown
              .flatMap((p) => formatProblemDetailLines(p, language))
              .join('\n') +
            '\n' +
            (renderedResolvedTeamProblems.omitted > 0
              ? formatProblemOmittedNotice(language, renderedResolvedTeamProblems.omitted)
              : '')
          : '';

      const msg =
        language === 'zh'
          ? fmtHeader('team.yaml 校验失败') +
            fmtList([
              `\`${TEAM_YAML_REL}\`：❌ 检测到 ${activeTeamProblems.length} 个进行中的问题（详见 Problems 面板）`,
              '说明：无效的可选字段可能会被忽略并给 warning；更严格的成员配置错误仍可能让该成员被跳过或在使用时失败，但不会让整个 Team.load() 崩掉。你仍应立即修复以免行为偏离预期。',
              ...followUpLines,
            ]) +
            fmtSubHeader('进行中的问题') +
            issueLines.join('\n') +
            '\n' +
            (renderedActiveTeamProblems.omitted > 0
              ? formatProblemOmittedNotice(language, renderedActiveTeamProblems.omitted)
              : '') +
            '\n' +
            resolvedIssueBlock
          : fmtHeader('team.yaml Validation Failed') +
            fmtList([
              `\`${TEAM_YAML_REL}\`: ❌ ${activeTeamProblems.length} active issue(s) detected (see Problems panel)`,
              'Note: invalid optional fields may be ignored with warnings; stricter member config errors can still omit that member or fail when used, but they should not crash Team.load(). Fix them immediately.',
              ...followUpLines,
            ]) +
            fmtSubHeader('Active Problems') +
            issueLines.join('\n') +
            '\n' +
            (renderedActiveTeamProblems.omitted > 0
              ? formatProblemOmittedNotice(language, renderedActiveTeamProblems.omitted)
              : '') +
            '\n' +
            resolvedIssueBlock;

      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `校验失败：${err instanceof Error ? err.message : String(err)}`
          : `Validation failed: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtValidateMcpCfgTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_validate_mcp_cfg',
  description: `Validate ${MCP_YAML_REL} and surface MCP issues to the WebUI Problems panel.`,
  descriptionI18n: {
    en: `Validate ${MCP_YAML_REL} and surface MCP issues to the WebUI Problems panel.`,
    zh: `校验 ${MCP_YAML_REL}，并将 MCP 问题上报到 WebUI 的 Problems 面板。`,
  },
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  argsValidation: 'dominds',
  async call(dlg, _caller, _args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const minds = await getMindsDirState();
      if (minds.kind === 'not_directory') {
        const msg =
          language === 'zh'
            ? `错误：\`${MINDS_DIR}/\` 存在但不是目录：\`${minds.abs}\``
            : `Error: \`${MINDS_DIR}/\` exists but is not a directory: \`${minds.abs}\``;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const reloadRes = await requestMcpConfigReload('team_mgmt_validate_mcp_cfg');
      if (!reloadRes.ok) {
        const msg =
          language === 'zh'
            ? `MCP 配置重载失败：${reloadRes.errorText}`
            : `MCP config reload failed: ${reloadRes.errorText}`;
        return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const cwd = path.resolve(process.cwd());
      const mcpYamlAbs = path.resolve(cwd, MCP_YAML_REL);
      let mcpRaw: string | null = null;
      let declaredServerCount = 0;
      let declaredServerIdsInYamlOrder: ReadonlyArray<string> = [];
      let fallbackInvalidServers: ReadonlyArray<{ serverId: string; errorText: string }> = [];

      try {
        const st = await fs.stat(mcpYamlAbs);
        if (!st.isFile()) {
          const msg =
            language === 'zh'
              ? `错误：\`${MCP_YAML_REL}\` 存在但不是文件。`
              : `Error: \`${MCP_YAML_REL}\` exists but is not a file.`;
          return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
        mcpRaw = await fs.readFile(mcpYamlAbs, 'utf8');
        const parsed = parseMcpYaml(mcpRaw);
        if (!parsed.ok) {
          const msg =
            language === 'zh'
              ? fmtHeader('mcp.yaml 校验失败') +
                fmtList([
                  `\`${MCP_YAML_REL}\`：❌ YAML/结构解析失败`,
                  '说明：该错误会直接影响 MCP 配置加载（详见 Problems 面板）。',
                ]) +
                '\n' +
                parsed.errorText
              : fmtHeader('mcp.yaml Validation Failed') +
                fmtList([
                  `\`${MCP_YAML_REL}\`: ❌ YAML/structure parse failed`,
                  'Note: this directly affects MCP config loading (see Problems panel).',
                ]) +
                '\n' +
                parsed.errorText;
          return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
        }
        declaredServerCount = parsed.serverIdsInYamlOrder.length;
        declaredServerIdsInYamlOrder = parsed.serverIdsInYamlOrder;
        fallbackInvalidServers = parsed.invalidServers;
      } catch (err: unknown) {
        if (!(isFsErrWithCode(err) && err.code === 'ENOENT')) {
          throw err;
        }
      }

      const snapshot = getProblemsSnapshot();
      const mcpProblems = listMcpYamlProblems(snapshot.problems);
      const { active: activeMcpProblems, resolved: resolvedMcpProblems } =
        splitProblemsByLifecycle(mcpProblems);
      const renderedActiveMcpProblems = limitProblemsForRender(activeMcpProblems);
      const renderedResolvedMcpProblems = limitProblemsForRender(resolvedMcpProblems);
      const fallbackOnlyInvalidServers: Array<{ serverId: string; errorText: string }> = [];
      for (const s of fallbackInvalidServers) {
        const hasMatchingProblem = activeMcpProblems.some(
          (p) => p.kind === 'mcp_server_error' && p.detail.serverId === s.serverId,
        );
        if (!hasMatchingProblem) {
          fallbackOnlyInvalidServers.push(s);
        }
      }

      if (activeMcpProblems.length === 0 && fallbackOnlyInvalidServers.length === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('mcp.yaml 校验通过') +
              fmtList([
                mcpRaw === null
                  ? `\`${MCP_YAML_REL}\`：✅ 未发现（按空配置处理）`
                  : `\`${MCP_YAML_REL}\`：✅ 未检测到问题（已声明 ${declaredServerCount} 个 server）`,
                '提示：每次修改 mcp.yaml 后都应运行本工具，确认 MCP 相关问题已清空。',
                resolvedMcpProblems.length > 0
                  ? formatResolvedProblemsHint({
                      language,
                      source: 'mcp',
                      path: MCP_YAML_REL,
                    })
                  : '',
              ])
            : fmtHeader('mcp.yaml Validation Passed') +
              fmtList([
                mcpRaw === null
                  ? `\`${MCP_YAML_REL}\`: ✅ not found (treated as empty config)`
                  : `\`${MCP_YAML_REL}\`: ✅ no issues detected (${declaredServerCount} declared server(s))`,
                'Tip: run this after every mcp.yaml change to confirm MCP problems are cleared.',
                resolvedMcpProblems.length > 0
                  ? formatResolvedProblemsHint({
                      language,
                      source: 'mcp',
                      path: MCP_YAML_REL,
                    })
                  : '',
              ]);
        const resolvedBlock =
          renderedResolvedMcpProblems.shown.length > 0
            ? fmtSubHeader(
                language === 'zh' ? '已解决但未清理的问题' : 'Resolved But Not Yet Cleared',
              ) +
              renderedResolvedMcpProblems.shown
                .flatMap((p) => formatProblemDetailLines(p, language))
                .join('\n') +
              '\n' +
              (renderedResolvedMcpProblems.omitted > 0
                ? formatProblemOmittedNotice(language, renderedResolvedMcpProblems.omitted)
                : '')
            : '';
        const content = msg + resolvedBlock;
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const issueLines = renderedActiveMcpProblems.shown.flatMap((p) =>
        formatProblemDetailLines(p, language),
      );
      for (const s of fallbackOnlyInvalidServers) {
        issueLines.push(`- [error] ${MCP_SERVER_PROBLEM_PREFIX}${s.serverId}/server_error`);
        issueLines.push(`  serverId: ${s.serverId}`);
        issueLines.push('  ' + s.errorText.split('\n').join('\n  '));
      }

      const totalIssues = activeMcpProblems.length + fallbackOnlyInvalidServers.length;
      const resolvedIssueBlock =
        resolvedMcpProblems.length > 0
          ? fmtSubHeader(
              language === 'zh' ? '已解决但未清理的问题' : 'Resolved But Not Yet Cleared',
            ) +
            fmtList([
              formatResolvedProblemsHint({
                language,
                source: 'mcp',
                path: MCP_YAML_REL,
              }),
            ]) +
            renderedResolvedMcpProblems.shown
              .flatMap((p) => formatProblemDetailLines(p, language))
              .join('\n') +
            '\n' +
            (renderedResolvedMcpProblems.omitted > 0
              ? formatProblemOmittedNotice(language, renderedResolvedMcpProblems.omitted)
              : '')
          : '';
      const msg =
        language === 'zh'
          ? fmtHeader('mcp.yaml 校验失败') +
            fmtList([
              `\`${MCP_YAML_REL}\`：❌ 检测到 ${totalIssues} 个问题（详见 Problems 面板）`,
              '说明：本校验会同时报告两类问题：1) 静态配置/声明错误；2) 当前运行时可达性问题（例如 MCP server 暂时不可连接、尚未加载或租用状态异常）。后者通常是暂态，服务恢复后重新运行本工具即可清除。',
            ]) +
            fmtSubHeader('进行中的问题') +
            issueLines.join('\n') +
            '\n' +
            resolvedIssueBlock
          : fmtHeader('mcp.yaml Validation Failed') +
            fmtList([
              `\`${MCP_YAML_REL}\`: ❌ ${totalIssues} issue(s) detected (see Problems panel)`,
              'Note: this validator can report both static config/declaration errors and current runtime availability failures (for example an MCP server that is temporarily down, unreachable, not yet loaded, or stuck in a lease-related state). The runtime-availability cases are often transient and may clear once the MCP service recovers.',
            ]) +
            fmtSubHeader('Active Problems') +
            issueLines.join('\n') +
            '\n' +
            resolvedIssueBlock;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `校验失败：${err instanceof Error ? err.message : String(err)}`
          : `Validation failed: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtListProblemsTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_list_problems',
  description: 'List Problems panel entries with active/resolved lifecycle split.',
  descriptionI18n: {
    en: 'List Problems panel entries with active/resolved lifecycle split.',
    zh: '列出 Problems 面板中的问题，并按进行中/已解决历史分开展示。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: {
        type: 'string',
        enum: [...TEAM_MGMT_PROBLEM_SOURCES],
      },
      path: { type: 'string' },
      problem_id: { type: 'string' },
      status: {
        type: 'string',
        enum: [...TEAM_MGMT_PROBLEM_STATUS],
      },
      max_items: { type: 'integer' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const source = parseTeamMgmtProblemSourceArg(args['source']);
      const filterPath = parseTeamMgmtProblemPathArg(args['path']);
      const problemId = parseTeamMgmtProblemIdArg(args['problem_id']);
      const status = parseTeamMgmtProblemStatusArg(args['status'], 'all');
      const maxItems = parseOptionalPositiveInteger(args['max_items'], 'max_items');
      const resolvedFilter = status === 'all' ? undefined : status === 'resolved' ? true : false;
      const matched = listProblems({
        ...(source !== undefined ? { source } : {}),
        ...(filterPath !== undefined ? { path: filterPath } : {}),
        ...(problemId !== undefined ? { problemId } : {}),
        ...(resolvedFilter !== undefined ? { resolved: resolvedFilter } : {}),
      });
      const requestedMaxItems = maxItems ?? TEAM_MGMT_RENDERED_PROBLEM_LIMIT;
      const effectiveMaxItems = Math.min(requestedMaxItems, TEAM_MGMT_RENDERED_PROBLEM_LIMIT);
      const problems = matched.slice(0, effectiveMaxItems);
      const { active, resolved } = splitProblemsByLifecycle(problems);
      const filters: string[] = [];
      if (source !== undefined) filters.push(`source=\`${source}\``);
      if (filterPath !== undefined) filters.push(`path=\`${filterPath}\``);
      if (problemId !== undefined) filters.push(`problem_id=\`${problemId}\``);
      filters.push(`status=\`${status}\``);
      if (maxItems !== undefined) filters.push(`max_items=\`${String(maxItems)}\``);
      filters.push(`effective_max_items=\`${String(effectiveMaxItems)}\``);
      const header =
        language === 'zh' ? fmtHeader('Problems 查询结果') : fmtHeader('Problems Query');
      const summary =
        language === 'zh'
          ? fmtList([
              `匹配到 ${matched.length} 条问题，本次返回 ${problems.length} 条`,
              `进行中：${active.length}，已解决历史：${resolved.length}`,
              `过滤条件：${filters.join('，')}`,
            ])
          : fmtList([
              `${matched.length} problem(s) matched; returning ${problems.length}`,
              `active: ${active.length}, resolved history: ${resolved.length}`,
              `filters: ${filters.join(', ')}`,
            ]);

      const activeBlock =
        active.length > 0
          ? fmtSubHeader(language === 'zh' ? '进行中的问题' : 'Active Problems') +
            active.flatMap((problem) => formatProblemDetailLines(problem, language)).join('\n') +
            '\n'
          : '';
      const resolvedBlock =
        resolved.length > 0
          ? fmtSubHeader(
              language === 'zh' ? '已解决但未清理的问题' : 'Resolved But Not Yet Cleared',
            ) +
            fmtList([
              formatResolvedProblemsHint({
                language,
                source,
                path: filterPath,
              }),
            ]) +
            resolved.flatMap((problem) => formatProblemDetailLines(problem, language)).join('\n') +
            '\n'
          : '';
      const emptyBlock =
        problems.length === 0
          ? language === 'zh'
            ? '当前没有匹配的问题。\n'
            : 'No matching problems.\n'
          : '';
      const omittedMatched = Math.max(0, matched.length - problems.length);
      const omittedBlock =
        omittedMatched > 0
          ? language === 'zh'
            ? `（为避免输出过长，本次省略其余 ${omittedMatched} 条匹配问题；请改用 source/path/problem_id/max_items 缩小范围）\n`
            : `(omitted ${omittedMatched} additional matching problem(s) to keep the output bounded; refine source/path/problem_id/max_items to inspect them)\n`
          : '';

      const entries = problems.map((problem) => ({
        problem_id: problem.id,
        kind: problem.kind,
        source: problem.source,
        severity: problem.severity,
        active: problem.resolved !== true,
        occurred_at:
          typeof problem.occurredAt === 'string' && problem.occurredAt !== ''
            ? problem.occurredAt
            : problem.timestamp,
        updated_at: getProblemUpdatedAt(problem),
        resolved_at: problem.resolved === true ? (problem.resolvedAt ?? null) : null,
        path: getWorkspaceProblemPath(problem) ?? undefined,
        message: problem.message,
      }));
      const yamlBlock = formatYamlCodeBlock(
        YAML.stringify({
          problems_version: getProblemsSnapshot().version,
          returned_count: problems.length,
          active_count: active.length,
          resolved_count: resolved.length,
          problems: entries,
        }).trimEnd(),
      );
      const content =
        header + summary + omittedBlock + emptyBlock + activeBlock + resolvedBlock + yamlBlock;
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtClearProblemsTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_clear_problems',
  description: 'Clear Problems panel entries, defaulting to resolved history only.',
  descriptionI18n: {
    en: 'Clear Problems panel entries, defaulting to resolved history only.',
    zh: '清理 Problems 面板中的问题项，默认只清理已解决的历史项。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: {
        type: 'string',
        enum: [...TEAM_MGMT_PROBLEM_SOURCES],
      },
      path: { type: 'string' },
      problem_id: { type: 'string' },
      status: {
        type: 'string',
        enum: [...TEAM_MGMT_PROBLEM_STATUS],
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getUserLang(dlg);
    try {
      const source = parseTeamMgmtProblemSourceArg(args['source']);
      const filterPath = parseTeamMgmtProblemPathArg(args['path']);
      const problemId = parseTeamMgmtProblemIdArg(args['problem_id']);
      const status = parseTeamMgmtProblemStatusArg(args['status'], 'resolved');
      const resolvedFilter = status === 'all' ? undefined : status === 'resolved' ? true : false;
      const hasExplicitTarget =
        source !== undefined || filterPath !== undefined || problemId !== undefined;
      if (status !== 'resolved' && !hasExplicitTarget) {
        throw new Error(
          language === 'zh'
            ? '清理 active/all 问题时必须显式指定 source、path 或 problem_id，避免误删进行中的问题。'
            : 'Clearing active/all problems requires an explicit source, path, or problem_id filter to avoid removing active issues by mistake.',
        );
      }

      const before = listProblems({
        ...(source !== undefined ? { source } : {}),
        ...(filterPath !== undefined ? { path: filterPath } : {}),
        ...(problemId !== undefined ? { problemId } : {}),
        ...(resolvedFilter !== undefined ? { resolved: resolvedFilter } : {}),
      });
      const removedCount = clearProblems({
        ...(source !== undefined ? { source } : {}),
        ...(filterPath !== undefined ? { path: filterPath } : {}),
        ...(problemId !== undefined ? { problemId } : {}),
        ...(resolvedFilter !== undefined ? { resolved: resolvedFilter } : {}),
      });
      const filters: string[] = [];
      if (source !== undefined) filters.push(`source=\`${source}\``);
      if (filterPath !== undefined) filters.push(`path=\`${filterPath}\``);
      if (problemId !== undefined) filters.push(`problem_id=\`${problemId}\``);
      filters.push(`status=\`${status}\``);
      const removedIds = before
        .slice(0, removedCount)
        .slice(0, TEAM_MGMT_REMOVED_PROBLEM_ID_LIMIT)
        .map((problem) => `- ${problem.id}`);
      const removedIdsOmitted = Math.max(0, removedCount - removedIds.length);
      const content =
        language === 'zh'
          ? fmtHeader('Problems 清理结果') +
            fmtList([
              `已清理 ${removedCount} 条问题`,
              `过滤条件：${filters.join('，')}`,
              status === 'resolved'
                ? '说明：默认只清理已解决历史；进行中的问题不会被静默移除。'
                : '说明：你本次显式请求了 active/all 清理，请确认这符合预期。',
            ]) +
            (removedIds.length > 0
              ? fmtSubHeader('已清理的问题') +
                removedIds.join('\n') +
                '\n' +
                (removedIdsOmitted > 0
                  ? `（其余 ${removedIdsOmitted} 条已清理问题未逐条展开）\n`
                  : '')
              : '')
          : fmtHeader('Problems Clear Result') +
            fmtList([
              `cleared ${removedCount} problem(s)`,
              `filters: ${filters.join(', ')}`,
              status === 'resolved'
                ? 'Note: by default this only clears resolved history; active problems are not removed silently.'
                : 'Note: this call explicitly requested active/all clearing; make sure that is what you intended.',
            ]) +
            (removedIds.length > 0
              ? fmtSubHeader('Cleared Problems') +
                removedIds.join('\n') +
                '\n' +
                (removedIdsOmitted > 0
                  ? `(omitted ${removedIdsOmitted} additional cleared problem id(s))\n`
                  : '')
              : '');
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtTools: ReadonlyArray<FuncTool> = [
  teamMgmtCheckProviderTool,
  teamMgmtListProvidersTool,
  teamMgmtListModelsTool,
  teamMgmtValidatePrimingScriptsTool,
  teamMgmtValidateTeamCfgTool,
  teamMgmtValidateMcpCfgTool,
  teamMgmtListProblemsTool,
  teamMgmtClearProblemsTool,
  teamMgmtListDirTool,
  teamMgmtReadFileTool,
  teamMgmtCreateNewFileTool,
  teamMgmtOverwriteEntireFileTool,
  teamMgmtPrepareFileAppendTool,
  teamMgmtPrepareInsertAfterTool,
  teamMgmtPrepareInsertBeforeTool,
  teamMgmtPrepareBlockReplaceTool,
  teamMgmtPrepareFileRangeEditTool,
  teamMgmtApplyFileModificationTool,
  teamMgmtMkDirTool,
  teamMgmtMoveFileTool,
  teamMgmtMoveDirTool,
  teamMgmtRipgrepFilesTool,
  teamMgmtRipgrepSnippetsTool,
  teamMgmtRipgrepCountTool,
  teamMgmtRipgrepFixedTool,
  teamMgmtRipgrepSearchTool,
  teamMgmtRmFileTool,
  teamMgmtRmDirTool,
];
