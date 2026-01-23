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
 * - !?@add_reminder: Add new reminders to maintain context across conversations
 * - !?@delete_reminder: Remove specific reminders by number
 * - !?@update_reminder: Modify existing reminder content
 * - !?@clear_mind: Drop all messages, start new round, optionally add reminder from call body
 * - !?@change_mind: Update a `.tsk/` task doc section without starting a new round
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
import type { ChatMessage } from '../llm/client';
import { formatToolActionResult } from '../shared/i18n/tool-result-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { Team } from '../team';
import { TellaskTool, TellaskToolCallResult } from '../tool';
import {
  isTaskPackagePath,
  taskPackageSectionFromSelector,
  updateTaskPackageSection,
  type TaskPackageSection,
} from '../utils/task-package';

function env(content: string): ChatMessage[] {
  return [{ type: 'environment_msg', role: 'user', content }] satisfies ChatMessage[];
}

function ok(result?: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'completed', result, messages };
}

function fail(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'failed', result, messages };
}

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
      invalidFormatDelete: '错误：格式不正确。用法：!?@delete_reminder <reminder-no>',
      reminderDoesNotExist: (reminderNoHuman, total) =>
        `错误：提醒编号 ${reminderNoHuman} 不存在。可用范围：1-${total}`,
      invalidFormatAdd: '错误：格式不正确。用法：!?@add_reminder [<reminder-no>]',
      reminderContentEmpty: '错误：提醒内容不能为空',
      invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
        `错误：提醒插入位置 ${reminderNoHuman} 无效。有效范围：1-${totalPlusOne}`,
      invalidFormatUpdate: '错误：格式不正确。用法：!?@update_reminder <reminder-no>',
      invalidFormatChangeMind:
        '错误：格式不正确。用法：!?@change_mind [!goals|!constraints|!progress]',
      tooManyArgsChangeMind: '错误：参数过多。用法：!?@change_mind [!goals|!constraints|!progress]',
      taskDocContentRequired: '错误：需要提供差遣牒内容',
      noTaskDocPathConfigured: '错误：此对话未配置差遣牒路径',
      pathMustBeWithinWorkspace: '错误：路径必须位于工作区内',
      invalidTaskDocPath: (taskDocPath) =>
        `错误：差遣牒路径 '${taskDocPath}' 无效。期望为 \`*.tsk/\` 目录。`,
      selectorRequired: '错误：Task packages 需要目标选择器：!goals | !constraints | !progress',
      invalidSelector: (selector) =>
        `错误：选择器 '${selector}' 无效。用法：!goals | !constraints | !progress`,
      clearedRoundPrompt: (nextRound) =>
        `这是对话的第 #${nextRound} 轮，你刚清理了思路，请继续执行任务。`,
    };
  }

  return {
    invalidFormatDelete: 'Error: Invalid format. Use: !?@delete_reminder <reminder-no>',
    reminderDoesNotExist: (reminderNoHuman, total) =>
      `Error: Reminder number ${reminderNoHuman} does not exist. Available reminders: 1-${total}`,
    invalidFormatAdd: 'Error: Invalid format. Use: !?@add_reminder [<reminder-no>]',
    reminderContentEmpty: 'Error: Reminder content cannot be empty',
    invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
      `Error: Invalid reminder position ${reminderNoHuman}. Valid range: 1-${totalPlusOne}`,
    invalidFormatUpdate: 'Error: Invalid format. Use: !?@update_reminder <reminder-no>',
    invalidFormatChangeMind:
      'Error: Invalid format. Use: !?@change_mind [!goals|!constraints|!progress]',
    tooManyArgsChangeMind:
      'Error: Too many arguments. Use: !?@change_mind [!goals|!constraints|!progress]',
    taskDocContentRequired: 'Error: Task doc content is required',
    noTaskDocPathConfigured: 'Error: No task doc path configured for this dialog',
    pathMustBeWithinWorkspace: 'Error: Path must be within workspace',
    invalidTaskDocPath: (taskDocPath) =>
      `Error: Invalid Task Doc path '${taskDocPath}'. Expected a \`*.tsk/\` directory.`,
    selectorRequired:
      'Error: Task packages require a target selector: !goals | !constraints | !progress',
    invalidSelector: (selector) =>
      `Error: Invalid selector '${selector}'. Use: !goals | !constraints | !progress`,
    clearedRoundPrompt: (nextRound) =>
      `This is round #${nextRound} of the dialog, you just cleared your mind and please proceed with the task.`,
  };
}

