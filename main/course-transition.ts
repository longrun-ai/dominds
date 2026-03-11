import type { Dialog, RootDialog, SubDialog } from './dialog';
import { DialogID } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from './dialog-instance-registry';
import type { ChatMessage } from './llm/client';
import { log } from './log';
import { DialogPersistence } from './persistence';
import { getWorkLanguage } from './shared/runtime-language';
import type { LanguageCode } from './shared/types/language';
import type { PendingSubdialogStateRecord } from './shared/types/storage';
import { formatTeammateResponseContent } from './shared/utils/inter-dialog-format';
import { syncPendingTellaskReminderState } from './tools/pending-tellask-reminder';

type WaitingOwnerRecord = Readonly<{
  ownerDialogId: DialogID;
  pendingRecords: ReadonlyArray<PendingSubdialogStateRecord>;
}>;

export function buildClearedMindInvalidationNotice(language: LanguageCode): string {
  if (language === 'zh') {
    return '系统反馈：诉请对象已清理头脑并开启新一程对话；本轮诉请已失效，请基于最新完整上下文重新诉请祂。';
  }
  return 'System notice: the callee cleared its mind and started a new course; this tellask round is no longer valid. Re-tellask with the latest complete context.';
}

async function loadWaitingOwnerRecords(dialog: Dialog): Promise<WaitingOwnerRecord[]> {
  const allDialogIds = await DialogPersistence.listAllDialogIds('running');
  const results: WaitingOwnerRecord[] = [];
  for (const candidateId of allDialogIds) {
    if (candidateId.rootId !== dialog.id.rootId) {
      continue;
    }
    const pending = await DialogPersistence.loadPendingSubdialogs(candidateId, 'running');
    const matching = pending.filter((record) => record.subdialogId === dialog.id.selfId);
    if (matching.length === 0) {
      continue;
    }
    results.push({
      ownerDialogId: candidateId,
      pendingRecords: matching,
    });
  }
  return results;
}

function resolveOwnerDialogFromCurrentTree(
  currentDialog: Dialog,
  ownerDialogId: string,
): Dialog | undefined {
  if (currentDialog.id.selfId === currentDialog.id.rootId) {
    const rootDialog = currentDialog as RootDialog;
    if (ownerDialogId === rootDialog.id.selfId) {
      return rootDialog;
    }
    return rootDialog.lookupDialog(ownerDialogId);
  }

  // Rationale: in this code path, every non-root dialog is a SubDialog. Prefer the live
  // in-memory root tree first so existing dialog objects receive state/message updates.
  const rootDialog = (currentDialog as SubDialog).rootDialog;
  if (ownerDialogId === rootDialog.id.selfId) {
    return rootDialog;
  }
  return rootDialog.lookupDialog(ownerDialogId);
}

async function resolveOwnerDialog(
  currentDialog: Dialog,
  rootId: string,
  ownerDialogId: DialogID,
): Promise<Dialog | undefined> {
  const live = resolveOwnerDialogFromCurrentTree(currentDialog, ownerDialogId.selfId);
  if (live) {
    return live;
  }

  const rootDialog = await getOrRestoreRootDialog(rootId, 'running');
  if (!rootDialog) {
    return undefined;
  }
  if (ownerDialogId.selfId === rootDialog.id.selfId) {
    return rootDialog;
  }
  return await ensureDialogLoaded(rootDialog, ownerDialogId, 'running');
}

async function syncPendingTellaskReminderOrThrow(ownerDialog: Dialog): Promise<void> {
  const changed = await syncPendingTellaskReminderState(ownerDialog);
  if (!changed) {
    return;
  }
  await ownerDialog.processReminderUpdates();
}

