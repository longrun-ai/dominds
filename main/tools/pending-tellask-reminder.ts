import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { DialogPersistence } from '../persistence';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Reminder, ReminderOwner, ReminderUpdateResult } from '../tool';

type PendingSubdialogView = Readonly<{
  subdialogId: string;
  tellaskHead: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  tellaskSession?: string;
}>;

type PendingTellaskReminderMeta = Readonly<{
  kind: 'pending_tellask';
  pendingCount: number;
  pendingSignature: string;
  updatedAt: string;
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
  return true;
}

function callTypeLabel(language: LanguageCode, callType: 'A' | 'B' | 'C'): string {
  if (language === 'zh') {
    if (callType === 'A') return '回问诉请';
    if (callType === 'B') return '长线诉请';
    return '一次性诉请';
  }
  if (callType === 'A') return 'TellaskBack';
  if (callType === 'B') return 'Tellask Session';
  return 'Fresh Tellask';
}

function summarizeTellaskHead(tellaskHead: string): string {
  const normalized = tellaskHead.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty tellaskHead)';
  const max = 140;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}...`;
}

function makePendingSignature(pending: ReadonlyArray<PendingSubdialogView>): string {
  return pending
    .map((p) =>
      [
        p.subdialogId,
        p.targetAgentId,
        p.callType,
        p.tellaskSession ?? '',
        summarizeTellaskHead(p.tellaskHead),
      ].join('|'),
    )
    .sort()
    .join('||');
}

function buildReminderMeta(
  pending: ReadonlyArray<PendingSubdialogView>,
): PendingTellaskReminderMeta {
  return {
    kind: 'pending_tellask',
    pendingCount: pending.length,
    pendingSignature: makePendingSignature(pending),
    updatedAt: formatUnifiedTimestamp(new Date()),
  };
}

function buildReminderContent(
  language: LanguageCode,
  pending: ReadonlyArray<PendingSubdialogView>,
): string {
  const heading =
    language === 'zh' ? '⏳ 进行中诉请（自动维护）' : '⏳ In-flight Tellasks (auto-managed)';
  const summary =
    language === 'zh'
      ? '以下诉请仍在执行中；除这些条目外，当前没有其它仍在执行中的诉请。'
      : 'Only the Tellasks listed below are still in flight; besides them, no other Tellasks are currently executing.';

  const lines = pending.map((p, idx) => {
    const base =
      language === 'zh'
        ? `${idx + 1}. @${p.targetAgentId} | ${callTypeLabel(language, p.callType)} | ${summarizeTellaskHead(p.tellaskHead)}`
        : `${idx + 1}. @${p.targetAgentId} | ${callTypeLabel(language, p.callType)} | ${summarizeTellaskHead(p.tellaskHead)}`;
    if (!p.tellaskSession) return base;
    return language === 'zh'
      ? `${base} | 会话: ${p.tellaskSession}`
      : `${base} | session: ${p.tellaskSession}`;
  });

  return [heading, '', summary, '', ...lines].join('\n');
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

async function loadPendingSubdialogView(dlg: Dialog): Promise<PendingSubdialogView[]> {
  const pending = await DialogPersistence.loadPendingSubdialogs(dlg.id, dlg.status);
  return pending.map((p) => ({
    subdialogId: p.subdialogId,
    tellaskHead: p.tellaskHead,
    targetAgentId: p.targetAgentId,
    callType: p.callType,
    tellaskSession: p.tellaskSession,
  }));
}

async function withDialogLockIfNeeded<T>(dlg: Dialog, fn: () => Promise<T>): Promise<T> {
  if (dlg.isLocked()) {
    return await fn();
  }
  return await dlg.withLock(fn);
}

export async function syncPendingTellaskReminderState(dlg: Dialog): Promise<boolean> {
  const pending = await loadPendingSubdialogView(dlg);
  return await withDialogLockIfNeeded(dlg, async () => {
    const reminderIndex = assertSingleOwnedReminder(dlg);
    const language = getWorkLanguage();

    if (pending.length === 0) {
      if (reminderIndex === null) return false;
      dlg.deleteReminder(reminderIndex);
      return true;
    }

    const content = buildReminderContent(language, pending);
    const nextMeta = buildReminderMeta(pending);

    if (reminderIndex === null) {
      dlg.addReminder(content, pendingTellaskReminderOwner, nextMeta, 0);
      return true;
    }

    const current = dlg.reminders[reminderIndex];
    const currentMeta = current?.meta;
    const unchanged =
      current?.content === content &&
      isPendingTellaskReminderMeta(currentMeta) &&
      currentMeta.pendingSignature === nextMeta.pendingSignature &&
      currentMeta.pendingCount === nextMeta.pendingCount;

    if (unchanged) return false;

    dlg.updateReminder(reminderIndex, content, nextMeta);
    return true;
  });
}

export const pendingTellaskReminderOwner: ReminderOwner = {
  name: 'pendingTellask',
  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== pendingTellaskReminderOwner) {
      return { treatment: 'keep' };
    }

    const pending = await loadPendingSubdialogView(dlg);
    if (pending.length === 0) {
      return { treatment: 'drop' };
    }

    const language = getWorkLanguage();
    const updatedContent = buildReminderContent(language, pending);
    const updatedMeta = buildReminderMeta(pending);

    const unchanged =
      reminder.content === updatedContent &&
      isPendingTellaskReminderMeta(reminder.meta) &&
      reminder.meta.pendingSignature === updatedMeta.pendingSignature &&
      reminder.meta.pendingCount === updatedMeta.pendingCount;

    if (unchanged) {
      return { treatment: 'keep' };
    }
    return { treatment: 'update', updatedContent, updatedMeta };
  },

  async renderReminder(_dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage> {
    if (reminder.owner !== pendingTellaskReminderOwner) {
      const language = getWorkLanguage();
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content:
          language === 'zh'
            ? `系统提醒 #${index + 1}\n\n${reminder.content}`
            : `System reminder #${index + 1}\n\n${reminder.content}`,
      };
    }
    return {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: reminder.content,
    };
  },
};