/**
 * Delete a reminder by its number
 * Usage: !?@delete_reminder <reminder-no>
 */
export const deleteReminderTool: TellaskTool = {
  type: 'tellask',
  name: 'delete_reminder',
  usageDescription: 'Delete a reminder by number: !?@delete_reminder <reminder-no>',
  usageDescriptionI18n: {
    en: 'Delete a reminder by number: !?@delete_reminder <reminder-no>',
    zh: '按编号删除提醒：!?@delete_reminder <reminder-no>',
  },
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    _inputBody: string,
  ): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderNoMatch = headLine.match(/^@delete_reminder\s+(\d+)\s*$/);
    if (!reminderNoMatch) {
      return fail(t.invalidFormatDelete, env(t.invalidFormatDelete));
    }

    const reminderNo = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      const msg = t.reminderDoesNotExist(reminderNoMatch[1], dlg.reminders.length);
      return fail(msg, env(msg));
    }

    dlg.deleteReminder(reminderNo);
    return ok(formatToolActionResult(language, 'deleted'));
  },
};

/**
 * Add a new reminder or insert at specific position
 * Usage: !?@add_reminder [<reminder-no>]
 * !?<reminder-content>
 */
export const addReminderTool: TellaskTool = {
  type: 'tellask',
  name: 'add_reminder',
  usageDescription: 'Add a reminder: !?@add_reminder [<reminder-no>]\n!?<reminder-content>',
  usageDescriptionI18n: {
    en: 'Add a reminder: !?@add_reminder [<reminder-no>]\n!?<reminder-content>',
    zh: '添加提醒：!?@add_reminder [<reminder-no>]\n!?<reminder-content>',
  },
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderNoMatch = headLine.match(/^@add_reminder(?:\s+(\d+)\s*)?$/);
    if (!reminderNoMatch) {
      return fail(t.invalidFormatAdd, env(t.invalidFormatAdd));
    }

    const reminderContent = inputBody.trim();
    if (!reminderContent) {
      return fail(t.reminderContentEmpty, env(t.reminderContentEmpty));
    }

    let insertIndex: number;
    if (reminderNoMatch[1]) {
      insertIndex = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
      if (insertIndex < 0 || insertIndex > dlg.reminders.length) {
        const msg = t.invalidReminderPosition(reminderNoMatch[1], dlg.reminders.length + 1);
        return fail(msg, env(msg));
      }
    } else {
      insertIndex = dlg.reminders.length; // Append at end
    }

    dlg.addReminder(reminderContent, undefined, undefined, insertIndex);
    return ok(formatToolActionResult(language, 'added'));
  },
};

/**
 * Update an existing reminder
 * Usage: !?@update_reminder <reminder-no>
 * !?<reminder-content>
 */
export const updateReminderTool: TellaskTool = {
  type: 'tellask',
  name: 'update_reminder',
  usageDescription: 'Update a reminder: !?@update_reminder <reminder-no>\n!?<reminder-content>',
  usageDescriptionI18n: {
    en: 'Update a reminder: !?@update_reminder <reminder-no>\n!?<reminder-content>',
    zh: '更新提醒：!?@update_reminder <reminder-no>\n!?<reminder-content>',
  },
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderNoMatch = headLine.match(/^@update_reminder\s+(\d+)\s*$/);
    if (!reminderNoMatch) {
      return fail(t.invalidFormatUpdate, env(t.invalidFormatUpdate));
    }

    const reminderNo = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      const msg = t.reminderDoesNotExist(reminderNoMatch[1], dlg.reminders.length);
      return fail(msg, env(msg));
    }

    const reminderContent = inputBody.trim();
    if (!reminderContent) {
      return fail(t.reminderContentEmpty, env(t.reminderContentEmpty));
    }

    dlg.updateReminder(reminderNo, reminderContent);
    return ok(formatToolActionResult(language, 'updated'));
  },
};

