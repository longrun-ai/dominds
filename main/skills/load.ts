import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { parseMarkdownFrontmatter } from '../markdown/frontmatter';

export type WorkspaceSkillScope = 'team_shared' | 'individual';

export type LoadedWorkspaceSkill = Readonly<{
  id: string;
  title: string;
  description: string;
  prompt: string;
  body: string;
  scope: WorkspaceSkillScope;
  sourcePathAbs: string;
  sourcePathRel: string;
  declaredAllowedTools?: ReadonlyArray<string>;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}>;

type SkillVariant = 'en' | 'cn' | 'neutral';

type SkillCandidateFile = Readonly<{
  fileName: string;
  filePathAbs: string;
  filePathRel: string;
  variant: SkillVariant;
}>;

type SkillCandidateGroup = Readonly<{
  id: string;
  files: ReadonlyArray<SkillCandidateFile>;
}>;

type ParsedSkillFrontmatter = Readonly<{
  name: string;
  description: string;
  declaredAllowedTools?: ReadonlyArray<string>;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}>;

function parseSkillDirectFileName(fileName: string): Readonly<{
  skillId: string;
  variant: SkillVariant;
}> | null {
  const match = /^(?<stem>.+?)(?:\.(?<lang>en|cn))?\.md$/i.exec(fileName);
  if (!match || !match.groups) return null;
  const stem = match.groups['stem']?.trim() ?? '';
  if (stem === '') return null;
  const lang = match.groups['lang']?.toLowerCase();
  const variant: SkillVariant = lang === 'en' || lang === 'cn' ? lang : 'neutral';
  return { skillId: stem, variant };
}

function parseSkillPackageFileName(fileName: string): SkillVariant | null {
  const lowered = fileName.toLowerCase();
  if (lowered === 'skill.md') return 'neutral';
  if (lowered === 'skill.en.md') return 'en';
  if (lowered === 'skill.cn.md') return 'cn';
  return null;
}

function getPreferredSkillVariants(language: LanguageCode): readonly SkillVariant[] {
  if (language === 'zh') {
    return ['cn', 'neutral'];
  }
  return ['en', 'neutral'];
}

function pickSkillCandidateFile(
  files: ReadonlyArray<SkillCandidateFile>,
  language: LanguageCode,
): SkillCandidateFile | null {
  const variantsByKind = new Map<SkillVariant, SkillCandidateFile[]>();
  for (const file of files) {
    const bucket = variantsByKind.get(file.variant);
    if (bucket) {
      bucket.push(file);
    } else {
      variantsByKind.set(file.variant, [file]);
    }
  }

  for (const [variant, bucket] of variantsByKind.entries()) {
    if (bucket.length > 1) {
      const filesText = bucket.map((item) => item.filePathRel).join(', ');
      throw new Error(`Duplicate skill variant '${variant}' detected: ${filesText}`);
    }
  }

  for (const variant of getPreferredSkillVariants(language)) {
    const bucket = variantsByKind.get(variant);
    if (bucket && bucket.length === 1) {
      return bucket[0];
    }
  }
  return null;
}

function parseSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  sourcePathRel: string,
): ParsedSkillFrontmatter {
  const nameValue = frontmatter['name'];
  if (typeof nameValue !== 'string' || nameValue.trim() === '') {
    throw new Error(`Invalid skill frontmatter: 'name' is required (${sourcePathRel})`);
  }

  const descriptionValue = frontmatter['description'];
  if (typeof descriptionValue !== 'string' || descriptionValue.trim() === '') {
    throw new Error(`Invalid skill frontmatter: 'description' is required (${sourcePathRel})`);
  }

  const allowedToolsValue = frontmatter['allowed-tools'];
  const declaredAllowedTools = (() => {
    if (allowedToolsValue === undefined) return undefined;
    if (typeof allowedToolsValue === 'string') {
      const values = allowedToolsValue
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      if (values.length === 0) {
        throw new Error(
          `Invalid skill frontmatter: 'allowed-tools' string must not be empty (${sourcePathRel})`,
        );
      }
      return values;
    }
    if (!Array.isArray(allowedToolsValue)) {
      throw new Error(
        `Invalid skill frontmatter: 'allowed-tools' must be a string or string[] (${sourcePathRel})`,
      );
    }
    const values: string[] = [];
    for (let index = 0; index < allowedToolsValue.length; index += 1) {
      const item = allowedToolsValue[index];
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(
          `Invalid skill frontmatter: 'allowed-tools[${String(index)}]' must be a non-empty string (${sourcePathRel})`,
        );
      }
      values.push(item.trim());
    }
    return values;
  })();

  const userInvocableValue = frontmatter['user-invocable'];
  if (userInvocableValue !== undefined && typeof userInvocableValue !== 'boolean') {
    throw new Error(
      `Invalid skill frontmatter: 'user-invocable' must be boolean (${sourcePathRel})`,
    );
  }

  const disableModelInvocationValue = frontmatter['disable-model-invocation'];
  if (
    disableModelInvocationValue !== undefined &&
    typeof disableModelInvocationValue !== 'boolean'
  ) {
    throw new Error(
      `Invalid skill frontmatter: 'disable-model-invocation' must be boolean (${sourcePathRel})`,
    );
  }

  for (const key of Object.keys(frontmatter)) {
    if (
      key !== 'name' &&
      key !== 'description' &&
      key !== 'allowed-tools' &&
      key !== 'user-invocable' &&
      key !== 'disable-model-invocation'
    ) {
      throw new Error(`Invalid skill frontmatter: unsupported key '${key}' (${sourcePathRel})`);
    }
  }

  return {
    name: nameValue.trim(),
    description: descriptionValue.trim(),
    declaredAllowedTools,
    userInvocable: userInvocableValue,
    disableModelInvocation: disableModelInvocationValue,
  };
}

async function readScopeSkillCandidates(params: {
  scopeRootAbs: string;
  scopeRootRel: string;
}): Promise<ReadonlyArray<SkillCandidateGroup>> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(params.scopeRootAbs, { withFileTypes: true });
  } catch (error: unknown) {
    const isEnoent =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) return [];
    throw error;
  }

  const groups = new Map<string, SkillCandidateFile[]>();
  const pushFile = (skillId: string, file: SkillCandidateFile): void => {
    const bucket = groups.get(skillId);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(skillId, [file]);
    }
  };

  for (const entry of entries) {
    if (entry.isFile()) {
      const parsed = parseSkillDirectFileName(entry.name);
      if (!parsed) continue;
      const filePathAbs = path.join(params.scopeRootAbs, entry.name);
      const filePathRel = path.join(params.scopeRootRel, entry.name);
      pushFile(parsed.skillId, {
        fileName: entry.name,
        filePathAbs,
        filePathRel,
        variant: parsed.variant,
      });
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRootAbs = path.join(params.scopeRootAbs, entry.name);
    const packageRootRel = path.join(params.scopeRootRel, entry.name);
    let packageEntries: Dirent<string>[];
    try {
      packageEntries = await readdir(packageRootAbs, { withFileTypes: true });
    } catch (error: unknown) {
      const isEnoent =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT';
      if (isEnoent) continue;
      throw error;
    }
    for (const packageEntry of packageEntries) {
      if (!packageEntry.isFile()) continue;
      const variant = parseSkillPackageFileName(packageEntry.name);
      if (variant === null) continue;
      const filePathAbs = path.join(packageRootAbs, packageEntry.name);
      const filePathRel = path.join(packageRootRel, packageEntry.name);
      pushFile(entry.name, {
        fileName: packageEntry.name,
        filePathAbs,
        filePathRel,
        variant,
      });
    }
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, files]) => ({ id, files }));
}

