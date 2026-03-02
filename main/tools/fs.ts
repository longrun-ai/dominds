/**
 * Module: tools/fs
 *
 * Filesystem tools: list directories, remove directories/files, create/move paths.
 * Includes helpers for text-file detection and line counting.
 */
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import { log } from '../log';
import { getWorkLanguage } from '../shared/runtime-language';
import type { FuncTool, ToolArguments } from '../tool';

interface DirectoryEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size?: number;
  lines?: number;
  target?: string;
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

export const listDirTool: FuncTool = {
  type: 'func',
  name: 'list_dir',
  description:
    'List directory contents relative to rtws (runtime workspace) with detailed information (sizes, line counts for text files, symlink targets).',
  descriptionI18n: {
    en: 'List directory contents relative to rtws (runtime workspace) with detailed information (sizes, line counts for text files, symlink targets).',
    zh: '列出 rtws（运行时工作区）内目录内容（包含大小、文本文件行数、符号链接目标等信息）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description: "rtws-relative directory path. Defaults to '.'.",
      },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            accessDenied: '❌ **访问被拒绝**\n\n路径必须位于 rtws（运行时工作区）内',
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
            accessDenied: '❌ **Access Denied**\n\nPath must be within rtws (runtime workspace)',
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

    let rel = '.';
    const pathValue = args['path'];
    if (typeof pathValue === 'string' && pathValue.trim() !== '') rel = pathValue.trim();

    // Resolve path relative to current working directory (rtws)
    const dir = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within rtws
    const cwd = path.resolve(process.cwd());
    if (!dir.startsWith(cwd)) {
      const content = labels.accessDenied;
      return content;
    }

    // Check member access permissions
    if (!hasReadAccess(caller, rel)) {
      const content = getAccessDeniedMessage('read', rel, workLanguage);
      return content;
    }

    try {
      try {
        const stats = await fs.lstat(dir);
        if (!stats.isDirectory()) {
          const content = labels.notDir(rel);
          return content;
        }
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          const content = labels.notFound(rel);
          return content;
        }

        const msg = error instanceof Error ? error.message : String(error);
        const content = labels.readDirFailed(msg);
        return content;
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

      return markdown;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = labels.notFound(rel);
        return content;
      }

      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOTDIR'
      ) {
        const content = labels.notDir(rel);
        return content;
      }

      const msg = error instanceof Error ? error.message : String(error);
      const content = labels.readDirFailed(msg);
      return content;
    }
  },
};

export const rmDirTool: FuncTool = {
  type: 'func',
  name: 'rm_dir',
  description: 'Remove a directory relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Remove a directory relative to rtws (runtime workspace).',
    zh: '删除 rtws（运行时工作区）内目录。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'rtws-relative directory path.' },
      recursive: {
        type: 'boolean',
        description: 'When true, remove directory and all contents.',
      },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            formatError:
              '请使用正确的目录删除参数。\n\n**期望参数：** `{ "path": "<path>", "recursive": true|false }`\n\n**示例：**\n```json\n{ \"path\": \"temp\", \"recursive\": true }\n```',
            dirPathRequired: '❌ **错误**\n\n需要提供目录路径。',
            pathMustBeWithinWorkspace: '❌ **错误**\n\n路径必须位于 rtws（运行时工作区）内。',
            notDir: (p: string) => `❌ **错误**\n\n\`${p}\` 不是目录。`,
            notEmpty: (p: string) =>
              `❌ **错误**\n\n目录 \`${p}\` 非空。请设置 \`recursive: true\` 删除非空目录。`,
            removed: (p: string) => `✅ 已删除目录：\`${p}\`。`,
            doesNotExist: (p: string) => `❌ **未找到**\n\n目录 \`${p}\` 不存在。`,
            removeFailed: (msg: string) => `❌ **错误**\n\n删除目录失败：${msg}`,
          }
        : {
            formatError:
              'Please use the correct arguments for removing directories.\n\n**Expected args:** `{ "path": "<path>", "recursive": true|false }`\n\n**Example:**\n```json\n{ \"path\": \"temp\", \"recursive\": true }\n```',
            dirPathRequired: '❌ **Error**\n\nDirectory path is required.',
            pathMustBeWithinWorkspace:
              '❌ **Error**\n\nPath must be within rtws (runtime workspace).',
            notDir: (p: string) => `❌ **Error**\n\n\`${p}\` is not a directory.`,
            notEmpty: (p: string) =>
              `❌ **Error**\n\nDirectory \`${p}\` is not empty. Set \`recursive: true\` to remove non-empty directories.`,
            removed: (p: string) => `✅ Removed directory: \`${p}\`.`,
            doesNotExist: (p: string) => `❌ **Not Found**\n\nDirectory \`${p}\` does not exist.`,
            removeFailed: (msg: string) => `❌ **Error**\n\nError removing directory: ${msg}`,
          };

    const pathValue = args['path'];
    const rel = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!rel) return labels.dirPathRequired;

    const recursiveValue = args['recursive'];
    const recursive = recursiveValue === undefined ? false : recursiveValue === true ? true : false;
    if (recursiveValue !== undefined && typeof recursiveValue !== 'boolean')
      return labels.formatError;

    // Resolve path relative to current working directory (rtws)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within rtws
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      return labels.pathMustBeWithinWorkspace;
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      return getAccessDeniedMessage('write', rel, workLanguage);
    }

    try {
      // Check if path exists and is a directory
      const stats = await fs.lstat(targetPath);
      if (!stats.isDirectory()) {
        return labels.notDir(rel);
      }

      // Check if directory is empty when not using recursive
      if (!recursive) {
        const entries = await fs.readdir(targetPath);
        if (entries.length > 0) {
          return labels.notEmpty(rel);
        }
      }

      // Node.js >=22+ types deprecate recursive rmdir in favor of rm.
      await fs.rm(targetPath, { recursive, force: false });

      return labels.removed(rel);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return labels.doesNotExist(rel);
      }

      return labels.removeFailed(error instanceof Error ? error.message : String(error));
    }
  },
};

