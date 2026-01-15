/**
 * Module: utils/task-doc
 *
 * Utilities for formatting task document content for display in LLM context.
 */
import * as path from 'path';
import { ChatMessage } from '../llm/client';
import {
  ensureTaskPackage,
  formatEffectiveTaskDocFromSections,
  isTaskPackagePath,
  readTaskPackageSections,
} from './task-package';

/**
 * Format task document content for display in the LLM context.
 * Task docs are `*.tsk/` packages only (legacy single-file task docs are not supported).
 */
export async function formatTaskDocContent(taskDocPath: string): Promise<ChatMessage> {
  const workspaceRoot = path.resolve(process.cwd());
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
    if (!isTaskPackagePath(taskDocPath)) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** Only encapsulated task packages (\`*.tsk/\`) are supported.

Migrate this task doc to a \`.tsk/\` directory with:
- \`goals.md\`
- \`constraints.md\`
- \`progress.md\`

Then create a new dialog referencing the \`.tsk/\` task package.`,
      };
    }

    // Task packages are directory-based, but the content is still injected deterministically.
    // General file tools must NOT be used to access anything under `*.tsk/`.

    await ensureTaskPackage(fullPath);
    const sections = await readTaskPackageSections(fullPath);
    const effectiveDoc = formatEffectiveTaskDocFromSections(sections);

    const bytes = Buffer.byteLength(effectiveDoc, 'utf8');
    const maxSize = 100 * 1024; // 100KB
    if (bytes > maxSize) {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Task Document:** \`${taskDocPath}\`
📦 **Type:** Encapsulated task package (\`*.tsk/\`)
📊 **Size:** ${(bytes / 1024).toFixed(1)} KB (too large to inline)

⚠️ **Note:** Task packages are encapsulated. Do not use file tools to read/write/list anything under \`*.tsk/\`.
Use \`@change_mind !goals\` / \`@change_mind !constraints\` / \`@change_mind !progress\` to update exactly one section.`,
      };
    }

    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Task Document:** \`${taskDocPath}\`
📦 **Type:** Encapsulated task package (\`*.tsk/\`)
📄 **Size:** ${bytes} bytes

---
${effectiveDoc}
---

*Use \`@change_mind !goals\` / \`@change_mind !constraints\` / \`@change_mind !progress\` to replace exactly one section.*

Directive: Do not invoke any general file tools (\`@read_file\`, \`@overwrite_file\`, \`@patch_file\`, \`@apply_patch\`, \`@list_dir\`, \`@rm_file\`, \`@rm_dir\`) on any path under \`*.tsk/\`. Task package state is managed only through explicit task-doc actions.`,
    };
  } catch (error: unknown) {
    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Task Document:** \`${taskDocPath}\`
❌ **Error:** ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
