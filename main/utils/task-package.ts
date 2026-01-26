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

export const BEAR_IN_MIND_SECTIONS = [
  'contracts',
  'acceptance',
  'grants',
  'runbook',
  'decisions',
  'risks',
] as const;

export type BearInMindSection = (typeof BEAR_IN_MIND_SECTIONS)[number];

export type TaskPackageBearInMindSectionsState = Record<BearInMindSection, TaskPackageSectionState>;

export type TaskPackageBearInMindState =
  | { kind: 'absent' }
  | {
      kind: 'present';
      sections: TaskPackageBearInMindSectionsState;
      extraEntries: readonly string[];
    }
  | { kind: 'invalid'; reason: 'not_a_directory' };

export type TaskPackageLayoutViolation =
  | { kind: 'top_level_file_under_subdir'; filename: string; foundAt: string }
  | { kind: 'bearinmind_file_outside_bearinmind'; filename: string; foundAt: string }
  | { kind: 'bearinmind_extra_entry'; foundAt: string }
  | { kind: 'bearinmind_not_directory'; foundAt: string }
  | { kind: 'scan_limit_exceeded'; maxEntries: number };

const sectionToFilename: Record<TaskPackageSection, string> = {
  goals: 'goals.md',
  constraints: 'constraints.md',
  progress: 'progress.md',
};

const bearInMindSectionToFilename: Record<BearInMindSection, string> = {
  contracts: 'contracts.md',
  acceptance: 'acceptance.md',
  grants: 'grants.md',
  runbook: 'runbook.md',
  decisions: 'decisions.md',
  risks: 'risks.md',
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

export function bearInMindFilenameForSection(section: BearInMindSection): string {
  return bearInMindSectionToFilename[section];
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

function formatSectionBodyI18n(state: TaskPackageSectionState): string {
  // Injection must be deterministic and treat section bodies as opaque markdown.
  // If a required file is missing, inject an empty body (status should be shown elsewhere).
  if (state.kind === 'present') return state.content;
  return '';
}

function formatBearInMindBody(state: TaskPackageSectionState): string | null {
  if (state.kind !== 'present') return null;
  if (state.content.trim() === '') return null;
  return state.content;
}

export function formatEffectiveTaskDocFromSections(
  language: LanguageCode,
  sections: TaskPackageSectionsState,
  bearInMind?: TaskPackageBearInMindState,
): string {
  // Deterministic framing only; section bodies are treated as opaque markdown.
  if (language === 'zh') {
    const bearBlocks: string[] = [];
    if (bearInMind?.kind === 'present') {
      for (const section of BEAR_IN_MIND_SECTIONS) {
        const body = formatBearInMindBody(bearInMind.sections[section]);
        if (!body) continue;
        bearBlocks.push(`### ${bearInMindFilenameForSection(section)}`, body);
      }
    }
    const bearInMindBlock =
      bearBlocks.length > 0 ? [`## Bear In Mind`, ...bearBlocks, ``].join('\n') : '';

    return [
      `# 差遣牒（对话树）`,
      ``,
      `## Goals`,
      formatSectionBodyI18n(sections.goals),
      ``,
      `## Constraints`,
      formatSectionBodyI18n(sections.constraints),
      ``,
      ...(bearInMindBlock ? [bearInMindBlock] : []),
      `## Progress`,
      formatSectionBodyI18n(sections.progress),
    ].join('\n');
  }
  const bearBlocks: string[] = [];
  if (bearInMind?.kind === 'present') {
    for (const section of BEAR_IN_MIND_SECTIONS) {
      const body = formatBearInMindBody(bearInMind.sections[section]);
      if (!body) continue;
      bearBlocks.push(`### ${bearInMindFilenameForSection(section)}`, body);
    }
  }
  const bearInMindBlock =
    bearBlocks.length > 0 ? [`## Bear In Mind`, ...bearBlocks, ``].join('\n') : '';

  return [
    `# Taskdoc (Dialog Tree)`,
    ``,
    `## Goals`,
    formatSectionBodyI18n(sections.goals),
    ``,
    `## Constraints`,
    formatSectionBodyI18n(sections.constraints),
    ``,
    ...(bearInMindBlock ? [bearInMindBlock] : []),
    `## Progress`,
    formatSectionBodyI18n(sections.progress),
  ].join('\n');
}

async function readBearInMindSections(
  taskPackageDirFullPath: string,
): Promise<TaskPackageBearInMindState> {
  const bearDir = path.join(taskPackageDirFullPath, 'bearinmind');
  try {
    const st = await fs.promises.stat(bearDir);
    if (!st.isDirectory()) {
      return { kind: 'invalid', reason: 'not_a_directory' };
    }
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return { kind: 'absent' };
    }
    throw err;
  }

  const sections: TaskPackageBearInMindSectionsState = {
    contracts: { kind: 'missing' },
    acceptance: { kind: 'missing' },
    grants: { kind: 'missing' },
    runbook: { kind: 'missing' },
    decisions: { kind: 'missing' },
    risks: { kind: 'missing' },
  };
  for (const section of BEAR_IN_MIND_SECTIONS) {
    sections[section] = await readSectionFile(
      path.join(bearDir, bearInMindFilenameForSection(section)),
    );
  }

  const extraEntries: string[] = [];
  const allowed = new Set(Object.values(bearInMindSectionToFilename));
  const entries = await fs.promises.readdir(bearDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!allowed.has(entry.name)) {
      extraEntries.push(entry.name);
    }
  }

  return { kind: 'present', sections, extraEntries };
}

