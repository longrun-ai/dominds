import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { Dialog } from './dialog';
import { getWorkLanguage } from './runtime/work-language';
import { materializeReminder, type JsonObject, type Reminder } from './tool';

export const MAIN_DIALOG_GOAL_REMINDER_ID = 'mainDialogGoal';

type MainDialogGoalReminderMetaBase = Readonly<{
  kind: 'main_dialog_goal';
  updatedAt: string;
  update: Readonly<{ altInstruction: string }>;
  delete: Readonly<{ altInstruction: string }>;
}>;

type MainDialogGoalReminderMeta =
  | (MainDialogGoalReminderMetaBase &
      Readonly<{
        mode: 'requires_human_confirmation';
        goal?: never;
      }>)
  | (MainDialogGoalReminderMetaBase &
      Readonly<{
        mode: 'follow_taskdoc';
        goal?: never;
      }>)
  | (MainDialogGoalReminderMetaBase &
      Readonly<{
        mode: 'specific_goal';
        goal: string;
      }>);

type BuildMainDialogGoalMetaArgs =
  | Readonly<{
      mode: 'requires_human_confirmation';
      updatedAt?: string;
    }>
  | Readonly<{
      mode: 'follow_taskdoc';
      updatedAt?: string;
    }>
  | Readonly<{
      mode: 'specific_goal';
      goal: string;
      updatedAt?: string;
    }>;

export type SetMainDialogGoalRequest =
  | Readonly<{
      mode: 'goal';
      goal: string;
    }>
  | Readonly<{
      mode: 'follow_taskdoc';
    }>;

export type SetMainDialogGoalResult =
  | Readonly<{
      kind: 'updated';
      reminder: Reminder;
    }>
  | Readonly<{
      kind: 'rejected_parallel_dialogs';
      reminder: Reminder;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainDialog(dlg: Dialog): boolean {
  return dlg.id.selfId === dlg.id.rootId;
}

function parseMainDialogGoalMeta(meta: unknown): MainDialogGoalReminderMeta | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  if (meta['kind'] !== 'main_dialog_goal') {
    return undefined;
  }
  const mode = meta['mode'];
  if (
    mode !== 'requires_human_confirmation' &&
    mode !== 'specific_goal' &&
    mode !== 'follow_taskdoc'
  ) {
    throw new Error(`Invalid main-dialog goal reminder mode: ${String(mode)}`);
  }
  const goal = meta['goal'];
  const specificGoal = mode === 'specific_goal' && typeof goal === 'string' ? goal : undefined;
  if (mode === 'specific_goal') {
    if (specificGoal === undefined || specificGoal.trim() === '') {
      throw new Error('Invalid main-dialog goal reminder meta: specific_goal requires goal');
    }
  } else if (goal !== undefined) {
    throw new Error('Invalid main-dialog goal reminder meta: goal is only valid for specific_goal');
  }
  const updatedAt = meta['updatedAt'];
  if (typeof updatedAt !== 'string' || updatedAt.trim() === '') {
    throw new Error('Invalid main-dialog goal reminder meta: updatedAt required');
  }
  const update = meta['update'];
  if (!isRecord(update) || typeof update['altInstruction'] !== 'string') {
    throw new Error('Invalid main-dialog goal reminder meta: update.altInstruction required');
  }
  const deleteValue = meta['delete'];
  if (!isRecord(deleteValue) || typeof deleteValue['altInstruction'] !== 'string') {
    throw new Error('Invalid main-dialog goal reminder meta: delete.altInstruction required');
  }
  const base: MainDialogGoalReminderMetaBase = {
    kind: 'main_dialog_goal',
    updatedAt,
    update: { altInstruction: update['altInstruction'] },
    delete: { altInstruction: deleteValue['altInstruction'] },
  };
  switch (mode) {
    case 'requires_human_confirmation':
      return { ...base, mode };
    case 'follow_taskdoc':
      return { ...base, mode };
    case 'specific_goal': {
      if (specificGoal === undefined) {
        throw new Error('Invalid main-dialog goal reminder meta: specific_goal requires goal');
      }
      return { ...base, mode, goal: specificGoal };
    }
  }
}