export const rmFileTool: FuncTool = {
  type: 'func',
  name: 'rm_file',
  description: 'Remove a file relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Remove a file relative to rtws (runtime workspace).',
    zh: '删除 rtws（运行时工作区）内文件。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'rtws-relative file path.' },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const labels =
      workLanguage === 'zh'
        ? {
            formatError:
              '请使用正确的文件删除参数。\n\n**期望参数：** `{ \"path\": \"<path>\" }`\n\n**示例：**\n```json\n{ \"path\": \"temp/old-file.txt\" }\n```',
            filePathRequired: '❌ **错误**\n\n需要提供文件路径。',
            pathMustBeWithinWorkspace: '❌ **错误**\n\n路径必须位于 rtws（运行时工作区）内。',
            notFile: (p: string) => `❌ **错误**\n\n\`${p}\` 不是文件。`,
            removed: (p: string) => `✅ 已删除文件：\`${p}\`。`,
            doesNotExist: (p: string) => `❌ **未找到**\n\n文件 \`${p}\` 不存在。`,
            removeFailed: (msg: string) => `❌ **错误**\n\n删除文件失败：${msg}`,
          }
        : {
            formatError:
              'Please use the correct arguments for removing files.\n\n**Expected args:** `{ \"path\": \"<path>\" }`\n\n**Example:**\n```json\n{ \"path\": \"temp/old-file.txt\" }\n```',
            filePathRequired: '❌ **Error**\n\nFile path is required.',
            pathMustBeWithinWorkspace:
              '❌ **Error**\n\nPath must be within rtws (runtime workspace).',
            notFile: (p: string) => `❌ **Error**\n\n\`${p}\` is not a file.`,
            removed: (p: string) => `✅ Removed file: \`${p}\`.`,
            doesNotExist: (p: string) => `❌ **Not Found**\n\nFile \`${p}\` does not exist.`,
            removeFailed: (msg: string) => `❌ **Error**\n\nError removing file: ${msg}`,
          };

    const pathValue = args['path'];
    const rel = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!rel) return labels.filePathRequired;

    // Resolve path relative to current working directory (rtws)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within rtws
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      return labels.pathMustBeWithinWorkspace;
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      return getAccessDeniedMessage('write', rel, workLanguage);
    }

    try {
      // Check if path exists and is a file
      const stats = await fs.lstat(targetPath);
      if (!stats.isFile()) {
        return labels.notFile(rel);
      }

      // Remove the file
      await fs.unlink(targetPath);

      return labels.removed(rel);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return labels.doesNotExist(rel);
      }

      return labels.removeFailed(error instanceof Error ? error.message : String(error));
    }
  },
};

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
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

