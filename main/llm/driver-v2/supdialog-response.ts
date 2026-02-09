import { Dialog, DialogID, RootDialog, SubDialog } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { getWorkLanguage } from '../../shared/runtime-language';
import { generateShortId } from '../../shared/utils/id';
import { formatTeammateResponseContent } from '../../shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from '../../shared/utils/time';
import { syncPendingTellaskReminderState } from '../../tools/pending-tellask-reminder';
import type { ChatMessage } from '../client';
import { withSubdialogTxnLock } from './subdialog-txn';

export type SubdialogReplyTarget = {
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
};

export type ScheduleDriveFn = (
  dialog: Dialog,
  options: {
    humanPrompt?: {
      content: string;
      msgId: string;
      grammar: 'markdown' | 'tellask';
      userLanguageCode?: 'zh' | 'en';
      origin?: 'user' | 'diligence_push';
      skipTaskdoc?: boolean;
      persistMode?: 'persist' | 'internal';
      subdialogReplyTarget?: SubdialogReplyTarget;
    };
    waitInQue: boolean;
    driveOptions?: { suppressDiligencePush?: boolean };
  },
) => void;

async function syncPendingTellaskReminderBestEffort(dlg: Dialog, where: string): Promise<void> {
  try {
    const changed = await syncPendingTellaskReminderState(dlg);
    if (!changed) return;
    await dlg.processReminderUpdates();
  } catch (err) {
    log.warn('Failed to sync pending tellask reminder', {
      where,
      dialogId: dlg.id.selfId,
      rootId: dlg.id.rootId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resolveOwnerDialogBySelfId(
  subdialog: SubDialog,
  ownerDialogId: string,
): Promise<Dialog | undefined> {
  const rootDialog = subdialog.rootDialog;
  if (ownerDialogId === rootDialog.id.selfId) {
    return rootDialog;
  }
  const existing = rootDialog.lookupDialog(ownerDialogId);
  if (existing) return existing;
  return await ensureDialogLoaded(
    rootDialog,
    new DialogID(ownerDialogId, rootDialog.id.rootId),
    'running',
  );
}

export async function supplyResponseToSupdialogV2(args: {
  parentDialog: Dialog;
  subdialogId: DialogID;
  responseText: string;
  callType: 'A' | 'B' | 'C';
  callId?: string;
  status?: 'completed' | 'failed';
  scheduleDrive: ScheduleDriveFn;
}): Promise<void> {
  const {
    parentDialog,
    subdialogId,
    responseText,
    callType,
    callId,
    status = 'completed',
    scheduleDrive,
  } = args;
  try {
    const result = await withSubdialogTxnLock(parentDialog.id, async () => {
      const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(parentDialog.id);
      let pendingRecord:
        | {
            subdialogId: string;
            createdAt: string;
            tellaskHead: string;
            targetAgentId: string;
            callType: 'A' | 'B' | 'C';
            tellaskSession?: string;
          }
        | undefined;
      const filteredPending: typeof pendingSubdialogs = [];
      for (const pending of pendingSubdialogs) {
        if (pending.subdialogId === subdialogId.selfId) {
          pendingRecord = pending;
        } else {
          filteredPending.push(pending);
        }
      }

      let responderId = subdialogId.rootId;
      let responderAgentId: string | undefined;
      let tellaskHead = responseText;
      let originMemberId: string | undefined;

      try {
        let metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'running');
        if (!metadata) {
          metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'completed');
        }
        if (metadata && metadata.assignmentFromSup) {
          originMemberId = metadata.assignmentFromSup.originMemberId;
          if (!pendingRecord) {
            const assignmentHead = metadata.assignmentFromSup.tellaskHead;
            if (typeof assignmentHead === 'string' && assignmentHead.trim() !== '') {
              tellaskHead = assignmentHead;
            }
          }
        }
        if (!pendingRecord && metadata && typeof metadata.agentId === 'string') {
          if (metadata.agentId.trim() !== '') {
            responderId = metadata.agentId;
            responderAgentId = metadata.agentId;
          }
        }
      } catch (err) {
        log.warn('Failed to load subdialog metadata for response record', {
          parentId: parentDialog.id.selfId,
          subdialogId: subdialogId.selfId,
          error: err,
        });
      }

      if (!originMemberId) {
        originMemberId = parentDialog.agentId;
      }

      if (pendingRecord) {
        responderId = pendingRecord.targetAgentId;
        responderAgentId = pendingRecord.targetAgentId;
        tellaskHead = pendingRecord.tellaskHead;
      }

      if (tellaskHead.trim() === '') {
        tellaskHead = responseText.slice(0, 100) + (responseText.length > 100 ? '...' : '');
      }

      const completedAt = formatUnifiedTimestamp(new Date());
      const responseId = generateShortId();
      await DialogPersistence.appendSubdialogResponse(parentDialog.id, {
        responseId,
        subdialogId: subdialogId.selfId,
        response: responseText,
        completedAt,
        status,
        callType,
        tellaskHead,
        responderId,
        originMemberId,
        callId: callId ?? '',
      });

      await DialogPersistence.savePendingSubdialogs(parentDialog.id, filteredPending);

      const hasQ4H = await parentDialog.hasPendingQ4H();
      const shouldRevive = !hasQ4H && filteredPending.length === 0;
      if (shouldRevive && parentDialog instanceof RootDialog) {
        await DialogPersistence.setNeedsDrive(parentDialog.id, true, parentDialog.status);
      }
      return {
        responderId,
        responderAgentId,
        tellaskHead,
        originMemberId,
        shouldRevive,
      };
    });

    await syncPendingTellaskReminderBestEffort(parentDialog, 'driver-v2:supplyResponseToSupdialog');

    await parentDialog.receiveTeammateResponse(
      result.responderId,
      result.tellaskHead,
      status,
      subdialogId,
      {
        response: responseText,
        agentId: result.responderAgentId ?? result.responderId,
        callId: callId ?? '',
        originMemberId: result.originMemberId ?? parentDialog.agentId,
      },
    );

    // Keep in-memory dialog context in sync with live teammate-response events immediately.
    // Without this, tellask_result_msg can appear batched at drive-finalization mirror time.
    const immediateMirror: ChatMessage = {
      type: 'tellask_result_msg',
      role: 'tool',
      responderId: result.responderId,
      tellaskHead: result.tellaskHead,
      status,
      content: formatTeammateResponseContent({
        responderId: result.responderId,
        requesterId: result.originMemberId ?? parentDialog.agentId,
        originalCallHeadLine: result.tellaskHead,
        responseBody: responseText,
        language: getWorkLanguage(),
      }),
    };
    await parentDialog.addChatMessages(immediateMirror);

    if (result.shouldRevive) {
      log.info(
        `All Type ${callType} subdialogs complete, parent ${parentDialog.id.selfId} auto-reviving`,
      );
      if (parentDialog instanceof RootDialog) {
        globalDialogRegistry.markNeedsDrive(parentDialog.id.rootId);
      }
      scheduleDrive(parentDialog, {
        waitInQue: true,
        driveOptions: { suppressDiligencePush: parentDialog.disableDiligencePush },
      });
    }
  } catch (error) {
    log.error('driver-v2 failed to supply subdialog response', {
      parentId: parentDialog.id.selfId,
      subdialogId: subdialogId.selfId,
      error,
    });
    throw error;
  }
}

export async function supplySubdialogResponseToSpecificCallerIfPendingV2(args: {
  subdialog: SubDialog;
  responseText: string;
  target: SubdialogReplyTarget;
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { subdialog, responseText, target, scheduleDrive } = args;
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return false;
  }

  const ownerDialog = await resolveOwnerDialogBySelfId(subdialog, target.ownerDialogId);
  if (!ownerDialog) {
    return false;
  }

  const pending = await DialogPersistence.loadPendingSubdialogs(ownerDialog.id);
  const pendingRecord = pending.find((p) => p.subdialogId === subdialog.id.selfId);
  if (!pendingRecord) {
    return false;
  }
  if (pendingRecord.callType !== target.callType) {
    log.warn('Reply target callType does not match pending callType; skipping stale reply target', {
      rootId: subdialog.rootDialog.id.rootId,
      subdialogId: subdialog.id.selfId,
      ownerDialogId: ownerDialog.id.selfId,
      targetCallType: target.callType,
      pendingCallType: pendingRecord.callType,
    });
    return false;
  }

  await supplyResponseToSupdialogV2({
    parentDialog: ownerDialog,
    subdialogId: subdialog.id,
    responseText,
    callType: pendingRecord.callType,
    callId: target.callId,
    status: 'completed',
    scheduleDrive,
  });
  return true;
}

export async function supplySubdialogResponseToAssignedCallerIfPendingV2(args: {
  subdialog: SubDialog;
  responseText: string;
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { subdialog, responseText, scheduleDrive } = args;
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return false;
  }

  const callerDialog = await resolveOwnerDialogBySelfId(subdialog, assignment.callerDialogId);
  if (!callerDialog) {
    log.warn('Missing caller dialog for subdialog response supply', {
      rootId: subdialog.rootDialog.id.rootId,
      subdialogId: subdialog.id.selfId,
      callerDialogId: assignment.callerDialogId,
    });
    return false;
  }

  const pending = await DialogPersistence.loadPendingSubdialogs(callerDialog.id);
  const pendingRecord = pending.find((p) => p.subdialogId === subdialog.id.selfId);
  if (!pendingRecord) {
    return false;
  }

  await supplyResponseToSupdialogV2({
    parentDialog: callerDialog,
    subdialogId: subdialog.id,
    responseText,
    callType: pendingRecord.callType,
    callId: assignment.callId,
    status: 'completed',
    scheduleDrive,
  });
  return true;
}
