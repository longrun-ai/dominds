import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { DialogPersistence } from '../persistence';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { getWorkLanguage } from '../runtime/work-language';
import type { Reminder, ReminderOwner, ReminderUpdateResult } from '../tool';

type PendingSubdialogView = Readonly<{
  subdialogId: string;
  mentionList?: string[];
  tellaskContent: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  sessionSlug?: string;
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

function callKindLabel(language: LanguageCode, view: PendingSubdialogView): string {
  if (view.callType === 'A') {
    return language === 'zh' ? '回问诉请' : 'TellaskBack';
  }

  if (language === 'zh') {
    switch (view.callName) {
      case 'tellask':
        return '长线诉请';
      case 'tellaskSessionless':
        return '一次性诉请';
      case 'freshBootsReasoning':
        return '扪心自问（FBR）';
    }
  }

  switch (view.callName) {
    case 'tellask':
      return 'Tellask Session';
    case 'tellaskSessionless':
      return 'Fresh Tellask';
    case 'freshBootsReasoning':
      return 'Fresh Boots Reasoning (FBR)';
  }
}

function pendingTargetLabel(language: LanguageCode, view: PendingSubdialogView): string {
  if (view.callType === 'A') {
    return language === 'zh'
      ? `上游诉请者 @${view.targetAgentId}`
      : `upstream requester @${view.targetAgentId}`;
  }

  switch (view.callName) {
    case 'freshBootsReasoning':
      return language === 'zh' ? '本对话自身' : 'this dialog itself';
    case 'tellask':
    case 'tellaskSessionless':
      return `@${view.targetAgentId}`;
  }
}

function summarizeTellask(view: PendingSubdialogView): string {
  const mentionPrefix = Array.isArray(view.mentionList) ? view.mentionList.join(' ') : '';
  const normalized = `${mentionPrefix} ${view.tellaskContent}`.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty tellask)';
  const max = 140;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}...`;
}

function makePendingSignature(pending: ReadonlyArray<PendingSubdialogView>): string {
  return pending
    .map((p) =>
      [p.subdialogId, p.targetAgentId, p.callType, p.sessionSlug ?? '', summarizeTellask(p)].join(
        '|',
      ),
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
    language === 'zh'
      ? `⏳ 进行中诉请（共 ${pending.length} 路，自动添加，手动删除）`
      : `⏳ In-flight Tellasks (${pending.length} total, auto-added, manually deleted)`;

  if (pending.length === 0) {
    const noneRunningText =
      language === 'zh'
        ? '当前没有任何执行中的诉请，没有其祂智能体仍在后台工作，任何 “等待” 想法和行为都是错误的；若你删除后该提醒项未再次出现，也同样表示当前无可等待事项。若已明确知晓，可删除此提醒项以免碍眼。'
        : 'There are no in-flight Tellasks, and no other agents are still working in the background. Any “wait” thought or behavior is wrong. If this reminder does not reappear after deletion, it likewise means there is nothing to wait for. If you clearly know this, delete this reminder to reduce noise.';
    return [heading, '', noneRunningText].join('\n');
  }

  const summary =
    language === 'zh'
      ? '以下诉请仍在执行中；除这些条目外，当前没有其它仍在执行中的诉请。此提醒会自动添加与刷新，但不会自动删除。'
      : 'Only the Tellasks listed below are still in flight; besides them, no other Tellasks are currently executing. This reminder is auto-added/refreshed and not auto-deleted.';

  const lines = pending.map((p, idx) => {
    const base =
      language === 'zh'
        ? `${idx + 1}. ${pendingTargetLabel(language, p)} | ${callKindLabel(language, p)} | ${summarizeTellask(p)}`
        : `${idx + 1}. ${pendingTargetLabel(language, p)} | ${callKindLabel(language, p)} | ${summarizeTellask(p)}`;
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

async function loadPendingSubdialogView(dlg: Dialog): Promise<PendingSubdialogView[]> {
  const pending = await DialogPersistence.loadPendingSubdialogs(dlg.id, dlg.status);
  return pending.map((p) => ({
    subdialogId: p.subdialogId,
    mentionList: p.mentionList,
    tellaskContent: p.tellaskContent,
    targetAgentId: p.targetAgentId,
    callType: p.callType,
    callName: p.callName,
    sessionSlug: p.sessionSlug,
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
    const content = buildReminderContent(language, pending);
    const nextMeta = buildReminderMeta(pending);

    if (reminderIndex === null) {
      if (pending.length === 0) {
        return false;
      }
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
    const language = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(language);
    if (reminder.owner !== pendingTellaskReminderOwner) {
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `${prefix} 自动维护诉请状态提醒 #${index + 1}\n你正在查看系统自动维护的诉请状态，不要把它当成你自己写的工作便签。\n\n${reminder.content}`
            : `${prefix} Auto-maintained tellask status reminder #${index + 1}\nYou are looking at system-maintained tellask state. Do not treat it as a self-authored work note.\n\n${reminder.content}`,
      };
    }
    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `${prefix} 自动维护诉请状态提醒 #${index + 1}\n你正在查看系统自动维护的诉请状态，不要把它当成你自己写的工作便签。\n\n${reminder.content}`
          : `${prefix} Auto-maintained tellask status reminder #${index + 1}\nYou are looking at system-maintained tellask state. Do not treat it as a self-authored work note.\n\n${reminder.content}`,
    };
  },
};