export const mkDirTool: FuncTool = {
  type: 'func',
  name: 'mk_dir',
  description: 'Create a directory relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Create a directory relative to rtws (runtime workspace).',
    zh: '创建 rtws（运行时工作区）内目录。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'rtws-relative directory path.' },
      parents: { type: 'boolean', description: 'Create parent directories as needed.' },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const pathValue = args['path'];
    const rel = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!rel) {
      const yaml = [
        `status: error`,
        `error: PATH_REQUIRED`,
        `summary: ${yamlQuote(workLanguage === 'zh' ? 'Mk-dir failed: path required.' : 'Mk-dir failed: path required.')}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }

    const parentsValue = args['parents'];
    const parents =
      parentsValue === undefined
        ? true
        : parentsValue === true
          ? true
          : parentsValue === false
            ? false
            : true;
    if (parentsValue !== undefined && typeof parentsValue !== 'boolean') {
      const yaml = [
        `status: error`,
        `error: INVALID_ARGS`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Mk-dir failed: invalid args. Expected { path: string, parents?: boolean }.'
            : 'Mk-dir failed: invalid args. Expected { path: string, parents?: boolean }.',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
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
            ? 'Mk-dir failed: path must be within rtws (runtime workspace).'
            : 'Mk-dir failed: path must be within rtws (runtime workspace).',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }

    if (!hasWriteAccess(caller, rel)) {
      return getAccessDeniedMessage('write', rel, workLanguage);
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
          return formatYamlCodeBlock(yaml);
        }
        const yaml = [
          `status: ok`,
          `path: ${yamlQuote(rel)}`,
          `created: false`,
          `summary: ${yamlQuote(`Mk-dir: ${rel} (parents=${parents}).`)}`,
        ].join('\n');
        return formatYamlCodeBlock(yaml);
      }

      await fs.mkdir(targetPath, { recursive: parents });
      const yaml = [
        `status: ok`,
        `path: ${yamlQuote(rel)}`,
        `created: true`,
        `summary: ${yamlQuote(`Mk-dir: ${rel} (parents=${parents}).`)}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `path: ${yamlQuote(rel)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }
  },
};

export const moveFileTool: FuncTool = {
  type: 'func',
  name: 'move_file',
  description: 'Move/rename a file relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Move/rename a file relative to rtws (runtime workspace).',
    zh: '移动/重命名 rtws（运行时工作区）内文件。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', description: 'rtws-relative source file path.' },
      to: { type: 'string', description: 'rtws-relative destination file path.' },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const fromValue = args['from'];
    const toValue = args['to'];
    const from = typeof fromValue === 'string' ? fromValue.trim() : '';
    const to = typeof toValue === 'string' ? toValue.trim() : '';
    if (!from || !to) {
      const yaml = [
        `status: error`,
        `error: INVALID_ARGS`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-file failed: from/to required.'
            : 'Move-file failed: from/to required.',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
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
            ? 'Move-file failed: paths must be within rtws (runtime workspace).'
            : 'Move-file failed: paths must be within rtws (runtime workspace).',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }

    if (!hasWriteAccess(caller, from) || !hasWriteAccess(caller, to)) {
      return getAccessDeniedMessage('write', from, workLanguage);
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
        return formatYamlCodeBlock(yaml);
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
        return formatYamlCodeBlock(yaml);
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
        return formatYamlCodeBlock(yaml);
      }

      await fs.rename(absFrom, absTo);
      const yaml = [
        `status: ok`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `summary: ${yamlQuote(`Move-file: ${from} \u2192 ${to}.`)}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }
  },
};

export const moveDirTool: FuncTool = {
  type: 'func',
  name: 'move_dir',
  description: 'Move/rename a directory relative to rtws (runtime workspace).',
  descriptionI18n: {
    en: 'Move/rename a directory relative to rtws (runtime workspace).',
    zh: '移动/重命名 rtws（运行时工作区）内目录。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'to'],
    properties: {
      from: { type: 'string', description: 'rtws-relative source directory path.' },
      to: { type: 'string', description: 'rtws-relative destination directory path.' },
    },
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args: ToolArguments): Promise<string> => {
    const workLanguage = getWorkLanguage();
    const fromValue = args['from'];
    const toValue = args['to'];
    const from = typeof fromValue === 'string' ? fromValue.trim() : '';
    const to = typeof toValue === 'string' ? toValue.trim() : '';
    if (!from || !to) {
      const yaml = [
        `status: error`,
        `error: INVALID_ARGS`,
        `summary: ${yamlQuote(
          workLanguage === 'zh'
            ? 'Move-dir failed: from/to required.'
            : 'Move-dir failed: from/to required.',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
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
            ? 'Move-dir failed: paths must be within rtws (runtime workspace).'
            : 'Move-dir failed: paths must be within rtws (runtime workspace).',
        )}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }

    if (!hasWriteAccess(caller, from) || !hasWriteAccess(caller, to)) {
      return getAccessDeniedMessage('write', from, workLanguage);
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
        return formatYamlCodeBlock(yaml);
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
        return formatYamlCodeBlock(yaml);
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
        return formatYamlCodeBlock(yaml);
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
      return formatYamlCodeBlock(yaml);
    } catch (error: unknown) {
      const yaml = [
        `status: error`,
        `from: ${yamlQuote(from)}`,
        `to: ${yamlQuote(to)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n');
      return formatYamlCodeBlock(yaml);
    }
  },
};
