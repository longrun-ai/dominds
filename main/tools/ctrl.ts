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
 * - delete_reminder: Delete a reminder by id
 * - update_reminder: Update reminder content
 * - clear_mind: Start a new course, optionally add a reminder
 * - do_mind: Create a new `.tsk/` Taskdoc section without starting a new course
 * - change_mind: Update a `.tsk/` Taskdoc section without starting a new course
 * - mind_more: Append entries to a `.tsk/` Taskdoc section without starting a new course
 * - never_mind: Delete a `.tsk/` Taskdoc section file without starting a new course
 * - recall_taskdoc: Read a Taskdoc section from `*.tsk/` by (category, selector)
 *
 * USAGE CONTEXT:
 * Can both be triggered by an agent autonomously, or by human with role='user' msg,
 * both ways treated the same
 *
 * reminder items with `echoback !== false` are injected into llm input;
 * virtual reminders are UI-only and do not appear in reminder_id-targeted operations
 * agents should see hints of reminder manip syntax
 * humans should better have clickable UI widgets to draft reminder manips
 */

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import * as fs from 'fs';
import * as path from 'path';
import type { Dialog, VisibleReminderTarget } from '../dialog';
import { InvalidReminderIndexError, SideDialog } from '../dialog';
import { formatNewCourseStartPrompt } from '../runtime/driver-messages';
import { formatToolActionResult } from '../runtime/tool-result-messages';
import { getWorkLanguage } from '../runtime/work-language';
import { mutateAgentSharedReminders } from '../shared-reminders';
import type { Team } from '../team';
import {
  materializeReminder,
  reminderIsListed,
  toolFailure,
  toolSuccess,
  type FuncTool,
  type JsonObject,
  type JsonValue,
  type Reminder,
  type ReminderRenderMode,
  type ReminderScope,
  type ToolArguments,
  type ToolCallOutput,
} from '../tool';
import {
  appendTaskPackageByChangeMindTarget,
  createTaskPackageByChangeMindTarget,
  deleteTaskPackageByChangeMindTarget,
  isTaskPackagePath,
  parseTaskPackageChangeMindTarget,
  taskPackageRelativePathForChangeMindTarget,
  updateTaskPackageByChangeMindTarget,
} from '../utils/task-package';

type CtrlMessages = Readonly<{
  invalidFormatDelete: string;
  reminderDoesNotExist: (reminderId: string) => string;
  reminderTargetChanged: string;
  invalidFormatAdd: string;
  personalPositionUnsupported: string;
  reminderContentEmpty: string;
  invalidReminderPosition: (positionHuman: string, totalPlusOne: number) => string;
  invalidFormatUpdate: string;
  invalidFormatDoMind: string;
  invalidFormatChangeMind: string;
  tooManyArgsChangeMind: string;
  invalidFormatMindMore: string;
  invalidFormatNeverMind: string;
  mindMoreItemsRequired: string;
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
  taskDocSectionAlreadyExists: (relativePath: string) => string;
  taskDocSectionChangeMissing: (relativePath: string) => string;
  taskDocSectionMissing: (relativePath: string) => string;
  taskDocSectionDeleteMissing: (relativePath: string) => string;
  clearedCoursePrompt: (nextCourse: number) => string;
}>;

class InvalidReminderPositionError extends Error {
  public readonly positionHuman: string;
  public readonly totalPlusOne: number;

  constructor(positionHuman: string, totalPlusOne: number) {
    super(`Invalid reminder position ${positionHuman} (max ${String(totalPlusOne)})`);
    this.positionHuman = positionHuman;
    this.totalPlusOne = totalPlusOne;
  }
}

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

function isPathWithinDirectory(childPath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function getUpdateAltInstruction(meta: unknown): string | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }

  const updateValue = meta['update'];
  if (!isRecord(updateValue)) {
    return undefined;
  }

  const altInstruction = updateValue['altInstruction'];
  return typeof altInstruction === 'string' && altInstruction.trim().length > 0
    ? altInstruction.trim()
    : undefined;
}

function formatManualDeleteBlockedError(language: LanguageCode, altInstruction: string): string {
  return language === 'zh'
    ? `错误：该提醒项不能用 delete_reminder 删除；请改为执行：${altInstruction}`
    : `Error: This reminder cannot be deleted via delete_reminder. Use instead: ${altInstruction}`;
}

function formatManualUpdateBlockedError(language: LanguageCode, altInstruction: string): string {
  return language === 'zh'
    ? `错误：该提醒项不能用 update_reminder 修改；请改按此处理：${altInstruction}`
    : `Error: This reminder cannot be edited via update_reminder. Follow instead: ${altInstruction}`;
}

function listListedReminderIndices(reminders: readonly Reminder[]): number[] {
  return listListedReminderIndicesBy(reminders, () => true);
}

function listListedReminderIndicesBy(
  reminders: readonly Reminder[],
  predicate: (reminder: Reminder) => boolean,
): number[] {
  const indices: number[] = [];
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = reminders[index];
    if (!reminder || !reminderIsListed(reminder) || !predicate(reminder)) {
      continue;
    }
    indices.push(index);
  }
  return indices;
}