function mainDialogGoalMaintenanceInstruction(): string {
  return (
    'set_dialog_goal({ "mode": "goal", "goal": "..." }) ' +
    'or set_dialog_goal({ "mode": "follow_taskdoc" })'
  );
}

function buildMainDialogGoalMeta(args: BuildMainDialogGoalMetaArgs): MainDialogGoalReminderMeta {
  if (args.mode === 'specific_goal') {
    if (args.goal.trim() === '') {
      throw new Error('Main-dialog goal reminder specific_goal meta requires a non-empty goal');
    }
  } else if ('goal' in args && args.goal !== undefined) {
    throw new Error('Main-dialog goal reminder goal is only valid for specific_goal meta');
  }
  const instruction = mainDialogGoalMaintenanceInstruction();
  const base: MainDialogGoalReminderMetaBase = {
    kind: 'main_dialog_goal',
    updatedAt: args.updatedAt ?? formatUnifiedTimestamp(new Date()),
    update: { altInstruction: instruction },
    delete: { altInstruction: instruction },
  };
  switch (args.mode) {
    case 'requires_human_confirmation':
      return { ...base, mode: args.mode };
    case 'follow_taskdoc':
      return { ...base, mode: args.mode };
    case 'specific_goal':
      return { ...base, mode: args.mode, goal: args.goal };
  }
}

function formatMainDialogGoalContent(
  language: LanguageCode,
  meta: MainDialogGoalReminderMeta,
  hasParallelDialogs: boolean,
): string {
  if (language === 'zh') {
    switch (meta.mode) {
      case 'specific_goal':
        return `本路主线目标：\n${meta.goal}`;
      case 'follow_taskdoc':
        return hasParallelDialogs
          ? [
              '本路主线目标：依差遣牒推进。',
              'Dominds 已确认：这个智能体现在还有其它并行对话。不能只按差遣牒继续；请立即问人类：这一路主线接下来具体推进什么？得到答案后用 set_dialog_goal 记录。',
            ].join('\n')
          : [
              '本路主线目标：依差遣牒推进。',
              'Dominds 已确认：当前这个智能体只有这一条对话，可以按差遣牒继续。若以后出现同智能体并行对话，Dominds 会在这条提醒上补充“先问人类”。',
            ].join('\n');
      case 'requires_human_confirmation':
        return hasParallelDialogs
          ? [
              '本路主线目标：未设置。',
              'Dominds 已确认：这个智能体现在有其它并行对话。请立即问人类：这一路主线接下来具体推进什么？得到答案后用 set_dialog_goal 记录。',
            ].join('\n')
          : [
              '本路主线目标：未设置。',
              '请立即问人类：这一路主线接下来具体推进什么？得到答案后用 set_dialog_goal 记录。',
            ].join('\n');
    }
  }

  switch (meta.mode) {
    case 'specific_goal':
      return `Goal for this Main Dialog:\n${meta.goal}`;
    case 'follow_taskdoc':
      return hasParallelDialogs
        ? [
            'Goal for this Main Dialog: proceed from the Taskdoc.',
            'Dominds has confirmed that this agent now has another parallel dialog. Do not continue from the Taskdoc alone. Ask the human immediately: what should this Main Dialog work on next? Then record the answer with set_dialog_goal.',
          ].join('\n')
        : [
            'Goal for this Main Dialog: proceed from the Taskdoc.',
            'Dominds has confirmed that this agent has only one dialog right now, so following the Taskdoc is enough. If another parallel dialog appears for this agent, Dominds will add an "ask the human first" note to this reminder.',
          ].join('\n');
    case 'requires_human_confirmation':
      return hasParallelDialogs
        ? [
            'Goal for this Main Dialog: not set.',
            'Dominds has confirmed that this agent now has another parallel dialog. Ask the human immediately: what should this Main Dialog work on next? Then record the answer with set_dialog_goal.',
          ].join('\n')
        : [
            'Goal for this Main Dialog: not set.',
            'Ask the human immediately: what should this Main Dialog work on next? Then record the answer with set_dialog_goal.',
          ].join('\n');
  }
}

