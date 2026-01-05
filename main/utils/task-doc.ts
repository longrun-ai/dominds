/**
 * Module: utils/task-doc
 *
 * Utilities for formatting task document content for display in LLM context.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/client';

/**
 * Format task document content for display in the LLM context.
 * Handles all possible cases: normal, empty, large (>100K), and binary files.
 */
export async function formatTaskDocContent(taskDocPath: string): Promise<ChatMessage> {
  const workspaceRoot = process.cwd();
  const fullPath = path.resolve(workspaceRoot, taskDocPath);

  // Security check - ensure path is within workspace
  if (!fullPath.startsWith(workspaceRoot)) {
    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** Path must be within workspace`,
    };
  }

  try {
    // Check if file exists
    const stats = await fs.promises.stat(fullPath);

    // Check if it's a file (not directory)
    if (!stats.isFile()) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** Path is not a file`,
      };
    }

    const fileSize = stats.size;
    const maxSize = 100 * 1024; // 100KB

    // Handle empty file
    if (fileSize === 0) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
📄 **Status:** Empty file (0 bytes)

*This is a fresh task document. You can use \`@change_mind\` to add initial content.*

Directive: Do not invoke \`@read_file\` for this exact path. Refer to this injected document only; the system will update it across rounds as needed.`,
      };
    }

    // Handle large files (>100K)
    if (fileSize > maxSize) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
📊 **Size:** ${(fileSize / 1024).toFixed(1)} KB (too large to inline)
⚠️ **Note:** The system will manage excerpts; do not invoke \`@read_file\` for this exact path yourself.

*Consider breaking large documents into smaller, focused task files or requesting a targeted excerpt to be injected next round.*`,
      };
    }

    // Read file content
    const buffer = await fs.promises.readFile(fullPath);

    // Check if file is binary
    const isBinary = buffer.some(
      (byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
    );

    if (isBinary) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
🔧 **Type:** Binary file
📊 **Size:** ${fileSize} bytes (${(fileSize / 1024).toFixed(1)} KB)

*Binary files cannot be displayed as text. If this should be a text file, check the file encoding.*

Directive: Do not invoke \`@read_file\` for this exact path. Coordinate to obtain a textual excerpt via system injection instead.`,
      };
    }

    // Handle normal text file
    const content = buffer.toString('utf-8');
    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Task Document:** \`${taskDocPath}\`
📄 **Size:** ${fileSize} bytes

---
${content}
---

*Use \`@change_mind\` to update this document or switch to a different task.*

Directive: Do not invoke \`@read_file\` for this exact path. This injected content is authoritative within the current round context; if updates are needed, they will be reflected by the system in subsequent rounds.`,
    };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** File not found

*Use \`@change_mind\` to create a new task document or specify a different path.*`,
      };
    }

    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
