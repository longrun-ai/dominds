import type { DialogRuntimePrompt } from '@longrun-ai/kernel/types/drive-intent';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { Dialog, DialogID } from '../../dialog';
import { hasActiveRun } from '../../dialog-display-state';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { formatSystemNoticePrefix } from '../../runtime/driver-messages';
import { getWorkLanguage } from '../../runtime/work-language';
import { mutateAgentSharedReminders } from '../../shared-reminders';
import { materializeReminder, type Reminder, type ReminderWakeEvent } from '../../tool';
import type { KernelDriverDriveCallbacks } from './types';

const IDLE_WAKE_AGGREGATION_WINDOW_MS = 500;

type IdleReminderWakeTask = Readonly<{
  dialogKey: string;
  controller: AbortController;
  startedAt: string;
}>;

const idleReminderWakeTasks = new Map<string, IdleReminderWakeTask>();

function normalizeWakeEvents(
  result: ReminderWakeEvent | readonly ReminderWakeEvent[] | null,
): ReminderWakeEvent[] {
  if (result === null) return [];
  if (Array.isArray(result)) {
    return result.map(assertWakeEventShape);
  }
  const event = result as ReminderWakeEvent;
  return [assertWakeEventShape(event)];
}

function assertWakeEventShape(event: ReminderWakeEvent): ReminderWakeEvent {
  if (event.eventId.trim() === '') {
    throw new Error('idle reminder wake invariant violation: empty eventId');
  }
  if (event.reminderId.trim() === '') {
    throw new Error(`idle reminder wake invariant violation: empty reminderId (${event.eventId})`);
  }
  if (event.content.trim() === '') {
    throw new Error(`idle reminder wake invariant violation: empty content (${event.eventId})`);
  }
  if (!event.content.startsWith('【系统提示】') && !event.content.startsWith('[System notice]')) {
    throw new Error(
      `idle reminder wake invariant violation: wake event content must start with a system notice prefix (${event.eventId})`,
    );
  }
  return event;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timeout: NodeJS.Timeout;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      finish();
    };
    timeout = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isCurrentTask(dialogId: DialogID, task: IdleReminderWakeTask): boolean {
  return idleReminderWakeTasks.get(dialogId.key()) === task;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted');
}

function stripSystemNoticePrefix(content: string, prefix: string): string {
  const normalized = content.trim();
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length).trim();
  }
  return normalized;
}

function buildAggregatedWakePromptContent(events: readonly ReminderWakeEvent[]): string {
  if (events.length === 1) {
    const only = events[0];
    if (!only) {
      throw new Error('idle reminder wake invariant violation: missing first event');
    }
    return only.content;
  }
  const language = getWorkLanguage();
  const prefix = formatSystemNoticePrefix(language);
  const body = events
    .map((event, index) => {
      const eventText = stripSystemNoticePrefix(event.content, prefix);
      return `${String(index + 1)}. ${eventText}`;
    })
    .join('\n\n');
  return language === 'zh'
    ? `${prefix}
以下是对话空闲期间发生的 runtime 环境事件。这些事件不是新的用户指令。

${body}

请结合当前任务上下文继续推进；若这些事件不影响当前工作，不要发送占位式确认。`
    : `${prefix}
The following runtime environment events happened while the dialog was idle. These events are not new user instructions.

${body}

Continue according to the current task context; if these events do not affect the work, do not send a placeholder acknowledgement.`;
}