function computeReminderInsertIndex(
  reminders: readonly Reminder[],
  positionValue: unknown,
  predicate: (reminder: Reminder) => boolean,
): number {
  const listedIndices = listListedReminderIndicesBy(reminders, predicate);
  let insertIndex = reminders.length;
  if (positionValue === undefined) {
    return insertIndex;
  }
  if (typeof positionValue !== 'number' || !Number.isInteger(positionValue)) {
    throw new Error('invalid_add_position_format');
  }
  const position = positionValue - 1;
  if (position < 0 || position > listedIndices.length) {
    throw new InvalidReminderPositionError(String(positionValue), listedIndices.length + 1);
  }
  if (position < listedIndices.length) {
    const targetIndex = listedIndices[position];
    if (targetIndex === undefined) {
      throw new InvalidReminderPositionError(String(positionValue), listedIndices.length + 1);
    }
    insertIndex = targetIndex;
  }
  return insertIndex;
}

function parseReminderRenderMode(value: unknown): ReminderRenderMode | null {
  if (value === undefined) return 'markdown';
  return value === 'plain' || value === 'markdown' ? value : null;
}

type ContinuationPackageReminderMeta = Readonly<{
  kind: 'continuation_package';
  createdBy: 'clear_mind' | 'context_health';
  contextHealthLevel?: 'caution' | 'critical';
}>;

type ContinuationPackageContextHealthLevel = 'caution' | 'critical';
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

async function resolveReminderTarget(
  dlg: Dialog,
  reminderIdRaw: unknown,
): Promise<{ ok: true; target: VisibleReminderTarget } | { ok: false; reminderId: string }> {
  const reminderId = typeof reminderIdRaw === 'string' ? reminderIdRaw.trim() : '';
  if (reminderId === '') {
    return { ok: false, reminderId: String(reminderIdRaw ?? '') };
  }
  const target = await dlg.resolveReminderTargetById(reminderId);
  if (!target) {
    return { ok: false, reminderId };
  }
  return { ok: true, target };
}

function runReminderIndexMutation(mutation: () => void): boolean {
  try {
    mutation();
    return true;
  } catch (error: unknown) {
    if (error instanceof InvalidReminderIndexError) {
      return false;
    }
    throw error;
  }
}

function findReminderIndexById(
  sourceLabel: 'dialog' | 'shared',
  reminders: readonly Reminder[],
  reminderId: string,
): number | null {
  let foundIndex: number | null = null;
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = reminders[index];
    if (reminder?.id !== reminderId) continue;
    if (foundIndex !== null) {
      throw new Error(`Duplicate ${sourceLabel} reminder_id detected: ${reminderId}`);
    }
    foundIndex = index;
  }
  return foundIndex;
}

async function deleteSharedReminderById(agentId: string, reminderId: string): Promise<boolean> {
  return mutateAgentSharedReminders(agentId, (reminders) => {
    const index = findReminderIndexById('shared', reminders, reminderId);
    if (index === null) return false;
    reminders.splice(index, 1);
    return true;
  });
}

async function updateSharedReminderById(
  agentId: string,
  reminderId: string,
  updateReminder: (reminder: Reminder) => Reminder,
): Promise<boolean> {
  return mutateAgentSharedReminders(agentId, (reminders) => {
    const index = findReminderIndexById('shared', reminders, reminderId);
    if (index === null) return false;
    const reminder = reminders[index];
    if (reminder === undefined) {
      throw new Error(
        `Shared reminder index ${index} disappeared while updating reminder_id ${reminderId}`,
      );
    }
    reminders[index] = updateReminder(reminder);
    return true;
  });
}

function replaceReminderContent(
  reminder: Reminder,
  content: string,
  meta: JsonValue | undefined,
  renderMode: ReminderRenderMode | undefined,
): Reminder {
  return materializeReminder({
    id: reminder.id,
    content,
    owner: reminder.owner,
    meta: meta !== undefined ? meta : reminder.meta,
    echoback: reminder.echoback,
    scope: reminder.scope,
    createdAt: reminder.createdAt,
    priority: reminder.priority,
    renderMode: renderMode ?? reminder.renderMode,
  });
}

async function deleteResolvedReminderTarget(
  dlg: Dialog,
  target: VisibleReminderTarget,
): Promise<boolean> {
  switch (target.source) {
    case 'dialog': {
      const index = findReminderIndexById('dialog', dlg.reminders, target.reminder.id);
      if (index === null) return false;
      return runReminderIndexMutation(() => {
        dlg.deleteReminder(index);
      });
    }
    case 'agent_shared': {
      const deleted = await deleteSharedReminderById(target.agentId, target.reminder.id);
      if (deleted) dlg.touchReminders();
      return deleted;
    }
  }
  const _exhaustive: never = target;
  return _exhaustive;
}

