/**
 * Module: tools/fs
 *
 * Filesystem tellask tools: list directories, remove directories/files.
 * Includes helpers for text-file detection and line counting.
 */
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { ChatMessage } from '../llm/client';
import { log } from '../log';
import { getWorkLanguage } from '../shared/runtime-language';
import { TellaskTool, TellaskToolCallResult } from '../tool';

interface DirectoryEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size?: number;
  lines?: number;
  target?: string;
}

function ok(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'completed', result, messages };
}

function fail(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'failed', result, messages };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function isTextFile(filename: string): boolean {
  // prettier-ignore
  const textExtensions = [
    '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.xml', '.html', '.htm',
    '.css', '.scss', '.sass', '.less', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
    '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash',
    '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml', '.ini',
    '.cfg', '.conf', '.config', '.env', '.gitignore', '.gitattributes', '.editorconfig',
    '.prettierrc', '.eslintrc', '.babelrc', '.dockerignore', '.dockerfile', '.makefile',
    '.cmake', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro', '.r', '.R',
    '.m', '.mm', '.pl', '.pm', '.lua', '.vim', '.vimrc', '.tmux', '.zshrc',
    '.bashrc', '.profile', '.aliases', '.functions', '.exports', '.path', '.extra', '.log',
  ];

  const ext = path.extname(filename).toLowerCase();
  const basename = path.basename(filename).toLowerCase();

  // Check by extension
  if (textExtensions.includes(ext)) {
    return true;
  }

  // Check by common filenames without extensions
  // prettier-ignore
  const textFilenames = [
    'readme', 'license', 'changelog', 'contributing', 'authors', 'contributors',
    'copying', 'install', 'news', 'todo', 'makefile', 'dockerfile', 'gemfile',
    'rakefile', 'procfile', 'vagrantfile', 'gruntfile', 'gulpfile', 'webpack',
  ];

  return textFilenames.includes(basename) || textFilenames.includes(basename.split('.')[0]);
}

async function countLines(filePath: string): Promise<number> {
  try {
    const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity, // Handle Windows line endings properly
    });

    let lineCount = 0;
    for await (const line of rl) {
      lineCount++;
    }

    return lineCount;
  } catch (err) {
    log.warn(`Failed to count lines in file ${filePath}:`, err);
    return 0; // Return 0 if file can't be read as text
  }
}

