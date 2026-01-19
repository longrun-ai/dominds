/**
 * Module: tools/team-mgmt
 *
 * Team management tooling scoped strictly to `.minds/**`.
 *
 * Goals:
 * - Allow a dedicated team manager (e.g. shadow `fuxi`) to manage `.minds/` without granting broad
 *   workspace permissions (e.g. `ws_mod`).
 * - Enforce static scoping to `.minds/**` and reject anything outside that subtree.
 */

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import type { ChatMessage } from '../llm/client';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { TextingTool, TextingToolCallResult } from '../tool';
import { listDirTool, rmDirTool, rmFileTool } from './fs';
import { listToolsets } from './registry';
import { applyPatchTool, overwriteFileTool, patchFileTool, readFileTool } from './txt';

const MINDS_ALLOW = ['.minds/**'] as const;
const MINDS_DIR = '.minds';

function ok(result: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'completed', result, messages };
}

function fail(result: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'failed', result, messages };
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

function parseArgsAfterTool(headLine: string, toolName: string): string {
  const trimmed = headLine.trim();
  const prefix = `@${toolName}`;
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Invalid format. Use @${toolName} ...`);
  }
  return trimmed.slice(prefix.length).trim();
}

export const teamMgmtListDirTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_list_dir',
  backfeeding: true,
  usageDescription:
    `List directory contents under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_list_dir [path]\n\n` +
    `Examples:\n` +
    `@team_mgmt_list_dir\n` +
    `@team_mgmt_list_dir team\n`,
  usageDescriptionI18n: {
    en:
      `List directory contents under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_list_dir [path]\n\n` +
      `Examples:\n` +
      `@team_mgmt_list_dir\n` +
      `@team_mgmt_list_dir team\n`,
    zh:
      `列出 ${MINDS_DIR}/ 下的目录内容。\n` +
      `用法：@team_mgmt_list_dir [path]\n\n` +
      `示例：\n` +
      `@team_mgmt_list_dir\n` +
      `@team_mgmt_list_dir team\n`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const rel = toMindsRelativePath(after || '.');
      ensureMindsScopedPath(rel);

      const proxyCaller = makeMindsOnlyAccessMember(caller);
      return await listDirTool.call(dlg, proxyCaller, `@list_dir ${rel}`, '');
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtReadFileTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_read_file',
  backfeeding: true,
  usageDescription:
    `Read a text file under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_read_file [options] <path>\n\n` +
    `Options (same as @read_file):\n` +
    `  !range <start~end>\n` +
    `  !max-lines <n>\n` +
    `  !decorate-linenos [true|false]\n\n` +
    `Examples:\n` +
    `@team_mgmt_read_file team.yaml\n` +
    `@team_mgmt_read_file !range 1~120 team.yaml\n`,
  usageDescriptionI18n: {
    en:
      `Read a text file under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_read_file [options] <path>\n\n` +
      `Options (same as @read_file):\n` +
      `  !range <start~end>\n` +
      `  !max-lines <n>\n` +
      `  !decorate-linenos [true|false]\n\n` +
      `Examples:\n` +
      `@team_mgmt_read_file team.yaml\n` +
      `@team_mgmt_read_file !range 1~120 team.yaml\n`,
    zh:
      `读取 ${MINDS_DIR}/ 下的文本文件。\n` +
      `用法：@team_mgmt_read_file [options] <path>\n\n` +
      `可选项（同 @read_file）：\n` +
      `  !range <start~end>\n` +
      `  !max-lines <n>\n` +
      `  !decorate-linenos [true|false]\n\n` +
      `示例：\n` +
      `@team_mgmt_read_file team.yaml\n` +
      `@team_mgmt_read_file !range 1~120 team.yaml\n`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const parts = after.split(/\s+/).filter((p) => p.trim() !== '');
      if (parts.length === 0) {
        throw new Error('Path required');
      }
      const rawPath = parts[parts.length - 1];
      const opts = parts.slice(0, parts.length - 1);
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const rebuilt = `@read_file ${[...opts, rel].join(' ')}`.trim();
      return await readFileTool.call(dlg, proxyCaller, rebuilt, '');
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtOverwriteFileTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_overwrite_file',
  backfeeding: true,
  usageDescription:
    `Overwrite a text file under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_overwrite_file <path>\n` +
    `<content in body>\n\n` +
    `Example:\n` +
    `@team_mgmt_overwrite_file team.yaml\n` +
    `member_defaults:\n` +
    `  provider: openai\n`,
  usageDescriptionI18n: {
    en:
      `Overwrite a text file under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_overwrite_file <path>\n` +
      `<content in body>\n\n` +
      `Example:\n` +
      `@team_mgmt_overwrite_file team.yaml\n` +
      `member_defaults:\n` +
      `  provider: openai\n`,
    zh:
      `覆盖写入 ${MINDS_DIR}/ 下的文本文件。\n` +
      `用法：@team_mgmt_overwrite_file <path>\n` +
      `<正文为文件内容>\n\n` +
      `示例：\n` +
      `@team_mgmt_overwrite_file team.yaml\n` +
      `member_defaults:\n` +
      `  provider: openai\n`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const filePath = after.split(/\s+/)[0] || '';
      if (!filePath) throw new Error('Path required');
      const rel = toMindsRelativePath(filePath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      return await overwriteFileTool.call(dlg, proxyCaller, `@overwrite_file ${rel}`, inputBody);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtPatchFileTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_patch_file',
  backfeeding: true,
  usageDescription:
    `Apply a simple single-file patch under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_patch_file <path>\n` +
    `<patch in body>\n\n` +
    `Tip: If your patch contains lines starting with '@' (e.g. '@@' hunks), wrap the body in triple backticks.\n`,
  usageDescriptionI18n: {
    en:
      `Apply a simple single-file patch under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_patch_file <path>\n` +
      `<patch in body>\n\n` +
      `Tip: If your patch contains lines starting with '@' (e.g. '@@' hunks), wrap the body in triple backticks.\n`,
    zh:
      `对 ${MINDS_DIR}/ 下的单个文件应用简单补丁。\n` +
      `用法：@team_mgmt_patch_file <path>\n` +
      `<正文为补丁内容>\n\n` +
      `提示：如果补丁包含以 @ 开头的行（例如 @@ hunk），请用三反引号 \`\`\` 包裹正文。\n`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const filePath = after.split(/\s+/)[0] || '';
      if (!filePath) throw new Error('Path required');
      const rel = toMindsRelativePath(filePath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      return await patchFileTool.call(dlg, proxyCaller, `@patch_file ${rel}`, inputBody);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtApplyPatchTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_apply_patch',
  backfeeding: true,
  usageDescription:
    `Apply a unified diff patch to files under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_apply_patch\n` +
    `<diff content in body>\n\n` +
    `Tip: Unified diffs usually contain '@@' hunks; wrap the body in triple backticks.\n`,
  usageDescriptionI18n: {
    en:
      `Apply a unified diff patch to files under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_apply_patch\n` +
      `<diff content in body>\n\n` +
      `Tip: Unified diffs usually contain '@@' hunks; wrap the body in triple backticks.\n`,
    zh:
      `对 ${MINDS_DIR}/ 下的文件应用 unified diff 补丁。\n` +
      `用法：@team_mgmt_apply_patch\n` +
      `<正文为 diff 内容>\n\n` +
      `提示：unified diff 通常包含 @@ hunk，请用三反引号 \`\`\` 包裹正文。\n`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const trimmed = headLine.trim();
      if (!trimmed.startsWith(`@${this.name}`)) {
        throw new Error(`Invalid format. Use @${this.name}`);
      }
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      return await applyPatchTool.call(dlg, proxyCaller, '@apply_patch', inputBody);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRmFileTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_rm_file',
  backfeeding: true,
  usageDescription: `Remove a file under ${MINDS_DIR}/.\n` + `Usage: @team_mgmt_rm_file <path>\n`,
  usageDescriptionI18n: {
    en: `Remove a file under ${MINDS_DIR}/.\n` + `Usage: @team_mgmt_rm_file <path>\n`,
    zh: `删除 ${MINDS_DIR}/ 下的文件。\n` + `用法：@team_mgmt_rm_file <path>\n`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const filePath = after.split(/\s+/)[0] || '';
      if (!filePath) throw new Error('Path required');
      const rel = toMindsRelativePath(filePath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      return await rmFileTool.call(dlg, proxyCaller, `@rm_file ${rel}`, '');
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtRmDirTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_rm_dir',
  backfeeding: true,
  usageDescription:
    `Remove a directory under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_rm_dir <path> [!recursive true|false]\n`,
  usageDescriptionI18n: {
    en:
      `Remove a directory under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_rm_dir <path> [!recursive true|false]\n`,
    zh:
      `删除 ${MINDS_DIR}/ 下的目录。\n` +
      `用法：@team_mgmt_rm_dir <path> [!recursive true|false]\n`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const parts = after.split(/\s+/).filter((p) => p.trim() !== '');
      if (parts.length === 0) throw new Error('Path required');
      const rawPath = parts[0];
      const rest = parts.slice(1);
      const rel = toMindsRelativePath(rawPath);
      ensureMindsScopedPath(rel);
      const proxyCaller = makeMindsOnlyAccessMember(caller);
      const rebuilt = `@rm_dir ${[rel, ...rest].join(' ')}`.trim();
      return await rmDirTool.call(dlg, proxyCaller, rebuilt, '');
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtMkdirTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_mkdir',
  backfeeding: true,
  usageDescription:
    `Create a directory under ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_mkdir <path> [!parents true|false]\n`,
  usageDescriptionI18n: {
    en:
      `Create a directory under ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_mkdir <path> [!parents true|false]\n`,
    zh: `在 ${MINDS_DIR}/ 下创建目录。\n` + `用法：@team_mgmt_mkdir <path> [!parents true|false]\n`,
  },
  async call(dlg, _caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const parts = after.split(/\s+/).filter((p) => p.trim() !== '');
      if (parts.length === 0) throw new Error('Path required');
      const rawPath = parts[0];
      let parents = true;
      for (let i = 1; i < parts.length; i += 1) {
        if (parts[i] === '!parents' && i + 1 < parts.length) {
          const v = parts[i + 1];
          if (v === 'true' || v === 'false') {
            parents = v === 'true';
            i += 1;
          }
        }
      }
      const rel = toMindsRelativePath(rawPath);
      const resolved = ensureMindsScopedPath(rel);
      await fs.mkdir(resolved.abs, { recursive: parents });
      const msg =
        language === 'zh'
          ? `已创建目录：\`${resolved.rel}\``
          : `Created directory: \`${resolved.rel}\``;
      return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    } catch (err: unknown) {
      const msg =
        language === 'zh'
          ? `错误：${err instanceof Error ? err.message : String(err)}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
      return fail(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
    }
  },
};

export const teamMgmtMovePathTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_move_path',
  backfeeding: true,
  usageDescription:
    `Move/rename a path under ${MINDS_DIR}/.\n` + `Usage: @team_mgmt_move_path <from> <to>\n`,
  usageDescriptionI18n: {
    en: `Move/rename a path under ${MINDS_DIR}/.\n` + `Usage: @team_mgmt_move_path <from> <to>\n`,
    zh: `在 ${MINDS_DIR}/ 下移动/重命名路径。\n` + `用法：@team_mgmt_move_path <from> <to>\n`,
  },
  async call(dlg, _caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getUserLang(dlg);
    try {
      const after = parseArgsAfterTool(headLine, this.name);
      const parts = after.split(/\s+/).filter((p) => p.trim() !== '');
      if (parts.length < 2) throw new Error('Expected: <from> <to>');
      const fromRel = toMindsRelativePath(parts[0]);
      const toRel = toMindsRelativePath(parts[1]);
      const fromResolved = ensureMindsScopedPath(fromRel);
      const toResolved = ensureMindsScopedPath(toRel);
      await fs.rename(fromResolved.abs, toResolved.abs);
      const msg =
        language === 'zh'
          ? `已移动：\`${fromResolved.rel}\` → \`${toResolved.rel}\``
          : `Moved: \`${fromResolved.rel}\` → \`${toResolved.rel}\``;
      return ok(msg, [{ type: 'environment_msg', role: 'user', content: msg }]);
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

function parseManualTopics(headLine: string): ManualTopic[] {
  const trimmed = headLine.trim();
  if (!trimmed.startsWith('@team_mgmt_manual')) return [];
  const after = trimmed.slice('@team_mgmt_manual'.length).trim();
  if (!after) return [];
  const tokens = after.split(/\s+/).filter((t) => t.trim() !== '');
  const topics: ManualTopic[] = [];
  for (const token of tokens) {
    if (!token.startsWith('!')) continue;
    const v = token.slice(1);
    switch (v) {
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
        topics.push(v);
        break;
      default:
        break;
    }
  }
  return topics;
}

function fmtHeader(title: string): string {
  return `# ${title}\n`;
}

function fmtList(items: string[]): string {
  return items.map((s) => `- ${s}`).join('\n') + '\n';
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
        '`provider` / `model` / `model_params`',
        '`toolsets` / `tools`',
        '`streaming`',
        '`hidden`（影子/隐藏成员：不出现在系统提示的团队目录里，但仍可被呼叫）',
        '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`',
      ])
    );
  }
  return (
    fmtHeader('Member Properties (members.<id>)') +
    fmtList([
      '`name` / `icon` / `gofor`',
      '`provider` / `model` / `model_params`',
      '`toolsets` / `tools`',
      '`streaming`',
      '`hidden` (shadow/hidden member: excluded from system-prompt team directory, but callable)',
      '`read_dirs` / `write_dirs` / `no_read_dirs` / `no_write_dirs`',
    ])
  );
}

function renderTeamManual(language: LanguageCode): string {
  const common = [
    'member_defaults: provider/model are required',
    'members: per-agent overrides inherit from member_defaults via prototype fallback',
    'hidden: true marks a shadow member (not listed in system prompt)',
    "toolsets supports '*' and '!<toolset>' exclusions (e.g. ['*','!team-mgmt'])",
  ];
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team.yaml') +
      fmtList([
        '必须包含 `member_defaults.provider` 与 `member_defaults.model`。',
        '成员配置通过 prototype 继承 `member_defaults`（省略字段会继承默认值）。',
        '`hidden: true` 表示影子/隐藏成员：不会出现在系统提示的团队目录里，但仍然可以 `@<id>` 呼叫。',
        '`toolsets` 支持 `*` 与 `!<toolset>` 排除项（例如 `[* , !team-mgmt]`）。',
      ]) +
      '\n' +
      '最小模板：\n' +
      '```yaml\n' +
      'member_defaults:\n' +
      '  provider: openai\n' +
      '  model: gpt-5.2\n' +
      '\n' +
      'default_responder: pangu\n' +
      '\n' +
      'members:\n' +
      '  fuxi:\n' +
      '    hidden: true\n' +
      "    toolsets: ['team-mgmt']\n" +
      '  pangu:\n' +
      '    hidden: true\n' +
      "    toolsets: ['*', '!team-mgmt']\n" +
      "    no_read_dirs: ['.minds/**']\n" +
      "    no_write_dirs: ['.minds/**']\n" +
      '```\n'
    );
  }
  return (
    fmtHeader('.minds/team.yaml') +
    fmtList(common.map((s) => s)) +
    '\n' +
    'Minimal template:\n' +
    '```yaml\n' +
    'member_defaults:\n' +
    '  provider: openai\n' +
    '  model: gpt-5.2\n' +
    '\n' +
    'default_responder: pangu\n' +
    '\n' +
    'members:\n' +
    '  fuxi:\n' +
    '    hidden: true\n' +
    "    toolsets: ['team-mgmt']\n" +
    '  pangu:\n' +
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
        '每个 MCP serverId 注册一个 toolset，toolset 名称 = `serverId`（不加 `mcp_` 前缀）。',
        '支持热重载：编辑 `.minds/mcp.yaml` 后无需重启 Dominds；必要时用 `mcp_restart`。',
        '用 `tools.whitelist/blacklist` 控制暴露的工具，用 `transform` 做命名变换。',
      ]) +
      '\n' +
      '示例（HTTP）：\n' +
      '```yaml\n' +
      'version: 1\n' +
      'servers:\n' +
      '  sdk_http:\n' +
      '    transport: streamable_http\n' +
      '    url: http://127.0.0.1:3000/mcp\n' +
      '    tools: { whitelist: [], blacklist: [] }\n' +
      '    transform: []\n' +
      '```\n'
    );
  }
  return (
    fmtHeader('.minds/mcp.yaml') +
    fmtList([
      'Each MCP serverId registers one toolset, and the toolset name is exactly `serverId` (no `mcp_` prefix).',
      'Hot reload: edits apply without restarting Dominds; use `mcp_restart` when needed.',
      'Use `tools.whitelist/blacklist` for exposure control and `transform` for naming transforms.',
    ]) +
    '\n' +
    'Example (HTTP):\n' +
    '```yaml\n' +
    'version: 1\n' +
    'servers:\n' +
    '  sdk_http:\n' +
    '    transport: streamable_http\n' +
    '    url: http://127.0.0.1:3000/mcp\n' +
    '    tools: { whitelist: [], blacklist: [] }\n' +
    '    transform: []\n' +
    '```\n'
  );
}

function renderPermissionsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('目录权限（read_dirs / write_dirs）') +
      fmtList([
        'deny-list（no_*）优先于 allow-list（*_dirs）。',
        '若未配置 allow-list，则默认允许（在 deny-list 不命中的前提下）。',
        '模式支持 `*` 和 `**`，按“目录范围”语义匹配。',
        '`*.tsk/` 是封装任务包：通用文件工具必须禁止访问。',
      ])
    );
  }
  return (
    fmtHeader('Directory Permissions (read_dirs / write_dirs)') +
    fmtList([
      'Deny-lists (no_*) override allow-lists (*_dirs).',
      'If no allow-list is configured, access defaults to allow (after deny-list check).',
      'Patterns support `*` and `**` with directory-scope semantics.',
      '`*.tsk/` is an encapsulated task package and is forbidden to general file tools.',
    ])
  );
}

function renderMindsManual(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('.minds/team/<id>/*') +
      fmtList([
        'persona.*.md：角色设定（稳定的工作方式与职责）。',
        'knowledge.*.md：领域知识（可维护）。',
        'lessons.*.md：经验教训（可维护）。',
        '优先按工作语言命名：persona.zh.md / persona.en.md 等。',
      ])
    );
  }
  return (
    fmtHeader('.minds/team/<id>/*') +
    fmtList([
      'persona.*.md: persona and operating style.',
      'knowledge.*.md: domain knowledge (maintainable).',
      'lessons.*.md: lessons learned (maintainable).',
      'Prefer working-language variants: persona.en.md / persona.zh.md, etc.',
    ])
  );
}