async function updateResolvedReminderTarget(
  dlg: Dialog,
  target: VisibleReminderTarget,
  content: string,
  meta: JsonValue | undefined,
  renderMode: ReminderRenderMode | undefined,
): Promise<boolean> {
  switch (target.source) {
    case 'dialog': {
      const index = findReminderIndexById('dialog', dlg.reminders, target.reminder.id);
      if (index === null) return false;
      return runReminderIndexMutation(() => {
        dlg.updateReminder(index, content, meta, { renderMode });
      });
    }
    case 'agent_shared': {
      const updated = await updateSharedReminderById(
        target.agentId,
        target.reminder.id,
        (current) => replaceReminderContent(current, content, meta, renderMode),
      );
      if (updated) dlg.touchReminders();
      return updated;
    }
  }
  const _exhaustive: never = target;
  return _exhaustive;
}

function getCtrlMessages(language: LanguageCode): CtrlMessages {
  if (language === 'zh') {
    return {
      invalidFormatDelete: '参数格式不对。用法：delete_reminder({ reminder_id: string })',
      reminderDoesNotExist: (reminderId) => `提醒项 '${reminderId}' 不存在。`,
      reminderTargetChanged:
        '错误：提醒项列表已变化，这条提醒项当前不在可见列表中。请重新查看提醒项列表后，用当前的 reminder_id 重试。',
      invalidFormatAdd:
        '参数格式不对。用法：add_reminder({ content: string, position?: number, scope?: "dialog" | "personal" })（省略 position 表示追加）',
      personalPositionUnsupported: 'personal 范围提醒当前只支持追加，不能指定 position。',
      reminderContentEmpty: '提醒内容不能为空',
      invalidReminderPosition: (positionHuman, totalPlusOne) =>
        `位置 ${positionHuman} 无效。有效范围：1-${totalPlusOne}`,
      invalidFormatUpdate:
        '参数格式不对。用法：update_reminder({ reminder_id: string, content: string })',
      invalidFormatDoMind:
        '参数格式不对。用法：do_mind({ selector: string, category?: string, content: string })',
      invalidFormatChangeMind:
        '参数格式不对。用法：change_mind({ selector: string, category?: string, content: string })',
      tooManyArgsChangeMind:
        '参数格式不对。用法：change_mind({ selector: string, category?: string, content: string })',
      invalidFormatMindMore:
        '参数格式不对。用法：mind_more({ items: string[], sep?: string, selector?: string, category?: string })（selector 默认 progress）',
      invalidFormatNeverMind:
        '参数格式不对。用法：never_mind({ selector: string, category?: string })',
      mindMoreItemsRequired:
        '需要提供要追加的条目（items），且每一项都必须是非空字符串。\n' +
        '示例：mind_more({"items":["- 下一步：复核验证结果（详见 <文档路径>#<章节>）","- 阻塞：等待 API 验收口径确认"]})',
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
      taskDocSectionAlreadyExists: (relativePath) =>
        `无法新增：${relativePath} 已存在。若确有把握要改写已有章节，请使用 change_mind({ ... })。`,
      taskDocSectionChangeMissing: (relativePath) =>
        `无法修改：${relativePath} 不存在。若要新增章节，请使用 do_mind({ ... })。`,
      taskDocSectionMissing: (relativePath) =>
        `未找到：${relativePath}。\n\n新增章节请使用 do_mind；已有章节追加小条目用 mind_more；改写已有章节用 change_mind：\n- do_mind({"category":"<category>","selector":"<selector>","content":"..."})\n- mind_more({"category":"<category>","selector":"<selector>","items":["..."]})\n- change_mind({"category":"<category>","selector":"<selector>","content":"..."})`,
      taskDocSectionDeleteMissing: (relativePath) =>
        `无法删除：${relativePath} 不存在。请先确认要删除的差遣牒章节。`,
      clearedCoursePrompt: (nextCourse) =>
        formatNewCourseStartPrompt('zh', { nextCourse, source: 'clear_mind' }),
    };
  }

  return {
    invalidFormatDelete: 'Error: Invalid args. Use: delete_reminder({ reminder_id: string })',
    reminderDoesNotExist: (reminderId) => `Error: Reminder '${reminderId}' does not exist.`,
    reminderTargetChanged:
      'Error: The reminder list changed, and this reminder is no longer visible. Refresh the reminders and retry with the current reminder_id.',
    invalidFormatAdd:
      'Error: Invalid args. Use: add_reminder({ content: string, position?: number, scope?: "dialog" | "personal" }) (omit position to append).',
    personalPositionUnsupported:
      'Error: personal-scope reminders currently support append only; do not pass position.',
    reminderContentEmpty: 'Error: Reminder content cannot be empty',
    invalidReminderPosition: (positionHuman, totalPlusOne) =>
      `Error: Invalid reminder position ${positionHuman}. Valid range: 1-${totalPlusOne}`,
    invalidFormatUpdate:
      'Error: Invalid args. Use: update_reminder({ reminder_id: string, content: string })',
    invalidFormatDoMind:
      'Error: Invalid args. Use: do_mind({ selector: string, category?: string, content: string })',
    invalidFormatChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: string, category?: string, content: string })',
    tooManyArgsChangeMind:
      'Error: Invalid args. Use: change_mind({ selector: string, category?: string, content: string })',
    invalidFormatMindMore:
      'Error: Invalid args. Use: mind_more({ items: string[], sep?: string, selector?: string, category?: string }) (selector defaults to progress).',
    invalidFormatNeverMind:
      'Error: Invalid args. Use: never_mind({ selector: string, category?: string })',
    mindMoreItemsRequired:
      'Error: items are required, and every item must be a non-empty string.\n' +
      'Example: mind_more({"items":["- Next: review verification results (details: <doc-path>#<section>)","- Blocker: API acceptance criteria pending"]})',
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
    taskDocSectionAlreadyExists: (relativePath) =>
      `Cannot add: \`${relativePath}\` already exists. If you are sure you need to rewrite an existing section, use \`change_mind({ ... })\`.`,
    taskDocSectionChangeMissing: (relativePath) =>
      `Cannot change: \`${relativePath}\` does not exist. To create a new section, use \`do_mind({ ... })\`.`,
    taskDocSectionMissing: (relativePath) =>
      `Not found: \`${relativePath}\`.\n\nUse \`do_mind\` to create a section, \`mind_more\` for small append-only updates to existing sections, and \`change_mind\` to rewrite existing sections:\n- \`do_mind({\"category\":\"<category>\",\"selector\":\"<selector>\",\"content\":\"...\"})\`\n- \`mind_more({\"category\":\"<category>\",\"selector\":\"<selector>\",\"items\":[\"...\"]})\`\n- \`change_mind({\"category\":\"<category>\",\"selector\":\"<selector>\",\"content\":\"...\"})\``,
    taskDocSectionDeleteMissing: (relativePath) =>
      `Cannot delete: \`${relativePath}\` does not exist. Check the Taskdoc section target first.`,
    clearedCoursePrompt: (nextCourse) =>
      formatNewCourseStartPrompt('en', { nextCourse, source: 'clear_mind' }),
  };
}