async function applyWakeEventUpdates(
  dialog: Dialog,
  events: readonly ReminderWakeEvent[],
): Promise<void> {
  const eventsWithUpdates = events.filter(
    (event) => event.updatedContent !== undefined || event.updatedMeta !== undefined,
  );
  if (eventsWithUpdates.length === 0) return;

  const byReminderId = new Map<string, ReminderWakeEvent>();
  for (const event of eventsWithUpdates) {
    const existing = byReminderId.get(event.reminderId);
    if (existing && existing.eventId !== event.eventId) {
      throw new Error(
        `idle reminder wake invariant violation: multiple wake updates for reminder ${event.reminderId}`,
      );
    }
    byReminderId.set(event.reminderId, event);
  }

  const targets = await dialog.listVisibleReminderTargets();
  const appliedReminderIds = new Set<string>();
  for (const target of targets) {
    const event = byReminderId.get(target.reminder.id);
    if (!event) continue;
    appliedReminderIds.add(event.reminderId);
    const nextContent = event.updatedContent ?? target.reminder.content;
    const nextMeta = event.updatedMeta !== undefined ? event.updatedMeta : target.reminder.meta;
    if (target.source === 'dialog') {
      dialog.updateReminder(target.index, nextContent, nextMeta, {
        renderMode: target.reminder.renderMode,
      });
      continue;
    }
    await mutateAgentSharedReminders(target.agentId, (reminders) => {
      const index = reminders.findIndex((reminder) => reminder.id === target.reminder.id);
      if (index < 0) {
        throw new Error(
          `idle reminder wake invariant violation: shared reminder ${target.reminder.id} disappeared before update`,
        );
      }
      const previous = reminders[index];
      if (!previous) {
        throw new Error(
          `idle reminder wake invariant violation: shared reminder ${target.reminder.id} missing at resolved index`,
        );
      }
      reminders[index] = materializeReminder({
        id: previous.id,
        content: nextContent,
        owner: previous.owner,
        meta: nextMeta,
        echoback: previous.echoback,
        scope: previous.scope,
        createdAt: previous.createdAt,
        priority: previous.priority,
        renderMode: previous.renderMode,
      });
    });
    dialog.touchReminders();
  }
  for (const reminderId of byReminderId.keys()) {
    if (appliedReminderIds.has(reminderId)) continue;
    throw new Error(
      `idle reminder wake invariant violation: reminder update target disappeared before apply (${reminderId})`,
    );
  }

  await dialog.processReminderUpdates();
}

async function loadFreshIdleWakeEligibility(dialog: Dialog): Promise<boolean> {
  if (hasActiveRun(dialog.id)) return false;
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
  if (!latest) return false;
  if (latest.displayState?.kind !== 'idle_waiting_user') return false;
  if (latest.executionMarker?.kind === 'dead') return false;
  if (latest.executionMarker?.kind === 'interrupted') return false;
  const q4h = await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status);
  if (q4h.length > 0) return false;
  const pendingSideDialogs = await DialogPersistence.loadPendingSideDialogs(
    dialog.id,
    dialog.status,
  );
  return pendingSideDialogs.length === 0;
}

function collectWakeCapableReminders(
  reminders: readonly Reminder[],
): Array<Readonly<{ ownerName: string; reminder: Reminder }>> {
  const result: Array<Readonly<{ ownerName: string; reminder: Reminder }>> = [];
  for (const reminder of reminders) {
    if (!reminder.owner?.waitForReminderWakeEvent) continue;
    result.push({ ownerName: reminder.owner.name, reminder });
  }
  return result;
}

function dedupeAndSortWakeEvents(events: readonly ReminderWakeEvent[]): ReminderWakeEvent[] {
  const byId = new Map<string, ReminderWakeEvent>();
  for (const event of events) {
    const existing = byId.get(event.eventId);
    if (existing) {
      if (
        existing.content !== event.content ||
        existing.reminderId !== event.reminderId ||
        existing.updatedContent !== event.updatedContent ||
        JSON.stringify(existing.updatedMeta ?? null) !== JSON.stringify(event.updatedMeta ?? null)
      ) {
        throw new Error(
          `idle reminder wake invariant violation: conflicting duplicate eventId ${event.eventId}`,
        );
      }
      continue;
    }
    byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));
}

