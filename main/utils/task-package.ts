/**
 * Module: utils/task-package
 *
 * Encapsulated Taskdocs (`*.tsk/`).
 *
 * A Taskdoc is a directory ending in `.tsk`. It *may* contain:
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

const taskPackageIdentifierRe = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;

function isTaskPackageIdentifier(value: string): boolean {
  return taskPackageIdentifierRe.test(value);
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

export type TaskPackageExtraCategory = Readonly<{
  category: string;
  selectors: readonly string[];
}>;

export type TaskPackageExtraSectionsState =
  | { kind: 'unavailable'; reason: 'scan_error' }
  | { kind: 'present'; categories: readonly TaskPackageExtraCategory[]; truncated: boolean };

export type TaskPackageLayoutViolation =
  | { kind: 'top_level_file_under_subdir'; filename: string; foundAt: string }
  | { kind: 'bearinmind_file_outside_bearinmind'; filename: string; foundAt: string }
  | { kind: 'bearinmind_extra_entry'; foundAt: string }
  | { kind: 'bearinmind_not_directory'; foundAt: string }
  | { kind: 'scan_limit_exceeded'; maxEntries: number };

export type TaskPackageChangeMindTarget =
  | { kind: 'top_level'; section: TaskPackageSection }
  | { kind: 'bearinmind'; section: BearInMindSection }
  | { kind: 'category'; category: string; selector: string };

export type TaskPackageChangeMindTargetError =
  | { kind: 'selector_required' }
  | { kind: 'invalid_category_name'; category: string }
  | { kind: 'invalid_category_selector'; selector: string }
  | { kind: 'invalid_top_level_selector'; selector: string }
  | { kind: 'invalid_bearinmind_selector'; selector: string }
  | { kind: 'top_level_selector_requires_no_category'; category: string; selector: string }
  | {
      kind: 'bearinmind_selector_requires_bearinmind_category';
      category: string;
      selector: string;
    };

export type TaskPackageChangeMindTargetParseResult =
  | { kind: 'ok'; target: TaskPackageChangeMindTarget }
  | { kind: 'err'; error: TaskPackageChangeMindTargetError };

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

export function bearInMindSectionFromSelector(selector: string): BearInMindSection | null {
  const normalized = selector.startsWith('!') ? selector.slice(1) : selector;
  if (normalized === 'contracts') return normalized;
  if (normalized === 'acceptance') return normalized;
  if (normalized === 'grants') return normalized;
  if (normalized === 'runbook') return normalized;
  if (normalized === 'decisions') return normalized;
  if (normalized === 'risks') return normalized;
  return null;
}

export function parseTaskPackageChangeMindTarget(params: {
  selector: string;
  category?: string;
}): TaskPackageChangeMindTargetParseResult {
  const selector = params.selector.trim();
  if (selector === '') {
    return { kind: 'err', error: { kind: 'selector_required' } };
  }

  const categoryValue = typeof params.category === 'string' ? params.category.trim() : '';
  const category = categoryValue !== '' ? categoryValue : null;

  // Category missing/empty => top-level only.
  if (category === null) {
    const topLevel = taskPackageSectionFromSelector(selector);
    if (topLevel !== null) {
      return { kind: 'ok', target: { kind: 'top_level', section: topLevel } };
    }
    return { kind: 'err', error: { kind: 'invalid_top_level_selector', selector } };
  }

  // Category present => validate category name first.
  if (!isTaskPackageIdentifier(category)) {
    return { kind: 'err', error: { kind: 'invalid_category_name', category } };
  }

  if (category === 'bearinmind') {
    const bear = bearInMindSectionFromSelector(selector);
    if (bear !== null) {
      return { kind: 'ok', target: { kind: 'bearinmind', section: bear } };
    }

    // Reserved top-level selectors must not be nested under any category.
    const topLevel = taskPackageSectionFromSelector(selector);
    if (topLevel !== null) {
      return {
        kind: 'err',
        error: { kind: 'top_level_selector_requires_no_category', category, selector },
      };
    }

    return { kind: 'err', error: { kind: 'invalid_bearinmind_selector', selector } };
  }

  // Reserved top-level selectors must not be nested under any category.
  const topLevel = taskPackageSectionFromSelector(selector);
  if (topLevel !== null) {
    return {
      kind: 'err',
      error: { kind: 'top_level_selector_requires_no_category', category, selector },
    };
  }

  // Reserved bearinmind selectors must only appear under category="bearinmind".
  const bear = bearInMindSectionFromSelector(selector);
  if (bear !== null) {
    return {
      kind: 'err',
      error: { kind: 'bearinmind_selector_requires_bearinmind_category', category, selector },
    };
  }

  const normalizedSelector = selector.startsWith('!') ? selector.slice(1) : selector;
  if (!isTaskPackageIdentifier(normalizedSelector)) {
    return { kind: 'err', error: { kind: 'invalid_category_selector', selector } };
  }

  return {
    kind: 'ok',
    target: { kind: 'category', category, selector: normalizedSelector },
  };
}

export function taskPackageFilenameForSection(section: TaskPackageSection): string {
  return sectionToFilename[section];
}

export function bearInMindFilenameForSection(section: BearInMindSection): string {
  return bearInMindSectionToFilename[section];
}

export async function updateTaskPackageByChangeMindTarget(params: {
  taskPackageDirFullPath: string;
  target: TaskPackageChangeMindTarget;
  content: string;
  updatedBy?: string;
}): Promise<void> {
  const { taskPackageDirFullPath, target, content, updatedBy } = params;
  await ensureTaskPackage(taskPackageDirFullPath, updatedBy);

  switch (target.kind) {
    case 'top_level': {
      await updateTaskPackageSection({
        taskPackageDirFullPath,
        section: target.section,
        content,
        updatedBy,
      });
      return;
    }
    case 'bearinmind': {
      const dir = path.join(taskPackageDirFullPath, 'bearinmind');
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, bearInMindFilenameForSection(target.section));
      await fs.promises.writeFile(filePath, content, 'utf8');
      return;
    }
    case 'category': {
      const dir = path.join(taskPackageDirFullPath, target.category);
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${target.selector}.md`);
      await fs.promises.writeFile(filePath, content, 'utf8');
      return;
    }
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
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
  extraSections: TaskPackageExtraSectionsState;
  violations: TaskPackageLayoutViolation[];
}> {
  const sections = await readTaskPackageSections(taskPackageDirFullPath);
  const bearInMind = await readBearInMindSections(taskPackageDirFullPath);
  const extraSections = await readTaskPackageExtraSectionsIndex(taskPackageDirFullPath);
  const violations = await validateTaskPackageLayout(taskPackageDirFullPath);
  return { sections, bearInMind, extraSections, violations };
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

async function readTaskPackageExtraSectionsIndex(
  taskPackageDirFullPath: string,
): Promise<TaskPackageExtraSectionsState> {
  const maxEntries = 64;
  let total = 0;

  try {
    const dirents = await fs.promises.readdir(taskPackageDirFullPath, { withFileTypes: true });
    const categoryToSelectors = new Map<string, Set<string>>();

    for (const entry of dirents) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'bearinmind') continue;
      if (!isTaskPackageIdentifier(entry.name)) continue;

      const category = entry.name;
      const catAbs = path.join(taskPackageDirFullPath, category);
      let catEntries: fs.Dirent[];
      try {
        catEntries = await fs.promises.readdir(catAbs, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const child of catEntries) {
        if (total >= maxEntries) {
          return {
            kind: 'present',
            categories: materializeExtraCategories(categoryToSelectors),
            truncated: true,
          };
        }
        if (!child.isFile()) continue;
        if (child.name.startsWith('.')) continue;
        if (!child.name.endsWith('.md')) continue;

        const selector = child.name.slice(0, -3);
        if (!isTaskPackageIdentifier(selector)) continue;
        if (taskPackageSectionFromSelector(selector) !== null) continue;
        if (bearInMindSectionFromSelector(selector) !== null) continue;

        const set = categoryToSelectors.get(category) ?? new Set<string>();
        set.add(selector);
        categoryToSelectors.set(category, set);
        total++;
      }
    }

    return {
      kind: 'present',
      categories: materializeExtraCategories(categoryToSelectors),
      truncated: false,
    };
  } catch {
    return { kind: 'unavailable', reason: 'scan_error' };
  }
}

function materializeExtraCategories(
  categoryToSelectors: Map<string, Set<string>>,
): readonly TaskPackageExtraCategory[] {
  const categories = Array.from(categoryToSelectors.entries())
    .filter(([, selectors]) => selectors.size > 0)
    .map(([category, selectors]) => ({
      category,
      selectors: Array.from(selectors.values()).sort(),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return categories;
}
