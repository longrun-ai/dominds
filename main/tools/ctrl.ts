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
 * - @change_mind: Drop all messages, start new round, overwrite task doc with call body
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

import * as fs from 'fs';
import * as path from 'path';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import type { Team } from '../team';
import { TextingTool, TextingToolCallResult } from '../tool';

function env(content: string): ChatMessage[] {
  return [{ type: 'environment_msg', role: 'user', content }] satisfies ChatMessage[];
}

function guide(content: string): ChatMessage[] {
  return [{ type: 'transient_guide_msg', role: 'assistant', content }] satisfies ChatMessage[];
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
    return ok('Deleted');
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
    return ok('Added');
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
    return ok('Updated');
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
    await dlg.startNewRound();
    return ok(
      'Mind cleared',
      guide('Mind cleared. Continue with a fresh response in the new round.'),
    );
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
  usageDescription: 'Change mind and start new round: @change_mind\\n<new-task-doc-content>',
  backfeeding: false,
  async call(
    dlg: Dialog,
    _caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult> {
    const trimmedHeadLine = headLine.trim();
    if (!/^@change_mind(?:\s*:\s*.*)?$/.test(trimmedHeadLine)) {
      return fail(
        'Error: Invalid format. Use: @change_mind',
        env('Error: Invalid format. Use: @change_mind'),
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

    // Write new task doc content
    const fullPath = path.resolve(taskDocPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, newTaskDocContent, 'utf8');

    await dlg.startNewRound();
    return ok(
      'Mind changed',
      guide('Mind changed. Continue with a fresh response in the new round.'),
    );
  },
};
