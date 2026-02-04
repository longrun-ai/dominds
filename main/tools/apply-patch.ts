/**
 * Module: tools/apply-patch
 *
 * Codex-style `apply_patch` function tool.
 * - Accepts the Codex CLI patch format (`*** Begin Patch` ... `*** End Patch`)
 * - Applies edits to the current rtws (runtime workspace)
 * - Enforces Dominds directory access control (`read_dirs`/`write_dirs` + deny lists)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { Dialog } from '../dialog';
import { getWorkLanguage } from '../shared/runtime-language';
import type { Team } from '../team';
import type { FuncTool, ToolArguments } from '../tool';

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

type ApplyPatchArgs = Readonly<{ patch: string }>;

type AddFileHunk = Readonly<{ kind: 'add_file'; relPath: string; contents: string }>;
type DeleteFileHunk = Readonly<{ kind: 'delete_file'; relPath: string }>;
type UpdateFileChunk = Readonly<{
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}>;
type UpdateFileHunk = Readonly<{
  kind: 'update_file';
  relPath: string;
  moveToRelPath: string | null;
  chunks: UpdateFileChunk[];
}>;

type PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

function parseApplyPatchArgs(args: ToolArguments): ApplyPatchArgs {
  const patchValue = args['patch'];
  if (typeof patchValue !== 'string' || patchValue.trim() === '') {
    throw new Error('apply_patch.patch must be a non-empty string');
  }
  return { patch: patchValue };
}

function assertRelativePath(input: string, label: string): void {
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw new Error(`${label} must be a relative path: ${input}`);
  }
}

function resolveInWorkspace(workspaceRoot: string, relPath: string, label: string): string {
  assertRelativePath(relPath, label);
  const resolved = path.resolve(workspaceRoot, relPath);
  const root = path.resolve(workspaceRoot);
  if (resolved === root) return resolved;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`${label} escapes rtws (runtime workspace) root: ${relPath}`);
  }
  return resolved;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function tryStripHeredocWrapper(lines: string[]): string[] | null {
  if (lines.length < 4) return null;
  const firstRaw = lines[0];
  const lastRaw = lines[lines.length - 1];
  if (firstRaw === undefined || lastRaw === undefined) return null;

  const first = firstRaw.trim();
  const last = lastRaw.trim();
  if (first !== '<<EOF' && first !== "<<'EOF'" && first !== '<<\"EOF\"') {
    return null;
  }
  if (!last.endsWith('EOF')) {
    return null;
  }
  return lines.slice(1, lines.length - 1);
}

function ensurePatchBoundariesStrict(lines: string[]): { inner: string[] } {
  const firstLine = lines.length > 0 ? lines[0] : undefined;
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : undefined;
  const first = typeof firstLine === 'string' ? firstLine.trim() : '';
  const last = typeof lastLine === 'string' ? lastLine.trim() : '';

  if (first !== BEGIN_PATCH_MARKER) {
    throw new Error(`Invalid patch: The first line of the patch must be '${BEGIN_PATCH_MARKER}'`);
  }
  if (last !== END_PATCH_MARKER) {
    throw new Error(`Invalid patch: The last line of the patch must be '${END_PATCH_MARKER}'`);
  }

  return { inner: lines.slice(1, lines.length - 1) };
}

function normalizePatchText(patch: string): string {
  const rawLines = splitLines(patch.trim());
  try {
    const strict = ensurePatchBoundariesStrict(rawLines);
    return [BEGIN_PATCH_MARKER, ...strict.inner, END_PATCH_MARKER].join('\n');
  } catch (strictErr) {
    const heredocLines = tryStripHeredocWrapper(rawLines);
    if (heredocLines === null) {
      const message = strictErr instanceof Error ? strictErr.message : String(strictErr);
      throw new Error(message);
    }
    const strict = ensurePatchBoundariesStrict(heredocLines);
    return [BEGIN_PATCH_MARKER, ...strict.inner, END_PATCH_MARKER].join('\n');
  }
}

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const maxStart = lines.length - pattern.length;

  const exactMatchAt = (idx: number): boolean => {
    for (let j = 0; j < pattern.length; j++) {
      const lhs = lines[idx + j];
      const rhs = pattern[j];
      if (lhs !== rhs) return false;
    }
    return true;
  };

  for (let i = searchStart; i <= maxStart; i++) {
    if (exactMatchAt(i)) return i;
  }

  for (let i = searchStart; i <= maxStart; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      const lhs = lines[i + j] ?? '';
      const rhs = pattern[j] ?? '';
      if (lhs.trimEnd() !== rhs.trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  for (let i = searchStart; i <= maxStart; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      const lhs = lines[i + j] ?? '';
      const rhs = pattern[j] ?? '';
      if (lhs.trim() !== rhs.trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  const normalize = (s: string): string => {
    const trimmed = s.trim();
    let out = '';
    for (const ch of trimmed) {
      switch (ch) {
        case '\u2010':
        case '\u2011':
        case '\u2012':
        case '\u2013':
        case '\u2014':
        case '\u2015':
        case '\u2212':
          out += '-';
          break;
        case '\u2018':
        case '\u2019':
        case '\u201A':
        case '\u201B':
          out += "'";
          break;
        case '\u201C':
        case '\u201D':
        case '\u201E':
        case '\u201F':
          out += '"';
          break;
        case '\u00A0':
        case '\u2002':
        case '\u2003':
        case '\u2004':
        case '\u2005':
        case '\u2006':
        case '\u2007':
        case '\u2008':
        case '\u2009':
        case '\u200A':
        case '\u202F':
        case '\u205F':
        case '\u3000':
          out += ' ';
          break;
        default:
          out += ch;
      }
    }
    return out;
  };

  for (let i = searchStart; i <= maxStart; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      const lhs = normalize(lines[i + j] ?? '');
      const rhs = normalize(pattern[j] ?? '');
      if (lhs !== rhs) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  return null;
}

function parseUpdateFileChunk(
  lines: readonly string[],
  lineNumber: number,
  allowMissingContext: boolean,
): Readonly<{ chunk: UpdateFileChunk; consumed: number }> {
  if (lines.length === 0) {
    throw new Error(`Invalid hunk at line ${lineNumber}: Update hunk does not contain any lines`);
  }

  const firstLine = lines[0] ?? '';
  const firstTrimmed = firstLine.trim();
  let changeContext: string | null = null;
  let startIndex = 0;

  if (firstTrimmed === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (firstTrimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = firstTrimmed.slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else {
    if (!allowMissingContext) {
      throw new Error(
        `Invalid hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
      );
    }
    startIndex = 0;
  }

  if (startIndex >= lines.length) {
    throw new Error(
      `Invalid hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsedLines = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineTrimmed = line.trim();

    if (lineTrimmed === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new Error(
          `Invalid hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`,
        );
      }
      isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    if (line.length === 0) {
      oldLines.push('');
      newLines.push('');
      parsedLines += 1;
      continue;
    }

    const firstChar = line[0];
    if (firstChar === ' ') {
      const rest = line.slice(1);
      oldLines.push(rest);
      newLines.push(rest);
      parsedLines += 1;
      continue;
    }
    if (firstChar === '+') {
      newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (firstChar === '-') {
      oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new Error(
        `Invalid hunk at line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    break;
  }

  return {
    chunk: { changeContext, oldLines, newLines, isEndOfFile },
    consumed: parsedLines + startIndex,
  };
}

function parseOneHunk(
  lines: readonly string[],
  lineNumber: number,
): Readonly<{ hunk: PatchHunk; consumed: number }> {
  const firstLineRaw = lines.length > 0 ? lines[0] : undefined;
  const firstLineTrimmed = typeof firstLineRaw === 'string' ? firstLineRaw.trim() : '';

  if (firstLineTrimmed.startsWith(ADD_FILE_MARKER)) {
    const relPath = firstLineTrimmed.slice(ADD_FILE_MARKER.length);
    if (relPath.trim() === '') {
      throw new Error(`Invalid hunk at line ${lineNumber}: Add file path is empty`);
    }
    let contents = '';
    let consumed = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (typeof line !== 'string') break;
      if (line.startsWith('+')) {
        contents += line.slice(1) + '\n';
        consumed += 1;
        continue;
      }
      break;
    }
    return { hunk: { kind: 'add_file', relPath, contents }, consumed };
  }

  if (firstLineTrimmed.startsWith(DELETE_FILE_MARKER)) {
    const relPath = firstLineTrimmed.slice(DELETE_FILE_MARKER.length);
    if (relPath.trim() === '') {
      throw new Error(`Invalid hunk at line ${lineNumber}: Delete file path is empty`);
    }
    return { hunk: { kind: 'delete_file', relPath }, consumed: 1 };
  }

  if (firstLineTrimmed.startsWith(UPDATE_FILE_MARKER)) {
    const relPath = firstLineTrimmed.slice(UPDATE_FILE_MARKER.length);
    if (relPath.trim() === '') {
      throw new Error(`Invalid hunk at line ${lineNumber}: Update file path is empty`);
    }
    let consumed = 1;
    let remaining = lines.slice(1);

    let moveToRelPath: string | null = null;
    if (remaining.length > 0) {
      const moveCandidateRaw = remaining[0];
      const moveCandidate = typeof moveCandidateRaw === 'string' ? moveCandidateRaw.trim() : '';
      if (moveCandidate.startsWith(MOVE_TO_MARKER)) {
        moveToRelPath = moveCandidate.slice(MOVE_TO_MARKER.length);
        if (moveToRelPath.trim() === '') {
          throw new Error(`Invalid hunk at line ${lineNumber + consumed}: Move-to path is empty`);
        }
        remaining = remaining.slice(1);
        consumed += 1;
      }
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      const first = remaining[0];
      const firstStr = typeof first === 'string' ? first : '';

      if (firstStr.trim() === '') {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }

      if (firstStr.trimStart().startsWith('***')) {
        break;
      }

      const allowMissingContext = chunks.length === 0;
      const parsed = parseUpdateFileChunk(remaining, lineNumber + consumed, allowMissingContext);
      chunks.push(parsed.chunk);
      remaining = remaining.slice(parsed.consumed);
      consumed += parsed.consumed;
    }

    if (chunks.length === 0) {
      throw new Error(
        `Invalid hunk at line ${lineNumber}: Update file hunk for path '${relPath}' is empty`,
      );
    }

    return { hunk: { kind: 'update_file', relPath, moveToRelPath, chunks }, consumed };
  }

  throw new Error(
    `Invalid hunk at line ${lineNumber}: '${firstLineTrimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function parsePatch(patch: string): PatchHunk[] {
  const normalized = normalizePatchText(patch);
  const lines = splitLines(normalized);
  const { inner } = ensurePatchBoundariesStrict(lines);

  const hunks: PatchHunk[] = [];
  let idx = 0;
  let lineNumber = 2;
  while (idx < inner.length) {
    const slice = inner.slice(idx);
    const parsed = parseOneHunk(slice, lineNumber);
    hunks.push(parsed.hunk);
    idx += parsed.consumed;
    lineNumber += parsed.consumed;
  }
  return hunks;
}

function applyReplacements(
  originalLines: string[],
  replacements: ReadonlyArray<Readonly<[start: number, oldLen: number, newLines: string[]]>>,
): string[] {
  const lines = [...originalLines];
  const sorted = [...replacements].sort((a, b) => b[0] - a[0]);
  for (const [startIdx, oldLen, newSegment] of sorted) {
    for (let i = 0; i < oldLen; i++) {
      if (startIdx < lines.length) {
        lines.splice(startIdx, 1);
      }
    }
    if (newSegment.length > 0) {
      lines.splice(startIdx, 0, ...newSegment);
    }
  }
  return lines;
}

function computeReplacements(
  originalLines: readonly string[],
  sourceLabel: string,
  chunks: readonly UpdateFileChunk[],
): ReadonlyArray<Readonly<[start: number, oldLen: number, newLines: string[]]>> {
  const replacements: Array<Readonly<[number, number, string[]]>> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const ctxIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (ctxIdx === null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${sourceLabel}`);
      }
      lineIndex = ctxIdx + 1;
    }

    if (chunk.oldLines.length === 0) {
      const last = originalLines.length > 0 ? originalLines[originalLines.length - 1] : undefined;
      const insertionIdx = last === '' ? originalLines.length - 1 : originalLines.length;
      replacements.push([insertionIdx, 0, [...chunk.newLines]]);
      continue;
    }

    let pattern = chunk.oldLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    let newSlice = chunk.newLines;

    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, pattern.length - 1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, newSlice.length - 1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(
        `Failed to find expected lines in ${sourceLabel}:\n${chunk.oldLines.join('\n')}`,
      );
    }

    replacements.push([found, pattern.length, [...newSlice]]);
    lineIndex = found + pattern.length;
  }

  return replacements.sort((a, b) => a[0] - b[0]);
}

async function deriveNewContentsFromChunks(
  absPath: string,
  chunks: readonly UpdateFileChunk[],
): Promise<string> {
  let originalContents: string;
  try {
    originalContents = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read file to update ${absPath}: ${msg}`);
  }

  const originalLines = originalContents.split('\n');
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, absPath, chunks);
  const newLines = applyReplacements([...originalLines], replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('');
  }
  return newLines.join('\n');
}

type ApplyPatchSummary = Readonly<{
  added: string[];
  modified: string[];
  deleted: string[];
}>;

function printSummary(summary: ApplyPatchSummary): string {
  const parts: string[] = [];
  if (summary.added.length > 0) {
    parts.push(`Added:\n- ${summary.added.join('\n- ')}`);
  }
  if (summary.modified.length > 0) {
    parts.push(`Modified:\n- ${summary.modified.join('\n- ')}`);
  }
  if (summary.deleted.length > 0) {
    parts.push(`Deleted:\n- ${summary.deleted.join('\n- ')}`);
  }
  if (parts.length === 0) {
    return 'No files were modified.';
  }
  return parts.join('\n\n');
}

function ensureReadAccess(caller: Team.Member, relPath: string): void {
  const language = getWorkLanguage();
  if (!hasReadAccess(caller, relPath)) {
    throw new Error(getAccessDeniedMessage('read', relPath, language));
  }
}

function ensureWriteAccess(caller: Team.Member, relPath: string): void {
  const language = getWorkLanguage();
  if (!hasWriteAccess(caller, relPath)) {
    throw new Error(getAccessDeniedMessage('write', relPath, language));
  }
}

async function applyHunksToWorkspace(
  caller: Team.Member,
  hunks: readonly PatchHunk[],
): Promise<ApplyPatchSummary> {
  if (hunks.length === 0) {
    throw new Error('No files were modified.');
  }

  const workspaceRoot = process.cwd();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const hunk of hunks) {
    switch (hunk.kind) {
      case 'add_file': {
        ensureWriteAccess(caller, hunk.relPath);
        const abs = resolveInWorkspace(workspaceRoot, hunk.relPath, 'apply_patch path');
        const parent = path.dirname(abs);
        await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(abs, hunk.contents, 'utf8');
        added.push(hunk.relPath);
        break;
      }
      case 'delete_file': {
        ensureWriteAccess(caller, hunk.relPath);
        const abs = resolveInWorkspace(workspaceRoot, hunk.relPath, 'apply_patch path');
        await fs.unlink(abs);
        deleted.push(hunk.relPath);
        break;
      }
      case 'update_file': {
        ensureReadAccess(caller, hunk.relPath);
        ensureWriteAccess(caller, hunk.relPath);
        const srcAbs = resolveInWorkspace(workspaceRoot, hunk.relPath, 'apply_patch path');
        const newContents = await deriveNewContentsFromChunks(srcAbs, hunk.chunks);

        if (hunk.moveToRelPath !== null) {
          ensureWriteAccess(caller, hunk.moveToRelPath);
          const destAbs = resolveInWorkspace(
            workspaceRoot,
            hunk.moveToRelPath,
            'apply_patch move target',
          );
          const parent = path.dirname(destAbs);
          await fs.mkdir(parent, { recursive: true });
          await fs.writeFile(destAbs, newContents, 'utf8');
          await fs.unlink(srcAbs);
          modified.push(hunk.moveToRelPath);
          break;
        }

        await fs.writeFile(srcAbs, newContents, 'utf8');
        modified.push(hunk.relPath);
        break;
      }
      default: {
        const _exhaustive: never = hunk;
        return _exhaustive;
      }
    }
  }

  return { added, modified, deleted };
}

export const applyPatchTool: FuncTool = {
  type: 'func',
  name: 'apply_patch',
  description:
    'Apply a Codex-style apply_patch formatted patch to the rtws (runtime workspace). Enforces Dominds directory allow/deny lists.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['patch'],
    properties: {
      patch: { type: 'string' },
    },
  },
  async call(_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const parsed = parseApplyPatchArgs(args);
    const hunks = parsePatch(parsed.patch);
    const summary = await applyHunksToWorkspace(caller, hunks);
    return printSummary(summary);
  },
};
