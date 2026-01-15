/**
 * Module: utils/task-package
 *
 * Encapsulated task document packages (`*.tsk/`).
 *
 * A task package is a directory ending in `.tsk` containing:
 * - goals.md
 * - constraints.md
 * - progress.md
 *
 * These files are considered high-integrity state and MUST NOT be accessible via general file tools.
 */

import * as fs from 'fs';
import * as path from 'path';

export type TaskPackageSection = 'goals' | 'constraints' | 'progress';

export interface TaskPackageSections {
  goals: string;
  constraints: string;
  progress: string;
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

async function ensureFileExists(fullPath: string): Promise<void> {
  if (await fileExists(fullPath)) return;
  await fs.promises.writeFile(fullPath, '', 'utf8');
}

export async function ensureTaskPackage(
  taskPackageDirFullPath: string,
  _updatedBy?: string,
): Promise<void> {
  await fs.promises.mkdir(taskPackageDirFullPath, { recursive: true });

  for (const filename of Object.values(sectionToFilename)) {
    await ensureFileExists(path.join(taskPackageDirFullPath, filename));
  }
}

export async function readTaskPackageSections(
  taskPackageDirFullPath: string,
): Promise<TaskPackageSections> {
  const goals = await fs.promises.readFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('goals')),
    'utf8',
  );
  const constraints = await fs.promises.readFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('constraints')),
    'utf8',
  );
  const progress = await fs.promises.readFile(
    path.join(taskPackageDirFullPath, taskPackageFilenameForSection('progress')),
    'utf8',
  );
  return { goals, constraints, progress };
}

export function formatEffectiveTaskDocFromSections(sections: TaskPackageSections): string {
  // Deterministic framing only; section bodies are treated as opaque markdown.
  return [
    `# Task Doc (Dialog Tree)`,
    ``,
    `## Goals`,
    sections.goals,
    ``,
    `## Constraints`,
    sections.constraints,
    ``,
    `## Progress`,
    sections.progress,
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
