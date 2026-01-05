/**
 * Module: tools/fs
 *
 * Filesystem texting tools: list directories, remove directories/files.
 * Includes helpers for text-file detection and line counting.
 */
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { ChatMessage } from '../llm/client';
import { log } from '../log';
import { TextingTool, TextingToolCallResult } from '../tool';

interface DirectoryEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size?: number;
  lines?: number;
  target?: string;
}

function ok(result: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'completed', result, messages };
}

function fail(result: string, messages?: ChatMessage[]): TextingToolCallResult {
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

export const listDirTool: TextingTool = {
  type: 'texter',
  name: 'list_dir',
  backfeeding: true,
  usageDescription: `List directory contents relative to workspace with detailed information.
Usage: @list_dir [path]

Features:
- Shows file sizes for all entries
- Shows line count for text files
- Shows symbolic link targets
- Categorizes entries by type (dir, file, symlink, other)

Example:
@list_dir src/tools`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    // Parse path from headLine - expect format "@list_dir [path]"
    const trimmed = headLine.trim();
    let rel = '.';

    if (trimmed.startsWith('@list_dir')) {
      const afterToolName = trimmed.slice('@list_dir'.length).trim();
      rel = afterToolName || '.';
    } else {
      const content =
        'Please use the correct format for listing directories.\n\n**Expected format:** `@list_dir [path]`\n\n**Example:**\n```\n@list_dir src/tools\n```';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const dir = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!dir.startsWith(cwd)) {
      const content = '❌ **Access Denied**\n\nPath must be within workspace';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member access permissions
    if (!hasReadAccess(caller, rel)) {
      const content = getAccessDeniedMessage('read', rel);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
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
      let markdown = `📁 **Directory:** \`${relativeDir}\`\n\n`;

      if (data.length === 0) {
        markdown += '_This directory is empty._';
      } else {
        markdown += '| Name | Type | Size | Lines | Target |\n';
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
    } catch (error) {
      const content = `❌ **Error**\n\nFailed to read directory: ${error instanceof Error ? error.message : String(error)}`;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const rmDirTool: TextingTool = {
  type: 'texter',
  name: 'rm_dir',
  backfeeding: true,
  usageDescription: `Remove a directory relative to workspace.
Usage: @rm_dir <path> [options]

Options:
  !recursive [true|false]  - Remove directory and all contents (default: false)

Examples:
  @rm_dir temp
  @rm_dir build !recursive true`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    // Parse path and options from headLine
    const trimmed = headLine.trim();
    let rel = '';
    let recursive = false;

    if (trimmed.startsWith('@rm_dir')) {
      const afterToolName = trimmed.slice('@rm_dir'.length).trim();
      const parts = afterToolName.split(/\s+/);

      if (parts.length === 0 || !parts[0]) {
        const content = 'Error: Directory path is required.';
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
      const content =
        'Please use the correct format for removing directories.\n\n**Expected format:** `@rm_dir <path> [!recursive true|false]`\n\n**Example:**\n```\n@rm_dir temp !recursive true\n```';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      const content = 'Error: Path must be within workspace';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      const content = getAccessDeniedMessage('write', rel);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      // Check if path exists and is a directory
      const stats = await fs.lstat(targetPath);
      if (!stats.isDirectory()) {
        const content = `Error: '${rel}' is not a directory.`;
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Check if directory is empty when not using recursive
      if (!recursive) {
        const entries = await fs.readdir(targetPath);
        if (entries.length > 0) {
          const content = `Error: Directory '${rel}' is not empty. Use !recursive true to remove non-empty directories.`;
          return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
        }
      }

      // Remove the directory
      await fs.rmdir(targetPath, { recursive });

      const content = `Directory '${rel}' removed successfully.`;
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = `Error: Directory '${rel}' does not exist.`;
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const content = `Error removing directory: ${error instanceof Error ? error.message : String(error)}`;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const rmFileTool: TextingTool = {
  type: 'texter',
  name: 'rm_file',
  backfeeding: true,
  usageDescription: `Remove a file relative to workspace.
Usage: @rm_file <path>

Example:
  @rm_file temp/old-file.txt`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TextingToolCallResult> {
    // Parse path from headLine
    const trimmed = headLine.trim();
    let rel = '';

    if (trimmed.startsWith('@rm_file')) {
      const afterToolName = trimmed.slice('@rm_file'.length).trim();
      rel = afterToolName;
    } else {
      const content =
        'Please use the correct format for removing files.\n\n**Expected format:** `@rm_file <path>`\n\n**Example:**\n```\n@rm_file temp/old-file.txt\n```';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!rel) {
      const content = 'Error: File path is required.';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Resolve path relative to current working directory (workspace)
    const targetPath = path.resolve(process.cwd(), rel);

    // Basic security check - ensure path is within workspace
    const cwd = path.resolve(process.cwd());
    if (!targetPath.startsWith(cwd)) {
      const content = 'Error: Path must be within workspace';
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    // Check member write access permissions
    if (!hasWriteAccess(caller, rel)) {
      const content = getAccessDeniedMessage('write', rel);
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    try {
      // Check if path exists and is a file
      const stats = await fs.lstat(targetPath);
      if (!stats.isFile()) {
        const content = `Error: '${rel}' is not a file.`;
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      // Remove the file
      await fs.unlink(targetPath);

      const content = `File '${rel}' removed successfully.`;
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        const content = `Error: File '${rel}' does not exist.`;
        return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
      }

      const content = `Error removing file: ${error instanceof Error ? error.message : String(error)}`;
      return fail(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