export async function validateTaskPackageLayout(
  taskPackageDirFullPath: string,
): Promise<TaskPackageLayoutViolation[]> {
  const violations: TaskPackageLayoutViolation[] = [];
  const maxEntries = 2048;
  let seenEntries = 0;

  const topLevelFilenames = new Set(Object.values(sectionToFilename));
  const bearFilenames = new Set(Object.values(bearInMindSectionToFilename));
  const allowedBearDirEntries = new Set(Object.values(bearInMindSectionToFilename));

  const stack: { absDir: string; relDir: string }[] = [
    { absDir: taskPackageDirFullPath, relDir: '' },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur.absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      seenEntries++;
      if (seenEntries > maxEntries) {
        violations.push({ kind: 'scan_limit_exceeded', maxEntries });
        return violations;
      }

      const relPath = cur.relDir ? path.posix.join(cur.relDir, entry.name) : entry.name;
      const absPath = path.join(cur.absDir, entry.name);

      if (entry.isDirectory()) {
        if (cur.relDir === 'bearinmind') {
          violations.push({ kind: 'bearinmind_extra_entry', foundAt: relPath });
        }
        stack.push({ absDir: absPath, relDir: relPath.replace(/\\/g, '/') });
        continue;
      }

      if (!entry.isFile()) {
        if (cur.relDir === 'bearinmind') {
          violations.push({ kind: 'bearinmind_extra_entry', foundAt: relPath });
        }
        continue;
      }

      if (cur.relDir === 'bearinmind' && !allowedBearDirEntries.has(entry.name)) {
        violations.push({ kind: 'bearinmind_extra_entry', foundAt: relPath });
      }

      if (topLevelFilenames.has(entry.name) && cur.relDir !== '') {
        violations.push({
          kind: 'top_level_file_under_subdir',
          filename: entry.name,
          foundAt: relPath,
        });
      }

      if (bearFilenames.has(entry.name)) {
        if (cur.relDir !== 'bearinmind') {
          violations.push({
            kind: 'bearinmind_file_outside_bearinmind',
            filename: entry.name,
            foundAt: relPath,
          });
        }
      }
    }
  }

  // Special-case: bearinmind exists but is not a directory.
  const bearDir = path.join(taskPackageDirFullPath, 'bearinmind');
  try {
    const st = await fs.promises.stat(bearDir);
    if (!st.isDirectory()) {
      violations.push({ kind: 'bearinmind_not_directory', foundAt: 'bearinmind' });
    }
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      // ok
    } else {
      // ignore unexpected validation errors to avoid blocking prompt injection
    }
  }

  return violations;
}

export async function readTaskPackageForInjection(taskPackageDirFullPath: string): Promise<{
  sections: TaskPackageSectionsState;
  bearInMind: TaskPackageBearInMindState;
  violations: TaskPackageLayoutViolation[];
}> {
  const sections = await readTaskPackageSections(taskPackageDirFullPath);
  const bearInMind = await readBearInMindSections(taskPackageDirFullPath);
  const violations = await validateTaskPackageLayout(taskPackageDirFullPath);
  return { sections, bearInMind, violations };
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