function buildMainDialogGoalReminder(args: {
  existing?: Reminder;
  meta: MainDialogGoalReminderMeta;
  language: LanguageCode;
  hasParallelDialogs: boolean;
}): Reminder {
  return materializeReminder({
    id: MAIN_DIALOG_GOAL_REMINDER_ID,
    content: formatMainDialogGoalContent(args.language, args.meta, args.hasParallelDialogs),
    meta: args.meta as unknown as JsonObject,
    echoback: true,
    scope: 'dialog',
    createdAt: args.existing?.createdAt ?? args.meta.updatedAt,
    priority: 'high',
    renderMode: 'markdown',
  });
}

function mainDialogGoalMetaEquals(value: unknown, expected: MainDialogGoalReminderMeta): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const actual = parseMainDialogGoalMeta(value);
  const expectedKeys =
    expected.goal === undefined
      ? ['delete', 'kind', 'mode', 'update', 'updatedAt']
      : ['delete', 'goal', 'kind', 'mode', 'update', 'updatedAt'];
  return (
    actual !== undefined &&
    Object.keys(value).sort().join('\0') === expectedKeys.sort().join('\0') &&
    actual.mode === expected.mode &&
    actual.goal === expected.goal &&
    actual.updatedAt === expected.updatedAt &&
    actual.update.altInstruction === expected.update.altInstruction &&
    actual.delete.altInstruction === expected.delete.altInstruction
  );
}

function reminderMatchesMainDialogGoalState(
  existing: Reminder,
  next: Reminder,
  meta: MainDialogGoalReminderMeta,
): boolean {
  return (
    existing.content === next.content &&
    mainDialogGoalMetaEquals(existing.meta, meta) &&
    existing.echoback === true &&
    existing.scope === next.scope &&
    existing.renderMode === next.renderMode &&
    existing.priority === next.priority
  );
}

function findMainDialogGoalReminderIndex(reminders: readonly Reminder[]): number | undefined {
  let foundIndex: number | undefined;
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = reminders[index];
    if (reminder === undefined) {
      continue;
    }
    const meta = parseMainDialogGoalMeta(reminder.meta);
    const hasFixedId = reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID;
    if (hasFixedId && meta === undefined) {
      throw new Error(
        `Reminder id ${MAIN_DIALOG_GOAL_REMINDER_ID} is reserved for the main-dialog goal reminder`,
      );
    }
    if (meta !== undefined && !hasFixedId) {
      throw new Error(
        `Main-dialog goal reminder must use id ${MAIN_DIALOG_GOAL_REMINDER_ID}; got ${reminder.id}`,
      );
    }
    if (!hasFixedId) {
      continue;
    }
    if (reminder.scope !== 'dialog') {
      throw new Error('Main-dialog goal reminder must be dialog-scoped');
    }
    if (foundIndex !== undefined) {
      throw new Error(`Duplicate main-dialog goal reminder detected in dialog-local reminders`);
    }
    foundIndex = index;
  }
  return foundIndex;
}

async function countRunningDialogsForAgentIncludingCurrent(dlg: Dialog): Promise<number> {
  if (dlg.status !== 'running') {
    return 1;
  }
  const { globalDialogRegistry } = await import('./dialog-global-registry.js');
  const runningDialogs = globalDialogRegistry.getRunningDialogsByAgent(dlg.agentId);
  const includesCurrent = runningDialogs.some((candidate) => candidate.id.equals(dlg.id));
  return runningDialogs.length + (includesCurrent ? 0 : 1);
}

async function hasParallelRunningDialogsForAgent(dlg: Dialog): Promise<boolean> {
  return (await countRunningDialogsForAgentIncludingCurrent(dlg)) > 1;
}

function normalizeExistingMetaForReconcile(args: {
  existing: Reminder | undefined;
}): MainDialogGoalReminderMeta {
  const existingMeta = parseMainDialogGoalMeta(args.existing?.meta);
  if (existingMeta === undefined) {
    return buildMainDialogGoalMeta({
      mode: 'requires_human_confirmation',
    });
  }
  return existingMeta;
}

