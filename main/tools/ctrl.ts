/**
 * Module: tools/ctrl
 *
 * Intrinsic dialog control tools - ALWAYS AVAILABLE TO ALL AGENTS
 *
 * These tools are automatically included for every agent without needing to be
 * explicitly listed in team.yaml toolsets or tools configuration. They provide
 * core functionality for reminder management and mind control that should be
 * universally accessible.
 *
 * INTRINSIC TOOLS:
 * - add_reminder: Add a reminder
 * - delete_reminder: Delete a reminder by number
 * - update_reminder: Update reminder content
 * - clear_mind: Start a new round, optionally add a reminder
 * - change_mind: Update a `.tsk/` task doc section without starting a new round
 *
 * USAGE CONTEXT:
 * Can both be triggered by an agent autonomously, or by human with role='user' msg,
 * both ways treated the same
 *
 * agents always see reminders in llm input, humans should have some sticky UI component to see the reminders
 * agents should see hints of reminder manip syntax
 * humans should better have clickable UI widgets to draft reminder manips
 */

import * as path from 'path';
import type { Dialog } from '../dialog';
import { SubDialog } from '../dialog';
import { formatToolActionResult } from '../shared/i18n/tool-result-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { Team } from '../team';
import type { FuncTool, ToolArguments } from '../tool';
import {
  isTaskPackagePath,
  taskPackageSectionFromSelector,
  updateTaskPackageSection,
  type TaskPackageSection,
} from '../utils/task-package';

type CtrlMessages = Readonly<{
  invalidFormatDelete: string;
  reminderDoesNotExist: (reminderNoHuman: string, total: number) => string;
  invalidFormatAdd: string;
  reminderContentEmpty: string;
  invalidReminderPosition: (reminderNoHuman: string, totalPlusOne: number) => string;
  invalidFormatUpdate: string;
  invalidFormatChangeMind: string;
  tooManyArgsChangeMind: string;
  taskDocContentRequired: string;
  noTaskDocPathConfigured: string;
  pathMustBeWithinWorkspace: string;
  invalidTaskDocPath: (taskDocPath: string) => string;
  selectorRequired: string;
  invalidSelector: (selector: string) => string;
  clearedRoundPrompt: (nextRound: number) => string;
}>;

function getCtrlMessages(language: LanguageCode): CtrlMessages {
  if (language === 'zh') {
    return {
      invalidFormatDelete: '错误：参数不正确。用法：delete_reminder({ reminder_no: number })',
      reminderDoesNotExist: (reminderNoHuman, total) =>
        `错误：提醒编号 ${reminderNoHuman} 不存在。可用范围：1-${total}`,
      invalidFormatAdd:
        '错误：参数不正确。用法：add_reminder({ content: string, position: number })（position=0 表示默认追加）',
      reminderContentEmpty: '错误：提醒内容不能为空',
      invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
        `错误：提醒插入位置 ${reminderNoHuman} 无效。有效范围：1-${totalPlusOne}`,
      invalidFormatUpdate:
        '错误：参数不正确。用法：update_reminder({ reminder_no: number, content: string })',
      invalidFormatChangeMind:
        '错误：参数不正确。用法：change_mind({ selector: "goals"|"constraints"|"progress", content: string })',
      tooManyArgsChangeMind:
        '错误：参数不正确。用法：change_mind({ selector: "goals"|"constraints"|"progress", content: string })',
      taskDocContentRequired:
        '错误：需要提供差遣牒内容（content）。\n' +
        '可复制示例：\n' +
        '```json\n' +
        '{\n' +
        '  "selector": "progress",\n' +
        '  "content": "- 关键决策：...\\n- 下一步：..."\n' +
        '}\n' +
        '```',
      noTaskDocPathConfigured: '错误：此对话未配置差遣牒路径',
      pathMustBeWithinWorkspace: '错误：路径必须位于工作区内',
      invalidTaskDocPath: (taskDocPath) =>
        `错误：差遣牒路径 '${taskDocPath}' 无效。期望为 \`*.tsk/\` 目录。`,
      selectorRequired: '错误：Task packages 需要目标选择器：goals | constraints | progress',
      invalidSelector: (selector) =>
        `错误：选择器 '${selector}' 无效。用法：goals | constraints | progress`,
      clearedRoundPrompt: (nextRound) =>
        `这是对话的第 #${nextRound} 轮，你刚清理了思路，请继续执行任务。`,
    };
  }

  return {
    invalidFormatDelete: 'Error: Invalid args. Use: delete_reminder({ reminder_no: number })',
    reminderDoesNotExist: (reminderNoHuman, total) =>
      `Error: Reminder number ${reminderNoHuman} does not exist. Available reminders: 1-${total}`,
    invalidFormatAdd:
      'Error: Invalid args. Use: add_reminder({ content: string, position: number }) (position=0 means append).',
    reminderContentEmpty: 'Error: Reminder content cannot be empty',
    invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
      `Error: Invalid reminder position ${reminderNoHuman}. Valid range: 1-${totalPlusOne}`,
    invalidFormatUpdate:
      'Error: Invalid args. Use: update_reminder({ reminder_no: number, content: string })',
    invalidFormatChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: "goals"|"constraints"|"progress", content: string })',
    tooManyArgsChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: "goals"|"constraints"|"progress", content: string })',
    taskDocContentRequired:
      'Error: Taskdoc content is required (content).\n' +
      'Copy/paste example:\n' +
      '```json\n' +
      '{\n' +
      '  "selector": "progress",\n' +
      '  "content": "- Key decisions: ...\\n- Next steps: ..."\n' +
      '}\n' +
      '```',
    noTaskDocPathConfigured: 'Error: No task doc path configured for this dialog',
    pathMustBeWithinWorkspace: 'Error: Path must be within workspace',
    invalidTaskDocPath: (taskDocPath) =>
      `Error: Invalid Taskdoc path '${taskDocPath}'. Expected a \`*.tsk/\` directory.`,
    selectorRequired:
      'Error: Taskdoc packages require a target selector: goals | constraints | progress',
    invalidSelector: (selector) =>
      `Error: Invalid selector '${selector}'. Use: goals | constraints | progress`,
    clearedRoundPrompt: (nextRound) =>
      `This is round #${nextRound} of the dialog, you just cleared your mind and please proceed with the task.`,
  };
}

