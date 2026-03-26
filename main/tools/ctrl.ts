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
 * - clear_mind: Start a new course, optionally add a reminder
 * - change_mind: Update a `.tsk/` Taskdoc section without starting a new course
 * - recall_taskdoc: Read a Taskdoc section from `*.tsk/` by (category, selector)
 *
 * USAGE CONTEXT:
 * Can both be triggered by an agent autonomously, or by human with role='user' msg,
 * both ways treated the same
 *
 * reminder items with `echoback !== false` are injected into llm input;
 * virtual reminders are UI-only and do not consume reminder_no numbering
 * agents should see hints of reminder manip syntax
 * humans should better have clickable UI widgets to draft reminder manips
 */

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import * as fs from 'fs';
import * as path from 'path';
import type { Dialog } from '../dialog';
import { SubDialog } from '../dialog';
import { formatNewCourseStartPrompt } from '../runtime/driver-messages';
import { formatToolActionResult } from '../runtime/tool-result-messages';
import { getWorkLanguage } from '../runtime/work-language';
import type { Team } from '../team';
import {
  reminderIsNumbered,
  type FuncTool,
  type JsonObject,
  type JsonValue,
  type Reminder,
  type ToolArguments,
} from '../tool';
import {
  bearInMindFilenameForSection,
  isTaskPackagePath,
  parseTaskPackageChangeMindTarget,
  updateTaskPackageByChangeMindTarget,
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
  invalidFormatRecallTaskdoc: string;
  taskDocContentRequired: string;
  noTaskDocPathConfigured: string;
  pathMustBeWithinWorkspace: string;
  invalidTaskDocPath: (taskDocPath: string) => string;
  selectorRequired: string;
  categoryRequired: string;
  invalidSelector: (selector: string) => string;
  invalidCategory: (category: string) => string;
  invalidCategorySelector: (selector: string) => string;
  topLevelSelectorRequiresNoCategory: (category: string, selector: string) => string;
  bearInMindSelectorRequiresBearInMindCategory: (category: string, selector: string) => string;
  taskDocSectionMissing: (relativePath: string) => string;
  clearedCoursePrompt: (nextCourse: number) => string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item));
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

function getManagerTool(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const manager = meta['manager'];
  if (!isRecord(manager)) {
    return undefined;
  }
  const tool = manager['tool'];
  return typeof tool === 'string' && tool.trim().length > 0 ? tool.trim() : undefined;
}

function getDeleteAltInstruction(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }

  const deleteValue = meta['delete'];
  if (!isRecord(deleteValue)) {
    return undefined;
  }

  const altInstruction = deleteValue['altInstruction'];
  return typeof altInstruction === 'string' && altInstruction.trim().length > 0
    ? altInstruction.trim()
    : undefined;
}

function formatManualDeleteBlockedError(language: LanguageCode, altInstruction: string): string {
  return language === 'zh'
    ? `错误：该提醒项不能用 delete_reminder 删除；请改为执行：${altInstruction}`
    : `Error: This reminder cannot be deleted via delete_reminder. Use instead: ${altInstruction}`;
}

function listNumberedReminderIndices(reminders: readonly Reminder[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = reminders[index];
    if (!reminder || !reminderIsNumbered(reminder)) {
      continue;
    }
    indices.push(index);
  }
  return indices;
}

function listNumberedReminders(reminders: readonly Reminder[]): Reminder[] {
  const numbered: Reminder[] = [];
  for (const reminder of reminders) {
    if (!reminder || !reminderIsNumbered(reminder)) {
      continue;
    }
    numbered.push(reminder);
  }
  return numbered;
}

type ReminderRoundSnapshot = Readonly<{
  genseq: number;
  numberedReminders: readonly Reminder[];
}>;

type ContinuationPackageReminderMeta = Readonly<{
  kind: 'continuation_package';
  createdBy: 'clear_mind' | 'context_health';
  contextHealthLevel?: 'caution' | 'critical';
}>;

type ContinuationPackageContextHealthLevel = 'caution' | 'critical';