export const deleteReminderTool: FuncTool = {
  type: 'func',
  name: 'delete_reminder',
  description: 'Delete a reminder by its reminder_id.',
  descriptionI18n: {
    en: 'Delete a reminder by its reminder_id.',
    zh: '按 reminder_id 删除提醒。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['reminder_id'],
    properties: {
      reminder_id: { type: 'string', description: 'Stable reminder id.' },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const resolved = await resolveReminderTarget(dlg, args['reminder_id']);
    if (!resolved.ok) {
      const reminderId = resolved.reminderId.trim();
      if (reminderId === '') return toolFailure(t.invalidFormatDelete);
      return toolFailure(t.reminderDoesNotExist(reminderId));
    }
    const targetReminder = resolved.target.reminder;
    const deleteAltInstruction = getDeleteAltInstruction(targetReminder.meta);
    if (deleteAltInstruction !== undefined) {
      return toolFailure(formatManualDeleteBlockedError(language, deleteAltInstruction));
    }
    const deleted = await deleteResolvedReminderTarget(dlg, resolved.target);
    if (!deleted) return toolFailure(t.reminderTargetChanged);
    return formatToolActionResult(language, 'deleted');
  },
};

export const addReminderTool: FuncTool = {
  type: 'func',
  name: 'add_reminder',
  description:
    'Add a reminder, optionally inserting at a 1-based position and choosing dialog or personal scope.',
  descriptionI18n: {
    en: 'Add a reminder, optionally inserting at a 1-based position and choosing dialog or personal scope.',
    zh: '添加提醒，可选指定 1-based 插入位置，并可选择对话或个人范围。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
      content: { type: 'string', description: 'Reminder content.' },
      position: { type: 'integer', description: 'Insert position (1-based). Defaults to append.' },
      scope: {
        type: 'string',
        enum: ['dialog', 'personal'],
        description: 'Reminder visibility scope. Defaults to dialog.',
      },
      render_mode: {
        type: 'string',
        enum: ['markdown', 'plain'],
        description: 'How the reminder should render in WebUI. Defaults to markdown.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const contentValue = args['content'];
    const reminderContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!reminderContent) return toolFailure(t.reminderContentEmpty);

    const scopeValue = args['scope'];
    const reminderScope: 'dialog' | 'personal' | null =
      scopeValue === undefined
        ? 'dialog'
        : scopeValue === 'dialog' || scopeValue === 'personal'
          ? scopeValue
          : null;
    if (reminderScope === null) {
      return toolFailure(t.invalidFormatAdd);
    }
    const reminderRenderMode = parseReminderRenderMode(args['render_mode']);
    if (reminderRenderMode === null) {
      return toolFailure(t.invalidFormatAdd);
    }

    const positionValue = args['position'];
    const contextHealthLevel = getContinuationPackageContextHealthLevel(dlg.getLastContextHealth());
    const reminderMeta =
      contextHealthLevel === undefined
        ? undefined
        : buildContinuationPackageReminderMeta({
            createdBy: 'context_health',
            contextHealthLevel,
          });

    if (reminderScope === 'dialog') {
      try {
        const insertIndex = computeReminderInsertIndex(dlg.reminders, positionValue, () => true);
        dlg.addReminder(reminderContent, undefined, reminderMeta, insertIndex, {
          scope: 'dialog',
          renderMode: reminderRenderMode,
        });
        return formatToolActionResult(language, 'added');
      } catch (error: unknown) {
        if (error instanceof InvalidReminderPositionError) {
          return toolFailure(t.invalidReminderPosition(error.positionHuman, error.totalPlusOne));
        }
        if (error instanceof Error && error.message === 'invalid_add_position_format') {
          return toolFailure(t.invalidFormatAdd);
        }
        throw error;
      }
    }

    try {
      await mutateAgentSharedReminders(dlg.agentId, (reminders) => {
        if (positionValue !== undefined) {
          throw new Error('personal_add_position_unsupported');
        }
        const reminder = materializeReminder({
          content: reminderContent,
          meta: reminderMeta,
          scope: 'personal' satisfies ReminderScope,
          renderMode: reminderRenderMode,
        });
        reminders.push(reminder);
      });
      dlg.touchReminders();
      return formatToolActionResult(language, 'added');
    } catch (error: unknown) {
      if (error instanceof InvalidReminderPositionError) {
        return toolFailure(t.invalidReminderPosition(error.positionHuman, error.totalPlusOne));
      }
      if (error instanceof Error && error.message === 'invalid_add_position_format') {
        return toolFailure(t.invalidFormatAdd);
      }
      if (error instanceof Error && error.message === 'personal_add_position_unsupported') {
        return toolFailure(t.personalPositionUnsupported);
      }
      throw error;
    }
  },
};

export const updateReminderTool: FuncTool = {
  type: 'func',
  name: 'update_reminder',
  description: 'Update an existing reminder by its reminder_id.',
  descriptionI18n: {
    en: 'Update an existing reminder by its reminder_id.',
    zh: '按 reminder_id 更新提醒内容。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['reminder_id', 'content'],
    properties: {
      reminder_id: { type: 'string', description: 'Stable reminder id.' },
      content: { type: 'string', description: 'New reminder content.' },
      render_mode: {
        type: 'string',
        enum: ['markdown', 'plain'],
        description: 'Optional render mode override. Defaults to preserving current mode.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);
    const resolved = await resolveReminderTarget(dlg, args['reminder_id']);
    if (!resolved.ok) {
      const reminderId = resolved.reminderId.trim();
      if (reminderId === '') return toolFailure(t.invalidFormatUpdate);
      return toolFailure(t.reminderDoesNotExist(reminderId));
    }
    const reminder = resolved.target.reminder;
    // `reminder.meta` is persisted JSON. Runtime shape checks are unavoidable here because tools
    // may attach arbitrary metadata for reminder ownership/management.
    const meta = reminder?.meta;
    const updateAltInstruction = getUpdateAltInstruction(meta);
    if (updateAltInstruction !== undefined) {
      return toolFailure(formatManualUpdateBlockedError(language, updateAltInstruction));
    }
    const managerTool = getManagerTool(meta);
    if (managerTool !== undefined) {
      return toolFailure(
        language === 'zh'
          ? `错误：该提醒项由工具 ${managerTool} 管理，不能用 update_reminder 修改；请使用 ${managerTool} 更新。`
          : `Error: This reminder is managed by tool ${managerTool}. Do not edit it via update_reminder; use ${managerTool} instead.`,
      );
    }

    const contentValue = args['content'];
    const reminderContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!reminderContent) return toolFailure(t.reminderContentEmpty);
    const requestedRenderMode = args['render_mode'];
    const reminderRenderMode =
      requestedRenderMode === undefined
        ? reminder.renderMode
        : parseReminderRenderMode(requestedRenderMode);
    if (reminderRenderMode === null) {
      return toolFailure(t.invalidFormatUpdate);
    }

    const contextHealthLevel = getContinuationPackageContextHealthLevel(dlg.getLastContextHealth());
    if (contextHealthLevel === undefined) {
      const stripResult = removeContinuationPackageReminderMeta(reminder?.meta);
      if (stripResult.changed) {
        const updated = await updateResolvedReminderTarget(
          dlg,
          resolved.target,
          reminderContent,
          stripResult.nextMeta,
          reminderRenderMode,
        );
        if (!updated) return toolFailure(t.reminderTargetChanged);
        return formatToolActionResult(language, 'updated');
      }
      const updated = await updateResolvedReminderTarget(
        dlg,
        resolved.target,
        reminderContent,
        undefined,
        reminderRenderMode,
      );
      if (!updated) return toolFailure(t.reminderTargetChanged);
      return formatToolActionResult(language, 'updated');
    }

    const reminderMeta = buildContinuationPackageReminderMeta({
      existingMeta: reminder?.meta,
      createdBy: 'context_health',
      contextHealthLevel,
    });

    const updated = await updateResolvedReminderTarget(
      dlg,
      resolved.target,
      reminderContent,
      reminderMeta,
      reminderRenderMode,
    );
    if (!updated) return toolFailure(t.reminderTargetChanged);
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
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
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
  description: 'Replace one existing shared Taskdoc section in the Main Dialog.',
  descriptionI18n: {
    en: 'Replace one existing shared Taskdoc section in the Main Dialog.',
    zh: '在主线对话中替换一段已存在的共享差遣牒章节。',
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
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    if (dlg.askerDialog !== undefined) {
      const maintainerId = dlg instanceof SideDialog ? dlg.mainDialog.agentId : dlg.agentId;
      if (language === 'zh') {
        return toolFailure(
          `错误：\`change_mind\` 仅允许在主线对话中使用（支线对话中不可用）。\n` +
            `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\`，并提供要新增的章节、要追加的条目、已合并好的“分段全文替换稿”或要删除的章节（禁止覆盖/抹掉他人条目）。`,
        );
      }
      return toolFailure(
        `Error: \`change_mind\` is only available in the Main Dialog (not in Side Dialogs).\n` +
          `Ask the Taskdoc maintainer @${maintainerId} to run \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\` with the new section to create, entries to append, a fully merged full-section replacement draft, or the section to delete (do not overwrite/delete other contributors).`,
      );
    }

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (!selector) return toolFailure(t.selectorRequired);

    const categoryValue = args['category'];
    if (categoryValue !== undefined && typeof categoryValue !== 'string') {
      return toolFailure(t.invalidFormatChangeMind);
    }
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : undefined;

    const contentValue = args['content'];
    const newTaskDocContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!newTaskDocContent) return toolFailure(t.taskDocContentRequired);

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return toolFailure(t.noTaskDocPathConfigured);

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!isPathWithinDirectory(fullPath, workspaceRoot)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    if (!isTaskPackagePath(taskDocPath)) return toolFailure(t.invalidTaskDocPath(taskDocPath));

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return toolFailure(t.selectorRequired);
        case 'invalid_category_name':
          return toolFailure(t.invalidCategory(e.category));
        case 'invalid_category_selector':
          return toolFailure(t.invalidCategorySelector(e.selector));
        case 'invalid_top_level_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'invalid_bearinmind_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'top_level_selector_requires_no_category':
          return toolFailure(t.topLevelSelectorRequiresNoCategory(e.category, e.selector));
        case 'bearinmind_selector_requires_bearinmind_category':
          return toolFailure(
            t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector),
          );
        default: {
          const _exhaustive: never = e;
          return toolFailure(String(_exhaustive));
        }
      }
    }

    const result = await updateTaskPackageByChangeMindTarget({
      taskPackageDirFullPath: fullPath,
      target: parsed.target,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    switch (result.kind) {
      case 'updated':
        return formatToolActionResult(language, 'mindChanged');
      case 'missing':
        return toolFailure(
          t.taskDocSectionChangeMissing(taskPackageRelativePathForChangeMindTarget(parsed.target)),
        );
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  },
};

export const doMindTool: FuncTool = {
  type: 'func',
  name: 'do_mind',
  description: 'Create one new shared Taskdoc section in the Main Dialog.',
  descriptionI18n: {
    en: 'Create one new shared Taskdoc section in the Main Dialog.',
    zh: '在主线对话中新增一段共享差遣牒章节。',
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
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    if (dlg.askerDialog !== undefined) {
      const maintainerId = dlg instanceof SideDialog ? dlg.mainDialog.agentId : dlg.agentId;
      if (language === 'zh') {
        return toolFailure(
          `错误：\`do_mind\` 仅允许在主线对话中使用（支线对话中不可用）。\n` +
            `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\`，并提供要新增的章节、要追加的条目、已合并好的“分段全文替换稿”或要删除的章节（禁止覆盖/抹掉他人条目）。`,
        );
      }
      return toolFailure(
        `Error: \`do_mind\` is only available in the Main Dialog (not in Side Dialogs).\n` +
          `Ask the Taskdoc maintainer @${maintainerId} to run \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\` with the new section to create, entries to append, a fully merged full-section replacement draft, or the section to delete (do not overwrite/delete other contributors).`,
      );
    }

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (!selector) return toolFailure(t.selectorRequired);

    const categoryValue = args['category'];
    if (categoryValue !== undefined && typeof categoryValue !== 'string') {
      return toolFailure(t.invalidFormatDoMind);
    }
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : undefined;

    const contentValue = args['content'];
    const newTaskDocContent = typeof contentValue === 'string' ? contentValue.trim() : '';
    if (!newTaskDocContent) return toolFailure(t.taskDocContentRequired);

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return toolFailure(t.noTaskDocPathConfigured);

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!isPathWithinDirectory(fullPath, workspaceRoot)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    if (!isTaskPackagePath(taskDocPath)) return toolFailure(t.invalidTaskDocPath(taskDocPath));

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return toolFailure(t.selectorRequired);
        case 'invalid_category_name':
          return toolFailure(t.invalidCategory(e.category));
        case 'invalid_category_selector':
          return toolFailure(t.invalidCategorySelector(e.selector));
        case 'invalid_top_level_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'invalid_bearinmind_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'top_level_selector_requires_no_category':
          return toolFailure(t.topLevelSelectorRequiresNoCategory(e.category, e.selector));
        case 'bearinmind_selector_requires_bearinmind_category':
          return toolFailure(
            t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector),
          );
        default: {
          const _exhaustive: never = e;
          return toolFailure(String(_exhaustive));
        }
      }
    }

    const result = await createTaskPackageByChangeMindTarget({
      taskPackageDirFullPath: fullPath,
      target: parsed.target,
      content: newTaskDocContent,
      updatedBy: caller.id,
    });
    switch (result.kind) {
      case 'created':
        return formatToolActionResult(language, 'mindChanged');
      case 'exists':
        return toolFailure(
          t.taskDocSectionAlreadyExists(taskPackageRelativePathForChangeMindTarget(parsed.target)),
        );
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  },
};

