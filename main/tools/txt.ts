/**
 * Module: tools/txt
 *
 * Text file tooling for reading and modifying workspace files.
 * Provides `read_file`, `replace_file_contents`, `plan_file_modification`, and `apply_file_modification`.
 */
import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { ChatMessage } from '../llm/client';
import { formatToolError, formatToolOk } from '../shared/i18n/tool-result-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import { TellaskTool, TellaskToolCallResult } from '../tool';

function wrapTellaskResult(language: LanguageCode, messages: ChatMessage[]): TellaskToolCallResult {
  const first = messages[0];
  const text =
    first && 'content' in first && typeof first.content === 'string' ? first.content : '';
  const failed =
    /^(?:Error:|错误：|❌\s|\*\*Access Denied\*\*|\*\*访问被拒绝\*\*)/m.test(text) ||
    text.includes('Please use the correct format') ||
    text.includes('请使用正确的格式') ||
    text.includes('Invalid format') ||
    text.includes('格式不正确') ||
    text.includes('Path required') ||
    text.includes('需要提供路径') ||
    text.includes('Path must be within workspace') ||
    text.includes('路径必须位于工作区内');
  return {
    status: failed ? 'failed' : 'completed',
    result: text || (failed ? formatToolError(language) : formatToolOk(language)),
    messages,
  };
}

function ok(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'completed', result, messages };
}

function failed(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'failed', result, messages };
}

function ensureInsideWorkspace(rel: string): string {
  const file = path.resolve(process.cwd(), rel);
  const cwd = path.resolve(process.cwd());
  if (!file.startsWith(cwd)) {
    throw new Error('Path must be within workspace');
  }
  return file;
}

function normalizeFileWriteBody(inputBody: string): {
  normalizedBody: string;
  addedTrailingNewlineToContent: boolean;
} {
  if (inputBody === '' || inputBody.endsWith('\n')) {
    return { normalizedBody: inputBody, addedTrailingNewlineToContent: false };
  }
  return { normalizedBody: `${inputBody}\n`, addedTrailingNewlineToContent: true };
}

function detectDiffLikeContent(inputBody: string): boolean {
  if (
    inputBody.includes('diff --git') ||
    inputBody.includes('\n@@') ||
    inputBody.startsWith('@@')
  ) {
    return true;
  }
  const lines = inputBody.split('\n');
  let nonEmpty = 0;
  let plusMinusPrefixed = 0;
  for (const line of lines) {
    if (line === '') continue;
    nonEmpty++;
    if (
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---')
    ) {
      plusMinusPrefixed++;
    }
  }
  return nonEmpty >= 8 && plusMinusPrefixed / nonEmpty >= 0.6;
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlBlockScalarLines(valueLines: ReadonlyArray<string>, indent: string): string {
  if (valueLines.length === 0) return `''`;
  const content = valueLines.map((l) => `${indent}${l}`).join('\n');
  return `|-\n${content}`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function splitFileTextToLines(fileText: string): string[] {
  const parts = fileText.split('\n');
  // Remove the terminator token created by trailing '\n' (canonical line semantics).
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  // Keep empty-file representation stable: one empty line.
  if (parts.length === 0) return [''];
  return parts;
}

function isEmptyFileLines(lines: ReadonlyArray<string>): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0] === '');
}

function fileLineCount(lines: ReadonlyArray<string>): number {
  return isEmptyFileLines(lines) ? 0 : lines.length;
}

function rangeTotalLines(lines: ReadonlyArray<string>): number {
  return isEmptyFileLines(lines) ? 1 : lines.length;
}

function joinLinesForWrite(lines: ReadonlyArray<string>): string {
  if (isEmptyFileLines(lines)) return '';
  return `${lines.join('\n')}\n`;
}

function previewWindow(
  lines: ReadonlyArray<string>,
  startIndex0: number,
  count: number,
): ReadonlyArray<string> {
  if (count <= 0) return [];
  const start = Math.max(0, startIndex0);
  const end = Math.min(lines.length, startIndex0 + count);
  if (start >= end) return [];
  return lines.slice(start, end);
}

function buildRangePreview(rangeLines: ReadonlyArray<string>): ReadonlyArray<string> {
  const maxShow = 6;
  if (rangeLines.length <= maxShow) return rangeLines;
  const head = rangeLines.slice(0, 3);
  const tail = rangeLines.slice(-3);
  return [...head, '…', ...tail];
}

function yamlFlowStringArray(values: ReadonlyArray<string>): string {
  if (values.length === 0) return '[]';
  return `[${values.map(yamlQuote).join(', ')}]`;
}

