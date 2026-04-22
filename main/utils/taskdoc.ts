/**
 * Module: utils/taskdoc
 *
 * Utilities for formatting Taskdoc content for display in LLM context.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Dialog, SideDialog } from '../dialog';
import { ChatMessage } from '../llm/client';
import { getWorkLanguage } from '../runtime/work-language';
import {
  formatEffectiveTaskDocFromSections,
  isTaskPackagePath,
  readTaskPackageForInjection,
  type TaskPackageBearInMindState,
  type TaskPackageExtraSectionsState,
  type TaskPackageLayoutViolation,
  type TaskPackageSectionsState,
} from './task-package';

/**
 * Format Taskdoc content for display in the LLM context.
 * Taskdocs are encapsulated `*.tsk/` directories.
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

  const isSideDialog = dlg instanceof SideDialog;
  const taskdocMaintainerId = isSideDialog ? dlg.mainDialog.agentId : dlg.agentId;
  const workspaceRoot = path.resolve(process.cwd());
  const fullPath = path.resolve(workspaceRoot, taskDocPath);

  // Security check - ensure path is within rtws (runtime workspace)
  if (!fullPath.startsWith(workspaceRoot)) {
    const head =
      language === 'zh' ? `**差遣牒：** \`${taskDocPath}\`` : `**Taskdoc:** \`${taskDocPath}\``;
    const err =
      language === 'zh'
        ? '❌ **错误：** 路径必须位于 rtws（运行时工作区）内'
        : '❌ **Error:** Path must be within rtws (runtime workspace)';
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

    // Taskdocs (`*.tsk/`) are directory-based, but the content is still injected deterministically.
    // General file tools must NOT be used to access anything under `*.tsk/`.

    const pkg = await (async (): Promise<{
      sections: TaskPackageSectionsState;
      bearInMind: TaskPackageBearInMindState;
      extraSections: TaskPackageExtraSectionsState;
      violations: TaskPackageLayoutViolation[];
    }> => {
      try {
        const st = await fs.promises.stat(fullPath);
        if (!st.isDirectory()) {
          throw new Error(`Taskdoc path exists but is not a directory: '${taskDocPath}'`);
        }
        return await readTaskPackageForInjection(fullPath);
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: unknown }).code === 'ENOENT'
        ) {
          return {
            sections: {
              goals: { kind: 'missing' as const },
              constraints: { kind: 'missing' as const },
              progress: { kind: 'missing' as const },
            },
            bearInMind: { kind: 'absent' as const },
            extraSections: { kind: 'present' as const, categories: [], truncated: false },
            violations: [],
          };
        }
        throw err;
      }
    })();

    const goalsStatus = pkg.sections.goals.kind === 'present' ? 'present' : 'missing';
    const constraintsStatus = pkg.sections.constraints.kind === 'present' ? 'present' : 'missing';
    const progressStatus = pkg.sections.progress.kind === 'present' ? 'present' : 'missing';
    const bearInMindStatus: 'absent' | 'present' | 'invalid' =
      pkg.bearInMind.kind === 'absent'
        ? 'absent'
        : pkg.bearInMind.kind === 'invalid'
          ? 'invalid'
          : 'present';

    const formatViolation = (v: TaskPackageLayoutViolation): string => {
      if (language === 'zh') {
        switch (v.kind) {
          case 'top_level_file_under_subdir':
            return `- 违规：顶层文件 \`${v.filename}\` 不得出现在子目录下（发现于：\`${v.foundAt}\`）`;
          case 'bearinmind_file_outside_bearinmind':
            return `- 违规：\`${v.filename}\` 只能出现在 \`bearinmind/\` 下（发现于：\`${v.foundAt}\`）`;
          case 'bearinmind_extra_entry':
            return `- 违规：\`bearinmind/\` 下不允许额外条目（发现于：\`${v.foundAt}\`）`;
          case 'bearinmind_not_directory':
            return `- 违规：\`bearinmind\` 必须是目录（发现：\`${v.foundAt}\`）`;
          case 'scan_limit_exceeded':
            return `- 警告：差遣牒包过大，结构检查提前中止（max_entries=${v.maxEntries}）`;
          default: {
            const _exhaustive: never = v;
            return String(_exhaustive);
          }
        }
      }

      switch (v.kind) {
        case 'top_level_file_under_subdir':
          return `- Violation: top-level file \`${v.filename}\` must not appear under any subdirectory (found at: \`${v.foundAt}\`)`;
        case 'bearinmind_file_outside_bearinmind':
          return `- Violation: \`${v.filename}\` must only appear under \`bearinmind/\` (found at: \`${v.foundAt}\`)`;
        case 'bearinmind_extra_entry':
          return `- Violation: extra entries are not allowed under \`bearinmind/\` (found at: \`${v.foundAt}\`)`;
        case 'bearinmind_not_directory':
          return `- Violation: \`bearinmind\` must be a directory (found: \`${v.foundAt}\`)`;
        case 'scan_limit_exceeded':
          return `- Warning: task package too large; layout validation stopped early (max_entries=${v.maxEntries})`;
        default: {
          const _exhaustive: never = v;
          return String(_exhaustive);
        }
      }
    };

    const violationsBlock = (() => {
      if (pkg.violations.length === 0) return '';
      const title =
        language === 'zh'
          ? `**结构违规（需要人工修复）：**`
          : `**Layout violations (fix manually):**`;
      return [title, ...pkg.violations.map(formatViolation)].join('\n');
    })();

    const statusBlock = (() => {
      const extraSectionsBlock = (() => {
        const extra = pkg.extraSections;
        if (language === 'zh') {
          if (extra.kind === 'unavailable') {
            return [
              `**额外章节索引（不会自动注入）：**`,
              `- ⚠️ 暂不可用：无法扫描差遣牒包的额外章节目录（reason=${extra.reason}）。`,
              `- 若你确定存在额外章节，请直接尝试：\`recall_taskdoc({\"category\":\"<category>\",\"selector\":\"<selector>\"})\``,
            ].join('\n');
          }

          const entries: string[] = [];
          for (const cat of extra.categories) {
            for (const selector of cat.selectors) {
              entries.push(
                `- \`${cat.category}/${selector}.md\`（读：\`recall_taskdoc({\"category\":\"${cat.category}\",\"selector\":\"${selector}\"})\`；写：\`change_mind({\"category\":\"${cat.category}\",\"selector\":\"${selector}\",\"content\":\"...\"})\`）`,
              );
            }
          }

          const header = `**额外章节索引（不会自动注入；需要时用 \`recall_taskdoc\` 显式读取）：**`;
          const body = entries.length > 0 ? entries : ['- （无）'];
          const truncatedLine = extra.truncated
            ? `- ⚠️ 已截断：目录条目过多，仅展示前 64 项。`
            : '';
          return [header, ...body, ...(truncatedLine ? [truncatedLine] : [])].join('\n');
        }

        if (extra.kind === 'unavailable') {
          return [
            `**Extra sections index (NOT auto-injected):**`,
            `- ⚠️ Unavailable: failed to scan extra section directories (reason=${extra.reason}).`,
            `- If you believe an extra section exists, try: \`recall_taskdoc({\"category\":\"<category>\",\"selector\":\"<selector>\"})\``,
          ].join('\n');
        }

        const entries: string[] = [];
        for (const cat of extra.categories) {
          for (const selector of cat.selectors) {
            entries.push(
              `- \`${cat.category}/${selector}.md\` (read: \`recall_taskdoc({\"category\":\"${cat.category}\",\"selector\":\"${selector}\"})\`; update: \`change_mind({\"category\":\"${cat.category}\",\"selector\":\"${selector}\",\"content\":\"...\"})\`)`,
            );
          }
        }

        const header = `**Extra sections index (NOT auto-injected; use \`recall_taskdoc\` when needed):**`;
        const body = entries.length > 0 ? entries : ['- (none)'];
        const truncatedLine = extra.truncated
          ? `- ⚠️ Truncated: too many entries; showing first 64.`
          : '';
        return [header, ...body, ...(truncatedLine ? [truncatedLine] : [])].join('\n');
      })();

      if (language === 'zh') {
        const goalsZh = goalsStatus === 'present' ? '存在' : '缺失';
        const constraintsZh = constraintsStatus === 'present' ? '存在' : '缺失';
        const progressZh = progressStatus === 'present' ? '存在' : '缺失';
        const bearZh =
          bearInMindStatus === 'absent' ? '无' : bearInMindStatus === 'invalid' ? '无效' : '存在';
        const bearExtrasLine =
          pkg.bearInMind.kind === 'present' && pkg.bearInMind.extraEntries.length > 0
            ? `- \`bearinmind/\` 发现额外条目（不会被注入）：${pkg.bearInMind.extraEntries
                .map((n) => `\`${n}\``)
                .join(', ')}`
            : '';
        const maintenanceLine = isSideDialog
          ? `- 支线对话中不允许 \`change_mind\`：需要更新时请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供你已合并好的“分段全文替换稿”（用于替换对应分段全文；禁止覆盖/抹掉他人条目）。`
          : `- 维护方式：用函数工具 \`change_mind\` 指定分段（顶层 selector: \`goals\` / \`constraints\` / \`progress\`；或 category+selector 指定额外章节）。每次调用会替换该章节全文：必须先对照上下文中注入的当前内容并做合并/压缩；可在同一程中多次调用来一次更新多个章节（禁止覆盖/抹掉他人条目）。`;
        return [
          `**差遣牒结构（封装差遣牒 \`*.tsk/\`）：**`,
          `- 我们的差遣牒是一个 \`*.tsk/\` 目录：顶层 3 个分段（\`goals\` / \`constraints\` / \`progress\`）一定会自动注入；\`bearinmind/\`（固定白名单）可选自动注入；其他章节不会自动注入，仅以“目录索引”形式提示并需用 \`recall_taskdoc\` 显式读取。`,
          `- 全队共享：三个分段对所有队友与支线对话可见。更新时禁止覆盖/抹掉他人条目；建议为自己维护的条目标注责任人（如 \`- [owner:@<id>] ...\`）。`,
          `- 章节语义约定：\`goals\` / \`constraints\` 是任务契约；\`progress\` 是全队共享、准实时、可扫读的任务公告牌，用于当前有效状态、关键决策、下一步与仍成立阻塞，不是“我当前在做什么”的个人笔记。`,
          `- 差遣牒维护人（负责执行 \`change_mind\`）：@${taskdocMaintainerId}`,
          `- 重要：差遣牒内容已被系统以内联形式注入到上下文中（本程生成视角下即为最新）。请直接基于上下文里的差遣牒回顾与决策，不要试图用通用文件工具读取 \`*.tsk/\` 下的文件（会被拒绝）。`,
          maintenanceLine,
          ``,
          `**分段状态：**`,
          `- \`goals.md\`：${goalsZh}`,
          `- \`constraints.md\`：${constraintsZh}`,
          `- \`progress.md\`：${progressZh}`,
          `- \`bearinmind/\`（可选注入）：${bearZh}`,
          ...(bearExtrasLine ? [bearExtrasLine] : []),
          ``,
          extraSectionsBlock,
          ``,
          `若某个分段缺失，请用函数工具 \`change_mind\` 创建（不要用通用文件工具）：`,
          `- \`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\``,
          `- \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\``,
          `- \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\``,
          ...(violationsBlock ? ['', violationsBlock] : []),
        ].join('\n');
      }

      const maintenanceLine = isSideDialog
        ? `- Side Dialogs cannot call \`change_mind\`: ask the Taskdoc maintainer @${taskdocMaintainerId} to apply updates, and provide a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
        : `- Maintenance: in this dialog, use the function tool \`change_mind\` to target one section (top-level selector: \`goals\` / \`constraints\` / \`progress\`, or category+selector for extra sections). Each call replaces the entire section, so always start from the current injected content and merge/compress. You may call \`change_mind\` multiple times in a single turn to update multiple sections (do not overwrite/delete other contributors).`;
      const bearEn =
        bearInMindStatus === 'absent'
          ? 'absent'
          : bearInMindStatus === 'invalid'
            ? 'invalid'
            : 'present';
      const bearExtrasLine =
        pkg.bearInMind.kind === 'present' && pkg.bearInMind.extraEntries.length > 0
          ? `- Extra entries detected under \`bearinmind/\` (NOT injected): ${pkg.bearInMind.extraEntries
              .map((n) => `\`${n}\``)
              .join(', ')}`
          : '';
      return [
        `**Taskdoc Constitution (Encapsulated \`*.tsk/\`):**`,
        `- Our Taskdoc is a \`*.tsk/\` directory: it always auto-injects the 3 top-level sections (\`goals\` / \`constraints\` / \`progress\`); it may auto-inject \`bearinmind/\` (fixed whitelist); any other sections are NOT auto-injected and must be read via \`recall_taskdoc\` (only an index is shown).`,
        `- Team-shared: all 3 sections are visible to teammates and sideDialogs. Do not overwrite/delete other contributors; add an owner marker for entries you maintain (e.g. \`- [owner:@<id>] ...\`).`,
        `- Section semantics: \`goals\` / \`constraints\` are the task contract; \`progress\` is the team-shared, quasi-real-time, scannable task bulletin board for current effective state, key decisions, next steps, and still-active blockers, not a personal “what I'm doing now” notebook.`,
        `- Taskdoc maintainer (runs \`change_mind\`): @${taskdocMaintainerId}`,
        `- Important: Taskdoc content is injected inline into the context (the latest as of this generation). Review the injected Taskdoc; do not try to read files under \`*.tsk/\` via general file tools (they will be rejected).`,
        maintenanceLine,
        ``,
        `**Sections:**`,
        `- \`goals.md\`: ${goalsStatus}`,
        `- \`constraints.md\`: ${constraintsStatus}`,
        `- \`progress.md\`: ${progressStatus}`,
        `- \`bearinmind/\` (optional injection): ${bearEn}`,
        ...(bearExtrasLine ? [bearExtrasLine] : []),
        ``,
        extraSectionsBlock,
        ``,
        `If any section is missing, create it with the function tool \`change_mind\` (never via general file tools):`,
        `- \`change_mind({\"selector\":\"goals\",\"content\":\"...\"})\``,
        `- \`change_mind({\"selector\":\"constraints\",\"content\":\"...\"})\``,
        `- \`change_mind({\"selector\":\"progress\",\"content\":\"...\"})\``,
        ...(violationsBlock ? ['', violationsBlock] : []),
      ].join('\n');
    })();
    const effectiveDoc = formatEffectiveTaskDocFromSections(language, pkg.sections, pkg.bearInMind);

    const bytes = Buffer.byteLength(effectiveDoc, 'utf8');
    const maxSize = 100 * 1024; // 100KB
    if (bytes > maxSize) {
      if (language === 'zh') {
        const howToUpdate = isSideDialog
          ? `⚠️ **注意：** 差遣牒是封装的。不要用文件工具去读/写/列目录 \`*.tsk/\` 下的任何路径。\n支线对话中不允许 \`change_mind\`：请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。`
          : `⚠️ **注意：** 差遣牒是封装的。不要用文件工具去读/写/列目录 \`*.tsk/\` 下的任何路径。\n请在当前对话中用函数工具 \`change_mind\` 来更新（每次调用会替换一个分段全文；你可以在同一程中多次调用来批量更新；禁止覆盖/抹掉他人条目）。`;
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

      const howToUpdate = isSideDialog
        ? `⚠️ **Note:** Taskdocs are encapsulated. Do not use file tools to read/write/list anything under \`*.tsk/\`.\nSide Dialogs cannot call \`change_mind\`; ask the Taskdoc maintainer @${taskdocMaintainerId} with a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
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
      const footerLine = isSideDialog
        ? `*支线对话中不允许 \`change_mind\`：请诉请差遣牒维护人 @${taskdocMaintainerId} 执行更新，并提供合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。*`
        : `*在当前对话中用函数工具 \`change_mind\` 来替换分段（每次调用会替换一个分段全文；你可以在同一程中多次调用来批量替换；更新时禁止覆盖他人条目）。*`;
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

	指令：不要对 \`*.tsk/\` 下的任何路径调用通用文件工具（\`read_file\`, \`overwrite_entire_file\`, \`prepare_file_range_edit\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`）。差遣牒状态只能通过显式的差遣牒操作进行管理。

提示：以上“封装/禁用通用文件工具”的规则由系统强制执行，通常无需在差遣牒的 \`constraints\` 里重复书写（除非你要强调给人类读者）。`,
      };
    }

    const footerLine = isSideDialog
      ? `*Side Dialogs cannot call \`change_mind\`; ask the Taskdoc maintainer @${taskdocMaintainerId} with a fully merged full-section replacement draft (do not overwrite/delete other contributors).*`
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

	Directive: Do not invoke any general file tools (\`read_file\`, \`overwrite_entire_file\`, \`prepare_file_range_edit\`, \`apply_file_modification\`, \`list_dir\`, \`rm_file\`, \`rm_dir\`) on any path under \`*.tsk/\`. Task package state is managed only through explicit Taskdoc actions.

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
