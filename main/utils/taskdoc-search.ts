/**
 * Module: utils/taskdoc-search
 *
 * rtws (runtime workspace) search utilities for Taskdocs (`*.tsk/`).
 *
 * Taskdocs are encapsulated directories ending in `.tsk`. For search, we treat each `*.tsk/`
 * directory as a single unit and do not recurse into it.
 *
 * Ignore rules:
 * - Default ignore patterns skip common non-task directories (at any depth).
 * - A `.taskdoc-ignore` file may exist in any directory. Its patterns apply to that directory's
 *   subtree only (like a simplified `.gitignore`).
 * - Patterns are interpreted as paths relative to the `.taskdoc-ignore` directory (unless they
 *   start with `/`, in which case they are rtws-root-relative).
 */
import type { TaskDocumentSuggestion, TaskDocumentSummary } from '@longrun-ai/kernel/types/taskdoc';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import fs from 'fs';
import fsPromises from 'fs/promises';
import * as path from 'path';

export type ListTaskDocumentsResult =
  | { kind: 'ok'; taskDocuments: TaskDocumentSummary[] }
  | { kind: 'error'; errorText: string };

export type SearchTaskDocumentSuggestionsResult =
  | { kind: 'ok'; suggestions: TaskDocumentSuggestion[] }
  | { kind: 'error'; errorText: string };

interface ListTaskDocumentsParams {
  rootDir?: string;
}

interface SearchTaskDocumentSuggestionsParams extends ListTaskDocumentsParams {
  query: string;
  limit?: number;
}

