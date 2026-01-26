/**
 * Module: utils/taskdoc
 *
 * Utilities for formatting Taskdoc content for display in LLM context.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Dialog, SubDialog } from '../dialog';
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
export async function formatTaskDocContent(dlg: Dialog): Promise<ChatMessage> {
  const language = getWorkLanguage();
  const taskDocPath = dlg.taskDocPath;
  if (!taskDocPath) {
    const head = language === 'zh' ? `**差遣牒：**` : `**Taskdoc:**`;
    const err =
      language === 'zh'
        ? '❌ **错误：** 此对话未配置差遣牒路径（taskDocPath）。'
        : '❌ **Error:** No Taskdoc path configured for this dialog (taskDocPath).';
    return {
      type: 'environment_msg',
      role: 'user',
      content: `${head}\n${err}`,
    };
  }

  const isSubdialog = dlg instanceof SubDialog;
  const taskdocMaintainerId = isSubdialog ? dlg.rootDialog.agentId : dlg.agentId;
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
        const maintenanceLine = isSubdialog
          ? `- 子对话中不允许 \`change_mind\`：需要更新时请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供你已合并好的“分段全文替换稿”（用于替换对应分段全文；禁止覆盖/抹掉他人条目）。`
          : `- 维护方式：用函数工具 \`change_mind\` 指定分段（selector: \`goals\` / \`constraints\` / \`progress\`）。每次调用会替换该分段全文：必须先对照上下文中注入的当前内容并做合并/压缩；可在同一轮中多次调用来一次更新多个分段（禁止覆盖/抹掉他人条目）。`;
        return [
          `**差遣牒结构（封装差遣牒 \`*.tsk/\`）：**`,
          `- 我们的差遣牒是一个 \`*.tsk/\` 目录，分为 3 个分段：\`goals\` / \`constraints\` / \`progress\`。`,
          `- 全队共享：三个分段对所有队友与子对话可见。更新时禁止覆盖/抹掉他人条目；建议为自己维护的条目标注责任人（如 \`- [owner:@<id>] ...\`）。`,
          `- 差遣牒维护人（负责执行 \`change_mind\`）：@${taskdocMaintainerId}`,
          `- 重要：差遣牒内容已被系统以内联形式注入到上下文中（本轮生成视角下即为最新）。请直接基于上下文里的差遣牒回顾与决策，不要试图用通用文件工具读取 \`*.tsk/\` 下的文件（会被拒绝）。`,
          maintenanceLine,
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
      const maintenanceLine = isSubdialog
        ? `- Subdialogs cannot call \`change_mind\`: ask the Taskdoc maintainer @${taskdocMaintainerId} to apply updates, and provide a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
        : `- Maintenance: in this dialog, use the function tool \`change_mind\` to target one section (selector: \`goals\` / \`constraints\` / \`progress\`). Each call replaces the entire section, so always start from the current injected content and merge/compress. You may call \`change_mind\` multiple times in a single turn to update multiple sections (do not overwrite/delete other contributors).`;
      return [
        `**Taskdoc Constitution (Encapsulated \`*.tsk/\`):**`,
        `- Our Taskdoc is a \`*.tsk/\` directory with exactly 3 sections: \`goals\` / \`constraints\` / \`progress\`.`,
        `- Team-shared: all 3 sections are visible to teammates and subdialogs. Do not overwrite/delete other contributors; add an owner marker for entries you maintain (e.g. \`- [owner:@<id>] ...\`).`,
        `- Taskdoc maintainer (runs \`change_mind\`): @${taskdocMaintainerId}`,
        `- Important: Taskdoc content is injected inline into the context (the latest as of this generation). Review the injected Taskdoc; do not try to read files under \`*.tsk/\` via general file tools (they will be rejected).`,
        maintenanceLine,
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
        const howToUpdate = isSubdialog
          ? `⚠️ **注意：** 差遣牒是封装的。不要用文件工具去读/写/列目录 \`*.tsk/\` 下的任何路径。\n子对话中不允许 \`change_mind\`：请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。`
          : `⚠️ **注意：** 差遣牒是封装的。不要用文件工具去读/写/列目录 \`*.tsk/\` 下的任何路径。\n请在当前对话中用函数工具 \`change_mind\` 来更新（每次调用会替换一个分段全文；你可以在同一轮中多次调用来批量更新；禁止覆盖/抹掉他人条目）。`;
        return {
          type: 'environment_msg',
          role: 'user',
          content: `**差遣牒：** \`${taskDocPath}\`
📦 **类型：** 封装差遣牒（\`*.tsk/\`）
📊 **大小：** ${(bytes / 1024).toFixed(1)} KB（过大，无法内联）

${statusBlock}

${howToUpdate}`,
        };
      }
      const howToUpdate = isSubdialog
        ? `⚠️ **Note:** Taskdocs are encapsulated. Do not use file tools to read/write/list anything under \`*.tsk/\`.\nSubdialogs cannot call \`change_mind\`; ask the Taskdoc maintainer @${taskdocMaintainerId} with a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
        : `⚠️ **Note:** Taskdocs are encapsulated. Do not use file tools to read/write/list anything under \`*.tsk/\`.\nIn this dialog, use the function tool \`change_mind\` to update (each call replaces one section; you may call it multiple times in a single turn to batch updates; do not overwrite/delete other contributors).`;
      return {
        type: 'environment_msg',
        role: 'user',
        content: `**Taskdoc:** \`${taskDocPath}\`
📦 **Type:** Encapsulated Taskdoc (\`*.tsk/\`)
📊 **Size:** ${(bytes / 1024).toFixed(1)} KB (too large to inline)

${statusBlock}

${howToUpdate}`,
      };
    }

    if (language === 'zh') {
      const footerLine = isSubdialog
        ? `*子对话中不允许 \`change_mind\`：请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。*`
        : `*在当前对话中用函数工具 \`change_mind\` 来替换分段（每次调用会替换一个分段全文；你可以在同一轮中多次调用来批量替换；更新时禁止覆盖他人条目）。*`;
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

${footerLine}

指令：不要对 \`*.tsk/\` 下的任何路径调用通用文件工具（\`read_file\`, \`overwrite_entire_file\`, \`preview_file_modification\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`）。差遣牒状态只能通过显式的差遣牒操作进行管理。

提示：以上“封装/禁用通用文件工具”的规则由系统强制执行，通常无需在差遣牒的 \`constraints\` 里重复书写（除非你要强调给人类读者）。`,
      };
    }
    const footerLine = isSubdialog
      ? `*Subdialogs cannot call \`change_mind\`; ask the Taskdoc maintainer @${taskdocMaintainerId} with a fully merged full-section replacement draft (do not overwrite/delete other contributors).*`
      : `*In this dialog, use the function tool \`change_mind\` to replace sections (each call replaces one entire section; you may call it multiple times in a single turn to batch replacements; do not overwrite other contributors).*`;
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

${footerLine}

Directive: Do not invoke any general file tools (\`read_file\`, \`overwrite_entire_file\`, \`preview_file_modification\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`) on any path under \`*.tsk/\`. Task package state is managed only through explicit task-doc actions.

Note: This encapsulation rule is system-enforced and usually does not need to be duplicated in Taskdoc \`constraints\` (unless you want to emphasize it for human readers).`,
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
