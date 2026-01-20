/**
 * Module: tools/txt
 *
 * Text file tooling for reading and modifying workspace files.
 * Provides `read_file`, `overwrite_file`, `plan_file_modification`, and `apply_file_modification`.
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
import { TextingTool, TextingToolCallResult } from '../tool';

function wrapTextingResult(language: LanguageCode, messages: ChatMessage[]): TextingToolCallResult {
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

function ok(result: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'completed', result, messages };
}

function ensureInsideWorkspace(rel: string): string {
  const file = path.resolve(process.cwd(), rel);
  const cwd = path.resolve(process.cwd());
  if (!file.startsWith(cwd)) {
    throw new Error('Path must be within workspace');
  }
  return file;
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

function parseReadFileOptions(headLine: string): { path: string; options: ReadFileOptions } {
  const trimmed = headLine.trim();

  if (!trimmed.startsWith('@read_file')) {
    throw new Error('Invalid format');
  }

  const afterToolName = trimmed.slice('@read_file'.length).trim();
  const parts = afterToolName.split(/\s+/);

  if (parts.length === 0) {
    throw new Error('Path required');
  }

  // Path is now at the end
  const path = parts[parts.length - 1];
  const options: ReadFileOptions = {
    decorateLinenos: true, // default
    maxLines: 2000, // default
  };

  // Parse options (all parts except the last one which is the path)
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];

    if (part === '!decorate-linenos') {
      const nextPart = parts[i + 1];
      if (nextPart === 'true' || nextPart === 'false') {
        options.decorateLinenos = nextPart === 'true';
        i++; // skip the next part as we consumed it
      } else {
        options.decorateLinenos = true; // default when just flag is present
      }
    } else if (part === '!range') {
      // Parse range format: !range <range_spec>
      const rangePart = parts[i + 1];
      if (rangePart && i + 1 < parts.length - 1) {
        // ensure we don't consume the path
        const rangeMatch = rangePart.match(/^(\d+)?~(\d+)?$/);
        if (rangeMatch) {
          const [, startStr, endStr] = rangeMatch;

          if (startStr) {
            const start = parseInt(startStr, 10);
            if (!isNaN(start) && start > 0) {
              options.rangeStart = start;
            }
          }

          if (endStr) {
            const end = parseInt(endStr, 10);
            if (!isNaN(end) && end > 0) {
              options.rangeEnd = end;
            }
          }

          // Handle special case of just "~" for no range limit
          if (!startStr && !endStr) {
            // "~" means no range limit - don't set rangeStart or rangeEnd
          }

          i++; // skip the range part as we consumed it
        }
      }
    } else if (part === '!max-lines') {
      const nextPart = parts[i + 1];
      if (nextPart && i + 1 < parts.length - 1) {
        // ensure we don't consume the path
        const maxLines = parseInt(nextPart, 10);
        if (!isNaN(maxLines) && maxLines > 0) {
          options.maxLines = maxLines;
          i++; // skip the next part as we consumed it
        }
      }
    }
  }

  return { path, options };
}

function formatFileContent(content: string, options: ReadFileOptions): string {
  const lines = content.split('\n');
  let processedLines = lines;

  // Apply range filtering if specified
  if (options.rangeStart !== undefined && options.rangeEnd !== undefined) {
    const startIdx = Math.max(0, options.rangeStart - 1); // Convert to 0-based index
    const endIdx = Math.min(lines.length, options.rangeEnd); // End is inclusive
    processedLines = lines.slice(startIdx, endIdx);
  }

  // Apply max-lines limit
  if (processedLines.length > options.maxLines) {
    processedLines = processedLines.slice(0, options.maxLines);
  }

  // Apply line number decoration if enabled
  if (options.decorateLinenos) {
    const startLineNum = options.rangeStart || 1;
    processedLines = processedLines.map((line, idx) => {
      const lineNum = startLineNum + idx;
      const paddedLineNum = lineNum.toString().padStart(4, ' ');
      return `${paddedLineNum}| ${line}`;
    });
  }

  return processedLines.join('\n');
}

export const readFileTool: TextingTool = {
  type: 'texter',
  name: 'read_file',
  backfeeding: true,
  usageDescription: `Read a text file (bounded) relative to workspace. 
Usage: !!@read_file [options] <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Options:
  !decorate-linenos [true|false]  - Add line numbers (default: true)
  !range <range>                  - Show specific line range
  !max-lines <number>             - Limit max lines shown (default: 2000)

Range formats:
  10~50     - Lines 10 to 50
  300~      - From line 300 to end
  ~20       - From start to line 20
  ~         - No range limit (entire file)

Examples:
  !!@read_file src/main.ts
  !!@read_file !decorate-linenos false src/main.ts
  !!@read_file !range 10~50 src/main.ts
  !!@read_file !max-lines 100 !range 1~200 src/main.ts
  !!@read_file !range 300~ src/main.ts
  !!@read_file !range ~20 src/main.ts`,
  usageDescriptionI18n: {
    en: `Read a text file (bounded) relative to workspace.
Usage: !!@read_file [options] <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Options:
  !decorate-linenos [true|false]  - Add line numbers (default: true)
  !range <range>                  - Show specific line range
  !max-lines <number>             - Limit max lines shown (default: 2000)

Range formats:
  10~50     - Lines 10 to 50
  300~      - From line 300 to end
  ~20       - From start to line 20
  ~         - No range limit (entire file)

Examples:
  !!@read_file src/main.ts
  !!@read_file !decorate-linenos false src/main.ts
  !!@read_file !range 10~50 src/main.ts
  !!@read_file !max-lines 100 !range 1~200 src/main.ts
  !!@read_file !range 300~ src/main.ts
  !!@read_file !range ~20 src/main.ts`,
    zh: `读取工作区内的文本文件（有上限/可截断）。
用法：!!@read_file [options] <path>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。

选项：
  !decorate-linenos [true|false]  - 显示行号（默认：true）
  !range <range>                  - 读取指定行范围
  !max-lines <number>             - 最多显示行数（默认：2000）

范围格式：
  10~50     - 第 10 行到第 50 行
  300~      - 从第 300 行到文件末尾
  ~20       - 从开头到第 20 行
  ~         - 不限制范围（整文件）

示例：
  !!@read_file src/main.ts
  !!@read_file !decorate-linenos false src/main.ts
  !!@read_file !range 10~50 src/main.ts
  !!@read_file !max-lines 100 !range 1~200 src/main.ts
  !!@read_file !range 300~ src/main.ts
  !!@read_file !range ~20 src/main.ts`,
  },
  async call(dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            formatError:
              '请使用正确的文件读取格式。\n\n**期望格式：** `!!@read_file [options] <path>`\n\n**示例：**\n```\n!!@read_file src/main.ts\n!!@read_file !range 10~50 src/main.ts\n!!@read_file !range 300~ src/main.ts\n```',
            fileLabel: '文件',
            warningTruncated: (totalBytes: number, shownBytes: number) =>
              `⚠️ **警告：** 文件已截断（总大小 ${totalBytes} bytes，当前显示前 ${shownBytes} bytes）\n\n`,
            sizeLabel: '大小',
            optionsLabel: '选项',
            failedToRead: (msg: string) => `❌ **错误**\n\n读取文件失败：${msg}`,
          }
        : {
            formatError:
              'Please use the correct format for reading files.\n\n**Expected format:** `!!@read_file [options] <path>`\n\n**Examples:**\n```\n!!@read_file src/main.ts\n!!@read_file !range 10~50 src/main.ts\n!!@read_file !range 300~ src/main.ts\n```',
            fileLabel: 'File',
            warningTruncated: (totalBytes: number, shownBytes: number) =>
              `⚠️ **Warning:** File was truncated (${totalBytes} bytes total, showing first ${shownBytes} bytes)\n\n`,
            sizeLabel: 'Size',
            optionsLabel: 'Options',
            failedToRead: (msg: string) => `❌ **Error**\n\nFailed to read file: ${msg}`,
          };

    try {
      const { path: rel, options } = parseReadFileOptions(headLine);

      // Check member access permissions
      if (!hasReadAccess(caller, rel)) {
        const content = getAccessDeniedMessage('read', rel, language);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const file = ensureInsideWorkspace(rel);
      const stat = await fs.stat(file);
      const maxFileSize = 200_000; // 200 KB
      const buf = await fs.readFile(file, { encoding: 'utf-8' });
      const fileTruncated = stat.size > maxFileSize;
      const rawContent = fileTruncated ? buf.slice(0, maxFileSize) : buf;

      const formattedContent = formatFileContent(rawContent, options);

      // Create markdown response
      let markdown = `📄 **${labels.fileLabel}:** \`${rel}\`\n`;

      if (fileTruncated) {
        markdown += labels.warningTruncated(stat.size, rawContent.length);
      }

      markdown += `**${labels.sizeLabel}:** ${stat.size} bytes\n`;
      markdown += `**${labels.optionsLabel}:** ${JSON.stringify(options)}\n\n`;

      // Add file content with code block formatting
      markdown += '```\n';
      markdown += formattedContent;
      if (!formattedContent.endsWith('\n')) {
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
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const msg = error instanceof Error ? error.message : String(error);
      const content = labels.failedToRead(msg);
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const overwriteFileTool: TextingTool = {
  type: 'texter',
  name: 'overwrite_file',
  backfeeding: true,
  usageDescription: `Overwrite a file with new content. Usage: !!@overwrite_file <path>
<file content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Examples:
  !!@overwrite_file src/config.ts
  export const config = { version: '1.0' };
  
  !!@overwrite_file README.md
  # My Project
  This is a sample project.`,
  usageDescriptionI18n: {
    en: `Overwrite a file with new content. Usage: !!@overwrite_file <path>
<file content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Examples:
  !!@overwrite_file src/config.ts
  export const config = { version: '1.0' };
  
  !!@overwrite_file README.md
  # My Project
  This is a sample project.`,
    zh: `用新内容覆盖写入一个文件。用法：!!@overwrite_file <path>
<文件内容写在正文里>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。

示例：
  !!@overwrite_file src/config.ts
  export const config = { version: '1.0' };
  
  !!@overwrite_file README.md
  # My Project
  This is a sample project.`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat: '错误：格式不正确。用法：!!@overwrite_file <path>',
            filePathRequired: '错误：需要提供文件路径。',
            contentRequired: '错误：需要在正文中提供文件内容。',
            overwritten: (p: string) => `✅ 文件已覆盖写入：\`${p}\`。`,
            overwriteFailed: (msg: string) => `❌ **错误**\n\n覆盖写入文件失败：${msg}`,
          }
        : {
            invalidFormat: 'Error: Invalid format. Use !!@overwrite_file <path>',
            filePathRequired: 'Error: File path is required.',
            contentRequired: 'Error: File content is required in the body.',
            overwritten: (p: string) => `File '${p}' has been overwritten successfully.`,
            overwriteFailed: (msg: string) => `Error overwriting file: ${msg}`,
          };

    const trimmed = headLine.trim();

    if (!trimmed.startsWith('@overwrite_file')) {
      const content = labels.invalidFormat;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@overwrite_file'.length).trim();
    if (!afterToolName) {
      const content = labels.filePathRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const filePath = afterToolName.split(/\s+/)[0];

    if (!filePath) {
      const content = labels.filePathRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check write access
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!inputBody) {
      const content = labels.contentRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const fullPath = ensureInsideWorkspace(filePath);

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      fsSync.mkdirSync(dir, { recursive: true });

      // Write the file
      fsSync.writeFileSync(fullPath, inputBody, 'utf8');

      const content = labels.overwritten(filePath);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.overwriteFailed(
        error instanceof Error ? error.message : String(error),
      );
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const planFileModificationTool: TextingTool = {
  type: 'texter',
  name: 'plan_file_modification',
  backfeeding: true,
  usageDescription: `Plan a single-file modification by line range (does not write yet).
Usage: !!@plan_file_modification <path> <line~range> [!hunk-id]
<new content lines in body>

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
  3) Apply: confirm by calling \`!!@apply_file_modification !<hunk-id>\`.
  4) Optional revise: re-run this tool with \`!<hunk-id>\` to update the planned hunk.

Tip:
  For multiple hunks, plan each hunk separately.
  - Multiple applies to the same file can be in one message; they are serialized in-process (older planned hunks first).
  - Multiple applies to different files are safe to batch in one message.`,
  usageDescriptionI18n: {
    en: `Plan a single-file modification by line range (does not write yet).
Usage: !!@plan_file_modification <path> <line~range> [!hunk-id]
<new content lines in body>

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
  3) Apply: confirm by calling \`!!@apply_file_modification !<hunk-id>\`.
  4) Optional revise: re-run this tool with \`!<hunk-id>\` to update the planned hunk.

Tip:
  For multiple hunks, plan each hunk separately.
  - Multiple applies to the same file can be in one message; they are serialized in-process (older planned hunks first).
  - Multiple applies to different files are safe to batch in one message.`,
    zh: `按行号范围规划单文件修改（不会立刻写入文件）。
用法：!!@plan_file_modification <path> <line~range> [!hunk-id]
<正文为新内容行>

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
  3) 应用：用 \`!!@apply_file_modification !<hunk-id>\` 显式确认并写入。
  4) 可选修订：再次调用本工具并带上 \`!<hunk-id>\` 更新该规划。

提示：
  多处修改请拆成多个 hunk：分别规划。
  - 同一文件的多个 apply 可放在同一条消息里：系统会在进程内串行应用（按“更早规划的 hunk 先应用”）。
  - 不同文件的多个 apply 放在同一条消息里可安全批量确认。`,
  },
  async call(_dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat:
              '错误：格式不正确。\n\n期望格式：`!!@plan_file_modification <path> <line~range> [!hunk-id]`',
            filePathRequired: '错误：需要提供文件路径。',
            rangeRequired: '错误：需要提供行号范围（例如 10~20 或 ~）。',
            fileDoesNotExist: (p: string) => `错误：文件 \`${p}\` 不存在。`,
            planOk: (id: string) => `✅ 已生成修改规划：\`!${id}\``,
            next: (id: string) =>
              `下一步：执行 \`!!@apply_file_modification !${id}\` 来确认并写入。`,
            hunkIdTaken: (id: string) => `错误：hunk id \`!${id}\` 已被其他成员占用。`,
            planFailed: (msg: string) => `错误：生成修改规划失败：${msg}`,
          }
        : {
            invalidFormat:
              'Error: Invalid format.\n\nExpected: `!!@plan_file_modification <path> <line~range> [!hunk-id]`',
            filePathRequired: 'Error: File path is required.',
            rangeRequired: 'Error: Line range is required (e.g. 10~20 or ~).',
            fileDoesNotExist: (p: string) => `Error: File \`${p}\` does not exist.`,
            planOk: (id: string) => `Planned modification: \`!${id}\``,
            next: (id: string) =>
              `Next: run \`!!@apply_file_modification !${id}\` to confirm and write.`,
            hunkIdTaken: (id: string) =>
              `Error: hunk id \`!${id}\` is already owned by a different member.`,
            planFailed: (msg: string) => `Error planning modification: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@plan_file_modification')) {
      const content = labels.invalidFormat;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@plan_file_modification'.length).trim();
    if (!afterToolName) {
      const content = labels.filePathRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const parts = afterToolName.split(/\s+/).filter((p) => p.length > 0);
    const filePath = parts[0] ?? '';
    const rangeSpec = parts[1] ?? '';
    const maybeId = parts[2] ?? '';
    const requestedId = parseOptionalHunkId(maybeId);
    if (!filePath) {
      const content = labels.filePathRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    if (!rangeSpec) {
      const content = labels.rangeRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check write access
    if (!hasWriteAccess(caller, filePath)) {
      const content = getAccessDeniedMessage('write', filePath, language);
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      pruneExpiredPlannedMods(Date.now());
      const fullPath = ensureInsideWorkspace(filePath);

      // Check if file exists
      if (!fsSync.existsSync(fullPath)) {
        const content = labels.fileDoesNotExist(filePath);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Read current file content
      const currentContent = fsSync.readFileSync(fullPath, 'utf8');
      const currentLines = currentContent.split('\n');

      const totalLines = currentLines.length;
      const parsed = parseLineRangeSpec(rangeSpec, totalLines);
      if (!parsed.ok) {
        const content =
          language === 'zh'
            ? `错误：行号范围无效：${parsed.error}`
            : `Error: invalid line range: ${parsed.error}`;
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
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
      const hunkId = requestedId ?? generateHunkId();
      if (requestedId) {
        const existing = plannedModsById.get(hunkId);
        if (existing && existing.plannedBy !== caller.id) {
          const content = labels.hunkIdTaken(hunkId);
          return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
        }
      }
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
          ? `（可选：用 \`!!@plan_file_modification ${filePath} ${rangeSpec} !${hunkId}\` 重新规划并覆写该 hunk。）`
          : `Optional: revise by running \`!!@plan_file_modification ${filePath} ${rangeSpec} !${hunkId}\` with corrected body.`;

      const content =
        `${labels.planOk(hunkId)}\n\n` +
        `**File:** \`${filePath}\`\n` +
        `**Range:** \`${rangeLabel}\`\n\n` +
        `\`\`\`diff\n${unifiedDiff}\`\`\`\n\n` +
        `${labels.next(hunkId)}\n` +
        `${reviseHint}`;

      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.planFailed(error instanceof Error ? error.message : String(error));
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const applyFileModificationTool: TextingTool = {
  type: 'texter',
  name: 'apply_file_modification',
  usageDescription:
    'Apply a previously planned file modification by hunk id.\n' +
    'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
    'Notes: Applies are serialized per file (single-process). The hunk may still apply if lines moved, as long as the original target content is uniquely matchable.\n' +
    'Usage: !!@apply_file_modification !<hunk-id>\n' +
    '(no body)',
  usageDescriptionI18n: {
    en:
      'Apply a previously planned file modification by hunk id.\n' +
      'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
      'Notes: Applies are serialized per file (single-process). The hunk may still apply if lines moved, as long as the original target content is uniquely matchable.\n' +
      'Usage: !!@apply_file_modification !<hunk-id>\n' +
      '(no body)',
    zh:
      '按 hunk id 应用之前规划的单文件修改。\n' +
      '注意：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。\n' +
      '说明：同一文件的 apply 会在进程内串行化；若行号发生移动，只要能在文件中唯一定位到原始目标内容，仍可应用。\n' +
      '用法：!!@apply_file_modification !<hunk-id>\n' +
      '（无正文）',
  },
  backfeeding: true,
  async call(_dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            invalidFormat: '错误：格式不正确。用法：!!@apply_file_modification !<hunk-id>',
            hunkIdRequired: '错误：需要提供要应用的 hunk id（例如 `!a1b2c3d4`）。',
            notFound: (id: string) => `错误：未找到该 hunk：\`!${id}\`（可能已过期或已被应用）。`,
            wrongOwner: '错误：该 hunk 不是由当前成员规划的，不能应用。',
            mismatch: '错误：文件内容已变化，无法安全应用该 hunk；请重新规划。',
            ambiguous:
              '错误：无法唯一定位该 hunk 的目标位置（文件内出现多处匹配）；请重新规划（缩小范围或增加上下文）。',
            applied: (p: string, id: string) => `✅ 已应用：\`${p}\`（\`!${id}\`）`,
            applyFailed: (msg: string) => `错误：应用失败：${msg}`,
          }
        : {
            invalidFormat: 'Error: Invalid format. Use !!@apply_file_modification !<hunk-id>',
            hunkIdRequired: 'Error: hunk id is required (e.g. `!a1b2c3d4`).',
            notFound: (id: string) =>
              `Error: hunk \`!${id}\` not found (expired or already applied).`,
            wrongOwner: 'Error: this hunk was planned by a different member.',
            mismatch:
              'Error: file content has changed; refusing to apply this hunk safely. Re-plan it.',
            ambiguous:
              'Error: unable to uniquely locate the hunk target (multiple matches). Re-plan with a narrower range or more context.',
            applied: (p: string, id: string) => `Applied: \`${p}\` (\`!${id}\`)`,
            applyFailed: (msg: string) => `Error applying modification: ${msg}`,
          };

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@apply_file_modification')) {
      const content = labels.invalidFormat;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const afterToolName = trimmed.slice('@apply_file_modification'.length).trim();
    if (!afterToolName) {
      const content = labels.hunkIdRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const raw = afterToolName.split(/\s+/)[0] ?? '';
    const id = raw.startsWith('!') ? raw.slice(1) : raw;
    if (!id) {
      const content = labels.hunkIdRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      pruneExpiredPlannedMods(Date.now());
      const planned = plannedModsById.get(id);
      if (!planned) {
        const content = labels.notFound(id);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (planned.plannedBy !== caller.id) {
        const content = labels.wrongOwner;
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (!hasWriteAccess(caller, planned.relPath)) {
        const content = getAccessDeniedMessage('write', planned.relPath, language);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const absKey = planned.absPath;
      const res = await new Promise<TextingToolCallResult>((resolve) => {
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
                  wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]),
                );
                return;
              }
              if (p.plannedBy !== caller.id) {
                const content = labels.wrongOwner;
                resolve(
                  wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]),
                );
                return;
              }

              const currentContent = fsSync.readFileSync(p.absPath, 'utf8');
              const currentLines = currentContent.split('\n');

              let startIndex0 = -1;
              if (p.deleteCount === 0 && p.oldLines.length === 0) {
                // Append-at-end is stable even if the file has changed.
                startIndex0 = currentLines.length;
              } else if (matchesAt(currentLines, p.startIndex0, p.oldLines)) {
                startIndex0 = p.startIndex0;
              } else {
                const all = findAllMatches(currentLines, p.oldLines);
                if (all.length === 0) {
                  const content = labels.mismatch;
                  resolve(
                    wrapTextingResult(language, [
                      { type: 'environment_msg', role: 'user', content },
                    ]),
                  );
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
                    const content = labels.ambiguous;
                    resolve(
                      wrapTextingResult(language, [
                        { type: 'environment_msg', role: 'user', content },
                      ]),
                    );
                    return;
                  }
                }
              }

              const nextLines = [...currentLines];
              nextLines.splice(startIndex0, p.deleteCount, ...p.newLines);
              fsSync.writeFileSync(p.absPath, nextLines.join('\n'), 'utf8');
              plannedModsById.delete(id);

              const content = `${labels.applied(p.relPath, id)}\n\n\`\`\`diff\n${p.unifiedDiff}\`\`\``;
              resolve(ok(content, [{ type: 'environment_msg', role: 'user', content }]));
            } catch (error: unknown) {
              const content = labels.applyFailed(
                error instanceof Error ? error.message : String(error),
              );
              resolve(
                wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]),
              );
            }
          },
        });
        void drainFileApplyQueue(absKey);
      });

      return res;
    } catch (error: unknown) {
      const content = labels.applyFailed(error instanceof Error ? error.message : String(error));
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