function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const flush = (): void => {
    if (current === '') return;
    args.push(current);
    current = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? '';
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (!inSingle && ch === '\\') {
      escape = true;
      continue;
    }
    if (!inDouble && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (!inDouble && ch === "'" && inSingle) {
      inSingle = false;
      continue;
    }
    if (!inSingle && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (!inSingle && ch === '"' && inDouble) {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return args;
}

function parseBooleanOption(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

type Occurrence = { kind: 'index'; index1: number } | { kind: 'last' };

function parseOccurrence(value: string): Occurrence | undefined {
  if (value === 'last') return { kind: 'last' };
  if (!/^\d+$/.test(value)) return undefined;
  const index1 = Number.parseInt(value, 10);
  if (!Number.isFinite(index1) || index1 <= 0) return undefined;
  return { kind: 'index', index1 };
}

function splitTextToLinesForEditing(fileText: string): string[] {
  if (fileText === '') return [];
  const parts = fileText.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function joinLinesForTextWrite(lines: ReadonlyArray<string>): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

function countLogicalLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

type ParsedLineRange =
  | { kind: 'replace'; startLine: number; endLine: number }
  | { kind: 'append'; startLine: number };

type PlannedFileModification = {
  readonly hunkId: string;
  readonly plannedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly relPath: string;
  readonly absPath: string;
  readonly range: ParsedLineRange;
  readonly startIndex0: number;
  readonly deleteCount: number;
  readonly contextBefore: ReadonlyArray<string>;
  readonly contextAfter: ReadonlyArray<string>;
  readonly oldLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
  readonly unifiedDiff: string;
};

const PLANNED_MOD_TTL_MS = 60 * 60 * 1000; // ~1 hour
const plannedModsById = new Map<string, PlannedFileModification>();

type LockQueueItem = {
  readonly priority: number;
  readonly tieBreaker: string;
  readonly run: () => Promise<void>;
};

const fileApplyQueues = new Map<string, LockQueueItem[]>();
const fileApplyRunning = new Set<string>();

function enqueueFileApply(relPath: string, item: LockQueueItem): void {
  const q = fileApplyQueues.get(relPath) ?? [];
  q.push(item);
  q.sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.tieBreaker.localeCompare(b.tieBreaker),
  );
  fileApplyQueues.set(relPath, q);
}

async function drainFileApplyQueue(relPath: string): Promise<void> {
  if (fileApplyRunning.has(relPath)) return;
  const q = fileApplyQueues.get(relPath);
  if (!q || q.length === 0) return;
  fileApplyRunning.add(relPath);
  try {
    while (true) {
      const next = fileApplyQueues.get(relPath)?.shift();
      if (!next) break;
      await next.run();
    }
  } finally {
    fileApplyRunning.delete(relPath);
    const remaining = fileApplyQueues.get(relPath);
    if (!remaining || remaining.length === 0) fileApplyQueues.delete(relPath);
  }
}

function pruneExpiredPlannedMods(nowMs: number): void {
  for (const [id, mod] of plannedModsById.entries()) {
    if (mod.expiresAtMs <= nowMs) plannedModsById.delete(id);
  }
}

function generateHunkId(): string {
  // Short, URL-safe, command-friendly id
  return crypto.randomBytes(4).toString('hex');
}

function parseOptionalHunkId(arg: string): string | undefined {
  const trimmed = arg.trim();
  if (!trimmed.startsWith('!')) return undefined;
  const id = trimmed.slice(1);
  if (!/^[a-z0-9_-]{2,32}$/i.test(id)) return undefined;
  return id;
}

function parseLineRangeSpec(
  rangeSpec: string,
  totalLines: number,
): { ok: true; range: ParsedLineRange } | { ok: false; error: string } {
  const trimmed = rangeSpec.trim();
  if (!trimmed) return { ok: false, error: 'Range required' };

  // Shorthand: "N" means "N~N"
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Invalid range' };
    if (n > totalLines) return { ok: false, error: 'Range out of bounds' };
    return { ok: true, range: { kind: 'replace', startLine: n, endLine: n } };
  }

  const match = trimmed.match(/^(\d+)?~(\d+)?$/);
  if (!match) return { ok: false, error: 'Invalid range' };

  const startStr = match[1];
  const endStr = match[2];

  const start = startStr !== undefined ? Number.parseInt(startStr, 10) : undefined;
  const end = endStr !== undefined ? Number.parseInt(endStr, 10) : undefined;

  if (start !== undefined && (!Number.isFinite(start) || start <= 0)) {
    return { ok: false, error: 'Invalid range' };
  }
  if (end !== undefined && (!Number.isFinite(end) || end <= 0)) {
    return { ok: false, error: 'Invalid range' };
  }

  // "~" = entire file
  if (start === undefined && end === undefined) {
    return { ok: true, range: { kind: 'replace', startLine: 1, endLine: totalLines } };
  }

  // "~N" = 1..N
  if (start === undefined && end !== undefined) {
    if (end > totalLines) return { ok: false, error: 'Range out of bounds' };
    return { ok: true, range: { kind: 'replace', startLine: 1, endLine: end } };
  }

  // "N~" = N..end (or append if N is exactly totalLines+1)
  if (start !== undefined && end === undefined) {
    if (start === totalLines + 1) {
      return { ok: true, range: { kind: 'append', startLine: start } };
    }
    if (start > totalLines) return { ok: false, error: 'Range out of bounds' };
    return { ok: true, range: { kind: 'replace', startLine: start, endLine: totalLines } };
  }

  // "N~M"
  if (start !== undefined && end !== undefined) {
    if (start > end) return { ok: false, error: 'Invalid range' };
    if (end > totalLines) return { ok: false, error: 'Range out of bounds' };
    return { ok: true, range: { kind: 'replace', startLine: start, endLine: end } };
  }

  return { ok: false, error: 'Invalid range' };
}

function buildUnifiedSingleHunkDiff(
  relPath: string,
  currentLines: ReadonlyArray<string>,
  startIndex0: number,
  deleteCount: number,
  newLines: ReadonlyArray<string>,
): string {
  const context = 3;
  const beforeStart0 = Math.max(0, startIndex0 - context);
  const afterEnd0 = Math.min(currentLines.length, startIndex0 + deleteCount + context);

  const contextBefore = currentLines.slice(beforeStart0, startIndex0);
  const oldRemoved = currentLines.slice(startIndex0, startIndex0 + deleteCount);
  const contextAfter = currentLines.slice(startIndex0 + deleteCount, afterEnd0);

  const oldStartLine1 = beforeStart0 + 1;
  const oldCount = contextBefore.length + oldRemoved.length + contextAfter.length;
  const newStartLine1 = oldStartLine1;
  const newCount = contextBefore.length + newLines.length + contextAfter.length;

  const hunkLines = [
    ...contextBefore.map((l) => ` ${l}`),
    ...oldRemoved.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
    ...contextAfter.map((l) => ` ${l}`),
  ];

  return [
    `diff --git a/${relPath} b/${relPath}`,
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${oldStartLine1},${oldCount} +${newStartLine1},${newCount} @@`,
    ...hunkLines,
    '',
  ].join('\n');
}

function computeContextWindow(
  currentLines: ReadonlyArray<string>,
  startIndex0: number,
  deleteCount: number,
): {
  contextBefore: ReadonlyArray<string>;
  contextAfter: ReadonlyArray<string>;
} {
  const context = 3;
  const beforeStart0 = Math.max(0, startIndex0 - context);
  const afterEnd0 = Math.min(currentLines.length, startIndex0 + deleteCount + context);
  const contextBefore = currentLines.slice(beforeStart0, startIndex0);
  const contextAfter = currentLines.slice(startIndex0 + deleteCount, afterEnd0);
  return { contextBefore, contextAfter };
}

function splitPlannedBodyLines(inputBody: string): string[] {
  // Treat a single trailing '\n' as a terminator, not an extra blank line.
  // - '' (no body) means "replace with nothing" (deletion).
  // - '\n' means "replace with one empty line".
  if (inputBody === '') return [];
  const body = inputBody.endsWith('\n') ? inputBody.slice(0, -1) : inputBody;
  return body.split('\n');
}

function matchesAt(
  currentLines: ReadonlyArray<string>,
  index0: number,
  oldLines: ReadonlyArray<string>,
): boolean {
  if (index0 < 0) return false;
  if (index0 + oldLines.length > currentLines.length) return false;
  for (let i = 0; i < oldLines.length; i++) {
    if (currentLines[index0 + i] !== oldLines[i]) return false;
  }
  return true;
}

function findAllMatches(
  currentLines: ReadonlyArray<string>,
  oldLines: ReadonlyArray<string>,
): number[] {
  if (oldLines.length === 0) return [];
  const matches: number[] = [];
  const maxStart = currentLines.length - oldLines.length;
  for (let i = 0; i <= maxStart; i++) {
    if (matchesAt(currentLines, i, oldLines)) matches.push(i);
  }
  return matches;
}

function filterByContext(
  currentLines: ReadonlyArray<string>,
  candidateStarts: ReadonlyArray<number>,
  contextBefore: ReadonlyArray<string>,
  contextAfter: ReadonlyArray<string>,
  oldLinesLen: number,
): number[] {
  if (candidateStarts.length <= 1) return [...candidateStarts];
  if (contextBefore.length === 0 && contextAfter.length === 0) return [...candidateStarts];
  const out: number[] = [];
  for (const start0 of candidateStarts) {
    const beforeStart0 = start0 - contextBefore.length;
    const afterStart0 = start0 + oldLinesLen;
    const afterEnd0 = afterStart0 + contextAfter.length;
    if (beforeStart0 < 0) continue;
    if (afterEnd0 > currentLines.length) continue;
    let ok = true;
    for (let i = 0; i < contextBefore.length; i++) {
      if (currentLines[beforeStart0 + i] !== contextBefore[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let i = 0; i < contextAfter.length; i++) {
      if (currentLines[afterStart0 + i] !== contextAfter[i]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(start0);
  }
  return out;
}

interface ReadFileOptions {
  decorateLinenos: boolean;
  rangeStart?: number;
  rangeEnd?: number;
  maxLines: number;
}

const READ_FILE_CONTENT_CHAR_LIMIT = 100_000;

type ReadFileParseResult =
  | {
      kind: 'ok';
      path: string;
      options: ReadFileOptions;
      flags: { maxLinesSpecified: boolean; rangeSpecified: boolean };
    }
  | {
      kind: 'error';
      error:
        | 'invalid_format'
        | 'path_required'
        | 'missing_option_value'
        | 'invalid_option_value'
        | 'unknown_option'
        | 'unexpected_token';
      option?: string;
      expected?: string;
      value?: string;
      token?: string;
    };

function parseReadFileOptions(headLine: string): ReadFileParseResult {
  const trimmed = headLine.trim();

  if (!trimmed.startsWith('@read_file')) {
    return { kind: 'error', error: 'invalid_format' };
  }

  const afterToolName = trimmed.slice('@read_file'.length).trim();
  const parts = afterToolName.split(/\s+/).filter((p) => p.trim() !== '');

  if (parts.length === 0) {
    return { kind: 'error', error: 'path_required' };
  }

  // Path is now at the end
  const path = parts[parts.length - 1];
  if (!path || path.startsWith('!')) {
    return { kind: 'error', error: 'path_required' };
  }
  const options: ReadFileOptions = {
    decorateLinenos: true, // default (line numbers shown unless explicitly disabled)
    maxLines: 500, // default
  };
  const flags = { maxLinesSpecified: false, rangeSpecified: false };

  // Parse options (all parts except the last one which is the path)
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];

    if (part === '!no-linenos') {
      options.decorateLinenos = false;
      continue;
    }

    if (part === '!range') {
      const rangePart = parts[i + 1];
      if (!rangePart || i + 1 >= parts.length - 1) {
        return {
          kind: 'error',
          error: 'missing_option_value',
          option: '!range',
          expected: '<start~end>',
        };
      }

      const rangeMatch = rangePart.match(/^(\d+)?~(\d+)?$/);
      if (!rangeMatch) {
        return {
          kind: 'error',
          error: 'invalid_option_value',
          option: '!range',
          value: rangePart,
        };
      }

      const [, startStr, endStr] = rangeMatch;

      flags.rangeSpecified = true;

      if (startStr) {
        const start = parseInt(startStr, 10);
        if (Number.isNaN(start) || start <= 0) {
          return {
            kind: 'error',
            error: 'invalid_option_value',
            option: '!range',
            value: startStr,
          };
        }
        options.rangeStart = start;
      }

      if (endStr) {
        const end = parseInt(endStr, 10);
        if (Number.isNaN(end) || end <= 0) {
          return {
            kind: 'error',
            error: 'invalid_option_value',
            option: '!range',
            value: endStr,
          };
        }
        options.rangeEnd = end;
      }

      if (
        options.rangeStart !== undefined &&
        options.rangeEnd !== undefined &&
        options.rangeStart > options.rangeEnd
      ) {
        return {
          kind: 'error',
          error: 'invalid_option_value',
          option: '!range',
          value: rangePart,
        };
      }

      i++; // consume range spec
      continue;
    }

    if (part === '!max-lines') {
      const maxLinesPart = parts[i + 1];
      if (!maxLinesPart || i + 1 >= parts.length - 1) {
        return {
          kind: 'error',
          error: 'missing_option_value',
          option: '!max-lines',
          expected: '<number>',
        };
      }

      const maxLines = parseInt(maxLinesPart, 10);
      if (Number.isNaN(maxLines) || maxLines <= 0) {
        return {
          kind: 'error',
          error: 'invalid_option_value',
          option: '!max-lines',
          value: maxLinesPart,
        };
      }

      flags.maxLinesSpecified = true;
      options.maxLines = maxLines;
      i++; // consume value
      continue;
    }

    if (part.startsWith('!')) {
      return { kind: 'error', error: 'unknown_option', option: part };
    }

    return { kind: 'error', error: 'unexpected_token', token: part };
  }

  return { kind: 'ok', path, options, flags };
}

async function readFileContentBounded(
  absPath: string,
  options: ReadFileOptions,
): Promise<{
  totalLines: number;
  formattedContent: string;
  shownLines: number;
  truncatedByMaxLines: boolean;
  truncatedByCharLimit: boolean;
}> {
  const rangeStart = options.rangeStart ?? 1;
  const rangeEnd = options.rangeEnd ?? Number.POSITIVE_INFINITY;

  const outLines: string[] = [];
  let shownLines = 0;
  let totalLines = 0;
  let outputChars = 0;
  let truncatedByMaxLines = false;
  let truncatedByCharLimit = false;

  const stream = fsSync.createReadStream(absPath, { encoding: 'utf8' });
  let leftover = '';
  let currentLineNumber = 1;

  const tryAddLine = (line: string, lineNumber: number): void => {
    if (lineNumber < rangeStart || lineNumber > rangeEnd) return;
    if (shownLines >= options.maxLines) {
      truncatedByMaxLines = true;
      return;
    }

    const decoratedLine = options.decorateLinenos
      ? `${lineNumber.toString().padStart(4, ' ')}| ${line}`
      : line;

    const extraChars = decoratedLine.length + (outLines.length === 0 ? 0 : 1); // +1 for '\n'
    if (outputChars + extraChars > READ_FILE_CONTENT_CHAR_LIMIT) {
      truncatedByCharLimit = true;
      return;
    }

    outLines.push(decoratedLine);
    outputChars += extraChars;
    shownLines++;
  };

  return await new Promise((resolve, reject) => {
    stream.on('error', (err: unknown) => reject(err));
    stream.on('data', (chunk: string | Buffer) => {
      const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const combined = leftover + chunkText;
      const parts = combined.split('\n');
      const nextLeftover = parts.pop();
      leftover = nextLeftover === undefined ? '' : nextLeftover;

      for (const line of parts) {
        tryAddLine(line, currentLineNumber);
        totalLines++;
        currentLineNumber++;
      }
    });
    stream.on('end', () => {
      // Canonical line semantics:
      // - empty file yields 1 empty line (line 1)
      // - trailing '\n' does NOT yield an extra empty "terminator" line
      if (leftover !== '' || totalLines === 0) {
        tryAddLine(leftover, currentLineNumber);
        totalLines++;
      }

      resolve({
        totalLines,
        formattedContent: outLines.join('\n'),
        shownLines,
        truncatedByMaxLines,
        truncatedByCharLimit,
      });
    });
  });
}

export const readFileTool: TellaskTool = {
  type: 'tellask',
  name: 'read_file',
  backfeeding: true,
  usageDescription: `Read a text file (bounded) relative to workspace. 
Usage: !?@read_file [options] <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Options:
  !no-linenos                     - Disable line numbers (default: show line numbers)
  !range <range>                  - Show specific line range
  !max-lines <number>             - Limit max lines shown (default: 500)

Output bounds:
  Content is truncated to stay below ~100KB characters total.

Range formats:
  10~50     - Lines 10 to 50
  300~      - From line 300 to end
  ~20       - From start to line 20
  ~         - No range limit (entire file)

Examples:
!?@read_file src/main.ts
!?@read_file !no-linenos src/main.ts
!?@read_file !range 10~50 src/main.ts
!?@read_file !max-lines 100 !range 1~500 src/main.ts
!?@read_file !range 300~ src/main.ts
!?@read_file !range ~20 src/main.ts`,
  usageDescriptionI18n: {
    en: `Read a text file (bounded) relative to workspace.
Usage: !?@read_file [options] <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Options:
  !no-linenos                     - Disable line numbers (default: show line numbers)
  !range <range>                  - Show specific line range
  !max-lines <number>             - Limit max lines shown (default: 500)

Output bounds:
  Content is truncated to stay below ~100KB characters total.

Range formats:
  10~50     - Lines 10 to 50
  300~      - From line 300 to end
  ~20       - From start to line 20
  ~         - No range limit (entire file)

Examples:
!?@read_file src/main.ts
!?@read_file !no-linenos src/main.ts
!?@read_file !range 10~50 src/main.ts
!?@read_file !max-lines 100 !range 1~500 src/main.ts
!?@read_file !range 300~ src/main.ts
!?@read_file !range ~20 src/main.ts`,
    zh: `读取工作区内的文本文件（有上限/可截断）。
用法：!?@read_file [options] <path>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。

选项：
  !no-linenos                     - 不显示行号（默认：显示行号）
  !range <range>                  - 读取指定行范围
  !max-lines <number>             - 最多显示行数（默认：500）

输出上限：
  内容会被截断以确保返回的字符总数低于约 100KB。

范围格式：
  10~50     - 第 10 行到第 50 行
  300~      - 从第 300 行到文件末尾
  ~20       - 从开头到第 20 行
  ~         - 不限制范围（整文件）

示例：
!?@read_file src/main.ts
!?@read_file !no-linenos src/main.ts
!?@read_file !range 10~50 src/main.ts
!?@read_file !max-lines 100 !range 1~500 src/main.ts
!?@read_file !range 300~ src/main.ts
!?@read_file !range ~20 src/main.ts`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    let labels:
      | {
          formatError: string;
          formatErrorWithReason: (msg: string) => string;
          fileLabel: string;
          warningTruncatedByMaxLines: (shown: number, maxLines: number) => string;
          warningTruncatedByCharLimit: (shown: number, maxChars: number) => string;
          warningMaxLinesRangeMismatch: (
            maxLines: number,
            rangeLines: number,
            used: number,
          ) => string;
          hintUseRangeNext: (relPath: string, start: number, end: number) => string;
          hintLargeFileStrategy: (relPath: string) => string;
          sizeLabel: string;
          totalLinesLabel: string;
          failedToRead: (msg: string) => string;
          invalidFormatMultiToolCalls: (toolName: string) => string;
        }
      | undefined;

    if (language === 'zh') {
      labels = {
        formatError:
          '请使用正确的文件读取格式。\n\n**期望格式：** `!?@read_file [options] <path>`\n\n**示例：**\n```\n!?@read_file src/main.ts\n!?@read_file !range 10~50 src/main.ts\n!?@read_file !range 300~ src/main.ts\n```\n\n' +
          '**多个工具调用用空行分隔即可：**\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **错误：** ${msg}\n\n` +
          '请使用正确的文件读取格式。\n\n**期望格式：** `!?@read_file [options] <path>`\n\n**示例：**\n```\n!?@read_file src/main.ts\n!?@read_file !range 10~50 src/main.ts\n!?@read_file !range 300~ src/main.ts\n```\n\n' +
          '**多个工具调用用空行分隔即可：**\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
        fileLabel: '文件',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **警告：** 输出已截断（最多显示 ${maxLines} 行，当前显示 ${shown} 行）\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **警告：** 输出已截断（字符总数上限约 ${maxChars}，当前显示 ${shown} 行）\n\n`,
        warningMaxLinesRangeMismatch: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **警告：** \`!max-lines\`（${maxLines}）与 \`!range\`（共 ${rangeLines} 行）不一致，将按更小值 ${used} 处理。\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **提示：** 可使用 \`!range\` 继续读取下一段，例如：\`!?@read_file !range ${start}~${end} ${relPath}\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **大文件策略：** 建议分多轮分析：每轮用 \`!range\` 读取一段、完成总结后，在新一轮先执行 \`!?@clear_mind\`（降低上下文占用），再读取下一段（例如：\`!?@read_file !range 1~500 ${relPath}\`、\`!?@read_file !range 201~400 ${relPath}\`）。\n\n`,
        sizeLabel: '大小',
        totalLinesLabel: '总行数',
        failedToRead: (msg: string) => `❌ **错误**\n\n读取文件失败：${msg}`,
        invalidFormatMultiToolCalls: (toolName: string) =>
          `INVALID_FORMAT：检测到疑似多个工具调用被合并到同一个诉请块 headline（例如出现 \`${toolName}\`）。\n\n` +
          '多个工具调用必须用空行分隔，例如：\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
      };
    } else {
      labels = {
        formatError:
          'Please use the correct format for reading files.\n\n**Expected format:** `!?@read_file [options] <path>`\n\n**Examples:**\n```\n!?@read_file src/main.ts\n!?@read_file !range 10~50 src/main.ts\n!?@read_file !range 300~ src/main.ts\n```\n\n' +
          '**Separate multiple tool calls with a blank line:**\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **Error:** ${msg}\n\n` +
          'Please use the correct format for reading files.\n\n**Expected format:** `!?@read_file [options] <path>`\n\n**Examples:**\n```\n!?@read_file src/main.ts\n!?@read_file !range 10~50 src/main.ts\n!?@read_file !range 300~ src/main.ts\n```\n\n' +
          '**Separate multiple tool calls with a blank line:**\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
        fileLabel: 'File',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **Warning:** Output was truncated (max ${maxLines} lines; showing ${shown})\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **Warning:** Output was truncated (~${maxChars} character cap; showing ${shown} lines)\n\n`,
        warningMaxLinesRangeMismatch: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **Warning:** \`!max-lines\` (${maxLines}) contradicts \`!range\` (${rangeLines} lines); using the smaller limit (${used}).\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **Hint:** Use \`!range\` to continue reading, e.g. \`!?@read_file !range ${start}~${end} ${relPath}\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **Large file strategy:** Analyze in multiple rounds: each round read a slice via \`!range\`, summarize, then start a new round and run \`!?@clear_mind\` (less context) before reading the next slice (e.g. \`!?@read_file !range 1~500 ${relPath}\`, then \`!?@read_file !range 201~400 ${relPath}\`).\n\n`,
        sizeLabel: 'Size',
        totalLinesLabel: 'Total lines',
        failedToRead: (msg: string) => `❌ **Error**\n\nFailed to read file: ${msg}`,
        invalidFormatMultiToolCalls: (toolName: string) =>
          `INVALID_FORMAT: Detected what looks like multiple tool calls merged into a single tellask headline (e.g. \`${toolName}\`).\n\n` +
          'Multiple tool calls must be separated by a blank line, for example:\n```\n!?@read_file src/main.ts\n\n!?@ripgrep_files \"pattern\" .\n```',
      };
    }

    // labels is always set above
    if (!labels) {
      throw new Error('Failed to initialize labels');
    }

    try {
      const trimmed = headLine.trimEnd();
      const lines = trimmed.split(/\r?\n/);
      if (lines.length > 1) {
        const suspicious = lines.slice(1).find((l) => l.trimStart().startsWith('@'));
        if (suspicious) {
          const toolName = suspicious.trimStart().split(/\s+/)[0];
          const content = labels.invalidFormatMultiToolCalls(toolName);
          return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
        }
      }

      const parsed = parseReadFileOptions(headLine);
      if (parsed.kind === 'error') {
        let reason = '';
        const tokenHint = parsed.error === 'unexpected_token' ? (parsed.token ?? '') : '';
        const tokenLooksLikeToolCall =
          tokenHint.includes('!?@') || /@[-a-zA-Z0-9_]{1,64}/.test(tokenHint);
        if (language === 'zh') {
          if (parsed.error === 'unknown_option') {
            reason = `无法识别的选项：${parsed.option ?? ''}`;
          } else if (parsed.error === 'unexpected_token') {
            reason = `多余参数：${parsed.token ?? ''}`;
            if (tokenLooksLikeToolCall) {
              reason +=
                '（疑似把另一个工具调用并入了同一诉请块 headline；多个工具调用需用普通行分隔）';
            }
          } else if (parsed.error === 'missing_option_value') {
            reason = `${parsed.option ?? ''} 缺少参数（期望 ${parsed.expected ?? ''}）`;
          } else if (parsed.error === 'invalid_option_value') {
            reason = `${parsed.option ?? ''} 的参数无效：${parsed.value ?? ''}`;
          }
        } else {
          if (parsed.error === 'unknown_option') {
            reason = `Unrecognized option: ${parsed.option ?? ''}`;
          } else if (parsed.error === 'unexpected_token') {
            reason = `Unexpected token: ${parsed.token ?? ''}`;
            if (tokenLooksLikeToolCall) {
              reason +=
                ' (It looks like another tool call was merged into the same tellask headline; separate tool calls with a normal line.)';
            }
          } else if (parsed.error === 'missing_option_value') {
            reason = `Missing value for ${parsed.option ?? ''} (expected ${parsed.expected ?? ''})`;
          } else if (parsed.error === 'invalid_option_value') {
            reason = `Invalid value for ${parsed.option ?? ''}: ${parsed.value ?? ''}`;
          }
        }

        const content =
          parsed.error === 'invalid_format' || parsed.error === 'path_required'
            ? labels.formatError
            : labels.formatErrorWithReason(reason);
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const rel = parsed.path;
      const flags = parsed.flags;
      const optionsRequested = parsed.options;
      const options: ReadFileOptions = { ...optionsRequested };
      let maxLinesRangeMismatch: { maxLines: number; rangeLines: number; used: number } | null =
        null;
      if (flags.maxLinesSpecified && flags.rangeSpecified && options.rangeEnd !== undefined) {
        const rangeStart = options.rangeStart ?? 1;
        const rangeLines = options.rangeEnd - rangeStart + 1;
        if (rangeLines > 0 && rangeLines < options.maxLines) {
          maxLinesRangeMismatch = { maxLines: options.maxLines, rangeLines, used: rangeLines };
          options.maxLines = rangeLines;
        }
      }

      // Check member access permissions
      if (!hasReadAccess(caller, rel)) {
        const content = getAccessDeniedMessage('read', rel, language);
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const file = ensureInsideWorkspace(rel);
      const stat = await fs.stat(file);
      const contentSummary = await readFileContentBounded(file, options);

      // Create markdown response
      let markdown = `📄 **${labels.fileLabel}:** \`${rel}\`\n`;

      if (maxLinesRangeMismatch) {
        markdown += labels.warningMaxLinesRangeMismatch(
          maxLinesRangeMismatch.maxLines,
          maxLinesRangeMismatch.rangeLines,
          maxLinesRangeMismatch.used,
        );
      }

      if (contentSummary.truncatedByCharLimit) {
        markdown += labels.warningTruncatedByCharLimit(
          contentSummary.shownLines,
          READ_FILE_CONTENT_CHAR_LIMIT,
        );
      } else if (contentSummary.truncatedByMaxLines) {
        markdown += labels.warningTruncatedByMaxLines(contentSummary.shownLines, options.maxLines);
      }

      if (
        (contentSummary.truncatedByCharLimit || contentSummary.truncatedByMaxLines) &&
        !flags.maxLinesSpecified &&
        !flags.rangeSpecified
      ) {
        const start = contentSummary.shownLines + 1;
        const end = start + 199;
        markdown += labels.hintUseRangeNext(rel, start, end);
      }

      if (contentSummary.truncatedByCharLimit) {
        markdown += labels.hintLargeFileStrategy(rel);
      }

      markdown += `**${labels.sizeLabel}:** ${stat.size} bytes\n`;
      markdown += `**${labels.totalLinesLabel}:** ${contentSummary.totalLines}\n`;
      markdown += '\n';

      // Add file content with code block formatting
      markdown += '```\n';
      markdown += contentSummary.formattedContent;
      if (!contentSummary.formattedContent.endsWith('\n')) {
        markdown += '\n';
      }
      markdown += '```';

      return ok(markdown, [{ type: 'environment_msg', role: 'user', content: markdown }]);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message === 'Invalid format' || error.message === 'Path required')
      ) {
        const content = labels.formatError;
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const msg = error instanceof Error ? error.message : String(error);
      const content = labels.failedToRead(msg);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const replaceFileContentsTool: TellaskTool = {
  type: 'tellask',
  name: 'replace_file_contents',
  backfeeding: true,
  usageDescription: `Replace a file's entire contents (writes literally; does NOT parse diff/patch syntax).
Usage: !?@replace_file_contents <path>
!?<file content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.
  If you paste a diff (e.g. lines starting with \`+\` / \`-\` or \`@@\`), it will be saved literally.`,
  usageDescriptionI18n: {
    en: `Replace a file's entire contents (writes literally; does NOT parse diff/patch syntax).
Usage: !?@replace_file_contents <path>
!?<file content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.
  If you paste a diff (e.g. lines starting with \`+\` / \`-\` or \`@@\`), it will be saved literally.`,
    zh: `用新内容整体替换写入一个文件（逐字写入；不会解析 diff/patch 语法）。
用法：!?@replace_file_contents <path>
!?<文件内容写在正文里>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。
  若粘贴了 diff（例如 \`+\`/\`-\` 前缀或 \`@@\`），会被按字面写入文件。`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat: '错误：格式不正确。用法：!?@replace_file_contents <path>',
            filePathRequired: '错误：需要提供文件路径。',
            contentRequired: '错误：需要在正文中提供文件内容。',
            diffLikeWarning:
              '⚠️ 检测到疑似 diff/patch 内容。\n`replace_file_contents` 会逐字写入；其中的 `+` / `-` / `@@` 等将被保存进文件。\n',
            replaced: (p: string) => `✅ 文件已整体替换写入：\`${p}\`。`,
            replaceFailed: (msg: string) => `❌ **错误**\n\n替换写入文件失败：${msg}`,
          }
        : {
            invalidFormat: 'Error: Invalid format. Use !?@replace_file_contents <path>',
            filePathRequired: 'Error: File path is required.',
            contentRequired: 'Error: File content is required in the body.',
            diffLikeWarning:
              '⚠️ Detected diff-like content.\n`replace_file_contents` writes literally; `+` / `-` / `@@` will be saved into the file.\n',
            replaced: (p: string) => `Replaced contents of: \`${p}\`.`,
            replaceFailed: (msg: string) => `Error replacing file contents: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@replace_file_contents')) {
      const content = labels.invalidFormat;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@replace_file_contents'.length).trim();
    if (!afterToolName) {
      const content = labels.filePathRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const filePath = afterToolName.split(/\s+/)[0];
    if (!filePath) {
      const content = labels.filePathRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!inputBody) {
      const content = labels.contentRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);
      const dir = path.dirname(fullPath);
      fsSync.mkdirSync(dir, { recursive: true });

      const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
      const diffLike = detectDiffLikeContent(inputBody);
      fsSync.writeFileSync(fullPath, normalizedBody, 'utf8');

      const warning = diffLike ? labels.diffLikeWarning : '';
      const normalizedNote =
        addedTrailingNewlineToContent && normalizedBody !== ''
          ? language === 'zh'
            ? '（已规范化：补齐正文末尾换行）\n'
            : '(normalized: added trailing newline)\n'
          : '';

      const content = `${warning}${labels.replaced(filePath)}\n${normalizedNote}`.trimEnd();
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.replaceFailed(error instanceof Error ? error.message : String(error));
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const planFileModificationTool: TellaskTool = {
  type: 'tellask',
  name: 'plan_file_modification',
  backfeeding: true,
  usageDescription: `Plan a single-file modification by line range (does not write yet).
Usage: !?@plan_file_modification <path> <line~range> [!existing-hunk-id]
!?<new content lines in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.
  Body can be empty to delete the target range.

Range formats:
  10~50     - Lines 10 to 50 (replace)
  300~      - From line 300 to end (replace)
  ~20       - From start to line 20 (replace)
  ~         - Whole file (replace)
  42        - Shorthand for 42~42 (replace)
  N~        - If N is (last_line+1), append at end

Workflow:
  1) Plan: tool returns a proposed unified diff hunk with a generated hunk id.
  2) Review the diff.
  3) Apply: confirm by calling \`!?@apply_file_modification !<hunk-id>\`.
  4) Optional revise: re-run this tool with \`!<hunk-id>\` to update the planned hunk.
     - You cannot choose custom hunk ids. The optional \`!<hunk-id>\` must be an existing id previously generated by this tool.

Tip:
  For multiple hunks, plan each hunk separately.
  - Multiple applies to the same file can be in one message; they are serialized in-process (older planned hunks first).
  - Multiple applies to different files are safe to batch in one message.`,
  usageDescriptionI18n: {
    en: `Plan a single-file modification by line range (does not write yet).
Usage: !?@plan_file_modification <path> <line~range> [!existing-hunk-id]
!?<new content lines in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.
  Body can be empty to delete the target range.

Range formats:
  10~50     - Lines 10 to 50 (replace)
  300~      - From line 300 to end (replace)
  ~20       - From start to line 20 (replace)
  ~         - Whole file (replace)
  42        - Shorthand for 42~42 (replace)
  N~        - If N is (last_line+1), append at end

Workflow:
  1) Plan: tool returns a proposed unified diff hunk with a generated hunk id.
  2) Review the diff.
  3) Apply: confirm by calling \`!?@apply_file_modification !<hunk-id>\`.
  4) Optional revise: re-run this tool with \`!<hunk-id>\` to update the planned hunk.
     - You cannot choose custom hunk ids. The optional \`!<hunk-id>\` must be an existing id previously generated by this tool.

Tip:
  For multiple hunks, plan each hunk separately.
  - Multiple applies to the same file can be in one message; they are serialized in-process (older planned hunks first).
  - Multiple applies to different files are safe to batch in one message.`,
    zh: `按行号范围规划单文件修改（不会立刻写入文件）。
用法：!?@plan_file_modification <path> <line~range> [!existing-hunk-id]
!?<正文为新内容行>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。
  正文可为空，表示删除目标范围。

范围格式：
  10~50     - 第 10 行到第 50 行（替换）
  300~      - 从第 300 行到末尾（替换）
  ~20       - 从开头到第 20 行（替换）
  ~         - 整个文件（替换）
  42        - 等价于 42~42（替换）
  N~        - 若 N =（最后一行+1），表示追加到末尾

流程：
  1) 规划：返回一个 proposed unified diff hunk，并生成 hunk id。
  2) 你先检查 diff。
  3) 应用：用 \`!?@apply_file_modification !<hunk-id>\` 显式确认并写入。
  4) 可选修订：再次调用本工具并带上 \`!<hunk-id>\` 更新该规划。
     - 不支持自定义 hunk id；可选的 \`!<hunk-id>\` 必须是本工具之前生成的、仍然存在的 id。

提示：
  多处修改请拆成多个 hunk：分别规划。
  - 同一文件的多个 apply 可放在同一条消息里：系统会在进程内串行应用（按“更早规划的 hunk 先应用”）。
  - 不同文件的多个 apply 放在同一条消息里可安全批量确认。`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat:
              '错误：格式不正确。\n\n期望格式：`!?@plan_file_modification <path> <line~range> [!existing-hunk-id]`',
            filePathRequired: '错误：需要提供文件路径。',
            rangeRequired: '错误：需要提供行号范围（例如 10~20 或 ~）。',
            fileDoesNotExist: (p: string) => `错误：文件 \`${p}\` 不存在。`,
            planned: (id: string, p: string) => `✅ 已规划：\`!${id}\` → \`${p}\``,
            next: (id: string) =>
              `下一步：执行 \`!?@apply_file_modification !${id}\` 来确认并写入。`,
            invalidHunkId: '错误：hunk id 格式无效（期望 `!<hunk-id>`）。',
            unknownHunkId: (id: string) =>
              `错误：hunk id \`!${id}\` 不存在（可能已过期/已被应用）。不支持自定义 hunk id；新规划请省略第三个参数，由工具自动生成。`,
            wrongOwner: (id: string) => `错误：hunk id \`!${id}\` 不是由当前成员规划的，不能覆写。`,
            planFailed: (msg: string) => `错误：生成修改规划失败：${msg}`,
          }
        : {
            invalidFormat:
              'Error: Invalid format.\n\nExpected: `!?@plan_file_modification <path> <line~range> [!existing-hunk-id]`',
            filePathRequired: 'Error: File path is required.',
            rangeRequired: 'Error: Line range is required (e.g. 10~20 or ~).',
            fileDoesNotExist: (p: string) => `Error: File \`${p}\` does not exist.`,
            planned: (id: string, p: string) => `✅ Planned \`!${id}\` for \`${p}\``,
            next: (id: string) =>
              `Next: run \`!?@apply_file_modification !${id}\` to confirm and write.`,
            invalidHunkId: 'Error: invalid hunk id format (expected `!<hunk-id>`).',
            unknownHunkId: (id: string) =>
              `Error: hunk id \`!${id}\` not found (expired or already applied). Custom hunk ids are not allowed; omit the third argument to generate a new one.`,
            wrongOwner: (id: string) =>
              `Error: hunk id \`!${id}\` was planned by a different member; cannot overwrite.`,
            planFailed: (msg: string) => `Error planning modification: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@plan_file_modification')) {
      const content = labels.invalidFormat;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@plan_file_modification'.length).trim();
    if (!afterToolName) {
      const content = labels.filePathRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const parts = afterToolName.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 3) {
      const content = labels.invalidFormat;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const filePath = parts[0] ?? '';
    const rangeSpec = parts[1] ?? '';
    const maybeId = parts[2] ?? '';
    const requestedId = parseOptionalHunkId(maybeId);
    if (maybeId && !requestedId) {
      const content = labels.invalidHunkId;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!filePath) {
      const content = labels.filePathRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!rangeSpec) {
      const content = labels.rangeRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check write access
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      pruneExpiredPlannedMods(Date.now());
      const fullPath = ensureInsideWorkspace(filePath);
      if (requestedId) {
        const existing = plannedModsById.get(requestedId);
        if (!existing) {
          const content = labels.unknownHunkId(requestedId);
          return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
        }
        if (existing.plannedBy !== caller.id) {
          const content = labels.wrongOwner(requestedId);
          return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
        }
      }

      // Check if file exists
      if (!fsSync.existsSync(fullPath)) {
        const content = labels.fileDoesNotExist(filePath);
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Read current file content
      const currentContent = fsSync.readFileSync(fullPath, 'utf8');
      const currentLines = splitFileTextToLines(currentContent);

      const totalLines = rangeTotalLines(currentLines);
      const parsed = parseLineRangeSpec(rangeSpec, totalLines);
      if (!parsed.ok) {
        const content =
          language === 'zh'
            ? `错误：行号范围无效：${parsed.error}`
            : `Error: invalid line range: ${parsed.error}`;
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const range = parsed.range;
      const startIndex0 = range.kind === 'append' ? totalLines : range.startLine - 1;
      const deleteCount = range.kind === 'append' ? 0 : range.endLine - range.startLine + 1;
      const newLines = splitPlannedBodyLines(inputBody);
      const oldLines = currentLines.slice(startIndex0, startIndex0 + deleteCount);
      const { contextBefore, contextAfter } = computeContextWindow(
        currentLines,
        startIndex0,
        deleteCount,
      );

      const unifiedDiff = buildUnifiedSingleHunkDiff(
        filePath,
        currentLines,
        startIndex0,
        deleteCount,
        newLines,
      );

      const nowMs = Date.now();
      const hunkId = (() => {
        if (requestedId) return requestedId;
        for (let i = 0; i < 10; i += 1) {
          const id = generateHunkId();
          if (!plannedModsById.has(id)) return id;
        }
        throw new Error('Failed to generate a unique hunk id');
      })();
      const planned: PlannedFileModification = {
        hunkId,
        plannedBy: caller.id,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + PLANNED_MOD_TTL_MS,
        relPath: filePath,
        absPath: fullPath,
        range,
        startIndex0,
        deleteCount,
        contextBefore,
        contextAfter,
        oldLines,
        newLines,
        unifiedDiff,
      };
      plannedModsById.set(hunkId, planned);

      const rangeLabel =
        range.kind === 'append' ? `${range.startLine}~` : `${range.startLine}~${range.endLine}`;

      const reviseHint =
        language === 'zh'
          ? `（可选：用 \`!?@plan_file_modification ${filePath} ${rangeSpec} !${hunkId}\` 重新规划并覆写该 hunk。）`
          : `Optional: revise by running \`!?@plan_file_modification ${filePath} ${rangeSpec} !${hunkId}\` with corrected body.`;

      const action: 'replace' | 'append' | 'delete' =
        range.kind === 'append' ? 'append' : newLines.length === 0 ? 'delete' : 'replace';

      const resolvedStart = range.kind === 'append' ? range.startLine : range.startLine;
      const resolvedEnd =
        range.kind === 'append'
          ? range.startLine + Math.max(0, newLines.length - 1)
          : range.endLine;

      const evidenceBefore = previewWindow(currentLines, startIndex0 - 2, 2);
      const evidenceRange = buildRangePreview(oldLines);
      const evidenceAfter = previewWindow(currentLines, startIndex0 + deleteCount, 2);

      const linesOld = deleteCount;
      const linesNew = newLines.length;
      const delta = linesNew - linesOld;

      const summary =
        language === 'zh'
          ? `Plan：${action} 第 ${resolvedStart}–${resolvedEnd} 行（old=${linesOld}, new=${linesNew}, delta=${delta}）；匹配=exact；hunk_id=${hunkId}.`
          : `Plan: ${action} lines ${resolvedStart}–${resolvedEnd} (old=${linesOld}, new=${linesNew}, delta=${delta}); matched exact; hunk_id=${hunkId}.`;

      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(filePath)}`,
        `hunk_id: ${yamlQuote(hunkId)}`,
        `action: ${action}`,
        `range:`,
        `  input: ${yamlQuote(rangeSpec)}`,
        `  resolved:`,
        `    start: ${resolvedStart}`,
        `    end: ${resolvedEnd}`,
        `file_line_count: ${fileLineCount(currentLines)}`,
        `lines:`,
        `  old: ${linesOld}`,
        `  new: ${linesNew}`,
        `  delta: ${delta}`,
        `match: exact`,
        `evidence:`,
        `  before: ${yamlBlockScalarLines(evidenceBefore, '    ')}`,
        `  range: ${yamlBlockScalarLines(evidenceRange, '    ')}`,
        `  after: ${yamlBlockScalarLines(evidenceAfter, '    ')}`,
        `summary: ${yamlQuote(summary)}`,
      ].join('\n');

      const content =
        `${labels.planned(hunkId, filePath)}\n\n` +
        `${formatYamlCodeBlock(yaml)}\n\n` +
        `\`\`\`diff\n${unifiedDiff}\`\`\`\n\n` +
        `${labels.next(hunkId)}\n` +
        `${reviseHint}\n` +
        (language === 'zh'
          ? `（Range resolved: \`${rangeLabel}\`）`
          : `(Range resolved: \`${rangeLabel}\`)`);

      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.planFailed(error instanceof Error ? error.message : String(error));
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const applyFileModificationTool: TellaskTool = {
  type: 'tellask',
  name: 'apply_file_modification',
  usageDescription:
    'Apply a previously planned file modification by hunk id.\n' +
    'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
    'Notes: Applies are serialized per file (single-process). The hunk may still apply if lines moved, as long as the original target content is uniquely matchable.\n' +
    'Usage: !?@apply_file_modification !<hunk-id>\n' +
    '(no body)',
  usageDescriptionI18n: {
    en:
      'Apply a previously planned file modification by hunk id.\n' +
      'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
      'Notes: Applies are serialized per file (single-process). The hunk may still apply if lines moved, as long as the original target content is uniquely matchable.\n' +
      'Usage: !?@apply_file_modification !<hunk-id>\n' +
      '(no body)',
    zh:
      '按 hunk id 应用之前规划的单文件修改。\n' +
      '注意：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。\n' +
      '说明：同一文件的 apply 会在进程内串行化；若行号发生移动，只要能在文件中唯一定位到原始目标内容，仍可应用。\n' +
      '用法：!?@apply_file_modification !<hunk-id>\n' +
      '（无正文）',
  },
  backfeeding: true,
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat: '错误：格式不正确。用法：!?@apply_file_modification !<hunk-id>',
            hunkIdRequired: '错误：需要提供要应用的 hunk id（例如 `!a1b2c3d4`）。',
            notFound: (id: string) => `错误：未找到该 hunk：\`!${id}\`（可能已过期或已被应用）。`,
            wrongOwner: '错误：该 hunk 不是由当前成员规划的，不能应用。',
            mismatch: '错误：文件内容已变化，无法安全应用该 hunk；请重新规划。',
            ambiguous:
              '错误：无法唯一定位该 hunk 的目标位置（文件内出现多处匹配）；请重新规划（缩小范围或增加上下文）。',
            applied: (p: string, id: string) => `✅ 已应用：\`!${id}\` → \`${p}\``,
            applyFailed: (msg: string) => `错误：应用失败：${msg}`,
          }
        : {
            invalidFormat: 'Error: Invalid format. Use !?@apply_file_modification !<hunk-id>',
            hunkIdRequired: 'Error: hunk id is required (e.g. `!a1b2c3d4`).',
            notFound: (id: string) =>
              `Error: hunk \`!${id}\` not found (expired or already applied).`,
            wrongOwner: 'Error: this hunk was planned by a different member.',
            mismatch:
              'Error: file content has changed; refusing to apply this hunk safely. Re-plan it.',
            ambiguous:
              'Error: unable to uniquely locate the hunk target (multiple matches). Re-plan with a narrower range or more context.',
            applied: (p: string, id: string) => `✅ Applied \`!${id}\` to \`${p}\``,
            applyFailed: (msg: string) => `Error applying modification: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@apply_file_modification')) {
      const content = labels.invalidFormat;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const afterToolName = trimmed.slice('@apply_file_modification'.length).trim();
    if (!afterToolName) {
      const content = labels.hunkIdRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const raw = afterToolName.split(/\s+/)[0] ?? '';
    const id = raw.startsWith('!') ? raw.slice(1) : raw;
    if (!id) {
      const content = labels.hunkIdRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      pruneExpiredPlannedMods(Date.now());
      const planned = plannedModsById.get(id);
      if (!planned) {
        const content = labels.notFound(id);
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (planned.plannedBy !== caller.id) {
        const content = labels.wrongOwner;
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (!hasWriteAccess(caller, planned.relPath)) {
        const content = getAccessDeniedMessage('write', planned.relPath, language);
        return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const absKey = planned.absPath;
      const res = await new Promise<TellaskToolCallResult>((resolve) => {
        enqueueFileApply(absKey, {
          priority: planned.createdAtMs,
          tieBreaker: planned.hunkId,
          run: async () => {
            try {
              pruneExpiredPlannedMods(Date.now());
              const p = plannedModsById.get(id);
              if (!p) {
                const content = labels.notFound(id);
                resolve(
                  wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]),
                );
                return;
              }
              if (p.plannedBy !== caller.id) {
                const content = labels.wrongOwner;
                resolve(
                  wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]),
                );
                return;
              }

              const currentContent = fsSync.readFileSync(p.absPath, 'utf8');
              const currentLines = splitFileTextToLines(currentContent);

              let startIndex0 = -1;
              if (p.deleteCount === 0 && p.oldLines.length === 0) {
                // Append-at-end is stable even if the file has changed.
                startIndex0 = currentLines.length;
              } else if (matchesAt(currentLines, p.startIndex0, p.oldLines)) {
                startIndex0 = p.startIndex0;
              } else {
                const all = findAllMatches(currentLines, p.oldLines);
                if (all.length === 0) {
                  const summary =
                    language === 'zh'
                      ? 'Apply rejected：文件内容已变化，无法定位该 hunk 目标位置；请重新 plan。'
                      : 'Apply rejected: file content changed; unable to locate the hunk target; re-plan this hunk.';
                  const yaml = [
                    `status: error`,
                    `path: ${yamlQuote(p.relPath)}`,
                    `hunk_id: ${yamlQuote(id)}`,
                    `context_match: rejected`,
                    `error: CONTENT_CHANGED`,
                    `summary: ${yamlQuote(summary)}`,
                  ].join('\n');
                  const content = formatYamlCodeBlock(yaml);
                  resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
                  return;
                }
                if (all.length === 1) {
                  startIndex0 = all[0];
                } else {
                  const filtered = filterByContext(
                    currentLines,
                    all,
                    p.contextBefore,
                    p.contextAfter,
                    p.oldLines.length,
                  );
                  if (filtered.length === 1) {
                    startIndex0 = filtered[0];
                  } else {
                    const summary =
                      language === 'zh'
                        ? 'Apply rejected：hunk 目标位置不唯一（多处匹配）；请缩小范围或增加上下文后重新 plan。'
                        : 'Apply rejected: ambiguous hunk target (multiple matches); re-plan with a narrower range or more context.';
                    const yaml = [
                      `status: error`,
                      `path: ${yamlQuote(p.relPath)}`,
                      `hunk_id: ${yamlQuote(id)}`,
                      `context_match: rejected`,
                      `error: AMBIGUOUS_MATCH`,
                      `summary: ${yamlQuote(summary)}`,
                    ].join('\n');
                    const content = formatYamlCodeBlock(yaml);
                    resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
                    return;
                  }
                }
              }

              const nextLines = [...currentLines];
              nextLines.splice(startIndex0, p.deleteCount, ...p.newLines);
              const nextText = joinLinesForWrite(nextLines);
              fsSync.writeFileSync(p.absPath, nextText, 'utf8');
              plannedModsById.delete(id);

              const contextMatch =
                p.deleteCount === 0 && p.oldLines.length === 0
                  ? ('exact' as const)
                  : startIndex0 === p.startIndex0
                    ? ('exact' as const)
                    : ('fuzz' as const);

              const action: 'replace' | 'append' | 'delete' =
                p.deleteCount === 0 && p.oldLines.length === 0
                  ? 'append'
                  : p.newLines.length === 0
                    ? 'delete'
                    : 'replace';

              const startLine = startIndex0 + 1;
              const endLine =
                action === 'delete'
                  ? startLine + p.deleteCount - 1
                  : startLine + Math.max(0, p.newLines.length - 1);

              const evidenceBefore = previewWindow(nextLines, startIndex0 - 2, 2);
              const appliedRangeLines =
                action === 'delete'
                  ? ([] as const)
                  : nextLines.slice(startIndex0, startIndex0 + p.newLines.length);
              const evidenceRange = buildRangePreview(appliedRangeLines);
              const afterStartIndex0 =
                action === 'delete' ? startIndex0 : startIndex0 + p.newLines.length;
              const evidenceAfter = previewWindow(nextLines, afterStartIndex0, 2);

              const linesOld = p.deleteCount;
              const linesNew = p.newLines.length;
              const delta = linesNew - linesOld;
              const summary =
                language === 'zh'
                  ? `Apply：${action} 第 ${startLine}–${endLine} 行（old=${linesOld}, new=${linesNew}, delta=${delta}）；匹配=${contextMatch}；hunk_id=${id}.`
                  : `Apply: ${action} lines ${startLine}–${endLine} (old=${linesOld}, new=${linesNew}, delta=${delta}); matched ${contextMatch}; hunk_id=${id}.`;

              const yaml = [
                `status: ok`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `action: ${action}`,
                `range:`,
                `  applied:`,
                `    start: ${startLine}`,
                `    end: ${endLine}`,
                `lines:`,
                `  old: ${linesOld}`,
                `  new: ${linesNew}`,
                `  delta: ${delta}`,
                `context_match: ${contextMatch}`,
                `evidence:`,
                `  before: ${yamlBlockScalarLines(evidenceBefore, '    ')}`,
                `  range: ${yamlBlockScalarLines(evidenceRange, '    ')}`,
                `  after: ${yamlBlockScalarLines(evidenceAfter, '    ')}`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');

              const content =
                `${labels.applied(p.relPath, id)}\n\n` +
                `${formatYamlCodeBlock(yaml)}\n\n` +
                `\`\`\`diff\n${p.unifiedDiff}\`\`\``;
              resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
            } catch (error: unknown) {
              const content = labels.applyFailed(
                error instanceof Error ? error.message : String(error),
              );
              resolve(
                wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]),
              );
            }
          },
        });
        void drainFileApplyQueue(absKey);
      });

      return res;
    } catch (error: unknown) {
      const content = labels.applyFailed(error instanceof Error ? error.message : String(error));
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const appendFileTool: TellaskTool = {
  type: 'tellask',
  name: 'append_file',
  backfeeding: true,
  usageDescription: `Append content to the end of a text file.
Usage: !?@append_file <path>
!?<content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.`,
  usageDescriptionI18n: {
    en: `Append content to the end of a text file.
Usage: !?@append_file <path>
!?<content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.`,
    zh: `向文本文件末尾追加内容。
用法：!?@append_file <path>
!?<正文为追加内容>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat: '错误：格式不正确。用法：!?@append_file <path>',
            filePathRequired: '错误：需要提供文件路径。',
            contentRequired: '错误：需要在正文中提供追加内容。',
            writeFailed: (msg: string) => `错误：追加失败：${msg}`,
          }
        : {
            invalidFormat: 'Error: Invalid format. Use !?@append_file <path>',
            filePathRequired: 'Error: file path is required.',
            contentRequired: 'Error: content is required in the body.',
            writeFailed: (msg: string) => `Error appending to file: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@append_file')) {
      const content = labels.invalidFormat;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const afterToolName = trimmed.slice('@append_file'.length).trim();
    const filePath = afterToolName.split(/\s+/)[0] ?? '';
    if (!filePath) {
      const content = labels.filePathRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (inputBody === '') {
      const content = labels.contentRequired;
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);
      fsSync.mkdirSync(path.dirname(fullPath), { recursive: true });

      const existing = fsSync.existsSync(fullPath) ? fsSync.readFileSync(fullPath, 'utf8') : '';
      const addedLeadingNewlineToFile = existing !== '' && !existing.endsWith('\n');
      const existingNormalized = addedLeadingNewlineToFile ? `${existing}\n` : existing;

      const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
      const out = `${existingNormalized}${normalizedBody}`;
      fsSync.writeFileSync(fullPath, out, 'utf8');

      const beforeCount = countLogicalLines(existing);
      const afterCount = countLogicalLines(out);
      const appendedCount = countLogicalLines(normalizedBody);

      const summary =
        language === 'zh'
          ? `Append：+${appendedCount} 行；file ${beforeCount} → ${afterCount}；normalized: file_eof_newline=${addedLeadingNewlineToFile}, content_eof_newline=${addedTrailingNewlineToContent}.`
          : `Append: +${appendedCount} lines; file ${beforeCount} → ${afterCount}; normalized: file_eof_newline=${addedLeadingNewlineToFile}, content_eof_newline=${addedTrailingNewlineToContent}.`;

      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(filePath)}`,
        `mode: append`,
        `file_line_count_before: ${beforeCount}`,
        `file_line_count_after: ${afterCount}`,
        `appended_line_count: ${appendedCount}`,
        `normalized:`,
        `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
        `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
        `summary: ${yamlQuote(summary)}`,
      ].join('\n');

      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: append`,
          `error: WRITE_FAILED`,
          `summary: ${yamlQuote(labels.writeFailed(error instanceof Error ? error.message : String(error)))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const insertAfterTool: TellaskTool = {
  type: 'tellask',
  name: 'insert_after',
  backfeeding: true,
  usageDescription: `Insert content after an anchor string (by occurrence).
Usage: !?@insert_after <path> <anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  strict=true|false (default: true)`,
  usageDescriptionI18n: {
    en: `Insert content after an anchor string (by occurrence).
Usage: !?@insert_after <path> <anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  strict=true|false (default: true)`,
    zh: `在锚点字符串之后插入内容（按 occurrence 选择）。
用法：!?@insert_after <path> <anchor> [options]
!?<正文为插入内容>

选项：
  occurrence=<n|last>（默认 1）
  strict=true|false（默认 true）`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@insert_after')) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: insert_after\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-after 失败：格式不正确。用法：!?@insert_after <path> <anchor> [options]（body 为要插入的内容）。'
            : 'Insert-after failed: invalid format. Use !?@insert_after <path> <anchor> [options].',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@insert_after'.length).trim();
    const args = splitCommandArgs(afterToolName);
    const filePath = args[0] ?? '';
    const anchor = args[1] ?? '';
    const optTokens = args.slice(2);

    if (!filePath || !anchor) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: insert_after\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-after failed: path and anchor are required. 用法：!?@insert_after <path> <anchor> [options]（参数必须在同一行；body 为要插入的内容）。'
            : 'Insert-after failed: path and anchor are required. Usage: !?@insert_after <path> <anchor> [options] (args must be on the same line; body is inserted text).',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!hasWriteAccess(caller, filePath)) {
      const content = formatYamlCodeBlock(
        `status: error\npath: ${yamlQuote(filePath)}\nmode: insert_after\nerror: CONTENT_REQUIRED\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-after 失败：body 中需要提供要插入的内容。'
            : 'Insert-after failed: content is required in the body.',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;
    let strict = true;
    for (const tok of optTokens) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (key === 'occurrence') {
        const parsed = parseOccurrence(value);
        if (parsed) {
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else if (key === 'strict') {
        const parsed = parseBooleanOption(value);
        if (parsed !== undefined) strict = parsed;
      }
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);
      if (!fsSync.existsSync(fullPath)) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_after`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: FILE_NOT_FOUND`,
            `summary: ${yamlQuote('Insert-after failed: file does not exist.')}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const existing = fsSync.readFileSync(fullPath, 'utf8');
      const addedLeadingNewlineToFile = existing !== '' && !existing.endsWith('\n');

      const lines = splitTextToLinesForEditing(existing);
      const matchLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if ((lines[i] ?? '').includes(anchor)) matchLines.push(i);
      }

      if (!occurrenceSpecified && matchLines.length > 1) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_after`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: ANCHOR_AMBIGUOUS`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Insert-after failed: anchor appears multiple times; specify occurrence or use plan/apply_file_modification.'
                : 'Insert-after failed: anchor appears multiple times; specify occurrence or use plan/apply_file_modification.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      if (matchLines.length === 0) {
        if (strict) {
          const content = formatYamlCodeBlock(
            [
              `status: error`,
              `path: ${yamlQuote(filePath)}`,
              `mode: insert_after`,
              `anchor: ${yamlQuote(anchor)}`,
              `error: ANCHOR_NOT_FOUND`,
              `summary: ${yamlQuote(
                language === 'zh'
                  ? 'Insert-after failed: anchor not found. Use plan/apply_file_modification for precise edits or choose a different anchor.'
                  : 'Insert-after failed: anchor not found. Use plan/apply_file_modification for precise edits or choose a different anchor.',
              )}`,
            ].join('\n'),
          );
          return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
        }

        const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
        const out = `${existing}${existing !== '' && !existing.endsWith('\n') ? '\n' : ''}${normalizedBody}`;
        fsSync.writeFileSync(fullPath, out, 'utf8');

        const insertedCount = countLogicalLines(normalizedBody);
        const summary =
          language === 'zh'
            ? `Insert-after (fallback append): +${insertedCount} 行；anchor 未找到（strict=false）。`
            : `Insert-after (fallback append): +${insertedCount} lines; anchor not found (strict=false).`;
        const yaml = [
          `status: ok`,
          `path: ${yamlQuote(filePath)}`,
          `mode: insert_after`,
          `anchor: ${yamlQuote(anchor)}`,
          `occurrence_resolved: ${yamlQuote(occurrence.kind === 'last' ? 'last' : String(occurrence.index1))}`,
          `inserted_at_line: ${countLogicalLines(existing)}`,
          `inserted_line_count: ${insertedCount}`,
          `normalized:`,
          `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
          `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
          `evidence_preview:`,
          `  before_preview: ${yamlFlowStringArray([])}`,
          `  insert_preview: ${yamlFlowStringArray(splitPlannedBodyLines(normalizedBody).slice(0, 2))}`,
          `  after_preview: ${yamlFlowStringArray([])}`,
          `summary: ${yamlQuote(summary)}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const anchorIndex0 =
        occurrence.kind === 'last'
          ? matchLines[matchLines.length - 1]
          : matchLines[occurrence.index1 - 1];
      if (anchorIndex0 === undefined) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_after`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: OCCURRENCE_OUT_OF_RANGE`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Insert-after failed: occurrence out of range.'
                : 'Insert-after failed: occurrence out of range.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const occurrenceResolved = occurrence.kind === 'last' ? 'last' : String(occurrence.index1);
      const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
      const insertLines = splitPlannedBodyLines(normalizedBody);
      const insertionIndex0 = anchorIndex0 + 1;
      const outLines = [...lines];
      outLines.splice(insertionIndex0, 0, ...insertLines);
      const out = joinLinesForTextWrite(outLines);
      fsSync.writeFileSync(fullPath, out, 'utf8');

      const insertedCount = insertLines.length;
      const insertedAtLine = anchorIndex0 + 1;
      const insertPreview = insertLines.length <= 2 ? insertLines : insertLines.slice(0, 2);

      const beforePreview = outLines.slice(Math.max(0, insertionIndex0 - 2), insertionIndex0);
      const afterPreview = outLines.slice(
        insertionIndex0 + insertedCount,
        insertionIndex0 + insertedCount + 2,
      );

      const summary =
        language === 'zh'
          ? `Insert-after: +${insertedCount} 行；after "${anchor}"（occurrence=${occurrenceResolved}）at line ${insertedAtLine}.`
          : `Insert-after: +${insertedCount} lines after "${anchor}" (occurrence=${occurrenceResolved}) at line ${insertedAtLine}.`;

      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(filePath)}`,
        `mode: insert_after`,
        `anchor: ${yamlQuote(anchor)}`,
        `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
        `inserted_at_line: ${insertedAtLine}`,
        `inserted_line_count: ${insertedCount}`,
        `normalized:`,
        `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
        `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
        `evidence_preview:`,
        `  before_preview: ${yamlFlowStringArray(beforePreview)}`,
        `  insert_preview: ${yamlFlowStringArray(insertPreview)}`,
        `  after_preview: ${yamlFlowStringArray(afterPreview)}`,
        `summary: ${yamlQuote(summary)}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: insert_after`,
          `anchor: ${yamlQuote(anchor)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const insertBeforeTool: TellaskTool = {
  type: 'tellask',
  name: 'insert_before',
  backfeeding: true,
  usageDescription: `Insert content before an anchor string (by occurrence).
Usage: !?@insert_before <path> <anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  strict=true|false (default: true)`,
  usageDescriptionI18n: {
    en: `Insert content before an anchor string (by occurrence).
Usage: !?@insert_before <path> <anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  strict=true|false (default: true)`,
    zh: `在锚点字符串之前插入内容（按 occurrence 选择）。
用法：!?@insert_before <path> <anchor> [options]
!?<正文为插入内容>

选项：
  occurrence=<n|last>（默认 1）
  strict=true|false（默认 true）`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@insert_before')) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: insert_before\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-before 失败：格式不正确。用法：!?@insert_before <path> <anchor> [options]（body 为要插入的内容）。'
            : 'Insert-before failed: invalid format. Use !?@insert_before <path> <anchor> [options].',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@insert_before'.length).trim();
    const args = splitCommandArgs(afterToolName);
    const filePath = args[0] ?? '';
    const anchor = args[1] ?? '';
    const optTokens = args.slice(2);

    if (!filePath || !anchor) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: insert_before\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-before failed: path and anchor are required. 用法：!?@insert_before <path> <anchor> [options]（参数必须在同一行；body 为要插入的内容）。'
            : 'Insert-before failed: path and anchor are required. Usage: !?@insert_before <path> <anchor> [options] (args must be on the same line; body is inserted text).',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (inputBody === '') {
      const content = formatYamlCodeBlock(
        `status: error\npath: ${yamlQuote(filePath)}\nmode: insert_before\nerror: CONTENT_REQUIRED\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Insert-before 失败：body 中需要提供要插入的内容。'
            : 'Insert-before failed: content is required in the body.',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;
    let strict = true;
    for (const tok of optTokens) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (key === 'occurrence') {
        const parsed = parseOccurrence(value);
        if (parsed) {
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else if (key === 'strict') {
        const parsed = parseBooleanOption(value);
        if (parsed !== undefined) strict = parsed;
      }
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);
      if (!fsSync.existsSync(fullPath)) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_before`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: FILE_NOT_FOUND`,
            `summary: ${yamlQuote('Insert-before failed: file does not exist.')}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const existing = fsSync.readFileSync(fullPath, 'utf8');
      const addedLeadingNewlineToFile = existing !== '' && !existing.endsWith('\n');
      const lines = splitTextToLinesForEditing(existing);
      const matchLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if ((lines[i] ?? '').includes(anchor)) matchLines.push(i);
      }

      if (!occurrenceSpecified && matchLines.length > 1) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_before`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: ANCHOR_AMBIGUOUS`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Insert-before failed: anchor appears multiple times; specify occurrence or use plan/apply_file_modification.'
                : 'Insert-before failed: anchor appears multiple times; specify occurrence or use plan/apply_file_modification.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      if (matchLines.length === 0) {
        if (strict) {
          const content = formatYamlCodeBlock(
            [
              `status: error`,
              `path: ${yamlQuote(filePath)}`,
              `mode: insert_before`,
              `anchor: ${yamlQuote(anchor)}`,
              `error: ANCHOR_NOT_FOUND`,
              `summary: ${yamlQuote(
                language === 'zh'
                  ? 'Insert-before failed: anchor not found. Use plan/apply_file_modification for precise edits or choose a different anchor.'
                  : 'Insert-before failed: anchor not found. Use plan/apply_file_modification for precise edits or choose a different anchor.',
              )}`,
            ].join('\n'),
          );
          return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
        }

        const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
        const out = `${existing}${existing !== '' && !existing.endsWith('\n') ? '\n' : ''}${normalizedBody}`;
        fsSync.writeFileSync(fullPath, out, 'utf8');

        const insertedCount = countLogicalLines(normalizedBody);
        const summary =
          language === 'zh'
            ? `Insert-before (fallback append): +${insertedCount} 行；anchor 未找到（strict=false）。`
            : `Insert-before (fallback append): +${insertedCount} lines; anchor not found (strict=false).`;
        const yaml = [
          `status: ok`,
          `path: ${yamlQuote(filePath)}`,
          `mode: insert_before`,
          `anchor: ${yamlQuote(anchor)}`,
          `occurrence_resolved: ${yamlQuote(occurrence.kind === 'last' ? 'last' : String(occurrence.index1))}`,
          `inserted_at_line: ${countLogicalLines(existing)}`,
          `inserted_line_count: ${insertedCount}`,
          `normalized:`,
          `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
          `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
          `evidence_preview:`,
          `  before_preview: ${yamlFlowStringArray([])}`,
          `  insert_preview: ${yamlFlowStringArray(splitPlannedBodyLines(normalizedBody).slice(0, 2))}`,
          `  after_preview: ${yamlFlowStringArray([])}`,
          `summary: ${yamlQuote(summary)}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const anchorIndex0 =
        occurrence.kind === 'last'
          ? matchLines[matchLines.length - 1]
          : matchLines[occurrence.index1 - 1];
      if (anchorIndex0 === undefined) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: insert_before`,
            `anchor: ${yamlQuote(anchor)}`,
            `error: OCCURRENCE_OUT_OF_RANGE`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Insert-before failed: occurrence out of range.'
                : 'Insert-before failed: occurrence out of range.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const occurrenceResolved = occurrence.kind === 'last' ? 'last' : String(occurrence.index1);
      const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
      const insertLines = splitPlannedBodyLines(normalizedBody);
      const insertionIndex0 = anchorIndex0;
      const outLines = [...lines];
      outLines.splice(insertionIndex0, 0, ...insertLines);
      const out = joinLinesForTextWrite(outLines);
      fsSync.writeFileSync(fullPath, out, 'utf8');

      const insertedCount = insertLines.length;
      const insertedAtLine = anchorIndex0 + 1;
      const insertPreview = insertLines.length <= 2 ? insertLines : insertLines.slice(0, 2);
      const beforePreview = outLines.slice(Math.max(0, anchorIndex0 - 2), anchorIndex0);
      const afterPreview = outLines.slice(
        anchorIndex0 + insertedCount,
        anchorIndex0 + insertedCount + 2,
      );

      const summary =
        language === 'zh'
          ? `Insert-before: +${insertedCount} 行；before "${anchor}"（occurrence=${occurrenceResolved}）at line ${insertedAtLine}.`
          : `Insert-before: +${insertedCount} lines before "${anchor}" (occurrence=${occurrenceResolved}) at line ${insertedAtLine}.`;

      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(filePath)}`,
        `mode: insert_before`,
        `anchor: ${yamlQuote(anchor)}`,
        `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
        `inserted_at_line: ${insertedAtLine}`,
        `inserted_line_count: ${insertedCount}`,
        `normalized:`,
        `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
        `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
        `evidence_preview:`,
        `  before_preview: ${yamlFlowStringArray(beforePreview)}`,
        `  insert_preview: ${yamlFlowStringArray(insertPreview)}`,
        `  after_preview: ${yamlFlowStringArray(afterPreview)}`,
        `summary: ${yamlQuote(summary)}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: insert_before`,
          `anchor: ${yamlQuote(anchor)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const replaceBlockTool: TellaskTool = {
  type: 'tellask',
  name: 'replace_block',
  backfeeding: true,
  usageDescription: `Replace a block between start/end anchors.
Usage: !?@replace_block <path> <start_anchor> <end_anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  include_anchors=true|false (default: true)`,
  usageDescriptionI18n: {
    en: `Replace a block between start/end anchors.
Usage: !?@replace_block <path> <start_anchor> <end_anchor> [options]
!?<content in body>

Options:
  occurrence=<n|last> (default: 1)
  include_anchors=true|false (default: true)`,
    zh: `按 start/end 锚点替换块内容。
用法：!?@replace_block <path> <start_anchor> <end_anchor> [options]
!?<正文为新块内容>

选项：
  occurrence=<n|last>（默认 1）
  include_anchors=true|false（默认 true）`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@replace_block')) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: replace_block\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Replace-block failed: invalid format. Use !?@replace_block <path> <start_anchor> <end_anchor> [options].'
            : 'Replace-block failed: invalid format. Use !?@replace_block <path> <start_anchor> <end_anchor> [options].',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@replace_block'.length).trim();
    const args = splitCommandArgs(afterToolName);
    const filePath = args[0] ?? '';
    const startAnchor = args[1] ?? '';
    const endAnchor = args[2] ?? '';
    const optTokens = args.slice(3);

    if (!filePath || !startAnchor || !endAnchor) {
      const content = formatYamlCodeBlock(
        `status: error\nmode: replace_block\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Replace-block failed: path, start_anchor, and end_anchor are required.'
            : 'Replace-block failed: path, start_anchor, and end_anchor are required.',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTellaskResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (inputBody === '') {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: replace_block`,
          `error: CONTENT_REQUIRED`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? 'Replace-block failed: content is required in the body.'
              : 'Replace-block failed: content is required in the body.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;
    let includeAnchors = true;
    for (const tok of optTokens) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (key === 'occurrence') {
        const parsed = parseOccurrence(value);
        if (parsed) {
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else if (key === 'include_anchors') {
        const parsed = parseBooleanOption(value);
        if (parsed !== undefined) includeAnchors = parsed;
      }
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);
      if (!fsSync.existsSync(fullPath)) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: replace_block`,
            `error: FILE_NOT_FOUND`,
            `summary: ${yamlQuote('Replace-block failed: file does not exist.')}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const existing = fsSync.readFileSync(fullPath, 'utf8');
      const addedLeadingNewlineToFile = existing !== '' && !existing.endsWith('\n');
      const lines = splitTextToLinesForEditing(existing);

      const startMatches: number[] = [];
      const endMatches: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.includes(startAnchor)) startMatches.push(i);
        if (line.includes(endAnchor)) endMatches.push(i);
      }

      const pairs: Array<{ start0: number; end0: number }> = [];
      for (const start0 of startMatches) {
        const end0 = endMatches.find((e) => e > start0);
        if (end0 !== undefined) pairs.push({ start0, end0 });
      }

      if (!occurrenceSpecified && pairs.length !== 1) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: replace_block`,
            `start_anchor: ${yamlQuote(startAnchor)}`,
            `end_anchor: ${yamlQuote(endAnchor)}`,
            `error: AMBIGUOUS_BLOCK`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Replace-block failed: ambiguous anchors (0 or multiple possible blocks). Use plan/apply_file_modification.'
                : 'Replace-block failed: ambiguous anchors (0 or multiple possible blocks). Use plan/apply_file_modification.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      if (pairs.length === 0) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: replace_block`,
            `start_anchor: ${yamlQuote(startAnchor)}`,
            `end_anchor: ${yamlQuote(endAnchor)}`,
            `error: ANCHOR_NOT_FOUND`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Replace-block failed: anchors not found or not paired. Use plan/apply_file_modification.'
                : 'Replace-block failed: anchors not found or not paired. Use plan/apply_file_modification.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const selected =
        occurrence.kind === 'last' ? pairs[pairs.length - 1] : pairs[occurrence.index1 - 1];
      if (!selected) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: replace_block`,
            `error: OCCURRENCE_OUT_OF_RANGE`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Replace-block failed: occurrence out of range.'
                : 'Replace-block failed: occurrence out of range.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const nestedStart = startMatches.some((s) => s > selected.start0 && s < selected.end0);
      if (nestedStart) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `path: ${yamlQuote(filePath)}`,
            `mode: replace_block`,
            `error: NESTED_ANCHORS`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? 'Replace-block failed: nested/ambiguous anchors detected. Use plan/apply_file_modification.'
                : 'Replace-block failed: nested/ambiguous anchors detected. Use plan/apply_file_modification.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const occurrenceResolved = occurrence.kind === 'last' ? 'last' : String(occurrence.index1);
      const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
      const replacementLines = splitPlannedBodyLines(normalizedBody);

      const replaceStart0 = includeAnchors ? selected.start0 + 1 : selected.start0;
      const replaceDeleteCount = includeAnchors
        ? Math.max(0, selected.end0 - selected.start0 - 1)
        : selected.end0 - selected.start0 + 1;

      const oldCountInBlock = replaceDeleteCount;
      const newCountInBlock = replacementLines.length;
      const deltaLines = newCountInBlock - oldCountInBlock;

      const outLines = [...lines];
      outLines.splice(replaceStart0, replaceDeleteCount, ...replacementLines);
      const out = joinLinesForTextWrite(outLines);
      fsSync.writeFileSync(fullPath, out, 'utf8');

      const replacedRangeStartLine = selected.start0 + 1;
      const replacedRangeEndLine = selected.end0 + 1;

      const rangePreview = buildRangePreview(replacementLines);
      const summary =
        language === 'zh'
          ? `Replace-block：第 ${replacedRangeStartLine}–${replacedRangeEndLine} 行；${oldCountInBlock} → ${newCountInBlock} 行；anchors ${includeAnchors ? 'preserved' : 'replaced'}。`
          : `Replace-block: lines ${replacedRangeStartLine}–${replacedRangeEndLine}; ${oldCountInBlock} → ${newCountInBlock} lines; anchors ${includeAnchors ? 'preserved' : 'replaced'}.`;

      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(filePath)}`,
        `mode: replace_block`,
        `start_anchor: ${yamlQuote(startAnchor)}`,
        `end_anchor: ${yamlQuote(endAnchor)}`,
        `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
        `replaced_range:`,
        `  start_line: ${replacedRangeStartLine}`,
        `  end_line: ${replacedRangeEndLine}`,
        `old_line_count_in_block: ${oldCountInBlock}`,
        `new_line_count_in_block: ${newCountInBlock}`,
        `delta_lines: ${deltaLines}`,
        `normalized:`,
        `  added_leading_newline_to_file: ${addedLeadingNewlineToFile}`,
        `  added_trailing_newline_to_content: ${addedTrailingNewlineToContent}`,
        `evidence_preview:`,
        `  before_preview: ${yamlFlowStringArray([lines[selected.start0] ?? ''])}`,
        `  range_preview: ${yamlFlowStringArray(rangePreview)}`,
        `  after_preview: ${yamlFlowStringArray([lines[selected.end0] ?? ''])}`,
        `summary: ${yamlQuote(summary)}`,
      ].join('\n');

      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: replace_block`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