const DEFAULT_IGNORE_PATTERNS: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.minds/**',
  '**/.dialogs/**',
];

type CompiledIgnorePattern = { kind: 'prefix'; prefix: string } | { kind: 'glob'; re: RegExp };

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripTaskdocSuffixForMatch(value: string): string {
  return value.endsWith('.tsk') ? value.slice(0, -4) : value;
}

function calculateTaskDocumentSuggestionScore(params: {
  nameMatch: boolean;
  pathMatch: boolean;
  nameStartsWith: boolean;
  pathStartsWith: boolean;
  nameExactMatch: boolean;
}): number {
  if (params.nameExactMatch) return 100;
  if (params.nameStartsWith) return 90;
  if (params.pathStartsWith) return 80;
  if (params.nameMatch) return 70;
  if (params.pathMatch) return 60;
  return 0;
}

function escapeRegexLiteralChar(ch: string): string {
  // Regex special chars: \ ^ $ . | ? * + ( ) [ ] { }
  if ('\\^$.|?*+()[]{}'.includes(ch)) return `\\${ch}`;
  return ch;
}

function globToRegexSource(pattern: string): string {
  const normalized = normalizePosixPath(pattern);
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    const next2 = normalized[i + 2];

    if (ch === '*' && next === '*' && next2 === '/') {
      // `**/` => zero or more directories (including none).
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegexLiteralChar(ch);
  }
  return out;
}

function compileGlobPattern(pattern: string): RegExp {
  let normalized = normalizePosixPath(pattern);
  // For taskdoc search we only care about pruning directories. Patterns like `dist/*`
  // are interpreted as "ignore the subtree under dist" and should skip recursing into `dist/`.
  if (normalized.endsWith('/*')) normalized = normalized.slice(0, -2) + '/**';
  if (normalized.endsWith('/**')) {
    const base = normalized.slice(0, -3);
    const baseSource = globToRegexSource(base);
    return new RegExp(`^${baseSource}(?:/.*)?$`);
  }
  const source = globToRegexSource(normalized);
  return new RegExp(`^${source}$`);
}

function compileIgnorePattern(pattern: string): CompiledIgnorePattern | null {
  const normalized = normalizePosixPath(pattern).trim();
  if (!normalized) return null;

  if (normalized.includes('*') || normalized.includes('?')) {
    return { kind: 'glob', re: compileGlobPattern(normalized) };
  }
  return { kind: 'prefix', prefix: normalized.replace(/\/$/, '') };
}

function shouldIgnorePath(relPath: string, patterns: CompiledIgnorePattern[]): boolean {
  const normalizedPath = normalizePosixPath(relPath);
  for (const pat of patterns) {
    if (pat.kind === 'prefix') {
      if (normalizedPath === pat.prefix || normalizedPath.startsWith(pat.prefix + '/')) {
        return true;
      }
      continue;
    }
    if (pat.re.test(normalizedPath)) return true;
  }
  return false;
}

function normalizeIgnoreFileLineToRootPattern(line: string, dirRel: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null;

  const raw = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const joined =
    trimmed.startsWith('/') || !dirRel
      ? raw
      : path.posix.join(normalizePosixPath(dirRel), normalizePosixPath(raw));

  const normalized = path.posix.normalize(normalizePosixPath(joined)).replace(/\/$/, '');
  if (!normalized || normalized === '.') return null;

  // Reject patterns that escape the rtws root.
  if (normalized === '..' || normalized.startsWith('../')) return null;

  return normalized;
}

async function loadTaskdocIgnorePatternsForDir(
  dirAbs: string,
  dirRel: string,
): Promise<CompiledIgnorePattern[]> {
  const ignoreFile = path.join(dirAbs, '.taskdoc-ignore');
  try {
    const st = await fsPromises.stat(ignoreFile);
    if (!st.isFile()) return [];
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return [];
    }
    // Unexpected stat error: fail open (do not block search).
    return [];
  }

  try {
    const content = await fsPromises.readFile(ignoreFile, 'utf-8');
    const lines = content.split(/\r?\n/);
    const compiled: CompiledIgnorePattern[] = [];

    for (const line of lines) {
      const rootPattern = normalizeIgnoreFileLineToRootPattern(line, dirRel);
      if (!rootPattern) continue;
      const c = compileIgnorePattern(rootPattern);
      if (c) compiled.push(c);
    }

    return compiled;
  } catch {
    // Fail open: ignore file is optional.
    return [];
  }
}

async function scanDirForTaskDocs(params: {
  dirAbs: string;
  dirRel: string;
  inheritedIgnore: CompiledIgnorePattern[];
  out: TaskDocumentSummary[];
}): Promise<void> {
  const localIgnore = params.inheritedIgnore.concat(
    await loadTaskdocIgnorePatternsForDir(params.dirAbs, params.dirRel),
  );

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(params.dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryRel = params.dirRel
      ? path.posix.join(normalizePosixPath(params.dirRel), entry.name)
      : entry.name;
    if (shouldIgnorePath(entryRel, localIgnore)) continue;

    const entryAbs = path.join(params.dirAbs, entry.name);

    // Treat `*.tsk/` as a single encapsulated Taskdoc (do NOT recurse into it).
    if (entry.name.toLowerCase().endsWith('.tsk')) {
      try {
        const dirStats = await fsPromises.stat(entryAbs);
        let totalSize = 0;
        let lastModified = dirStats.mtime;
        const sectionFiles = ['goals.md', 'constraints.md', 'progress.md'] as const;
        const bearInMindFiles = [
          'contracts.md',
          'acceptance.md',
          'grants.md',
          'runbook.md',
          'decisions.md',
          'risks.md',
        ] as const;

        for (const filename of sectionFiles) {
          try {
            const sectionPath = path.join(entryAbs, filename);
            const st = await fsPromises.stat(sectionPath);
            totalSize += st.size;
            if (st.mtime > lastModified) lastModified = st.mtime;
          } catch {
            // Missing files are allowed; package may be created lazily.
          }
        }

        for (const filename of bearInMindFiles) {
          try {
            const sectionPath = path.join(entryAbs, 'bearinmind', filename);
            const st = await fsPromises.stat(sectionPath);
            totalSize += st.size;
            if (st.mtime > lastModified) lastModified = st.mtime;
          } catch {
            // Optional.
          }
        }

        params.out.push({
          path: entryRel,
          relativePath: normalizePosixPath(entryRel),
          name: entry.name,
          size: totalSize,
          lastModified: formatUnifiedTimestamp(lastModified),
        });
      } catch {
        // If stat fails, just skip this entry.
      }
      continue;
    }

    await scanDirForTaskDocs({
      dirAbs: entryAbs,
      dirRel: entryRel,
      inheritedIgnore: localIgnore,
      out: params.out,
    });
  }
}

export async function listTaskDocumentsInRtws(
  params: ListTaskDocumentsParams = {},
): Promise<ListTaskDocumentsResult> {
  const rootDir = params.rootDir ?? '.';
  try {
    const rootAbs = path.resolve(rootDir);
    const ignore: CompiledIgnorePattern[] = [];
    for (const p of DEFAULT_IGNORE_PATTERNS) {
      const c = compileIgnorePattern(p);
      if (c) ignore.push(c);
    }

    const taskDocuments: TaskDocumentSummary[] = [];
    await scanDirForTaskDocs({
      dirAbs: rootAbs,
      dirRel: '',
      inheritedIgnore: ignore,
      out: taskDocuments,
    });

    taskDocuments.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { kind: 'ok', taskDocuments };
  } catch {
    return { kind: 'error', errorText: 'Failed to list Taskdocs' };
  }
}

export async function searchTaskDocumentSuggestionsInRtws(
  params: SearchTaskDocumentSuggestionsParams,
): Promise<SearchTaskDocumentSuggestionsResult> {
  const normalizedQuery = stripTaskdocSuffixForMatch(params.query.trim().toLowerCase());
  if (normalizedQuery === '') return { kind: 'ok', suggestions: [] };

  const listed = await listTaskDocumentsInRtws({ rootDir: params.rootDir });
  if (listed.kind === 'error') return listed;

  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : 50;

  const suggestions = listed.taskDocuments
    .map((doc) => {
      const normalizedRelativePathForMatch = stripTaskdocSuffixForMatch(
        doc.relativePath.toLowerCase(),
      );
      const normalizedNameForMatch = stripTaskdocSuffixForMatch(doc.name.toLowerCase());
      const nameMatch = normalizedNameForMatch.includes(normalizedQuery);
      const pathMatch = normalizedRelativePathForMatch.includes(normalizedQuery);
      if (!nameMatch && !pathMatch) return null;
      return {
        doc,
        score: calculateTaskDocumentSuggestionScore({
          nameMatch,
          pathMatch,
          nameStartsWith: normalizedNameForMatch.startsWith(normalizedQuery),
          pathStartsWith: normalizedRelativePathForMatch.startsWith(normalizedQuery),
          nameExactMatch: normalizedNameForMatch === normalizedQuery,
        }),
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        doc: TaskDocumentSummary;
        score: number;
      } => entry !== null,
    )
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.doc.name.length !== b.doc.name.length) return a.doc.name.length - b.doc.name.length;
      return a.doc.name.localeCompare(b.doc.name);
    })
    .slice(0, limit)
    .map(({ doc }) => ({
      path: doc.path,
      relativePath: doc.relativePath,
      name: doc.name,
    }));

  return { kind: 'ok', suggestions };
}