const reminderRoundSnapshots = new WeakMap<Dialog, ReminderRoundSnapshot>();

function getContinuationPackageContextHealthLevel(
  snapshot: ContextHealthSnapshot | undefined,
): ContinuationPackageContextHealthLevel | undefined {
  if (snapshot?.kind !== 'available') {
    return undefined;
  }
  if (snapshot.level === 'caution' || snapshot.level === 'critical') {
    return snapshot.level;
  }
  return undefined;
}

function buildContinuationPackageReminderMeta(args: {
  existingMeta?: unknown;
  createdBy: 'clear_mind' | 'context_health';
  contextHealthLevel?: 'caution' | 'critical';
}): ContinuationPackageReminderMeta | JsonObject {
  const baseMeta: ContinuationPackageReminderMeta = {
    kind: 'continuation_package',
    createdBy: args.createdBy,
    ...(args.contextHealthLevel === undefined
      ? {}
      : { contextHealthLevel: args.contextHealthLevel }),
  };
  if (!isJsonObject(args.existingMeta)) {
    return baseMeta;
  }
  if (args.existingMeta['kind'] === 'continuation_package') {
    const preservedCreatedBy =
      args.existingMeta['createdBy'] === 'clear_mind' ||
      args.existingMeta['createdBy'] === 'context_health'
        ? args.existingMeta['createdBy']
        : args.createdBy;
    const nextMeta: JsonObject = {
      ...args.existingMeta,
      kind: 'continuation_package',
      createdBy: preservedCreatedBy,
      ...(args.contextHealthLevel === undefined
        ? {}
        : { contextHealthLevel: args.contextHealthLevel }),
    };
    return nextMeta;
  }
  const nextMeta: JsonObject = { ...args.existingMeta, ...baseMeta };
  return nextMeta;
}

function removeContinuationPackageReminderMeta(existingMeta: unknown): {
  changed: boolean;
  nextMeta?: JsonObject | null;
} {
  if (!isJsonObject(existingMeta) || existingMeta['kind'] !== 'continuation_package') {
    return { changed: false };
  }
  const nextMeta: JsonObject = {};
  for (const [key, value] of Object.entries(existingMeta)) {
    if (key === 'kind' || key === 'createdBy' || key === 'contextHealthLevel') {
      continue;
    }
    nextMeta[key] = value;
  }
  if (Object.keys(nextMeta).length === 0) {
    return { changed: true, nextMeta: null };
  }
  return { changed: true, nextMeta };
}

function getNumberedRemindersForLookup(dlg: Dialog): readonly Reminder[] {
  const genseq = dlg.activeGenSeqOrUndefined;
  if (typeof genseq !== 'number') {
    return listNumberedReminders(dlg.reminders);
  }

  const existing = reminderRoundSnapshots.get(dlg);
  if (existing && existing.genseq === genseq) {
    return existing.numberedReminders;
  }

  const snapshot: ReminderRoundSnapshot = {
    genseq,
    numberedReminders: listNumberedReminders(dlg.reminders),
  };
  reminderRoundSnapshots.set(dlg, snapshot);
  return snapshot.numberedReminders;
}

