/**
 * Module: tools/txt
 *
 * Text file tooling for reading and modifying rtws (runtime workspace) files.
 * Provides `read_file`, direct range edits, overwrite, prepare/apply, and scratch pads.
 */
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { domindsRtwsRootAbs } from '../rtws';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { getWorkLanguage } from '../runtime/work-language';
import type {
  FuncTool,
  JsonValue,
  Reminder,
  ReminderOwner,
  ReminderUpdateResult,
  ToolArguments,
  ToolCallOutput,
} from '../tool';
import { materializeReminder, reminderOwnedBy, toolFailure, toolSuccess } from '../tool';

type FuncToolCallContext = Parameters<FuncTool['call']>[1];

type TxtToolCallResult = {
  status: 'completed' | 'failed';
  result: ToolCallOutput;
  messages?: ChatMessage[];
};

function ok(result: string, messages?: ChatMessage[]): TxtToolCallResult {
  return { status: 'completed', result: toolSuccess(result), messages };
}

function failed(result: string, messages?: ChatMessage[]): TxtToolCallResult {
  return { status: 'failed', result: toolFailure(result), messages };
}

function ensureInsideWorkspace(rel: string): string {
  const cwd = domindsRtwsRootAbs();
  const file = path.resolve(cwd, rel);
  const relative = path.relative(cwd, file);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return file;
  }
  throw new Error('Path must be within rtws (runtime workspace)');
}

function resolveLocalFilesystemPath(inputPath: string): string {
  return path.resolve(process.cwd(), inputPath);
}

function displayLocalFilesystemPath(inputPath: string, absPath: string): string {
  return path.isAbsolute(inputPath) ? absPath : inputPath;
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

function hasOwnArg(args: ToolArguments, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function unwrapTxtToolResult(res: TxtToolCallResult): ToolCallOutput {
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

type PadWriteMode = 'create' | 'replace' | 'append' | 'upsert';

type WsModPadMeta = Readonly<{
  kind: 'ws_mod_pad';
  padId: string;
  text: string;
  manager: Readonly<{ tool: 'pad_*' }>;
  update: Readonly<{ altInstruction: string }>;
  delete: Readonly<{ altInstruction: string }>;
}>;

type PadLookupResult = Readonly<{
  index: number;
  reminder: Reminder;
  meta: WsModPadMeta;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWsModPadMeta(value: unknown): value is WsModPadMeta {
  if (!isRecord(value)) return false;
  if (value['kind'] !== 'ws_mod_pad') return false;
  if (typeof value['padId'] !== 'string') return false;
  if (typeof value['text'] !== 'string') return false;
  const manager = value['manager'];
  const update = value['update'];
  const del = value['delete'];
  return (
    isRecord(manager) &&
    manager['tool'] === 'pad_*' &&
    isRecord(update) &&
    typeof update['altInstruction'] === 'string' &&
    isRecord(del) &&
    typeof del['altInstruction'] === 'string'
  );
}

function normalizePadId(raw: string): string {
  const padId = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(padId)) {
    throw new Error('`pad_id` must match /^[A-Za-z0-9_-]{1,64}$/');
  }
  return padId;
}

function padReminderId(padId: string): string {
  return `pad_${padId}`;
}

function padDeleteInstruction(padId: string): string {
  return `pad_delete({ "pad_id": "${padId}" })`;
}

function padUpdateInstruction(padId: string): string {
  return `Use pad_write/pad_edit/pad_load_file_range with pad_id="${padId}".`;
}

function countPadLines(text: string): number {
  return splitTextToLinesForEditing(text).length;
}

function hashPadText(text: string): string {
  return `sha256:${sha256HexUtf8(text)}`;
}

function buildPadSummaryContent(language: LanguageCode, meta: WsModPadMeta): string {
  const bytes = Buffer.byteLength(meta.text, 'utf8');
  const lines = countPadLines(meta.text);
  if (language === 'zh') {
    return [
      `[ws_mod pad] pad_id=${meta.padId}`,
      `size=${lines} 行, ${bytes} bytes`,
      `hash=${hashPadText(meta.text)}`,
      'ws_mod 临时大文本缓冲区。应用完成或不再需要后请主动删除。',
    ].join('\n');
  }
  return [
    `[ws_mod pad] pad_id=${meta.padId}`,
    `size=${lines} lines, ${bytes} bytes`,
    `hash=${hashPadText(meta.text)}`,
    'Temporary scratch text for ws_mod editing. Apply it or delete it when done.',
  ].join('\n');
}

function buildPadMeta(padId: string, text: string): WsModPadMeta {
  return {
    kind: 'ws_mod_pad',
    padId,
    text,
    manager: { tool: 'pad_*' },
    update: { altInstruction: padUpdateInstruction(padId) },
    delete: { altInstruction: padDeleteInstruction(padId) },
  };
}

function padMetaAsJson(meta: WsModPadMeta): JsonValue {
  return meta;
}

function findDialogPadById(dlg: Dialog, padId: string): PadLookupResult | undefined {
  let found: PadLookupResult | undefined;
  for (let index = 0; index < dlg.reminders.length; index += 1) {
    const reminder = dlg.reminders[index];
    if (reminder === undefined) continue;
    if (!reminderOwnedBy(reminder, wsModPadReminderOwner)) continue;
    if (!isWsModPadMeta(reminder.meta)) continue;
    if (reminder.meta.padId !== padId) continue;
    if (found !== undefined) {
      throw new Error(`Duplicate ws_mod pad reminder detected for pad_id=${padId}`);
    }
    found = { index, reminder, meta: reminder.meta };
  }
  return found;
}

function findDialogPadReminderIndexByReminderId(dlg: Dialog, padId: string): number | undefined {
  const reminderId = padReminderId(padId);
  let found: number | undefined;
  for (let index = 0; index < dlg.reminders.length; index += 1) {
    const reminder = dlg.reminders[index];
    if (reminder === undefined) continue;
    if (!reminderOwnedBy(reminder, wsModPadReminderOwner)) continue;
    if (reminder.id !== reminderId) continue;
    if (found !== undefined) {
      throw new Error(`Duplicate ws_mod pad reminder_id detected: ${reminderId}`);
    }
    found = index;
  }
  return found;
}

function assertPadReminderIdAvailable(
  dlg: Dialog,
  padId: string,
  existing: PadLookupResult | undefined,
): void {
  const expectedReminderId = padReminderId(padId);
  if (existing !== undefined) {
    if (existing.reminder.id !== expectedReminderId) {
      throw new Error(
        `ws_mod pad invariant violation: pad_id=${padId} has reminder_id=${existing.reminder.id}, expected ${expectedReminderId}`,
      );
    }
    return;
  }
  for (const reminder of dlg.reminders) {
    if (reminder.id === expectedReminderId) {
      throw new Error(
        `Cannot create ws_mod pad ${padId}: reminder_id ${expectedReminderId} already exists`,
      );
    }
  }
}

function upsertDialogPad(dlg: Dialog, padId: string, text: string): Reminder {
  const meta = buildPadMeta(padId, text);
  const content = buildPadSummaryContent(getWorkLanguage(), meta);
  const existing = findDialogPadById(dlg, padId);
  assertPadReminderIdAvailable(dlg, padId, existing);
  if (existing === undefined) {
    const reminder = materializeReminder({
      id: padReminderId(padId),
      content,
      owner: wsModPadReminderOwner,
      meta: padMetaAsJson(meta),
      scope: 'dialog',
      renderMode: 'markdown',
    });
    dlg.reminders.push(reminder);
    dlg.touchReminders();
    return reminder;
  }
  dlg.updateReminder(existing.index, content, padMetaAsJson(meta), { renderMode: 'markdown' });
  const updated = dlg.reminders[existing.index];
  if (updated === undefined) {
    throw new Error(`Updated ws_mod pad disappeared for pad_id=${padId}`);
  }
  return updated;
}

function formatPadResultYaml(mode: string, padId: string, text: string, summary: string): string {
  return [
    `status: ok`,
    `mode: ${mode}`,
    `pad_id: ${yamlQuote(padId)}`,
    `lines: ${countPadLines(text)}`,
    `bytes: ${Buffer.byteLength(text, 'utf8')}`,
    `hash: ${yamlQuote(hashPadText(text))}`,
    `summary: ${yamlQuote(summary)}`,
  ].join('\n');
}

function parsePadWriteMode(value: unknown): PadWriteMode {
  if (value === undefined) return 'upsert';
  if (value === '') return 'upsert';
  if (value === 'create' || value === 'replace' || value === 'append' || value === 'upsert') {
    return value;
  }
  throw new Error('`mode` must be create, replace, append, or upsert');
}

function selectTextByLineRange(text: string, rangeSpec: string): string {
  const lines = splitTextToLinesForEditing(text);
  if (lines.length === 0 && rangeSpec.trim() === '~') return '';
  const parsed = parseLineRangeSpec(rangeSpec, rangeTotalLines(lines));
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.range.kind === 'append') {
    throw new Error('Range selects an append position, not existing text');
  }
  const selected = lines.slice(parsed.range.startLine - 1, parsed.range.endLine);
  return joinLinesForTextWrite(selected);
}

function applyTextLineRangeEdit(
  baseText: string,
  rangeSpec: string,
  replacementText: string,
): string {
  const baseLines = splitTextToLinesForEditing(baseText);
  const replacementLines = splitPlannedBodyLines(replacementText);
  const parsed = parseLineRangeSpec(rangeSpec, rangeTotalLines(baseLines));
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.range.kind === 'append') {
    return joinLinesForTextWrite([...baseLines, ...replacementLines]);
  }
  const nextLines = [
    ...baseLines.slice(0, parsed.range.startLine - 1),
    ...replacementLines,
    ...baseLines.slice(parsed.range.endLine),
  ];
  return joinLinesForTextWrite(nextLines);
}

function insertTextAtLinePosition(baseText: string, line: number, insertedText: string): string {
  const baseLines = splitTextToLinesForEditing(baseText);
  if (!Number.isInteger(line) || line <= 0 || line > baseLines.length + 1) {
    throw new Error(`Insert line must be between 1 and ${baseLines.length + 1}`);
  }
  const insertedLines = splitPlannedBodyLines(insertedText);
  const insertIndex0 = line - 1;
  return joinLinesForTextWrite([
    ...baseLines.slice(0, insertIndex0),
    ...insertedLines,
    ...baseLines.slice(insertIndex0),
  ]);
}

function requireDialogPadById(dlg: Dialog, padId: string): PadLookupResult {
  const existing = findDialogPadById(dlg, padId);
  if (existing === undefined) {
    throw new Error(`pad_id=${padId} does not exist`);
  }
  return existing;
}

function parseOptionalPadRange(args: ToolArguments, key: string): string {
  const value = optionalStringArg(args, key);
  if (value === undefined || value.trim() === '') return '~';
  return value;
}

export const wsModPadReminderOwner: ReminderOwner = {
  name: 'wsModPad',

  async updateReminder(_dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (!reminderOwnedBy(reminder, wsModPadReminderOwner)) {
      return { treatment: 'keep' };
    }
    if (!isWsModPadMeta(reminder.meta)) {
      return { treatment: 'keep' };
    }
    const updatedContent = buildPadSummaryContent(getWorkLanguage(), reminder.meta);
    if (reminder.content === updatedContent) {
      return { treatment: 'keep' };
    }
    return { treatment: 'update', updatedContent };
  },

  async renderReminder(_dlg: Dialog, reminder: Reminder): Promise<ChatMessage> {
    const language = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(language);
    if (!isWsModPadMeta(reminder.meta)) {
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `${prefix} ws_mod scratch pad [${reminder.id}]\n该 pad metadata 无法识别。此 role=user 投影不提供可执行清理指令；请参考 role=assistant 的 reminder maintenance reference 或检查持久化记录。`
            : `${prefix} ws_mod scratch pad [${reminder.id}]\nThis pad metadata is not recognized. This role=user projection does not provide executable cleanup instructions; use the role=assistant reminder maintenance reference or inspect persistence.`,
      };
    }
    const meta = reminder.meta;
    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? [
              `${prefix} ws_mod scratch pad [${meta.padId}]`,
              '',
              '这是 ws_mod 管理的大文本临时缓冲区，不是普通提醒项，也不是聊天正文。',
              '正文不会投影到上下文；只显示元信息。若已经应用或不再需要，请尽快删除。',
              '',
              buildPadSummaryContent(language, meta),
            ].join('\n')
          : [
              `${prefix} ws_mod scratch pad [${meta.padId}]`,
              '',
              'This is a ws_mod-managed temporary large-text buffer, not an ordinary reminder and not chat transcript text.',
              'The body is not projected into context; only metadata is shown. Delete it as soon as it has been applied or is no longer needed.',
              '',
              buildPadSummaryContent(language, meta),
            ].join('\n'),
    };
  },
};

function okYaml(yaml: string): ToolCallOutput {
  return toolSuccess(formatYamlCodeBlock(yaml));
}

