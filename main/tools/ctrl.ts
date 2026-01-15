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
 * - @add_reminder: Add new reminders to maintain context across conversations
 * - @delete_reminder: Remove specific reminders by number
 * - @update_reminder: Modify existing reminder content
 * - @clear_mind: Drop all messages, start new round, optionally add reminder from call body
 * - @change_mind: Update a `.tsk/` task doc section without starting a new round
 *
 * USAGE CONTEXT:
 * Can both be triggered by an agent autonomously, or by human with role='user' msg,
 * both ways treated the same
 *
 * agents always see reminders in llm input, humans should have some sticky UI component to see the reminders
 * agents should see hints of reminder manip syntax
 * humans should better have clickable UI widgets to draft reminder manips
 *
 * agents always see task-doc content (with ws path info together) in llm input
 * humans should have the clickable link (webui or vscode etc., configurable) to current task-doc file,
 * with doc-path (relative to workspace root) as the link text
 */

import * as path from 'path';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { formatToolActionResult } from '../shared/i18n/tool-result-messages';
import type { Team } from '../team';
import { TextingTool, TextingToolCallResult } from '../tool';
import {
  isTaskPackagePath,
  taskPackageSectionFromSelector,
  updateTaskPackageSection,
  type TaskPackageSection,
} from '../utils/task-package';

function env(content: string): ChatMessage[] {
  return [{ type: 'environment_msg', role: 'user', content }] satisfies ChatMessage[];
}

function ok(result?: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'completed', result, messages };
}

function fail(result: string, messages?: ChatMessage[]): TextingToolCallResult {
  return { status: 'failed', result, messages };
}

/**
 * Delete a reminder by its number
 * Usage: @delete_reminder <reminder-no>
 */
export const deleteReminderTool: TextingTool = {
  type: 'texter',
  name: 'delete_reminder',
  usageDescription: 'Delete a reminder by number: @delete_reminder <reminder-no>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    _inputBody: string,
  ): Promise<TextingToolCallResult> {
    const reminderNoMatch = headLine.match(/^@delete_reminder\s+(\d+)\s*$/);
    if (!reminderNoMatch) {
      return fail(
        'Error: Invalid format. Use: @delete_reminder <reminder-no>',
        env('Error: Invalid format. Use: @delete_reminder <reminder-no>'),
      );
    }

    const reminderNo = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      const msg = `Error: Reminder number ${reminderNoMatch[1]} does not exist. Available reminders: 1-${dlg.reminders.length}`;
      return fail(msg, env(msg));
    }

    dlg.deleteReminder(reminderNo);
    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'deleted'));
  },
};

/**
 * Add a new reminder or insert at specific position
 * Usage: @add_reminder [<reminder-no>]
 * <reminder-content>
 */
export const addReminderTool: TextingTool = {
  type: 'texter',
  name: 'add_reminder',
  usageDescription: 'Add a reminder: @add_reminder [<reminder-no>]\n<reminder-content>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult> {
    const reminderNoMatch = headLine.match(/^@add_reminder(?:\s+(\d+)\s*)?$/);
    if (!reminderNoMatch) {
      return fail(
        'Error: Invalid format. Use: @add_reminder [<reminder-no>]',
        env('Error: Invalid format. Use: @add_reminder [<reminder-no>]'),
      );
    }

    const reminderContent = inputBody.trim();
    if (!reminderContent) {
      return fail(
        'Error: Reminder content cannot be empty',
        env('Error: Reminder content cannot be empty'),
      );
    }

    let insertIndex: number;
    if (reminderNoMatch[1]) {
      insertIndex = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
      if (insertIndex < 0 || insertIndex > dlg.reminders.length) {
        const msg = `Error: Invalid reminder position ${reminderNoMatch[1]}. Valid range: 1-${dlg.reminders.length + 1}`;
        return fail(msg, env(msg));
      }
    } else {
      insertIndex = dlg.reminders.length; // Append at end
    }

    dlg.addReminder(reminderContent, undefined, undefined, insertIndex);
    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'added'));
  },
};

/**
 * Update an existing reminder
 * Usage: @update_reminder <reminder-no>
 * <reminder-content>
 */