function getCtrlMessages(language: LanguageCode): CtrlMessages {
  if (language === 'zh') {
    return {
      invalidFormatDelete: '参数格式不对。用法：delete_reminder({ reminder_no: number })',
      reminderDoesNotExist: (reminderNoHuman, total) =>
        total > 0
          ? `提醒 #${reminderNoHuman} 不存在。现有提醒：1-${total}`
          : `提醒 #${reminderNoHuman} 不存在。当前没有提醒。`,
      invalidFormatAdd:
        '参数格式不对。用法：add_reminder({ content: string, position: number })（position=0 表示追加）',
      reminderContentEmpty: '提醒内容不能为空',
      invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
        `位置 ${reminderNoHuman} 无效。有效范围：1-${totalPlusOne}`,
      invalidFormatUpdate:
        '参数格式不对。用法：update_reminder({ reminder_no: number, content: string })',
      invalidFormatChangeMind:
        '参数格式不对。用法：change_mind({ selector: string, category?: string, content: string })',
      tooManyArgsChangeMind:
        '参数格式不对。用法：change_mind({ selector: string, category?: string, content: string })',
      invalidFormatRecallTaskdoc:
        '参数格式不对。用法：recall_taskdoc({ category: string, selector: string })',
      taskDocContentRequired:
        '需要提供差遣牒内容（content）。\n' +
        '示例：\n' +
        '```json\n' +
        '{\n' +
        '  "selector": "progress",\n' +
        '  "content": "- 关键决策：...\\n- 下一步：..."\n' +
        '}\n' +
        '```',
      noTaskDocPathConfigured: '此对话未配置差遣牒路径',
      pathMustBeWithinWorkspace: '路径必须位于 rtws（运行时工作区）内',
      invalidTaskDocPath: (taskDocPath) => `差遣牒路径 '${taskDocPath}' 无效。应为 *.tsk/ 目录。`,
      selectorRequired: '需要提供选择器（selector）。',
      categoryRequired: '需要提供章节目录（category）。',
      invalidSelector: (selector) =>
        `选择器 '${selector}' 无效。可用：顶层 goals | constraints | progress；bearinmind 下 contracts | acceptance | grants | runbook | decisions | risks；或任意标识符（如 ux.checklist）。`,
      invalidCategory: (category) =>
        `目录名 '${category}' 无效。需匹配 ^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]*)*$。`,
      invalidCategorySelector: (selector) =>
        `选择器 '${selector}' 无效。需匹配 ^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]*)*$。`,
      topLevelSelectorRequiresNoCategory: (category, selector) =>
        `选择器 '${selector}' 是顶层保留分段（goals/constraints/progress），不能与 category='${category}' 一起用。`,
      bearInMindSelectorRequiresBearInMindCategory: (category, selector) =>
        `选择器 '${selector}' 只能在 category='bearinmind' 下用（当前 category='${category}'）。`,
      taskDocSectionMissing: (relativePath) =>
        `未找到：${relativePath}。\n\n用 change_mind 创建或更新：\n- change_mind({"category":string,"selector":string,"content":string})`,
      clearedCoursePrompt: (nextCourse) =>
        formatNewCourseStartPrompt('zh', { nextCourse, source: 'clear_mind' }),
    };
  }

  return {
    invalidFormatDelete: 'Error: Invalid args. Use: delete_reminder({ reminder_no: number })',
    reminderDoesNotExist: (reminderNoHuman, total) =>
      total > 0
        ? `Error: Reminder number ${reminderNoHuman} does not exist. Available reminders: 1-${total}`
        : `Error: Reminder number ${reminderNoHuman} does not exist. There are no reminders.`,
    invalidFormatAdd:
      'Error: Invalid args. Use: add_reminder({ content: string, position: number }) (position=0 means append).',
    reminderContentEmpty: 'Error: Reminder content cannot be empty',
    invalidReminderPosition: (reminderNoHuman, totalPlusOne) =>
      `Error: Invalid reminder position ${reminderNoHuman}. Valid range: 1-${totalPlusOne}`,
    invalidFormatUpdate:
      'Error: Invalid args. Use: update_reminder({ reminder_no: number, content: string })',
    invalidFormatChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: string, category?: string, content: string })',
    tooManyArgsChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: string, category?: string, content: string })',
    invalidFormatRecallTaskdoc:
      'Error: Invalid args. Use: recall_taskdoc({ category: string, selector: string })',
    taskDocContentRequired:
      'Error: Taskdoc content is required (content).\n' +
      'Copy/paste example:\n' +
      '```json\n' +
      '{\n' +
      '  "selector": "progress",\n' +
      '  "content": "- Key decisions: ...\\n- Next steps: ..."\n' +
      '}\n' +
      '```',
    noTaskDocPathConfigured: 'Error: No Taskdoc path configured for this dialog',
    pathMustBeWithinWorkspace: 'Error: Path must be within rtws (runtime workspace)',
    invalidTaskDocPath: (taskDocPath) =>
      `Error: Invalid Taskdoc path '${taskDocPath}'. Expected a \`*.tsk/\` directory.`,
    selectorRequired: 'Error: selector is required.',
    categoryRequired: 'Error: category is required.',
    invalidSelector: (selector) =>
      `Error: Invalid selector '${selector}'. Use: top-level goals|constraints|progress; under bearinmind: contracts|acceptance|grants|runbook|decisions|risks; or any identifier (e.g. \`ux.checklist\`).`,
    invalidCategory: (category) =>
      `Error: Invalid category '${category}'. Must match \`^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$\`.`,
    invalidCategorySelector: (selector) =>
      `Error: Invalid category selector '${selector}'. Must match \`^[a-zA-Z][a-zA-Z0-9_-]*(\\.[a-zA-Z0-9_-]+)*$\`.`,
    topLevelSelectorRequiresNoCategory: (category, selector) =>
      `Error: Selector '${selector}' is reserved for top-level sections (goals/constraints/progress) and must not be used with category='${category}'.`,
    bearInMindSelectorRequiresBearInMindCategory: (category, selector) =>
      `Error: Selector '${selector}' is only valid under category='bearinmind' (got category='${category}').`,
    taskDocSectionMissing: (relativePath) =>
      `Not found: \`${relativePath}\`.\n\nUse \`change_mind\` to create/update it (whole-section replace):\n- \`change_mind({\"category\":\"<category>\",\"selector\":\"<selector>\",\"content\":\"...\"})\``,
    clearedCoursePrompt: (nextCourse) =>
      formatNewCourseStartPrompt('en', { nextCourse, source: 'clear_mind' }),
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
    const numberedReminders = getNumberedRemindersForLookup(dlg);
    const reminderNo = reminderNoValue - 1; // Convert to 0-based index
    if (reminderNo < 0 || reminderNo >= numberedReminders.length) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }
    const targetReminder = numberedReminders[reminderNo];
    if (!targetReminder) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }
    const targetIndex = dlg.reminders.indexOf(targetReminder);
    if (targetIndex < 0) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }
    const deleteAltInstruction = getDeleteAltInstruction(targetReminder.meta);
    if (deleteAltInstruction !== undefined) {
      return formatManualDeleteBlockedError(language, deleteAltInstruction);
    }
    dlg.deleteReminder(targetIndex);
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

    const numberedIndices = listNumberedReminderIndices(dlg.reminders);
    const positionValue = args['position'];
    let insertIndex = dlg.reminders.length;
    if (positionValue !== undefined) {
      if (typeof positionValue !== 'number' || !Number.isInteger(positionValue)) {
        return t.invalidFormatAdd;
      }
      const position = positionValue - 1;
      if (position < 0 || position > numberedIndices.length) {
        return t.invalidReminderPosition(String(positionValue), numberedIndices.length + 1);
      }
      if (position < numberedIndices.length) {
        const targetIndex = numberedIndices[position];
        if (targetIndex === undefined) {
          return t.invalidReminderPosition(String(positionValue), numberedIndices.length + 1);
        }
        insertIndex = targetIndex;
      }
    }

    const contextHealthLevel = getContinuationPackageContextHealthLevel(dlg.getLastContextHealth());
    const reminderMeta =
      contextHealthLevel === undefined
        ? undefined
        : buildContinuationPackageReminderMeta({
            createdBy: 'context_health',
            contextHealthLevel,
          });
    dlg.addReminder(reminderContent, undefined, reminderMeta, insertIndex);
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
    const numberedReminders = getNumberedRemindersForLookup(dlg);
    const reminderNo = reminderNoValue - 1;
    if (reminderNo < 0 || reminderNo >= numberedReminders.length) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }
    const targetReminder = numberedReminders[reminderNo];
    if (!targetReminder) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }
    const targetIndex = dlg.reminders.indexOf(targetReminder);
    if (targetIndex < 0) {
      return t.reminderDoesNotExist(String(reminderNoValue), numberedReminders.length);
    }

    const reminder = dlg.reminders[targetIndex];
    // `reminder.meta` is persisted JSON. Runtime shape checks are unavoidable here because tools
    // may attach arbitrary metadata for reminder ownership/management.
    const meta = reminder?.meta;
    const managerTool = getManagerTool(meta);
    if (managerTool !== undefined) {
      return language === 'zh'
        ? `错误：该提醒项由工具 ${managerTool} 管理，不能用 update_reminder 修改；请使用 ${managerTool} 更新。`
        : `Error: This reminder is managed by tool ${managerTool}. Do not edit it via update_reminder; use ${managerTool} instead.`;
    }

    const contentValue = args['content'];
    const reminderContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!reminderContent) return t.reminderContentEmpty;

    const contextHealthLevel = getContinuationPackageContextHealthLevel(dlg.getLastContextHealth());
    if (contextHealthLevel === undefined) {
      const stripResult = removeContinuationPackageReminderMeta(reminder?.meta);
      if (stripResult.changed) {
        dlg.updateReminder(targetIndex, reminderContent, stripResult.nextMeta);
        return formatToolActionResult(language, 'updated');
      }
      dlg.updateReminder(targetIndex, reminderContent);
      return formatToolActionResult(language, 'updated');
    }

    const reminderMeta = buildContinuationPackageReminderMeta({
      existingMeta: reminder?.meta,
      createdBy: 'context_health',
      contextHealthLevel,
    });

    dlg.updateReminder(targetIndex, reminderContent, reminderMeta);
    return formatToolActionResult(language, 'updated');
  },
};

