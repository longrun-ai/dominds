import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, type Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { DialogPersistence } from '../persistence';
import {
  formatAutoMaintainedReminderManualMirrorBan,
  formatSystemNoticePrefix,
} from '../runtime/driver-messages';
import { getTellaskKindLabel } from '../runtime/tellask-labels';
import { getWorkLanguage } from '../runtime/work-language';
import type { Reminder, ReminderOwner, ReminderUpdateResult } from '../tool';

type ActiveCalleeDispatchView = Readonly<{
  sideDialogId: string;
  latestActivityAt: string;
  mentionList?: string[];
  tellaskContent: string;
  targetAgentId: string;
  callId: string;
  callType: 'A' | 'B' | 'C';
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  sessionSlug?: string;
}>;

type PendingTellaskReminderMeta = Readonly<{
  kind: 'pending_tellask';
  pendingCount: number;
  pendingSignature: string;
  updatedAt: string;
  update: Readonly<{
    altInstruction: string;
  }>;
  delete?: Readonly<{
    altInstruction: string;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPendingTellaskReminderMeta(value: unknown): value is PendingTellaskReminderMeta {
  if (!isRecord(value)) return false;
  if (value.kind !== 'pending_tellask') return false;
  if (typeof value.pendingCount !== 'number') return false;
  if (typeof value.pendingSignature !== 'string') return false;
  if (typeof value.updatedAt !== 'string') return false;
  const update = value.update;
  if (!isRecord(update)) return false;
  if (typeof update.altInstruction !== 'string' || update.altInstruction.trim() === '')
    return false;
  const del = value.delete;
  if (
    del !== undefined &&
    (!isRecord(del) || typeof del.altInstruction !== 'string' || del.altInstruction.trim() === '')
  ) {
    return false;
  }
  return true;
}

function getPendingTellaskUpdateAltInstruction(language: LanguageCode): string {
  return language === 'zh'
    ? '我不手改这条系统提醒。诉请更改规则：同一路长线诉请要改要求时，我复用同一 `sessionSlug` 再发 `tellask`；`tellaskSessionless` 是另一件一次性独立任务，不能改旧任务，也不能要求旧任务停止。其它情况我等待系统按真实诉请状态自动刷新。'
    : 'I do not hand-edit this system reminder. To change a sessioned task, I send another `tellask` with the same `sessionSlug`; `tellaskSessionless` is another one-shot independent task, so it cannot change or stop an earlier task. Otherwise I wait for system refresh from real tellask state.';
}

function getPendingTellaskDeleteAltInstruction(language: LanguageCode): string {
  return language === 'zh'
    ? '我不能删除这条系统提醒。诉请更改规则：同一路长线诉请要改要求时，我复用同一 `sessionSlug` 再发 `tellask`；`tellaskSessionless` 是另一件一次性独立任务，不能改旧任务，也不能要求旧任务停止。其它情况我等待系统按真实诉请状态自动刷新。'
    : 'I cannot delete this system reminder. To change a sessioned task, I send another `tellask` with the same `sessionSlug`; `tellaskSessionless` is another one-shot independent task, so it cannot change or stop an earlier task. Otherwise I wait for system refresh from real tellask state.';
}

function callKindLabel(language: LanguageCode, view: ActiveCalleeDispatchView): string {
  if (view.callType === 'A') {
    return getTellaskKindLabel({ language, name: 'tellaskBack' });
  }

  return getTellaskKindLabel({ language, name: view.callName });
}

function activeCalleeTargetLabel(language: LanguageCode, view: ActiveCalleeDispatchView): string {
  if (view.callType === 'A') {
    return language === 'zh' ? `诉请者 @${view.targetAgentId}` : `tellasker @${view.targetAgentId}`;
  }

  switch (view.callName) {
    case 'freshBootsReasoning':
      return language === 'zh' ? '本对话自身' : 'this dialog itself';
    case 'tellask':
    case 'tellaskSessionless':
      return `@${view.targetAgentId}`;
  }
}

function summarizeTellask(view: ActiveCalleeDispatchView): string {
  const mentionPrefix = Array.isArray(view.mentionList) ? view.mentionList.join(' ') : '';
  const normalized = `${mentionPrefix} ${view.tellaskContent}`.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty tellask)';
  const max = 140;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}...`;
}

function makePendingSignature(pending: ReadonlyArray<ActiveCalleeDispatchView>): string {
  return pending
    .map((p) =>
      [
        p.sideDialogId,
        p.targetAgentId,
        p.callType,
        p.callId,
        p.sessionSlug ?? '',
        summarizeTellask(p),
      ].join('|'),
    )
    .sort()
    .join('||');
}

function buildReminderMeta(
  pending: ReadonlyArray<ActiveCalleeDispatchView>,
  previousMeta?: PendingTellaskReminderMeta,
): PendingTellaskReminderMeta {
  const language = getWorkLanguage();
  const latestActivityAt =
    pending.length === 0
      ? previousMeta?.pendingCount === 0
        ? previousMeta.updatedAt
        : formatUnifiedTimestamp(new Date())
      : pending.reduce(
          (latest, entry) => (entry.latestActivityAt > latest ? entry.latestActivityAt : latest),
          pending[0]?.latestActivityAt ?? formatUnifiedTimestamp(new Date()),
        );
  const deleteMeta =
    pending.length === 0
      ? {}
      : {
          delete: {
            altInstruction: getPendingTellaskDeleteAltInstruction(language),
          },
        };
  return {
    kind: 'pending_tellask',
    pendingCount: pending.length,
    pendingSignature: makePendingSignature(pending),
    updatedAt: latestActivityAt,
    update: {
      altInstruction: getPendingTellaskUpdateAltInstruction(language),
    },
    ...deleteMeta,
  };
}

function buildReminderContent(
  language: LanguageCode,
  pending: ReadonlyArray<ActiveCalleeDispatchView>,
): string {
  const heading =
    language === 'zh'
      ? `⏳ 进行中诉请（共 ${pending.length} 路，自动维护）`
      : `⏳ In-flight Tellasks (${pending.length} total, auto-maintained)`;

  if (pending.length === 0) {
    const noneRunningText =
      language === 'zh'
        ? '当前没有任何执行中的诉请，没有其祂智能体仍在后台工作，任何“等待”想法和行为都是错误的。该提醒项只是系统状态窗；后续需要推进时，只能直接执行下一步本地动作，或发起新的诉请。'
        : 'There are no in-flight Tellasks, and no other agents are still working in the background. Any “wait” thought or behavior is wrong. This reminder is only a system status window; to continue later, take the next local action directly or issue a new Tellask.';
    return [heading, '', noneRunningText].join('\n');
  }

  const summary =
    language === 'zh'
      ? '以下诉请仍在执行中；除这些条目外，当前没有其它仍在执行中的诉请。该提醒项只是系统状态窗，不是控制面。不要把智能体队友当成真人同事：同一个队友可以同时做多件独立任务。'
      : 'Only the Tellasks listed below are still in flight; besides them, no other Tellasks are currently executing. This reminder is only a system status window, not a control surface. Do not treat an agent teammate like a human coworker who can only handle one conversation at a time: the same teammate can work on several independent tasks at once.';

  const lines = pending.map((p, idx) => {
    const base =
      language === 'zh'
        ? `${idx + 1}. ${activeCalleeTargetLabel(language, p)} | ${callKindLabel(language, p)} | ${summarizeTellask(p)}`
        : `${idx + 1}. ${activeCalleeTargetLabel(language, p)} | ${callKindLabel(language, p)} | ${summarizeTellask(p)}`;
    if (!p.sessionSlug) return base;
    return language === 'zh'
      ? `${base} | 会话: ${p.sessionSlug}`
      : `${base} | session: ${p.sessionSlug}`;
  });

  const detailList = lines.join('\n\n');
  return [heading, '', summary, '', detailList].join('\n');
}

function findOwnedReminderIndices(dlg: Dialog): number[] {
  const indices: number[] = [];
  for (let i = 0; i < dlg.reminders.length; i++) {
    if (dlg.reminders[i]?.owner === pendingTellaskReminderOwner) {
      indices.push(i);
    }
  }
  return indices;
}

function assertSingleOwnedReminder(dlg: Dialog): number | null {
  const indices = findOwnedReminderIndices(dlg);
  if (indices.length === 0) return null;
  if (indices.length === 1) return indices[0] ?? null;
  throw new Error(
    `pendingTellask reminder invariant violated: expected <=1 owner reminder, got ${indices.length} (dialog=${dlg.id.valueOf()})`,
  );
}

async function loadActiveCalleeDispatchView(dlg: Dialog): Promise<ActiveCalleeDispatchView[]> {
  const pending = await DialogPersistence.loadActiveCalleeDispatches(dlg.id, dlg.status);
  return await Promise.all(
    pending.map(async (p) => {
      const sideDialogId = new DialogID(p.calleeDialogId, dlg.id.rootId);
      const latest = await DialogPersistence.loadDialogLatest(sideDialogId, dlg.status);
      return {
        sideDialogId: p.calleeDialogId,
        latestActivityAt: latest?.lastModified ?? p.createdAt,
        mentionList: p.mentionList,
        tellaskContent: p.tellaskContent,
        targetAgentId: p.targetAgentId,
        callId: p.callId,
        callType: p.callType,
        callName: p.callName,
        sessionSlug: p.sessionSlug,
      };
    }),
  );
}

async function withDialogLockIfNeeded<T>(dlg: Dialog, fn: () => Promise<T>): Promise<T> {
  if (dlg.isLocked()) {
    return await fn();
  }
  return await dlg.withLock(fn);
}

export async function syncPendingTellaskReminderState(dlg: Dialog): Promise<boolean> {
  const pending = await loadActiveCalleeDispatchView(dlg);
  return await withDialogLockIfNeeded(dlg, async () => {
    const reminderIndex = assertSingleOwnedReminder(dlg);
    const language = getWorkLanguage();
    const content = buildReminderContent(language, pending);
    const currentReminder = reminderIndex === null ? undefined : dlg.reminders[reminderIndex];
    const currentMeta = isPendingTellaskReminderMeta(currentReminder?.meta)
      ? currentReminder.meta
      : undefined;
    const nextMeta = buildReminderMeta(pending, currentMeta);

    if (reminderIndex === null) {
      if (pending.length === 0) {
        return false;
      }
      dlg.addReminder(content, pendingTellaskReminderOwner, nextMeta, 0, {
        scope: 'dialog',
        renderMode: 'markdown',
      });
      return true;
    }

    const current = dlg.reminders[reminderIndex];
    const persistedMeta = current?.meta;
    const unchanged =
      current?.content === content &&
      isPendingTellaskReminderMeta(persistedMeta) &&
      persistedMeta.pendingSignature === nextMeta.pendingSignature &&
      persistedMeta.pendingCount === nextMeta.pendingCount &&
      persistedMeta.updatedAt === nextMeta.updatedAt;

    if (unchanged) return false;

    dlg.updateReminder(reminderIndex, content, nextMeta, { renderMode: 'markdown' });
    return true;
  });
}

export const pendingTellaskReminderOwner: ReminderOwner = {
  name: 'pendingTellask',
  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== pendingTellaskReminderOwner) {
      return { treatment: 'keep' };
    }

    const pending = await loadActiveCalleeDispatchView(dlg);

    const language = getWorkLanguage();
    const updatedContent = buildReminderContent(language, pending);
    const currentMeta = isPendingTellaskReminderMeta(reminder.meta) ? reminder.meta : undefined;
    const updatedMeta = buildReminderMeta(pending, currentMeta);

    const unchanged =
      reminder.content === updatedContent &&
      isPendingTellaskReminderMeta(reminder.meta) &&
      reminder.meta.pendingSignature === updatedMeta.pendingSignature &&
      reminder.meta.pendingCount === updatedMeta.pendingCount &&
      reminder.meta.updatedAt === updatedMeta.updatedAt;

    if (unchanged) {
      return { treatment: 'keep' };
    }
    return { treatment: 'update', updatedContent, updatedMeta };
  },

  async renderReminder(_dlg: Dialog, reminder: Reminder): Promise<ChatMessage> {
    const language = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(language);
    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `${prefix} 自动维护诉请状态提醒 [${reminder.id}]\n这是系统自动维护的诉请状态，不是你自己写的工作便签。${formatAutoMaintainedReminderManualMirrorBan(language)}\n\n${reminder.content}`
          : `${prefix} Auto-maintained tellask status reminder [${reminder.id}]\nThis is system-maintained tellask state, not a work note you wrote. ${formatAutoMaintainedReminderManualMirrorBan(language)}\n\n${reminder.content}`,
    };
  },
};
