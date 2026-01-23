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
  if (selector === '!goals') return 'goals';
  if (selector === '!constraints') return 'constraints';
  if (selector === '!progress') return 'progress';
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
  if (section === 'goals') return '*Missing `goals.md`. Create it with `!?@change_mind !goals`.*';
  if (section === 'constraints')
    return '*Missing `constraints.md`. Create it with `!?@change_mind !constraints`.*';
  if (section === 'progress')
    return '*Missing `progress.md`. Create it with `!?@change_mind !progress`.*';
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
    if (section === 'goals') return '*缺少 `goals.md`。请用 `!?@change_mind !goals` 创建。*';
    if (section === 'constraints')
      return '*缺少 `constraints.md`。请用 `!?@change_mind !constraints` 创建。*';
    if (section === 'progress')
      return '*缺少 `progress.md`。请用 `!?@change_mind !progress` 创建。*';
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
      `> 维护方式：每次 \`!?@change_mind\` 必须指定一个分段（\`!goals\` / \`!constraints\` / \`!progress\`）。可在同一条消息中连续发出多个 \`!?@change_mind\` 来一次更新多个分段。`,
      ``,
      `## 目标 (通过 \`!?@change_mind !goals\` 维护)`,
      formatSectionBodyI18n(language, 'goals', sections.goals),
      ``,
      `## 约束 (通过 \`!?@change_mind !constraints\` 维护)`,
      formatSectionBodyI18n(language, 'constraints', sections.constraints),
      ``,
      `## 进展 (通过 \`!?@change_mind !progress\` 维护)`,
      formatSectionBodyI18n(language, 'progress', sections.progress),
    ].join('\n');
  }
  return [
    `# Task Doc`,
    ``,
    `> Our task doc is composed of exactly 3 sections: Goals / Constraints / Progress.`,
    `> Maintenance: each \`!?@change_mind\` call must target one section (\`!goals\` / \`!constraints\` / \`!progress\`). You may include multiple \`!?@change_mind\` calls in a single message to update multiple sections.`,
    ``,
    `## Goals (subject to \`!?@change_mind !goals\`)`,
    formatSectionBodyI18n(language, 'goals', sections.goals),
    ``,
    `## Constraints (subject to \`!?@change_mind !constraints\`)`,
    formatSectionBodyI18n(language, 'constraints', sections.constraints),
    ``,
    `## Progress (subject to \`!?@change_mind !progress\`)`,
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