export const listDirTool: TellaskTool = {
  type: 'texter',
  name: 'list_dir',
  backfeeding: true,
  usageDescription: `List directory contents relative to workspace with detailed information.
Usage: !?@list_dir [path]

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including listing).

Features:
- Shows file sizes for all entries
- Shows line count for text files
- Shows symbolic link targets
- Categorizes entries by type (dir, file, symlink, other)

Example:
!?@list_dir src/tools`,
  usageDescriptionI18n: {
    en: `List directory contents relative to workspace with detailed information.
Usage: !?@list_dir [path]

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including listing).

Features:
- Shows file sizes for all entries
- Shows line count for text files
- Shows symbolic link targets
- Categorizes entries by type (dir, file, symlink, other)

Example:
!?@list_dir src/tools`,
    zh: `列出工作区内目录内容（包含详细信息）。
用法：!?@list_dir [path]

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具（包括列目录）不可访问。

功能：
- 显示每个条目的文件大小
- 对文本文件显示行数
- 显示符号链接目标
- 按类型分类（dir、file、symlink、other）

示例：
!?@list_dir src/tools`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            formatError:
              '请使用正确的目录列出格式。\n\n**期望格式：** `!?@list_dir [path]`\n\n**示例：**\n```\n!?@list_dir src/tools\n```',
            accessDenied: '❌ **访问被拒绝**\n\n路径必须位于工作区内',
            notFound: (p: string) => `❌ **未找到**\n\n目录 \`${p}\` 不存在。`,
            notDir: (p: string) => `❌ **错误**\n\n路径 \`${p}\` 不是目录。`,
            readDirFailed: (msg: string) => `❌ **错误**\n\n读取目录失败：${msg}`,
            dirHeader: '📁 **目录：**',
            emptyDir: '_此目录为空。_',
            table: {
              name: '名称',
              type: '类型',
              size: '大小',
              lines: '行数',
              target: '目标',
            },
          }
        : {
            formatError:
              'Please use the correct format for listing directories.\n\n**Expected format:** `!?@list_dir [path]`\n\n**Example:**\n```\n!?@list_dir src/tools\n```',
            accessDenied: '❌ **Access Denied**\n\nPath must be within workspace',
            notFound: (p: string) => `❌ **Not Found**\n\nDirectory \`${p}\` does not exist.`,
            notDir: (p: string) => `❌ **Error**\n\nPath \`${p}\` is not a directory.`,
            readDirFailed: (msg: string) => `❌ **Error**\n\nFailed to read directory: ${msg}`,
            dirHeader: '📁 **Directory:**',
            emptyDir: '_This directory is empty._',
            table: {
              name: 'Name',
              type: 'Type',
              size: 'Size',
              lines: 'Lines',
              target: 'Target',
            },
          };

    // Parse path from headLine - expect format "@list_dir [path]"
    const trimmed = headLine.trim();
    let rel = '.';

    if (trimmed.startsWith('@list_dir')) {
      const afterToolName = trimmed.slice('@list_dir'.length).trim();
      rel = afterToolName || '.';
    } else {
      const content = labels.formatError;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const dir = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!dir.startsWith(cwd)) {
      const content = labels.accessDenied;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member access permissions
    if (!hasReadAccess(caller, rel)) {
      const content = getAccessDeniedMessage('read', rel, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      try {
        const stats = await fs.lstat(dir);
        if (!stats.isDirectory()) {
          const content = labels.notDir(rel);
          return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
        }
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          const content = labels.notFound(rel);
          return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
        }

        const msg = error instanceof Error ? error.message : String(error);
        const content = labels.readDirFailed(msg);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const data: DirectoryEntry[] = [];

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        const dirEntry: DirectoryEntry = {
          name: entry.name,
          type: 'other',
        };

        try {
          const stats = await fs.lstat(entryPath);

          if (entry.isDirectory()) {
            dirEntry.type = 'dir';
            dirEntry.size = stats.size;
          } else if (entry.isFile()) {
            dirEntry.type = 'file';
            dirEntry.size = stats.size;

            // Count lines for text files
            if (isTextFile(entry.name)) {
              dirEntry.lines = await countLines(entryPath);
            }
          } else if (entry.isSymbolicLink()) {
            dirEntry.type = 'symlink';
            dirEntry.size = stats.size;

            try {
              const target = await fs.readlink(entryPath);
              dirEntry.target = target;

              // If symlink points to a text file, count lines from the target
              try {
                const targetStats = await fs.stat(entryPath); // Follow the symlink
                if (targetStats.isFile() && isTextFile(entry.name)) {
                  dirEntry.lines = await countLines(entryPath);
                }
              } catch (err) {
                log.warn(`Failed to stat symlink target ${entryPath}:`, err);
                // Target doesn't exist or can't be accessed
              }
            } catch (err) {
              log.warn(`Failed to read symlink ${entryPath}:`, err);
              dirEntry.target = '<unreadable>';
            }
          } else {
            dirEntry.type = 'other';
            dirEntry.size = stats.size;
          }
        } catch (error) {
          // If we can't stat the entry, just include basic info
          if (entry.isDirectory()) {
            dirEntry.type = 'dir';
          } else if (entry.isFile()) {
            dirEntry.type = 'file';
          } else if (entry.isSymbolicLink()) {
            dirEntry.type = 'symlink';
            dirEntry.target = '<error>';
          }
        }

        data.push(dirEntry);
      }

      const relativeDir = path.relative(cwd, dir) || '.';

      // Create markdown table for directory entries
      let markdown = `${labels.dirHeader} \`${relativeDir}\`\n\n`;

      if (data.length === 0) {
        markdown += labels.emptyDir;
      } else {
        markdown += `| ${labels.table.name} | ${labels.table.type} | ${labels.table.size} | ${labels.table.lines} | ${labels.table.target} |\n`;
        markdown += '|------|------|------|-------|--------|\n';

        for (const entry of data) {
          const typeIcon =
            entry.type === 'dir'
              ? '📁'
              : entry.type === 'file'
                ? '📄'
                : entry.type === 'symlink'
                  ? '🔗'
                  : '❓';

          const sizeStr = entry.size ? formatSize(entry.size) : '-';
          const linesStr = entry.lines ? entry.lines.toString() : '-';
          const targetStr = entry.target ? `→ ${entry.target}` : '-';

          markdown += `| ${typeIcon} \`${entry.name}\` | ${entry.type} | ${sizeStr} | ${linesStr} | ${targetStr} |\n`;
        }
      }

      return ok(markdown, [{ type: 'environment_msg', role: 'user', content: markdown }]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = labels.notFound(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOTDIR'
      ) {
        const content = labels.notDir(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const msg = error instanceof Error ? error.message : String(error);
      const content = labels.readDirFailed(msg);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const rmDirTool: TellaskTool = {
  type: 'texter',
  name: 'rm_dir',
  backfeeding: true,
  usageDescription: `Remove a directory relative to workspace.
Usage: !?@rm_dir <path> [options]

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including deletion).

Options:
  !recursive [true|false]  - Remove directory and all contents (default: false)

Examples:
  !?@rm_dir temp
  !?@rm_dir build !recursive true`,
  usageDescriptionI18n: {
    en: `Remove a directory relative to workspace.
Usage: !?@rm_dir <path> [options]

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including deletion).

Options:
  !recursive [true|false]  - Remove directory and all contents (default: false)

Examples:
  !?@rm_dir temp
  !?@rm_dir build !recursive true`,
    zh: `删除工作区内的目录。
用法：!?@rm_dir <path> [options]

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具（包括删除）不可访问。

选项：
  !recursive [true|false]  - 递归删除目录及其内容（默认：false）

示例：
  !?@rm_dir temp
  !?@rm_dir build !recursive true`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            formatError:
              '请使用正确的目录删除格式。\n\n**期望格式：** `!?@rm_dir <path> [!recursive true|false]`\n\n**示例：**\n```\n!?@rm_dir temp !recursive true\n```',
            dirPathRequired: '❌ **错误**\n\n需要提供目录路径。',
            pathMustBeWithinWorkspace: '❌ **错误**\n\n路径必须位于工作区内。',
            notDir: (p: string) => `❌ **错误**\n\n\`${p}\` 不是目录。`,
            notEmpty: (p: string) =>
              `❌ **错误**\n\n目录 \`${p}\` 非空。请使用 \`!recursive true\` 删除非空目录。`,
            removed: (p: string) => `✅ 已删除目录：\`${p}\`。`,
            doesNotExist: (p: string) => `❌ **未找到**\n\n目录 \`${p}\` 不存在。`,
            removeFailed: (msg: string) => `❌ **错误**\n\n删除目录失败：${msg}`,
          }
        : {
            formatError:
              'Please use the correct format for removing directories.\n\n**Expected format:** `!?@rm_dir <path> [!recursive true|false]`\n\n**Example:**\n```\n!?@rm_dir temp !recursive true\n```',
            dirPathRequired: '❌ **Error**\n\nDirectory path is required.',
            pathMustBeWithinWorkspace: '❌ **Error**\n\nPath must be within workspace.',
            notDir: (p: string) => `❌ **Error**\n\n\`${p}\` is not a directory.`,
            notEmpty: (p: string) =>
              `❌ **Error**\n\nDirectory \`${p}\` is not empty. Use \`!recursive true\` to remove non-empty directories.`,
            removed: (p: string) => `✅ Removed directory: \`${p}\`.`,
            doesNotExist: (p: string) => `❌ **Not Found**\n\nDirectory \`${p}\` does not exist.`,
            removeFailed: (msg: string) => `❌ **Error**\n\nError removing directory: ${msg}`,
          };

    // Parse path and options from headLine
    const trimmed = headLine.trim();
    let rel = '';
    let recursive = false;

    if (trimmed.startsWith('@rm_dir')) {
      const afterToolName = trimmed.slice('@rm_dir'.length).trim();
      const parts = afterToolName.split(/\s+/);

      if (parts.length === 0 || !parts[0]) {
        const content = labels.dirPathRequired;
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      rel = parts[0];

      // Parse options
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '!recursive' && i + 1 < parts.length) {
          recursive = parts[i + 1].toLowerCase() === 'true';
          i++; // Skip the value
        }
      }
    } else {
      const content = labels.formatError;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      const content = labels.pathMustBeWithinWorkspace;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      const content = getAccessDeniedMessage('write', rel, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      // Check if path exists and is a directory
      const stats = await fs.lstat(targetPath);
      if (!stats.isDirectory()) {
        const content = labels.notDir(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Check if directory is empty when not using recursive
      if (!recursive) {
        const entries = await fs.readdir(targetPath);
        if (entries.length > 0) {
          const content = labels.notEmpty(rel);
          return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
        }
      }

      // Remove the directory
      await fs.rmdir(targetPath, { recursive });

      const content = labels.removed(rel);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = labels.doesNotExist(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const content = labels.removeFailed(error instanceof Error ? error.message : String(error));
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const rmFileTool: TellaskTool = {
  type: 'texter',
  name: 'rm_file',
  backfeeding: true,
  usageDescription: `Remove a file relative to workspace.
Usage: !?@rm_file <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including deletion).

Example:
  !?@rm_file temp/old-file.txt`,
  usageDescriptionI18n: {
    en: `Remove a file relative to workspace.
Usage: !?@rm_file <path>

Note:
  Paths under \`*.tsk/\` are encapsulated Task Docs and are NOT accessible via file tools (including deletion).

Example:
  !?@rm_file temp/old-file.txt`,
    zh: `删除工作区内的文件。
用法：!?@rm_file <path>

注意：
  \`*.tsk/\` 下的路径属于封装差遣牒，文件工具（包括删除）不可访问。

示例：
  !?@rm_file temp/old-file.txt`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            formatError:
              '请使用正确的文件删除格式。\n\n**期望格式：** `!?@rm_file <path>`\n\n**示例：**\n```\n!?@rm_file temp/old-file.txt\n```',
            filePathRequired: '❌ **错误**\n\n需要提供文件路径。',
            pathMustBeWithinWorkspace: '❌ **错误**\n\n路径必须位于工作区内。',
            notFile: (p: string) => `❌ **错误**\n\n\`${p}\` 不是文件。`,
            removed: (p: string) => `✅ 已删除文件：\`${p}\`。`,
            doesNotExist: (p: string) => `❌ **未找到**\n\n文件 \`${p}\` 不存在。`,
            removeFailed: (msg: string) => `❌ **错误**\n\n删除文件失败：${msg}`,
          }
        : {
            formatError:
              'Please use the correct format for removing files.\n\n**Expected format:** `!?@rm_file <path>`\n\n**Example:**\n```\n!?@rm_file temp/old-file.txt\n```',
            filePathRequired: '❌ **Error**\n\nFile path is required.',
            pathMustBeWithinWorkspace: '❌ **Error**\n\nPath must be within workspace.',
            notFile: (p: string) => `❌ **Error**\n\n\`${p}\` is not a file.`,
            removed: (p: string) => `✅ Removed file: \`${p}\`.`,
            doesNotExist: (p: string) => `❌ **Not Found**\n\nFile \`${p}\` does not exist.`,
            removeFailed: (msg: string) => `❌ **Error**\n\nError removing file: ${msg}`,
          };

    // Parse path from headLine
    const trimmed = headLine.trim();
    let rel = '';

    if (trimmed.startsWith('@rm_file')) {
      const afterToolName = trimmed.slice('@rm_file'.length).trim();
      rel = afterToolName;
    } else {
      const content = labels.formatError;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!rel) {
      const content = labels.filePathRequired;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      const content = labels.pathMustBeWithinWorkspace;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      const content = getAccessDeniedMessage('write', rel, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      // Check if path exists and is a file
      const stats = await fs.lstat(targetPath);
      if (!stats.isFile()) {
        const content = labels.notFile(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Remove the file
      await fs.unlink(targetPath);

      const content = labels.removed(rel);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = labels.doesNotExist(rel);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const content = labels.removeFailed(error instanceof Error ? error.message : String(error));
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function parseBooleanOption(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

async function countDirEntries(absPath: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  for (const entry of entries) {
    count++;
    if (entry.isDirectory()) {
      count += await countDirEntries(path.join(absPath, entry.name));
    }
  }
  return count;
}

export const mkDirTool: TellaskTool = {
  type: 'texter',
  name: 'mk_dir',
  backfeeding: true,
  usageDescription: `Create a directory relative to workspace.
Usage: !?@mk_dir <path> [options]

Options:
  parents=true|false (default: true)`,
  usageDescriptionI18n: {
    en: `Create a directory relative to workspace.
Usage: !?@mk_dir <path> [options]

Options:
  parents=true|false (default: true)`,
    zh: `创建工作区内目录。
用法：!?@mk_dir <path> [options]

选项：
  parents=true|false（默认 true）`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@mk_dir')) {
      const yaml = [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Mk-dir failed: invalid format. Use !?@mk_dir <path> [parents=true|false].'
            : 'Mk-dir failed: invalid format. Use !?@mk_dir <path> [parents=true|false].',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const after = trimmed.slice('@mk_dir'.length).trim();
    const parts = after.split(/\s+/).filter((p) => p.length > 0);
    const rel = parts[0] ?? '';
    if (!rel) {
      const yaml = [
        `status: error`,
        `error: PATH_REQUIRED`,
        `summary: ${yamlQuote(workLanguage === 'zh' ? 'Mk-dir failed: path required.' : 'Mk-dir failed: path required.')}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    let parents = true;
    for (const tok of parts.slice(1)) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (key === 'parents') {
        const parsed = parseBooleanOption(value);
        if (parsed !== undefined) parents = parsed;
      }
    }

    const targetPath = path.resolve(process.cwd(), rel);
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      const yaml = [
        `status: error`,
        `path: ${yamlQuote(rel)}`,
        `error: PATH_OUTSIDE_WORKSPACE`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Mk-dir failed: path must be within workspace.'
            : 'Mk-dir failed: path must be within workspace.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!hasWriteAccess(caller, rel)) {
      const content = getAccessDeniedMessage('write', rel, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const st = await fs.lstat(targetPath).catch((err: unknown) => {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: unknown }).code === 'ENOENT'
        ) {
          return undefined;
        }
        throw err;
      });
      if (st) {
        if (!st.isDirectory()) {
          const yaml = [
            `status: error`,
            `path: ${yamlQuote(rel)}`,
            `error: PATH_EXISTS_NOT_DIR`,
            `summary: ${yamlQuote(
              workLanguage === 'zh'
                ? 'Mk-dir failed: path exists and is not a directory.'
                : 'Mk-dir failed: path exists and is not a directory.',
            )}`,
          ].join('\n');
          const content = formatYamlCodeBlock(yaml);
          return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
        }
        const yaml = [
          `status: ok`,
          `path: ${yamlQuote(rel)}`,
          `created: false`,
          `summary: ${yamlQuote(`Mk-dir: ${rel} (parents=${parents}).`)}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      await fs.mkdir(targetPath, { recursive: parents });
      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(rel)}`,
        `created: true`,
        `summary: ${yamlQuote(`Mk-dir: ${rel} (parents=${parents}).`)}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `path: ${yamlQuote(rel)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const moveFileTool: TellaskTool = {
  type: 'texter',
  name: 'move_file',
  backfeeding: true,
  usageDescription: `Move/rename a file relative to workspace.
Usage: !?@move_file <from> <to>`,
  usageDescriptionI18n: {
    en: `Move/rename a file relative to workspace.
Usage: !?@move_file <from> <to>`,
    zh: `移动/重命名工作区内文件。
用法：!?@move_file <from> <to>`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@move_file')) {
      const yaml = [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-file failed: invalid format. Use !?@move_file <from> <to>.'
            : 'Move-file failed: invalid format. Use !?@move_file <from> <to>.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const after = trimmed.slice('@move_file'.length).trim();
    const parts = after.split(/\s+/).filter((p) => p.length > 0);
    const from = parts[0] ?? '';
    const to = parts[1] ?? '';
    if (!from || !to) {
      const yaml = [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-file failed: from/to required.'
            : 'Move-file failed: from/to required.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const absFrom = path.resolve(process.cwd(), from);
    const absTo = path.resolve(process.cwd(), to);
    const cwd = path.resolve(process.cwd());
    if (!absFrom.startsWith(cwd) || !absTo.startsWith(cwd)) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: PATH_OUTSIDE_WORKSPACE`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-file failed: paths must be within workspace.'
            : 'Move-file failed: paths must be within workspace.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!hasWriteAccess(caller, from) || !hasWriteAccess(caller, to)) {
      const content = getAccessDeniedMessage('write', from, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const st = await fs.lstat(absFrom);
      if (!st.isFile()) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: FROM_NOT_FILE`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-file failed: from is not a file.'
              : 'Move-file failed: from is not a file.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const toParent = path.dirname(absTo);
      const toParentSt = await fs.lstat(toParent).catch(() => undefined);
      if (!toParentSt || !toParentSt.isDirectory()) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: TO_PARENT_NOT_DIR`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-file failed: destination parent directory does not exist. Use mk_dir first.'
              : 'Move-file failed: destination parent directory does not exist. Use mk_dir first.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const toExists = await fs
        .lstat(absTo)
        .then(() => true)
        .catch((err: unknown) => {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === 'ENOENT'
          ) {
            return false;
          }
          throw err;
        });
      if (toExists) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: TO_EXISTS`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-file failed: destination already exists.'
              : 'Move-file failed: destination already exists.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      await fs.rename(absFrom, absTo);
      const yaml = [
        `status: ok`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `summary: ${yamlQuote(`Move-file: ${from} \u2192 ${to}.`)}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const moveDirTool: TellaskTool = {
  type: 'texter',
  name: 'move_dir',
  backfeeding: true,
  usageDescription: `Move/rename a directory relative to workspace.
Usage: !?@move_dir <from> <to>`,
  usageDescriptionI18n: {
    en: `Move/rename a directory relative to workspace.
Usage: !?@move_dir <from> <to>`,
    zh: `移动/重命名工作区内目录。
用法：!?@move_dir <from> <to>`,
  },
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const workLanguage = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@move_dir')) {
      const yaml = [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-dir failed: invalid format. Use !?@move_dir <from> <to>.'
            : 'Move-dir failed: invalid format. Use !?@move_dir <from> <to>.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const after = trimmed.slice('@move_dir'.length).trim();
    const parts = after.split(/\s+/).filter((p) => p.length > 0);
    const from = parts[0] ?? '';
    const to = parts[1] ?? '';
    if (!from || !to) {
      const yaml = [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-dir failed: from/to required.'
            : 'Move-dir failed: from/to required.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const absFrom = path.resolve(process.cwd(), from);
    const absTo = path.resolve(process.cwd(), to);
    const cwd = path.resolve(process.cwd());
    if (!absFrom.startsWith(cwd) || !absTo.startsWith(cwd)) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: PATH_OUTSIDE_WORKSPACE`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-dir failed: paths must be within workspace.'
            : 'Move-dir failed: paths must be within workspace.',
        )}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!hasWriteAccess(caller, from) || !hasWriteAccess(caller, to)) {
      const content = getAccessDeniedMessage('write', from, workLanguage);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      const st = await fs.lstat(absFrom);
      if (!st.isDirectory()) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: FROM_NOT_DIR`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-dir failed: from is not a directory.'
              : 'Move-dir failed: from is not a directory.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const toParent = path.dirname(absTo);
      const toParentSt = await fs.lstat(toParent).catch(() => undefined);
      if (!toParentSt || !toParentSt.isDirectory()) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: TO_PARENT_NOT_DIR`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-dir failed: destination parent directory does not exist. Use mk_dir first.'
              : 'Move-dir failed: destination parent directory does not exist. Use mk_dir first.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const toExists = await fs
        .lstat(absTo)
        .then(() => true)
        .catch((err: unknown) => {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === 'ENOENT'
          ) {
            return false;
          }
          throw err;
        });
      if (toExists) {
        const yaml = [
          `status: error`,
          `from: ${yamlQuote(from)}`,
          `to: ${yamlQuote(to)}`,
          `error: TO_EXISTS`,
          `summary: ${yamlQuote(
            workLanguage === 'zh'
              ? 'Move-dir failed: destination already exists.'
              : 'Move-dir failed: destination already exists.',
          )}`,
        ].join('\n');
        const content = formatYamlCodeBlock(yaml);
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const movedEntryCount = await countDirEntries(absFrom);
      await fs.rename(absFrom, absTo);
      const yaml = [
        `status: ok`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `moved_entry_count: ${movedEntryCount}`,
        `summary: ${yamlQuote(`Move-dir: ${from} \u2192 ${to} (${movedEntryCount} entries).`)}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
