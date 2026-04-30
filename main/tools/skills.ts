/**
 * Module: tools/skills
 *
 * Personal skill management tools scoped to `.minds/skills/individual/<member-id>`.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { getAccessDeniedMessage, hasReadAccess } from '../access-control';
import { normalizeMarkdownText, parseMarkdownFrontmatter } from '../markdown/frontmatter';
import { formatToolActionResult } from '../runtime/tool-result-messages';
import { getWorkLanguage } from '../runtime/work-language';
import type { Team } from '../team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../tool';
import { toolFailure } from '../tool';

type SkillPathResult =
  | Readonly<{ kind: 'ok'; skillId: string; rel: string; abs: string }>
  | Readonly<{ kind: 'invalid_path'; message: string }>;

type SkillVariant = 'cn' | 'en' | 'neutral';

type SkillContentArgs =
  | Readonly<{
      kind: 'ok';
      content: string;
    }>
  | Readonly<{
      kind: 'invalid';
      message: string;
    }>;

type PersonalSkillPackageState =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'directory' }>
  | Readonly<{ kind: 'symlink' }>
  | Readonly<{ kind: 'not_directory' }>;

type CopyOnWritePersonalSkillResult =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'failure'; output: ToolCallOutput }>;

type PersonalSkillWriteMode = 'add' | 'replace';

function localizedError(language: LanguageCode, zh: string, en: string): string {
  return language === 'zh' ? `错误：${zh}` : `Error: ${en}`;
}

function parseSkillVariant(raw: unknown): SkillVariant {
  if (raw === undefined) return 'neutral';
  if (raw === 'cn' || raw === 'en' || raw === 'neutral') return raw;
  throw new Error('Invalid variant (expected "cn", "en", or "neutral").');
}

function validatePathSegment(params: {
  language: LanguageCode;
  label: 'member_id' | 'skill_id';
  rawValue: string;
}): Readonly<{ kind: 'ok'; value: string }> | Readonly<{ kind: 'invalid_path'; message: string }> {
  const value = params.rawValue.trim();
  if (value === '') {
    return {
      kind: 'invalid_path',
      message: localizedError(
        params.language,
        `需要提供 ${params.label}。`,
        `${params.label} is required.`,
      ),
    };
  }

  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return {
      kind: 'invalid_path',
      message: localizedError(
        params.language,
        `${params.label} 必须是单段相对标识，不能包含路径分隔符。`,
        `${params.label} must be one relative path segment and must not contain path separators.`,
      ),
    };
  }

  if (value === '.' || value === '..' || value.includes('..')) {
    return {
      kind: 'invalid_path',
      message: localizedError(
        params.language,
        `${params.label} 不允许包含 \`..\`。`,
        `${params.label} must not contain \`..\`.`,
      ),
    };
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return {
      kind: 'invalid_path',
      message: localizedError(
        params.language,
        `${params.label} 只能包含字母、数字、下划线和连字符。`,
        `${params.label} may only contain letters, numbers, underscores, and hyphens.`,
      ),
    };
  }

  return { kind: 'ok', value };
}

function validateSkillId(language: LanguageCode, rawSkillId: string): SkillPathResult {
  const validated = validatePathSegment({ language, label: 'skill_id', rawValue: rawSkillId });
  if (validated.kind === 'invalid_path') return validated;
  const skillId = validated.value;
  const rel = path.join('.minds', 'skills', 'individual', '<member>', skillId);
  return { kind: 'ok', skillId, rel, abs: rel };
}

function getPersonalSkillPackagePath(params: {
  language: LanguageCode;
  caller: Team.Member;
  skillId: string;
}): SkillPathResult {
  const validated = validateSkillId(params.language, params.skillId);
  if (validated.kind === 'invalid_path') return validated;
  const memberId = validatePathSegment({
    language: params.language,
    label: 'member_id',
    rawValue: params.caller.id,
  });
  if (memberId.kind === 'invalid_path') return memberId;

  const rel = path.join('.minds', 'skills', 'individual', memberId.value, validated.skillId);
  const abs = path.resolve(process.cwd(), rel);
  return { kind: 'ok', skillId: validated.skillId, rel, abs };
}

function skillFileName(variant: SkillVariant): string {
  if (variant === 'cn') return 'SKILL.cn.md';
  if (variant === 'en') return 'SKILL.en.md';
  return 'SKILL.md';
}

function isPathInsideRtws(absPath: string): boolean {
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readPersonalSkillPackageState(abs: string): PersonalSkillPackageState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return { kind: 'missing' };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (stat.isDirectory()) return { kind: 'directory' };
  return { kind: 'not_directory' };
}

function pathExistsNoFollow(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function lstatOrNull(abs: string): fs.Stats | null {
  try {
    return fs.lstatSync(abs);
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function rejectPersonalSkillNonDirectory(language: LanguageCode, skillId: string): ToolCallOutput {
  return toolFailure(
    language === 'zh'
      ? `错误：个人 skill '${skillId}' 的路径已存在但不是目录包。`
      : `Error: Personal skill '${skillId}' path already exists but is not a directory package.`,
  );
}

function copyDirectoryRecursiveSync(
  sourceAbs: string,
  targetAbs: string,
  visitedRealDirs: ReadonlySet<string> = new Set<string>(),
): void {
  const sourceRealAbs = fs.realpathSync(sourceAbs);
  if (visitedRealDirs.has(sourceRealAbs)) {
    throw new Error(
      `Symlink cycle detected while materializing linked skill package: ${sourceAbs}`,
    );
  }
  const childVisitedRealDirs = new Set(visitedRealDirs);
  childVisitedRealDirs.add(sourceRealAbs);

  fs.mkdirSync(targetAbs, { recursive: true });
  for (const entry of fs.readdirSync(sourceAbs, { withFileTypes: true })) {
    const sourceEntryAbs = path.join(sourceAbs, entry.name);
    const targetEntryAbs = path.join(targetAbs, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursiveSync(sourceEntryAbs, targetEntryAbs, childVisitedRealDirs);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const targetStat = fs.statSync(sourceEntryAbs);
      if (targetStat.isDirectory()) {
        copyDirectoryRecursiveSync(sourceEntryAbs, targetEntryAbs, childVisitedRealDirs);
        continue;
      }
      if (targetStat.isFile()) {
        fs.copyFileSync(sourceEntryAbs, targetEntryAbs);
        continue;
      }
      throw new Error(`Unsupported symlink target inside linked skill package: ${sourceEntryAbs}`);
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourceEntryAbs, targetEntryAbs);
      continue;
    }
    const sourceStat = fs.statSync(sourceEntryAbs);
    if (sourceStat.isFile()) {
      fs.copyFileSync(sourceEntryAbs, targetEntryAbs);
      continue;
    }
    if (sourceStat.isDirectory()) {
      copyDirectoryRecursiveSync(sourceEntryAbs, targetEntryAbs, childVisitedRealDirs);
      continue;
    }
    throw new Error(`Unsupported entry inside linked skill package: ${sourceEntryAbs}`);
  }
}

function materializeLinkedPersonalSkillPackage(params: {
  language: LanguageCode;
  skillId: string;
  packageAbs: string;
}): CopyOnWritePersonalSkillResult {
  const tempAbs = `${params.packageAbs}.cow-${process.pid}-${Date.now()}`;
  let originalSymlinkTarget: string | undefined;
  try {
    originalSymlinkTarget = fs.readlinkSync(params.packageAbs);
    const targetStat = fs.statSync(params.packageAbs);
    if (!targetStat.isDirectory()) {
      return {
        kind: 'failure',
        output: toolFailure(
          params.language === 'zh'
            ? `错误：个人 skill '${params.skillId}' 的链接目标不是目录包。`
            : `Error: Personal skill '${params.skillId}' link target is not a directory package.`,
        ),
      };
    }
    copyDirectoryRecursiveSync(params.packageAbs, tempAbs);
    fs.unlinkSync(params.packageAbs);
    fs.renameSync(tempAbs, params.packageAbs);
    return { kind: 'ok' };
  } catch (error: unknown) {
    if (fs.existsSync(tempAbs)) {
      fs.rmSync(tempAbs, { recursive: true, force: true });
    }
    let restoreFailure: string | undefined;
    if (originalSymlinkTarget !== undefined && !pathExistsNoFollow(params.packageAbs)) {
      try {
        fs.symlinkSync(originalSymlinkTarget, params.packageAbs, 'dir');
      } catch (restoreError: unknown) {
        restoreFailure =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
      }
    }
    const baseMsg = error instanceof Error ? error.message : String(error);
    const msg =
      restoreFailure === undefined
        ? baseMsg
        : `${baseMsg}; failed to restore original symlink: ${restoreFailure}`;
    return {
      kind: 'failure',
      output: toolFailure(
        params.language === 'zh'
          ? `错误：个人 skill '${params.skillId}' copy-on-write 失败：${msg}`
          : `Error: Personal skill '${params.skillId}' copy-on-write failed: ${msg}`,
      ),
    };
  }
}

function buildSkillMarkdown(params: {
  name: string;
  description: string;
  body: string;
  allowedTools?: readonly string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}): string {
  const frontmatter: Record<string, unknown> = {
    name: params.name,
    description: params.description,
  };
  if (params.allowedTools !== undefined) {
    frontmatter['allowed-tools'] = [...params.allowedTools];
  }
  if (params.userInvocable !== undefined) {
    frontmatter['user-invocable'] = params.userInvocable;
  }
  if (params.disableModelInvocation !== undefined) {
    frontmatter['disable-model-invocation'] = params.disableModelInvocation;
  }

  const frontmatterText = YAML.stringify(frontmatter).trimEnd();
  return `---\n${frontmatterText}\n---\n\n${params.body.trimEnd()}\n`;
}

function validateSkillMarkdownContent(language: LanguageCode, content: string): SkillContentArgs {
  try {
    const { body, frontmatter } = parseMarkdownFrontmatter(content, 'personal skill');
    const nameValue = frontmatter['name'];
    if (typeof nameValue !== 'string' || nameValue.trim() === '') {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'SKILL frontmatter 必须包含非空 name。',
          "SKILL frontmatter must include a non-empty 'name'.",
        ),
      };
    }

    const descriptionValue = frontmatter['description'];
    if (typeof descriptionValue !== 'string' || descriptionValue.trim() === '') {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'SKILL frontmatter 必须包含非空 description。',
          "SKILL frontmatter must include a non-empty 'description'.",
        ),
      };
    }

    const allowedToolsValue = frontmatter['allowed-tools'];
    if (allowedToolsValue !== undefined) {
      if (typeof allowedToolsValue === 'string') {
        const values = allowedToolsValue
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '');
        if (values.length === 0) {
          return {
            kind: 'invalid',
            message: localizedError(
              language,
              'allowed-tools 字符串不能为空。',
              'allowed-tools string must not be empty.',
            ),
          };
        }
      } else if (
        !Array.isArray(allowedToolsValue) ||
        !allowedToolsValue.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        return {
          kind: 'invalid',
          message: localizedError(
            language,
            'allowed-tools 必须是非空字符串或非空字符串数组。',
            'allowed-tools must be a non-empty string or an array of non-empty strings.',
          ),
        };
      }
    }

    const userInvocableValue = frontmatter['user-invocable'];
    if (userInvocableValue !== undefined && typeof userInvocableValue !== 'boolean') {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'user-invocable 必须是 boolean。',
          'user-invocable must be boolean.',
        ),
      };
    }

    const disableModelInvocationValue = frontmatter['disable-model-invocation'];
    if (
      disableModelInvocationValue !== undefined &&
      typeof disableModelInvocationValue !== 'boolean'
    ) {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'disable-model-invocation 必须是 boolean。',
          'disable-model-invocation must be boolean.',
        ),
      };
    }

    for (const key of Object.keys(frontmatter)) {
      if (
        key !== 'name' &&
        key !== 'description' &&
        key !== 'allowed-tools' &&
        key !== 'user-invocable' &&
        key !== 'disable-model-invocation'
      ) {
        return {
          kind: 'invalid',
          message: localizedError(
            language,
            `SKILL frontmatter 包含不支持的字段 '${key}'。`,
            `SKILL frontmatter contains unsupported key '${key}'.`,
          ),
        };
      }
    }

    if (body.trim() === '') {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'SKILL 正文不能为空。',
          'SKILL markdown body must not be empty.',
        ),
      };
    }
    return { kind: 'ok', content };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', message: localizedError(language, msg, msg) };
  }
}

function parseOptionalStringArg(args: ToolArguments, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid ${key} (expected string).`);
  return value;
}

function parseOptionalBooleanArg(args: ToolArguments, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key} (expected boolean).`);
  return value;
}

function parseAllowedToolsArg(args: ToolArguments): readonly string[] | undefined {
  const value = args['allowed_tools'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid allowed_tools (expected string[]).');

  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`Invalid allowed_tools[${String(index)}] (expected non-empty string).`);
    }
    out.push(item.trim());
  }
  if (out.length === 0) throw new Error('Invalid allowed_tools (must not be empty).');
  return out;
}

function parseSkillContentArgs(
  language: LanguageCode,
  args: ToolArguments,
  mode: 'add' | 'replace',
): SkillContentArgs {
  try {
    const contentValue = parseOptionalStringArg(args, 'content');
    if (contentValue !== undefined) {
      if (contentValue.trim() === '') {
        return {
          kind: 'invalid',
          message: localizedError(language, 'content 不能为空。', 'content must not be empty.'),
        };
      }
      const normalizedContent = contentValue.endsWith('\n') ? contentValue : `${contentValue}\n`;
      const validatedContent = validateSkillMarkdownContent(language, normalizedContent);
      if (validatedContent.kind === 'invalid') return validatedContent;
      return {
        kind: 'ok',
        content: validatedContent.content,
      };
    }

    const name = parseOptionalStringArg(args, 'name')?.trim();
    const description = parseOptionalStringArg(args, 'description')?.trim();
    const body = parseOptionalStringArg(args, 'body')?.trimEnd();
    if (!name || !description || !body) {
      const zh =
        mode === 'add'
          ? '需要提供 content，或同时提供 name / description / body 来创建 skill。'
          : '需要提供 content，或同时提供 name / description / body 来替换 skill。';
      const en =
        mode === 'add'
          ? 'Provide content, or provide name / description / body together to create the skill.'
          : 'Provide content, or provide name / description / body together to replace the skill.';
      return { kind: 'invalid', message: localizedError(language, zh, en) };
    }

    const allowedTools = parseAllowedToolsArg(args);
    const userInvocable = parseOptionalBooleanArg(args, 'user_invocable');
    const disableModelInvocation = parseOptionalBooleanArg(args, 'disable_model_invocation');
    const generated = buildSkillMarkdown({
      name,
      description,
      body,
      allowedTools,
      userInvocable,
      disableModelInvocation,
    });
    return validateSkillMarkdownContent(language, generated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', message: localizedError(language, msg, msg) };
  }
}

function stripMarkdownFrontmatterForImport(raw: string): string {
  const normalized = normalizeMarkdownText(raw);
  if (!normalized.startsWith('---\n')) return normalized;

  const endWithBody = normalized.indexOf('\n---\n', 4);
  const endAtEof = normalized.endsWith('\n---') ? normalized.length - '\n---'.length : -1;
  const end = endWithBody >= 0 ? endWithBody : endAtEof;
  if (end < 0) return normalized;
  return endWithBody >= 0
    ? normalized.slice(end + '\n---\n'.length)
    : normalized.slice(end + '\n---'.length);
}

function parseImportSkillContentArgs(
  language: LanguageCode,
  sourceContent: string,
  args: ToolArguments,
): SkillContentArgs {
  try {
    const replaceFrontmatterValue = args['replace_frontmatter'];
    if (replaceFrontmatterValue !== undefined && typeof replaceFrontmatterValue !== 'boolean') {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'replace_frontmatter 必须是 boolean。',
          'replace_frontmatter must be boolean.',
        ),
      };
    }
    if (replaceFrontmatterValue !== true) {
      const normalizedContent = sourceContent.endsWith('\n') ? sourceContent : `${sourceContent}\n`;
      const validatedContent = validateSkillMarkdownContent(language, normalizedContent);
      if (validatedContent.kind === 'invalid') return validatedContent;
      return { kind: 'ok', content: validatedContent.content };
    }

    const name = parseOptionalStringArg(args, 'name')?.trim();
    const description = parseOptionalStringArg(args, 'description')?.trim();
    if (!name || !description) {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          'replace_frontmatter=true 时必须提供 name 和 description。',
          'When replace_frontmatter=true, provide name and description.',
        ),
      };
    }

    const body = stripMarkdownFrontmatterForImport(sourceContent).trimEnd();
    if (!body) {
      return {
        kind: 'invalid',
        message: localizedError(
          language,
          '源文件正文不能为空。',
          'Source file markdown body must not be empty.',
        ),
      };
    }

    const allowedTools = parseAllowedToolsArg(args);
    const userInvocable = parseOptionalBooleanArg(args, 'user_invocable');
    const disableModelInvocation = parseOptionalBooleanArg(args, 'disable_model_invocation');
    const generated = buildSkillMarkdown({
      name,
      description,
      body,
      allowedTools,
      userInvocable,
      disableModelInvocation,
    });
    return validateSkillMarkdownContent(language, generated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', message: localizedError(language, msg, msg) };
  }
}

function skillContentProperties(): Record<string, unknown> {
  return {
    skill_id: {
      type: 'string',
      description: 'One-segment personal skill identifier under your own skill store.',
    },
    variant: {
      type: 'string',
      enum: ['cn', 'en', 'neutral'],
      description: 'Language variant to write. Defaults to neutral (SKILL.md).',
    },
    content: {
      type: 'string',
      description:
        'Full SKILL markdown content, including YAML frontmatter. If omitted, provide name/description/body.',
    },
    name: { type: 'string', description: 'Skill frontmatter name.' },
    description: { type: 'string', description: 'Skill frontmatter description.' },
    body: { type: 'string', description: 'Skill markdown body.' },
    allowed_tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Advisory upstream allowed-tools metadata; does not grant Dominds tools.',
    },
    user_invocable: {
      type: 'boolean',
      description: 'Compatibility metadata for public skill formats.',
    },
    disable_model_invocation: {
      type: 'boolean',
      description: 'Compatibility metadata for public skill formats.',
    },
  };
}

function parseSkillTarget(
  language: LanguageCode,
  caller: Team.Member,
  args: ToolArguments,
): SkillPathResult | Readonly<{ kind: 'invalid_path'; message: string }> {
  const skillIdValue = args['skill_id'];
  const skillId = typeof skillIdValue === 'string' ? skillIdValue : '';
  return getPersonalSkillPackagePath({ language, caller, skillId });
}

function parsePersonalSkillWriteMode(raw: unknown): PersonalSkillWriteMode {
  if (raw === undefined) return 'add';
  if (raw === 'add' || raw === 'replace') return raw;
  throw new Error('Invalid import_mode (expected "add" or "replace").');
}

function preparePersonalSkillPackageForWrite(params: {
  language: LanguageCode;
  target: Extract<SkillPathResult, { kind: 'ok' }>;
}): CopyOnWritePersonalSkillResult {
  const packageState = readPersonalSkillPackageState(params.target.abs);
  if (packageState.kind === 'symlink') {
    const materialized = materializeLinkedPersonalSkillPackage({
      language: params.language,
      skillId: params.target.skillId,
      packageAbs: params.target.abs,
    });
    if (materialized.kind === 'failure') return materialized;
  }
  if (packageState.kind === 'not_directory') {
    return {
      kind: 'failure',
      output: rejectPersonalSkillNonDirectory(params.language, params.target.skillId),
    };
  }
  return { kind: 'ok' };
}

function writePersonalSkillVariant(params: {
  language: LanguageCode;
  target: Extract<SkillPathResult, { kind: 'ok' }>;
  variant: SkillVariant;
  content: string;
  mode: PersonalSkillWriteMode;
}): ToolCallOutput {
  const prepared = preparePersonalSkillPackageForWrite({
    language: params.language,
    target: params.target,
  });
  if (prepared.kind === 'failure') return prepared.output;

  const fileName = skillFileName(params.variant);
  const fullPath = path.join(params.target.abs, fileName);
  const existingFileStat = lstatOrNull(fullPath);
  const exists = existingFileStat !== null;
  if (params.mode === 'add' && exists) {
    return toolFailure(
      params.language === 'zh'
        ? `错误：个人 skill '${params.target.skillId}' 的 ${fileName} 已存在。请使用 replace_personal_skill 更新它。`
        : `Error: Personal skill '${params.target.skillId}' ${fileName} already exists. Use replace_personal_skill to update it.`,
    );
  }
  if (params.mode === 'replace' && !exists) {
    return toolFailure(
      params.language === 'zh'
        ? `错误：个人 skill '${params.target.skillId}' 的 ${fileName} 不存在。请使用 add_personal_skill 创建它。`
        : `Error: Personal skill '${params.target.skillId}' ${fileName} does not exist. Use add_personal_skill to create it.`,
    );
  }
  if (existingFileStat && !existingFileStat.isFile() && !existingFileStat.isSymbolicLink()) {
    return toolFailure(
      params.language === 'zh'
        ? `错误：个人 skill '${params.target.skillId}' 的 ${fileName} 已存在但不是文件。`
        : `Error: Personal skill '${params.target.skillId}' ${fileName} already exists but is not a file.`,
    );
  }

  fs.mkdirSync(params.target.abs, { recursive: true });
  if (existingFileStat?.isSymbolicLink()) {
    fs.unlinkSync(fullPath);
  }
  fs.writeFileSync(fullPath, params.content, 'utf8');
  return formatToolActionResult(params.language, params.mode === 'add' ? 'added' : 'updated');
}

export const addPersonalSkillTool: FuncTool = {
  type: 'func',
  name: 'add_personal_skill',
  description: 'Create a new personal skill package for the current agent.',
  descriptionI18n: {
    en: 'Create a new personal skill package for the current agent.',
    zh: '为当前智能体创建新的个人 skill 包。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['skill_id'],
    properties: skillContentProperties(),
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const target = parseSkillTarget(language, caller, args);
    if (target.kind === 'invalid_path') return toolFailure(target.message);

    let variant: SkillVariant;
    try {
      variant = parseSkillVariant(args['variant']);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(localizedError(language, msg, msg));
    }

    const content = parseSkillContentArgs(language, args, 'add');
    if (content.kind === 'invalid') return toolFailure(content.message);

    return writePersonalSkillVariant({
      language,
      target,
      variant,
      content: content.content,
      mode: 'add',
    });
  },
};

export const replacePersonalSkillTool: FuncTool = {
  type: 'func',
  name: 'replace_personal_skill',
  description: 'Replace an existing personal skill variant for the current agent.',
  descriptionI18n: {
    en: 'Replace an existing personal skill variant for the current agent.',
    zh: '替换当前智能体已有个人 skill 的指定语言变体。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['skill_id'],
    properties: skillContentProperties(),
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const target = parseSkillTarget(language, caller, args);
    if (target.kind === 'invalid_path') return toolFailure(target.message);

    let variant: SkillVariant;
    try {
      variant = parseSkillVariant(args['variant']);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(localizedError(language, msg, msg));
    }

    const content = parseSkillContentArgs(language, args, 'replace');
    if (content.kind === 'invalid') return toolFailure(content.message);

    return writePersonalSkillVariant({
      language,
      target,
      variant,
      content: content.content,
      mode: 'replace',
    });
  },
};

export const importPersonalSkillFromFileTool: FuncTool = {
  type: 'func',
  name: 'import_personal_skill_from_file',
  description: 'Import a personal skill variant from an rtws markdown file.',
  descriptionI18n: {
    en: 'Import a personal skill variant from an rtws markdown file.',
    zh: '从 rtws markdown 文件导入当前智能体的个人 skill 变体。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['skill_id', 'source_path'],
    properties: {
      skill_id: {
        type: 'string',
        description: 'One-segment personal skill identifier under your own skill store.',
      },
      source_path: {
        type: 'string',
        description:
          'rtws-relative markdown file path to import. The file is read directly, so long skill bodies do not need to be copied into tool arguments.',
      },
      import_mode: {
        type: 'string',
        enum: ['add', 'replace'],
        description: 'Defaults to add. Use replace to overwrite an existing variant.',
      },
      variant: {
        type: 'string',
        enum: ['cn', 'en', 'neutral'],
        description: 'Language variant to write. Defaults to neutral (SKILL.md).',
      },
      replace_frontmatter: {
        type: 'boolean',
        description:
          'When true, strip source frontmatter and rebuild it from name/description and optional metadata args.',
      },
      name: { type: 'string', description: 'Required when replace_frontmatter=true.' },
      description: {
        type: 'string',
        description: 'Required when replace_frontmatter=true.',
      },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Advisory upstream allowed-tools metadata; does not grant Dominds tools.',
      },
      user_invocable: {
        type: 'boolean',
        description: 'Compatibility metadata for public skill formats.',
      },
      disable_model_invocation: {
        type: 'boolean',
        description: 'Compatibility metadata for public skill formats.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const target = parseSkillTarget(language, caller, args);
    if (target.kind === 'invalid_path') return toolFailure(target.message);

    let variant: SkillVariant;
    let importMode: PersonalSkillWriteMode;
    try {
      variant = parseSkillVariant(args['variant']);
      importMode = parsePersonalSkillWriteMode(args['import_mode']);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(localizedError(language, msg, msg));
    }

    const sourcePathValue = args['source_path'];
    const sourceRel = typeof sourcePathValue === 'string' ? sourcePathValue.trim() : '';
    if (!sourceRel) {
      return toolFailure(
        localizedError(language, 'source_path 不能为空。', 'source_path is required.'),
      );
    }
    const sourceAbs = path.resolve(process.cwd(), sourceRel);
    if (!isPathInsideRtws(sourceAbs)) {
      return toolFailure(
        localizedError(
          language,
          'source_path 必须位于 rtws（运行时工作区）内。',
          'source_path must be within rtws (runtime workspace).',
        ),
      );
    }
    if (!hasReadAccess(caller, sourceRel)) {
      return toolFailure(getAccessDeniedMessage('read', sourceRel, language));
    }

    let sourceStat: fs.Stats;
    let sourceContent: string;
    try {
      sourceStat = fs.statSync(sourceAbs);
      if (!sourceStat.isFile()) {
        return toolFailure(
          localizedError(language, 'source_path 必须是文件。', 'source_path must be a file.'),
        );
      }
      sourceContent = fs.readFileSync(sourceAbs, 'utf8');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(localizedError(language, msg, msg));
    }

    const content = parseImportSkillContentArgs(language, sourceContent, args);
    if (content.kind === 'invalid') return toolFailure(content.message);

    return writePersonalSkillVariant({
      language,
      target,
      variant,
      content: content.content,
      mode: importMode,
    });
  },
};

export const dropPersonalSkillTool: FuncTool = {
  type: 'func',
  name: 'drop_personal_skill',
  description: 'Remove one personal skill package or one variant from the current agent.',
  descriptionI18n: {
    en: 'Remove one personal skill package or one variant from the current agent.',
    zh: '删除当前智能体的一个个人 skill 包，或删除其中一个语言变体。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['skill_id'],
    properties: {
      skill_id: {
        type: 'string',
        description: 'One-segment personal skill identifier under your own skill store.',
      },
      variant: {
        type: 'string',
        enum: ['cn', 'en', 'neutral'],
        description: 'When provided, remove only this variant. Otherwise remove the package.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, caller, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const target = parseSkillTarget(language, caller, args);
    if (target.kind === 'invalid_path') return toolFailure(target.message);

    const packageState = readPersonalSkillPackageState(target.abs);
    if (packageState.kind === 'not_directory') {
      return rejectPersonalSkillNonDirectory(language, target.skillId);
    }

    if (packageState.kind === 'symlink' && args['variant'] === undefined) {
      fs.unlinkSync(target.abs);
      return formatToolActionResult(language, 'deleted');
    }

    if (args['variant'] !== undefined) {
      let variant: SkillVariant;
      try {
        variant = parseSkillVariant(args['variant']);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolFailure(localizedError(language, msg, msg));
      }
      const fullPath = path.join(target.abs, skillFileName(variant));
      const fileStat = lstatOrNull(fullPath);
      if (fileStat === null) {
        return toolFailure(
          language === 'zh'
            ? `错误：个人 skill '${target.skillId}' 的 ${skillFileName(variant)} 不存在。`
            : `Error: Personal skill '${target.skillId}' ${skillFileName(variant)} does not exist.`,
        );
      }
      if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
        return toolFailure(
          language === 'zh'
            ? `错误：个人 skill '${target.skillId}' 的 ${skillFileName(variant)} 已存在但不是文件。`
            : `Error: Personal skill '${target.skillId}' ${skillFileName(variant)} already exists but is not a file.`,
        );
      }
      fs.unlinkSync(fullPath);
      return formatToolActionResult(language, 'deleted');
    }

    if (packageState.kind === 'missing') {
      return toolFailure(
        language === 'zh'
          ? `错误：个人 skill '${target.skillId}' 不存在。`
          : `Error: Personal skill '${target.skillId}' does not exist.`,
      );
    }
    fs.rmSync(target.abs, { recursive: true, force: false });
    return formatToolActionResult(language, 'deleted');
  },
};