async function runIdleReminderWakeTask(
  dialog: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  task: IdleReminderWakeTask,
): Promise<void> {
  if (!(await loadFreshIdleWakeEligibility(dialog))) return;
  const targets = collectWakeCapableReminders(await dialog.listVisibleReminders());
  if (targets.length === 0) return;

  const waitController = new AbortController();
  task.controller.signal.addEventListener(
    'abort',
    () => {
      waitController.abort();
    },
    { once: true },
  );
  if (task.controller.signal.aborted) {
    waitController.abort();
  }

  const collected: ReminderWakeEvent[] = [];
  let pending = targets.length;
  let resolveFirstEvent: (() => void) | undefined;
  const firstEvent = new Promise<void>((resolve) => {
    resolveFirstEvent = resolve;
  });
  const settleOne = (): void => {
    pending -= 1;
    if (pending === 0 && collected.length === 0) {
      resolveFirstEvent?.();
    }
  };

  for (const target of targets) {
    const owner = target.reminder.owner;
    if (!owner?.waitForReminderWakeEvent) {
      settleOne();
      continue;
    }
    void owner
      .waitForReminderWakeEvent(dialog, [target.reminder], waitController.signal)
      .then((result) => {
        const events = normalizeWakeEvents(result);
        if (events.length > 0) {
          collected.push(...events);
          resolveFirstEvent?.();
        }
      })
      .catch((error: unknown) => {
        if (!waitController.signal.aborted && !isAbortLikeError(error)) {
          log.warn('idle reminder wake owner wait failed', error, {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
            ownerName: target.ownerName,
            reminderId: target.reminder.id,
          });
        }
      })
      .finally(() => {
        settleOne();
      });
  }

  await firstEvent;
  if (task.controller.signal.aborted || collected.length === 0) return;
  await sleep(IDLE_WAKE_AGGREGATION_WINDOW_MS, task.controller.signal);
  if (task.controller.signal.aborted || !isCurrentTask(dialog.id, task)) return;

  waitController.abort();
  const events = dedupeAndSortWakeEvents(collected);
  if (events.length === 0) return;

  await applyWakeEventUpdates(dialog, events);
  if (task.controller.signal.aborted || !isCurrentTask(dialog.id, task)) return;
  if (!(await loadFreshIdleWakeEligibility(dialog))) {
    log.debug('idle reminder wake dropped because dialog is no longer eligible', undefined, {
      dialogId: dialog.id.valueOf(),
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
      eventIds: events.map((event) => event.eventId),
    });
    return;
  }

  const prompt: DialogRuntimePrompt = {
    content: buildAggregatedWakePromptContent(events),
    msgId: generateShortId(),
    grammar: 'markdown',
    origin: 'runtime',
  };

  await callbacks.driveDialog(dialog, {
    humanPrompt: prompt,
    waitInQue: true,
    driveOptions: {
      source: 'kernel_driver_idle_reminder_wake',
      reason: 'idle_reminder_wake',
    },
  });
}

export function cancelIdleReminderWake(dialogId: DialogID, reason: string): void {
  const task = idleReminderWakeTasks.get(dialogId.key());
  if (!task) return;
  idleReminderWakeTasks.delete(dialogId.key());
  task.controller.abort();
  log.debug('idle reminder wake task canceled', undefined, {
    dialogId: dialogId.valueOf(),
    rootId: dialogId.rootId,
    selfId: dialogId.selfId,
    reason,
    startedAt: task.startedAt,
  });
}

export function maybeStartIdleReminderWake(
  dialog: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  reason: string,
): void {
  cancelIdleReminderWake(dialog.id, `replace:${reason}`);
  const task: IdleReminderWakeTask = {
    dialogKey: dialog.id.key(),
    controller: new AbortController(),
    startedAt: formatUnifiedTimestamp(new Date()),
  };
  idleReminderWakeTasks.set(dialog.id.key(), task);
  log.debug('idle reminder wake task started', undefined, {
    dialogId: dialog.id.valueOf(),
    rootId: dialog.id.rootId,
    selfId: dialog.id.selfId,
    reason,
    startedAt: task.startedAt,
  });
  void (async () => {
    try {
      if (!(await loadFreshIdleWakeEligibility(dialog))) return;
      if (task.controller.signal.aborted || !isCurrentTask(dialog.id, task)) return;
      await runIdleReminderWakeTask(dialog, callbacks, task);
    } catch (error: unknown) {
      if (!task.controller.signal.aborted && !isAbortLikeError(error)) {
        log.warn('idle reminder wake task failed', error, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
      }
    } finally {
      if (isCurrentTask(dialog.id, task)) {
        idleReminderWakeTasks.delete(dialog.id.key());
      }
    }
  })();
}