export const neverMindTool: FuncTool = {
  type: 'func',
  name: 'never_mind',
  description: 'Delete one shared Taskdoc section file in the Main Dialog.',
  descriptionI18n: {
    en: 'Delete one shared Taskdoc section file in the Main Dialog.',
    zh: '在主线对话中删除一段共享差遣牒章节文件。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['selector'],
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
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    if (dlg.askerDialog !== undefined) {
      const maintainerId = dlg instanceof SideDialog ? dlg.mainDialog.agentId : dlg.agentId;
      if (language === 'zh') {
        return toolFailure(
          `错误：\`never_mind\` 仅允许在主线对话中使用（支线对话中不可用）。\n` +
            `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\`，并提供要新增的章节、要追加的条目、已合并好的“分段全文替换稿”或要删除的章节（禁止覆盖/抹掉他人条目）。`,
        );
      }
      return toolFailure(
        `Error: \`never_mind\` is only available in the Main Dialog (not in Side Dialogs).\n` +
          `Ask the Taskdoc maintainer @${maintainerId} to run \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\` with the new section to create, entries to append, a fully merged full-section replacement draft, or the section to delete (do not overwrite/delete other contributors).`,
      );
    }

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (!selector) return toolFailure(t.selectorRequired);

    const categoryValue = args['category'];
    if (categoryValue !== undefined && typeof categoryValue !== 'string') {
      return toolFailure(t.invalidFormatNeverMind);
    }
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : undefined;

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return toolFailure(t.noTaskDocPathConfigured);

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!isPathWithinDirectory(fullPath, workspaceRoot)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    if (!isTaskPackagePath(taskDocPath)) return toolFailure(t.invalidTaskDocPath(taskDocPath));

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return toolFailure(t.selectorRequired);
        case 'invalid_category_name':
          return toolFailure(t.invalidCategory(e.category));
        case 'invalid_category_selector':
          return toolFailure(t.invalidCategorySelector(e.selector));
        case 'invalid_top_level_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'invalid_bearinmind_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'top_level_selector_requires_no_category':
          return toolFailure(t.topLevelSelectorRequiresNoCategory(e.category, e.selector));
        case 'bearinmind_selector_requires_bearinmind_category':
          return toolFailure(
            t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector),
          );
        default: {
          const _exhaustive: never = e;
          return toolFailure(String(_exhaustive));
        }
      }
    }

    const result = await deleteTaskPackageByChangeMindTarget({
      taskPackageDirFullPath: fullPath,
      target: parsed.target,
    });
    switch (result.kind) {
      case 'deleted':
        return formatToolActionResult(language, 'deleted');
      case 'missing': {
        return toolFailure(
          t.taskDocSectionDeleteMissing(taskPackageRelativePathForChangeMindTarget(parsed.target)),
        );
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  },
};