function upsertMainDialogGoalReminder(args: {
  dlg: Dialog;
  meta: MainDialogGoalReminderMeta;
  hasParallelDialogs: boolean;
}): {
  changed: boolean;
  reminder: Reminder;
} {
  const index = findMainDialogGoalReminderIndex(args.dlg.reminders);
  if (index === undefined) {
    const next = buildMainDialogGoalReminder({
      meta: args.meta,
      language: getWorkLanguage(),
      hasParallelDialogs: args.hasParallelDialogs,
    });
    args.dlg.reminders.unshift(next);
    args.dlg.touchReminders();
    return { changed: true, reminder: next };
  }
  const existing = args.dlg.reminders[index];
  if (existing === undefined) {
    throw new Error(`Main-dialog goal reminder index ${index} disappeared before update`);
  }
  const next = buildMainDialogGoalReminder({
    existing,
    meta: args.meta,
    language: getWorkLanguage(),
    hasParallelDialogs: args.hasParallelDialogs,
  });
  if (reminderMatchesMainDialogGoalState(existing, next, args.meta)) {
    return { changed: false, reminder: existing };
  }
  args.dlg.reminders[index] = next;
  args.dlg.touchReminders();
  return { changed: true, reminder: next };
}

export async function ensureMainDialogGoalReminder(dlg: Dialog): Promise<boolean> {
  if (!isMainDialog(dlg)) {
    return false;
  }
  const hasParallelDialogs = await hasParallelRunningDialogsForAgent(dlg);
  return reconcileMainDialogGoalReminderForKnownParallelState(dlg, hasParallelDialogs);
}

export function reconcileMainDialogGoalReminderForKnownParallelState(
  dlg: Dialog,
  hasParallelDialogs: boolean,
): boolean {
  if (!isMainDialog(dlg)) {
    return false;
  }
  const index = findMainDialogGoalReminderIndex(dlg.reminders);
  const existing = index === undefined ? undefined : dlg.reminders[index];
  const meta = normalizeExistingMetaForReconcile({
    existing,
  });
  return upsertMainDialogGoalReminder({ dlg, meta, hasParallelDialogs }).changed;
}

export function refreshFollowTaskdocMainDialogGoalReminderForKnownParallelState(
  dlg: Dialog,
): boolean {
  if (!isMainDialog(dlg)) {
    return false;
  }
  const index = findMainDialogGoalReminderIndex(dlg.reminders);
  if (index === undefined) {
    return false;
  }
  const existing = dlg.reminders[index];
  if (existing === undefined) {
    throw new Error(`Main-dialog goal reminder index ${index} disappeared before parallel marking`);
  }
  const existingMeta = parseMainDialogGoalMeta(existing.meta);
  if (existingMeta?.mode !== 'follow_taskdoc') {
    return false;
  }
  return upsertMainDialogGoalReminder({
    dlg,
    meta: existingMeta,
    hasParallelDialogs: true,
  }).changed;
}

export async function setMainDialogGoalReminder(
  dlg: Dialog,
  request: SetMainDialogGoalRequest,
): Promise<SetMainDialogGoalResult> {
  if (!isMainDialog(dlg)) {
    throw new Error('setMainDialogGoalReminder is only valid for Main Dialogs');
  }
  const hasParallelDialogs = await hasParallelRunningDialogsForAgent(dlg);
  if (request.mode === 'follow_taskdoc' && hasParallelDialogs) {
    const rejected = upsertMainDialogGoalReminder({
      dlg,
      meta: buildMainDialogGoalMeta({
        mode: 'follow_taskdoc',
      }),
      hasParallelDialogs,
    });
    return { kind: 'rejected_parallel_dialogs', reminder: rejected.reminder };
  }

  if (request.mode === 'follow_taskdoc') {
    return {
      kind: 'updated',
      reminder: upsertMainDialogGoalReminder({
        dlg,
        meta: buildMainDialogGoalMeta({ mode: 'follow_taskdoc' }),
        hasParallelDialogs,
      }).reminder,
    };
  }

  const goal = request.goal.trim();
  if (goal === '') {
    throw new Error('setMainDialogGoalReminder requires a non-empty goal');
  }
  return {
    kind: 'updated',
    reminder: upsertMainDialogGoalReminder({
      dlg,
      meta: buildMainDialogGoalMeta({ mode: 'specific_goal', goal }),
      hasParallelDialogs,
    }).reminder,
  };
}
