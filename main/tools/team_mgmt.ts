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

import type { ChatMessage, ModelParamOption, ProviderConfig } from '../llm/client';
import { LlmConfig } from '../llm/client';
import type { LlmStreamReceiver } from '../llm/gen';
import { getLlmGenerator } from '../llm/gen/registry';
import { parseMcpYaml } from '../mcp/config';
import { requestMcpConfigReload } from '../mcp/supervisor';
import { getProblemsSnapshot, reconcileProblemsByPrefix } from '../problems';
import type { TeamMgmtManualTopicKey } from '../shared/team_mgmt-manual';
import { getTeamMgmtManualTopicTitle, isTeamMgmtManualTopicKey } from '../shared/team_mgmt-manual';
import type { LanguageCode } from '../shared/types/language';
import type { WorkspaceProblem } from '../shared/types/problems';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../tool';
import { listDirTool, mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from './fs';
import { listToolsets } from './registry';
import {
  ripgrepCountTool,
  ripgrepFilesTool,
  ripgrepFixedTool,
  ripgrepSearchTool,
  ripgrepSnippetsTool,
} from './ripgrep';
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
const TEAM_YAML_PROBLEM_PREFIX = 'team/team_yaml_error/';
const MCP_YAML_REL = `${MINDS_DIR}/mcp.yaml`;
const MCP_WORKSPACE_PROBLEM_PREFIX = 'mcp/workspace_config_error';
const MCP_SERVER_PROBLEM_PREFIX = 'mcp/server/';

function ok(result: string, messages?: ChatMessage[]): string {
  void messages;
  return result;
}

function fail(result: string, messages?: ChatMessage[]): string {
  void messages;
  return result;
}

function toolCallOutputToString(output: ToolCallOutput): string {
  return typeof output === 'string' ? output : output.content;
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
  const cwd = path.resolve(process.cwd());
  const teamYamlAbs = path.resolve(cwd, TEAM_YAML_REL);
  try {
    const st = await fs.stat(teamYamlAbs);
    if (!st.isFile()) return;
  } catch (err: unknown) {
    if (isFsErrWithCode(err) && err.code === 'ENOENT') return;
    throw err;
  }

  const raw = await fs.readFile(teamYamlAbs, 'utf8');
  const warnings = lintTeamYamlStyle(raw);
  const STYLE_PREFIX = TEAM_YAML_PROBLEM_PREFIX + 'style/';
  if (warnings.length === 0) {
    reconcileProblemsByPrefix(STYLE_PREFIX, []);
    return;
  }

  const now = formatUnifiedTimestamp(new Date());
  reconcileProblemsByPrefix(STYLE_PREFIX, [
    {
      kind: 'team_workspace_config_error',
      source: 'team',
      id: STYLE_PREFIX + 'formatting',
      severity: 'warning',
      timestamp: now,
      message: `Style warnings in ${TEAM_YAML_REL}.`,
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

type TeamConfigProblem = Extract<WorkspaceProblem, { source: 'team' }>;

function listTeamYamlProblems(problems: ReadonlyArray<WorkspaceProblem>): TeamConfigProblem[] {
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

type McpConfigProblem = Extract<WorkspaceProblem, { source: 'mcp' }>;

function listMcpYamlProblems(problems: ReadonlyArray<WorkspaceProblem>): McpConfigProblem[] {
  const out: McpConfigProblem[] = [];
  for (const p of problems) {
    if (p.source !== 'mcp') continue;
    if (
      p.id.startsWith(MCP_WORKSPACE_PROBLEM_PREFIX) ||
      p.id.startsWith(MCP_SERVER_PROBLEM_PREFIX)
    ) {
      out.push(p);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
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
  return `${head.join(', ')}${ids.length > head.length ? ', ...' : ''}`;
}

async function loadBuiltinLlmProviders(): Promise<Record<string, ProviderConfig>> {
  const defaultsPath = path.join(__dirname, '..', 'llm', 'defaults.yaml');
  const raw = await fs.readFile(defaultsPath, 'utf-8');
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
  async call(dlg, _caller, args: ToolArguments): Promise<string> {
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
      // Codex provider requires all func args to be schema-required; use max_models=0 as sentinel for default.
      const maxModels =
        typeof maxModelsValue === 'number' && Number.isInteger(maxModelsValue) && maxModelsValue > 0
          ? maxModelsValue
          : 10;
      if (
        maxModelsValue !== undefined &&
        (typeof maxModelsValue !== 'number' ||
          !Number.isInteger(maxModelsValue) ||
          maxModelsValue < 0)
      ) {
        throw new Error('Invalid max_models (expected positive integer or 0 for default)');
      }

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
            await llmGen.genToReceiver(providerCfg, agent, systemPrompt, [], context, receiver, 0);
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
            ? `提示：如需做真实连通性测试，设置 \`live: true\`。例如：\`team_mgmt_check_provider({ provider_key: \"${providerKey}\", model: \"<modelKey>\", all_models: false, live: true, max_models: 0 })\``
            : `Tip: to perform a real connectivity test, set \`live: true\`. Example: \`team_mgmt_check_provider({ provider_key: \"${providerKey}\", model: \"<modelKey>\", all_models: false, live: true, max_models: 0 })\``;
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
  async call(dlg, _caller, args: ToolArguments): Promise<string> {
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
      const maxModels = isInteger(maxModelsValue) && maxModelsValue > 0 ? maxModelsValue : 30;
      if (maxModelsValue !== undefined && (!isInteger(maxModelsValue) || maxModelsValue < 0)) {
        throw new Error('Invalid max_models (expected integer >= 0)');
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
            for (const providerKey of keys) {
              if (!wildcardMatch(providerKey, providerPattern)) continue;
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
          for (const providerKey of keys) {
            if (!wildcardMatch(providerKey, providerPattern)) continue;
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
  async call(dlg, _caller, args: ToolArguments): Promise<string> {
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
      const maxModels = isInteger(maxModelsValue) && maxModelsValue > 0 ? maxModelsValue : 200;
      if (maxModelsValue !== undefined && (!isInteger(maxModelsValue) || maxModelsValue < 0)) {
        throw new Error('Invalid max_models (expected integer >= 0)');
      }

      const maxModelsPerProviderValue = args['max_models_per_provider'];
      const maxModelsPerProvider =
        isInteger(maxModelsPerProviderValue) && maxModelsPerProviderValue > 0
          ? maxModelsPerProviderValue
          : 50;
      if (
        maxModelsPerProviderValue !== undefined &&
        (!isInteger(maxModelsPerProviderValue) || maxModelsPerProviderValue < 0)
      ) {
        throw new Error('Invalid max_models_per_provider (expected integer >= 0)');
      }

      const maxParamsValue = args['max_params'];
      const maxParams = isInteger(maxParamsValue) && maxParamsValue > 0 ? maxParamsValue : 80;
      if (maxParamsValue !== undefined && (!isInteger(maxParamsValue) || maxParamsValue < 0)) {
        throw new Error('Invalid max_params (expected integer >= 0)');
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, _caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
      return ok(result, [{ type: 'environment_msg', role: 'user', content: result }]);
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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
  async call(dlg, caller, args: ToolArguments): Promise<string> {
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

type ManualTopic = TeamMgmtManualTopicKey;

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

async function loadBuiltinLlmDefaultsText(): Promise<string> {
  const defaultsPath = path.join(__dirname, '..', 'llm', 'defaults.yaml');
  const raw = await fs.readFile(defaultsPath, 'utf-8');
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
  const defaultsPath = path.join(__dirname, '..', 'llm', 'defaults.yaml');
  const raw = await fs.readFile(defaultsPath, 'utf-8');
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

function renderMemberProperties(language: LanguageCode): string {
  const memberKeys = fmtKeyList(Team.TEAM_YAML_MEMBER_KEYS);
  if (language === 'zh') {
    return (
      fmtHeader('成员字段（members.<id>）') +
      fmtList([
        `字段白名单（以当前实现为准）：${memberKeys}`,
        '`name` / `icon` / `gofor`',
        '`gofor`：该长期 agent 的职责速记卡（建议 5 行内），用于快速路由/提醒：写清“负责什么 / 不负责什么 / 主要交付物 / 优先级”。推荐用 YAML list（3–6 条）；也支持 YAML object（单对象多键值，value 必须是 string），string 仅适合单句。对象的渲染顺序跟 YAML key 写入顺序一致（当前实现/依赖）。详细规范请写入 `.minds/team/<id>/*` 或 `.minds/team/domains/*.md` 等 Markdown 资产。',
        '`provider` / `model` / `model_params`',
        '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
        '`diligence-push-max`：鞭策 上限（number）。也接受兼容别名 `diligence_push_max`，但请优先用 `diligence-push-max`。',
        '`streaming`：是否启用流式输出。注意：若该成员解析后的 provider 的 `apiType` 是 `codex`，则 `streaming: false` 属于配置错误（Codex 仅支持流式）；会在 team 校验与运行期被视为严重问题并中止请求。',
        '`hidden`（影子/隐藏成员：不出现在系统提示的团队目录里，但仍可被诉请）',
        '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`（冲突规则见 `team_mgmt_manual({ topics: ["permissions"] })`；read 与 write 是独立控制，别默认 write implies read）',
      ])
    );
  }
  return (
    fmtHeader('Member Properties (members.<id>)') +
    fmtList([
      `Allow-list (per current implementation): ${memberKeys}`,
      '`name` / `icon` / `gofor`',
      '`gofor`: a short responsibility flashcard (≤ 5 lines) for a long-lived agent; use it for fast routing/reminders (owns / does-not-own / key deliverables / priorities). Prefer a YAML list (3–6 items); YAML object is also allowed (single object with multiple keys, string values only). Object rendering order follows the YAML key order (implementation-dependent). Use a string only for a single sentence. Put detailed specs in Markdown assets like `.minds/team/<id>/*` or `.minds/team/domains/*.md`.',
      '`provider` / `model` / `model_params`',
      '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
      '`diligence-push-max`: Diligence Push cap (number). Compatibility alias `diligence_push_max` is accepted, but prefer `diligence-push-max`.',
      '`streaming`: whether to enable streaming output. Note: if the member resolves to a provider whose `apiType` is `codex`, then `streaming: false` is a configuration error (Codex is streaming-only); it is treated as a severe issue during validation/runtime and the request will be aborted.',
      '`hidden` (shadow/hidden member: excluded from system-prompt team directory, but callable)',
      '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`（冲突规则见 `team_mgmt_manual({ topics: ["permissions"] })`；read 与 write 是独立控制，别默认 write implies read）',
    ])
  );
}

function renderTeamManual(language: LanguageCode): string {
  const common = [
    'member_defaults: strongly recommended to set provider/model explicitly (omitting may fall back to built-in defaults)',
    'members: per-agent overrides inherit from member_defaults via prototype fallback',
    'after every modification to `.minds/team.yaml`: you must run `team_mgmt_validate_team_cfg({})` and resolve any Problems panel errors before proceeding to avoid runtime issues (e.g., wrong field types, missing fields, or broken path bindings)',
    'when changing provider/model: validate provider exists + env var is configured (use `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false, max_models: 0 })`)',
    'to discover providers/models: use `team_mgmt_list_providers({})` and `team_mgmt_list_models({ provider_pattern: "*", model_pattern: "*" })`',
    'streaming: Codex providers (apiType=codex) are streaming-only. Setting members.<id>.streaming=false with a Codex provider is a config error and will abort requests.',
    'do not write built-in members (e.g. fuxi/pangu) into `.minds/team.yaml` (define only rtws members)',
    '`shell_specialists`: optional allow-list of member ids permitted to have shell tools. If any member has shell tools (e.g. toolset `os` / tools like `shell_exec`), they must be listed in shell_specialists; null/empty means “no shell specialists”.',
    'hidden: true marks a shadow member (not listed in system prompt)',
  ];
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team.yaml') +
      fmtList([
        '团队定义入口文件是 `.minds/team.yaml`（当前没有 `.minds/team.yml` / `.minds/team.json` 等别名；也不使用 `.minds/team.yaml` 以外的“等效入口”）。',
        '强烈建议显式设置 `member_defaults.provider` 与 `member_defaults.model`：如果省略，可能会使用实现内置的默认值（以当前实现为准），但可移植性/可复现性会变差，也更容易在环境变量未配置时把系统刷成板砖。',
        '每次修改 `.minds/team.yaml` 必须运行 `team_mgmt_validate_team_cfg({})`，并在继续之前先清空 Problems 面板里的 team.yaml 相关错误，避免潜在错误进入运行期（例如字段类型错误/字段缺失/路径绑定错误）。',
        '角色职责（Markdown）通过 `.minds/team/<id>/{persona,knowledge,lessons}.*.md` 绑定到 `members.<id>`：同一个 `<id>` 必须在 `team.yaml` 的 `members` 里出现，且在 `.minds/team/<id>/` 下存在对应的 mind 文件。',
        '团队机制默认范式是“长期 agent”（long-lived teammates）：`members` 列表表示稳定存在、可随时被诉请的队友，并非“按需子角色/临时 sub-role”。这是产品机制，而非部署/运行偏好。\n如需切换当前由谁执行/扮演，用 CLI/TUI 的 `-m/--member <id>` 显式选择。\n`members.<id>.gofor` 用于写该长期 agent 的“职责速记卡/工作边界/交付物摘要”（建议 5 行内）：用于快速路由与提醒；更完整的规范请写入 `.minds/team/<id>/*` 或 `.minds/team/domains/*.md` 等 Markdown 资产。\n示例（gofor）：\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      - Own release regression checklist and pass/fail gate\n      - Maintain script-style smoke tests and how to run them\n      - Reject changes that break lint/types/tests (or request fixes)\n      - Track high-risk areas and required manual verification\n```\n示例（gofor, object；按 YAML key 顺序渲染）：\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      Scope: release regression gate\n      Deliverables: checklist + runnable scripts\n      Non-goals: feature dev\n      Interfaces: coordinates with server/webui owners\n```',
        '`members.<id>.gofor` 推荐用 YAML list（3–6 条）而不是长字符串；string 仅适合单句。建议用下面 5 行模板维度（每条尽量短）：\n```yaml\ngofor:\n  - Scope: ...\n  - Interfaces: ...\n  - Deliverables: ...\n  - Non-goals: ...\n  - Regression: ...\n```',
        '如何为不同角色指定默认模型：用 `member_defaults.provider/model` 设全局默认；对特定成员在 `members.<id>.provider/model` 里覆盖即可。例如：默认用 `gpt-5.2`，代码编写域成员用 `gpt-5.2-codex`。',
        '模型参数（例如 `reasoning_effort` / `verbosity` / `temperature`）应写在 `member_defaults.model_params.codex.*` 或 `members.<id>.model_params.codex.*` 下（对内置 `codex` provider）。不要把这些参数直接写在 `member_defaults`/`members.<id>` 根上。',
        '重要：Codex provider（`apiType=codex`）仅支持流式输出。若成员解析后的 provider 是 Codex，则 `members.<id>.streaming: false` 属于配置错误，会在校验/运行时作为严重问题上报并中止请求。',
        '`shell_specialists`：可选，列出允许拥有 shell 工具的成员 id（string|string[]|null）。如某成员获得了 shell 工具（例如 toolset `os` 或 tools 里的 `shell_exec` 等），则该成员必须出现在 `shell_specialists`；否则会在 Problems 面板提示（运行期 fail-open，但你仍应修复）。',

        '风格提醒：保持 `team.yaml` 的可读性。推荐用空行分隔段落/成员块，避免连续多行空行；每次修改后运行 `team_mgmt_validate_team_cfg({})` 以便在 Problems 面板看到错误与风格提醒。',

        '默认策略（可被用户覆盖）：\n' +
          '1) 新增成员时，`diligence-push-max` 默认设为 `3`（除非用户明确要求其他值）。\n' +
          '2) 切换成员的 LLM `provider/model` 时，默认保留 `ws_read` / `ws_mod` 作为基线；当目标是 `provider: codex` 时，在基线上追加 `codex_style_tools`（而不是替代），除非用户明确要求其他组合。',

        '成员配置通过 prototype 继承 `member_defaults`（省略字段会继承默认值）。',
        '修改 provider/model 前请务必确认该 provider 可用（至少 env var 已配置）。可用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` 做检查，避免把系统刷成板砖。',
        '想快速查看有哪些 provider / models / model_param_options：用 `team_mgmt_list_providers({})` 和 `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })`。',
        '不要把内置成员（例如 `fuxi` / `pangu`）的定义写入 `.minds/team.yaml`（这里只定义 rtws（运行时工作区）自己的成员）：内置成员通常带有特殊权限/目录访问边界；重复定义可能引入冲突、权限误配或行为不一致。',
        '`hidden: true` 表示影子/隐藏成员：不会出现在系统提示的团队目录里，但仍然可以通过 tellask-special 函数诉请。',
        '修改文件推荐流程：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` 定位行号；小改动用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` 生成 diff（工具会返回 hunk_id），再用 `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })` 显式确认写入；如需修订同一个预览，可再次调用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` 覆写；如确实需要整文件覆盖：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` 从 YAML header 获取 total_lines/size_bytes，再用 `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`。',
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
      '      - codex_style_tools\n' +
      "    no_read_dirs: ['.minds/**']\n" +
      "    no_write_dirs: ['.minds/**']\n" +
      '  qa_guard:\n' +
      '    name: QA Guard\n' +
      '    gofor:\n' +
      '      - Own release regression checklist and pass/fail gate\n' +
      '      - Maintain runnable smoke tests and docs\n' +
      '      - Flag high-risk changes and required manual checks\n' +
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
        'Role responsibilities (Markdown) live under `.minds/team/<id>/{persona,knowledge,lessons}.*.md` and are linked by member id: the same `<id>` must exist in `members.<id>` in `team.yaml`.',
        'The team mechanism default is long-lived agents (long-lived teammates): `members` is a stable roster of callable teammates, not “on-demand sub-roles”. This is a product mechanism, not a deployment preference.\nTo pick who acts, use `-m/--member <id>` in CLI/TUI.\n`members.<id>.gofor` is a responsibility flashcard / scope / deliverables summary (≤ 5 lines). Use it for fast routing/reminders; put detailed specs in Markdown assets like `.minds/team/<id>/*` or `.minds/team/domains/*.md`.\nExample (`gofor`):\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      - Own release regression checklist and pass/fail gate\n      - Maintain runnable smoke tests and docs\n      - Flag high-risk changes and required manual checks\n```\nExample (`gofor`, object; rendered in YAML key order):\n```yaml\nmembers:\n  qa_guard:\n    name: QA Guard\n    gofor:\n      Scope: release regression gate\n      Deliverables: checklist + runnable scripts\n      Non-goals: feature dev\n      Interfaces: coordinates with server/webui owners\n```',
        'Per-role default models: set global defaults via `member_defaults.provider/model`, then override `members.<id>.provider/model` per member (e.g. use `gpt-5.2` by default, and `gpt-5.2-codex` for code-writing members).',
        'Model params (e.g. `reasoning_effort` / `verbosity` / `temperature`) must be nested under `member_defaults.model_params.codex.*` or `members.<id>.model_params.codex.*` (for the built-in `codex` provider). Do not put them directly under `member_defaults`/`members.<id>` root.',
        'Style reminder: keep `team.yaml` readable. Prefer single blank lines between sections/member blocks; avoid long runs of blank lines. Run `team_mgmt_validate_team_cfg({})` after edits to surface errors and style warnings in the Problems panel.',
        'Default policy (override only when requested):\n1) When adding a member, set `diligence-push-max` to `3` unless the user explicitly asks otherwise.\n2) When switching a member’s LLM `provider/model`, keep `ws_read` / `ws_mod` as the baseline; when the target is `provider: codex`, add `codex_style_tools` on top (not as a replacement), unless the user explicitly asks for a different combination.',
        'Deployment/org suggestion (optional): if you do not want a visible team manager, keep `team_mgmt` only on a hidden/shadow member and have a human trigger it when needed; Dominds does not require this organizational setup.',
        'Recommended editing workflow: use `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` to find line numbers; for small edits, run `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` to get a diff (the tool returns hunk_id), then confirm with `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })`; to revise the same prepared diff, call `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` again; if you truly need a full overwrite: first `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` and read total_lines/size_bytes from the YAML header, then use `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`.',
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
    '      - codex_style_tools\n' +
    "    no_read_dirs: ['.minds/**']\n" +
    "    no_write_dirs: ['.minds/**']\n" +
    '```\n'
  );
}

function renderMcpManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/mcp.yaml') +
      fmtList([
        '每个 MCP `serverId` 注册一个 toolset，toolset 名称 = `serverId`（不加 `mcp_` 前缀）。成员通过 `members.<id>.toolsets` 选择能用哪些 MCP toolset。',
        '支持热重载：编辑 `.minds/mcp.yaml` 后通常无需重启 Dominds；必要时用 `mcp_restart`。',
        '默认按“每个对话租用一个 MCP client”运行（更安全）：首次使用该 toolset 会产生 sticky reminder，完成后用 `mcp_release` 释放；如确实是无状态服务器，可配置 `truely-stateless: true` 允许跨对话共享。',
        'stdio 配置格式：`command` 必须是字符串（可执行命令），参数放在 `args`（string[]，可省略，默认空数组）。`cwd` 可选（字符串）：用于固定相对路径解析目录。',
        '用 `tools.whitelist/blacklist` 控制暴露的工具，用 `transform` 做命名变换。',
        '常见坑：stdio transport 需要可执行命令路径正确，且受成员目录权限（`read_dirs/write_dirs/no_*`）约束；HTTP transport 需要服务可达（url/端口/网络）。',
        '高频坑（stdio 路径）：若未设置 `cwd`，相对路径按 Dominds 进程工作目录（通常 rtws 根目录）解析；建议显式配置 `cwd` 或直接使用绝对路径。`cwd` 必须存在且是目录。',
        '最小诊断流程（建议顺序）：1) 先用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` 确认 LLM provider 可用；2) 再检查该成员的目录权限（`team_mgmt_manual({ topics: [\"permissions\"] })`）；3) 运行 `team_mgmt_validate_mcp_cfg({})` 汇总 `.minds/mcp.yaml` 与 MCP 问题；4) 必要时 `mcp_restart`，用完记得 `mcp_release`。',
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小模板（stdio）',
        'version: 1',
        'servers:',
        '  sdk_stdio:',
        '    truely-stateless: false',
        '    transport: stdio',
        '    command: npx',
        "    args: ['-y', '@some/mcp-server@latest']",
        '    cwd: "."',
        '    env: {}',
        '    tools: { whitelist: [], blacklist: [] }',
        '    transform: []',
      ]) +
      fmtCodeBlock('yaml', [
        '# stdio 路径示例（最小）',
        '# 相对路径：配合 cwd 固定解析目录',
        'command: node',
        "args: ['./mcp/server.js']",
        'cwd: "/absolute/path/to/project"',
        '',
        '# 绝对路径：更稳，不依赖 cwd',
        'command: node',
        "args: ['/absolute/path/to/mcp/server.js']",
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小模板（HTTP）',
        'version: 1',
        'servers:',
        '  sdk_http:',
        '    truely-stateless: false',
        '    transport: streamable_http',
        '    url: http://127.0.0.1:3000/mcp',
        '    tools: { whitelist: [], blacklist: [] }',
        '    transform: []',
      ])
    );
  }

  return (
    fmtHeader('.minds/mcp.yaml') +
    fmtList([
      'Each MCP `serverId` registers one toolset, and the toolset name is exactly `serverId` (no `mcp_` prefix). Members choose MCP access via `members.<id>.toolsets`.',
      'Hot reload: edits usually apply without restarting Dominds; use `mcp_restart` when needed.',
      "Default is per-dialog MCP client leasing (safer): first use adds a sticky reminder; call `mcp_release` when you're sure you won't need the toolset soon. If the server is truly stateless, set `truely-stateless: true` to allow cross-dialog sharing.",
      'Stdio shape: `command` must be a string executable; parameters go in `args` (string[], optional, defaults to empty). Optional `cwd` (string) fixes the working directory used for relative paths.',
      'Use `tools.whitelist/blacklist` for exposure control and `transform` for naming transforms.',
      'Common pitfalls: stdio transport needs a correct executable/command path, and is subject to member directory permissions (`read_dirs/write_dirs/no_*`); HTTP transport requires the server URL to be reachable.',
      'High-frequency pitfall (stdio paths): if `cwd` is omitted, relative paths are resolved from Dominds process cwd (usually rtws root). Prefer setting `cwd` explicitly or use absolute paths. `cwd` must exist and be a directory.',
      'Minimal diagnostic flow: 1) run `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` to confirm the LLM provider works; 2) review member directory permissions (`team_mgmt_manual({ topics: [\"permissions\"] })`); 3) run `team_mgmt_validate_mcp_cfg({})` to summarize `.minds/mcp.yaml` + MCP issues; 4) use `mcp_restart` if needed, and `mcp_release` when done.',
    ]) +
    fmtCodeBlock('yaml', [
      '# Minimal template (stdio)',
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    truely-stateless: false',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', '@some/mcp-server@latest']",
      '    cwd: "."',
      '    env: {}',
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
    ]) +
    fmtCodeBlock('yaml', [
      '# stdio path example (minimal)',
      '# Relative path: stable with explicit cwd',
      'command: node',
      "args: ['./mcp/server.js']",
      'cwd: "/absolute/path/to/project"',
      '',
      '# Absolute path: more stable, independent of cwd',
      'command: node',
      "args: ['/absolute/path/to/mcp/server.js']",
    ]) +
    fmtCodeBlock('yaml', [
      '# Minimal template (HTTP)',
      'version: 1',
      'servers:',
      '  sdk_http:',
      '    truely-stateless: false',
      '    transport: streamable_http',
      '    url: http://127.0.0.1:3000/mcp',
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
    ])
  );
}

function renderPermissionsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('目录权限（read_dirs / write_dirs）') +
      fmtList([
        '权限字段：`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`。',
        'deny-list（no_*）优先于 allow-list（*_dirs）。',
        '若未配置 allow-list，则默认允许（在 deny-list 不命中的前提下）。这很方便，但也更容易“权限过大”；如需最小权限，建议显式收敛 allow-list 并对敏感目录加 deny-list。',
        '`read_dirs` 与 `write_dirs` 是独立控制：不要默认 write implies read（以当前实现的权限检查为准）。',
        '模式支持 `*` 和 `**`，按“目录范围”语义匹配（按目录/路径前缀范围来理解）。',
        '示例：`dominds/**` 会匹配 `dominds/README.md`、`dominds/main/server.ts`、`dominds/webapp/src/...` 等路径。',
        '示例：`.minds/**` 会匹配 `.minds/team.yaml`、`.minds/team/<id>/persona.zh.md` 等；常用于限制普通成员访问 minds 资产。',
        '`*.tsk/` 是封装差遣牒：只能用函数工具 `change_mind` 维护。任何通用文件工具都无法访问该目录树（硬编码无条件拒绝）。',
        '`.minds/**` 是 rtws（运行时工作区）的“团队配置/记忆/资产”目录：任何通用文件工具都无法访问（硬编码无条件拒绝）。只有专用的 `.minds/` 工具集（例如 `team_mgmt`）可访问它。',
        '说明：如果你在 `team.yaml` 的 allow-list（`read_dirs`/`write_dirs`）里写了 `.minds/**` 或 `*.tsk/**` 试图绕过限制，运行时会忽略并上报 err 级别问题。',
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小权限写法示例（仅示意）',
        'members:',
        '  coder:',
        '    read_dirs: ["dominds/**"]',
        '    write_dirs: ["dominds/**"]',
        '    no_read_dirs: [".minds/**"]',
        '    no_write_dirs: [".minds/**"]',
      ])
    );
  }
  return (
    fmtHeader('Directory Permissions (read_dirs / write_dirs)') +
    fmtList([
      'Fields: `read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`.',
      'Deny-lists (no_*) override allow-lists (*_dirs).',
      'If no allow-list is configured, access defaults to allow (after deny-list check). This is convenient but can be overly permissive; for least privilege, explicitly narrow allow-lists and deny sensitive directories.',
      '`read_dirs` and `write_dirs` are controlled independently (do not assume write implies read; follow current implementation).',
      'Patterns support `*` and `**` with directory-scope semantics (think directory/path-range matching).',
      'Example: `dominds/**` matches `dominds/README.md`, `dominds/main/server.ts`, `dominds/webapp/src/...`, etc.',
      'Example: `.minds/**` matches `.minds/team.yaml` and `.minds/team/<id>/persona.*.md`; commonly used to restrict normal members from minds assets.',
      '`*.tsk/` is an encapsulated Taskdoc: it must be maintained via the function tool `change_mind` only. It is hard-denied for all general file tools.',
      '`.minds/**` stores rtws (runtime workspace) team config/memory/assets: it is hard-denied for all general file tools. Only dedicated `.minds/`-scoped toolsets (e.g. `team_mgmt`) may access it.',
      'Note: If you try to whitelist `.minds/**` or `*.tsk/**` via `read_dirs`/`write_dirs`, the runtime ignores it and reports an error-level Problem.',
    ]) +
    fmtCodeBlock('yaml', [
      '# Least-privilege example (illustrative)',
      'members:',
      '  coder:',
      '    read_dirs: ["dominds/**"]',
      '    write_dirs: ["dominds/**"]',
      '    no_read_dirs: [".minds/**"]',
      '    no_write_dirs: [".minds/**"]',
    ])
  );
}

function renderMindsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team/<id>/*') +
      fmtList([
        '最小要求：每个 `members.<id>` 建议至少提供 `persona.*.md`（否则该成员将缺少可发现的角色设定；具体忽略/回退/报错行为以当前实现为准）。',
        'persona.*.md：角色设定（稳定的工作方式与职责）。',
        'knowledge.*.md：领域知识（可维护）。',
        'lessons.*.md：经验教训（可维护）。',
        '语言文件命名：优先按工作语言提供 `persona.zh.md` / `persona.en.md` 等；是否回退到 `persona.md`/其他语言版本，以当前实现为准。',
      ]) +
      fmtCodeBlock('text', [
        '.minds/',
        '  team/',
        '    qa_guard/',
        '      persona.zh.md',
        '      knowledge.zh.md',
        '      lessons.zh.md',
      ])
    );
  }
  return (
    fmtHeader('.minds/team/<id>/*') +
    fmtList([
      'Minimum: for each `members.<id>`, provide at least `persona.*.md` (otherwise the member may lack a discoverable persona; ignore/fallback/error behavior follows current implementation).',
      'persona.*.md: persona and operating style.',
      'knowledge.*.md: domain knowledge (maintainable).',
      'lessons.*.md: lessons learned (maintainable).',
      'Language variants: prefer working-language files like `persona.en.md` / `persona.zh.md`; whether it falls back to `persona.md` or other languages follows current implementation.',
    ]) +
    fmtCodeBlock('text', [
      '.minds/',
      '  team/',
      '    qa_guard/',
      '      persona.en.md',
      '      knowledge.en.md',
      '      lessons.en.md',
    ])
  );
}

function renderEnvManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/env.*.md（运行环境提示）') +
      fmtList([
        '用途：为“当前 rtws 的运行环境”提供一段稳定的介绍文案。Dominds 会将其注入到 agent 的 system prompt 中，注入位置在“团队目录（Team Directory）”之前。',
        '文件位置：写在当前 rtws 的 `.minds/` 下；切换 rtws（例如 `-C ux-rtws`）时，应在对应 rtws 的 `.minds/` 下分别维护。',
        '推荐文件名：`env.zh.md`（中文语义基准）与 `env.en.md`（英文对齐）。',
        '回退规则：优先按工作语言读取 `env.<lang>.md`；如不存在，可回退到 `env.md`（以当前实现为准）。空文件/仅空白会被当作“无提示”。',
        'i18n 约定：`zh` 为语义基准。不要把 `zh` 通过翻译 `en` 来更新；应让 `en` 追随 `zh` 的语义。',
        '管理者提醒：若发现缺失/质量不佳/与实际环境不符，应与人类用户讨论并确认措辞，然后再写入/更新对应的 `env.*.md`（避免“凭空编造”的环境描述）。',
      ]) +
      fmtCodeBlock('text', [
        '# 示例（片段；请按你的 rtws 真实环境改写）',
        '## 本 rtws 的 Dominds 运行环境说明',
        '',
        '- 本 rtws 用于 Dominds 自我开发与联调。',
        '- Dominds 程序来源：本机全局 link 的 `dominds`，由 `./dominds/` 构建产物提供。',
        '- WebUI dev/UX：`./dev-server.sh` 使用 `ux-rtws/` 作为 rtws（避免污染根 rtws）。',
      ])
    );
  }
  return (
    fmtHeader('.minds/env.*.md (runtime environment intro)') +
    fmtList([
      'Purpose: provide a stable intro note describing the “current rtws runtime environment”. Dominds injects it into the agent system prompt, positioned before “Team Directory”.',
      'Location: place it under the current rtws `.minds/`. If you switch rtws (e.g. `-C ux-rtws`), maintain a separate `env.*.md` under that rtws’s `.minds/`.',
      'Recommended filenames: `env.zh.md` (canonical semantics) and `env.en.md` (English aligned to zh).',
      'Fallback behavior: prefer `env.<lang>.md` by working language; if missing, it may fall back to `env.md` (per current implementation). Empty/whitespace-only content is treated as “no intro”.',
      'i18n rule: `zh` is canonical. Do not update `zh` by translating from `en`; update `en` to match `zh` semantics.',
      'Manager reminder: if the file is missing / inaccurate / low quality, discuss wording with the human user and then write/update `env.*.md` (avoid fabricating environment details).',
    ]) +
    fmtCodeBlock('text', [
      '# Example (snippet; tailor to your real rtws)',
      '## Dominds runtime environment notes',
      '',
      '- This rtws is used for Dominds self-development and integration.',
      '- Program source: a globally linked `dominds` built from `./dominds/`.',
      '- WebUI dev/UX: `./dev-server.sh` uses `ux-rtws/` as rtws (keeps root rtws clean).',
    ])
  );
}

function renderTroubleshooting(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('排障（症状 → 原因 → 解决步骤）') +
      fmtList([
        '改 provider/model 前总是先做：先用 `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })` 确认 key 是否存在，再运行 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })` 做可用性检查（env + 可选 live）。',
        '症状：提示“缺少 provider/model” → 原因：`member_defaults` 或成员覆盖缺失 → 步骤：检查 `.minds/team.yaml` 的 `member_defaults.provider/model`（以及 `members.<id>.provider/model` 是否写错）。',
        '症状：提示“Provider not found” → 原因：provider key 未定义/拼写错误/未按预期合并 defaults → 步骤：检查 `.minds/llm.yaml` 的 provider keys，并确认 `.minds/team.yaml` 引用的 key 存在。',
        '症状：提示“Model not found” → 原因：model key 未定义/拼写错误/不在该 provider 下 → 步骤：用 `team_mgmt_list_models({ provider_pattern: \"<providerKey>\", model_pattern: \"*\" })` 查已有模型 key，再修正 `.minds/team.yaml` 引用或补全 `.minds/llm.yaml`。',
        '症状：提示“permission denied / forbidden / not allowed” → 原因：目录权限（read/write/no_*）命中 deny-list 或未被 allow-list 覆盖 → 步骤：用 `team_mgmt_manual({ topics: [\"permissions\"] })` 复核规则，并检查该成员的 `read_dirs/write_dirs/no_*` 配置。',
        '症状：MCP 不生效 → 原因：mcp 配置错误/服务不可用/租用未释放 → 步骤：先运行 `team_mgmt_validate_mcp_cfg({})` 汇总错误；必要时用 `mcp_restart`；完成后用 `mcp_release` 释放租用。',
      ])
    );
  }
  return (
    fmtHeader('Troubleshooting (symptom → cause → steps)') +
    fmtList([
      'Before changing provider/model: use `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })` to confirm keys exist, then run `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })` for a readiness check (env + optional live).',
      'Symptom: "Missing provider/model" → Cause: missing `member_defaults` or member overrides → Steps: check `.minds/team.yaml` `member_defaults.provider/model` (and `members.<id>.provider/model`).',
      'Symptom: "Provider not found" → Cause: provider key not defined / typo / unexpected merge with defaults → Steps: check `.minds/llm.yaml` provider keys and ensure `.minds/team.yaml` references an existing key.',
      'Symptom: "Model not found" → Cause: model key not defined / typo / not under that provider → Steps: run `team_mgmt_list_models({ provider_pattern: \"<providerKey>\", model_pattern: \"*\" })` and fix `.minds/team.yaml` references or update `.minds/llm.yaml`.',
      'Symptom: "permission denied / forbidden / not allowed" → Cause: directory permissions (read/write/no_*) hit deny-list or not covered by allow-list → Steps: review `team_mgmt_manual({ topics: [\"permissions\"] })` and the member `read_dirs/write_dirs/no_*` config.',
      'Symptom: MCP not working → Cause: bad config / server down / leasing issues → Steps: run `team_mgmt_validate_mcp_cfg({})` first, then use `mcp_restart` if needed; call `mcp_release` when done.',
    ])
  );
}

async function renderModelParamsManual(language: LanguageCode): Promise<string> {
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

async function renderToolsets(language: LanguageCode): Promise<string> {
  const ids = Object.keys(listToolsets()).filter((id) => id !== 'control');
  const header =
    language === 'zh' ? fmtHeader('已注册 toolsets') : fmtHeader('Registered toolsets');

  const intro =
    language === 'zh'
      ? fmtList([
          '`control`：对话控制类工具属于“内建必备能力”，运行时会自动包含给所有成员；因此不需要（也不建议）在 `members.<id>.toolsets` 里显式列出，本页也默认不展示它。',
          '`diag`：诊断类工具集不应默认授予任何成员；仅当用户明确要求“诊断/排查/验证解析/流式分段”等能力时才添加。',
          '多数情况下推荐用 `members.<id>.toolsets` 做粗粒度授权；`members.<id>.tools` 更适合做少量补充/收敛。',
          '按 provider 选择匹配的 toolsets：默认把 `ws_read` / `ws_mod` 作为通用基线；当 `provider: codex`（偏 Codex CLI 风格提示/工具名）时，在基线上追加 `codex_style_tools`（`apply_patch` 等），不是替换 `ws_read` / `ws_mod`。如果还需要“读/探测 rtws”，通常要再给 `os`（`shell_cmd`）并严格限制在少数专员成员手里。',
          '最佳实践：把 `os`（尤其 `shell_cmd`）只授予具备良好纪律/风控意识的人设成员（例如 “cmdr/ops”）。对不具备 shell 工具的成员，系统提示会明确要求其将 shell 执行委派给这类专员，并提供可审查的命令提案与理由。',
          '常见三种模式（示例写在 `.minds/team.yaml` 的 `members.<id>.toolsets` 下）：',
        ])
      : fmtList([
          '`control`: dialog-control tools are intrinsic and automatically included for all members at runtime; you do not need (and should not) list it under `members.<id>.toolsets`. It is omitted from the list below.',
          '`diag`: diagnostics tools should not be granted by default; only add it when the user explicitly asks for diagnostics/troubleshooting/streaming-parse verification.',
          'Typically use `members.<id>.toolsets` for coarse-grained access; use `members.<id>.tools` for a small number of additions/limits.',
          'Pick toolsets to match the provider: keep `ws_read` / `ws_mod` as the general baseline; for `provider: codex` (Codex CLI-style prompts/tool names), add `codex_style_tools` (`apply_patch`, etc.) on top rather than replacing `ws_read` / `ws_mod`. If you also need to read/probe the rtws, you typically must grant `os` (`shell_cmd`) and keep it restricted to a small number of specialist operators.',
          'Best practice: grant `os` (especially `shell_cmd`) only to a disciplined, risk-aware operator persona (e.g. “cmdr/ops”). For members without shell tools, the system prompt explicitly tells them to delegate shell execution to such a specialist, with a reviewable command proposal and justification.',
          'Three common patterns (in `.minds/team.yaml` under `members.<id>.toolsets`):',
        ]);

  const patterns = fmtCodeBlock('yaml', [
    '# Recommended: explicit allow-list (most common)',
    'toolsets:',
    '  - ws_read',
    '  - ws_mod',
    '  - codex_style_tools',
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

  const list = fmtList(ids.map((id) => `\`${id}\``));
  return header + intro + patterns + '\n' + list;
}

async function renderBuiltinDefaults(language: LanguageCode): Promise<string> {
  const header =
    language === 'zh'
      ? fmtHeader('内置 LLM Defaults（摘要）')
      : fmtHeader('Built-in LLM Defaults (summary)');
  const body = await loadBuiltinLlmDefaultsText();

  const explain =
    language === 'zh'
      ? fmtList([
          '这份列表来自 Dominds 内置的 LLM defaults（实现内置）。当你没有在 `.minds/llm.yaml` 里显式覆盖某些 provider/model key 时，这些 defaults 可能会生效（以当前实现的合并规则为准）。',
          '在 `.minds/llm.yaml` 里新增/覆盖 provider key，通常只会影响同名 key 的解析，不表示“禁用其他内置 provider”。建议用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })` 验证配置。',
        ])
      : fmtList([
          'This list comes from Dominds built-in LLM defaults (implementation-provided). If you do not explicitly override certain provider/model keys in `.minds/llm.yaml`, these defaults may be used (per current merge rules).',
          'Adding/overriding a provider key in `.minds/llm.yaml` typically affects that key only; it does not imply disabling other built-in providers. Use `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })` to verify.',
        ]);

  return header + explain + '\n' + body + '\n';
}

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
  async call(dlg, _caller, _args: ToolArguments): Promise<string> {
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

      // Team.load() is fail-open (always returns a usable team) and publishes any team.yaml issues
      // to the Problems panel.
      await Team.load();

      // Non-blocking style lint (keeps team.yaml readable).
      await lintTeamYamlStyleProblems();

      const snapshot = getProblemsSnapshot();
      const teamProblems = listTeamYamlProblems(snapshot.problems);

      if (teamProblems.length === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('team.yaml 校验通过') +
              fmtList([
                `\`${TEAM_YAML_REL}\`：✅ 未检测到问题`,
                '提示：每次修改 team.yaml 后都应运行本工具，避免“坏成员配置被静默跳过”。',
              ])
            : fmtHeader('team.yaml Validation Passed') +
              fmtList([
                `\`${TEAM_YAML_REL}\`: ✅ no issues detected`,
                'Tip: run this after every team.yaml change to avoid silent omission of broken members.',
              ]);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const issueLines: string[] = [];
      for (const p of teamProblems) {
        issueLines.push(`- ${p.id}: ${p.message}`);
        issueLines.push('  ' + p.detail.errorText.split('\n').join('\n  '));
      }

      const msg =
        language === 'zh'
          ? fmtHeader('team.yaml 校验失败') +
            fmtList([
              `\`${TEAM_YAML_REL}\`：❌ 检测到 ${teamProblems.length} 个问题（详见 Problems 面板）`,
              '说明：坏的成员配置可能会在运行时被跳过或在使用时失败（为了保持 Team 可用），但你仍应立即修复以免行为偏离预期。',
            ]) +
            '\n' +
            issueLines.join('\n')
          : fmtHeader('team.yaml Validation Failed') +
            fmtList([
              `\`${TEAM_YAML_REL}\`: ❌ ${teamProblems.length} issue(s) detected (see Problems panel)`,
              'Note: invalid member configs may be omitted at runtime or fail when used (to keep the Team usable), but you should fix them immediately.',
            ]) +
            '\n' +
            issueLines.join('\n');

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
  async call(dlg, _caller, _args: ToolArguments): Promise<string> {
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
        fallbackInvalidServers = parsed.invalidServers;
      } catch (err: unknown) {
        if (!(isFsErrWithCode(err) && err.code === 'ENOENT')) {
          throw err;
        }
      }

      const snapshot = getProblemsSnapshot();
      const mcpProblems = listMcpYamlProblems(snapshot.problems);
      const fallbackOnlyInvalidServers: Array<{ serverId: string; errorText: string }> = [];
      for (const s of fallbackInvalidServers) {
        const hasMatchingProblem = mcpProblems.some(
          (p) => p.kind === 'mcp_server_error' && p.detail.serverId === s.serverId,
        );
        if (!hasMatchingProblem) {
          fallbackOnlyInvalidServers.push(s);
        }
      }

      if (mcpProblems.length === 0 && fallbackOnlyInvalidServers.length === 0) {
        const msg =
          language === 'zh'
            ? fmtHeader('mcp.yaml 校验通过') +
              fmtList([
                mcpRaw === null
                  ? `\`${MCP_YAML_REL}\`：✅ 未发现（按空配置处理）`
                  : `\`${MCP_YAML_REL}\`：✅ 未检测到问题（已声明 ${declaredServerCount} 个 server）`,
                '提示：每次修改 mcp.yaml 后都应运行本工具，确认 MCP 相关问题已清空。',
              ])
            : fmtHeader('mcp.yaml Validation Passed') +
              fmtList([
                mcpRaw === null
                  ? `\`${MCP_YAML_REL}\`: ✅ not found (treated as empty config)`
                  : `\`${MCP_YAML_REL}\`: ✅ no issues detected (${declaredServerCount} declared server(s))`,
                'Tip: run this after every mcp.yaml change to confirm MCP problems are cleared.',
              ]);
        return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
      }

      const issueLines: string[] = [];
      for (const p of mcpProblems) {
        issueLines.push(`- [${p.severity}] ${p.id}: ${p.message}`);
        switch (p.kind) {
          case 'mcp_workspace_config_error':
            issueLines.push(`  file: ${p.detail.filePath}`);
            issueLines.push('  ' + p.detail.errorText.split('\n').join('\n  '));
            break;
          case 'mcp_server_error':
            issueLines.push(`  serverId: ${p.detail.serverId}`);
            issueLines.push('  ' + p.detail.errorText.split('\n').join('\n  '));
            break;
          case 'mcp_tool_collision':
            issueLines.push(
              language === 'zh'
                ? `  serverId=${p.detail.serverId}, tool=${p.detail.toolName}, 冲突目标=${p.detail.domindsToolName}`
                : `  serverId=${p.detail.serverId}, tool=${p.detail.toolName}, collides_with=${p.detail.domindsToolName}`,
            );
            break;
          case 'mcp_tool_blacklisted':
            issueLines.push(
              `  serverId=${p.detail.serverId}, tool=${p.detail.toolName}, pattern=${p.detail.pattern}`,
            );
            break;
          case 'mcp_tool_not_whitelisted':
            issueLines.push(
              `  serverId=${p.detail.serverId}, tool=${p.detail.toolName}, pattern=${p.detail.pattern}`,
            );
            break;
          case 'mcp_tool_invalid_name':
            issueLines.push(
              `  serverId=${p.detail.serverId}, tool=${p.detail.toolName}, rule=${p.detail.rule}`,
            );
            break;
          default: {
            const _exhaustive: never = p;
            void _exhaustive;
          }
        }
      }
      for (const s of fallbackOnlyInvalidServers) {
        issueLines.push(`- [error] ${MCP_SERVER_PROBLEM_PREFIX}${s.serverId}/server_error`);
        issueLines.push(`  serverId: ${s.serverId}`);
        issueLines.push('  ' + s.errorText.split('\n').join('\n  '));
      }

      const totalIssues = mcpProblems.length + fallbackOnlyInvalidServers.length;
      const msg =
        language === 'zh'
          ? fmtHeader('mcp.yaml 校验失败') +
            fmtList([
              `\`${MCP_YAML_REL}\`：❌ 检测到 ${totalIssues} 个问题（详见 Problems 面板）`,
              '说明：MCP 配置问题会导致 server/toolset 加载失败、部分工具不可用或运行时异常。',
            ]) +
            '\n' +
            issueLines.join('\n')
          : fmtHeader('mcp.yaml Validation Failed') +
            fmtList([
              `\`${MCP_YAML_REL}\`: ❌ ${totalIssues} issue(s) detected (see Problems panel)`,
              'Note: MCP config issues can block server/toolset loading and cause runtime tool failures.',
            ]) +
            '\n' +
            issueLines.join('\n');
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

export const teamMgmtManualTool: FuncTool = {
  type: 'func',
  name: 'team_mgmt_manual',
  description: `Team management manual for ${MINDS_DIR}/.`,
  descriptionI18n: {
    en: `Team management manual for ${MINDS_DIR}/.`,
    zh: `${MINDS_DIR}/ 的团队管理手册。`,
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      topics: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Manual topics to render. Empty/omitted renders the index. Examples: ["team"], ["team","member-properties"].',
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg, _caller, args: ToolArguments): Promise<string> {
    const language = getUserLang(dlg);
    const topicsValue = args['topics'];
    const topicsRaw: string[] =
      topicsValue === undefined
        ? []
        : Array.isArray(topicsValue) && topicsValue.every((v) => typeof v === 'string')
          ? topicsValue
          : (() => {
              throw new Error('Invalid topics (expected string[])');
            })();

    const topics: ManualTopic[] = [];
    for (const token0 of topicsRaw) {
      const token = token0.trim().startsWith('!') ? token0.trim().slice(1) : token0.trim();
      if (token === '') continue;
      if (isTeamMgmtManualTopicKey(token)) {
        topics.push(token);
        continue;
      }
      throw new Error(`Unknown topic: ${token0}`);
    }
    const msgPrefix =
      language === 'zh'
        ? `（生成时间：${formatUnifiedTimestamp(new Date())}）\n\n`
        : `(Generated: ${formatUnifiedTimestamp(new Date())})\n\n`;

    const renderIndex = (): string => {
      const topicTitle = (key: TeamMgmtManualTopicKey): string =>
        getTeamMgmtManualTopicTitle(language, key);
      if (language === 'zh') {
        return (
          fmtHeader('Team Management Manual') +
          msgPrefix +
          fmtList([
            `\`team_mgmt_manual({ topics: ["topics"] })\`：${topicTitle('topics')}（你在这里）`,
            '新手最常见流程：先 `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: "*", model_pattern: "*" })` 确认 provider/model keys → 再写 `.minds/team.yaml` → 再写 `.minds/team/<id>/persona.*.md` → 再跑 `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false, max_models: 0 })`。',
            '',
            `\`team_mgmt_manual({ topics: ["team"] })\`：${topicTitle('team')} — .minds/team.yaml（团队花名册、工具集、目录权限入口）`,
            `\`team_mgmt_manual({ topics: ["minds"] })\`：${topicTitle('minds')} — .minds/team/<id>/*（persona/knowledge/lessons 资产怎么写）`,
            `\`team_mgmt_manual({ topics: ["env"] })\`：${topicTitle('env')} — .minds/env.*.md（运行环境提示：在团队介绍之前注入）`,
            `\`team_mgmt_manual({ topics: ["permissions"] })\`：${topicTitle('permissions')} — 目录权限（read_dirs/write_dirs/no_* 语义与冲突规则）`,
            `\`team_mgmt_manual({ topics: ["toolsets"] })\`：${topicTitle('toolsets')} — toolsets 列表（当前已注册 toolsets；常见三种授权模式）`,
            `\`team_mgmt_manual({ topics: ["llm"] })\`：${topicTitle('llm')} — .minds/llm.yaml（provider key 如何定义/引用；env var 安全边界）`,
            `\`team_mgmt_manual({ topics: ["mcp"] })\`：${topicTitle('mcp')} — .minds/mcp.yaml（MCP serverId→toolset；热重载与租用；可复制最小模板）`,
            `\`team_mgmt_manual({ topics: ["troubleshooting"] })\`：${topicTitle('troubleshooting')} — 按症状定位；优先 list_providers/list_models → check_provider`,
            '',
            `\`team_mgmt_manual({ topics: ["team","member-properties"] })\`：${topicTitle('team')} + ${topicTitle('member-properties')} — 成员字段表（members.<id> 字段参考）`,
            `\`team_mgmt_manual({ topics: ["llm","builtin-defaults"] })\`：${topicTitle('llm')} + ${topicTitle('builtin-defaults')} — 内置 defaults 摘要（内置 provider/model 概览与合并语义）`,
            `\`team_mgmt_manual({ topics: ["llm","model-params"] })\`：${topicTitle('llm')} + ${topicTitle('model-params')} — 模型参数参考（model_params / model_param_options）`,
          ])
        );
      }
      return (
        fmtHeader('Team Management Manual') +
        msgPrefix +
        fmtList([
          `\`team_mgmt_manual({ topics: ["topics"] })\`: ${topicTitle('topics')} (you are here)`,
          'Common starter flow: run `team_mgmt_list_providers({})` / `team_mgmt_list_models({ provider_pattern: \"*\", model_pattern: \"*\" })` to confirm provider/model keys → write `.minds/team.yaml` → write `.minds/team/<id>/persona.*.md` → run `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false, max_models: 0 })`. ',
          '',
          `\`team_mgmt_manual({ topics: ["team"] })\`: ${topicTitle('team')} — .minds/team.yaml (roster/toolsets/permissions entrypoint)`,
          `\`team_mgmt_manual({ topics: ["minds"] })\`: ${topicTitle('minds')} — .minds/team/<id>/* (persona/knowledge/lessons assets)`,
          `\`team_mgmt_manual({ topics: ["env"] })\`: ${topicTitle('env')} — .minds/env.*.md (runtime intro injected before Team Directory)`,
          `\`team_mgmt_manual({ topics: ["permissions"] })\`: ${topicTitle('permissions')} — directory permissions (semantics + conflict rules)`,
          `\`team_mgmt_manual({ topics: ["toolsets"] })\`: ${topicTitle('toolsets')} — toolsets list (registered toolsets + common patterns)`,
          `\`team_mgmt_manual({ topics: ["llm"] })\`: ${topicTitle('llm')} — .minds/llm.yaml (provider keys, env var boundaries)`,
          `\`team_mgmt_manual({ topics: ["mcp"] })\`: ${topicTitle('mcp')} — .minds/mcp.yaml (serverId→toolset, hot reload, leasing, minimal templates)`,
          `\`team_mgmt_manual({ topics: ["troubleshooting"] })\`: ${topicTitle('troubleshooting')} — symptom → steps; start with list_providers/list_models, then check_provider`,
          '',
          `\`team_mgmt_manual({ topics: ["team","member-properties"] })\`: ${topicTitle('team')} + ${topicTitle('member-properties')} — member field reference (members.<id>)`,
          `\`team_mgmt_manual({ topics: ["llm","builtin-defaults"] })\`: ${topicTitle('llm')} + ${topicTitle('builtin-defaults')} — built-in defaults summary (what/when/merge behavior)`,
          `\`team_mgmt_manual({ topics: ["llm","model-params"] })\`: ${topicTitle('llm')} + ${topicTitle('model-params')} — \`model_params\` and \`model_param_options\` reference`,
        ])
      );
    };

    const want = (t: ManualTopic): boolean => topics.includes(t);

    try {
      if (topics.length === 0) {
        const content = renderIndex();
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('topics')) {
        const content = renderIndex();
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('team') && want('member-properties')) {
        const content = renderMemberProperties(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('team')) {
        const content = renderTeamManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('llm') && want('builtin-defaults')) {
        const content = await renderBuiltinDefaults(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('llm') && want('model-params')) {
        const content = await renderModelParamsManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('llm')) {
        const llmText =
          language === 'zh'
            ? fmtHeader('.minds/llm.yaml') +
              fmtList([
                '定义 provider key → model 映射（用于 `.minds/team.yaml` 的 `member_defaults.provider` / `members.<id>.provider` 引用）。',
                '快速自检：用 `team_mgmt_list_providers({})` 列出内置/rtws provider keys、env var 是否配置；用 `team_mgmt_list_models({ source: \"effective\", provider_pattern: \"*\", model_pattern: \"*\" })` 列出“合并后”的模型与 `model_param_options`。',
                '最小示例：\n```yaml\nproviders:\n  my_provider:\n    apiKeyEnvVar: MY_PROVIDER_API_KEY\n    models:\n      my_model: { name: "my-model-id" }\n```\n然后在 `.minds/team.yaml` 里引用 `provider: my_provider` / `model: my_model`。',

                '覆盖/合并语义：`.minds/llm.yaml` 会在内置 defaults 之上做覆盖（以当前实现为准）；定义一个 provider key 并不意味着“禁用其他内置 provider”。',

                '不要在文件里存 API key，使用环境变量（apiKeyEnvVar）。',
                'member_defaults.provider/model 需要引用这里的 key。',
                '`model_param_options` 可选：用于记录该 provider 支持的 `.minds/team.yaml model_params` 选项（文档用途）。',
              ])
            : fmtHeader('.minds/llm.yaml') +
              fmtList([
                'Defines provider keys → model keys (referenced by `.minds/team.yaml` via `member_defaults.provider` / `members.<id>.provider`).',
                'Quick checks: use `team_mgmt_list_providers({})` to list built-in/rtws providers + env-var readiness; use `team_mgmt_list_models({ source: \"effective\", provider_pattern: \"*\", model_pattern: \"*\" })` to list merged models and `model_param_options`.',
                'Minimal example:\n```yaml\nproviders:\n  my_provider:\n    apiKeyEnvVar: MY_PROVIDER_API_KEY\n    models:\n      my_model: { name: "my-model-id" }\n```\nThen reference `provider: my_provider` and `model: my_model` in `.minds/team.yaml`.',

                'Merge/override: `.minds/llm.yaml` overrides built-in defaults (per current implementation); defining one provider does not imply disabling other built-in providers.',

                'Do not store API keys in the file; use env vars via apiKeyEnvVar.',
                'member_defaults.provider/model must reference these keys.',
                'Optional: `model_param_options` documents `.minds/team.yaml model_params` knobs (documentation only).',
              ]);
        return ok(llmText, [{ type: 'environment_msg', role: 'user', content: llmText }]);
      }
      if (want('mcp')) {
        const content = renderMcpManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('minds')) {
        const content = renderMindsManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('env')) {
        const content = renderEnvManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('permissions')) {
        const content = renderPermissionsManual(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('toolsets')) {
        const content = await renderToolsets(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (want('troubleshooting')) {
        const content = renderTroubleshooting(language);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const content = renderIndex();
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (err: unknown) {
      const content =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const teamMgmtTools: ReadonlyArray<FuncTool> = [
  teamMgmtManualTool,
  teamMgmtCheckProviderTool,
  teamMgmtListProvidersTool,
  teamMgmtListModelsTool,
  teamMgmtValidateTeamCfgTool,
  teamMgmtValidateMcpCfgTool,
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