async function loadScopeSkills(params: {
  rtwsRootAbs: string;
  memberId: string;
  language: LanguageCode;
  scope: WorkspaceSkillScope;
}): Promise<ReadonlyArray<LoadedWorkspaceSkill>> {
  const scopeRootRel =
    params.scope === 'team_shared'
      ? path.join('.minds', 'skills', 'team_shared')
      : path.join('.minds', 'skills', 'individual', params.memberId);
  const scopeRootAbs = path.resolve(params.rtwsRootAbs, scopeRootRel);
  const candidateGroups = await readScopeSkillCandidates({ scopeRootAbs, scopeRootRel });
  const loaded: LoadedWorkspaceSkill[] = [];

  for (const group of candidateGroups) {
    const selectedFile = pickSkillCandidateFile(group.files, params.language);
    if (!selectedFile) continue;
    const raw = await readFile(selectedFile.filePathAbs, 'utf-8');
    const { body, frontmatter } = parseMarkdownFrontmatter(
      raw,
      `skill '${selectedFile.filePathRel}'`,
    );
    const parsed = parseSkillFrontmatter(frontmatter, selectedFile.filePathRel);
    const prompt = body.trim();
    if (prompt === '') {
      throw new Error(
        `Invalid skill file: markdown body is required (${selectedFile.filePathRel})`,
      );
    }
    loaded.push({
      id: group.id,
      title: parsed.name,
      description: parsed.description,
      prompt,
      body: prompt,
      scope: params.scope,
      sourcePathAbs: selectedFile.filePathAbs,
      sourcePathRel: selectedFile.filePathRel,
      declaredAllowedTools: parsed.declaredAllowedTools,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
    });
  }

  return loaded;
}

export async function loadWorkspaceSkills(params: {
  rtwsRootAbs: string;
  memberId: string;
  language: LanguageCode;
}): Promise<ReadonlyArray<LoadedWorkspaceSkill>> {
  const teamSharedSkills = await loadScopeSkills({
    ...params,
    scope: 'team_shared',
  });
  const individualSkills = await loadScopeSkills({
    ...params,
    scope: 'individual',
  });
  return [...teamSharedSkills, ...individualSkills];
}

function renderScopeLabel(language: LanguageCode, scope: WorkspaceSkillScope): string {
  if (language === 'zh') {
    return scope === 'team_shared' ? '团队共享' : '个人';
  }
  return scope === 'team_shared' ? 'Team Shared' : 'Individual';
}

export function renderWorkspaceSkillsPrompt(params: {
  language: LanguageCode;
  skills: ReadonlyArray<LoadedWorkspaceSkill>;
}): string {
  if (params.skills.length === 0) return '';

  const title = params.language === 'zh' ? '### Skills（工作技能）' : '### Skills';
  const promptLabel = params.language === 'zh' ? '提示词' : 'Prompt';
  const descLabel = params.language === 'zh' ? '说明' : 'Description';
  const scopeLabel = params.language === 'zh' ? '作用域' : 'Scope';
  const allowedToolsLabel =
    params.language === 'zh' ? '上游 allowed-tools' : 'Upstream allowed-tools';
  const allowedToolsHint =
    params.language === 'zh'
      ? '仅作迁移提示；Dominds 不会据此自动授予工具权限，实际权限仍以 team.yaml / toolsets / apps 为准。'
      : 'Advisory only; Dominds does not auto-grant tool permissions from this field. Actual access still comes from team.yaml / toolsets / apps.';

  const blocks = params.skills.map((skill) => {
    const lines = [
      `#### ${skill.title}`,
      `- ${scopeLabel}: ${renderScopeLabel(params.language, skill.scope)}`,
      `- ${descLabel}: ${skill.description}`,
    ];
    if (skill.declaredAllowedTools && skill.declaredAllowedTools.length > 0) {
      lines.push(
        `- ${allowedToolsLabel}: ${skill.declaredAllowedTools.join(', ')} (${allowedToolsHint})`,
      );
    }
    lines.push(`- ${promptLabel}:`);
    const body = skill.body.trim();
    if (body !== '') {
      lines.push(body);
    }
    return lines.join('\n');
  });

  return [title, ...blocks].join('\n\n');
}
