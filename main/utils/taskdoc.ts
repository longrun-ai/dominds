/**
 * Module: utils/taskdoc
 *
 * Utilities for formatting Taskdoc content for display in LLM context.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/client';
import { getWorkLanguage } from '../shared/runtime-language';
import {
  formatEffectiveTaskDocFromSections,
  isTaskPackagePath,
  readTaskPackageSections,
} from './task-package';

/**
 * Format task document content for display in the LLM context.
 * Task Docs are encapsulated `*.tsk/` directories.
 */
export async function formatTaskDocContent(taskDocPath: string): Promise<ChatMessage> {
  const language = getWorkLanguage();
  const workspaceRoot = path.resolve(process.cwd());
  const fullPath = path.resolve(workspaceRoot, taskDocPath);

  // Security check - ensure path is within workspace
  if (!fullPath.startsWith(workspaceRoot)) {
    const head =
      language === 'zh' ? `**差遣牒：** \`${taskDocPath}\`` : `**Taskdoc:** \`${taskDocPath}\``;
    const err =
      language === 'zh'
        ? '❌ **错误：** 路径必须在 workspace 内'
        : '❌ **Error:** Path must be within workspace';
    return {
      type: 'environment_msg',
      role: 'user',
      content: `${head}
${err}`,
    };
  }

  try {
    if (!isTaskPackagePath(taskDocPath)) {
      if (language === 'zh') {
        return {
          type: 'environment_msg',
          role: 'user',
          content: `**差遣牒：** \`${taskDocPath}\`
❌ **错误：** 无效的差遣牒路径：差遣牒必须是一个以 \`.tsk\` 结尾的目录（\`*.tsk/\`）。

如果你提供的是一个普通文件路径（例如 \`.md\`），这是不符合预期的。请改为指向一个 \`.tsk/\` 目录。`,
        };
      }
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Taskdoc:** \`${taskDocPath}\`
❌ **Error:** Invalid Taskdoc path: Taskdoc must be a directory ending with \`.tsk\` (\`*.tsk/\`).

If you provided a regular file path (e.g. a \`.md\`), that is unexpected. Please point to a \`.tsk/\` directory instead.`,
      };
    }

    // Task Docs (`*.tsk/`) are directory-based, but the content is still injected deterministically.
    // General file tools must NOT be used to access anything under `*.tsk/`.

    const sections = await (async () => {
      try {
        const st = await fs.promises.stat(fullPath);
        if (!st.isDirectory()) {
          throw new Error(`Task Doc path exists but is not a directory: '${taskDocPath}'`);
        }
        return await readTaskPackageSections(fullPath);
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: unknown }).code === 'ENOENT'
        ) {
          return {
            goals: { kind: 'missing' as const },
            constraints: { kind: 'missing' as const },
            progress: { kind: 'missing' as const },
          };
        }
        throw err;
      }
    })();

    const goalsStatus = sections.goals.kind === 'present' ? 'present' : 'missing';
    const constraintsStatus = sections.constraints.kind === 'present' ? 'present' : 'missing';
    const progressStatus = sections.progress.kind === 'present' ? 'present' : 'missing';
    const statusBlock = (() => {
      if (language === 'zh') {
        const goalsZh = goalsStatus === 'present' ? '存在' : '缺失';
        const constraintsZh = constraintsStatus === 'present' ? '存在' : '缺失';
        const progressZh = progressStatus === 'present' ? '存在' : '缺失';
        return [
          `**差遣牒结构（封装差遣牒 \`*.tsk/\`）：**`,
          `- 我们的差遣牒是一个 \`*.tsk/\` 目录，分为 3 个分段：\`goals\` / \`constraints\` / \`progress\`。`,
          `- 维护方式：每次调用函数工具 \`change_mind\` 必须指定一个分段（selector: \`goals\` / \`constraints\` / \`progress\`）；可在同一轮中多次调用 \`change_mind\` 来一次更新多个分段。`,
          ``,
          `**分段状态：**`,
          `- \`goals.md\`：${goalsZh}`,
          `- \`constraints.md\`：${constraintsZh}`,
          `- \`progress.md\`：${progressZh}`,
          ``,
          `若某个分段缺失，请用函数工具 \`change_mind\` 创建（不要用通用文件工具）：`,
          `- \`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\``,
          `- \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\``,
          `- \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\``,
        ].join('\n');
      }
      return [
        `**Taskdoc Constitution (Encapsulated \`*.tsk/\`):**`,
        `- Our Taskdoc is a \`*.tsk/\` directory with exactly 3 sections: \`goals\` / \`constraints\` / \`progress\`.`,
        `- Maintenance: each function tool call \`change_mind\` must target one section (selector: \`goals\` / \`constraints\` / \`progress\`). You may call \`change_mind\` multiple times in a single turn to update multiple sections.`,
        ``,
        `**Sections:**`,
        `- \`goals.md\`: ${goalsStatus}`,
        `- \`constraints.md\`: ${constraintsStatus}`,
        `- \`progress.md\`: ${progressStatus}`,
        ``,
        `If any section is missing, create it with the function tool \`change_mind\` (never via general file tools):`,
        `- \`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\``,
        `- \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\``,
        `- \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\``,
      ].join('\n');
    })();
    const effectiveDoc = formatEffectiveTaskDocFromSections(language, sections);

    const bytes = Buffer.byteLength(effectiveDoc, 'utf8');
    const maxSize = 100 * 1024; // 100KB
    if (bytes > maxSize) {
      if (language === 'zh') {
        return {
          type: 'environment_msg',
          role: 'user',
          content: `**差遣牒：** \`${taskDocPath}\`
📦 **类型：** 封装差遣牒（\`*.tsk/\`）
📊 **大小：** ${(bytes / 1024).toFixed(1)} KB（过大，无法内联）

${statusBlock}

⚠️ **注意：** 差遣牒是封装的。不要用文件工具去读/写/列目录 \`*.tsk/\` 下的任何路径。
请用函数工具 \`change_mind\` 来更新（每次调用只更新一个分段；你可以在同一轮中多次调用来批量更新），例如：\`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\` / \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\` / \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\`。`,
        };
      }
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Taskdoc:** \`${taskDocPath}\`
📦 **Type:** Encapsulated Taskdoc (\`*.tsk/\`)
📊 **Size:** ${(bytes / 1024).toFixed(1)} KB (too large to inline)

${statusBlock}

⚠️ **Note:** Taskdocs are encapsulated. Do not use file tools to read/write/list anything under \`*.tsk/\`.
Use the function tool \`change_mind\` to update (each call updates one section; you may call it multiple times in a single turn to batch updates), e.g. \`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\` / \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\` / \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\`.`,
      };
    }

    if (language === 'zh') {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**差遣牒：** \`${taskDocPath}\`
📦 **类型：** 封装差遣牒（\`*.tsk/\`）
📄 **大小：** ${bytes} bytes

${statusBlock}

---
${effectiveDoc}
---

*用函数工具 \`change_mind\` 来替换分段（每次调用只替换一个分段；你可以在同一轮中多次调用来批量替换）。*

指令：不要对 \`*.tsk/\` 下的任何路径调用通用文件工具（\`read_file\`, \`overwrite_entire_file\`, \`preview_file_modification\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`）。差遣牒状态只能通过显式的差遣牒操作进行管理。`,
      };
    }
    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Taskdoc:** \`${taskDocPath}\`
📦 **Type:** Encapsulated Taskdoc (\`*.tsk/\`)
📄 **Size:** ${bytes} bytes

${statusBlock}

---
${effectiveDoc}
---

*Use the function tool \`change_mind\` to replace sections (each call replaces one section; you may call it multiple times in a single turn to batch replacements).*

Directive: Do not invoke any general file tools (\`read_file\`, \`overwrite_entire_file\`, \`preview_file_modification\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`) on any path under \`*.tsk/\`. Task package state is managed only through explicit task-doc actions.`,
    };
  } catch (error: unknown) {
    if (language === 'zh') {
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**差遣牒：** \`${taskDocPath}\`
❌ **错误：** ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      type: 'environment_msg',
      role: 'user',
      content: `**Taskdoc:** \`${taskDocPath}\`
❌ **Error:** ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
