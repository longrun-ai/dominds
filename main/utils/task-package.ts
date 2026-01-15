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
import { formatUnifiedTimestamp } from '../shared/utils/time';

export type TaskPackageSection = 'goals' | 'constraints' | 'progress';

export interface TaskPackageSections {
  goals: string;
  constraints: string;
  progress: string;
}

export interface TaskPackageMetaV1Section {
  updatedAt: string;
  updatedBy?: string;
}

export interface TaskPackageMetaV1 {
  schemaVersion: 1;
  updatedAt: string;
  sections: {
    goals: TaskPackageMetaV1Section;
    constraints: TaskPackageMetaV1Section;
    progress: TaskPackageMetaV1Section;
  };
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

export function getTaskPackageMetaPath(taskPackageDirFullPath: string): string {
  return path.join(taskPackageDirFullPath, 'meta.json');
}

function buildFreshMeta(updatedBy?: string): TaskPackageMetaV1 {
  const now = formatUnifiedTimestamp(new Date());
  const base: TaskPackageMetaV1Section = updatedBy
    ? { updatedAt: now, updatedBy }
    : { updatedAt: now };
  return {
    schemaVersion: 1,
    updatedAt: now,
    sections: {
      goals: base,
      constraints: base,
      progress: base,
    },
  };
}

function parseMetaV1(raw: unknown): TaskPackageMetaV1 | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['schemaVersion'] !== 1) return null;
  if (typeof obj['updatedAt'] !== 'string') return null;
  const sections = obj['sections'];
  if (typeof sections !== 'object' || sections === null) return null;
  const sec = sections as Record<string, unknown>;
  const goals = sec['goals'];
  const constraints = sec['constraints'];
  const progress = sec['progress'];
  const parseSection = (v: unknown): TaskPackageMetaV1Section | null => {
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r['updatedAt'] !== 'string') return null;
    const updatedBy = r['updatedBy'];
    if (updatedBy !== undefined && typeof updatedBy !== 'string') return null;
    return updatedBy ? { updatedAt: r['updatedAt'], updatedBy } : { updatedAt: r['updatedAt'] };
  };
  const g = parseSection(goals);
  const c = parseSection(constraints);
  const p = parseSection(progress);
  if (!g || !c || !p) return null;
  return {
    schemaVersion: 1,
    updatedAt: obj['updatedAt'],
    sections: { goals: g, constraints: c, progress: p },
  };
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
  updatedBy?: string,
): Promise<void> {
  await fs.promises.mkdir(taskPackageDirFullPath, { recursive: true });

  for (const filename of Object.values(sectionToFilename)) {
    await ensureFileExists(path.join(taskPackageDirFullPath, filename));
  }

  const metaPath = getTaskPackageMetaPath(taskPackageDirFullPath);
  if (!(await fileExists(metaPath))) {
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify(buildFreshMeta(updatedBy), null, 2),
      'utf8',
    );
    return;
  }

  // Ensure meta parses; if corrupted, reset to a fresh meta (high-integrity state).
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const parsedUnknown: unknown = JSON.parse(raw);
    if (!parseMetaV1(parsedUnknown)) {
      await fs.promises.writeFile(
        metaPath,
        JSON.stringify(buildFreshMeta(updatedBy), null, 2),
        'utf8',
      );
    }
  } catch {
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify(buildFreshMeta(updatedBy), null, 2),
      'utf8',
    );
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

  const metaPath = getTaskPackageMetaPath(taskPackageDirFullPath);
  let meta: TaskPackageMetaV1 = buildFreshMeta(updatedBy);
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const parsedUnknown: unknown = JSON.parse(raw);
    const parsed = parseMetaV1(parsedUnknown);
    if (parsed) {
      meta = parsed;
    }
  } catch {
    // fall back to fresh meta
  }

  const now = formatUnifiedTimestamp(new Date());
  const secMeta: TaskPackageMetaV1Section = updatedBy
    ? { updatedAt: now, updatedBy }
    : { updatedAt: now };
  meta.updatedAt = now;
  if (section === 'goals') meta.sections.goals = secMeta;
  if (section === 'constraints') meta.sections.constraints = secMeta;
  if (section === 'progress') meta.sections.progress = secMeta;

  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}