function failYaml(yaml: string): ToolCallOutput {
  return toolFailure(formatYamlCodeBlock(yaml));
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

type AnchorMatchMode = 'contains' | 'equals';

type FileEofNewlineNormalization = {
  readonly fileEofHasNewline: boolean;
  readonly contentEofHasNewline: boolean;
  readonly normalizedFileEofNewlineAdded: boolean;
  readonly normalizedContentEofNewlineAdded: boolean;
};

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

function generateHunkId(): string {
  // Short, URL-safe, command-friendly id
  return crypto.randomBytes(4).toString('hex');
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
      // - empty file yields 0 lines
      // - trailing '\n' does NOT yield an extra empty "terminator" line
      if (leftover !== '') {
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
  description: 'Read a text file (bounded) relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Read a text file (bounded) relative to rtws (runtime workspace).',
    zh: '读取 rtws（运行时工作区）内的文本文件（有上限/可截断）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'rtws-relative path.' },
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
  call: async (dlg, caller, args: ToolArguments): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    let labels:
      | {
          formatError: string;
          formatErrorWithReason: (msg: string) => string;
          fileLabel: string;
          warningTruncatedByMaxLines: (shown: number, maxLines: number) => string;
          warningTruncatedByCharLimit: (shown: number, maxChars: number) => string;
          warningTruncatedByMaxLinesWithRange: (
            maxLines: number,
            rangeLines: number,
            used: number,
          ) => string;
          hintUseRangeNext: (relPath: string, start: number, end: number) => string;
          hintLargeFileStrategy: (relPath: string) => string;
          sizeLabel: string;
          totalLinesLabel: string;
          emptyFileLabel: string;
          failedToRead: (msg: string) => string;
          invalidFormatMultiToolCalls: (toolName: string) => string;
        }
      | undefined;

    if (language === 'zh') {
      labels = {
        formatError:
          '请使用正确的函数工具参数调用 `read_file`。\n\n' +
          '**期望格式：** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          '注意：可选字段可直接省略。若你显式传入“未指定/默认”，可使用：`range: \"\"`（不指定范围）、`max_lines: 0`（默认 500）。\n\n' +
          '**示例：**\n```text\n{ \"path\": \"src/main.ts\" }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\" }\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **错误：** ${msg}\n\n` +
          '请使用正确的函数工具参数调用 `read_file`。\n\n' +
          '**期望格式：** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          '注意：可选字段可直接省略。若你显式传入“未指定/默认”，可使用：`range: \"\"`（不指定范围）、`max_lines: 0`（默认 500）。\n\n' +
          '**示例：**\n```text\n{ \"path\": \"src/main.ts\" }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\" }\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n```',
        fileLabel: '文件',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **警告：** 输出已截断（最多显示 ${maxLines} 行，当前显示 ${shown} 行）\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **警告：** 输出已截断（字符总数上限约 ${maxChars}，当前显示 ${shown} 行）\n\n`,
        warningTruncatedByMaxLinesWithRange: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **警告：** 输出将被 \`max_lines\`（${maxLines}）截断：\`range\` 共 ${rangeLines} 行，仅返回前 ${used} 行。\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **提示：** 可继续调用 \`read_file\` 读取下一段，例如：\`read_file({ \"path\": \"${relPath}\", \"range\": \"${start}~${end}\", \"max_lines\": 0, \"show_linenos\": true })\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **大文件策略：** 建议分多程分析：每程读取一段、完成总结并整理“接续包”后，在新一程调用函数工具 \`clear_mind({ \"reminder_content\": \"<接续包>\" })\`（降低上下文占用，同时保留可扫读、可行动的恢复信息），再继续读取下一段（例如：\`read_file({ \"path\": \"${relPath}\", \"range\": \"1~500\", \"max_lines\": 0, \"show_linenos\": true })\`、\`read_file({ \"path\": \"${relPath}\", \"range\": \"201~400\", \"max_lines\": 0, \"show_linenos\": true })\`）。\n\n`,
        sizeLabel: '大小',
        totalLinesLabel: '总行数',
        emptyFileLabel: '<空文件>',
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
          'Note: optional fields can be omitted. If you explicitly pass “unset/default”, use `range: \"\"` (unset range) and `max_lines: 0` (default 500).\n\n' +
          '**Examples:**\n```text\n{ \"path\": \"src/main.ts\" }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\" }\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n```',
        formatErrorWithReason: (msg: string) =>
          `❌ **Error:** ${msg}\n\n` +
          'Please call the function tool `read_file` with valid arguments.\n\n' +
          '**Expected:** `read_file({ path, range, max_lines, show_linenos })`\n\n' +
          'Note: optional fields can be omitted. If you explicitly pass “unset/default”, use `range: \"\"` (unset range) and `max_lines: 0` (default 500).\n\n' +
          '**Examples:**\n```text\n{ \"path\": \"src/main.ts\" }\n{ \"path\": \"src/main.ts\", \"range\": \"10~50\" }\n{ \"path\": \"src/main.ts\", \"range\": \"\", \"max_lines\": 0, \"show_linenos\": true }\n```',
        fileLabel: 'File',
        warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
          `⚠️ **Warning:** Output was truncated (max ${maxLines} lines; showing ${shown})\n\n`,
        warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
          `⚠️ **Warning:** Output was truncated (~${maxChars} character cap; showing ${shown} lines)\n\n`,
        warningTruncatedByMaxLinesWithRange: (maxLines: number, rangeLines: number, used: number) =>
          `⚠️ **Warning:** Output will be truncated by \`max_lines\` (${maxLines}): \`range\` has ${rangeLines} lines; returning only the first ${used}.\n\n`,
        hintUseRangeNext: (relPath: string, start: number, end: number) =>
          `💡 **Hint:** Call \`read_file\` again to continue reading, e.g. \`read_file({ \"path\": \"${relPath}\", \"range\": \"${start}~${end}\", \"max_lines\": 0, \"show_linenos\": true })\`\n\n`,
        hintLargeFileStrategy: (relPath: string) =>
          `💡 **Large file strategy:** Analyze in multiple courses: each course read a slice, summarize, and prepare a continuation package; then start a new course and call the function tool \`clear_mind({ \"reminder_content\": \"<continuation package>\" })\` (less context, while preserving scannable resume info) before reading the next slice (e.g. \`read_file({ \"path\": \"${relPath}\", \"range\": \"1~500\", \"max_lines\": 0, \"show_linenos\": true })\`, then \`read_file({ \"path\": \"${relPath}\", \"range\": \"201~400\", \"max_lines\": 0, \"show_linenos\": true })\`).\n\n`,
        sizeLabel: 'Size',
        totalLinesLabel: 'Total lines',
        emptyFileLabel: '<empty file>',
        failedToRead: (msg: string) => `❌ **Error**\n\nFailed to read file: ${msg}`,
        invalidFormatMultiToolCalls: (toolName: string) =>
          `INVALID_FORMAT: Detected what looks like function tool call text mixed into \`read_file\` input (e.g. \`${toolName}\`).\n\n` +
          'Split different tools into separate calls (do not paste `@ripgrep_*` or other function tool call text into `path/range`).',
      };
    }

    // labels is always set above
    if (!labels) {
      throw new Error('Failed to initialize labels');
    }

    const errorMsg = (zh: string, en: string): string => (language === 'zh' ? zh : en);

    const pathValue = args['path'];
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      return toolFailure(labels.formatError);
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
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg('`show_linenos` 必须是 boolean', '`show_linenos` must be a boolean'),
        ),
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
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg(
            '`max_lines` 必须是正整数（或传 0 表示默认值）',
            '`max_lines` must be a positive integer (or 0 for default)',
          ),
        ),
      );
    }

    const rangeValue = args['range'];
    const rangeStr =
      rangeValue === undefined ? '' : typeof rangeValue === 'string' ? rangeValue.trim() : null;
    if (rangeStr === null) {
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg(
            '`range` 必须是 string（传 \"\" 表示不指定）',
            '`range` must be a string (use "" for unset)',
          ),
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
      return toolFailure(labels.invalidFormatMultiToolCalls(suspiciousTool));
    }

    const options: ReadFileOptions = { decorateLinenos: showLinenos, maxLines };
    if (rangeSpecified) {
      const match = rangeStr.match(/^(\d+)?~(\d+)?$/);
      if (!match) {
        return toolFailure(
          labels.formatErrorWithReason(
            errorMsg(
              '`range` 无效（期望：\"start~end\" / \"start~\" / \"~end\" / \"~\"）',
              'Invalid `range` (expected "start~end" / "start~" / "~end" / "~")',
            ),
          ),
        );
      }
      const [, startStr, endStr] = match;
      if (startStr) {
        const start = Number.parseInt(startStr, 10);
        if (!Number.isFinite(start) || start <= 0) {
          return toolFailure(
            labels.formatErrorWithReason(
              errorMsg(
                '`range` 起始行号无效（必须是正整数）',
                'Invalid `range` start (must be a positive integer)',
              ),
            ),
          );
        }
        options.rangeStart = start;
      }
      if (endStr) {
        const end = Number.parseInt(endStr, 10);
        if (!Number.isFinite(end) || end <= 0) {
          return toolFailure(
            labels.formatErrorWithReason(
              errorMsg(
                '`range` 结束行号无效（必须是正整数）',
                'Invalid `range` end (must be a positive integer)',
              ),
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
        return toolFailure(
          labels.formatErrorWithReason(
            errorMsg('`range` 无效（start 必须 <= end）', 'Invalid `range` (start must be <= end)'),
          ),
        );
      }
    }

    const flags = { maxLinesSpecified, rangeSpecified };

    try {
      // Check member access permissions
      if (!hasReadAccess(caller, rel)) {
        return toolFailure(getAccessDeniedMessage('read', rel, language));
      }

      const file = ensureInsideWorkspace(rel);
      const stat = await fs.stat(file);
      const contentSummary = await readFileContentBounded(file, options);

      const maxLinesRangeMismatch: { maxLines: number; rangeLines: number; used: number } | null =
        contentSummary.truncatedByMaxLines &&
        flags.maxLinesSpecified &&
        flags.rangeSpecified &&
        options.rangeEnd !== undefined
          ? (() => {
              const rangeStart = options.rangeStart ?? 1;
              const rangeLines = options.rangeEnd - rangeStart + 1;
              if (rangeLines > options.maxLines) {
                return { maxLines: options.maxLines, rangeLines, used: options.maxLines };
              }
              return null;
            })()
          : null;

      const headerSummary =
        language === 'zh'
          ? `read_file：${rel}；size=${stat.size} bytes；total_lines=${contentSummary.totalLines}；shown=${contentSummary.shownLines}.`
          : `read_file: ${rel}; size=${stat.size} bytes; total_lines=${contentSummary.totalLines}; shown=${contentSummary.shownLines}.`;

      const yaml = [
        `status: ok`,
        `mode: read_file`,
        `path: ${yamlQuote(rel)}`,
        `size_bytes: ${stat.size}`,
        `total_lines: ${contentSummary.totalLines}`,
        `shown_lines: ${contentSummary.shownLines}`,
        `truncated_by_max_lines: ${contentSummary.truncatedByMaxLines}`,
        `truncated_by_char_limit: ${contentSummary.truncatedByCharLimit}`,
        `summary: ${yamlQuote(headerSummary)}`,
      ].join('\n');

      // Create markdown response (human-friendly body after a structured YAML header)
      let markdown = `${formatYamlCodeBlock(yaml)}\n\n`;
      markdown += `📄 **${labels.fileLabel}:** \`${rel}\`\n`;

      if (maxLinesRangeMismatch) {
        markdown += labels.warningTruncatedByMaxLinesWithRange(
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
      } else if (contentSummary.truncatedByMaxLines && !maxLinesRangeMismatch) {
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
      if (contentSummary.totalLines === 0) {
        markdown += `\n${labels.emptyFileLabel}\n`;
      }
      markdown += '\n';

      if (contentSummary.totalLines > 0) {
        // Add file content with code block formatting
        markdown += '```\n';
        markdown += contentSummary.formattedContent;
        if (!contentSummary.formattedContent.endsWith('\n')) {
          markdown += '\n';
        }
        markdown += '```';
      }

      return toolSuccess(markdown);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message === 'Invalid format' || error.message === 'Path required')
      ) {
        return toolFailure(labels.formatError);
      }

      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(labels.failedToRead(msg));
    }
  },
} satisfies FuncTool;

export const fsReadFileTool = {
  type: 'func',
  name: 'fs_read_file',
  description:
    'Read a bounded local filesystem text file without restricting paths to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Read a bounded local filesystem text file without restricting paths to rtws (runtime workspace).',
    zh: '读取本机文件系统文本文件（有上限/可截断），不限制路径必须位于 rtws（运行时工作区）内。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description:
          'File path. Absolute paths are accepted; relative paths resolve from the current process cwd.',
      },
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
  call: async (_dlg, _caller, args: ToolArguments): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            formatError:
              '请使用正确的函数工具参数调用 `fs_read_file`。\n\n' +
              '**期望格式：** `fs_read_file({ path, range, max_lines, show_linenos })`\n\n' +
              '注意：`path` 可为绝对路径，或相对当前进程 cwd 的路径；可选字段可直接省略。若你显式传入“未指定/默认”，可使用：`range: ""`（不指定范围）、`max_lines: 0`（默认 500）。',
            formatErrorWithReason: (msg: string) =>
              `❌ **错误：** ${msg}\n\n请使用正确的函数工具参数调用 \`fs_read_file\`。`,
            fileLabel: '文件',
            warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
              `⚠️ **警告：** 输出已截断（最多显示 ${maxLines} 行，当前显示 ${shown} 行）\n\n`,
            warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
              `⚠️ **警告：** 输出已截断（字符总数上限约 ${maxChars}，当前显示 ${shown} 行）\n\n`,
            warningTruncatedByMaxLinesWithRange: (
              maxLines: number,
              rangeLines: number,
              used: number,
            ) =>
              `⚠️ **警告：** 输出将被 \`max_lines\`（${maxLines}）截断：\`range\` 共 ${rangeLines} 行，仅返回前 ${used} 行。\n\n`,
            hintUseRangeNext: (filePath: string, start: number, end: number) =>
              `💡 **提示：** 可继续调用 \`fs_read_file\` 读取下一段，例如：\`fs_read_file({ "path": "${filePath}", "range": "${start}~${end}", "max_lines": 0, "show_linenos": true })\`\n\n`,
            hintLargeFileStrategy: (filePath: string) =>
              `💡 **大文件策略：** 建议分多程分析，每程读取一段并整理接续信息，再继续读取下一段（例如：\`fs_read_file({ "path": "${filePath}", "range": "1~500", "max_lines": 0, "show_linenos": true })\`）。\n\n`,
            sizeLabel: '大小',
            totalLinesLabel: '总行数',
            emptyFileLabel: '<空文件>',
            failedToRead: (msg: string) => `❌ **错误**\n\n读取文件失败：${msg}`,
            invalidFormatMultiToolCalls: (toolName: string) =>
              `INVALID_FORMAT：检测到疑似把多个工具调用文本混入了 \`fs_read_file\` 的输入（例如出现 \`${toolName}\`）。\n\n请把不同工具拆分为独立调用。`,
          }
        : {
            formatError:
              'Please call the function tool `fs_read_file` with valid arguments.\n\n' +
              '**Expected:** `fs_read_file({ path, range, max_lines, show_linenos })`\n\n' +
              'Note: `path` may be absolute or relative to the current process cwd. Optional fields can be omitted. If you explicitly pass “unset/default”, use `range: ""` (unset range) and `max_lines: 0` (default 500).',
            formatErrorWithReason: (msg: string) =>
              `❌ **Error:** ${msg}\n\nPlease call the function tool \`fs_read_file\` with valid arguments.`,
            fileLabel: 'File',
            warningTruncatedByMaxLines: (shown: number, maxLines: number) =>
              `⚠️ **Warning:** Output was truncated (max ${maxLines} lines; showing ${shown})\n\n`,
            warningTruncatedByCharLimit: (shown: number, maxChars: number) =>
              `⚠️ **Warning:** Output was truncated (~${maxChars} character cap; showing ${shown} lines)\n\n`,
            warningTruncatedByMaxLinesWithRange: (
              maxLines: number,
              rangeLines: number,
              used: number,
            ) =>
              `⚠️ **Warning:** Output will be truncated by \`max_lines\` (${maxLines}): \`range\` has ${rangeLines} lines; returning only the first ${used}.\n\n`,
            hintUseRangeNext: (filePath: string, start: number, end: number) =>
              `💡 **Hint:** Call \`fs_read_file\` again to continue reading, e.g. \`fs_read_file({ "path": "${filePath}", "range": "${start}~${end}", "max_lines": 0, "show_linenos": true })\`\n\n`,
            hintLargeFileStrategy: (filePath: string) =>
              `💡 **Large file strategy:** Analyze in slices and continue with another \`fs_read_file\` range, e.g. \`fs_read_file({ "path": "${filePath}", "range": "1~500", "max_lines": 0, "show_linenos": true })\`.\n\n`,
            sizeLabel: 'Size',
            totalLinesLabel: 'Total lines',
            emptyFileLabel: '<empty file>',
            failedToRead: (msg: string) => `❌ **Error**\n\nFailed to read file: ${msg}`,
            invalidFormatMultiToolCalls: (toolName: string) =>
              `INVALID_FORMAT: Detected what looks like function tool call text mixed into \`fs_read_file\` input (e.g. \`${toolName}\`).\n\nSplit different tools into separate calls.`,
          };

    const errorMsg = (zh: string, en: string): string => (language === 'zh' ? zh : en);

    const pathValue = args['path'];
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      return toolFailure(labels.formatError);
    }
    const requestedPath = pathValue.trim();
    const absPath = resolveLocalFilesystemPath(requestedPath);
    const displayPath = displayLocalFilesystemPath(requestedPath, absPath);

    const showLinenosValue = args['show_linenos'];
    const showLinenos =
      showLinenosValue === undefined
        ? true
        : typeof showLinenosValue === 'boolean'
          ? showLinenosValue
          : null;
    if (showLinenos === null) {
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg('`show_linenos` 必须是 boolean', '`show_linenos` must be a boolean'),
        ),
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
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg(
            '`max_lines` 必须是正整数（或传 0 表示默认值）',
            '`max_lines` must be a positive integer (or 0 for default)',
          ),
        ),
      );
    }

    const rangeValue = args['range'];
    const rangeStr =
      rangeValue === undefined ? '' : typeof rangeValue === 'string' ? rangeValue.trim() : null;
    if (rangeStr === null) {
      return toolFailure(
        labels.formatErrorWithReason(
          errorMsg(
            '`range` 必须是 string（传 "" 表示不指定）',
            '`range` must be a string (use "" for unset)',
          ),
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
      detectMultiToolCalls(requestedPath) ??
      (rangeSpecified ? detectMultiToolCalls(rangeStr) : null);
    if (suspiciousTool) {
      return toolFailure(labels.invalidFormatMultiToolCalls(suspiciousTool));
    }

    const options: ReadFileOptions = { decorateLinenos: showLinenos, maxLines };
    if (rangeSpecified) {
      const match = rangeStr.match(/^(\d+)?~(\d+)?$/);
      if (!match) {
        return toolFailure(
          labels.formatErrorWithReason(
            errorMsg(
              '`range` 无效（期望："start~end" / "start~" / "~end" / "~"）',
              'Invalid `range` (expected "start~end" / "start~" / "~end" / "~")',
            ),
          ),
        );
      }
      const [, startStr, endStr] = match;
      if (startStr) {
        const start = Number.parseInt(startStr, 10);
        if (!Number.isFinite(start) || start <= 0) {
          return toolFailure(
            labels.formatErrorWithReason(
              errorMsg(
                '`range` 起始行号无效（必须是正整数）',
                'Invalid `range` start (must be a positive integer)',
              ),
            ),
          );
        }
        options.rangeStart = start;
      }
      if (endStr) {
        const end = Number.parseInt(endStr, 10);
        if (!Number.isFinite(end) || end <= 0) {
          return toolFailure(
            labels.formatErrorWithReason(
              errorMsg(
                '`range` 结束行号无效（必须是正整数）',
                'Invalid `range` end (must be a positive integer)',
              ),
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
        return toolFailure(
          labels.formatErrorWithReason(
            errorMsg('`range` 无效（start 必须 <= end）', 'Invalid `range` (start must be <= end)'),
          ),
        );
      }
    }

    try {
      const stat = await fs.stat(absPath);
      const contentSummary = await readFileContentBounded(absPath, options);

      const maxLinesRangeMismatch: { maxLines: number; rangeLines: number; used: number } | null =
        contentSummary.truncatedByMaxLines &&
        maxLinesSpecified &&
        rangeSpecified &&
        options.rangeEnd !== undefined
          ? (() => {
              const rangeStart = options.rangeStart ?? 1;
              const rangeLines = options.rangeEnd - rangeStart + 1;
              if (rangeLines > options.maxLines) {
                return { maxLines: options.maxLines, rangeLines, used: options.maxLines };
              }
              return null;
            })()
          : null;

      const headerSummary =
        language === 'zh'
          ? `fs_read_file：${displayPath}；size=${stat.size} bytes；total_lines=${contentSummary.totalLines}；shown=${contentSummary.shownLines}.`
          : `fs_read_file: ${displayPath}; size=${stat.size} bytes; total_lines=${contentSummary.totalLines}; shown=${contentSummary.shownLines}.`;

      const yaml = [
        `status: ok`,
        `mode: fs_read_file`,
        `path: ${yamlQuote(displayPath)}`,
        `size_bytes: ${stat.size}`,
        `total_lines: ${contentSummary.totalLines}`,
        `shown_lines: ${contentSummary.shownLines}`,
        `truncated_by_max_lines: ${contentSummary.truncatedByMaxLines}`,
        `truncated_by_char_limit: ${contentSummary.truncatedByCharLimit}`,
        `summary: ${yamlQuote(headerSummary)}`,
      ].join('\n');

      let markdown = `${formatYamlCodeBlock(yaml)}\n\n`;
      markdown += `📄 **${labels.fileLabel}:** \`${displayPath}\`\n`;

      if (maxLinesRangeMismatch) {
        markdown += labels.warningTruncatedByMaxLinesWithRange(
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
      } else if (contentSummary.truncatedByMaxLines && !maxLinesRangeMismatch) {
        markdown += labels.warningTruncatedByMaxLines(contentSummary.shownLines, options.maxLines);
      }

      if (
        (contentSummary.truncatedByCharLimit || contentSummary.truncatedByMaxLines) &&
        !maxLinesSpecified &&
        !rangeSpecified
      ) {
        const start = contentSummary.shownLines + 1;
        const end = start + 199;
        markdown += labels.hintUseRangeNext(displayPath, start, end);
      }

      if (contentSummary.truncatedByCharLimit) {
        markdown += labels.hintLargeFileStrategy(displayPath);
      }

      markdown += `**${labels.sizeLabel}:** ${stat.size} bytes\n`;
      markdown += `**${labels.totalLinesLabel}:** ${contentSummary.totalLines}\n`;
      if (contentSummary.totalLines === 0) {
        markdown += `\n${labels.emptyFileLabel}\n`;
      }
      markdown += '\n';

      if (contentSummary.totalLines > 0) {
        markdown += '```\n';
        markdown += contentSummary.formattedContent;
        if (!contentSummary.formattedContent.endsWith('\n')) {
          markdown += '\n';
        }
        markdown += '```';
      }

      return toolSuccess(markdown);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return toolFailure(labels.failedToRead(msg));
    }
  },
} satisfies FuncTool;

type OverwriteContentFormat = string;

type FileBodySource =
  | Readonly<{
      kind: 'content';
      text: string;
      redacted: false;
    }>
  | Readonly<{
      kind: 'pad';
      padId: string;
      padRange: string;
      padHash: string;
      selectedText: string;
      selectedHash: string;
      redacted: true;
    }>;

function resolveFileBodySource(
  dlg: Dialog,
  args: ToolArguments,
  options: Readonly<{ allowMissingContent: boolean }>,
): FileBodySource {
  const rawPadId = optionalNonEmptyStringArg(args, 'pad_id');
  const hasPadSource = rawPadId !== undefined;
  const contentValue = optionalStringArg(args, 'content');
  const hasContentSource =
    contentValue !== undefined && !(hasPadSource && contentValue.trim() === '');

  if (hasPadSource && hasContentSource) {
    throw new Error('Provide either `content` or `pad_id`, not both');
  }
  if (!hasPadSource && hasOwnArg(args, 'pad_range')) {
    const padRange = optionalStringArg(args, 'pad_range');
    if (padRange !== undefined && padRange.trim() !== '') {
      throw new Error('`pad_range` requires `pad_id`');
    }
  }
  if (!hasPadSource && contentValue === undefined && !options.allowMissingContent) {
    throw new Error('Provide `content`, or provide `pad_id` with optional `pad_range`');
  }
  if (!hasPadSource) {
    return { kind: 'content', text: contentValue ?? '', redacted: false };
  }

  const padId = normalizePadId(rawPadId);
  const padRange = parseOptionalPadRange(args, 'pad_range');
  const pad = requireDialogPadById(dlg, padId);
  const selectedText = selectTextByLineRange(pad.meta.text, padRange);
  return {
    kind: 'pad',
    padId,
    padRange,
    padHash: hashPadText(pad.meta.text),
    selectedText,
    selectedHash: hashPadText(selectedText),
    redacted: true,
  };
}

function fileBodySourceText(source: FileBodySource): string {
  return source.kind === 'content' ? source.text : source.selectedText;
}

function pushFileBodySourceYaml(lines: string[], source: FileBodySource, showBody: boolean): void {
  lines.push(`source: ${source.kind}`, `redacted: ${source.redacted && !showBody}`);
  if (source.kind === 'pad') {
    lines.push(
      `pad_id: ${yamlQuote(source.padId)}`,
      `pad_range: ${yamlQuote(source.padRange)}`,
      `pad_hash: ${yamlQuote(source.padHash)}`,
      `pad_selected_lines: ${countPadLines(source.selectedText)}`,
      `pad_selected_bytes: ${Buffer.byteLength(source.selectedText, 'utf8')}`,
      `pad_selected_hash: ${yamlQuote(source.selectedHash)}`,
    );
  }
}

const overwriteEntireFileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'rtws-relative path to an existing file to overwrite.',
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
        'The new full file content. If non-empty and missing a trailing newline, Dominds will append one. Omit when using pad_id.',
    },
    pad_id: {
      type: 'string',
      description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
    },
    pad_range: {
      type: 'string',
      description: "Optional source pad line range. Defaults to '~' (entire pad).",
    },
    content_format: {
      type: 'string',
      description:
        "Optional content format hint. Any non-empty string is accepted (for example: yaml, toml, json, markdown). If omitted (or empty string), Dominds refuses to overwrite when content looks like a diff/patch (use prepare/apply instead). Use 'diff' or 'patch' to explicitly allow writing diff/patch text literally.",
    },
  },
  required: ['path', 'known_old_total_lines', 'known_old_total_bytes'],
} as const;

function parseCreateNewFilePath(args: ToolArguments): string {
  const pathValue = args['path'];
  if (typeof pathValue !== 'string' || pathValue.trim() === '') {
    throw new Error('Invalid `path` (expected non-empty string)');
  }
  return pathValue;
}

function parseOverwriteContentFormat(value: unknown): OverwriteContentFormat | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed;
}

function parseOverwriteEntireFileArgs(args: ToolArguments): {
  path: string;
  knownOldTotalLines: number;
  knownOldTotalBytes: number;
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

  const rawContentFormat = args['content_format'];
  let contentFormat: OverwriteContentFormat | undefined;
  if (rawContentFormat === undefined) {
    contentFormat = undefined;
  } else if (typeof rawContentFormat === 'string') {
    if (rawContentFormat.trim() === '') {
      contentFormat = undefined;
    } else {
      contentFormat = parseOverwriteContentFormat(rawContentFormat);
    }
  } else {
    throw new Error('Invalid `content_format` (expected string)');
  }

  return {
    path: pathValue,
    // Guardrails are expected to come from `read_file`'s YAML header:
    // - `total_lines` → known_old_total_lines
    // - `size_bytes`  → known_old_total_bytes
    knownOldTotalLines: knownOldTotalLinesValue,
    knownOldTotalBytes: knownOldTotalBytesValue,
    contentFormat,
  };
}

export const createNewFileTool: FuncTool = {
  type: 'func',
  name: 'create_new_file',
  description:
    'Create a new file from inline content or ws_mod pad content (no prepare/apply). Refuses to overwrite existing files.',
  descriptionI18n: {
    en: 'Create a new file from inline content or ws_mod pad content (no prepare/apply). Refuses to overwrite existing files.',
    zh: '用内联 content 或 ws_mod pad 内容创建一个新文件（不走 prepare/apply）。若文件已存在则拒绝覆写。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'rtws-relative path to create.' },
      content: {
        type: 'string',
        description:
          'Optional initial content. Empty string is allowed. If non-empty and missing a trailing newline, Dominds will append one. Omit when using pad_id.',
      },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
    },
    required: ['path'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args: ToolArguments): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    const t =
      language === 'zh'
        ? {
            invalidArgs: (msg: string) => `参数不正确：${msg}`,
            fileExists: '文件已存在，拒绝创建。',
            notAFile: '路径已存在但不是文件（可能是目录），拒绝创建。',
            nextOverwrite:
              '下一步：先用 read_file 获取 total_lines/size_bytes，然后再调用 overwrite_entire_file 覆盖写入。',
            ok: '已创建新文件。',
          }
        : {
            invalidArgs: (msg: string) => `Invalid args: ${msg}`,
            fileExists: 'File already exists; refusing to create.',
            notAFile: 'Path exists but is not a file (e.g. a directory); refusing to create.',
            nextOverwrite:
              'Next: call read_file to get total_lines/size_bytes, then use overwrite_entire_file to overwrite.',
            ok: 'Created new file.',
          };

    const parsed = (() => {
      try {
        return {
          path: parseCreateNewFilePath(args),
          source: resolveFileBodySource(dlg, args, { allowMissingContent: true }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { __error: msg } as const;
      }
    })();
    if ('__error' in parsed) {
      const errorSummary = typeof parsed.__error === 'string' ? parsed.__error : 'Unknown error';
      return failYaml(
        [
          `status: error`,
          `mode: create_new_file`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(t.invalidArgs(errorSummary))}`,
        ].join('\n'),
      );
    }

    const content = fileBodySourceText(parsed.source);

    if (!hasWriteAccess(caller, parsed.path)) {
      return toolFailure(getAccessDeniedMessage('write', parsed.path, language));
    }

    let absPath: string;
    try {
      absPath = ensureInsideWorkspace(parsed.path);
    } catch (err: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: create_new_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: INVALID_PATH`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
    }

    if (fsSync.existsSync(absPath)) {
      let s: fsSync.Stats;
      try {
        s = fsSync.statSync(absPath);
      } catch (err: unknown) {
        return failYaml(
          [
            `status: error`,
            `mode: create_new_file`,
            `path: ${yamlQuote(parsed.path)}`,
            `error: FAILED`,
            `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
          ].join('\n'),
        );
      }

      if (!s.isFile()) {
        return failYaml(
          [
            `status: error`,
            `mode: create_new_file`,
            `path: ${yamlQuote(parsed.path)}`,
            `error: NOT_A_FILE`,
            `summary: ${yamlQuote(t.notAFile)}`,
          ].join('\n'),
        );
      }

      return failYaml(
        [
          `status: error`,
          `mode: create_new_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: FILE_EXISTS`,
          `summary: ${yamlQuote(t.fileExists)}`,
          `next: ${yamlQuote(t.nextOverwrite)}`,
        ].join('\n'),
      );
    }

    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(content);
    try {
      fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
      fsSync.writeFileSync(absPath, normalizedBody, 'utf8');
    } catch (err: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: create_new_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
    }

    const newTotalBytes = Buffer.byteLength(normalizedBody, 'utf8');
    const newTotalLines = splitTextToLinesForEditing(normalizedBody).length;
    const normalizedNewlineAdded = addedTrailingNewlineToContent && normalizedBody !== '';
    const okSummary =
      language === 'zh'
        ? `${t.ok} path=${parsed.path}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`
        : `${t.ok} path=${parsed.path}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`;
    const yamlLines = [`status: ok`, `mode: create_new_file`, `path: ${yamlQuote(parsed.path)}`];
    pushFileBodySourceYaml(yamlLines, parsed.source, false);
    yamlLines.push(
      `new_total_lines: ${newTotalLines}`,
      `new_total_bytes: ${newTotalBytes}`,
      `normalized_trailing_newline_added: ${normalizedNewlineAdded}`,
      `summary: ${yamlQuote(okSummary)}`,
    );
    return okYaml(yamlLines.join('\n'));
  },
};

export const padWriteTool: FuncTool = {
  type: 'func',
  name: 'pad_write',
  description:
    'Create, replace, append to, or upsert a ws_mod scratch pad. The tool result never echoes pad body text.',
  descriptionI18n: {
    en: 'Create, replace, append to, or upsert a ws_mod scratch pad. The tool result never echoes pad body text.',
    zh: '创建、替换、追加或 upsert 一个 ws_mod scratch pad。工具结果不会回显 pad 正文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id', 'content'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      content: {
        type: 'string',
        description:
          'Pad body text. Large content is allowed, but it will still be persisted as tool-call arguments.',
      },
      mode: {
        type: 'string',
        enum: ['', 'create', 'replace', 'append', 'upsert'],
        description: 'Write mode. Defaults to upsert.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const content = optionalStringArg(args, 'content') ?? '';
      const mode = parsePadWriteMode(args['mode']);
      const existing = findDialogPadById(dlg, padId);
      if (mode === 'create' && existing !== undefined) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_write`,
            `pad_id: ${yamlQuote(padId)}`,
            `error: PAD_ALREADY_EXISTS`,
            `summary: ${yamlQuote(`pad_id=${padId} already exists`)}`,
          ].join('\n'),
        );
      }
      if ((mode === 'replace' || mode === 'append') && existing === undefined) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_write`,
            `pad_id: ${yamlQuote(padId)}`,
            `error: PAD_NOT_FOUND`,
            `summary: ${yamlQuote(`pad_id=${padId} does not exist`)}`,
          ].join('\n'),
        );
      }
      const nextText =
        mode === 'append' && existing !== undefined ? `${existing.meta.text}${content}` : content;
      upsertDialogPad(dlg, padId, nextText);
      return okYaml(
        formatPadResultYaml(
          'pad_write',
          padId,
          nextText,
          `pad_id=${padId} ${mode === 'append' ? 'appended' : 'written'}`,
        ),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_write`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padLoadFileRangeTool: FuncTool = {
  type: 'func',
  name: 'pad_load_file_range',
  description:
    'Load a rtws file or file line range into a ws_mod scratch pad without echoing the selected text.',
  descriptionI18n: {
    en: 'Load a rtws file or file line range into a ws_mod scratch pad without echoing the selected text.',
    zh: '把 rtws 文件或文件行范围装入 ws_mod scratch pad，且不回显选中文本。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id', 'path'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      path: { type: 'string', description: 'rtws-relative file path.' },
      range: {
        type: 'string',
        description: "Optional line range: '10~50' | '300~' | '~20' | '~'. Defaults to '~'.",
      },
      mode: {
        type: 'string',
        enum: ['', 'create', 'replace', 'append', 'upsert'],
        description: 'Write mode. Defaults to upsert.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const filePath = requireNonEmptyStringArg(args, 'path');
      const range = optionalNonEmptyStringArg(args, 'range') ?? '~';
      const mode = parsePadWriteMode(args['mode']);
      if (!hasReadAccess(caller, filePath)) {
        return toolFailure(getAccessDeniedMessage('read', filePath, getWorkLanguage()));
      }
      const existing = findDialogPadById(dlg, padId);
      if (mode === 'create' && existing !== undefined) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_load_file_range`,
            `pad_id: ${yamlQuote(padId)}`,
            `error: PAD_ALREADY_EXISTS`,
            `summary: ${yamlQuote(`pad_id=${padId} already exists`)}`,
          ].join('\n'),
        );
      }
      if ((mode === 'replace' || mode === 'append') && existing === undefined) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_load_file_range`,
            `pad_id: ${yamlQuote(padId)}`,
            `error: PAD_NOT_FOUND`,
            `summary: ${yamlQuote(`pad_id=${padId} does not exist`)}`,
          ].join('\n'),
        );
      }
      const absPath = ensureInsideWorkspace(filePath);
      const raw = await fs.readFile(absPath, 'utf8');
      const selectedText = selectTextByLineRange(raw, range);
      const nextText =
        mode === 'append' && existing !== undefined
          ? `${existing.meta.text}${selectedText}`
          : selectedText;
      upsertDialogPad(dlg, padId, nextText);
      return okYaml(
        formatPadResultYaml(
          'pad_load_file_range',
          padId,
          nextText,
          `loaded ${filePath}:${range} into pad_id=${padId}`,
        ),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_load_file_range`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padEditTool: FuncTool = {
  type: 'func',
  name: 'pad_edit',
  description:
    'Replace, delete, or append by line range inside an existing ws_mod scratch pad. The result never echoes pad body text.',
  descriptionI18n: {
    en: 'Replace, delete, or append by line range inside an existing ws_mod scratch pad. The result never echoes pad body text.',
    zh: '在已有 ws_mod scratch pad 内按行范围替换、删除或追加。工具结果不会回显 pad 正文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id', 'range'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      range: { type: 'string', description: "Line range: '10~50' | '300~' | '~20' | '~'." },
      content: {
        type: 'string',
        description: 'Replacement text. Empty string deletes the selected range.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const range = requireNonEmptyStringArg(args, 'range');
      const content = optionalStringArg(args, 'content') ?? '';
      const existing = findDialogPadById(dlg, padId);
      if (existing === undefined) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_edit`,
            `pad_id: ${yamlQuote(padId)}`,
            `error: PAD_NOT_FOUND`,
            `summary: ${yamlQuote(`pad_id=${padId} does not exist`)}`,
          ].join('\n'),
        );
      }
      const nextText = applyTextLineRangeEdit(existing.meta.text, range, content);
      upsertDialogPad(dlg, padId, nextText);
      return okYaml(formatPadResultYaml('pad_edit', padId, nextText, `edited pad_id=${padId}`));
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_edit`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padInsertTool: FuncTool = {
  type: 'func',
  name: 'pad_insert',
  description:
    'Insert text before a 1-based line position inside an existing ws_mod scratch pad. The result never echoes pad body text.',
  descriptionI18n: {
    en: 'Insert text before a 1-based line position inside an existing ws_mod scratch pad. The result never echoes pad body text.',
    zh: '在已有 ws_mod scratch pad 的 1-based 行位置之前插入文本。工具结果不会回显 pad 正文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id', 'line', 'content'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      line: {
        type: 'integer',
        description:
          '1-based insertion position. 1 inserts at the beginning; total_lines + 1 appends.',
      },
      content: {
        type: 'string',
        description: 'Inserted text. Empty string is a no-op.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const line = optionalIntegerArg(args, 'line');
      if (line === undefined) {
        throw new Error('Invalid arguments: `line` must be an integer');
      }
      const content = optionalStringArg(args, 'content') ?? '';
      const existing = requireDialogPadById(dlg, padId);
      const nextText = insertTextAtLinePosition(existing.meta.text, line, content);
      upsertDialogPad(dlg, padId, nextText);
      return okYaml(
        formatPadResultYaml(
          'pad_insert',
          padId,
          nextText,
          `inserted text before line ${line} in pad_id=${padId}`,
        ),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_insert`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padDeleteRangeTool: FuncTool = {
  type: 'func',
  name: 'pad_delete_range',
  description:
    'Delete a line range inside an existing ws_mod scratch pad. The result never echoes pad body text.',
  descriptionI18n: {
    en: 'Delete a line range inside an existing ws_mod scratch pad. The result never echoes pad body text.',
    zh: '删除已有 ws_mod scratch pad 内的行范围。工具结果不会回显 pad 正文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id', 'range'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      range: { type: 'string', description: "Line range: '10~50' | '300~' | '~20' | '~'." },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const range = requireNonEmptyStringArg(args, 'range');
      const existing = requireDialogPadById(dlg, padId);
      const nextText = applyTextLineRangeEdit(existing.meta.text, range, '');
      upsertDialogPad(dlg, padId, nextText);
      return okYaml(
        formatPadResultYaml(
          'pad_delete_range',
          padId,
          nextText,
          `deleted range in pad_id=${padId}`,
        ),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_delete_range`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padCopyTool: FuncTool = {
  type: 'func',
  name: 'pad_copy',
  description:
    'Copy a line range from one ws_mod scratch pad into another pad or another range of the same pad. The result never echoes copied body text.',
  descriptionI18n: {
    en: 'Copy a line range from one ws_mod scratch pad into another pad or another range of the same pad. The result never echoes copied body text.',
    zh: '把一个 ws_mod scratch pad 的行范围复制到另一个 pad，或同一 pad 的另一个范围。工具结果不会回显复制正文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from_pad_id', 'to_pad_id'],
    properties: {
      from_pad_id: {
        type: 'string',
        description: 'Source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      from_range: {
        type: 'string',
        description: "Source line range. Defaults to '~' (entire pad).",
      },
      to_pad_id: {
        type: 'string',
        description: 'Target scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      to_range: {
        type: 'string',
        description:
          "Target line range to replace, or append position like 'N~'. Defaults to '~'. If target pad does not exist, '~' creates it.",
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const fromPadId = normalizePadId(requireNonEmptyStringArg(args, 'from_pad_id'));
      const toPadId = normalizePadId(requireNonEmptyStringArg(args, 'to_pad_id'));
      const fromRange = parseOptionalPadRange(args, 'from_range');
      const toRange = parseOptionalPadRange(args, 'to_range');
      const source = requireDialogPadById(dlg, fromPadId);
      const copiedText = selectTextByLineRange(source.meta.text, fromRange);
      const target = findDialogPadById(dlg, toPadId);
      if (target === undefined) {
        if (toRange !== '~') {
          return failYaml(
            [
              `status: error`,
              `mode: pad_copy`,
              `from_pad_id: ${yamlQuote(fromPadId)}`,
              `to_pad_id: ${yamlQuote(toPadId)}`,
              `error: PAD_NOT_FOUND`,
              `summary: ${yamlQuote('Target pad does not exist; omit to_range or use "~" to create it from the copied text.')}`,
            ].join('\n'),
          );
        }
        upsertDialogPad(dlg, toPadId, copiedText);
      } else {
        const nextText = applyTextLineRangeEdit(target.meta.text, toRange, copiedText);
        upsertDialogPad(dlg, toPadId, nextText);
      }
      const updatedTarget = requireDialogPadById(dlg, toPadId);
      return okYaml(
        [
          `status: ok`,
          `mode: pad_copy`,
          `from_pad_id: ${yamlQuote(fromPadId)}`,
          `from_range: ${yamlQuote(fromRange)}`,
          `to_pad_id: ${yamlQuote(toPadId)}`,
          `to_range: ${yamlQuote(toRange)}`,
          `target_lines: ${countPadLines(updatedTarget.meta.text)}`,
          `target_bytes: ${Buffer.byteLength(updatedTarget.meta.text, 'utf8')}`,
          `target_hash: ${yamlQuote(hashPadText(updatedTarget.meta.text))}`,
          `summary: ${yamlQuote(`copied ${fromPadId}:${fromRange} to ${toPadId}:${toRange}`)}`,
        ].join('\n'),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_copy`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padMoveTool: FuncTool = {
  type: 'func',
  name: 'pad_move',
  description:
    'Move a line range from one ws_mod scratch pad into another pad. Same-pad moves are rejected to avoid ambiguous shifting ranges.',
  descriptionI18n: {
    en: 'Move a line range from one ws_mod scratch pad into another pad. Same-pad moves are rejected to avoid ambiguous shifting ranges.',
    zh: '把一个 ws_mod scratch pad 的行范围移动到另一个 pad。为避免范围位移歧义，拒绝同 pad move。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from_pad_id', 'to_pad_id'],
    properties: {
      from_pad_id: {
        type: 'string',
        description: 'Source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      from_range: {
        type: 'string',
        description: "Source line range. Defaults to '~' (entire pad).",
      },
      to_pad_id: {
        type: 'string',
        description: 'Target scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      to_range: {
        type: 'string',
        description:
          "Target line range to replace, or append position like 'N~'. Defaults to '~'. If target pad does not exist, '~' creates it.",
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const fromPadId = normalizePadId(requireNonEmptyStringArg(args, 'from_pad_id'));
      const toPadId = normalizePadId(requireNonEmptyStringArg(args, 'to_pad_id'));
      if (fromPadId === toPadId) {
        return failYaml(
          [
            `status: error`,
            `mode: pad_move`,
            `pad_id: ${yamlQuote(fromPadId)}`,
            `error: SAME_PAD_MOVE_UNSUPPORTED`,
            `summary: ${yamlQuote('Use pad_copy plus pad_delete_range, or pad_edit, for same-pad rearrangement.')}`,
          ].join('\n'),
        );
      }
      const fromRange = parseOptionalPadRange(args, 'from_range');
      const toRange = parseOptionalPadRange(args, 'to_range');
      const source = requireDialogPadById(dlg, fromPadId);
      const movedText = selectTextByLineRange(source.meta.text, fromRange);
      const target = findDialogPadById(dlg, toPadId);
      if (target === undefined) {
        if (toRange !== '~') {
          return failYaml(
            [
              `status: error`,
              `mode: pad_move`,
              `from_pad_id: ${yamlQuote(fromPadId)}`,
              `to_pad_id: ${yamlQuote(toPadId)}`,
              `error: PAD_NOT_FOUND`,
              `summary: ${yamlQuote('Target pad does not exist; omit to_range or use "~" to create it from the moved text.')}`,
            ].join('\n'),
          );
        }
        upsertDialogPad(dlg, toPadId, movedText);
      } else {
        const nextTargetText = applyTextLineRangeEdit(target.meta.text, toRange, movedText);
        upsertDialogPad(dlg, toPadId, nextTargetText);
      }
      const nextSourceText = applyTextLineRangeEdit(source.meta.text, fromRange, '');
      upsertDialogPad(dlg, fromPadId, nextSourceText);
      const updatedSource = requireDialogPadById(dlg, fromPadId);
      const updatedTarget = requireDialogPadById(dlg, toPadId);
      return okYaml(
        [
          `status: ok`,
          `mode: pad_move`,
          `from_pad_id: ${yamlQuote(fromPadId)}`,
          `from_range: ${yamlQuote(fromRange)}`,
          `to_pad_id: ${yamlQuote(toPadId)}`,
          `to_range: ${yamlQuote(toRange)}`,
          `source_lines: ${countPadLines(updatedSource.meta.text)}`,
          `source_bytes: ${Buffer.byteLength(updatedSource.meta.text, 'utf8')}`,
          `source_hash: ${yamlQuote(hashPadText(updatedSource.meta.text))}`,
          `target_lines: ${countPadLines(updatedTarget.meta.text)}`,
          `target_bytes: ${Buffer.byteLength(updatedTarget.meta.text, 'utf8')}`,
          `target_hash: ${yamlQuote(hashPadText(updatedTarget.meta.text))}`,
          `summary: ${yamlQuote(`moved ${fromPadId}:${fromRange} to ${toPadId}:${toRange}`)}`,
        ].join('\n'),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_move`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const padDeleteTool: FuncTool = {
  type: 'func',
  name: 'pad_delete',
  description: 'Delete a ws_mod scratch pad by pad_id.',
  descriptionI18n: {
    en: 'Delete a ws_mod scratch pad by pad_id.',
    zh: '按 pad_id 删除 ws_mod scratch pad。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pad_id'],
    properties: {
      pad_id: {
        type: 'string',
        description: 'Agent-chosen scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, _caller, args): Promise<ToolCallOutput> => {
    try {
      const padId = normalizePadId(requireNonEmptyStringArg(args, 'pad_id'));
      const existing = findDialogPadById(dlg, padId);
      if (existing === undefined) {
        const fallbackIndex = findDialogPadReminderIndexByReminderId(dlg, padId);
        if (fallbackIndex === undefined) {
          return failYaml(
            [
              `status: error`,
              `mode: pad_delete`,
              `pad_id: ${yamlQuote(padId)}`,
              `error: PAD_NOT_FOUND`,
              `summary: ${yamlQuote(`pad_id=${padId} does not exist`)}`,
            ].join('\n'),
          );
        }
        dlg.deleteReminder(fallbackIndex);
        return okYaml(
          [
            `status: ok`,
            `mode: pad_delete`,
            `pad_id: ${yamlQuote(padId)}`,
            `summary: ${yamlQuote(
              `deleted pad_id=${padId} by reminder_id fallback because metadata was not readable`,
            )}`,
          ].join('\n'),
        );
      }
      dlg.deleteReminder(existing.index);
      return okYaml(
        [
          `status: ok`,
          `mode: pad_delete`,
          `pad_id: ${yamlQuote(padId)}`,
          `summary: ${yamlQuote(`deleted pad_id=${padId}`)}`,
        ].join('\n'),
      );
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: pad_delete`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

type FileRangeEditSource =
  | Readonly<{
      kind: 'content';
      text: string;
      redacted: false;
    }>
  | Readonly<{
      kind: 'pad';
      padId: string;
      padRange: string;
      padHash: string;
      selectedText: string;
      selectedHash: string;
      redacted: true;
    }>;

function fileRangeEditSourceText(source: FileRangeEditSource): string {
  return source.kind === 'content' ? source.text : source.selectedText;
}

function pushFileRangeEditSourceYaml(
  lines: string[],
  source: FileRangeEditSource,
  showDiff: boolean,
): void {
  lines.push(`source: ${source.kind}`, `redacted: ${source.redacted && !showDiff}`);
  if (source.kind === 'pad') {
    lines.push(
      `pad_id: ${yamlQuote(source.padId)}`,
      `pad_range: ${yamlQuote(source.padRange)}`,
      `pad_hash: ${yamlQuote(source.padHash)}`,
      `pad_selected_lines: ${countPadLines(source.selectedText)}`,
      `pad_selected_bytes: ${Buffer.byteLength(source.selectedText, 'utf8')}`,
      `pad_selected_hash: ${yamlQuote(source.selectedHash)}`,
    );
  }
}

function resolveFileRangeEditSource(dlg: Dialog, args: ToolArguments): FileRangeEditSource {
  const rawPadId = optionalNonEmptyStringArg(args, 'pad_id');
  const hasPadSource = rawPadId !== undefined;
  const contentValue = optionalStringArg(args, 'content');
  const hasContentSource =
    contentValue !== undefined && !(hasPadSource && contentValue.trim() === '');

  if (hasPadSource && hasContentSource) {
    throw new Error('Provide either `content` or `pad_id`, not both');
  }
  if (!hasPadSource && contentValue === undefined) {
    throw new Error('Provide `content`, or provide `pad_id` with optional `pad_range`');
  }
  if (!hasPadSource && hasOwnArg(args, 'pad_range')) {
    const padRange = optionalStringArg(args, 'pad_range');
    if (padRange !== undefined && padRange.trim() !== '') {
      throw new Error('`pad_range` requires `pad_id`');
    }
  }

  if (!hasPadSource) {
    return { kind: 'content', text: contentValue ?? '', redacted: false };
  }

  const padId = normalizePadId(rawPadId);
  const padRange = parseOptionalPadRange(args, 'pad_range');
  const pad = requireDialogPadById(dlg, padId);
  const selectedText = selectTextByLineRange(pad.meta.text, padRange);
  return {
    kind: 'pad',
    padId,
    padRange,
    padHash: hashPadText(pad.meta.text),
    selectedText,
    selectedHash: hashPadText(selectedText),
    redacted: true,
  };
}

export const fileRangeEditTool: FuncTool = {
  type: 'func',
  name: 'file_range_edit',
  description:
    'Directly write a precise rtws file line range using inline content or ws_mod pad content. Defaults to redacted YAML output; set preview/show_diff explicitly for review-only diff output.',
  descriptionI18n: {
    en: 'Directly write a precise rtws file line range using inline content or ws_mod pad content. Defaults to redacted YAML output; set preview/show_diff explicitly for review-only diff output.',
    zh: '用内联 content 或 ws_mod pad 内容直接写入明确的 rtws 文件行范围。默认只输出 redacted YAML；显式 preview/show_diff 才做预览或 diff 输出。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'range'],
    properties: {
      path: { type: 'string', description: 'rtws-relative file path.' },
      range: {
        type: 'string',
        description: "Target file line range: '10~50' | '300~' | '~20' | '~'.",
      },
      content: {
        type: 'string',
        description:
          'Replacement text. Empty string deletes the selected range. Omit when using pad_id.',
      },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
      preview: {
        type: 'boolean',
        description: 'If true, do not write; return the same metadata for the proposed edit.',
      },
      show_diff: {
        type: 'boolean',
        description:
          'If true, include a unified diff in the tool result. This may echo new content, including pad content.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    try {
      const filePath = requireNonEmptyStringArg(args, 'path');
      const rangeSpec = requireNonEmptyStringArg(args, 'range');
      const preview = optionalBooleanArg(args, 'preview') ?? false;
      const showDiff = optionalBooleanArg(args, 'show_diff') ?? false;
      const source = resolveFileRangeEditSource(dlg, args);
      const replacementText = fileRangeEditSourceText(source);

      if (!hasWriteAccess(caller, filePath)) {
        return toolFailure(getAccessDeniedMessage('write', filePath, language));
      }

      const absPath = ensureInsideWorkspace(filePath);
      const absKey = path.resolve(absPath);
      const runEdit = async (): Promise<ToolCallOutput> => {
        let stat: fsSync.Stats;
        try {
          stat = fsSync.statSync(absPath);
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            return failYaml(
              [
                `status: error`,
                `mode: file_range_edit`,
                `path: ${yamlQuote(filePath)}`,
                `error: FILE_NOT_FOUND`,
                `summary: ${yamlQuote(language === 'zh' ? '文件不存在。' : 'File not found.')}`,
              ].join('\n'),
            );
          }
          throw error;
        }
        if (!stat.isFile()) {
          return failYaml(
            [
              `status: error`,
              `mode: file_range_edit`,
              `path: ${yamlQuote(filePath)}`,
              `error: NOT_A_FILE`,
              `summary: ${yamlQuote(language === 'zh' ? '路径不是文件。' : 'Path is not a file.')}`,
            ].join('\n'),
          );
        }

        const currentContent = fsSync.readFileSync(absPath, 'utf8');
        const currentLines = splitFileTextToLines(currentContent);
        const parsed = parseLineRangeSpec(rangeSpec, rangeTotalLines(currentLines));
        if (!parsed.ok) {
          return failYaml(
            [
              `status: error`,
              `mode: file_range_edit`,
              `path: ${yamlQuote(filePath)}`,
              `range: ${yamlQuote(rangeSpec)}`,
              `error: INVALID_RANGE`,
              `summary: ${yamlQuote(parsed.error)}`,
            ].join('\n'),
          );
        }

        const range = parsed.range;
        const startIndex0 =
          range.kind === 'append' ? rangeTotalLines(currentLines) : range.startLine - 1;
        const deleteCount = range.kind === 'append' ? 0 : range.endLine - range.startLine + 1;
        const replacementLines = splitPlannedBodyLines(replacementText);
        const nextLines = [...currentLines];
        nextLines.splice(startIndex0, deleteCount, ...replacementLines);
        const nextText = joinLinesForWrite(nextLines);
        const oldTotalLines = fileLineCount(currentLines);
        const newTotalLines = fileLineCount(nextLines);
        const oldTotalBytes = Buffer.byteLength(currentContent, 'utf8');
        const newTotalBytes = Buffer.byteLength(nextText, 'utf8');
        const oldFileHash = `sha256:${sha256HexUtf8(currentContent)}`;
        const newFileHash = `sha256:${sha256HexUtf8(nextText)}`;
        const action =
          range.kind === 'append' ? 'append' : replacementLines.length === 0 ? 'delete' : 'replace';
        const resolvedStart = range.kind === 'append' ? oldTotalLines + 1 : range.startLine;
        const resolvedEnd =
          range.kind === 'append'
            ? resolvedStart + Math.max(0, replacementLines.length - 1)
            : action === 'delete'
              ? range.endLine
              : range.startLine + Math.max(0, replacementLines.length - 1);
        const normalizedContentEofNewlineAdded =
          replacementText !== '' && !replacementText.endsWith('\n');
        const normalizedFileEofNewlineAdded =
          currentContent !== '' && !currentContent.endsWith('\n');

        if (!preview) {
          fsSync.writeFileSync(absPath, nextText, 'utf8');
        }

        const yamlLines = [
          `status: ok`,
          `mode: file_range_edit`,
          `preview: ${preview}`,
          `path: ${yamlQuote(filePath)}`,
        ];
        pushFileRangeEditSourceYaml(yamlLines, source, showDiff);
        yamlLines.push(
          `action: ${action}`,
          `range:`,
          `  input: ${yamlQuote(rangeSpec)}`,
          `  applied:`,
          `    start: ${resolvedStart}`,
          `    end: ${resolvedEnd}`,
          `lines:`,
          `  old: ${deleteCount}`,
          `  new: ${replacementLines.length}`,
          `  delta: ${replacementLines.length - deleteCount}`,
          `file:`,
          `  old_total_lines: ${oldTotalLines}`,
          `  old_total_bytes: ${oldTotalBytes}`,
          `  old_hash: ${yamlQuote(oldFileHash)}`,
          `  new_total_lines: ${newTotalLines}`,
          `  new_total_bytes: ${newTotalBytes}`,
          `  new_hash: ${yamlQuote(newFileHash)}`,
          `normalized:`,
          `  file_eof_has_newline: ${currentContent === '' || currentContent.endsWith('\n')}`,
          `  content_eof_has_newline: ${replacementText === '' || replacementText.endsWith('\n')}`,
          `  normalized_file_eof_newline_added: ${normalizedFileEofNewlineAdded}`,
          `  normalized_content_eof_newline_added: ${normalizedContentEofNewlineAdded}`,
          `summary: ${yamlQuote(
            language === 'zh'
              ? `${preview ? '预览' : '已写入'}：${action} ${filePath}:${rangeSpec}；old=${deleteCount}, new=${replacementLines.length}.`
              : `${preview ? 'Previewed' : 'Wrote'}: ${action} ${filePath}:${rangeSpec}; old=${deleteCount}, new=${replacementLines.length}.`,
          )}`,
        );
        const yaml = yamlLines.join('\n');
        if (!showDiff) {
          return okYaml(yaml);
        }
        const unifiedDiff = buildUnifiedSingleHunkDiff(
          filePath,
          currentLines,
          startIndex0,
          deleteCount,
          replacementLines,
        );
        return toolSuccess(`${formatYamlCodeBlock(yaml)}\n\n\`\`\`diff\n${unifiedDiff}\`\`\``);
      };

      return await new Promise<ToolCallOutput>((resolve) => {
        enqueueFileApply(absKey, {
          priority: Date.now(),
          tieBreaker: generateHunkId(),
          run: async () => {
            try {
              resolve(await runEdit());
            } catch (error: unknown) {
              resolve(
                failYaml(
                  [
                    `status: error`,
                    `mode: file_range_edit`,
                    `error: WRITE_FAILED`,
                    `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
                  ].join('\n'),
                ),
              );
            }
          },
        });
        void drainFileApplyQueue(absKey);
      });
    } catch (error: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: file_range_edit`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
    }
  },
};

export const overwriteEntireFileTool: FuncTool = {
  type: 'func',
  name: 'overwrite_entire_file',
  description:
    'Overwrite an existing file with inline content or ws_mod pad content (guarded by known_old_total_lines/bytes; refuses diff/patch-like content unless content_format is diff|patch).',
  descriptionI18n: {
    en: 'Overwrite an existing file with inline content or ws_mod pad content (guarded by known_old_total_lines/bytes; refuses diff/patch-like content unless content_format is diff|patch).',
    zh: '用内联 content 或 ws_mod pad 内容整体覆盖写入一个已存在的文件（需要 known_old_total_lines/bytes 对账；若正文疑似 diff/patch 且未显式声明 content_format=diff|patch，则默认拒绝）。',
  },
  parameters: overwriteEntireFileSchema,
  argsValidation: 'dominds',
  call: async (dlg, caller, args: ToolArguments): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    const t =
      language === 'zh'
        ? {
            invalidArgs: (msg: string) => `参数不正确：${msg}`,
            fileNotFound:
              '文件不存在；创建文件请使用 create_new_file，或确实要追加创建时使用 file_append create=true。',
            notAFile: '路径不是文件。',
            statsMismatch: '旧文件快照不匹配，拒绝覆盖写入。',
            nextRefreshStats: '下一步：先 read_file 获取最新 total_lines/size_bytes，再重试。',
            suspiciousDiff:
              '检测到疑似 diff/patch 正文，且未显式声明 content_format；为避免把 patch 文本误写进文件，默认拒绝。',
            nextUsePreviewApply:
              '下一步：若确实要保存 diff/patch 字面量，请设置 content_format=diff|patch；若只是想审阅改动，请在 direct 工具上使用 preview/show_diff。',
            ok: '已覆盖写入。',
          }
        : {
            invalidArgs: (msg: string) => `Invalid args: ${msg}`,
            fileNotFound:
              'File not found; create files with create_new_file, or use file_append create=true when append-create is intended.',
            notAFile: 'Path is not a file.',
            statsMismatch: 'known_old_total_lines/bytes mismatch; refusing to overwrite.',
            nextRefreshStats: 'Next: call read_file to refresh total_lines/size_bytes, then retry.',
            suspiciousDiff:
              'Content looks like a diff/patch, but content_format was not provided; rejected by default to prevent accidental overwrites.',
            nextUsePreviewApply:
              "Next: if you intentionally want to store diff/patch text literally, set content_format='diff'|'patch'; if you only want review output, use preview/show_diff on the direct tool.",
            ok: 'Overwrote file.',
          };

    const parsed = (() => {
      try {
        return {
          ...parseOverwriteEntireFileArgs(args),
          source: resolveFileBodySource(dlg, args, { allowMissingContent: false }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { __error: msg } as const;
      }
    })();
    if ('__error' in parsed) {
      const errorSummary = typeof parsed.__error === 'string' ? parsed.__error : 'Unknown error';
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `error: INVALID_ARGS`,
          `summary: ${yamlQuote(t.invalidArgs(errorSummary))}`,
        ].join('\n'),
      );
    }

    const content = fileBodySourceText(parsed.source);

    if (!hasWriteAccess(caller, parsed.path)) {
      return toolFailure(getAccessDeniedMessage('write', parsed.path, language));
    }

    let absPath: string;
    try {
      absPath = ensureInsideWorkspace(parsed.path);
    } catch (err: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: INVALID_PATH`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
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
        return failYaml(
          [
            `status: error`,
            `mode: overwrite_entire_file`,
            `path: ${yamlQuote(parsed.path)}`,
            `error: FILE_NOT_FOUND`,
            `summary: ${yamlQuote(t.fileNotFound)}`,
          ].join('\n'),
        );
      }
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
    }
    if (!s.isFile()) {
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: NOT_A_FILE`,
          `summary: ${yamlQuote(t.notAFile)}`,
        ].join('\n'),
      );
    }

    const actualOldTotalBytes = s.size;
    let actualOldTotalLines: number;
    try {
      actualOldTotalLines = await countFileLinesUtf8(absPath);
    } catch (err: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
    }

    if (
      parsed.knownOldTotalBytes !== actualOldTotalBytes ||
      parsed.knownOldTotalLines !== actualOldTotalLines
    ) {
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: STATS_MISMATCH`,
          `known_old_total_lines: ${parsed.knownOldTotalLines}`,
          `known_old_total_bytes: ${parsed.knownOldTotalBytes}`,
          `actual_old_total_lines: ${actualOldTotalLines}`,
          `actual_old_total_bytes: ${actualOldTotalBytes}`,
          `summary: ${yamlQuote(t.statsMismatch)}`,
          `next: ${yamlQuote(t.nextRefreshStats)}`,
        ].join('\n'),
      );
    }

    if (parsed.contentFormat !== 'diff' && parsed.contentFormat !== 'patch') {
      // Only refuse when content_format is omitted (or a non-diff format), and content is strongly diff-like.
      if (detectStrongDiffOrPatchMarkers(content)) {
        return failYaml(
          [
            `status: error`,
            `mode: overwrite_entire_file`,
            `path: ${yamlQuote(parsed.path)}`,
            `error: SUSPICIOUS_DIFF`,
            `content_format: ${yamlQuote(parsed.contentFormat ?? '')}`,
            `summary: ${yamlQuote(t.suspiciousDiff)}`,
            `next: ${yamlQuote(t.nextUsePreviewApply)}`,
          ].join('\n'),
        );
      }
    }

    const { normalizedBody, addedTrailingNewlineToContent } = normalizeFileWriteBody(content);
    try {
      await fs.writeFile(absPath, normalizedBody, 'utf8');
    } catch (err: unknown) {
      return failYaml(
        [
          `status: error`,
          `mode: overwrite_entire_file`,
          `path: ${yamlQuote(parsed.path)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(err instanceof Error ? err.message : String(err))}`,
        ].join('\n'),
      );
    }

    const newTotalBytes = Buffer.byteLength(normalizedBody, 'utf8');
    const newTotalLines = splitTextToLinesForEditing(normalizedBody).length;
    const normalizedNewlineAdded = addedTrailingNewlineToContent && normalizedBody !== '';
    const okSummary =
      language === 'zh'
        ? `${t.ok} path=${parsed.path}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`
        : `${t.ok} path=${parsed.path}; new_total_lines=${newTotalLines}; new_total_bytes=${newTotalBytes}.`;
    const yamlLines = [
      `status: ok`,
      `mode: overwrite_entire_file`,
      `path: ${yamlQuote(parsed.path)}`,
    ];
    pushFileBodySourceYaml(yamlLines, parsed.source, false);
    yamlLines.push(
      `known_old_total_lines: ${parsed.knownOldTotalLines}`,
      `known_old_total_bytes: ${parsed.knownOldTotalBytes}`,
      `new_total_lines: ${newTotalLines}`,
      `new_total_bytes: ${newTotalBytes}`,
      `normalized_trailing_newline_added: ${normalizedNewlineAdded}`,
      `content_format: ${yamlQuote(parsed.contentFormat ?? '')}`,
      `summary: ${yamlQuote(okSummary)}`,
    );
    return okYaml(yamlLines.join('\n'));
  },
};

async function runFileAppend(
  caller: FuncToolCallContext,
  filePath: string,
  source: FileRangeEditSource,
  options: { create: boolean; preview: boolean; showDiff: boolean },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const mode = 'file_append';
  const inputBody = fileRangeEditSourceText(source);
  if (!filePath) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
        `error: PATH_REQUIRED`,
        `summary: ${yamlQuote(language === 'zh' ? '需要提供文件路径。' : 'File path is required.')}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (inputBody === '') {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
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
  const preview = options.preview;
  const showDiff = options.showDiff;

  try {
    const fullPath = ensureInsideWorkspace(filePath);
    const absKey = path.resolve(fullPath);
    const res = await new Promise<TxtToolCallResult>((resolve) => {
      enqueueFileApply(absKey, {
        priority: Date.now(),
        tieBreaker: generateHunkId(),
        run: async () => {
          try {
            const fileExists = fsSync.existsSync(fullPath);
            if (!fileExists && !create) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: ${mode}`,
                  `path: ${yamlQuote(filePath)}`,
                  `error: FILE_NOT_FOUND`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? '文件不存在（create=false），无法追加。'
                      : 'File does not exist (create=false); cannot append.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            if (fileExists && !fsSync.statSync(fullPath).isFile()) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: ${mode}`,
                  `path: ${yamlQuote(filePath)}`,
                  `error: NOT_A_FILE`,
                  `summary: ${yamlQuote(language === 'zh' ? '路径不是文件。' : 'Path is not a file.')}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const existingContent = fileExists ? fsSync.readFileSync(fullPath, 'utf8') : '';
            const fileEofHasNewline = existingContent === '' || existingContent.endsWith('\n');
            const normalizedFileEofNewlineAdded =
              existingContent !== '' && !existingContent.endsWith('\n');
            const existingNormalized = normalizedFileEofNewlineAdded
              ? `${existingContent}\n`
              : existingContent;
            const { normalizedBody, addedTrailingNewlineToContent } =
              normalizeFileWriteBody(inputBody);
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
            const nextText = `${existingNormalized}${normalizedBody}`;
            const plannedAfterLines = splitTextToLinesForEditing(nextText);
            const unifiedDiff = buildUnifiedSingleHunkDiff(
              filePath,
              fileLinesBefore,
              fileLinesBefore.length,
              0,
              appendLines,
            );
            if (!preview) {
              fsSync.mkdirSync(path.dirname(fullPath), { recursive: true });
              fsSync.writeFileSync(fullPath, nextText, 'utf8');
            }

            const fileLineCountBefore = countLogicalLines(existingContent);
            const fileLineCountAfter = countLogicalLines(nextText);
            const appendedLineCount = countLogicalLines(normalizedBody);
            const fileTrailingBlankLineCount = countTrailingBlankLines(fileLinesBefore);
            const contentLeadingBlankLineCount = countLeadingBlankLines(appendLines);
            const styleWarning =
              fileTrailingBlankLineCount > 0 && contentLeadingBlankLineCount > 0
                ? language === 'zh'
                  ? '注意：文件末尾已有空行且追加内容以空行开头，可能产生多余空行。'
                  : 'Warning: file already ends with blank line(s) and appended content starts with blank line(s); you may get extra blank lines.'
                : '';
            const evidenceBeforeTail = fileLinesBefore.slice(
              Math.max(0, fileLinesBefore.length - 2),
            );
            const evidenceAppendPreview = showDiff
              ? appendLines.length <= 2
                ? appendLines
                : appendLines.slice(0, 2)
              : appendLines.length > 0
                ? ['<redacted>']
                : [];
            const evidenceAfterTail = showDiff
              ? plannedAfterLines.slice(Math.max(0, plannedAfterLines.length - 2))
              : appendLines.length > 0
                ? ['<redacted>']
                : [];
            const summary =
              language === 'zh'
                ? `${preview ? '预览追加' : '已追加'}：+${appendedLineCount} 行；file ${fileLineCountBefore} → ${fileLineCountAfter}.`
                : `${preview ? 'Previewed append' : 'Appended'}: +${appendedLineCount} lines; file ${fileLineCountBefore} → ${fileLineCountAfter}.`;
            const yamlLines = [
              `status: ok`,
              `mode: ${mode}`,
              `preview: ${preview}`,
              `path: ${yamlQuote(filePath)}`,
            ];
            pushFileRangeEditSourceYaml(yamlLines, source, showDiff);
            yamlLines.push(
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
            );
            const yaml = yamlLines.join('\n');
            const content = showDiff
              ? `${formatYamlCodeBlock(yaml)}\n\n\`\`\`diff\n${unifiedDiff}\`\`\``
              : formatYamlCodeBlock(yaml);
            resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
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
            resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
          }
        },
      });
      void drainFileApplyQueue(absKey);
    });
    return res;
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

async function runFileInsertionCommon(
  position: 'before' | 'after',
  caller: FuncToolCallContext,
  options: {
    filePath: string;
    anchor: string;
    occurrence: Occurrence;
    occurrenceSpecified: boolean;
    match: AnchorMatchMode;
    source: FileRangeEditSource;
    preview: boolean;
    showDiff: boolean;
  },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const mode = position === 'after' ? 'file_insert_after' : 'file_insert_before';

  const filePath = options.filePath;
  const anchor = options.anchor;
  const inputBody = fileRangeEditSourceText(options.source);
  const occurrence = options.occurrence;
  const occurrenceSpecified = options.occurrenceSpecified;
  const match = options.match;
  const preview = options.preview;
  const showDiff = options.showDiff;

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

  if (!hasWriteAccess(caller, filePath)) {
    const content = getAccessDeniedMessage('write', filePath, language);
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
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
    const fullPath = ensureInsideWorkspace(filePath);
    const absKey = path.resolve(fullPath);
    const res = await new Promise<TxtToolCallResult>((resolve) => {
      enqueueFileApply(absKey, {
        priority: Date.now(),
        tieBreaker: generateHunkId(),
        run: async () => {
          try {
            if (!fsSync.existsSync(fullPath)) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: ${mode}`,
                  `path: ${yamlQuote(filePath)}`,
                  `error: FILE_NOT_FOUND`,
                  `summary: ${yamlQuote(
                    language === 'zh' ? '文件不存在，无法插入。' : 'File does not exist.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            if (!fsSync.statSync(fullPath).isFile()) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `mode: ${mode}`,
                  `path: ${yamlQuote(filePath)}`,
                  `error: NOT_A_FILE`,
                  `summary: ${yamlQuote(language === 'zh' ? '路径不是文件。' : 'Path is not a file.')}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
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
                  `candidates_count: ${matchLines.length}`,
                  `error: ANCHOR_AMBIGUOUS`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? '锚点出现多次且未指定 occurrence；拒绝写入。请指定 occurrence 或改用 file_range_edit。'
                      : 'Anchor appears multiple times and occurrence is not specified; refusing to write. Specify occurrence or use file_range_edit.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
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
                      ? '锚点未找到；请改用 file_range_edit 或选择更可靠的 anchor。'
                      : 'Anchor not found; use file_range_edit or choose a different anchor.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
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
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }

            const occurrenceResolved =
              matchLines.length === 1
                ? '1'
                : occurrence.kind === 'last'
                  ? 'last'
                  : String(occurrence.index1);

            const anchorLineText = lines[anchorIndex0] ?? '';
            const { normalizedBody, addedTrailingNewlineToContent } =
              normalizeFileWriteBody(inputBody);
            const insertLines = splitPlannedBodyLines(normalizedBody);
            const insertIndex0 = position === 'after' ? anchorIndex0 + 1 : anchorIndex0;
            const nextLines = [...lines];
            nextLines.splice(insertIndex0, 0, ...insertLines);
            const nextText = joinLinesForWrite(nextLines);
            const unifiedDiff = buildUnifiedSingleHunkDiff(
              filePath,
              lines,
              insertIndex0,
              0,
              insertLines,
            );
            if (!preview) {
              fsSync.writeFileSync(fullPath, nextText, 'utf8');
            }

            const fileEofHasNewline = existingContent === '' || existingContent.endsWith('\n');
            const normalizedFileEofNewlineAdded =
              existingContent !== '' && !existingContent.endsWith('\n');
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
            const insertPreview = showDiff
              ? insertLines.length <= 2
                ? insertLines
                : insertLines.slice(0, 2)
              : insertLines.length > 0
                ? ['<redacted>']
                : [];
            const afterPreview =
              position === 'after'
                ? lines.slice(anchorIndex0 + 1, anchorIndex0 + 3)
                : lines.slice(anchorIndex0, anchorIndex0 + 2);
            const delta = insertLines.length;
            const summary =
              language === 'zh'
                ? `${preview ? '预览插入' : '已插入'}：${position === 'after' ? 'after' : 'before'} "${anchor}"（occurrence=${occurrenceResolved}）+${insertedLineCount} 行。`
                : `${preview ? 'Previewed insert' : 'Inserted'}: +${insertedLineCount} lines ${position} "${anchor}" (occurrence=${occurrenceResolved}).`;
            const yamlLines = [
              `status: ok`,
              `mode: ${mode}`,
              `preview: ${preview}`,
              `path: ${yamlQuote(filePath)}`,
            ];
            pushFileRangeEditSourceYaml(yamlLines, options.source, showDiff);
            yamlLines.push(
              `action: insert`,
              `position: ${yamlQuote(position)}`,
              `anchor: ${yamlQuote(anchor)}`,
              `match: ${yamlQuote(match)}`,
              `candidates_count: ${matchLines.length}`,
              `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
              `inserted_at_line: ${insertedAtLine}`,
              `inserted_line_count: ${insertedLineCount}`,
              `lines:`,
              `  old: 0`,
              `  new: ${insertedLineCount}`,
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
            );
            const yaml = yamlLines.join('\n');
            const content = showDiff
              ? `${formatYamlCodeBlock(yaml)}\n\n\`\`\`diff\n${unifiedDiff}\`\`\``
              : formatYamlCodeBlock(yaml);
            resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
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
            resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
          }
        },
      });
      void drainFileApplyQueue(absKey);
    });
    return res;
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

export const fileInsertAfterTool: FuncTool = {
  type: 'func',
  name: 'file_insert_after',
  description:
    'Directly insert inline content or ws_mod pad content after an anchor line in an rtws file.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: {
        type: 'string',
        description: "Anchor match mode: 'contains' (default) or 'equals'.",
      },
      content: { type: 'string' },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
      preview: { type: 'boolean' },
      show_diff: { type: 'boolean' },
    },
    required: ['path', 'anchor'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const anchor = requireNonEmptyStringArg(args, 'anchor');
    const source = resolveFileRangeEditSource(dlg, args);
    const preview = optionalBooleanArg(args, 'preview') ?? false;
    const showDiff = optionalBooleanArg(args, 'show_diff') ?? false;

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

    const res = await runFileInsertionCommon('after', caller, {
      filePath,
      anchor,
      occurrence,
      occurrenceSpecified,
      match,
      source,
      preview,
      showDiff,
    });
    return unwrapTxtToolResult(res);
  },
};

export const fileInsertBeforeTool: FuncTool = {
  type: 'func',
  name: 'file_insert_before',
  description:
    'Directly insert inline content or ws_mod pad content before an anchor line in an rtws file.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      anchor: { type: 'string' },
      occurrence: { type: ['integer', 'string'] },
      match: {
        type: 'string',
        description: "Anchor match mode: 'contains' (default) or 'equals'.",
      },
      content: { type: 'string' },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
      preview: { type: 'boolean' },
      show_diff: { type: 'boolean' },
    },
    required: ['path', 'anchor'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const anchor = requireNonEmptyStringArg(args, 'anchor');
    const source = resolveFileRangeEditSource(dlg, args);
    const preview = optionalBooleanArg(args, 'preview') ?? false;
    const showDiff = optionalBooleanArg(args, 'show_diff') ?? false;

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

    const res = await runFileInsertionCommon('before', caller, {
      filePath,
      anchor,
      occurrence,
      occurrenceSpecified,
      match,
      source,
      preview,
      showDiff,
    });
    return unwrapTxtToolResult(res);
  },
};

async function runFileBlockReplace(
  caller: FuncToolCallContext,
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
    source: FileRangeEditSource;
    preview: boolean;
    showDiff: boolean;
  },
): Promise<TxtToolCallResult> {
  const language = getWorkLanguage();
  const mode = 'file_block_replace';
  const filePath = options.filePath;
  const startAnchor = options.startAnchor;
  const endAnchor = options.endAnchor;
  const inputBody = fileRangeEditSourceText(options.source);
  const occurrence = options.occurrence;
  const occurrenceSpecified = options.occurrenceSpecified;
  const includeAnchors = options.includeAnchors;
  const match = options.match;
  const requireUnique = options.requireUnique;
  const strict = options.strict;
  const preview = options.preview;
  const showDiff = options.showDiff;

  if (!filePath || !startAnchor || !endAnchor) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `mode: ${mode}`,
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
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
  if (inputBody === '') {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `path: ${yamlQuote(filePath)}`,
        `mode: ${mode}`,
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
    const fullPath = ensureInsideWorkspace(filePath);
    const absKey = path.resolve(fullPath);
    const res = await new Promise<TxtToolCallResult>((resolve) => {
      enqueueFileApply(absKey, {
        priority: Date.now(),
        tieBreaker: generateHunkId(),
        run: async () => {
          try {
            if (!fsSync.existsSync(fullPath)) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `path: ${yamlQuote(filePath)}`,
                  `mode: ${mode}`,
                  `error: FILE_NOT_FOUND`,
                  `summary: ${yamlQuote(language === 'zh' ? '文件不存在。' : 'File does not exist.')}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            if (!fsSync.statSync(fullPath).isFile()) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `path: ${yamlQuote(filePath)}`,
                  `mode: ${mode}`,
                  `error: NOT_A_FILE`,
                  `summary: ${yamlQuote(language === 'zh' ? '路径不是文件。' : 'Path is not a file.')}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
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
            for (let i = 0; i < lines.length; i += 1) {
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
                  `mode: ${mode}`,
                  `start_anchor: ${yamlQuote(startAnchor)}`,
                  `end_anchor: ${yamlQuote(endAnchor)}`,
                  `candidates_count: 0`,
                  `error: ANCHOR_NOT_FOUND`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? '锚点未找到或无法配对。请改用 file_range_edit（行号范围精确编辑）。'
                      : 'Anchors not found or not paired. Use file_range_edit (line-range precise edits).',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            if (!occurrenceSpecified && requireUnique && candidatesCount !== 1 && strict) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `path: ${yamlQuote(filePath)}`,
                  `mode: ${mode}`,
                  `start_anchor: ${yamlQuote(startAnchor)}`,
                  `end_anchor: ${yamlQuote(endAnchor)}`,
                  `candidates_count: ${candidatesCount}`,
                  `error: ANCHOR_AMBIGUOUS`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? `锚点歧义：存在 ${candidatesCount} 个候选块。请指定 occurrence=<n|last>，或改用 file_range_edit（行号范围）。`
                      : `Ambiguous anchors: ${candidatesCount} candidate block(s). Specify occurrence=<n|last>, or use file_range_edit (line range).`,
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            const selected = (() => {
              if (candidatesCount === 1) return pairs[0];
              if (occurrence.kind === 'last') return pairs[pairs.length - 1];
              return pairs[occurrence.index1 - 1];
            })();
            if (!selected) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `path: ${yamlQuote(filePath)}`,
                  `mode: ${mode}`,
                  `start_anchor: ${yamlQuote(startAnchor)}`,
                  `end_anchor: ${yamlQuote(endAnchor)}`,
                  `candidates_count: ${candidatesCount}`,
                  `error: OCCURRENCE_OUT_OF_RANGE`,
                  `summary: ${yamlQuote(
                    language === 'zh' ? 'occurrence 超出范围。' : 'occurrence is out of range.',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            const nestedStart = startMatches.some((s) => s > selected.start0 && s < selected.end0);
            const nestedEnd = endMatches.some((e) => e > selected.start0 && e < selected.end0);
            if (nestedStart || nestedEnd) {
              const content = formatYamlCodeBlock(
                [
                  `status: error`,
                  `path: ${yamlQuote(filePath)}`,
                  `mode: ${mode}`,
                  `start_anchor: ${yamlQuote(startAnchor)}`,
                  `end_anchor: ${yamlQuote(endAnchor)}`,
                  `candidates_count: ${candidatesCount}`,
                  `error: ANCHOR_AMBIGUOUS`,
                  `summary: ${yamlQuote(
                    language === 'zh'
                      ? '检测到嵌套/歧义锚点，拒绝写入。请先规范 anchors，或改用 file_range_edit（行号范围）。'
                      : 'Nested/ambiguous anchors detected. Refusing to write; normalize anchors or use file_range_edit (line range).',
                  )}`,
                ].join('\n'),
              );
              resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
              return;
            }
            const occurrenceResolved =
              candidatesCount === 1
                ? '1'
                : occurrence.kind === 'last'
                  ? 'last'
                  : String(occurrence.index1);
            const { normalizedBody, addedTrailingNewlineToContent } =
              normalizeFileWriteBody(inputBody);
            const contentEofHasNewline = inputBody.endsWith('\n');
            const normalizedContentEofNewlineAdded = addedTrailingNewlineToContent;
            const replacementLines = splitPlannedBodyLines(normalizedBody);
            const replaceStart0 = includeAnchors ? selected.start0 + 1 : selected.start0;
            const replaceDeleteCount = includeAnchors
              ? Math.max(0, selected.end0 - selected.start0 - 1)
              : selected.end0 - selected.start0 + 1;
            const oldLines = lines.slice(replaceStart0, replaceStart0 + replaceDeleteCount);
            const nextLines = [...lines];
            nextLines.splice(replaceStart0, replaceDeleteCount, ...replacementLines);
            const nextText = joinLinesForWrite(nextLines);
            const unifiedDiff = buildUnifiedSingleHunkDiff(
              filePath,
              lines,
              replaceStart0,
              replaceDeleteCount,
              replacementLines,
            );
            if (!preview) {
              fsSync.writeFileSync(fullPath, nextText, 'utf8');
            }
            const oldCount = replaceDeleteCount;
            const newCount = replacementLines.length;
            const delta = newCount - oldCount;
            const oldPreview = buildRangePreview(oldLines);
            const newPreview = showDiff
              ? buildRangePreview(replacementLines)
              : replacementLines.length > 0
                ? ['<redacted>']
                : [];
            const summary =
              language === 'zh'
                ? `${preview ? '预览块替换' : '已块替换'}：候选=${candidatesCount}；block 第 ${selected.start0 + 1}–${selected.end0 + 1} 行；old=${oldCount}, new=${newCount}, delta=${delta}.`
                : `${preview ? 'Previewed block replace' : 'Block replaced'}: candidates=${candidatesCount}; block lines ${selected.start0 + 1}–${selected.end0 + 1}; old=${oldCount}, new=${newCount}, delta=${delta}.`;
            const yamlLines = [
              `status: ok`,
              `mode: ${mode}`,
              `preview: ${preview}`,
              `path: ${yamlQuote(filePath)}`,
            ];
            pushFileRangeEditSourceYaml(yamlLines, options.source, showDiff);
            yamlLines.push(
              `action: block_replace`,
              `start_anchor: ${yamlQuote(startAnchor)}`,
              `end_anchor: ${yamlQuote(endAnchor)}`,
              `match: ${yamlQuote(match)}`,
              `include_anchors: ${includeAnchors}`,
              `require_unique: ${requireUnique}`,
              `strict: ${strict}`,
              `candidates_count: ${candidatesCount}`,
              `occurrence_resolved: ${yamlQuote(occurrenceResolved)}`,
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
              `  file_eof_has_newline: ${fileEofHasNewline}`,
              `  content_eof_has_newline: ${contentEofHasNewline}`,
              `  normalized_file_eof_newline_added: ${normalizedFileEofNewlineAdded}`,
              `  normalized_content_eof_newline_added: ${normalizedContentEofNewlineAdded}`,
              `evidence_preview:`,
              `  before_preview: ${yamlFlowStringArray([lines[selected.start0] ?? ''])}`,
              `  old_preview: ${yamlFlowStringArray(oldPreview)}`,
              `  new_preview: ${yamlFlowStringArray(newPreview)}`,
              `  after_preview: ${yamlFlowStringArray([lines[selected.end0] ?? ''])}`,
              `summary: ${yamlQuote(summary)}`,
            );
            const yaml = yamlLines.join('\n');
            const content = showDiff
              ? `${formatYamlCodeBlock(yaml)}\n\n\`\`\`diff\n${unifiedDiff}\`\`\``
              : formatYamlCodeBlock(yaml);
            resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
          } catch (error: unknown) {
            const content = formatYamlCodeBlock(
              [
                `status: error`,
                `path: ${yamlQuote(filePath)}`,
                `mode: ${mode}`,
                `error: FAILED`,
                `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
              ].join('\n'),
            );
            resolve(failed(content, [{ type: 'environment_msg', role: 'user', content }]));
          }
        },
      });
      void drainFileApplyQueue(absKey);
    });
    return res;
  } catch (error: unknown) {
    const content = formatYamlCodeBlock(
      [
        `status: error`,
        `path: ${yamlQuote(filePath)}`,
        `mode: ${mode}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
    return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
  }
}

export const fileBlockReplaceTool: FuncTool = {
  type: 'func',
  name: 'file_block_replace',
  description:
    'Directly replace one anchor-delimited block in an rtws file with inline content or ws_mod pad content.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      start_anchor: { type: 'string' },
      end_anchor: { type: 'string' },
      occurrence: {
        type: ['integer', 'string'],
        description: "1-based occurrence index (e.g. 1, 2) or 'last'.",
      },
      include_anchors: {
        type: 'boolean',
        description:
          'When true (default), keep the start/end anchor lines and replace only the content between them. When false, the replacement range includes the anchor lines.',
      },
      match: {
        type: 'string',
        description: "Anchor match mode: 'contains' (default) or 'equals'.",
      },
      require_unique: {
        type: 'boolean',
        description: 'When true (default), require unique match.',
      },
      strict: { type: 'boolean', description: 'When true (default), reject ambiguous plans.' },
      content: { type: 'string' },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
      preview: { type: 'boolean' },
      show_diff: { type: 'boolean' },
    },
    required: ['path', 'start_anchor', 'end_anchor'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const startAnchor = requireNonEmptyStringArg(args, 'start_anchor');
    const endAnchor = requireNonEmptyStringArg(args, 'end_anchor');
    const source = resolveFileRangeEditSource(dlg, args);
    const preview = optionalBooleanArg(args, 'preview') ?? false;
    const showDiff = optionalBooleanArg(args, 'show_diff') ?? false;

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

    const res = await runFileBlockReplace(caller, {
      filePath,
      startAnchor,
      endAnchor,
      occurrence,
      occurrenceSpecified,
      includeAnchors,
      match,
      requireUnique,
      strict,
      source,
      preview,
      showDiff,
    });
    return unwrapTxtToolResult(res);
  },
};

export const fileAppendTool: FuncTool = {
  type: 'func',
  name: 'file_append',
  description:
    'Directly append inline content or ws_mod pad content to an rtws file, optionally creating it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      create: { type: 'boolean' },
      content: { type: 'string' },
      pad_id: {
        type: 'string',
        description: 'Optional source scratch pad slug: /^[A-Za-z0-9_-]{1,64}$/.',
      },
      pad_range: {
        type: 'string',
        description: "Optional source pad line range. Defaults to '~' (entire pad).",
      },
      preview: { type: 'boolean' },
      show_diff: { type: 'boolean' },
    },
    required: ['path'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const filePath = requireNonEmptyStringArg(args, 'path');
    const create = optionalBooleanArg(args, 'create');
    const source = resolveFileRangeEditSource(dlg, args);
    const preview = optionalBooleanArg(args, 'preview') ?? false;
    const showDiff = optionalBooleanArg(args, 'show_diff') ?? false;

    const res = await runFileAppend(caller, filePath, source, {
      create: create ?? true,
      preview,
      showDiff,
    });
    return unwrapTxtToolResult(res);
  },
};