export const clearMindTool: FuncTool = {
  type: 'func',
  name: 'clear_mind',
  description: 'Start a new dialog course, optionally carrying one extra continuation reminder.',
  descriptionI18n: {
    en: 'Start a new dialog course, optionally carrying one extra continuation reminder.',
    zh: '开启新一程对话；必要时可额外带一条接续提醒。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reminder_content: {
        type: 'string',
        description: 'Optional extra continuation note not already captured in existing reminders.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const reminderValue = args['reminder_content'];
    const reminderContent = typeof reminderValue === 'string' ? reminderValue.trim() : '';
    if (reminderContent) {
      const contextHealthLevel = getContinuationPackageContextHealthLevel(
        dlg.getLastContextHealth(),
      );
      const continuationMeta = buildContinuationPackageReminderMeta({
        createdBy: 'clear_mind',
        contextHealthLevel,
      });
      dlg.addReminder(reminderContent, undefined, continuationMeta);
    }
    await dlg.startNewCourse(t.clearedCoursePrompt(dlg.currentCourse + 1));

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
  description: 'Replace one shared Taskdoc section in the mainline dialog.',
  descriptionI18n: {
    en: 'Replace one shared Taskdoc section in the mainline dialog.',
    zh: '在主线对话中替换一段共享差遣牒章节。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['selector', 'content'],
    properties: {
      selector: {
        type: 'string',
        description:
          'Target section selector. Top-level: goals|constraints|progress. Under category="bearinmind": contracts|acceptance|grants|runbook|decisions|risks. For other categories: any identifier.',
      },
      category: {
        type: 'string',
        description:
          'Optional category directory within the Taskdoc package. When present, selector targets <category>/<selector>.md.',
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
          `错误：\`change_mind\` 仅允许在主线对话中使用（支线对话中不可用）。\n` +
          `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`change_mind\`，并提供你已合并好的“分段全文替换稿”（禁止覆盖/抹掉他人条目）。`
        );
      }
      return (
        `Error: \`change_mind\` is only available in the mainline dialog (not in sideline dialogs).\n` +
        `Ask the Taskdoc maintainer @${maintainerId} to run \`change_mind\` and provide a fully merged full-section replacement draft (do not overwrite/delete other contributors).`
      );
    }

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (!selector) return t.selectorRequired;

    const categoryValue = args['category'];
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : undefined;

    const contentValue = args['content'];
    const newTaskDocContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!newTaskDocContent) return t.taskDocContentRequired;

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return t.noTaskDocPathConfigured;

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!fullPath.startsWith(workspaceRoot)) return t.pathMustBeWithinWorkspace;

    if (!isTaskPackagePath(taskDocPath)) return t.invalidTaskDocPath(taskDocPath);

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return t.selectorRequired;
        case 'invalid_category_name':
          return t.invalidCategory(e.category);
        case 'invalid_category_selector':
          return t.invalidCategorySelector(e.selector);
        case 'invalid_top_level_selector':
          return t.invalidSelector(e.selector);
        case 'invalid_bearinmind_selector':
          return t.invalidSelector(e.selector);
        case 'top_level_selector_requires_no_category':
          return t.topLevelSelectorRequiresNoCategory(e.category, e.selector);
        case 'bearinmind_selector_requires_bearinmind_category':
          return t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector);
        default: {
          const _exhaustive: never = e;
          return String(_exhaustive);
        }
      }
    }

    await updateTaskPackageByChangeMindTarget({
      taskPackageDirFullPath: fullPath,
      target: parsed.target,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    return formatToolActionResult(language, 'mindChanged');
  },
};