function renderTroubleshooting(language: LanguageCode): string {
  if (language === 'zh') {
    return (
      fmtHeader('排障') +
      fmtList([
        '“缺少 provider/model”：检查 `.minds/team.yaml` 的 member_defaults。',
        '“Provider not found”：检查 `.minds/llm.yaml` 与 defaults 合并后的 provider key。',
        'MCP 不生效：打开 Problems 面板查看错误；必要时用 `mcp_restart`。',
      ])
    );
  }
  return (
    fmtHeader('Troubleshooting') +
    fmtList([
      '"Missing provider/model": check `.minds/team.yaml` member_defaults.',
      '"Provider not found": check `.minds/llm.yaml` provider keys (merged with defaults).',
      'MCP not working: check Problems panel; use `mcp_restart` when needed.',
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
        'OpenAI/Codex 常用：`openai.reasoning_effort`（minimal/low/medium/high）、`openai.verbosity`（low/medium/high）。',
        '工具调用/可重复输出：倾向 `openai.temperature: 0` 或较低（0–0.2）。',
      ]) +
      '\n' +
      '示例：\n' +
      '```yaml\n' +
      'members:\n' +
      '  pangu:\n' +
      '    model_params:\n' +
      '      openai:\n' +
      '        reasoning_effort: medium\n' +
      '        verbosity: low\n' +
      '        temperature: 0\n' +
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
      'Common OpenAI/Codex knobs: `openai.reasoning_effort` (minimal/low/medium/high), `openai.verbosity` (low/medium/high).',
      'For tool-calling and repeatability: prefer `openai.temperature: 0` or low (0–0.2).',
    ]) +
    '\n' +
    'Example:\n' +
    '```yaml\n' +
    'members:\n' +
    '  pangu:\n' +
    '    model_params:\n' +
    '      openai:\n' +
    '        reasoning_effort: medium\n' +
    '        verbosity: low\n' +
    '        temperature: 0\n' +
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
  return header + fmtList(ids.map((id) => `\`${id}\``));
}

