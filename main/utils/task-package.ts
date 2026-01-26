/**
 * Module: utils/task-package
 *
 * Encapsulated Task Docs (`*.tsk/`).
 *
 * A Task Doc is a directory ending in `.tsk`. It *may* contain:
 * - goals.md
 * - constraints.md
 * - progress.md
 *
 * These files are considered high-integrity state and MUST NOT be accessible via general file tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LanguageCode } from '../shared/types/language';

export type TaskPackageSection = 'goals' | 'constraints' | 'progress';

export type TaskPackageSectionState = { kind: 'present'; content: string } | { kind: 'missing' };

export interface TaskPackageSectionsState {
  goals: TaskPackageSectionState;
  constraints: TaskPackageSectionState;
  progress: TaskPackageSectionState;
}

const sectionToFilename: Record<TaskPackageSection, string> = {
  goals: 'goals.md',
  constraints: 'constraints.md',
  progress: 'progress.md',
};

function normalizeTaskPackagePath(taskDocPath: string): string {
  return taskDocPath.replace(/\\/g, '/').replace(/\/+$/g, '');
}

export function isTaskPackagePath(taskDocPath: string): boolean {
  return normalizeTaskPackagePath(taskDocPath).endsWith('.tsk');
}

export function taskPackageSectionFromSelector(selector: string): TaskPackageSection | null {
  const normalized = selector.startsWith('!') ? selector.slice(1) : selector;
  if (normalized === 'goals') return normalized;
  if (normalized === 'constraints') return normalized;
  if (normalized === 'progress') return normalized;
  return null;
}

export function taskPackageFilenameForSection(section: TaskPackageSection): string {
  return sectionToFilename[section];
}

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await fs.promises.stat(fullPath);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}

export async function ensureTaskPackage(
  taskPackageDirFullPath: string,
  _updatedBy?: string,
): Promise<void> {
  await fs.promises.mkdir(taskPackageDirFullPath, { recursive: true });
}

async function readSectionFile(sectionPath: string): Promise<TaskPackageSectionState> {
  if (!(await fileExists(sectionPath))) {
    return { kind: 'missing' };
  }
  const content = await fs.promises.readFile(sectionPath, 'utf8');
  return { kind: 'present', content };
}

export async function readTaskPackageSections(
  taskPackageDirFullPath: string,
): Promise<TaskPackageSectionsState> {
  const goals = await readSectionFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('goals')),
  );
  const constraints = await readSectionFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('constraints')),
  );
  const progress = await readSectionFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('progress')),
  );
  return { goals, constraints, progress };
}

function formatSectionBody(section: TaskPackageSection, state: TaskPackageSectionState): string {
  if (state.kind === 'present') return state.content;
  if (section === 'goals')
    return '*Missing `goals.md`. Create it with `change_mind` (selector `goals`).*';
  if (section === 'constraints')
    return '*Missing `constraints.md`. Create it with `change_mind` (selector `constraints`).*';
  if (section === 'progress')
    return '*Missing `progress.md`. Create it with `change_mind` (selector `progress`).*';
  const _exhaustive: never = section;
  return String(_exhaustive);
}

function formatSectionBodyI18n(
  language: LanguageCode,
  section: TaskPackageSection,
  state: TaskPackageSectionState,
): string {
  if (state.kind === 'present') return state.content;
  if (language === 'zh') {
    if (section === 'goals')
      return '*缺少 `goals.md`。请用 `change_mind`（selector 为 `goals`）创建。*';
    if (section === 'constraints')
      return '*缺少 `constraints.md`。请用 `change_mind`（selector 为 `constraints`）创建。*';
    if (section === 'progress')
      return '*缺少 `progress.md`。请用 `change_mind`（selector 为 `progress`）创建。*';
    const _exhaustiveZh: never = section;
    return String(_exhaustiveZh);
  }
  return formatSectionBody(section, state);
}

export function formatEffectiveTaskDocFromSections(
  language: LanguageCode,
  sections: TaskPackageSectionsState,
): string {
  // Deterministic framing only; section bodies are treated as opaque markdown.
  if (language === 'zh') {
    return [
      `# 差遣牒`,
      ``,
      `> 我们的差遣牒由三个分段构成：目标/约束/进展。`,
      `> 全队共享：\`goals\` / \`constraints\` / \`progress\` 对所有队友与子对话可见。更新时禁止覆盖/抹掉他人条目；建议为自己维护的条目标注责任人（如 \`- [owner:@<id>] ...\`）。`,
      `> 维护方式：每次 \`change_mind\` 必须指定一个分段（selector 为 \`goals\` / \`constraints\` / \`progress\`）。每次调用会替换该分段全文：必须先对照上下文中注入的当前内容并做合并/压缩；可在同一条消息中连续调用多次 \`change_mind\` 来一次更新多个分段。`,
      `> 注意：子对话中不允许 \`change_mind\`；需要更新时请把“合并好的分段全文替换稿”诉请差遣牒维护人（见注入的差遣牒状态区块里的 @id）执行（禁止覆盖/抹掉他人条目）。`,
      ``,
      `## 目标 (通过 \`change_mind\`，selector=\`goals\` 维护)`,
      formatSectionBodyI18n(language, 'goals', sections.goals),
      ``,
      `## 约束 (通过 \`change_mind\`，selector=\`constraints\` 维护)`,
      formatSectionBodyI18n(language, 'constraints', sections.constraints),
      ``,
      `## 进展 (通过 \`change_mind\`，selector=\`progress\` 维护)`,
      formatSectionBodyI18n(language, 'progress', sections.progress),
    ].join('\n');
  }
  return [
    `# Taskdoc`,
    ``,
    `> Our Taskdoc is composed of exactly 3 sections: Goals / Constraints / Progress.`,
    `> Team-shared: \`goals\` / \`constraints\` / \`progress\` are visible to all teammates and subdialogs. Do not overwrite/delete other contributors; add an owner marker for entries you maintain (e.g. \`- [owner:@<id>] ...\`).`,
    `> Maintenance: each \`change_mind\` call must target one section (selector \`goals\` / \`constraints\` / \`progress\`). Each call replaces the entire section, so always start from current content and merge/compress. You may include multiple \`change_mind\` calls in a single message to update multiple sections.`,
    `> Note: subdialogs cannot call \`change_mind\`; ask the Taskdoc maintainer (see the injected Taskdoc status block for the @id) with a fully merged full-section replacement draft (do not overwrite/delete other contributors).`,
    ``,
    `## Goals (maintained via \`change_mind\`, selector=\`goals\`)`,
    formatSectionBodyI18n(language, 'goals', sections.goals),
    ``,
    `## Constraints (maintained via \`change_mind\`, selector=\`constraints\`)`,
    formatSectionBodyI18n(language, 'constraints', sections.constraints),
    ``,
    `## Progress (maintained via \`change_mind\`, selector=\`progress\`)`,
    formatSectionBodyI18n(language, 'progress', sections.progress),
  ].join('\n');
}

export async function updateTaskPackageSection(params: {
  taskPackageDirFullPath: string;
  section: TaskPackageSection;
  content: string;
  updatedBy?: string;
}): Promise<void> {
  const { taskPackageDirFullPath, section, content, updatedBy } = params;
  await ensureTaskPackage(taskPackageDirFullPath, updatedBy);

  const filePath = path.join(taskPackageDirFullPath, taskPackageFilenameForSection(section));
  await fs.promises.writeFile(filePath, content, 'utf8');
}