export const recallTaskdocTool: FuncTool = {
  type: 'func',
  name: 'recall_taskdoc',
  description: 'Read one Taskdoc section by (category, selector).',
  descriptionI18n: {
    en: 'Read one Taskdoc section by (category, selector).',
    zh: '按 (category, selector) 读取一段差遣牒章节。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['category', 'selector'],
    properties: {
      category: { type: 'string', description: 'Category directory within the Taskdoc.' },
      selector: { type: 'string', description: 'Section selector within the category.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    const categoryValue = args['category'];
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : '';
    if (category === '') return t.categoryRequired;

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (selector === '') return t.selectorRequired;

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return t.noTaskDocPathConfigured;

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!fullPath.startsWith(workspaceRoot)) return t.pathMustBeWithinWorkspace;

    if (!isTaskPackagePath(taskDocPath)) return t.invalidTaskDocPath(taskDocPath);

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return t.selectorRequired;
        case 'invalid_category_name':
          return t.invalidCategory(e.category);
        case 'invalid_category_selector':
          return t.invalidCategorySelector(e.selector);
        case 'invalid_top_level_selector':
          return t.invalidSelector(e.selector);
        case 'invalid_bearinmind_selector':
          return t.invalidSelector(e.selector);
        case 'top_level_selector_requires_no_category':
          return t.topLevelSelectorRequiresNoCategory(e.category, e.selector);
        case 'bearinmind_selector_requires_bearinmind_category':
          return t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector);
        default: {
          const _exhaustive: never = e;
          return String(_exhaustive);
        }
      }
    }

    const target = parsed.target;
    const relPath = (() => {
      switch (target.kind) {
        case 'bearinmind':
          return path.join('bearinmind', bearInMindFilenameForSection(target.section));
        case 'category':
          return path.join(target.category, `${target.selector}.md`);
        case 'top_level':
          return null;
        default: {
          const _exhaustive: never = target;
          return _exhaustive;
        }
      }
    })();

    if (relPath === null) {
      return t.invalidFormatRecallTaskdoc;
    }

    const sectionPath = path.resolve(fullPath, relPath);
    if (!sectionPath.startsWith(fullPath)) {
      return t.pathMustBeWithinWorkspace;
    }

    try {
      const st = await fs.promises.stat(sectionPath);
      if (!st.isFile()) {
        return t.taskDocSectionMissing(relPath);
      }
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return t.taskDocSectionMissing(relPath);
      }
      throw err;
    }

    const content = await fs.promises.readFile(sectionPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const maxSize = 100 * 1024;
    const clipped = bytes > maxSize ? content.slice(0, maxSize) : content;
    const note =
      bytes > maxSize
        ? language === 'zh'
          ? `\n\n⚠️ 已截断：内容过大（${bytes} bytes），仅回显前 ${maxSize} bytes。`
          : `\n\n⚠️ Truncated: content is too large (${bytes} bytes); showing first ${maxSize} bytes.`
        : '';

    return `**recall_taskdoc:** \`${relPath}\`\n\n---\n${clipped}\n---${note}`;
  },
};
