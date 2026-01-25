/**
 * Module: tools/txt
 *
 * Text file tooling for reading and modifying workspace files.
 * Provides `read_file`, `overwrite_entire_file`, `preview_file_modification`, and `apply_file_modification`.
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
import type { FuncTool, ToolArguments } from '../tool';

type ToolCaller = Parameters<FuncTool['call']>[1];

type TxtToolCallResult = {
  status: 'completed' | 'failed';
  result: string;
  messages?: ChatMessage[];
};

function wrapTxtToolResult(language: LanguageCode, messages: ChatMessage[]): TxtToolCallResult {
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

function ok(result: string, messages?: ChatMessage[]): TxtToolCallResult {
  return { status: 'completed', result, messages };
}

function failed(result: string, messages?: ChatMessage[]): TxtToolCallResult {
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

function detectStrongDiffOrPatchMarkers(text: string): boolean {
  // Intentionally "strong-feature only" to avoid false positives on common Markdown patterns
  // like list bullets (`- foo`) or front matter delimiters (`---`).
  if (/^diff --git\s/m.test(text)) return true;
  if (/^\*\*\* Begin Patch\s*$/m.test(text)) return true;
  if (/^@@.*@@/m.test(text)) return true;
  const hasHeaderOld = /^---\s+\S+/m.test(text);
  const hasHeaderNew = /^\+\+\+\s+\S+/m.test(text);
  return hasHeaderOld && hasHeaderNew;
}

function requireNonEmptyStringArg(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid arguments: \`${key}\` must be a non-empty string`);
  }
  return value;
}

function optionalStringArg(args: ToolArguments, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid arguments: \`${key}\` must be a string`);
  return value;
}

function optionalBooleanArg(args: ToolArguments, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new Error(`Invalid arguments: \`${key}\` must be a boolean`);
  return value;
}

function optionalIntegerArg(args: ToolArguments, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid arguments: \`${key}\` must be an integer`);
  }
  return value;
}

function optionalNonEmptyStringArg(args: ToolArguments, key: string): string | undefined {
  const value = optionalStringArg(args, key);
  if (value === undefined) return undefined;
  if (value.trim() === '') return undefined;
  return value;
}

function normalizeExistingHunkId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const id = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  if (id === '') return undefined;
  return id;
}

function unwrapTxtToolResult(res: TxtToolCallResult): string {
  return res.result;
}

async function countFileLinesUtf8(absPath: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(absPath, { encoding: 'utf8' });
    let newlineCount = 0;
    let sawAny = false;
    let lastChar = '';
    stream.on('error', (err: unknown) => reject(err));
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.length === 0) return;
      sawAny = true;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') newlineCount += 1;
      }
      lastChar = text[text.length - 1] ?? '';
    });
    stream.on('end', () => {
      if (!sawAny) return resolve(0);
      if (lastChar === '\n') return resolve(newlineCount);
      return resolve(newlineCount + 1);
    });
  });
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

function sha256HexUtf8(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function countLeadingBlankLines(lines: ReadonlyArray<string>): number {
  let count = 0;
  for (const line of lines) {
    if (line === '') count += 1;
    else break;
  }
  return count;
}

function countTrailingBlankLines(lines: ReadonlyArray<string>): number {
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line === '') count += 1;
    else break;
  }
  return count;
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

type PlannedRangeAction = 'replace' | 'append' | 'delete';

type PlannedRangeModification = {
  readonly kind: 'range';
  readonly action: PlannedRangeAction;
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
  // Present when action='append'. Used to detect drift between plan and apply.
  readonly plannedFileDigestSha256?: string;
};

type AnchorMatchMode = 'contains' | 'equals';

type FileEofNewlineNormalization = {
  readonly fileEofHasNewline: boolean;
  readonly contentEofHasNewline: boolean;
  readonly normalizedFileEofNewlineAdded: boolean;
  readonly normalizedContentEofNewlineAdded: boolean;
};

type PlannedAppendModification = {
  readonly kind: 'append';
  readonly hunkId: string;
  readonly plannedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly relPath: string;
  readonly absPath: string;
  readonly allowCreate: boolean;
  readonly plannedFileDigestSha256: string;
  readonly newLines: ReadonlyArray<string>;
  readonly unifiedDiff: string;
  readonly normalized: FileEofNewlineNormalization;
};

type PlannedInsertion = {
  readonly position: 'before' | 'after';
  readonly anchor: string;
  readonly match: AnchorMatchMode;
  readonly strict: boolean;
  readonly occurrenceResolved: string;
  readonly anchorLineText: string;
  readonly fallback: 'none' | 'append';
};

type PlannedInsertionModification = {
  readonly kind: 'insert';
  readonly action: 'insert';
  readonly hunkId: string;
  readonly plannedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly relPath: string;
  readonly absPath: string;
  readonly startIndex0: number;
  readonly deleteCount: number;
  readonly contextBefore: ReadonlyArray<string>;
  readonly contextAfter: ReadonlyArray<string>;
  readonly oldLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
  readonly unifiedDiff: string;
  readonly insertion: PlannedInsertion;
  readonly plannedFileDigestSha256?: string;
};

type PlannedFileModification =
  | PlannedRangeModification
  | PlannedAppendModification
  | PlannedInsertionModification;

type PlannedBlockReplace = {
  readonly hunkId: string;
  readonly plannedBy: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly relPath: string;
  readonly absPath: string;
  readonly startAnchor: string;
  readonly endAnchor: string;
  readonly match: AnchorMatchMode;
  readonly includeAnchors: boolean;
  readonly requireUnique: boolean;
  readonly strict: boolean;
  readonly occurrence: Occurrence;
  readonly occurrenceSpecified: boolean;
  readonly selectedStart0: number;
  readonly selectedEnd0: number;
  readonly replaceStart0: number;
  readonly deleteCount: number;
  readonly oldLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
  readonly unifiedDiff: string;
  readonly normalized: FileEofNewlineNormalization;
};

const PLANNED_MOD_TTL_MS = 60 * 60 * 1000; // ~1 hour
const plannedModsById = new Map<string, PlannedFileModification>();
const plannedBlockReplacesById = new Map<string, PlannedBlockReplace>();

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

function pruneExpiredPlannedBlockReplaces(nowMs: number): void {
  for (const [id, mod] of plannedBlockReplacesById.entries()) {
    if (mod.expiresAtMs <= nowMs) plannedBlockReplacesById.delete(id);
  }
}

function generateHunkId(): string {
  // Short, URL-safe, command-friendly id
  return crypto.randomBytes(4).toString('hex');
}

function isValidHunkId(id: string): boolean {
  return /^[a-z0-9_-]{2,32}$/i.test(id);
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

export const readFileTool = {
  type: 'func',
  name: 'read_file',
  description: 'Read a text file (bounded) relative to workspace.',
  descriptionI18n: {
    en: 'Read a text file (bounded) relative to workspace.',
    zh: '读取工作区内的文本文件（有上限/可截断）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      range: {
        type: 'string',
        description:
          "Optional line range string: '10~50' | '300~' | '~20' | '~' (1-based, inclusive).",
      },
      max_lines: { type: 'integer', description: 'Max lines to show (default: 500).' },
      show_linenos: {
        type: 'boolean',
        description: 'Whether to show line numbers (default: true).',
      },
    },
    required: ['path'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args: ToolArguments): Promise<string> => {
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
          '请使用正确的函数工具参数调用 `read_file`。\n\n' +
          '**期望格式：** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          '说明（Codex provider 要求函数工具参数字段全部 `required`）：\n' +
          '- `range: \"\"` 表示不指定范围\n' +
          '- `max_lines: 0` 表示使用默认值（500）\n\n' +
          '**示例：**\n```text\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"300~\", \"max_lines\": 800, \"show_linenos\": false }\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **错误：** ${msg}\n\n` +
          '请使用正确的函数工具参数调用 `read_file`。\n\n' +
          '**期望格式：** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          '说明（Codex provider 要求函数工具参数字段全部 `required`）：\n' +
          '- `range: \"\"` 表示不指定范围\n' +
          '- `max_lines: 0` 表示使用默认值（500）\n\n' +
          '**示例：**\n```text\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"300~\", \"max_lines\": 800, \"show_linenos\": false }\n```',
        fileLabel: '文件',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **警告：** 输出已截断（最多显示 ${maxLines} 行，当前显示 ${shown} 行）\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **警告：** 输出已截断（字符总数上限约 ${maxChars}，当前显示 ${shown} 行）\n\n`,
        warningMaxLinesRangeMismatch: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **警告：** \`max_lines\`（${maxLines}）与 \`range\`（共 ${rangeLines} 行）不一致，将按更小值 ${used} 处理。\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **提示：** 可继续调用 \`read_file\` 读取下一段，例如：\`read_file({ \"path\": \"${relPath}\", \"range\": \"${start}~${end}\", \"max_lines\": 0, \"show_linenos\": true })\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **大文件策略：** 建议分多轮分析：每轮读取一段、完成总结后，在新一轮先调用函数工具 \`clear_mind({ \"reminder_content\": \"\" })\`（降低上下文占用），再继续读取下一段（例如：\`read_file({ \"path\": \"${relPath}\", \"range\": \"1~500\", \"max_lines\": 0, \"show_linenos\": true })\`、\`read_file({ \"path\": \"${relPath}\", \"range\": \"201~400\", \"max_lines\": 0, \"show_linenos\": true })\`）。\n\n`,
        sizeLabel: '大小',
        totalLinesLabel: '总行数',
        failedToRead: (msg: string) => `❌ **错误**\n\n读取文件失败：${msg}`,
        invalidFormatMultiToolCalls: (toolName: string) =>
          `INVALID_FORMAT：检测到疑似把多个工具调用文本混入了 \`read_file\` 的输入（例如出现 \`${toolName}\`）。\n\n` +
          '请把不同工具拆分为独立调用（不要把 `@ripgrep_*` 等调用文本拼接到 `path/range` 里）。',
      };
    } else {
      labels = {
        formatError:
          'Please call the function tool `read_file` with valid arguments.\n\n' +
          '**Expected:** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          'Note (Codex provider requires all args to be `required`):\n' +
          '- use `range: \"\"` for unset\n' +
          '- use `max_lines: 0` for default (500)\n\n' +
          '**Examples:**\n```text\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"300~\", \"max_lines\": 800, \"show_linenos\": false }\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **Error:** ${msg}\n\n` +
          'Please call the function tool `read_file` with valid arguments.\n\n' +
          '**Expected:** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          'Note (Codex provider requires all args to be `required`):\n' +
          '- use `range: \"\"` for unset\n' +
          '- use `max_lines: 0` for default (500)\n\n' +
          '**Examples:**\n```text\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\", \"max_lines\": 0, \"show_linenos\": true }\n{ \"path\": \"src/main.ts\", \"range\": \"300~\", \"max_lines\": 800, \"show_linenos\": false }\n```',
        fileLabel: 'File',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **Warning:** Output was truncated (max ${maxLines} lines; showing ${shown})\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **Warning:** Output was truncated (~${maxChars} character cap; showing ${shown} lines)\n\n`,
        warningMaxLinesRangeMismatch: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **Warning:** \`max_lines\` (${maxLines}) contradicts \`range\` (${rangeLines} lines); using the smaller limit (${used}).\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **Hint:** Call \`read_file\` again to continue reading, e.g. \`read_file({ \"path\": \"${relPath}\", \"range\": \"${start}~${end}\", \"max_lines\": 0, \"show_linenos\": true })\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **Large file strategy:** Analyze in multiple rounds: each round read a slice, summarize, then start a new round and call the function tool \`clear_mind({ \"reminder_content\": \"\" })\` (less context) before reading the next slice (e.g. \`read_file({ \"path\": \"${relPath}\", \"range\": \"1~500\", \"max_lines\": 0, \"show_linenos\": true })\`, then \`read_file({ \"path\": \"${relPath}\", \"range\": \"201~400\", \"max_lines\": 0, \"show_linenos\": true })\`).\n\n`,
        sizeLabel: 'Size',
        totalLinesLabel: 'Total lines',
        failedToRead: (msg: string) => `❌ **Error**\n\nFailed to read file: ${msg}`,
        invalidFormatMultiToolCalls: (toolName: string) =>
          `INVALID_FORMAT: Detected what looks like tool-call text mixed into \`read_file\` input (e.g. \`${toolName}\`).\n\n` +
          'Split different tools into separate calls (do not paste `@ripgrep_*` or other tool-call text into `path/range`).',
      };
    }

    // labels is always set above
    if (!labels) {
      throw new Error('Failed to initialize labels');
    }

    const errorMsg = (zh: string, en: string): string => (language === 'zh' ? zh : en);

    const pathValue = args['path'];
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      return labels.formatError;
    }
    const rel = pathValue.trim();

    const showLinenosValue = args['show_linenos'];
    const showLinenos =
      showLinenosValue === undefined
        ? true
        : typeof showLinenosValue === 'boolean'
          ? showLinenosValue
          : null;
    if (showLinenos === null) {
      return labels.formatErrorWithReason(
        errorMsg('`show_linenos` 必须是 boolean', '`show_linenos` must be a boolean'),
      );
    }

    const maxLinesValue = args['max_lines'];
    const maxLinesSpecified = maxLinesValue !== undefined && maxLinesValue !== 0;
    const maxLines =
      maxLinesValue === undefined || maxLinesValue === 0
        ? 500
        : typeof maxLinesValue === 'number' && Number.isInteger(maxLinesValue) && maxLinesValue > 0
          ? maxLinesValue
          : null;
    if (maxLines === null) {
      return labels.formatErrorWithReason(
        errorMsg(
          '`max_lines` 必须是正整数（或传 0 表示默认值）',
          '`max_lines` must be a positive integer (or 0 for default)',
        ),
      );
    }

    const rangeValue = args['range'];
    const rangeStr =
      rangeValue === undefined ? '' : typeof rangeValue === 'string' ? rangeValue.trim() : null;
    if (rangeStr === null) {
      return labels.formatErrorWithReason(
        errorMsg(
          '`range` 必须是 string（传 \"\" 表示不指定）',
          '`range` must be a string (use "" for unset)',
        ),
      );
    }
    const rangeSpecified = rangeStr !== '';

    const detectMultiToolCalls = (input: string): string | null => {
      const trimmed = input.trimEnd();
      const lines = trimmed.split(/\r?\n/);
      if (lines.length <= 1) return null;
      const suspicious = lines.slice(1).find((l) => l.trimStart().startsWith('@'));
      if (!suspicious) return null;
      return suspicious.trimStart().split(/\s+/)[0] ?? null;
    };

    const suspiciousTool =
      detectMultiToolCalls(rel) ?? (rangeSpecified ? detectMultiToolCalls(rangeStr) : null);
    if (suspiciousTool) {
      return labels.invalidFormatMultiToolCalls(suspiciousTool);
    }

    const options: ReadFileOptions = { decorateLinenos: showLinenos, maxLines };
    if (rangeSpecified) {
      const match = rangeStr.match(/^(\d+)?~(\d+)?$/);
      if (!match) {
        return labels.formatErrorWithReason(
          errorMsg(
            '`range` 无效（期望：\"start~end\" / \"start~\" / \"~end\" / \"~\"）',
            'Invalid `range` (expected "start~end" / "start~" / "~end" / "~")',
          ),
        );
      }
      const [, startStr, endStr] = match;
      if (startStr) {
        const start = Number.parseInt(startStr, 10);
        if (!Number.isFinite(start) || start <= 0) {
          return labels.formatErrorWithReason(
            errorMsg(
              '`range` 起始行号无效（必须是正整数）',
              'Invalid `range` start (must be a positive integer)',
            ),
          );
        }
        options.rangeStart = start;
      }
      if (endStr) {
        const end = Number.parseInt(endStr, 10);
        if (!Number.isFinite(end) || end <= 0) {
          return labels.formatErrorWithReason(
            errorMsg(
              '`range` 结束行号无效（必须是正整数）',
              'Invalid `range` end (must be a positive integer)',
            ),
          );
        }
        options.rangeEnd = end;
      }
      if (
        options.rangeStart !== undefined &&
        options.rangeEnd !== undefined &&
        options.rangeStart > options.rangeEnd
      ) {
        return labels.formatErrorWithReason(
          errorMsg('`range` 无效（start 必须 <= end）', 'Invalid `range` (start must be <= end)'),
        );
      }
    }

    const flags = { maxLinesSpecified, rangeSpecified };

    try {
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
        return content;
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

      return markdown;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message === 'Invalid format' || error.message === 'Path required')
      ) {
        const content = labels.formatError;
        return content;
      }

      const msg = error instanceof Error ? error.message : String(error);
      const content = labels.failedToRead(msg);
      return content;
    }
  },
} satisfies FuncTool;

type OverwriteContentFormat = 'text' | 'markdown' | 'json' | 'diff' | 'patch';

const overwriteEntireFileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'Workspace-relative path to an existing file to overwrite.',
    },
    known_old_total_lines: {
      type: 'integer',
      description:
        'Expected old total line count of the file (0 for empty). Used as an overwrite guardrail.',
    },
    known_old_total_bytes: {
      type: 'integer',
      description:
        'Expected old total bytes of the file as reported by stat().size. Used as an overwrite guardrail.',
    },
    content: {
      type: 'string',
      description:
        'The new full file content. If non-empty and missing a trailing newline, Dominds will append one.',
    },
    content_format: {
      type: 'string',
      description:
        "Optional content format hint. If omitted (or empty string), Dominds refuses to overwrite when content looks like a diff/patch (use preview/apply instead). Use 'diff' or 'patch' to explicitly allow writing diff/patch text literally.",
    },
  },
  required: ['path', 'known_old_total_lines', 'known_old_total_bytes', 'content'],
} as const;

function parseOverwriteContentFormat(value: unknown): OverwriteContentFormat | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.trim() === '') return undefined;
  switch (value) {
    case 'text':
    case 'markdown':
    case 'json':
    case 'diff':
    case 'patch':
      return value;
    default:
      return undefined;
  }
}

function parseOverwriteEntireFileArgs(args: ToolArguments): {
  path: string;
  knownOldTotalLines: number;
  knownOldTotalBytes: number;
  content: string;
  contentFormat: OverwriteContentFormat | undefined;
} {
  const pathValue = args['path'];
  if (typeof pathValue !== 'string' || pathValue.trim() === '') {
    throw new Error('Invalid `path` (expected non-empty string)');
  }

  const knownOldTotalLinesValue = args['known_old_total_lines'];
  if (typeof knownOldTotalLinesValue !== 'number' || !Number.isInteger(knownOldTotalLinesValue)) {
    throw new Error('Invalid `known_old_total_lines` (expected integer)');
  }
  if (knownOldTotalLinesValue < 0) {
    throw new Error('Invalid `known_old_total_lines` (must be >= 0)');
  }

  const knownOldTotalBytesValue = args['known_old_total_bytes'];
  if (typeof knownOldTotalBytesValue !== 'number' || !Number.isInteger(knownOldTotalBytesValue)) {
    throw new Error('Invalid `known_old_total_bytes` (expected integer)');
  }
  if (knownOldTotalBytesValue < 0) {
    throw new Error('Invalid `known_old_total_bytes` (must be >= 0)');
  }

  const contentValue = args['content'];
  if (typeof contentValue !== 'string') {
    throw new Error('Invalid `content` (expected string)');
  }

  const rawContentFormat = args['content_format'];
  let contentFormat: OverwriteContentFormat | undefined;
  if (rawContentFormat === undefined) {
    contentFormat = undefined;
  } else if (typeof rawContentFormat === 'string') {
    if (rawContentFormat.trim() === '') {
      contentFormat = undefined;
    } else {
      contentFormat = parseOverwriteContentFormat(rawContentFormat);
      if (contentFormat === undefined) {
        throw new Error(
          'Invalid `content_format` (expected one of: text, markdown, json, diff, patch)',
        );
      }
    }
  } else {
    throw new Error('Invalid `content_format` (expected string)');
  }

  return {
    path: pathValue,
    knownOldTotalLines: knownOldTotalLinesValue,
    knownOldTotalBytes: knownOldTotalBytesValue,
    content: contentValue,
    contentFormat,
  };
}

export const overwriteEntireFileTool: FuncTool = {
  type: 'func',
  name: 'overwrite_entire_file',
  description:
    'Overwrite an existing file with new full content (guarded by known_old_total_lines/bytes; refuses diff/patch-like content unless content_format is diff|patch).',
  descriptionI18n: {
    en: 'Overwrite an existing file with new full content (guarded by known_old_total_lines/bytes; refuses diff/patch-like content unless content_format is diff|patch).',
    zh: '整体覆盖写入一个已存在的文件（需要 known_old_total_lines/bytes 对账；若正文疑似 diff/patch 且未显式声明 content_format=diff|patch，则默认拒绝）。',
  },
  parameters: overwriteEntireFileSchema,
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            fileNotFound: (p: string) =>
              `错误：文件不存在：\`${p}\`。创建文件请使用 preview/apply（例如 preview_file_append create=true）。`,
            notAFile: (p: string) => `错误：路径不是文件：\`${p}\`。`,
            statsMismatch: (
              p: string,
              knownLines: number,
              knownBytes: number,
              actualLines: number,
              actualBytes: number,
            ) =>
              `错误：旧文件快照不匹配，拒绝覆盖写入：\`${p}\`。\n` +
              `- known_old_total_lines: ${knownLines}\n` +
              `- known_old_total_bytes: ${knownBytes}\n` +
              `- actual_old_total_lines: ${actualLines}\n` +
              `- actual_old_total_bytes: ${actualBytes}\n` +
              `下一步：先 read_file / list_dir 获取最新状态，再重试。`,
            suspiciousDiff:
              '错误：检测到疑似 diff/patch 正文，且未显式声明 `content_format`。\n' +
              '为避免把 patch 文本误写进文件，默认拒绝。\n' +
              '下一步：改用 preview_* → apply_file_modification；或若你确实要保存 diff/patch 字面量，请设置 content_format=diff|patch。',
            ok: (p: string, normalized: boolean, newLines: number, newBytes: number) =>
              `✅ 已覆盖写入：\`${p}\`\n` +
              `- new_total_lines: ${newLines}\n` +
              `- new_total_bytes: ${newBytes}\n` +
              (normalized ? '- normalized: added trailing newline\n' : ''),
          }
        : {
            fileNotFound: (p: string) =>
              `Error: file not found: \`${p}\`. To create a file, use preview/apply (e.g. preview_file_append create=true).`,
            notAFile: (p: string) => `Error: path is not a file: \`${p}\`.`,
            statsMismatch: (
              p: string,
              knownLines: number,
              knownBytes: number,
              actualLines: number,
              actualBytes: number,
            ) =>
              `Error: known_old_stats mismatch; refusing to overwrite: \`${p}\`.\n` +
              `- known_old_total_lines: ${knownLines}\n` +
              `- known_old_total_bytes: ${knownBytes}\n` +
              `- actual_old_total_lines: ${actualLines}\n` +
              `- actual_old_total_bytes: ${actualBytes}\n` +
              `Next: read_file / list_dir to refresh stats, then retry.`,
            suspiciousDiff:
              'Error: content looks like a diff/patch, but `content_format` was not provided.\n' +
              'To avoid accidentally overwriting a file with patch text, this call is rejected by default.\n' +
              "Next: use preview_* → apply_file_modification; or if you intentionally want to store diff/patch text literally, set content_format='diff'|'patch'.",
            ok: (p: string, normalized: boolean, newLines: number, newBytes: number) =>
              `ok: overwrote \`${p}\`\n` +
              `new_total_lines: ${newLines}\n` +
              `new_total_bytes: ${newBytes}\n` +
              (normalized ? 'normalized: added trailing newline\n' : ''),
          };

    const parsed = parseOverwriteEntireFileArgs(args);

    if (!hasWriteAccess(caller, parsed.path)) {
      return getAccessDeniedMessage('write', parsed.path, language);
    }

    let absPath: string;
    try {
      absPath = ensureInsideWorkspace(parsed.path);
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }

    let s: fsSync.Stats;
    try {
      s = fsSync.statSync(absPath);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return labels.fileNotFound(parsed.path);
      }
      return err instanceof Error ? err.message : String(err);
    }
    if (!s.isFile()) return labels.notAFile(parsed.path);

    const actualOldTotalBytes = s.size;
    let actualOldTotalLines: number;
    try {
      actualOldTotalLines = await countFileLinesUtf8(absPath);
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }

    if (
      parsed.knownOldTotalBytes !== actualOldTotalBytes ||
      parsed.knownOldTotalLines !== actualOldTotalLines
    ) {
      return labels.statsMismatch(
        parsed.path,
        parsed.knownOldTotalLines,
        parsed.knownOldTotalBytes,
        actualOldTotalLines,
        actualOldTotalBytes,
      );
    }

    if (parsed.contentFormat !== 'diff' && parsed.contentFormat !== 'patch') {
      // Only refuse when content_format is omitted (or a non-diff format), and content is strongly diff-like.
      if (detectStrongDiffOrPatchMarkers(parsed.content)) {
        return labels.suspiciousDiff;
      }
    }

    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(
      parsed.content,
    );
    try {
      await fs.writeFile(absPath, normalizedBody, 'utf8');
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }

    const newTotalBytes = Buffer.byteLength(normalizedBody, 'utf8');
    const newTotalLines = splitTextToLinesForEditing(normalizedBody).length;
    return labels
      .ok(
        parsed.path,
        addedTrailingNewlineToContent && normalizedBody !== '',
        newTotalLines,
        newTotalBytes,
      )
      .trimEnd();
  },
};

async function runPreviewFileModification(
  caller: ToolCaller,
  filePath: string,
  rangeSpec: string,
  requestedId: string | undefined,
  inputBody: string,
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const labels =
    language === 'zh'
      ? {
          invalidFormat:
            '错误：参数不正确。\n\n期望：调用函数工具 `preview_file_modification({ path, range, existing_hunk_id, content })`。\n（Codex provider 要求参数字段全部 required：`existing_hunk_id: \"\"` 表示生成新 hunk；`content: \"\"` 可用于删除范围内内容。）',
          filePathRequired: '错误：需要提供文件路径。',
          rangeRequired: '错误：需要提供行号范围（例如 10~20 或 ~）。',
          fileDoesNotExist: (p: string) => `错误：文件 \`${p}\` 不存在。`,
          planned: (id: string, p: string) => `✅ 已规划：\`${id}\` → \`${p}\``,
          next: (id: string) =>
            `下一步：调用函数工具 \`apply_file_modification\`，参数：{ \"hunk_id\": \"${id}\" }`,
          invalidHunkId: '错误：hunk id 格式无效（例如 `a1b2c3d4`）。',
          unknownHunkId: (id: string) =>
            `错误：hunk id \`${id}\` 不存在（可能已过期/已被应用）。不支持自定义新 id；要生成新 id，请将 \`existing_hunk_id\` 设为空字符串。`,
          wrongOwner: (id: string) => `错误：hunk id \`${id}\` 不是由当前成员规划的，不能覆写。`,
          planFailed: (msg: string) => `错误：生成修改规划失败：${msg}`,
        }
      : {
          invalidFormat:
            'Error: Invalid args.\n\nExpected: call the function tool `preview_file_modification({ path, range, existing_hunk_id, content })`.\n(Codex provider requires all args to be required: `existing_hunk_id: \"\"` means generate a new hunk; `content: \"\"` can be used to delete the range.)',
          filePathRequired: 'Error: File path is required.',
          rangeRequired: 'Error: Line range is required (e.g. 10~20 or ~).',
          fileDoesNotExist: (p: string) => `Error: File \`${p}\` does not exist.`,
          planned: (id: string, p: string) => `✅ Planned \`${id}\` for \`${p}\``,
          next: (id: string) =>
            `Next: call function tool \`apply_file_modification\` with { \"hunk_id\": \"${id}\" }.`,
          invalidHunkId: 'Error: invalid hunk id format (e.g. `a1b2c3d4`).',
          unknownHunkId: (id: string) =>
            `Error: hunk id \`${id}\` not found (expired or already applied). Custom new ids are not allowed; set \`existing_hunk_id\` to an empty string to generate a new one.`,
          wrongOwner: (id: string) =>
            `Error: hunk id \`${id}\` was planned by a different member; cannot overwrite.`,
          planFailed: (msg: string) => `Error planning modification: ${msg}`,
        };

  if (!filePath) {
    const content = labels.filePathRequired;
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (!rangeSpec) {
    const content = labels.rangeRequired;
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (requestedId !== undefined && !isValidHunkId(requestedId)) {
    const content = labels.invalidHunkId;
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }

  // Check write access
  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }

  try {
    pruneExpiredPlannedMods(Date.now());
    pruneExpiredPlannedBlockReplaces(Date.now());
    const fullPath = ensureInsideWorkspace(filePath);
    if (requestedId) {
      const existing = plannedModsById.get(requestedId);
      if (!existing) {
        const content = labels.unknownHunkId(requestedId);
        return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.plannedBy !== caller.id) {
        const content = labels.wrongOwner(requestedId);
        return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.kind !== 'range') {
        const content =
          language === 'zh'
            ? `错误：hunk id \`${requestedId}\` 不是由 preview_file_modification 生成的，不能用该工具覆写。`
            : `Error: hunk id \`${requestedId}\` was not generated by preview_file_modification; cannot overwrite with this tool.`;
        return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
    }

    // Check if file exists
    if (!fsSync.existsSync(fullPath)) {
      const content = labels.fileDoesNotExist(filePath);
      return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
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
      return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
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
    const action: PlannedRangeAction =
      range.kind === 'append' ? 'append' : newLines.length === 0 ? 'delete' : 'replace';

    const hunkId = (() => {
      if (requestedId) return requestedId;
      for (let i = 0; i < 10; i += 1) {
        const id = generateHunkId();
        if (!plannedModsById.has(id) && !plannedBlockReplacesById.has(id)) return id;
      }
      throw new Error('Failed to generate a unique hunk id');
    })();
    const planned: PlannedRangeModification = {
      kind: 'range',
      action,
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
      plannedFileDigestSha256: action === 'append' ? sha256HexUtf8(currentContent) : undefined,
    };
    plannedModsById.set(hunkId, planned);

    const rangeLabel =
      range.kind === 'append' ? `${range.startLine}~` : `${range.startLine}~${range.endLine}`;

    const reviseHint =
      language === 'zh'
        ? `（可选：用同一工具重新规划并覆写该 hunk：\`preview_file_modification({ \"path\": \"${filePath}\", \"range\": \"${rangeSpec}\", \"existing_hunk_id\": \"${hunkId}\", \"content\": \"...\" })\`。）`
        : `Optional: revise by re-running the same tool to overwrite this hunk: \`preview_file_modification({ \"path\": \"${filePath}\", \"range\": \"${rangeSpec}\", \"existing_hunk_id\": \"${hunkId}\", \"content\": \"...\" })\`.`;

    const resolvedStart = range.kind === 'append' ? range.startLine : range.startLine;
    const resolvedEnd =
      range.kind === 'append' ? range.startLine + Math.max(0, newLines.length - 1) : range.endLine;

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

    const fileEofHasNewline = currentContent === '' || currentContent.endsWith('\n');
    const normalizedFileEofNewlineAdded = currentContent !== '' && !currentContent.endsWith('\n');
    const contentEofHasNewline = inputBody === '' || inputBody.endsWith('\n');
    const normalizedContentEofNewlineAdded = inputBody !== '' && !inputBody.endsWith('\n');

    const yaml = [
      `status: ok`,
      `mode: preview_file_modification`,
      `path: ${yamlQuote(filePath)}`,
      `hunk_id: ${yamlQuote(hunkId)}`,
      `expires_at_ms: ${planned.expiresAtMs}`,
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
      `normalized:`,
      `  file_eof_has_newline: ${fileEofHasNewline}`,
      `  content_eof_has_newline: ${contentEofHasNewline}`,
      `  normalized_file_eof_newline_added: ${normalizedFileEofNewlineAdded}`,
      `  normalized_content_eof_newline_added: ${normalizedContentEofNewlineAdded}`,
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
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

export const previewFileModificationTool: FuncTool = {
  type: 'func',
  name: 'preview_file_modification',
  description: 'Preview a single-file edit by line range (does not write).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      range: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'range'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const range = requireNonEmptyStringArg(args, 'range');
    const existingHunkId = normalizeExistingHunkId(
      optionalNonEmptyStringArg(args, 'existing_hunk_id'),
    );
    const content = optionalStringArg(args, 'content') ?? '';

    const requestedId = existingHunkId;
    if (requestedId !== undefined && !isValidHunkId(requestedId)) {
      throw new Error(
        "Invalid arguments: `existing_hunk_id` must be a hunk id like 'a1b2c3d4' (letters/digits/_/-)",
      );
    }

    const res = await runPreviewFileModification(caller, filePath, range, requestedId, content);
    return unwrapTxtToolResult(res);
  },
};

async function runPreviewFileAppend(
  caller: ToolCaller,
  filePath: string,
  inputBody: string,
  options: { create: boolean; requestedId: string | undefined },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  if (!filePath) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: preview_file_append`,
        `error: PATH_REQUIRED`,
        `summary: ${yamlQuote(
          language === 'zh' ? '需要提供文件路径。' : 'File path is required.',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (inputBody === '') {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: preview_file_append`,
        `path: ${yamlQuote(filePath)}`,
        `error: CONTENT_REQUIRED`,
        `summary: ${yamlQuote(
          language === 'zh' ? '正文不能为空（需要提供要追加的内容）。' : 'Content is required.',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  const create = options.create;
  const requestedId = options.requestedId;
  if (requestedId !== undefined && !isValidHunkId(requestedId)) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: preview_file_append`,
        `path: ${yamlQuote(filePath)}`,
        `error: INVALID_HUNK_ID`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? 'hunk id 格式无效（例如 `a1b2c3d4`）。'
            : 'Invalid hunk id (e.g. `a1b2c3d4`).',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  try {
    pruneExpiredPlannedMods(Date.now());
    pruneExpiredPlannedBlockReplaces(Date.now());

    const fullPath = ensureInsideWorkspace(filePath);
    if (requestedId) {
      const existing = plannedModsById.get(requestedId);
      if (!existing) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: preview_file_append`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: HUNK_NOT_FOUND`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk id 不存在（可能已过期/已被应用）。不支持自定义新 id；要生成新 id，请将 `existing_hunk_id` 设为空字符串。'
                : 'Hunk not found (expired or already applied). Custom new ids are not allowed; set `existing_hunk_id` to an empty string to generate a new one.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.plannedBy !== caller.id) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: preview_file_append`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: WRONG_OWNER`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk 不是由当前成员规划的，不能覆写。'
                : 'This hunk was planned by a different member; cannot overwrite.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.kind !== 'append') {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: preview_file_append`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: WRONG_MODE`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk id 不是由 preview_file_append 生成的，不能用该工具覆写。'
                : 'This hunk was not generated by preview_file_append; cannot overwrite.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
    }

    const fileExists = fsSync.existsSync(fullPath);
    if (!fileExists && !create) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: preview_file_append`,
          `path: ${yamlQuote(filePath)}`,
          `error: FILE_NOT_FOUND`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? '文件不存在（create=false），无法规划追加。'
              : 'File does not exist (create=false); cannot plan append.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const existingContent = fileExists ? fsSync.readFileSync(fullPath, 'utf8') : '';

    const fileEofHasNewline = existingContent === '' || existingContent.endsWith('\n');
    const normalizedFileEofNewlineAdded = existingContent !== '' && !existingContent.endsWith('\n');
    const existingNormalized = normalizedFileEofNewlineAdded
      ? `${existingContent}\n`
      : existingContent;

    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
    const contentEofHasNewline = inputBody.endsWith('\n');
    const normalizedContentEofNewlineAdded = addedTrailingNewlineToContent;

    const normalized: FileEofNewlineNormalization = {
      fileEofHasNewline,
      contentEofHasNewline,
      normalizedFileEofNewlineAdded,
      normalizedContentEofNewlineAdded,
    };

    const fileLinesBefore = splitTextToLinesForEditing(existingNormalized);
    const appendLines = splitPlannedBodyLines(normalizedBody);
    const plannedAfterLines = [...fileLinesBefore, ...appendLines];
    const unifiedDiff = buildUnifiedSingleHunkDiff(
      filePath,
      fileLinesBefore,
      fileLinesBefore.length,
      0,
      appendLines,
    );

    const fileLineCountBefore = countLogicalLines(existingContent);
    const fileLineCountAfter = countLogicalLines(`${existingNormalized}${normalizedBody}`);
    const appendedLineCount = countLogicalLines(normalizedBody);

    const fileTrailingBlankLineCount = countTrailingBlankLines(fileLinesBefore);
    const contentLeadingBlankLineCount = countLeadingBlankLines(appendLines);
    const styleWarning =
      fileTrailingBlankLineCount > 0 && contentLeadingBlankLineCount > 0
        ? language === 'zh'
          ? '注意：文件末尾已有空行且追加内容以空行开头，可能产生多余空行。'
          : 'Warning: file already ends with blank line(s) and appended content starts with blank line(s); you may get extra blank lines.'
        : '';

    const evidenceBeforeTail = fileLinesBefore.slice(Math.max(0, fileLinesBefore.length - 2));
    const evidenceAppendPreview = appendLines.length <= 2 ? appendLines : appendLines.slice(0, 2);
    const evidenceAfterTail = plannedAfterLines.slice(Math.max(0, plannedAfterLines.length - 2));

    const nowMs = Date.now();
    const hunkId = (() => {
      if (requestedId) return requestedId;
      for (let i = 0; i < 10; i += 1) {
        const id = generateHunkId();
        if (!plannedModsById.has(id) && !plannedBlockReplacesById.has(id)) return id;
      }
      throw new Error('Failed to generate a unique hunk id');
    })();

    const planned: PlannedAppendModification = {
      kind: 'append',
      hunkId,
      plannedBy: caller.id,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PLANNED_MOD_TTL_MS,
      relPath: filePath,
      absPath: fullPath,
      allowCreate: create,
      plannedFileDigestSha256: sha256HexUtf8(existingContent),
      newLines: appendLines,
      unifiedDiff,
      normalized,
    };
    plannedModsById.set(hunkId, planned);

    const summary =
      language === 'zh'
        ? `Plan-append：+${appendedLineCount} 行；file ${fileLineCountBefore} → ${fileLineCountAfter}；hunk_id=${hunkId}.`
        : `Plan-append: +${appendedLineCount} lines; file ${fileLineCountBefore} → ${fileLineCountAfter}; hunk_id=${hunkId}.`;

    const yaml = [
      `status: ok`,
      `mode: preview_file_append`,
      `path: ${yamlQuote(filePath)}`,
      `hunk_id: ${yamlQuote(hunkId)}`,
      `expires_at_ms: ${planned.expiresAtMs}`,
      `action: append`,
      `create: ${create}`,
      `file_line_count_before: ${fileLineCountBefore}`,
      `file_line_count_after: ${fileLineCountAfter}`,
      `appended_line_count: ${appendedLineCount}`,
      `normalized:`,
      `  file_eof_has_newline: ${normalized.fileEofHasNewline}`,
      `  content_eof_has_newline: ${normalized.contentEofHasNewline}`,
      `  normalized_file_eof_newline_added: ${normalized.normalizedFileEofNewlineAdded}`,
      `  normalized_content_eof_newline_added: ${normalized.normalizedContentEofNewlineAdded}`,
      `blankline_style:`,
      `  file_trailing_blank_line_count: ${fileTrailingBlankLineCount}`,
      `  content_leading_blank_line_count: ${contentLeadingBlankLineCount}`,
      styleWarning ? `style_warning: ${yamlQuote(styleWarning)}` : `style_warning: ''`,
      `evidence_preview:`,
      `  before_tail: ${yamlFlowStringArray(evidenceBeforeTail)}`,
      `  append_preview: ${yamlFlowStringArray(evidenceAppendPreview)}`,
      `  after_tail: ${yamlFlowStringArray(evidenceAfterTail)}`,
      `summary: ${yamlQuote(summary)}`,
    ].join('\n');

    const content =
      `${formatYamlCodeBlock(yaml)}\n\n` +
      `\`\`\`diff\n${unifiedDiff}\`\`\`\n\n` +
      (language === 'zh'
        ? `下一步：调用函数工具 \`apply_file_modification\`，参数：{ \"hunk_id\": \"${hunkId}\" }`
        : `Next: call function tool \`apply_file_modification\` with { \"hunk_id\": \"${hunkId}\" }.`);
    return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
  } catch (error: unknown) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: preview_file_append`,
        `path: ${yamlQuote(filePath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

async function planInsertionCommon(
  position: 'before' | 'after',
  caller: ToolCaller,
  options: {
    filePath: string;
    anchor: string;
    occurrence: Occurrence;
    occurrenceSpecified: boolean;
    match: AnchorMatchMode;
    requestedId: string | undefined;
    inputBody: string;
  },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const mode = position === 'after' ? 'preview_insert_after' : 'preview_insert_before';

  const filePath = options.filePath;
  const anchor = options.anchor;
  const inputBody = options.inputBody;
  const occurrence = options.occurrence;
  const occurrenceSpecified = options.occurrenceSpecified;
  const match = options.match;
  const requestedId = options.requestedId;

  if (!filePath || !anchor) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? `需要提供 path 与 anchor。请调用函数工具：${mode}({ path, anchor, content, ...options })`
            : `path and anchor are required. Call the function tool: ${mode}({ path, anchor, content, ...options })`,
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  if (requestedId !== undefined && !isValidHunkId(requestedId)) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
        `path: ${yamlQuote(filePath)}`,
        `error: INVALID_HUNK_ID`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? 'hunk id 格式无效（例如 `a1b2c3d4`）。'
            : 'Invalid hunk id (e.g. `a1b2c3d4`).',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }

  if (inputBody === '') {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
        `path: ${yamlQuote(filePath)}`,
        `error: CONTENT_REQUIRED`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? '正文不能为空（需要提供要插入的内容）。'
            : 'Content is required in the body.',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  try {
    pruneExpiredPlannedMods(Date.now());
    pruneExpiredPlannedBlockReplaces(Date.now());

    const fullPath = ensureInsideWorkspace(filePath);
    if (!fsSync.existsSync(fullPath)) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: ${mode}`,
          `path: ${yamlQuote(filePath)}`,
          `error: FILE_NOT_FOUND`,
          `summary: ${yamlQuote(
            language === 'zh' ? '文件不存在，无法规划插入。' : 'File does not exist.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (requestedId) {
      const existing = plannedModsById.get(requestedId);
      if (!existing) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: ${mode}`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: HUNK_NOT_FOUND`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk id 不存在（可能已过期/已被应用）。不支持自定义新 id；要生成新 id，请将 `existing_hunk_id` 设为空字符串。'
                : 'Hunk not found (expired or already applied). Custom new ids are not allowed; set `existing_hunk_id` to an empty string to generate a new one.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.plannedBy !== caller.id) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: ${mode}`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: WRONG_OWNER`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk 不是由当前成员规划的，不能覆写。'
                : 'This hunk was planned by a different member; cannot overwrite.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (existing.kind !== 'insert') {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: ${mode}`,
            `path: ${yamlQuote(filePath)}`,
            `hunk_id: ${yamlQuote(requestedId)}`,
            `error: WRONG_MODE`,
            `summary: ${yamlQuote(
              language === 'zh'
                ? '该 hunk id 不是由 plan_insert_* 生成的，不能用该工具覆写。'
                : 'This hunk was not generated by plan_insert_*; cannot overwrite.',
            )}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
    }

    const existingContent = fsSync.readFileSync(fullPath, 'utf8');
    const lines = splitTextToLinesForEditing(existingContent);
    const isMatch = (line: string): boolean => {
      return match === 'equals' ? line === anchor : line.includes(anchor);
    };
    const matchLines: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (isMatch(line)) matchLines.push(i);
    }

    if (!occurrenceSpecified && matchLines.length > 1) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: ${mode}`,
          `path: ${yamlQuote(filePath)}`,
          `anchor: ${yamlQuote(anchor)}`,
          `error: ANCHOR_AMBIGUOUS`,
          `candidates_count: ${matchLines.length}`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? '锚点出现多次且未指定 occurrence；拒绝规划。请指定 occurrence 或改用 preview_file_modification。'
              : 'Anchor appears multiple times and occurrence is not specified; refusing to plan. Specify occurrence or use preview_file_modification.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (matchLines.length === 0) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: ${mode}`,
          `path: ${yamlQuote(filePath)}`,
          `anchor: ${yamlQuote(anchor)}`,
          `error: ANCHOR_NOT_FOUND`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? '锚点未找到；请改用 preview_file_modification 或选择更可靠的 anchor。'
              : 'Anchor not found; use preview_file_modification or choose a different anchor.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const anchorIndex0 =
      occurrence.kind === 'last'
        ? matchLines[matchLines.length - 1]
        : matchLines[occurrence.index1 - 1];
    if (anchorIndex0 === undefined) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: ${mode}`,
          `path: ${yamlQuote(filePath)}`,
          `anchor: ${yamlQuote(anchor)}`,
          `error: OCCURRENCE_OUT_OF_RANGE`,
          `candidates_count: ${matchLines.length}`,
          `summary: ${yamlQuote(
            language === 'zh' ? 'occurrence 超出范围。' : 'Occurrence out of range.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const occurrenceResolved =
      matchLines.length === 1
        ? '1'
        : occurrence.kind === 'last'
          ? 'last'
          : String(occurrence.index1);

    const anchorLineText = lines[anchorIndex0] ?? '';
    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
    const insertLines = splitPlannedBodyLines(normalizedBody);

    const newLines: string[] =
      position === 'after' ? [anchorLineText, ...insertLines] : [...insertLines, anchorLineText];

    const startIndex0 = anchorIndex0;
    const deleteCount = 1;
    const { contextBefore, contextAfter } = computeContextWindow(lines, startIndex0, deleteCount);

    const unifiedDiff = buildUnifiedSingleHunkDiff(
      filePath,
      lines,
      startIndex0,
      deleteCount,
      newLines,
    );

    const fileEofHasNewline = existingContent === '' || existingContent.endsWith('\n');
    const normalizedFileEofNewlineAdded = existingContent !== '' && !existingContent.endsWith('\n');
    const contentEofHasNewline = inputBody.endsWith('\n');
    const normalizedContentEofNewlineAdded = addedTrailingNewlineToContent;

    const insertedLineCount = insertLines.length;
    const insertedAtLine = position === 'after' ? anchorIndex0 + 2 : anchorIndex0 + 1;

    const fileBeforeTrailingBlankLineCount =
      position === 'after'
        ? countTrailingBlankLines([anchorLineText])
        : countTrailingBlankLines(lines.slice(0, anchorIndex0));
    const fileAfterLeadingBlankLineCount =
      position === 'after'
        ? countLeadingBlankLines(lines.slice(anchorIndex0 + 1))
        : countLeadingBlankLines(lines.slice(anchorIndex0));
    const contentLeadingBlankLineCount = countLeadingBlankLines(insertLines);
    const contentTrailingBlankLineCount = countTrailingBlankLines(insertLines);

    const styleWarning =
      (fileBeforeTrailingBlankLineCount > 0 && contentLeadingBlankLineCount > 0) ||
      (contentTrailingBlankLineCount > 0 && fileAfterLeadingBlankLineCount > 0)
        ? language === 'zh'
          ? '注意：插入点两侧与插入内容的空行风格可能叠加，可能产生多余空行。'
          : 'Warning: blank lines may stack at insertion boundaries; you may get extra blank lines.'
        : '';

    const beforePreview =
      position === 'after'
        ? lines.slice(Math.max(0, anchorIndex0 - 1), anchorIndex0 + 1)
        : lines.slice(Math.max(0, anchorIndex0 - 2), anchorIndex0);
    const insertPreview = insertLines.length <= 2 ? insertLines : insertLines.slice(0, 2);
    const afterPreview =
      position === 'after'
        ? lines.slice(anchorIndex0 + 1, anchorIndex0 + 3)
        : lines.slice(anchorIndex0, anchorIndex0 + 2);

    const nowMs = Date.now();
    const hunkId = (() => {
      if (requestedId) return requestedId;
      for (let i = 0; i < 10; i += 1) {
        const id = generateHunkId();
        if (!plannedModsById.has(id) && !plannedBlockReplacesById.has(id)) return id;
      }
      throw new Error('Failed to generate a unique hunk id');
    })();

    const planned: PlannedInsertionModification = {
      kind: 'insert',
      action: 'insert',
      hunkId,
      plannedBy: caller.id,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PLANNED_MOD_TTL_MS,
      relPath: filePath,
      absPath: fullPath,
      startIndex0,
      deleteCount,
      contextBefore,
      contextAfter,
      oldLines: [anchorLineText],
      newLines,
      unifiedDiff,
      insertion: {
        position,
        anchor,
        match,
        strict: true,
        occurrenceResolved,
        anchorLineText,
        fallback: 'none',
      },
      plannedFileDigestSha256: sha256HexUtf8(existingContent),
    };
    plannedModsById.set(hunkId, planned);

    const linesOld = deleteCount;
    const linesNew = newLines.length;
    const delta = linesNew - linesOld;
    const summary =
      language === 'zh'
        ? `Plan-insert：${position === 'after' ? 'after' : 'before'} "${anchor}"（occurrence=${occurrenceResolved}）插入 +${insertedLineCount} 行；delta=${delta}；hunk_id=${hunkId}.`
        : `Plan-insert: insert +${insertedLineCount} lines ${position} "${anchor}" (occurrence=${occurrenceResolved}); delta=${delta}; hunk_id=${hunkId}.`;

    const yaml = [
      `status: ok`,
      `mode: ${mode}`,
      `path: ${yamlQuote(filePath)}`,
      `hunk_id: ${yamlQuote(hunkId)}`,
      `expires_at_ms: ${planned.expiresAtMs}`,
      `action: insert`,
      `position: ${yamlQuote(position)}`,
      `anchor: ${yamlQuote(anchor)}`,
      `match: ${yamlQuote(match)}`,
      `candidates_count: ${matchLines.length}`,
      `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
      `inserted_at_line: ${insertedAtLine}`,
      `inserted_line_count: ${insertedLineCount}`,
      `lines:`,
      `  old: ${linesOld}`,
      `  new: ${linesNew}`,
      `  delta: ${delta}`,
      `normalized:`,
      `  file_eof_has_newline: ${fileEofHasNewline}`,
      `  content_eof_has_newline: ${contentEofHasNewline}`,
      `  normalized_file_eof_newline_added: ${normalizedFileEofNewlineAdded}`,
      `  normalized_content_eof_newline_added: ${normalizedContentEofNewlineAdded}`,
      `blankline_style:`,
      `  file_before_trailing_blank_line_count: ${fileBeforeTrailingBlankLineCount}`,
      `  file_after_leading_blank_line_count: ${fileAfterLeadingBlankLineCount}`,
      `  content_leading_blank_line_count: ${contentLeadingBlankLineCount}`,
      `  content_trailing_blank_line_count: ${contentTrailingBlankLineCount}`,
      styleWarning ? `style_warning: ${yamlQuote(styleWarning)}` : `style_warning: ''`,
      `evidence_preview:`,
      `  before_preview: ${yamlFlowStringArray(beforePreview)}`,
      `  insert_preview: ${yamlFlowStringArray(insertPreview)}`,
      `  after_preview: ${yamlFlowStringArray(afterPreview)}`,
      `summary: ${yamlQuote(summary)}`,
    ].join('\n');

    const content =
      `${formatYamlCodeBlock(yaml)}\n\n` +
      `\`\`\`diff\n${unifiedDiff}\`\`\`\n\n` +
      (language === 'zh'
        ? `下一步：调用函数工具 \`apply_file_modification\`，参数：{ \"hunk_id\": \"${hunkId}\" }`
        : `Next: call function tool \`apply_file_modification\` with { \"hunk_id\": \"${hunkId}\" }.`);
    return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
  } catch (error: unknown) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
        `path: ${yamlQuote(filePath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

export const previewInsertAfterTool: FuncTool = {
  type: 'func',
  name: 'preview_insert_after',
  description: 'Preview an insertion after an anchor line (does not write).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'anchor', 'content'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const anchor = requireNonEmptyStringArg(args, 'anchor');
    const existingHunkId = normalizeExistingHunkId(
      optionalNonEmptyStringArg(args, 'existing_hunk_id'),
    );
    const content = optionalStringArg(args, 'content') ?? '';

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;

    const occurrenceValue = args['occurrence'];
    if (occurrenceValue !== undefined) {
      if (typeof occurrenceValue === 'number' && Number.isInteger(occurrenceValue)) {
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel 0 means "not specified".
        if (occurrenceValue >= 1) {
          occurrence = { kind: 'index', index1: occurrenceValue };
          occurrenceSpecified = true;
        } else if (occurrenceValue !== 0) {
          throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
        }
      } else if (typeof occurrenceValue === 'string') {
        const trimmed = occurrenceValue.trim();
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel empty string means "not specified".
        if (trimmed !== '') {
          const parsed = parseOccurrence(trimmed);
          if (!parsed) {
            throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
          }
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else {
        throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
      }
    }

    let match: AnchorMatchMode = 'contains';
    const matchArg = optionalNonEmptyStringArg(args, 'match');
    if (matchArg !== undefined) {
      if (matchArg !== 'contains' && matchArg !== 'equals') {
        throw new Error("Invalid arguments: `match` must be one of: 'contains', 'equals'");
      }
      match = matchArg;
    }

    const requestedId = existingHunkId;
    if (requestedId !== undefined && !isValidHunkId(requestedId)) {
      throw new Error(
        "Invalid arguments: `existing_hunk_id` must be a hunk id like 'a1b2c3d4' (letters/digits/_/-)",
      );
    }

    const res = await planInsertionCommon('after', caller, {
      filePath,
      anchor,
      occurrence,
      occurrenceSpecified,
      match,
      requestedId,
      inputBody: content,
    });
    return unwrapTxtToolResult(res);
  },
};

export const previewInsertBeforeTool: FuncTool = {
  type: 'func',
  name: 'preview_insert_before',
  description: 'Preview an insertion before an anchor line (does not write).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: { type: 'string' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'anchor', 'content'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const anchor = requireNonEmptyStringArg(args, 'anchor');
    const existingHunkId = normalizeExistingHunkId(
      optionalNonEmptyStringArg(args, 'existing_hunk_id'),
    );
    const content = optionalStringArg(args, 'content') ?? '';

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;

    const occurrenceValue = args['occurrence'];
    if (occurrenceValue !== undefined) {
      if (typeof occurrenceValue === 'number' && Number.isInteger(occurrenceValue)) {
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel 0 means "not specified".
        if (occurrenceValue >= 1) {
          occurrence = { kind: 'index', index1: occurrenceValue };
          occurrenceSpecified = true;
        } else if (occurrenceValue !== 0) {
          throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
        }
      } else if (typeof occurrenceValue === 'string') {
        const trimmed = occurrenceValue.trim();
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel empty string means "not specified".
        if (trimmed !== '') {
          const parsed = parseOccurrence(trimmed);
          if (!parsed) {
            throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
          }
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else {
        throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
      }
    }

    let match: AnchorMatchMode = 'contains';
    const matchArg = optionalNonEmptyStringArg(args, 'match');
    if (matchArg !== undefined) {
      if (matchArg !== 'contains' && matchArg !== 'equals') {
        throw new Error("Invalid arguments: `match` must be one of: 'contains', 'equals'");
      }
      match = matchArg;
    }

    const requestedId = existingHunkId;
    if (requestedId !== undefined && !isValidHunkId(requestedId)) {
      throw new Error(
        "Invalid arguments: `existing_hunk_id` must be a hunk id like 'a1b2c3d4' (letters/digits/_/-)",
      );
    }

    const res = await planInsertionCommon('before', caller, {
      filePath,
      anchor,
      occurrence,
      occurrenceSpecified,
      match,
      requestedId,
      inputBody: content,
    });
    return unwrapTxtToolResult(res);
  },
};

async function runApplyFileModification(
  caller: ToolCaller,
  id: string,
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const labels =
    language === 'zh'
      ? {
          invalidFormat:
            '错误：参数不正确。请调用函数工具：apply_file_modification({ \"hunk_id\": \"<hunk_id>\" })',
          hunkIdRequired: '错误：需要提供要应用的 hunk id（例如 `a1b2c3d4`）。',
          notFound: (id: string) => `错误：未找到该 hunk：\`${id}\`（可能已过期或已被应用）。`,
          wrongOwner: '错误：该 hunk 不是由当前成员规划的，不能应用。',
          mismatch: '错误：文件内容已变化，无法安全应用该 hunk；请重新规划。',
          ambiguous:
            '错误：无法唯一定位该 hunk 的目标位置（文件内出现多处匹配）；请重新规划（缩小范围或增加上下文）。',
          applied: (p: string, id: string) => `✅ 已应用：\`${id}\` → \`${p}\``,
          applyFailed: (msg: string) => `错误：应用失败：${msg}`,
        }
      : {
          invalidFormat:
            'Error: Invalid args. Call the function tool: apply_file_modification({ "hunk_id": "<hunk_id>" })',
          hunkIdRequired: 'Error: hunk id is required (e.g. `a1b2c3d4`).',
          notFound: (id: string) => `Error: hunk \`${id}\` not found (expired or already applied).`,
          wrongOwner: 'Error: this hunk was planned by a different member.',
          mismatch:
            'Error: file content has changed; refusing to apply this hunk safely. Re-plan it.',
          ambiguous:
            'Error: unable to uniquely locate the hunk target (multiple matches). Re-plan with a narrower range or more context.',
          applied: (p: string, id: string) => `✅ Applied \`${id}\` to \`${p}\``,
          applyFailed: (msg: string) => `Error applying modification: ${msg}`,
        };
  if (!id) {
    const content = labels.hunkIdRequired;
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (!isValidHunkId(id)) {
    const content = labels.hunkIdRequired;
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }

  try {
    pruneExpiredPlannedMods(Date.now());
    pruneExpiredPlannedBlockReplaces(Date.now());

    const plannedFileMod = plannedModsById.get(id);
    const plannedBlockReplace = plannedBlockReplacesById.get(id);

    if (plannedFileMod && plannedBlockReplace) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: apply_file_modification`,
          `hunk_id: ${yamlQuote(id)}`,
          `error: HUNK_ID_CONFLICT`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? 'hunk id 冲突：该 id 同时存在于不同的规划类型中；请重新规划生成新的 hunk id。'
              : 'Hunk id conflict: this id exists in multiple plan types; re-plan to generate a new hunk id.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!plannedFileMod && !plannedBlockReplace) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: apply_file_modification`,
          `hunk_id: ${yamlQuote(id)}`,
          `error: HUNK_NOT_FOUND`,
          `summary: ${yamlQuote(labels.notFound(id))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (plannedFileMod) {
      if (plannedFileMod.plannedBy !== caller.id) {
        const content = formatYamlCodeBlock(
          [
            `status: error`,
            `mode: apply_file_modification`,
            `hunk_id: ${yamlQuote(id)}`,
            `error: WRONG_OWNER`,
            `summary: ${yamlQuote(labels.wrongOwner)}`,
          ].join('\n'),
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (!hasWriteAccess(caller, plannedFileMod.relPath)) {
        const content = getAccessDeniedMessage('write', plannedFileMod.relPath, language);
        return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const absKey = plannedFileMod.absPath;
      const res = await new Promise<TxtToolCallResult>((resolve) => {
        enqueueFileApply(absKey, {
          priority: plannedFileMod.createdAtMs,
          tieBreaker: plannedFileMod.hunkId,
          run: async () => {
            try {
              pruneExpiredPlannedMods(Date.now());
              pruneExpiredPlannedBlockReplaces(Date.now());
              const p = plannedModsById.get(id);
              if (!p) {
                const content = formatYamlCodeBlock(
                  [
                    `status: error`,
                    `mode: apply_file_modification`,
                    `hunk_id: ${yamlQuote(id)}`,
                    `error: HUNK_NOT_FOUND`,
                    `summary: ${yamlQuote(labels.notFound(id))}`,
                  ].join('\n'),
                );
                resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
                return;
              }
              if (p.plannedBy !== caller.id) {
                const content = formatYamlCodeBlock(
                  [
                    `status: error`,
                    `mode: apply_file_modification`,
                    `hunk_id: ${yamlQuote(id)}`,
                    `error: WRONG_OWNER`,
                    `summary: ${yamlQuote(labels.wrongOwner)}`,
                  ].join('\n'),
                );
                resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
                return;
              }

              // Read current file (append hunks may allow creation).
              let fileExists = fsSync.existsSync(p.absPath);
              if (!fileExists && p.kind === 'append' && p.allowCreate) {
                fsSync.mkdirSync(path.dirname(p.absPath), { recursive: true });
                fileExists = true;
                fsSync.writeFileSync(p.absPath, '', 'utf8');
              }
              if (!fileExists) {
                const content = formatYamlCodeBlock(
                  [
                    `status: error`,
                    `mode: apply_file_modification`,
                    `path: ${yamlQuote(p.relPath)}`,
                    `hunk_id: ${yamlQuote(id)}`,
                    `context_match: rejected`,
                    `error: FILE_NOT_FOUND`,
                    `summary: ${yamlQuote(
                      language === 'zh'
                        ? '文件不存在，无法应用；请重新规划。'
                        : 'File not found; cannot apply; re-plan it.',
                    )}`,
                  ].join('\n'),
                );
                resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
                return;
              }

              const currentContent = fsSync.readFileSync(p.absPath, 'utf8');

              // Append is always applied at EOF; drift is reported via digest.
              if (p.kind === 'append' || (p.kind === 'range' && p.action === 'append')) {
                const currentDigest = sha256HexUtf8(currentContent);
                const plannedDigest =
                  p.kind === 'append' ? p.plannedFileDigestSha256 : p.plannedFileDigestSha256;
                const contextMatch =
                  plannedDigest && plannedDigest === currentDigest ? 'exact' : 'fuzz';

                const currentLinesRaw = splitFileTextToLines(currentContent);
                const baseLines = isEmptyFileLines(currentLinesRaw) ? [] : currentLinesRaw;
                const nextLines = [...baseLines, ...p.newLines];
                const nextText = joinLinesForWrite(nextLines);
                fsSync.mkdirSync(path.dirname(p.absPath), { recursive: true });
                fsSync.writeFileSync(p.absPath, nextText, 'utf8');
                plannedModsById.delete(id);

                const fileLineCountBefore = fileLineCount(baseLines);
                const appendedLineCount = p.newLines.length;
                const appendStartLine = fileLineCountBefore + 1;
                const appendEndLine = appendStartLine + Math.max(0, appendedLineCount - 1);

                const evidenceBeforeTail = baseLines.slice(Math.max(0, baseLines.length - 2));
                const evidenceAppendPreview =
                  p.newLines.length <= 2 ? p.newLines : p.newLines.slice(0, 2);
                const evidenceAfterTail = nextLines.slice(Math.max(0, nextLines.length - 2));

                const summary =
                  language === 'zh'
                    ? `Apply：append 第 ${appendStartLine}–${appendEndLine} 行（+${appendedLineCount} 行）；匹配=${contextMatch}；hunk_id=${id}.`
                    : `Apply: append lines ${appendStartLine}–${appendEndLine} (+${appendedLineCount} lines); matched ${contextMatch}; hunk_id=${id}.`;

                const yaml = [
                  `status: ok`,
                  `mode: apply_file_modification`,
                  `path: ${yamlQuote(p.relPath)}`,
                  `hunk_id: ${yamlQuote(id)}`,
                  `action: append`,
                  `append_range:`,
                  `  start: ${appendStartLine}`,
                  `  end: ${appendEndLine}`,
                  `lines:`,
                  `  old: 0`,
                  `  new: ${appendedLineCount}`,
                  `  delta: ${appendedLineCount}`,
                  `context_match: ${contextMatch}`,
                  `apply_evidence:`,
                  `  before_tail: ${yamlBlockScalarLines(evidenceBeforeTail, '    ')}`,
                  `  appended_preview: ${yamlBlockScalarLines(evidenceAppendPreview, '    ')}`,
                  `  after_tail: ${yamlBlockScalarLines(evidenceAfterTail, '    ')}`,
                  `summary: ${yamlQuote(summary)}`,
                ].join('\n');

                const content =
                  `${labels.applied(p.relPath, id)}\n\n` +
                  `${formatYamlCodeBlock(yaml)}\n\n` +
                  `\`\`\`diff\n${p.unifiedDiff}\`\`\``;
                resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
                return;
              }

              if (p.kind === 'insert') {
                const currentLines = splitFileTextToLines(currentContent);

                let startIndex0 = -1;
                if (matchesAt(currentLines, p.startIndex0, p.oldLines)) {
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
                      `mode: apply_file_modification`,
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
                        `mode: apply_file_modification`,
                        `path: ${yamlQuote(p.relPath)}`,
                        `hunk_id: ${yamlQuote(id)}`,
                        `context_match: rejected`,
                        `error: AMBIGUOUS_MATCH`,
                        `summary: ${yamlQuote(summary)}`,
                      ].join('\n');
                      const content = formatYamlCodeBlock(yaml);
                      resolve(
                        failed(content, [{ type: 'environment_msg', role: 'user', content }]),
                      );
                      return;
                    }
                  }
                }

                const nextLines = [...currentLines];
                nextLines.splice(startIndex0, p.deleteCount, ...p.newLines);
                const nextText = joinLinesForWrite(nextLines);
                fsSync.writeFileSync(p.absPath, nextText, 'utf8');
                plannedModsById.delete(id);

                const contextMatch = startIndex0 === p.startIndex0 ? 'exact' : 'fuzz';
                const insertedLineCount = Math.max(0, p.newLines.length - 1);
                const insertedAtLine =
                  p.insertion.position === 'after' ? startIndex0 + 2 : startIndex0 + 1;
                const insertedStartIndex0 =
                  p.insertion.position === 'after' ? startIndex0 + 1 : startIndex0;
                const insertedLines = nextLines.slice(
                  insertedStartIndex0,
                  insertedStartIndex0 + insertedLineCount,
                );

                const evidenceBefore = previewWindow(nextLines, insertedStartIndex0 - 2, 2);
                const evidenceRange = buildRangePreview(insertedLines);
                const evidenceAfter = previewWindow(
                  nextLines,
                  insertedStartIndex0 + insertedLineCount,
                  2,
                );

                const summary =
                  language === 'zh'
                    ? `Apply：insert 第 ${insertedAtLine} 起 +${insertedLineCount} 行；匹配=${contextMatch}；hunk_id=${id}.`
                    : `Apply: insert +${insertedLineCount} lines at line ${insertedAtLine}; matched ${contextMatch}; hunk_id=${id}.`;

                const yaml = [
                  `status: ok`,
                  `mode: apply_file_modification`,
                  `path: ${yamlQuote(p.relPath)}`,
                  `hunk_id: ${yamlQuote(id)}`,
                  `action: insert`,
                  `position: ${yamlQuote(p.insertion.position)}`,
                  `anchor: ${yamlQuote(p.insertion.anchor)}`,
                  `inserted_at_line: ${insertedAtLine}`,
                  `inserted_line_count: ${insertedLineCount}`,
                  `context_match: ${contextMatch}`,
                  `apply_evidence:`,
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
                return;
              }

              // Range replace/delete (non-append).
              const currentLines = splitFileTextToLines(currentContent);

              let startIndex0 = -1;
              if (matchesAt(currentLines, p.startIndex0, p.oldLines)) {
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
                    `mode: apply_file_modification`,
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
                      `mode: apply_file_modification`,
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

              const contextMatch = startIndex0 === p.startIndex0 ? 'exact' : 'fuzz';
              const action = p.action;

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
                `mode: apply_file_modification`,
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
                `apply_evidence:`,
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
                wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]),
              );
            }
          },
        });
        void drainFileApplyQueue(absKey);
      });

      return res;
    }

    // plannedBlockReplace must exist here.
    const planned = plannedBlockReplace;
    if (!planned) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: apply_file_modification`,
          `hunk_id: ${yamlQuote(id)}`,
          `error: HUNK_NOT_FOUND`,
          `summary: ${yamlQuote(labels.notFound(id))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (planned.plannedBy !== caller.id) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `mode: apply_file_modification`,
          `path: ${yamlQuote(planned.relPath)}`,
          `hunk_id: ${yamlQuote(id)}`,
          `error: WRONG_OWNER`,
          `summary: ${yamlQuote(labels.wrongOwner)}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!hasWriteAccess(caller, planned.relPath)) {
      const content = getAccessDeniedMessage('write', planned.relPath, language);
      return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const absKey = planned.absPath;
    const res = await new Promise<TxtToolCallResult>((resolve) => {
      enqueueFileApply(absKey, {
        priority: planned.createdAtMs,
        tieBreaker: planned.hunkId,
        run: async () => {
          try {
            pruneExpiredPlannedMods(Date.now());
            pruneExpiredPlannedBlockReplaces(Date.now());
            const p = plannedBlockReplacesById.get(id);
            if (!p) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: apply_file_modification`,
                  `hunk_id: ${yamlQuote(id)}`,
                  `error: HUNK_NOT_FOUND`,
                  `summary: ${yamlQuote(labels.notFound(id))}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            if (p.plannedBy !== caller.id) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: apply_file_modification`,
                  `path: ${yamlQuote(p.relPath)}`,
                  `hunk_id: ${yamlQuote(id)}`,
                  `error: WRONG_OWNER`,
                  `summary: ${yamlQuote(labels.wrongOwner)}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            if (!fsSync.existsSync(p.absPath)) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: apply_file_modification`,
                  `path: ${yamlQuote(p.relPath)}`,
                  `hunk_id: ${yamlQuote(id)}`,
                  `context_match: rejected`,
                  `error: FILE_NOT_FOUND`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? '文件不存在，无法应用；请重新规划。'
                      : 'File not found; cannot apply; re-plan it.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const currentContent = fsSync.readFileSync(p.absPath, 'utf8');
            const fileEofHasNewline = currentContent === '' || currentContent.endsWith('\n');
            const normalizedFileEofNewlineAdded =
              currentContent !== '' && !currentContent.endsWith('\n');
            const lines = splitTextToLinesForEditing(currentContent);

            const isMatch = (line: string, anchor: string): boolean => {
              return p.match === 'equals' ? line === anchor : line.includes(anchor);
            };

            const startMatches: number[] = [];
            const endMatches: number[] = [];
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i] ?? '';
              if (isMatch(line, p.startAnchor)) startMatches.push(i);
              if (isMatch(line, p.endAnchor)) endMatches.push(i);
            }

            const pairs: Array<{ start0: number; end0: number }> = [];
            for (const start0 of startMatches) {
              const end0 = endMatches.find((e) => e > start0);
              if (end0 !== undefined) pairs.push({ start0, end0 });
            }

            if (pairs.length === 0) {
              const summary =
                language === 'zh'
                  ? 'Apply rejected：anchors 未找到或无法配对；请重新 plan。'
                  : 'Apply rejected: anchors not found or not paired; re-plan this hunk.';
              const yaml = [
                `status: error`,
                `mode: apply_file_modification`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `context_match: rejected`,
                `error: APPLY_REJECTED_ANCHOR_NOT_FOUND`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');
              const content = formatYamlCodeBlock(yaml);
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            if (!p.occurrenceSpecified && p.requireUnique && pairs.length !== 1) {
              const summary =
                language === 'zh'
                  ? `Apply rejected：anchors 歧义（${pairs.length} 个候选块）；请重新 plan 并指定 occurrence。`
                  : `Apply rejected: ambiguous anchors (${pairs.length} candidates); re-plan with occurrence specified.`;
              const yaml = [
                `status: error`,
                `mode: apply_file_modification`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `context_match: rejected`,
                `error: APPLY_REJECTED_ANCHOR_AMBIGUOUS`,
                `candidates_count: ${pairs.length}`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');
              const content = formatYamlCodeBlock(yaml);
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const selected = (() => {
              if (pairs.length === 1) return pairs[0];
              if (p.occurrence.kind === 'last') return pairs[pairs.length - 1];
              return pairs[p.occurrence.index1 - 1];
            })();

            if (!selected) {
              const summary =
                language === 'zh'
                  ? 'Apply rejected：occurrence 超出范围；请重新 plan。'
                  : 'Apply rejected: occurrence out of range; re-plan.';
              const yaml = [
                `status: error`,
                `mode: apply_file_modification`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `context_match: rejected`,
                `error: APPLY_REJECTED_OCCURRENCE_OUT_OF_RANGE`,
                `candidates_count: ${pairs.length}`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');
              const content = formatYamlCodeBlock(yaml);
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const nestedStart = startMatches.some((s) => s > selected.start0 && s < selected.end0);
            const nestedEnd = endMatches.some((e) => e > selected.start0 && e < selected.end0);
            if (nestedStart || nestedEnd) {
              const summary =
                language === 'zh'
                  ? 'Apply rejected：检测到嵌套/歧义锚点；请重新 plan。'
                  : 'Apply rejected: nested/ambiguous anchors detected; re-plan.';
              const yaml = [
                `status: error`,
                `mode: apply_file_modification`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `context_match: rejected`,
                `error: APPLY_REJECTED_ANCHOR_AMBIGUOUS`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');
              const content = formatYamlCodeBlock(yaml);
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const replaceStart0 = p.includeAnchors ? selected.start0 + 1 : selected.start0;
            const replaceDeleteCount = p.includeAnchors
              ? Math.max(0, selected.end0 - selected.start0 - 1)
              : selected.end0 - selected.start0 + 1;

            const currentOldLines = lines.slice(replaceStart0, replaceStart0 + replaceDeleteCount);
            const same =
              currentOldLines.length === p.oldLines.length &&
              currentOldLines.every((v, i) => v === p.oldLines[i]);
            if (!same) {
              const summary =
                language === 'zh'
                  ? 'Apply rejected：文件内容已变化（目标块内容与规划时不一致）；请重新 plan。'
                  : 'Apply rejected: file content changed (target block no longer matches the planned content); re-plan.';
              const yaml = [
                `status: error`,
                `mode: apply_file_modification`,
                `path: ${yamlQuote(p.relPath)}`,
                `hunk_id: ${yamlQuote(id)}`,
                `context_match: rejected`,
                `error: APPLY_REJECTED_CONTENT_CHANGED`,
                `summary: ${yamlQuote(summary)}`,
              ].join('\n');
              const content = formatYamlCodeBlock(yaml);
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const outLines = [...lines];
            outLines.splice(replaceStart0, replaceDeleteCount, ...p.newLines);
            const out = joinLinesForTextWrite(outLines);
            fsSync.writeFileSync(p.absPath, out, 'utf8');
            plannedBlockReplacesById.delete(id);

            const locationMatch =
              selected.start0 === p.selectedStart0 &&
              selected.end0 === p.selectedEnd0 &&
              replaceStart0 === p.replaceStart0 &&
              replaceDeleteCount === p.deleteCount;
            const contextMatch = locationMatch ? 'exact' : 'fuzz';

            const oldCount = replaceDeleteCount;
            const newCount = p.newLines.length;
            const delta = newCount - oldCount;
            const oldPreview = buildRangePreview(p.oldLines);
            const newPreview = buildRangePreview(p.newLines);

            const summary =
              language === 'zh'
                ? `Apply：block_replace old=${oldCount}, new=${newCount}, delta=${delta}；匹配=${contextMatch}；hunk_id=${id}.`
                : `Apply: block_replace old=${oldCount}, new=${newCount}, delta=${delta}; matched ${contextMatch}; hunk_id=${id}.`;

            const yaml = [
              `status: ok`,
              `mode: apply_file_modification`,
              `path: ${yamlQuote(p.relPath)}`,
              `hunk_id: ${yamlQuote(id)}`,
              `action: block_replace`,
              `block_range:`,
              `  start_line: ${selected.start0 + 1}`,
              `  end_line: ${selected.end0 + 1}`,
              `replace_slice:`,
              `  start_line: ${replaceStart0 + 1}`,
              `  delete_count: ${replaceDeleteCount}`,
              `lines:`,
              `  old: ${oldCount}`,
              `  new: ${newCount}`,
              `  delta: ${delta}`,
              `context_match: ${contextMatch}`,
              `normalized:`,
              `  file_eof_has_newline: ${fileEofHasNewline}`,
              `  content_eof_has_newline: ${p.normalized.contentEofHasNewline}`,
              `  normalized_file_eof_newline_added: ${normalizedFileEofNewlineAdded}`,
              `  normalized_content_eof_newline_added: ${p.normalized.normalizedContentEofNewlineAdded}`,
              `apply_evidence:`,
              `  before_preview: ${yamlFlowStringArray([lines[selected.start0] ?? ''])}`,
              `  old_preview: ${yamlFlowStringArray(oldPreview)}`,
              `  new_preview: ${yamlFlowStringArray(newPreview)}`,
              `  after_preview: ${yamlFlowStringArray([lines[selected.end0] ?? ''])}`,
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
              wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]),
            );
          }
        },
      });
      void drainFileApplyQueue(absKey);
    });

    return res;
  } catch (error: unknown) {
    const content = labels.applyFailed(error instanceof Error ? error.message : String(error));
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

export const applyFileModificationTool: FuncTool = {
  type: 'func',
  name: 'apply_file_modification',
  description: 'Apply a previewed file modification by hunk id (writes the file).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      hunk_id: { type: 'string' },
    },
    required: ['hunk_id'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const raw = requireNonEmptyStringArg(args, 'hunk_id');
    const id = normalizeExistingHunkId(raw) ?? '';
    if (!id) throw new Error('Invalid arguments: `hunk_id` must be a non-empty string');
    if (!isValidHunkId(id)) {
      throw new Error(
        "Invalid arguments: `hunk_id` must be a hunk id like 'a1b2c3d4' (letters/digits/_/-)",
      );
    }
    const res = await runApplyFileModification(caller, id);
    return unwrapTxtToolResult(res);
  },
};
async function runPreviewBlockReplace(
  caller: ToolCaller,
  options: {
    filePath: string;
    startAnchor: string;
    endAnchor: string;
    occurrence: Occurrence;
    occurrenceSpecified: boolean;
    includeAnchors: boolean;
    match: AnchorMatchMode;
    requireUnique: boolean;
    strict: boolean;
    inputBody: string;
  },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const filePath = options.filePath;
  const startAnchor = options.startAnchor;
  const endAnchor = options.endAnchor;
  const inputBody = options.inputBody;
  const occurrence = options.occurrence;
  const occurrenceSpecified = options.occurrenceSpecified;
  const includeAnchors = options.includeAnchors;
  const match = options.match;
  const requireUnique = options.requireUnique;
  const strict = options.strict;

  if (!filePath || !startAnchor || !endAnchor) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: preview_block_replace`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? '需要提供 path、start_anchor、end_anchor。'
            : 'path, start_anchor, and end_anchor are required.',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return wrapTxtToolResult(language, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (inputBody === '') {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `path: ${yamlQuote(filePath)}`,
        `mode: preview_block_replace`,
        `error: CONTENT_REQUIRED`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? '正文不能为空（需要提供要写入块内的新内容）。'
            : 'Content is required in the body (new block content).',
        )}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }

  try {
    pruneExpiredPlannedMods(Date.now());
    pruneExpiredPlannedBlockReplaces(Date.now());

    const fullPath = ensureInsideWorkspace(filePath);
    if (!fsSync.existsSync(fullPath)) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: preview_block_replace`,
          `error: FILE_NOT_FOUND`,
          `summary: ${yamlQuote(language === 'zh' ? '文件不存在。' : 'File does not exist.')}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const existing = fsSync.readFileSync(fullPath, 'utf8');
    const fileEofHasNewline = existing === '' || existing.endsWith('\n');
    const normalizedFileEofNewlineAdded = existing !== '' && !existing.endsWith('\n');
    const lines = splitTextToLinesForEditing(existing);

    const isMatch = (line: string, anchor: string): boolean => {
      return match === 'equals' ? line === anchor : line.includes(anchor);
    };

    const startMatches: number[] = [];
    const endMatches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (isMatch(line, startAnchor)) startMatches.push(i);
      if (isMatch(line, endAnchor)) endMatches.push(i);
    }

    const pairs: Array<{ start0: number; end0: number }> = [];
    for (const start0 of startMatches) {
      const end0 = endMatches.find((e) => e > start0);
      if (end0 !== undefined) pairs.push({ start0, end0 });
    }

    const candidatesCount = pairs.length;

    if (candidatesCount === 0) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: preview_block_replace`,
          `start_anchor: ${yamlQuote(startAnchor)}`,
          `end_anchor: ${yamlQuote(endAnchor)}`,
          `candidates_count: 0`,
          `error: ANCHOR_NOT_FOUND`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? '锚点未找到或无法配对。请改用 preview_file_modification（行号范围精确编辑）。'
              : 'Anchors not found or not paired. Use preview_file_modification (line-range precise edits).',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!occurrenceSpecified && requireUnique && candidatesCount !== 1 && strict) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: preview_block_replace`,
          `start_anchor: ${yamlQuote(startAnchor)}`,
          `end_anchor: ${yamlQuote(endAnchor)}`,
          `candidates_count: ${candidatesCount}`,
          `error: ANCHOR_AMBIGUOUS`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? `锚点歧义：存在 ${candidatesCount} 个候选块。请指定 occurrence=<n|last>，或改用 preview_file_modification（行号范围）。`
              : `Ambiguous anchors: ${candidatesCount} candidate block(s). Specify occurrence=<n|last>, or use preview_file_modification (line range).`,
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const selected = (() => {
      if (candidatesCount === 1) return pairs[0];
      if (occurrence.kind === 'last') return pairs[pairs.length - 1];
      const idx0 = occurrence.index1 - 1;
      return pairs[idx0];
    })();

    if (!selected) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: preview_block_replace`,
          `start_anchor: ${yamlQuote(startAnchor)}`,
          `end_anchor: ${yamlQuote(endAnchor)}`,
          `candidates_count: ${candidatesCount}`,
          `error: OCCURRENCE_OUT_OF_RANGE`,
          `summary: ${yamlQuote(
            language === 'zh' ? 'occurrence 超出范围。' : 'occurrence is out of range.',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const nestedStart = startMatches.some((s) => s > selected.start0 && s < selected.end0);
    const nestedEnd = endMatches.some((e) => e > selected.start0 && e < selected.end0);
    if (nestedStart || nestedEnd) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `path: ${yamlQuote(filePath)}`,
          `mode: preview_block_replace`,
          `start_anchor: ${yamlQuote(startAnchor)}`,
          `end_anchor: ${yamlQuote(endAnchor)}`,
          `candidates_count: ${candidatesCount}`,
          `error: ANCHOR_AMBIGUOUS`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? '检测到嵌套/歧义锚点，拒绝规划。请先规范 anchors，或改用 preview_file_modification（行号范围）。'
              : 'Nested/ambiguous anchors detected. Refusing to preview; normalize anchors or use preview_file_modification (line range).',
          )}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const occurrenceResolved =
      candidatesCount === 1 ? '1' : occurrence.kind === 'last' ? 'last' : String(occurrence.index1);

    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(inputBody);
    const contentEofHasNewline = inputBody.endsWith('\n');
    const normalizedContentEofNewlineAdded = addedTrailingNewlineToContent;
    const normalized: FileEofNewlineNormalization = {
      fileEofHasNewline,
      contentEofHasNewline,
      normalizedFileEofNewlineAdded,
      normalizedContentEofNewlineAdded,
    };
    const replacementLines = splitPlannedBodyLines(normalizedBody);

    const replaceStart0 = includeAnchors ? selected.start0 + 1 : selected.start0;
    const replaceDeleteCount = includeAnchors
      ? Math.max(0, selected.end0 - selected.start0 - 1)
      : selected.end0 - selected.start0 + 1;

    const oldLines = lines.slice(replaceStart0, replaceStart0 + replaceDeleteCount);
    const unifiedDiff = buildUnifiedSingleHunkDiff(
      filePath,
      lines,
      replaceStart0,
      replaceDeleteCount,
      replacementLines,
    );

    const nowMs = Date.now();
    const hunkId = (() => {
      for (let i = 0; i < 10; i += 1) {
        const id = generateHunkId();
        if (!plannedModsById.has(id) && !plannedBlockReplacesById.has(id)) return id;
      }
      throw new Error('Failed to generate a unique hunk id');
    })();

    const planned: PlannedBlockReplace = {
      hunkId,
      plannedBy: caller.id,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PLANNED_MOD_TTL_MS,
      relPath: filePath,
      absPath: fullPath,
      startAnchor,
      endAnchor,
      match,
      includeAnchors,
      requireUnique,
      strict,
      occurrence,
      occurrenceSpecified,
      selectedStart0: selected.start0,
      selectedEnd0: selected.end0,
      replaceStart0,
      deleteCount: replaceDeleteCount,
      oldLines,
      newLines: replacementLines,
      unifiedDiff,
      normalized,
    };
    plannedBlockReplacesById.set(hunkId, planned);

    const oldCount = replaceDeleteCount;
    const newCount = replacementLines.length;
    const delta = newCount - oldCount;

    const oldPreview = buildRangePreview(oldLines);
    const newPreview = buildRangePreview(replacementLines);
    const summary =
      language === 'zh'
        ? `Plan-block-replace：候选=${candidatesCount}；block 第 ${selected.start0 + 1}–${selected.end0 + 1} 行；old=${oldCount}, new=${newCount}, delta=${delta}；hunk_id=${hunkId}.`
        : `Plan-block-replace: candidates=${candidatesCount}; block lines ${selected.start0 + 1}–${selected.end0 + 1}; old=${oldCount}, new=${newCount}, delta=${delta}; hunk_id=${hunkId}.`;

    const yaml = [
      `status: ok`,
      `mode: preview_block_replace`,
      `path: ${yamlQuote(filePath)}`,
      `action: block_replace`,
      `start_anchor: ${yamlQuote(startAnchor)}`,
      `end_anchor: ${yamlQuote(endAnchor)}`,
      `match: ${yamlQuote(match)}`,
      `include_anchors: ${includeAnchors}`,
      `require_unique: ${requireUnique}`,
      `strict: ${strict}`,
      `candidates_count: ${candidatesCount}`,
      `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
      `hunk_id: ${yamlQuote(hunkId)}`,
      `expires_at_ms: ${planned.expiresAtMs}`,
      `block_range:`,
      `  start_line: ${selected.start0 + 1}`,
      `  end_line: ${selected.end0 + 1}`,
      `replace_slice:`,
      `  start_line: ${replaceStart0 + 1}`,
      `  delete_count: ${replaceDeleteCount}`,
      `lines:`,
      `  old: ${oldCount}`,
      `  new: ${newCount}`,
      `  delta: ${delta}`,
      `normalized:`,
      `  file_eof_has_newline: ${normalized.fileEofHasNewline}`,
      `  content_eof_has_newline: ${normalized.contentEofHasNewline}`,
      `  normalized_file_eof_newline_added: ${normalized.normalizedFileEofNewlineAdded}`,
      `  normalized_content_eof_newline_added: ${normalized.normalizedContentEofNewlineAdded}`,
      `evidence_preview:`,
      `  before_preview: ${yamlFlowStringArray([lines[selected.start0] ?? ''])}`,
      `  old_preview: ${yamlFlowStringArray(oldPreview)}`,
      `  new_preview: ${yamlFlowStringArray(newPreview)}`,
      `  after_preview: ${yamlFlowStringArray([lines[selected.end0] ?? ''])}`,
      `summary: ${yamlQuote(summary)}`,
    ].join('\n');

    const content =
      `${formatYamlCodeBlock(yaml)}\n\n` +
      `\`\`\`diff\n${unifiedDiff}\`\`\`\n\n` +
      (language === 'zh'
        ? `下一步：调用函数工具 \`apply_file_modification\`，参数：{ \"hunk_id\": \"${hunkId}\" }`
        : `Next: call function tool \`apply_file_modification\` with { \"hunk_id\": \"${hunkId}\" }.`);

    return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
  } catch (error: unknown) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `path: ${yamlQuote(filePath)}`,
        `mode: preview_block_replace`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

export const previewBlockReplaceTool: FuncTool = {
  type: 'func',
  name: 'preview_block_replace',
  description: 'Preview a block replacement between anchors (does not write).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      start_anchor: { type: 'string' },
      end_anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      include_anchors: { type: 'boolean' },
      match: { type: 'string' },
      require_unique: { type: 'boolean' },
      strict: { type: 'boolean' },
      content: { type: 'string' },
    },
    required: ['path', 'start_anchor', 'end_anchor', 'content'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const startAnchor = requireNonEmptyStringArg(args, 'start_anchor');
    const endAnchor = requireNonEmptyStringArg(args, 'end_anchor');
    const content = optionalStringArg(args, 'content') ?? '';

    let occurrence: Occurrence = { kind: 'index', index1: 1 };
    let occurrenceSpecified = false;
    const occurrenceValue = args['occurrence'];
    if (occurrenceValue !== undefined) {
      if (typeof occurrenceValue === 'number' && Number.isInteger(occurrenceValue)) {
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel 0 means "not specified".
        if (occurrenceValue >= 1) {
          occurrence = { kind: 'index', index1: occurrenceValue };
          occurrenceSpecified = true;
        } else if (occurrenceValue !== 0) {
          throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
        }
      } else if (typeof occurrenceValue === 'string') {
        const trimmed = occurrenceValue.trim();
        // Codex may require this field to be present even when semantically "unset".
        // Sentinel empty string means "not specified".
        if (trimmed !== '') {
          const parsed = parseOccurrence(trimmed);
          if (!parsed) {
            throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
          }
          occurrence = parsed;
          occurrenceSpecified = true;
        }
      } else {
        throw new Error("Invalid arguments: `occurrence` must be a positive integer or 'last'");
      }
    }

    const includeAnchors = optionalBooleanArg(args, 'include_anchors') ?? true;

    let match: AnchorMatchMode = 'contains';
    const matchArg = optionalNonEmptyStringArg(args, 'match');
    if (matchArg !== undefined) {
      if (matchArg !== 'contains' && matchArg !== 'equals') {
        throw new Error("Invalid arguments: `match` must be one of: 'contains', 'equals'");
      }
      match = matchArg;
    }

    const requireUnique = optionalBooleanArg(args, 'require_unique') ?? true;

    const strict = optionalBooleanArg(args, 'strict') ?? true;

    const res = await runPreviewBlockReplace(caller, {
      filePath,
      startAnchor,
      endAnchor,
      occurrence,
      occurrenceSpecified,
      includeAnchors,
      match,
      requireUnique,
      strict,
      inputBody: content,
    });
    return unwrapTxtToolResult(res);
  },
};

export const previewFileAppendTool: FuncTool = {
  type: 'func',
  name: 'preview_file_append',
  description: 'Preview an append-to-EOF edit (does not write).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      create: { type: 'boolean' },
      existing_hunk_id: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<string> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const create = optionalBooleanArg(args, 'create');
    const existingHunkId = normalizeExistingHunkId(
      optionalNonEmptyStringArg(args, 'existing_hunk_id'),
    );
    const content = optionalStringArg(args, 'content') ?? '';

    const requestedId = existingHunkId;
    if (requestedId !== undefined && !isValidHunkId(requestedId)) {
      throw new Error(
        "Invalid arguments: `existing_hunk_id` must be a hunk id like 'a1b2c3d4' (letters/digits/_/-)",
      );
    }

    const res = await runPreviewFileAppend(caller, filePath, content, {
      create: create ?? true,
      requestedId,
    });
    return unwrapTxtToolResult(res);
  },
};