/**
 * Clear mind - start new round, drop all messages, add call body as reminder if provided
 * Usage: !?@clear_mind
 * !?<reminder-content> - optional, when provided, adds as new reminder
 */
export const clearMindTool: TellaskTool = {
  type: 'tellask',
  name: 'clear_mind',
  usageDescription: 'Clear mind and start new round: !?@clear_mind\\n!?<reminder-content>',
  usageDescriptionI18n: {
    en: 'Clear mind and start new round: !?@clear_mind\\n!?<reminder-content>',
    zh: '清空思维并开始新一轮：!?@clear_mind\\n!?<reminder-content>',
  },
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    _headLine: string,
    inputBody: string,
  ): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderContent = inputBody.trim();
    if (reminderContent) {
      dlg.addReminder(reminderContent);
    }
    await dlg.startNewRound(t.clearedRoundPrompt(dlg.currentRound + 1));
    return ok(formatToolActionResult(language, 'mindCleared'));
  },
};

/**
 * Change mind - start new round, drop all messages, overwrite task doc with call body
 * Usage: !?@change_mind
 * !?<new-task-doc-content> - required, overwrites current task doc file
 */
export const changeMindTool: TellaskTool = {
  type: 'tellask',
  name: 'change_mind',
  usageDescription:
    'Update task document content (no round reset).\n' +
    'Task Doc (`*.tsk/`): !?@change_mind !goals|!constraints|!progress\\n!?<new-section-content>',
  usageDescriptionI18n: {
    en:
      'Update task document content (no round reset).\n' +
      'Task Doc (`*.tsk/`): !?@change_mind !goals|!constraints|!progress\\n!?<new-section-content>',
    zh:
      '更新差遣牒内容（不重置轮次）。\n' +
      '差遣牒（`*.tsk/`）：!?@change_mind !goals|!constraints|!progress\\n!?<new-section-content>',
  },
  backfeeding: false,
  async call(
    dlg: Dialog,
    caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const trimmedHeadLine = headLine.trim();
    if (!trimmedHeadLine.startsWith('@change_mind')) {
      return fail(t.invalidFormatChangeMind, env(t.invalidFormatChangeMind));
    }

    const headBeforeColon = trimmedHeadLine.split(':', 1)[0] || trimmedHeadLine;
    const tokens = headBeforeColon.trim().split(/\s+/);
    const selector = tokens.length >= 2 ? tokens[1] : undefined;
    const extraToken = tokens.length >= 3 ? tokens[2] : undefined;
    if (extraToken) {
      return fail(t.tooManyArgsChangeMind, env(t.tooManyArgsChangeMind));
    }

    const newTaskDocContent = inputBody.trim();

    if (!newTaskDocContent) {
      return fail(t.taskDocContentRequired, env(t.taskDocContentRequired));
    }

    // Task doc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) {
      return fail(t.noTaskDocPathConfigured, env(t.noTaskDocPathConfigured));
    }

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!fullPath.startsWith(workspaceRoot)) {
      return fail(t.pathMustBeWithinWorkspace, env(t.pathMustBeWithinWorkspace));
    }

    if (!isTaskPackagePath(taskDocPath)) {
      const msg = t.invalidTaskDocPath(taskDocPath);
      return fail(msg, env(msg));
    }

    if (!selector) {
      return fail(t.selectorRequired, env(t.selectorRequired));
    }
    const section: TaskPackageSection | null = taskPackageSectionFromSelector(selector);
    if (!section) {
      const msg = t.invalidSelector(selector);
      return fail(msg, env(msg));
    }

    await updateTaskPackageSection({
      taskPackageDirFullPath: fullPath,
      section,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    return ok(formatToolActionResult(language, 'mindChanged'));
  },
};
