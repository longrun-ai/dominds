/**
 * Module: tools/team-mgmt
 *
 * Team management tooling scoped strictly to `.minds/**`.
 *
 * Goals:
 * - Allow a dedicated team manager (e.g. a shadow/hidden member) to manage `.minds/` without granting
 *   broad workspace permissions (e.g. `ws_mod`).
 * - Enforce static scoping to `.minds/**` and reject anything outside that subtree.
 */

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import type { ChatMessage } from '../llm/client';
import { LlmConfig } from '../llm/client';
import type { LlmStreamReceiver } from '../llm/gen';
import { getLlmGenerator } from '../llm/gen/registry';
import { getProblemsSnapshot } from '../problems';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { WorkspaceProblem } from '../shared/types/problems';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { FuncTool, ToolArguments } from '../tool';
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

function ok(result: string, messages?: ChatMessage[]): string {
  void messages;
  return result;
}

function fail(result: string, messages?: ChatMessage[]): string {
  void messages;
  return result;
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
      `注意：当前工作区未初始化 \`${MINDS_DIR}/\`（这是正常情况）。`,
      `因此当前在 \`${MINDS_DIR}/\` 下没有可读取/可列出的团队配置。`,
      ``,
      `如果要初始化团队配置，请先创建目录：\`team_mgmt_mk_dir({ \"path\": \"${MINDS_DIR}\", \"parents\": true })\`。`,
    ].join('\n');
  }
  return [
    `Note: \`${MINDS_DIR}/\` is not present in this workspace (this is normal).`,
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

type ModelCheckResult = { model: string; status: 'pass' | 'fail'; details?: string };

function formatModelCheckResult(r: ModelCheckResult): string {
  if (r.status === 'pass') return `- ${r.model}: ✅ ok`;
  return `- ${r.model}: ❌ ${r.details ?? 'failed'}`;
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
            ? `Provider 不存在：\`${providerKey}\`。请检查 \`.minds/llm.yaml\`（或内置 defaults）。`
            : `Provider not found: \`${providerKey}\`. Check \`.minds/llm.yaml\` (or built-in defaults).`;
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
            ? `Model 不存在：\`${model}\` 不在 provider \`${providerKey}\` 的 models 列表中。请先更新 \`.minds/llm.yaml\` 或选择一个已配置的 model key。`
            : `Model not found: \`${model}\` is not in provider \`${providerKey}\` models. Update \`.minds/llm.yaml\` or choose a configured model key.`;
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
                  ? 'tool call emitted'
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
      const content = await listDirTool.call(dlg, proxyCaller, { path: rel });
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
      const content = await readFileTool.call(dlg, proxyCaller, {
        path: rel,
        ...(range ? { range } : {}),
        ...(maxLines !== undefined ? { max_lines: maxLines } : {}),
        ...(showLinenos !== undefined ? { show_linenos: showLinenos } : {}),
      });
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
  description: `Create a new file under ${MINDS_DIR}/ (no preview/apply). Refuses to overwrite existing files.`,
  descriptionI18n: {
    en: `Create a new file under ${MINDS_DIR}/ (no preview/apply). Refuses to overwrite existing files.`,
    zh: `在 ${MINDS_DIR}/ 下创建一个新文件（不走 preview/apply）。若文件已存在则拒绝覆写。`,
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
      const result = await overwriteEntireFileTool.call(dlg, proxyCaller, {
        path: rel,
        known_old_total_lines: knownLinesValue,
        known_old_total_bytes: knownBytesValue,
        content: contentValue,
        ...(contentFormat ? { content_format: contentFormat } : {}),
      });
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

      const content = await prepareFileAppendTool.call(dlg, proxyCaller, {
        path: rel,
        ...(create !== undefined ? { create } : {}),
        ...(existingHunkId ? { existing_hunk_id: existingHunkId } : {}),
        content: contentValue,
      });
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

      const content = await prepareFileInsertAfterTool.call(dlg, proxyCaller, {
        path: rel,
        anchor,
        ...(occurrenceValue !== undefined ? { occurrence: occurrenceValue } : {}),
        ...(matchValue !== undefined ? { match: matchValue } : {}),
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        content: contentValue,
      });
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

      const content = await prepareFileInsertBeforeTool.call(dlg, proxyCaller, {
        path: rel,
        anchor,
        ...(occurrenceValue !== undefined ? { occurrence: occurrenceValue } : {}),
        ...(matchValue !== undefined ? { match: matchValue } : {}),
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        content: contentValue,
      });
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

      const content = await prepareFileBlockReplaceTool.call(dlg, proxyCaller, {
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
      const content = await prepareFileRangeEditTool.call(dlg, proxyCaller, {
        path: rel,
        range: rangeSpec,
        ...(existingHunkIdValue ? { existing_hunk_id: existingHunkIdValue } : {}),
        ...(typeof contentValue === 'string' ? { content: contentValue } : {}),
      });
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
      const content = await applyFileModificationTool.call(dlg, proxyCaller, { hunk_id: id });
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
      const content = await mkDirTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await moveFileTool.call(dlg, proxyCaller, { from: fromRel, to: toRel });
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
      const content = await moveDirTool.call(dlg, proxyCaller, { from: fromRel, to: toRel });
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
      const content = await ripgrepFilesTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await ripgrepSnippetsTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await ripgrepCountTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await ripgrepFixedTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await ripgrepSearchTool.call(dlg, proxyCaller, toolArgs);
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
      const content = await rmFileTool.call(dlg, proxyCaller, { path: rel });
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
      const content = await rmDirTool.call(dlg, proxyCaller, toolArgs);
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

type ManualTopic =
  | 'topics'
  | 'llm'
  | 'model-params'
  | 'mcp'
  | 'team'
  | 'minds'
  | 'permissions'
  | 'troubleshooting'
  | 'toolsets'
  | 'member-properties'
  | 'builtin-defaults';

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

      const extras: string[] = [];
      if (type) extras.push(type);
      if (values && values.length > 0) extras.push(values.join('|'));
      if (min !== undefined || max !== undefined) {
        extras.push(`${min !== undefined ? min : ''}..${max !== undefined ? max : ''}`.trim());
      }

      parts.push(extras.length > 0 ? `${paramName} (${extras.join(', ')})` : paramName);
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
  if (language === 'zh') {
    return (
      fmtHeader('成员字段（members.<id>）') +
      fmtList([
        '`name` / `icon` / `gofor`',
        '`gofor`：该长期 agent 的职责速记卡（建议 5 行内），用于快速路由/提醒：写清“负责什么 / 不负责什么 / 主要交付物 / 优先级”。推荐用 YAML list（3–6 条）；也支持 YAML object（单对象多键值，value 必须是 string），string 仅适合单句。对象的渲染顺序跟 YAML key 写入顺序一致（当前实现/依赖）。详细规范请写入 `.minds/team/<id>/*` 或 `.minds/team/domains/*.md` 等 Markdown 资产。',
        '`provider` / `model` / `model_params`',
        '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
        '`streaming`',
        '`hidden`（影子/隐藏成员：不出现在系统提示的团队目录里，但仍可被诉请）',
        '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`（冲突规则见 `team_mgmt_manual({ topics: ["permissions"] })`；read 与 write 是独立控制，别默认 write implies read）',
      ])
    );
  }
  return (
    fmtHeader('Member Properties (members.<id>)') +
    fmtList([
      '`name` / `icon` / `gofor`',
      '`gofor`: a short responsibility flashcard (≤ 5 lines) for a long-lived agent; use it for fast routing/reminders (owns / does-not-own / key deliverables / priorities). Prefer a YAML list (3–6 items); YAML object is also allowed (single object with multiple keys, string values only). Object rendering order follows the YAML key order (implementation-dependent). Use a string only for a single sentence. Put detailed specs in Markdown assets like `.minds/team/<id>/*` or `.minds/team/domains/*.md`.',
      '`provider` / `model` / `model_params`',
      '`toolsets` / `tools`（两者可同时配置；多数情况下推荐用 toolsets 做粗粒度授权，用 tools 做少量补充/收敛。具体冲突/合并规则以当前实现为准）',
      '`streaming`',
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
    'do not write built-in members (e.g. fuxi/pangu) into `.minds/team.yaml` (define only workspace members)',
    'hidden: true marks a shadow member (not listed in system prompt)',
    "toolsets supports '*' and '!<toolset>' exclusions (e.g. ['*','!team-mgmt'])",
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

        '成员配置通过 prototype 继承 `member_defaults`（省略字段会继承默认值）。',
        '修改 provider/model 前请务必确认该 provider 可用（至少 env var 已配置）。可用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` 做检查，避免把系统刷成板砖。',
        '不要把内置成员（例如 `fuxi` / `pangu`）的定义写入 `.minds/team.yaml`（这里只定义工作区自己的成员）：内置成员通常带有特殊权限/目录访问边界；重复定义可能引入冲突、权限误配或行为不一致。',
        '`hidden: true` 表示影子/隐藏成员：不会出现在系统提示的团队目录里，但仍然可以 `!?@<id>` 诉请。',
        '`toolsets` 支持 `*` 与 `!<toolset>` 排除项（例如 `[* , !team-mgmt]`）。',
        '修改文件推荐流程：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` 定位行号；小改动用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` 生成 diff（工具会返回 hunk_id），再用 `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })` 显式确认写入；如需修订同一个预览，可再次调用 `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` 覆写；如确实需要整文件覆盖：先 `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` 从 YAML header 获取 total_lines/size_bytes，再用 `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`。',
        '部署/组织建议（可选）：如果你不希望出现显在“团队管理者”，可由一个影子/隐藏成员持有 `team-mgmt` 负责维护 `.minds/**`（尤其 `team.yaml`），由人类在需要时触发其执行（例如初始化/调整权限/更新模型）。Dominds 不强制这种组织方式；你也可以让显在成员拥有 `team-mgmt` 或由人类直接维护文件。',
      ]) +
      '\n' +
      '最小模板：\n' +
      '```yaml\n' +
      '# 这里只放工作区自己的成员；不要把内置成员（例如 fuxi/pangu）写进来。\n' +
      'member_defaults:\n' +
      '  provider: codex\n' +
      '  model: gpt-5.2\n' +
      '\n' +
      'default_responder: primary\n' +
      '\n' +
      'members:\n' +
      '  team_manager:\n' +
      '    hidden: true\n' +
      "    toolsets: ['team-mgmt']\n" +
      '  primary:\n' +
      '    hidden: true\n' +
      "    toolsets: ['*', '!team-mgmt']\n" +
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
        'Deployment/org suggestion (optional): if you do not want a visible team manager, keep `team-mgmt` only on a hidden/shadow member and have a human trigger it when needed; Dominds does not require this organizational setup.',
        'Recommended editing workflow: use `team_mgmt_read_file({ path: \"team.yaml\", range: \"<start~end>\", max_lines: 0, show_linenos: true })` to find line numbers; for small edits, run `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"\", content: \"<new content>\" })` to get a diff (the tool returns hunk_id), then confirm with `team_mgmt_apply_file_modification({ hunk_id: \"<hunk_id>\" })`; to revise the same preview, call `team_mgmt_prepare_file_range_edit({ path: \"team.yaml\", range: \"<line~range>\", existing_hunk_id: \"<hunk_id>\", content: \"<new content>\" })` again; if you truly need a full overwrite: first `team_mgmt_read_file({ path: \"team.yaml\", range: \"\", max_lines: 0, show_linenos: true })` and read total_lines/size_bytes from the YAML header, then use `team_mgmt_overwrite_entire_file({ path: \"team.yaml\", known_old_total_lines: <n>, known_old_total_bytes: <n>, content_format: \"\", content: \"...\" })`.',
      ]),
    ) +
    '\n' +
    'Minimal template:\n' +
    '```yaml\n' +
    '# Define only workspace members here (do not copy built-in members like fuxi/pangu).\n' +
    'member_defaults:\n' +
    '  provider: codex\n' +
    '  model: gpt-5.2\n' +
    '\n' +
    'default_responder: primary\n' +
    '\n' +
    'members:\n' +
    '  team_manager:\n' +
    '    hidden: true\n' +
    "    toolsets: ['team-mgmt']\n" +
    '  primary:\n' +
    '    hidden: true\n' +
    "    toolsets: ['*', '!team-mgmt']\n" +
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
        '用 `tools.whitelist/blacklist` 控制暴露的工具，用 `transform` 做命名变换。',
        '常见坑：stdio transport 需要可执行命令路径/工作目录正确，且受成员目录权限（`read_dirs/write_dirs/no_*`）约束；HTTP transport 需要服务可达（url/端口/网络）。',
        '高频坑（stdio 路径）：相对路径会受 `cwd` 影响而失败；推荐用绝对路径，或显式设置 `cwd` 来固定相对路径的解析。',
        '最小诊断流程（建议顺序）：1) 先用 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` 确认 LLM provider 可用；2) 再检查该成员的目录权限（`team_mgmt_manual({ topics: [\"permissions\"] })`）；3) 最后检查 MCP 侧报错（Problems 面板/相关日志提示），必要时 `mcp_restart`，用完记得 `mcp_release`。',
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小模板（stdio）',
        'version: 1',
        'servers:',
        '  sdk_stdio:',
        '    truely-stateless: false',
        '    transport: stdio',
        '    command: ["node", "./path/to/mcp-server.js"]',
        '    cwd: "./"',
        '    env: {}',
        '    tools: { whitelist: [], blacklist: [] }',
        '    transform: []',
      ]) +
      fmtCodeBlock('yaml', [
        '# stdio 路径示例（最小）',
        '# 相对路径：cwd 变化会失败',
        'command: ["node", "./mcp/server.js"]',
        'cwd: "/absolute/path/to/project"',
        '',
        '# 绝对路径：不依赖 cwd',
        'command: ["node", "/absolute/path/to/mcp/server.js"]',
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
      'Use `tools.whitelist/blacklist` for exposure control and `transform` for naming transforms.',
      'Common pitfalls: stdio transport needs a correct executable/command path and working directory, and is subject to member directory permissions (`read_dirs/write_dirs/no_*`); HTTP transport requires the server URL to be reachable.',
      'High-frequency pitfall (stdio paths): relative paths depend on `cwd` and can break; prefer absolute paths, or set `cwd` explicitly to make relative paths stable.',
      'Minimal diagnostic flow: 1) run `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: false, max_models: 0 })` to confirm the LLM provider works; 2) review member directory permissions (`team_mgmt_manual({ topics: [\"permissions\"] })`); 3) check MCP-side errors (Problems panel / logs), use `mcp_restart` if needed, and `mcp_release` when done.',
    ]) +
    fmtCodeBlock('yaml', [
      '# Minimal template (stdio)',
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    truely-stateless: false',
      '    transport: stdio',
      '    command: ["node", "./path/to/mcp-server.js"]',
      '    cwd: "./"',
      '    env: {}',
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
    ]) +
    fmtCodeBlock('yaml', [
      '# stdio path example (minimal)',
      '# Relative path: depends on cwd',
      'command: ["node", "./mcp/server.js"]',
      'cwd: "/absolute/path/to/project"',
      '',
      '# Absolute path: independent of cwd',
      'command: ["node", "/absolute/path/to/mcp/server.js"]',
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
        '`*.tsk/` 是封装差遣牒：只能用函数工具 `change_mind` 维护。通用文件工具（read/list/replace/rm/preview/apply）必须禁止访问该目录树。',
      ]) +
      fmtCodeBlock('yaml', [
        '# 最小权限写法示例（仅示意）',
        'members:',
        '  coder:',
        '    read_dirs: ["dominds/**"]',
        '    write_dirs: ["dominds/**"]',
        '    no_read_dirs: [".minds/**", "*.tsk/**"]',
        '    no_write_dirs: [".minds/**", "*.tsk/**"]',
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
      '`*.tsk/` is an encapsulated Task Doc: it must be maintained via the function tool `change_mind` only. General file tools (read/list/replace/rm/preview/apply) must be blocked from that directory tree.',
    ]) +
    fmtCodeBlock('yaml', [
      '# Least-privilege example (illustrative)',
      'members:',
      '  coder:',
      '    read_dirs: ["dominds/**"]',
      '    write_dirs: ["dominds/**"]',
      '    no_read_dirs: [".minds/**", "*.tsk/**"]',
      '    no_write_dirs: [".minds/**", "*.tsk/**"]',
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

function renderTroubleshooting(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('排障（症状 → 原因 → 解决步骤）') +
      fmtList([
        '改 provider/model 前总是先做：运行 `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })`，确认 provider key 存在且环境变量已配置。',
        '症状：提示“缺少 provider/model” → 原因：`member_defaults` 或成员覆盖缺失 → 步骤：检查 `.minds/team.yaml` 的 `member_defaults.provider/model`（以及 `members.<id>.provider/model` 是否写错）。',
        '症状：提示“Provider not found” → 原因：provider key 未定义/拼写错误/未按预期合并 defaults → 步骤：检查 `.minds/llm.yaml` 的 provider keys，并确认 `.minds/team.yaml` 引用的 key 存在。',
        '症状：提示“permission denied / forbidden / not allowed” → 原因：目录权限（read/write/no_*）命中 deny-list 或未被 allow-list 覆盖 → 步骤：用 `team_mgmt_manual({ topics: [\"permissions\"] })` 复核规则，并检查该成员的 `read_dirs/write_dirs/no_*` 配置。',
        '症状：MCP 不生效 → 原因：mcp 配置错误/服务不可用/租用未释放 → 步骤：打开 Problems 面板查看错误；必要时用 `mcp_restart`；完成后用 `mcp_release` 释放租用。',
      ])
    );
  }
  return (
    fmtHeader('Troubleshooting (symptom → cause → steps)') +
    fmtList([
      'Always do this before changing provider/model: run `team_mgmt_check_provider({ provider_key: \"<providerKey>\", model: \"\", all_models: false, live: true, max_models: 0 })` to verify the provider key and env vars.',
      'Symptom: "Missing provider/model" → Cause: missing `member_defaults` or member overrides → Steps: check `.minds/team.yaml` `member_defaults.provider/model` (and `members.<id>.provider/model`).',
      'Symptom: "Provider not found" → Cause: provider key not defined / typo / unexpected merge with defaults → Steps: check `.minds/llm.yaml` provider keys and ensure `.minds/team.yaml` references an existing key.',
      'Symptom: "permission denied / forbidden / not allowed" → Cause: directory permissions (read/write/no_*) hit deny-list or not covered by allow-list → Steps: review `team_mgmt_manual({ topics: [\"permissions\"] })` and the member `read_dirs/write_dirs/no_*` config.',
      'Symptom: MCP not working → Cause: bad config / server down / leasing issues → Steps: check Problems panel; use `mcp_restart`; call `mcp_release` when done.',
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
        '常见参数示例（不同 provider 支持不同）：例如 `reasoning_effort`、`verbosity`、`temperature`、`max_tokens` 等。对内置 `codex` provider，这些参数应写在 `model_params.codex.*` 下。',
        '常见坑：不要把 `reasoning_effort` / `verbosity` 直接写在 `member_defaults` 或 `members.<id>` 根上（会被忽略，并会被 team.yaml 校验提示）；应写在 `model_params.codex.*` 下。',
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
      'Common examples (provider-dependent): e.g. `reasoning_effort`, `verbosity`, `temperature`, `max_tokens`, etc. For the built-in `codex` provider, these go under `model_params.codex.*`.',
      'Common pitfall: do not put `reasoning_effort` / `verbosity` directly under `member_defaults` or `members.<id>` (they are ignored and will be flagged by team.yaml validation); put them under `model_params.codex.*`.',
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
  const ids = Object.keys(listToolsets());
  const header =
    language === 'zh' ? fmtHeader('已注册 toolsets') : fmtHeader('Registered toolsets');

  const intro =
    language === 'zh'
      ? fmtList([
          '多数情况下推荐用 `members.<id>.toolsets` 做粗粒度授权；`members.<id>.tools` 更适合做少量补充/收敛。',
          '按 provider 选择匹配的 toolsets：当 `provider: codex`（偏 Codex CLI 风格提示/工具名）时，优先给 `codex_style_tools`（`apply_patch`）；如果还需要“读工作区”，通常要再给 `os`（`shell_cmd`）并严格限制在少数专员成员手里。其他 provider 或采用 Dominds 原生工具习惯时，优先给 `ws_read` / `ws_mod`（Tellask 预览→应用工作流）。',
          '最佳实践：把 `os`（尤其 `shell_cmd`）只授予具备良好纪律/风控意识的人设成员（例如 “cmdr/ops”）。对不具备 shell 工具的成员，系统提示会明确要求其将 shell 执行委派给这类专员，并提供可审查的命令提案与理由。',
          '常见三种模式（示例写在 `.minds/team.yaml` 的 `members.<id>.toolsets` 下）：',
        ])
      : fmtList([
          'Typically use `members.<id>.toolsets` for coarse-grained access; use `members.<id>.tools` for a small number of additions/limits.',
          'Pick toolsets to match the provider: for `provider: codex` (Codex CLI-style prompts/tool names), prefer `codex_style_tools` (`apply_patch`); if you also need “read the workspace”, you typically must grant `os` (`shell_cmd`) and keep it restricted to a small number of specialist operators. For other providers or when using Dominds-native tool habits, prefer `ws_read` / `ws_mod` (Tellask preview→apply workflow).',
          'Best practice: grant `os` (especially `shell_cmd`) only to a disciplined, risk-aware operator persona (e.g. “cmdr/ops”). For members without shell tools, the system prompt explicitly tells them to delegate shell execution to such a specialist, with a reviewable command proposal and justification.',
          'Three common patterns (in `.minds/team.yaml` under `members.<id>.toolsets`):',
        ]);

  const patterns = fmtCodeBlock('yaml', [
    '# 1) allow all',
    'toolsets: ["*"]',
    '',
    '# 2) allow all except team-mgmt',
    'toolsets: ["*", "!team-mgmt"]',
    '',
    '# 3) allow a few',
    'toolsets: ["shell", "git", "mcp"]',
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
              '说明：坏的成员配置会被运行时跳过（为了保持 Team 可用），但你仍应立即修复以免行为偏离预期。',
            ]) +
            '\n' +
            issueLines.join('\n')
          : fmtHeader('team.yaml Validation Failed') +
            fmtList([
              `\`${TEAM_YAML_REL}\`: ❌ ${teamProblems.length} issue(s) detected (see Problems panel)`,
              'Note: invalid member configs are omitted at runtime (to keep the Team usable), but you should fix them immediately.',
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
    const language = getWorkLanguage();
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
      switch (token) {
        case 'topics':
        case 'llm':
        case 'model-params':
        case 'mcp':
        case 'team':
        case 'minds':
        case 'permissions':
        case 'troubleshooting':
        case 'toolsets':
        case 'member-properties':
        case 'builtin-defaults':
          topics.push(token);
          break;
        default:
          throw new Error(`Unknown topic: ${token0}`);
      }
    }
    const msgPrefix =
      language === 'zh'
        ? `（生成时间：${formatUnifiedTimestamp(new Date())}）\n\n`
        : `(Generated: ${formatUnifiedTimestamp(new Date())})\n\n`;

    const renderIndex = (): string => {
      if (language === 'zh') {
        return (
          fmtHeader('Team Management Manual') +
          msgPrefix +
          fmtList([
            '`team_mgmt_manual({ topics: ["topics"] })`：主题索引（你在这里）',
            '新手最常见流程：先写 `.minds/team.yaml` → 再写 `.minds/team/<id>/persona.*.md` → 再跑 `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false, max_models: 0 })`。',
            '',
            '`team_mgmt_manual({ topics: ["team"] })`：.minds/team.yaml（团队花名册、工具集、目录权限入口）',
            '`team_mgmt_manual({ topics: ["minds"] })`：.minds/team/<id>/*（persona/knowledge/lessons 资产怎么写）',
            '`team_mgmt_manual({ topics: ["permissions"] })`：目录权限（read_dirs/write_dirs/no_* 语义与冲突规则）',
            '`team_mgmt_manual({ topics: ["toolsets"] })`：toolsets 列表（当前已注册 toolsets；常见三种授权模式）',
            '`team_mgmt_manual({ topics: ["llm"] })`：.minds/llm.yaml（provider key 如何定义/引用；env var 安全边界）',
            '`team_mgmt_manual({ topics: ["mcp"] })`：.minds/mcp.yaml（MCP serverId→toolset；热重载与租用；可复制最小模板）',
            '`team_mgmt_manual({ topics: ["troubleshooting"] })`：排障（按症状定位；优先用 check_provider）',
            '',
            '`team_mgmt_manual({ topics: ["team","member-properties"] })`：成员字段表（members.<id> 字段参考）',
            '`team_mgmt_manual({ topics: ["llm","builtin-defaults"] })`：内置 defaults 摘要（内置 provider/model 概览与合并语义）',
            '`team_mgmt_manual({ topics: ["llm","model-params"] })`：模型参数参考（model_params / model_param_options）',
          ])
        );
      }
      return (
        fmtHeader('Team Management Manual') +
        msgPrefix +
        fmtList([
          '`team_mgmt_manual({ topics: ["topics"] })`: topic index (you are here)',
          'Common starter flow: write `.minds/team.yaml` → write `.minds/team/<id>/persona.*.md` → run `team_mgmt_check_provider({ provider_key: "<providerKey>", model: "", all_models: false, live: false, max_models: 0 })`. ',
          '',
          '`team_mgmt_manual({ topics: ["team"] })`: `.minds/team.yaml` (roster/toolsets/permissions entrypoint)',
          '`team_mgmt_manual({ topics: ["minds"] })`: `.minds/team/<id>/*` (persona/knowledge/lessons assets)',
          '`team_mgmt_manual({ topics: ["permissions"] })`: directory permissions (semantics + conflict rules)',
          '`team_mgmt_manual({ topics: ["toolsets"] })`: toolsets list (registered toolsets + common patterns)',
          '`team_mgmt_manual({ topics: ["llm"] })`: `.minds/llm.yaml` (provider keys, env var boundaries)',
          '`team_mgmt_manual({ topics: ["mcp"] })`: `.minds/mcp.yaml` (serverId→toolset, hot reload, leasing, minimal templates)',
          '`team_mgmt_manual({ topics: ["troubleshooting"] })`: troubleshooting (symptom → steps; start with check_provider)',
          '',
          '`team_mgmt_manual({ topics: ["team","member-properties"] })`: member field reference (members.<id>)',
          '`team_mgmt_manual({ topics: ["llm","builtin-defaults"] })`: built-in defaults summary (what/when/merge behavior)',
          '`team_mgmt_manual({ topics: ["llm","model-params"] })`: `model_params` and `model_param_options` reference',
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
                '最小示例：\n```yaml\nproviders:\n  my_provider:\n    apiKeyEnvVar: MY_PROVIDER_API_KEY\n    models:\n      my_model: { name: "my-model-id" }\n```\n然后在 `.minds/team.yaml` 里引用 `provider: my_provider` / `model: my_model`。',

                '覆盖/合并语义：`.minds/llm.yaml` 会在内置 defaults 之上做覆盖（以当前实现为准）；定义一个 provider key 并不意味着“禁用其他内置 provider”。',

                '不要在文件里存 API key，使用环境变量（apiKeyEnvVar）。',
                'member_defaults.provider/model 需要引用这里的 key。',
                '`model_param_options` 可选：用于记录该 provider 支持的 `.minds/team.yaml model_params` 选项（文档用途）。',
              ])
            : fmtHeader('.minds/llm.yaml') +
              fmtList([
                'Defines provider keys → model keys (referenced by `.minds/team.yaml` via `member_defaults.provider` / `members.<id>.provider`).',
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
  teamMgmtValidateTeamCfgTool,
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