async function renderBuiltinDefaults(language: LanguageCode): Promise<string> {
  const header =
    language === 'zh'
      ? fmtHeader('内置 LLM Defaults（摘要）')
      : fmtHeader('Built-in LLM Defaults (summary)');
  const body = await loadBuiltinLlmDefaultsText();
  return header + body + '\n';
}

export const teamMgmtManualTool: TextingTool = {
  type: 'texter',
  name: 'team_mgmt_manual',
  backfeeding: true,
  usageDescription:
    `Team management manual for ${MINDS_DIR}/.\n` +
    `Usage: @team_mgmt_manual [!topic ...]\n\n` +
    `Examples:\n` +
    `@team_mgmt_manual\n` +
    `@team_mgmt_manual !topics\n` +
    `@team_mgmt_manual !team !member-properties\n` +
    `@team_mgmt_manual !llm !builtin-defaults\n` +
    `@team_mgmt_manual !llm !model-params\n`,
  usageDescriptionI18n: {
    en:
      `Team management manual for ${MINDS_DIR}/.\n` +
      `Usage: @team_mgmt_manual [!topic ...]\n\n` +
      `Examples:\n` +
      `@team_mgmt_manual\n` +
      `@team_mgmt_manual !topics\n` +
      `@team_mgmt_manual !team !member-properties\n` +
      `@team_mgmt_manual !llm !builtin-defaults\n` +
      `@team_mgmt_manual !llm !model-params\n`,
    zh:
      `${MINDS_DIR}/ 的团队管理手册。\n` +
      `用法：@team_mgmt_manual [!topic ...]\n\n` +
      `示例：\n` +
      `@team_mgmt_manual\n` +
      `@team_mgmt_manual !topics\n` +
      `@team_mgmt_manual !team !member-properties\n` +
      `@team_mgmt_manual !llm !builtin-defaults\n` +
      `@team_mgmt_manual !llm !model-params\n`,
  },
  async call(dlg, _caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const topics = parseManualTopics(headLine);
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
            '`@team_mgmt_manual !topics`：主题索引',
            '`@team_mgmt_manual !team`：.minds/team.yaml',
            '`@team_mgmt_manual !team !member-properties`：成员字段表',
            '`@team_mgmt_manual !llm`：.minds/llm.yaml',
            '`@team_mgmt_manual !llm !builtin-defaults`：内置 provider/model 摘要',
            '`@team_mgmt_manual !llm !model-params`：模型参数（model_params）参考',
            '`@team_mgmt_manual !mcp`：.minds/mcp.yaml',
            '`@team_mgmt_manual !minds`：.minds/team/<id>/*',
            '`@team_mgmt_manual !permissions`：目录权限',
            '`@team_mgmt_manual !toolsets`：当前已注册 toolsets',
            '`@team_mgmt_manual !troubleshooting`：排障',
          ])
        );
      }
      return (
        fmtHeader('Team Management Manual') +
        msgPrefix +
        fmtList([
          '`@team_mgmt_manual !topics`: topic index',
          '`@team_mgmt_manual !team`: .minds/team.yaml',
          '`@team_mgmt_manual !team !member-properties`: member field reference',
          '`@team_mgmt_manual !llm`: .minds/llm.yaml',
          '`@team_mgmt_manual !llm !builtin-defaults`: built-in provider/model summary',
          '`@team_mgmt_manual !llm !model-params`: `model_params` reference',
          '`@team_mgmt_manual !mcp`: .minds/mcp.yaml',
          '`@team_mgmt_manual !minds`: .minds/team/<id>/*',
          '`@team_mgmt_manual !permissions`: directory permissions',
          '`@team_mgmt_manual !toolsets`: currently registered toolsets',
          '`@team_mgmt_manual !troubleshooting`: troubleshooting',
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
                '定义 provider→model 映射（覆盖内置 defaults）。',
                '不要在文件里存 API key，使用环境变量（apiKeyEnvVar）。',
                'member_defaults.provider/model 需要引用这里的 key。',
                '`model_param_options` 可选：用于记录该 provider 支持的 `.minds/team.yaml model_params` 选项（文档用途）。',
              ])
            : fmtHeader('.minds/llm.yaml') +
              fmtList([
                'Defines provider→model map (overrides built-in defaults).',
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

export const teamMgmtTools: ReadonlyArray<TextingTool> = [
  teamMgmtManualTool,
  teamMgmtListDirTool,
  teamMgmtReadFileTool,
  teamMgmtOverwriteFileTool,
  teamMgmtPatchFileTool,
  teamMgmtApplyPatchTool,
  teamMgmtMkdirTool,
  teamMgmtMovePathTool,
  teamMgmtRmFileTool,
  teamMgmtRmDirTool,
];