export const mindMoreTool: FuncTool = {
  type: 'func',
  name: 'mind_more',
  description: 'Append entries to one shared Taskdoc section in the Main Dialog.',
  descriptionI18n: {
    en: 'Append entries to one shared Taskdoc section in the Main Dialog.',
    zh: '在主线对话中向一段共享差遣牒章节追加条目。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        description: 'Entries to append. Each entry must be a non-empty string.',
        items: { type: 'string' },
      },
      sep: {
        type: 'string',
        description:
          'Separator inserted between existing content and new entries, and between entries. Defaults to "\\n".',
      },
      selector: {
        type: 'string',
        description:
          'Target section selector. Defaults to progress. Top-level: goals|constraints|progress. Under category="bearinmind": contracts|acceptance|grants|runbook|decisions|risks. For other categories: any identifier.',
      },
      category: {
        type: 'string',
        description:
          'Optional category directory within the Taskdoc package. When present, selector targets <category>/<selector>.md.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    if (dlg.askerDialog !== undefined) {
      const maintainerId = dlg instanceof SideDialog ? dlg.mainDialog.agentId : dlg.agentId;
      if (language === 'zh') {
        return toolFailure(
          `错误：\`mind_more\` 仅允许在主线对话中使用（支线对话中不可用）。\n` +
            `请诉请差遣牒维护人 @${maintainerId} 在其对话中执行 \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\`，并提供要新增的章节、要追加的条目、已合并好的“分段全文替换稿”或要删除的章节（禁止覆盖/抹掉他人条目）。`,
        );
      }
      return toolFailure(
        `Error: \`mind_more\` is only available in the Main Dialog (not in Side Dialogs).\n` +
          `Ask the Taskdoc maintainer @${maintainerId} to run \`do_mind\` / \`mind_more\` / \`change_mind\` / \`never_mind\` with the new section to create, entries to append, a merged full-section replacement draft, or the section to delete (do not overwrite/delete other contributors).`,
      );
    }

    const rawItems = args['items'];
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return toolFailure(t.mindMoreItemsRequired);
    }
    const items: string[] = [];
    for (const item of rawItems) {
      if (typeof item !== 'string') return toolFailure(t.mindMoreItemsRequired);
      const normalized = item.trim();
      if (!normalized) return toolFailure(t.mindMoreItemsRequired);
      items.push(normalized);
    }

    const sepValue = args['sep'];
    const sep = sepValue === undefined ? '\n' : typeof sepValue === 'string' ? sepValue : null;
    if (sep === null) return toolFailure(t.invalidFormatMindMore);

    const selectorValue = args['selector'];
    const selector =
      selectorValue === undefined
        ? 'progress'
        : typeof selectorValue === 'string'
          ? selectorValue.trim()
          : '';
    if (!selector) return toolFailure(t.selectorRequired);

    const categoryValue = args['category'];
    if (categoryValue !== undefined && typeof categoryValue !== 'string') {
      return toolFailure(t.invalidFormatMindMore);
    }
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : undefined;

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return toolFailure(t.noTaskDocPathConfigured);

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!isPathWithinDirectory(fullPath, workspaceRoot)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    if (!isTaskPackagePath(taskDocPath)) return toolFailure(t.invalidTaskDocPath(taskDocPath));

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return toolFailure(t.selectorRequired);
        case 'invalid_category_name':
          return toolFailure(t.invalidCategory(e.category));
        case 'invalid_category_selector':
          return toolFailure(t.invalidCategorySelector(e.selector));
        case 'invalid_top_level_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'invalid_bearinmind_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'top_level_selector_requires_no_category':
          return toolFailure(t.topLevelSelectorRequiresNoCategory(e.category, e.selector));
        case 'bearinmind_selector_requires_bearinmind_category':
          return toolFailure(
            t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector),
          );
        default: {
          const _exhaustive: never = e;
          return toolFailure(String(_exhaustive));
        }
      }
    }

    await appendTaskPackageByChangeMindTarget({
      taskPackageDirFullPath: fullPath,
      target: parsed.target,
      content: items.join(sep),
      sep,
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
  async call(dlg: Dialog, _caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getCtrlMessages(language);

    const categoryValue = args['category'];
    const category = typeof categoryValue === 'string' ? categoryValue.trim() : '';
    if (category === '') return toolFailure(t.categoryRequired);

    const selectorValue = args['selector'];
    const selector = typeof selectorValue === 'string' ? selectorValue.trim() : '';
    if (selector === '') return toolFailure(t.selectorRequired);

    // Taskdoc path is immutable for the dialog lifecycle.
    const taskDocPath = dlg.taskDocPath;
    if (!taskDocPath) return toolFailure(t.noTaskDocPathConfigured);

    const workspaceRoot = path.resolve(process.cwd());
    const fullPath = path.resolve(workspaceRoot, taskDocPath);
    if (!isPathWithinDirectory(fullPath, workspaceRoot)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    if (!isTaskPackagePath(taskDocPath)) return toolFailure(t.invalidTaskDocPath(taskDocPath));

    const parsed = parseTaskPackageChangeMindTarget({ selector, category });
    if (parsed.kind !== 'ok') {
      const e = parsed.error;
      switch (e.kind) {
        case 'selector_required':
          return toolFailure(t.selectorRequired);
        case 'invalid_category_name':
          return toolFailure(t.invalidCategory(e.category));
        case 'invalid_category_selector':
          return toolFailure(t.invalidCategorySelector(e.selector));
        case 'invalid_top_level_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'invalid_bearinmind_selector':
          return toolFailure(t.invalidSelector(e.selector));
        case 'top_level_selector_requires_no_category':
          return toolFailure(t.topLevelSelectorRequiresNoCategory(e.category, e.selector));
        case 'bearinmind_selector_requires_bearinmind_category':
          return toolFailure(
            t.bearInMindSelectorRequiresBearInMindCategory(e.category, e.selector),
          );
        default: {
          const _exhaustive: never = e;
          return toolFailure(String(_exhaustive));
        }
      }
    }

    const target = parsed.target;
    if (target.kind === 'top_level') {
      return toolFailure(t.invalidFormatRecallTaskdoc);
    }
    const relPath = taskPackageRelativePathForChangeMindTarget(target);

    const sectionPath = path.resolve(fullPath, relPath);
    if (!isPathWithinDirectory(sectionPath, fullPath)) {
      return toolFailure(t.pathMustBeWithinWorkspace);
    }

    try {
      const st = await fs.promises.stat(sectionPath);
      if (!st.isFile()) {
        return toolFailure(t.taskDocSectionMissing(relPath));
      }
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'ENOENT'
      ) {
        return toolFailure(t.taskDocSectionMissing(relPath));
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

    const closingSeparatorPrefix = clipped.endsWith('\n') ? '' : '\n';
    return toolSuccess(
      `**recall_taskdoc:** \`${relPath}\`\n\n---\n${clipped}${closingSeparatorPrefix}---${note}`,
    );
  },
};
