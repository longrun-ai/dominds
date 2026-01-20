/**
 * Module: tools/txt
 *
 * Text file tooling for reading and modifying workspace files.
 * Provides `read_file`, `overwrite_file`, `patch_file`, and `apply_patch`.
 */
import { execSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
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

export const patchFileTool: TextingTool = {
  type: 'texter',
  name: 'patch_file',
  backfeeding: true,
  usageDescription: `Apply a simple patch to a single file. Usage: !!@patch_file <path>
<patch content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Patch format:
  @@ -<old_line>,<old_count> +<new_line>,<new_count> @@
  -removed line
  +added line
   unchanged line

Example:
  !!@patch_file src/config.ts
  @@ -5,3 +5,4 @@
   export const config = {
     version: '1.0',
  +  debug: true,
   };`,
  usageDescriptionI18n: {
    en: `Apply a simple patch to a single file. Usage: !!@patch_file <path>
<patch content in body>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools.

Patch format:
  @@ -<old_line>,<old_count> +<new_line>,<new_count> @@
  -removed line
  +added line
   unchanged line

Example:
  !!@patch_file src/config.ts
  @@ -5,3 +5,4 @@
   export const config = {
     version: '1.0',
  +  debug: true,
   };`,
    zh: `对单个文件应用简单补丁。用法：!!@patch_file <path>
<补丁内容写在正文里>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具不可访问。

补丁格式：
  @@ -<old_line>,<old_count> +<new_line>,<new_count> @@
  -删除的行
  +新增的行
   未改变的行

示例：
  !!@patch_file src/config.ts
  @@ -5,3 +5,4 @@
   export const config = {
     version: '1.0',
  +  debug: true,
   };`,
  },
  async call(dlg, caller, headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            patchContentRequired: '错误：需要在正文中提供补丁内容。',
            invalidFormat: '错误：格式不正确。用法：!!@patch_file <path>',
            filePathRequired: '错误：需要提供文件路径。',
            fileDoesNotExist: (p: string) => `错误：文件 '${p}' 不存在。`,
            missingHunkHeader: '错误：补丁格式无效：缺少 @@ hunk 头。',
            invalidHunkHeader: '错误：hunk 头格式无效。',
            applied: (p: string) => `✅ 已将补丁应用到：\`${p}\`。`,
            applyFailed: (msg: string) => `错误：应用补丁失败：${msg}`,
          }
        : {
            patchContentRequired: 'Error: Patch content is required in the body.',
            invalidFormat: 'Error: Invalid format. Use !!@patch_file <path>',
            filePathRequired: 'Error: File path is required.',
            fileDoesNotExist: (p: string) => `Error: File '${p}' does not exist.`,
            missingHunkHeader: 'Error: Invalid patch format. Missing @@ hunk header.',
            invalidHunkHeader: 'Error: Invalid hunk header format.',
            applied: (p: string) => `Patch applied successfully to '${p}'.`,
            applyFailed: (msg: string) => `Error applying patch: ${msg}`,
          };

    if (!inputBody || inputBody.trim() === '') {
      const content = labels.patchContentRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@patch_file')) {
      const content = labels.invalidFormat;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@patch_file'.length).trim();
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

    try {
      const fullPath = ensureInsideWorkspace(filePath);

      // Check if file exists
      if (!fsSync.existsSync(fullPath)) {
        const content = labels.fileDoesNotExist(filePath);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Read current file content
      const currentContent = fsSync.readFileSync(fullPath, 'utf8');
      const currentLines = currentContent.split('\n');

      // Parse the patch
      const patchContent = inputBody.trim();
      const patchLines = patchContent.split('\n');

      // Find the hunk header
      let hunkHeaderIndex = -1;
      for (let i = 0; i < patchLines.length; i++) {
        if (patchLines[i].startsWith('@@')) {
          hunkHeaderIndex = i;
          break;
        }
      }

      if (hunkHeaderIndex === -1) {
        const content = labels.missingHunkHeader;
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
      const hunkHeader = patchLines[hunkHeaderIndex];
      const hunkMatch = hunkHeader.match(/^@@\s*-(\d+),(\d+)\s*\+(\d+),(\d+)\s*@@/);
      if (!hunkMatch) {
        const content = labels.invalidHunkHeader;
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const oldStart = parseInt(hunkMatch[1]) - 1; // Convert to 0-based
      const oldCount = parseInt(hunkMatch[2]);
      const newStart = parseInt(hunkMatch[3]) - 1; // Convert to 0-based

      // Apply the patch
      const newLines = [...currentLines];
      const hunkLines = patchLines.slice(hunkHeaderIndex + 1);

      let oldLineIndex = oldStart;
      let newLineIndex = newStart;
      let insertions: string[] = [];
      let deletions = 0;

      for (const line of hunkLines) {
        if (line.startsWith('-')) {
          // Line to be removed
          deletions++;
        } else if (line.startsWith('+')) {
          // Line to be added
          insertions.push(line.substring(1));
        } else if (line.startsWith(' ')) {
          // Context line - apply any pending changes first
          if (deletions > 0 || insertions.length > 0) {
            // Remove deleted lines and insert new lines
            newLines.splice(oldLineIndex, deletions, ...insertions);
            oldLineIndex += insertions.length;
            deletions = 0;
            insertions = [];
          }
          oldLineIndex++;
        }
      }

      // Apply any remaining changes
      if (deletions > 0 || insertions.length > 0) {
        newLines.splice(oldLineIndex, deletions, ...insertions);
      }

      // Write the modified content back to the file
      const newContent = newLines.join('\n');
      fsSync.writeFileSync(fullPath, newContent, 'utf8');

      const content = labels.applied(filePath);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.applyFailed(error instanceof Error ? error.message : String(error));
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const applyPatchTool: TextingTool = {
  type: 'texter',
  name: 'apply_patch',
  usageDescription:
    'Apply a unified git diff patch to the workspace.\n' +
    'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
    'Usage: !!@apply_patch\n<diff content in body>',
  usageDescriptionI18n: {
    en:
      'Apply a unified git diff patch to the workspace.\n' +
      'Note: Paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.\n' +
      'Usage: !!@apply_patch\n<diff content in body>',
    zh:
      '对工作区应用 unified git diff 补丁。\n' +
      '注意：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。\n' +
      '用法：!!@apply_patch\n<diff 内容写在正文里>',
  },
  backfeeding: true,
  async call(_dlg, caller, _headLine, inputBody): Promise<TextingToolCallResult> {
    const language = getWorkLanguage();
    const labels =
      language === 'zh'
        ? {
            patchContentRequired: '错误：需要在正文中提供补丁内容。',
            applied: '✅ 已应用补丁。',
            applyFailed: (msg: string) => `错误：应用补丁失败：${msg}`,
          }
        : {
            patchContentRequired: 'Error: Patch content is required in the body.',
            applied: 'Patch applied successfully.',
            applyFailed: (msg: string) => `Error applying patch: ${msg}`,
          };

    if (!inputBody || inputBody.trim() === '') {
      const content = labels.patchContentRequired;
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const diffContent = inputBody.trim();

    // Parse the diff to extract file paths for access control
    const affectedFiles: string[] = [];
    const lines = diffContent.split('\n');

    for (const line of lines) {
      // Look for file headers in unified diff format
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const filePath = line.substring(4).trim();
        // Remove a/ or b/ prefixes if present
        const cleanPath = filePath.replace(/^[ab]\//, '');
        if (cleanPath !== '/dev/null' && !affectedFiles.includes(cleanPath)) {
          affectedFiles.push(cleanPath);
        }
      }
    }

    // Check write access for all affected files
    for (const filePath of affectedFiles) {
      if (!hasWriteAccess(caller, filePath)) {
        const content = getAccessDeniedMessage('write', filePath, language);
        return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
      }
    }

    try {
      // Create a temporary file for the patch
      const tempFile = path.join(os.tmpdir(), `patch-${Date.now()}.diff`);
      fsSync.writeFileSync(tempFile, diffContent);

      // Apply the patch using git apply
      execSync(`git apply "${tempFile}"`, {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      // Clean up the temporary file
      fsSync.unlinkSync(tempFile);

      const content = labels.applied;
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = labels.applyFailed(error instanceof Error ? error.message : String(error));
      return wrapTextingResult(language, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