async function reviveOwnerDialogIfReady(ownerDialog: Dialog): Promise<void> {
  const hasQ4H = await ownerDialog.hasPendingQ4H();
  const hasPendingSubdialogs = await ownerDialog.hasPendingSubdialogs();
  if (hasQ4H || hasPendingSubdialogs) {
    return;
  }

  if (ownerDialog.id.selfId === ownerDialog.id.rootId) {
    const hasRegistryEntry = globalDialogRegistry.get(ownerDialog.id.rootId) !== undefined;
    await DialogPersistence.setNeedsDrive(ownerDialog.id, true, ownerDialog.status);
    if (hasRegistryEntry) {
      globalDialogRegistry.markNeedsDrive(ownerDialog.id.rootId, {
        source: 'kernel_driver_supply_response',
        reason: 'callee_cleared_mind_invalidated_pending_waiters',
      });
      return;
    }
  }

  const { driveDialogStream } = await import('./llm/kernel-driver');
  void driveDialogStream(ownerDialog, undefined, true, {
    suppressDiligencePush: ownerDialog.disableDiligencePush,
    source: 'kernel_driver_supply_response_parent_revive',
    reason: 'callee_cleared_mind_invalidated_pending_waiters',
  });
}

export async function notifyWaitingDialogsOfClearedMind(dialog: Dialog): Promise<number> {
  if (dialog.status !== 'running') {
    return 0;
  }

  const waitingOwners = await loadWaitingOwnerRecords(dialog);
  if (waitingOwners.length === 0) {
    return 0;
  }

  const language = getWorkLanguage();
  const responseBody = buildClearedMindInvalidationNotice(language);
  let totalInvalidated = 0;

  for (const owner of waitingOwners) {
    const ownerDialog = await resolveOwnerDialog(dialog, dialog.id.rootId, owner.ownerDialogId);
    if (!ownerDialog) {
      throw new Error(
        `Failed to restore owner dialog while invalidating cleared-mind tellask waiters: root=${dialog.id.rootId} owner=${owner.ownerDialogId.valueOf()} callee=${dialog.id.valueOf()}`,
      );
    }

    const pendingOutcome = await DialogPersistence.mutatePendingSubdialogs(
      ownerDialog.id,
      (previous) => {
        const next = previous.filter((record) => record.subdialogId !== dialog.id.selfId);
        return { kind: 'replace', records: next };
      },
      undefined,
      ownerDialog.status,
    );

    for (const pendingRecord of owner.pendingRecords) {
      const requesterId = ownerDialog.agentId;
      const response = formatTeammateResponseContent({
        callName: pendingRecord.callName,
        responderId: dialog.agentId,
        requesterId,
        mentionList: pendingRecord.mentionList,
        sessionSlug: pendingRecord.sessionSlug,
        tellaskContent: pendingRecord.tellaskContent,
        responseBody,
        status: 'failed',
        language,
      });

      await ownerDialog.receiveTeammateResponse(
        dialog.agentId,
        pendingRecord.callName,
        pendingRecord.mentionList,
        pendingRecord.tellaskContent,
        'failed',
        dialog.id,
        {
          response,
          agentId: dialog.agentId,
          callId: pendingRecord.callId,
          originMemberId: requesterId,
          sessionSlug: pendingRecord.sessionSlug,
        },
      );

      const immediateMirror: ChatMessage = {
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: dialog.agentId,
        mentionList: pendingRecord.mentionList,
        tellaskContent: pendingRecord.tellaskContent,
        status: 'failed',
        callId: pendingRecord.callId,
        content: response,
      };
      await ownerDialog.addChatMessages(immediateMirror);
      totalInvalidated += 1;
    }

    try {
      await syncPendingTellaskReminderOrThrow(ownerDialog);
    } catch (err) {
      log.error('Failed to sync pending-tellask reminder after cleared-mind invalidation', err, {
        rootId: dialog.id.rootId,
        calleeDialogId: dialog.id.selfId,
        ownerDialogId: ownerDialog.id.selfId,
      });
      throw err;
    }

    if (pendingOutcome.records.length === 0) {
      await reviveOwnerDialogIfReady(ownerDialog);
    }
  }

  return totalInvalidated;
}