export const updateReminderTool: TextingTool = {
  type: 'texter',
  name: 'update_reminder',
  usageDescription: 'Update a reminder: @update_reminder <reminder-no>\n<reminder-content>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult> {
    const reminderNoMatch = headLine.match(/^@update_reminder\s+(\d+)\s*$/);
    if (!reminderNoMatch) {
      return fail(
        'Error: Invalid format. Use: @update_reminder <reminder-no>',
        env('Error: Invalid format. Use: @update_reminder <reminder-no>'),
      );
    }

    const reminderNo = parseInt(reminderNoMatch[1], 10) - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= dlg.reminders.length) {
      const msg = `Error: Reminder number ${reminderNoMatch[1]} does not exist. Available reminders: 1-${dlg.reminders.length}`;
      return fail(msg, env(msg));
    }

    const reminderContent = inputBody.trim();
    if (!reminderContent) {
      return fail(
        'Error: Reminder content cannot be empty',
        env('Error: Reminder content cannot be empty'),
      );
    }

    dlg.updateReminder(reminderNo, reminderContent);
    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'updated'));
  },
};

/**
 * Clear mind - start new round, drop all messages, add call body as reminder if provided
 * Usage: @clear_mind
 * <reminder-content> - optional, when provided, adds as new reminder
 */
export const clearMindTool: TextingTool = {
  type: 'texter',
  name: 'clear_mind',
  usageDescription: 'Clear mind and start new round: @clear_mind\\n<reminder-content>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    _headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult> {
    const reminderContent = inputBody.trim();
    if (reminderContent) {
      dlg.addReminder(reminderContent);
    }
    await dlg.startNewRound(
      `This is round #${dlg.currentRound + 1} of the dialog, you just cleared your mind and please proceed with the task.`,
    );
    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'mindCleared'));
  },
};

/**
 * Change mind - start new round, drop all messages, overwrite task doc with call body
 * Usage: @change_mind
 * <new-task-doc-content> - required, overwrites current task doc file
 */
export const changeMindTool: TextingTool = {
  type: 'texter',
  name: 'change_mind',
  usageDescription:
    'Update task document content (no round reset).\n' +
    'Task package: @change_mind !goals|!constraints|!progress\\n<new-section-content>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult> {
    const trimmedHeadLine = headLine.trim();
    if (!trimmedHeadLine.startsWith('@change_mind')) {
      return fail(
        'Error: Invalid format. Use: @change_mind [!goals|!constraints|!progress]',
        env('Error: Invalid format. Use: @change_mind [!goals|!constraints|!progress]'),
      );
    }

    const headBeforeColon = trimmedHeadLine.split(':', 1)[0] || trimmedHeadLine;
    const tokens = headBeforeColon.trim().split(/\s+/);
    const selector = tokens.length >= 2 ? tokens[1] : undefined;
    const extraToken = tokens.length >= 3 ? tokens[2] : undefined;
    if (extraToken) {
      return fail(
        'Error: Too many arguments. Use: @change_mind [!goals|!constraints|!progress]',
        env('Error: Too many arguments. Use: @change_mind [!goals|!constraints|!progress]'),
      );
    }

    const newTaskDocContent = inputBody.trim();

    if (!newTaskDocContent) {
      return fail(
        'Error: Task doc content is required',
        env('Error: Task doc content is required'),
      );
    }

    // Task doc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) {
      return fail(
        'Error: No task doc path configured for this dialog',
        env('Error: No task doc path configured for this dialog'),
      );
    }

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!fullPath.startsWith(workspaceRoot)) {
      return fail(
        'Error: Path must be within workspace',
        env('Error: Path must be within workspace'),
      );
    }

    if (!isTaskPackagePath(taskDocPath)) {
      return fail(
        `Error: This dialog uses a legacy task doc '${taskDocPath}'. Only \`*.tsk/\` task packages are supported.`,
        env(
          `Error: This dialog uses a legacy task doc '${taskDocPath}'. Only \`*.tsk/\` task packages are supported.`,
        ),
      );
    }

    if (!selector) {
      return fail(
        'Error: Task packages require a target selector: !goals | !constraints | !progress',
        env('Error: Task packages require a target selector: !goals | !constraints | !progress'),
      );
    }
    const section: TaskPackageSection | null = taskPackageSectionFromSelector(selector);
    if (!section) {
      return fail(
        `Error: Invalid selector '${selector}'. Use: !goals | !constraints | !progress`,
        env(`Error: Invalid selector '${selector}'. Use: !goals | !constraints | !progress`),
      );
    }

    await updateTaskPackageSection({
      taskPackageDirFullPath: fullPath,
      section,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    return ok(formatToolActionResult(dlg.getLastUserLanguageCode(), 'mindChanged'));
  },
};