export const deleteReminderTool: FuncTool = {
  type: 'func',
  name: 'delete_reminder',
  description: 'Delete a reminder by its 1-based number.',
  descriptionI18n: {
    en: 'Delete a reminder by its 1-based number.',
    zh: '按 1-based 编号删除提醒。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['reminder_no'],
    properties: {
      reminder_no: { type: 'integer', description: 'Reminder number (1-based).' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderNoValue = args['reminder_no'];
    if (typeof reminderNoValue !== 'number' || !Number.isInteger(reminderNoValue)) {
      return t.invalidFormatDelete;
    }
    const reminderNo = reminderNoValue - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      return t.reminderDoesNotExist(String(reminderNoValue), dlg.reminders.length);
    }
    dlg.deleteReminder(reminderNo);
    return formatToolActionResult(language, 'deleted');
  },
};

export const addReminderTool: FuncTool = {
  type: 'func',
  name: 'add_reminder',
  description: 'Add a reminder, optionally inserting at a 1-based position.',
  descriptionI18n: {
    en: 'Add a reminder, optionally inserting at a 1-based position.',
    zh: '添加提醒，可选指定 1-based 插入位置。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
      content: { type: 'string', description: 'Reminder content.' },
      position: { type: 'integer', description: 'Insert position (1-based). Defaults to append.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const contentValue = args['content'];
    const reminderContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!reminderContent) return t.reminderContentEmpty;

    const positionValue = args['position'];
    let insertIndex = dlg.reminders.length;
    // Codex provider requires all func args to be schema-required; we use position=0 as sentinel for "append".
    if (positionValue !== undefined && positionValue !== 0) {
      if (typeof positionValue !== 'number' || !Number.isInteger(positionValue)) {
        return t.invalidFormatAdd;
      }
      insertIndex = positionValue - 1;
      if (insertIndex < 0 || insertIndex > dlg.reminders.length) {
        return t.invalidReminderPosition(String(positionValue), dlg.reminders.length + 1);
      }
    }

    dlg.addReminder(reminderContent, undefined, undefined, insertIndex);
    return formatToolActionResult(language, 'added');
  },
};

export const updateReminderTool: FuncTool = {
  type: 'func',
  name: 'update_reminder',
  description: 'Update an existing reminder by its 1-based number.',
  descriptionI18n: {
    en: 'Update an existing reminder by its 1-based number.',
    zh: '按 1-based 编号更新提醒内容。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['reminder_no', 'content'],
    properties: {
      reminder_no: { type: 'integer', description: 'Reminder number (1-based).' },
      content: { type: 'string', description: 'New reminder content.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderNoValue = args['reminder_no'];
    if (typeof reminderNoValue !== 'number' || !Number.isInteger(reminderNoValue)) {
      return t.invalidFormatUpdate;
    }
    const reminderNo = reminderNoValue - 1;
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      return t.reminderDoesNotExist(String(reminderNoValue), dlg.reminders.length);
    }

    const contentValue = args['content'];
    const reminderContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!reminderContent) return t.reminderContentEmpty;

    dlg.updateReminder(reminderNo, reminderContent);
    return formatToolActionResult(language, 'updated');
  },
};

export const clearMindTool: FuncTool = {
  type: 'func',
  name: 'clear_mind',
  description: 'Clear dialog mind and start a new round, optionally adding a reminder.',
  descriptionI18n: {
    en: 'Clear dialog mind and start a new round, optionally adding a reminder.',
    zh: '清空思路并开始新一轮，可选添加一条提醒。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reminder_content: { type: 'string', description: 'Optional reminder content to add.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderValue = args['reminder_content'];
    const reminderContent = typeof reminderValue === 'string' ? reminderValue.trim() : '';
    if (reminderContent) {
      dlg.addReminder(reminderContent);
    }
    await dlg.startNewRound(t.clearedRoundPrompt(dlg.currentRound + 1));

    // Context health snapshot is inherently tied to the previous prompt/context.
    // After clearing, invalidate it so the next generation can recompute without
    // stale remediation based on the old (large) context.
    dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
    return formatToolActionResult(language, 'mindCleared');
  },
};

export const changeMindTool: FuncTool = {
  type: 'func',
  name: 'change_mind',
  description:
    'Update a shared Taskdoc section (`*.tsk/`) in the main dialog without resetting the round. Each call replaces the entire section; merge carefully and avoid overwriting other contributors.',
  descriptionI18n: {
    en: 'Update a shared Taskdoc section (`*.tsk/`) in the main dialog without resetting the round. Each call replaces the entire section; merge carefully and avoid overwriting other contributors. Note: Taskdoc is injected into context; do not try to read `*.tsk/` via general file tools.',
    zh: '在主对话中更新全队共享差遣牒（`*.tsk/`）的指定章节（不重置轮次）。每次调用会替换该章节全文；更新前必须基于现有内容做合并/压缩，避免覆盖他人条目；建议为自己维护的条目标注责任人（如 `[owner:@<id>]`）。注意：差遣牒内容已被注入到上下文中；不要试图用通用文件工具读取 `*.tsk/` 下的文件（会被拒绝）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['selector', 'content'],
    properties: {
      selector: {
        type: 'string',
        enum: ['goals', 'constraints', 'progress'],
        description: 'Target section selector.',
      },
      content: { type: 'string', description: 'New section content.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    if (dlg.supdialog !== undefined) {
      const maintainerId = dlg instanceof SubDialog ? dlg.rootDialog.agentId : dlg.agentId;
      if (language === 'zh') {
        return (
          `错误：\`change_mind\` 仅允许在主对话中使用（子对话中不可用）。\n` +
          `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`change_mind\`，并提供你已合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。`
        );
      }
      return (
        `Error: \`change_mind\` is only available in the main dialog (not in subdialogs).\n` +
        `Ask the Taskdoc maintainer @${maintainerId} to run \`change_mind\` and provide a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
      );
    }

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (!selector) return t.selectorRequired;

    const contentValue = args['content'];
    const newTaskDocContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!newTaskDocContent) return t.taskDocContentRequired;

    // Task doc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return t.noTaskDocPathConfigured;

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!fullPath.startsWith(workspaceRoot)) return t.pathMustBeWithinWorkspace;

    if (!isTaskPackagePath(taskDocPath)) return t.invalidTaskDocPath(taskDocPath);

    const section: TaskPackageSection | null = taskPackageSectionFromSelector(selector);
    if (!section) return t.invalidSelector(selector);

    await updateTaskPackageSection({
      taskPackageDirFullPath: fullPath,
      section,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    return formatToolActionResult(language, 'mindChanged');
  },
};
