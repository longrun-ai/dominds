import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { DialogPersistence } from '../persistence';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { getTellaskKindLabel } from '../runtime/tellask-labels';
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
    ? '不要手改这条系统提醒。若要改变某一路诉请，只有长线诉请（`tellask` + `sessionSlug`）才能更新那一路诉请的“任务安排”：复用同一 `sessionSlug` 再发 `tellask`，让对应主理人按最新安排自行最终回复并自然结束。一次性诉请（`tellaskSessionless`）没有这个通道；新开一个 `tellaskSessionless` 只会再创建新的瞬态支线，不能要求旧主理人停止。其余情况等待系统按真实诉请状态自动刷新。'
    : 'Do not hand-edit this system reminder. If you need to change one tellask, only a sessioned tellask (`tellask` + `sessionSlug`) can be updated in place: send another `tellask` with the same `sessionSlug` so the responder can finish naturally under the latest assignment. A one-shot tellask (`tellaskSessionless`) has no such channel; another `tellaskSessionless` only creates a new transient sideline and cannot tell the earlier owner to stop. Otherwise wait for system refresh from real tellask state.';
}

function getPendingTellaskDeleteAltInstruction(language: LanguageCode): string {
  return language === 'zh'
    ? '这条系统提醒不可删除。若要改变某一路诉请，只有长线诉请（`tellask` + `sessionSlug`）才能更新那一路诉请的“任务安排”：复用同一 `sessionSlug` 再发 `tellask`，让对应主理人按最新安排自行最终回复并自然结束。一次性诉请（`tellaskSessionless`）没有这个通道；新开一个 `tellaskSessionless` 只会再创建新的瞬态支线，不能要求旧主理人停止。其余情况等待系统按真实诉请状态自动刷新。'
    : 'This system reminder is not deletable. If you need to change one tellask, only a sessioned tellask (`tellask` + `sessionSlug`) can be updated in place: send another `tellask` with the same `sessionSlug` so the responder can finish naturally under the latest assignment. A one-shot tellask (`tellaskSessionless`) has no such channel; another `tellaskSessionless` only creates a new transient sideline and cannot tell the earlier owner to stop. Otherwise wait for system refresh from real tellask state.';
}

function callKindLabel(language: LanguageCode, view: PendingSubdialogView): string {
  if (view.callType === 'A') {
    return getTellaskKindLabel({ language, name: 'tellaskBack' });
  }

  return getTellaskKindLabel({ language, name: view.callName });
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
  const language = getWorkLanguage();
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
    updatedAt: formatUnifiedTimestamp(new Date()),
    update: {
      altInstruction: getPendingTellaskUpdateAltInstruction(language),
    },
    ...deleteMeta,
  };
}

function buildReminderContent(
  language: LanguageCode,
  pending: ReadonlyArray<PendingSubdialogView>,
): string {
  const heading =
    language === 'zh'
      ? `⏳ 进行中诉请（共 ${pending.length} 路，自动维护${pending.length === 0 ? '，0 路时可手动删除' : '，进行中不可删除'}）`
      : `⏳ In-flight Tellasks (${pending.length} total, auto-maintained${pending.length === 0 ? ', deletable only at zero in-flight' : ', non-deletable while active'})`;

  if (pending.length === 0) {
    const noneRunningText =
      language === 'zh'
        ? '当前没有任何执行中的诉请，没有其祂智能体仍在后台工作，任何“等待”想法和行为都是错误的。该提醒项仍是系统状态窗，内容不可手改；但因为当前为 0 路进行中，若你已明确知晓这一点，可手动删除以免碍眼。后续需要推进时，只能直接执行下一步本地动作，或发起新的诉请。'
        : 'There are no in-flight Tellasks, and no other agents are still working in the background. Any “wait” thought or behavior is wrong. This reminder is still a system status window and its content must not be hand-edited; however, because there are currently zero in-flight Tellasks, you may delete it manually once you are sure. To continue later, take the next local action directly or issue a new Tellask.';
    return [heading, '', noneRunningText].join('\n');
  }

  const summary =
    language === 'zh'
      ? '以下诉请仍在执行中；除这些条目外，当前没有其它仍在执行中的诉请。该提醒项只是系统状态窗，不是控制面：自动维护、不可手改，且在非 0 路进行中时不可删除。只有长线诉请（`tellask` + `sessionSlug`）才能更新“任务安排”；一次性诉请（`tellaskSessionless`）没有这个通道。新开一个 `tellaskSessionless` 只会再创建新的瞬态支线，不会影响旧支线继续执行，更不能要求旧主理人停止。若某一路长线诉请的要求变化，才可复用同一 `sessionSlug` 再发 `tellask`，让对应主理人按最新安排自行最终回复并自然结束。误删会被拒绝，并返回同样的引导文案。'
      : 'Only the Tellasks listed below are still in flight; besides them, no other Tellasks are currently executing. This reminder is only a system status window, not a control surface: auto-maintained, not hand-editable, and non-deletable while any tellask is still active. Only a sessioned tellask (`tellask` + `sessionSlug`) has an assignment-update channel; a one-shot tellask (`tellaskSessionless`) does not. Opening another `tellaskSessionless` only creates another transient sideline; it does not affect the earlier one and cannot tell the earlier owner to stop. If a sessioned tellask needs to change, reuse the same `sessionSlug` in another `tellask` so the responder can finish naturally under the latest assignment. Mistaken deletion will be rejected with the same guidance.';

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

  async renderReminder(_dlg: Dialog, reminder: Reminder): Promise<ChatMessage> {
    const language = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(language);
    if (reminder.owner !== pendingTellaskReminderOwner) {
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `${prefix} 自动维护诉请状态提醒 [${reminder.id}]\n你正在查看系统自动维护的诉请状态，不要把它当成你自己写的工作便签。\n\n${reminder.content}`
            : `${prefix} Auto-maintained tellask status reminder [${reminder.id}]\nYou are looking at system-maintained tellask state. Do not treat it as a self-authored work note.\n\n${reminder.content}`,
      };
    }
    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `${prefix} 自动维护诉请状态提醒 [${reminder.id}]\n你正在查看系统自动维护的诉请状态，不要把它当成你自己写的工作便签。\n\n${reminder.content}`
          : `${prefix} Auto-maintained tellask status reminder [${reminder.id}]\nYou are looking at system-maintained tellask state. Do not treat it as a self-authored work note.\n\n${reminder.content}`,
    };
  },
};
