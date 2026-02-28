import { Dialog, DialogID, RootDialog, SubDialog } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { ensureDialogLoaded, type DialogPersistenceStatus } from '../../dialog-instance-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { TeammateCallAnchorRecord } from '../../shared/types/storage';
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
      grammar: 'markdown';
      userLanguageCode?: 'zh' | 'en';
      q4hAnswerCallIds?: string[];
      origin?: 'user' | 'diligence_push';
      skipTaskdoc?: boolean;
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
    log.warn('Failed to sync pending tellask reminder', undefined, {
      where,
      dialogId: dlg.id.selfId,
      rootId: dlg.id.rootId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildFbrRelayPayload(subdialog: SubDialog, finalResponseText: string): string {
  const language = subdialog.getLastUserLanguageCode();
  const isZh = language === 'zh';
  const roundSayingMsgs = subdialog.msgs
    .filter((msg): msg is Extract<ChatMessage, { type: 'saying_msg' }> => msg.type === 'saying_msg')
    .map((msg) => msg.content)
    .filter((content) => content.trim() !== '')
    .map((content, idx) => ({
      idx,
      content,
    }));

  if (roundSayingMsgs.length <= 1) {
    return `${finalResponseText}\n\n${buildFbrDistillPrompt(language)}`;
  }

  const roundsText = roundSayingMsgs
    .map(
      (entry) =>
        `### ${isZh ? `FBR 第 ${entry.idx + 1} 轮` : `FBR Round ${entry.idx + 1}`}\n${entry.content}`,
    )
    .join('\n\n');
  const allRoundPayload = isZh
    ? `## FBR 全量回帖（按轮次）\n\n${roundsText}`
    : `## FBR Full Conclusions (by round)\n\n${roundsText}`;
  return `${allRoundPayload}\n\n${buildFbrDistillPrompt(language)}`;
}

function buildFbrDistillPrompt(language: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `## 提示上游：收到全量回帖后请提炼\n\n以上为该次 FBR 的全量结论，包含全部轮次。上游请在收到这条全量回帖后进行综合提炼（distill），形成可执行项与决策后立即执行；若需要人类澄清/授权/决策，立即发起 \`askHuman\`。`;
  }
  return `## Upstream Distill Note\n\nThe text above is the full FBR output for this run, containing all rounds. After receiving this full reply, distill the full set and execute immediately once actionable decisions are formed; if human clarification/authorization/decision is required, issue \`askHuman\` immediately.`;
}

async function resolveOwnerDialogBySelfId(
  subdialog: SubDialog,
  ownerDialogId: string,
): Promise<Dialog | undefined> {
  const rootDialog = subdialog.rootDialog;
  if (!(await ensureDialogFreshOrDiscard(rootDialog, 'resolveOwnerDialogBySelfId:root'))) {
    return undefined;
  }
  if (ownerDialogId === rootDialog.id.selfId) {
    return rootDialog;
  }
  const existing = rootDialog.lookupDialog(ownerDialogId);
  if (existing) {
    if (!(await ensureDialogFreshOrDiscard(existing, 'resolveOwnerDialogBySelfId:lookup'))) {
      return undefined;
    }
    return existing;
  }
  const restored = await ensureDialogLoaded(
    rootDialog,
    new DialogID(ownerDialogId, rootDialog.id.rootId),
    rootDialog.status,
  );
  if (!restored) {
    return undefined;
  }
  if (!(await ensureDialogFreshOrDiscard(restored, 'resolveOwnerDialogBySelfId:restore'))) {
    return undefined;
  }
  return restored;
}

async function ensureDialogFreshOrDiscard(dialog: Dialog, where: string): Promise<boolean> {
  try {
    const metadata = await DialogPersistence.loadDialogMetadata(dialog.id, dialog.status);
    if (metadata) {
      return true;
    }

    const statuses: ReadonlyArray<DialogPersistenceStatus> = ['running', 'completed', 'archived'];
    for (const status of statuses) {
      if (status === dialog.status) {
        continue;
      }
      const other = await DialogPersistence.loadDialogMetadata(dialog.id, status);
      if (other) {
        log.warn(
          'driver-v2 discarding stale dialog object due to persisted status mismatch',
          undefined,
          {
            where,
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
            inMemoryStatus: dialog.status,
            persistedStatus: status,
          },
        );
        if (dialog instanceof RootDialog) {
          globalDialogRegistry.unregister(dialog.id.rootId);
        }
        return false;
      }
    }

    if (dialog instanceof RootDialog && dialog.status === 'running') {
      const createdAt = formatUnifiedTimestamp(new Date());
      await DialogPersistence.saveDialogMetadata(
        dialog.id,
        {
          id: dialog.id.selfId,
          agentId: dialog.agentId,
          taskDocPath: dialog.taskDocPath,
          createdAt,
        },
        'running',
      );
      log.warn('driver-v2 auto-persisted missing root dialog metadata', undefined, {
        where,
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
      });
      return true;
    }
  } catch (err) {
    log.warn('driver-v2 failed to verify dialog freshness against persisted status', undefined, {
      where,
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
      status: dialog.status,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.warn('driver-v2 discarding stale dialog object due to status/path mismatch', undefined, {
    where,
    rootId: dialog.id.rootId,
    selfId: dialog.id.selfId,
    status: dialog.status,
  });
  if (dialog instanceof RootDialog) {
    globalDialogRegistry.unregister(dialog.id.rootId);
  }
  return false;
}

async function resolveLatestAssignmentAnchorRef(args: {
  calleeDialogId: DialogID;
  callId: string;
  status: DialogPersistenceStatus;
}): Promise<{ course: number; genseq: number } | undefined> {
  const normalizedCallId = args.callId.trim();
  if (normalizedCallId === '') {
    return undefined;
  }

  const latest = await DialogPersistence.loadDialogLatest(args.calleeDialogId, args.status);
  if (!latest) {
    return undefined;
  }

  const maxCourse = Math.floor(latest.currentCourse);
  for (let course = maxCourse; course >= 1; course -= 1) {
    const courseEvents = await DialogPersistence.loadCourseEvents(
      args.calleeDialogId,
      course,
      args.status,
    );
    for (let i = courseEvents.length - 1; i >= 0; i -= 1) {
      const event = courseEvents[i];
      if (event.type !== 'teammate_call_anchor_record') {
        continue;
      }
      if (event.anchorRole !== 'assignment') {
        continue;
      }
      if (event.callId.trim() !== normalizedCallId) {
        continue;
      }
      if (!Number.isFinite(event.genseq) || event.genseq <= 0) {
        continue;
      }
      return { course, genseq: Math.floor(event.genseq) };
    }
  }

  return undefined;
}

export async function supplyResponseToSupdialogV2(args: {
  parentDialog: Dialog;
  subdialogId: DialogID;
  responseText: string;
  callType: 'A' | 'B' | 'C';
  callId?: string;
  status?: 'completed' | 'failed';
  calleeResponseRef?: { course: number; genseq: number };
  scheduleDrive: ScheduleDriveFn;
  subdialog?: SubDialog;
}): Promise<void> {
  const {
    parentDialog,
    subdialogId,
    responseText,
    callType,
    callId,
    status = 'completed',
    calleeResponseRef,
    scheduleDrive,
    subdialog: maybeSubdialog,
  } = args;
  try {
    const result = await withSubdialogTxnLock(parentDialog.id, async () => {
      const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(
        parentDialog.id,
        parentDialog.status,
      );
      let pendingRecord:
        | {
            subdialogId: string;
            createdAt: string;
            callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
            mentionList?: string[];
            tellaskContent: string;
            targetAgentId: string;
            callId: string;
            callingCourse?: number;
            callType: 'A' | 'B' | 'C';
            sessionSlug?: string;
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
      let callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning' =
        'tellaskSessionless';
      let mentionList: string[] | undefined;
      let tellaskContent = responseText;
      let originMemberId: string | undefined;
      let sessionSlug: string | undefined;

      try {
        const metadata = await DialogPersistence.loadDialogMetadata(
          subdialogId,
          parentDialog.status,
        );
        if (metadata && metadata.assignmentFromSup) {
          originMemberId = metadata.assignmentFromSup.originMemberId;
          if (!pendingRecord) {
            callName = metadata.assignmentFromSup.callName;
            mentionList = metadata.assignmentFromSup.mentionList;
            tellaskContent = metadata.assignmentFromSup.tellaskContent;
          }
        }
        if (!pendingRecord && metadata && typeof metadata.agentId === 'string') {
          if (metadata.agentId.trim() !== '') {
            responderId = metadata.agentId;
            responderAgentId = metadata.agentId;
          }
        }
      } catch (err) {
        log.warn('Failed to load subdialog metadata for response record', undefined, {
          parentId: parentDialog.id.selfId,
          subdialogId: subdialogId.selfId,
          error: err,
        });
      }

      if (!originMemberId) {
        originMemberId = parentDialog.agentId;
      }

      if (pendingRecord) {
        callName = pendingRecord.callName;
        responderId = pendingRecord.targetAgentId;
        responderAgentId = pendingRecord.targetAgentId;
        mentionList = pendingRecord.mentionList;
        tellaskContent = pendingRecord.tellaskContent;
        sessionSlug = pendingRecord.sessionSlug;
      }

      if (
        (callName === 'tellask' || callName === 'tellaskSessionless') &&
        (!Array.isArray(mentionList) || mentionList.length < 1)
      ) {
        mentionList = [`@${responderId}`];
      }

      await DialogPersistence.savePendingSubdialogs(
        parentDialog.id,
        filteredPending,
        parentDialog.status,
      );

      const hasQ4H = await parentDialog.hasPendingQ4H();
      const shouldRevive = !hasQ4H && filteredPending.length === 0;
      if (shouldRevive && parentDialog instanceof RootDialog) {
        await DialogPersistence.setNeedsDrive(parentDialog.id, true, parentDialog.status);
      }
      return {
        responderId,
        responderAgentId,
        callName,
        mentionList,
        tellaskContent,
        originMemberId,
        sessionSlug,
        callId: pendingRecord?.callId,
        callingCourse:
          pendingRecord &&
          typeof pendingRecord.callingCourse === 'number' &&
          Number.isFinite(pendingRecord.callingCourse) &&
          pendingRecord.callingCourse > 0
            ? Math.floor(pendingRecord.callingCourse)
            : undefined,
        shouldRevive,
      };
    });

    const normalizedCallId = typeof callId === 'string' ? callId.trim() : '';
    const fallbackCallId = typeof result.callId === 'string' ? result.callId.trim() : '';
    const resolvedCallId = normalizedCallId !== '' ? normalizedCallId : fallbackCallId;
    const rootForLookup =
      parentDialog instanceof RootDialog
        ? parentDialog
        : parentDialog instanceof SubDialog
          ? parentDialog.rootDialog
          : undefined;
    const resolvedSubdialog =
      maybeSubdialog ?? (rootForLookup?.lookupDialog(subdialogId.selfId) as SubDialog | undefined);
    const shouldReportFbrUpstream =
      callType === 'C' &&
      result.callName === 'freshBootsReasoning' &&
      resolvedSubdialog !== undefined;
    const upstreamResponseBody = shouldReportFbrUpstream
      ? buildFbrRelayPayload(resolvedSubdialog, responseText)
      : responseText;
    const requesterId = result.originMemberId ?? parentDialog.agentId;
    const upstreamResponseText = formatTeammateResponseContent({
      callName: result.callName,
      responderId: result.responderId,
      requesterId,
      mentionList: result.mentionList,
      sessionSlug: result.sessionSlug,
      tellaskContent: result.tellaskContent,
      responseBody: upstreamResponseBody,
      status,
      language: getWorkLanguage(),
    });
    if (resolvedCallId !== '' && calleeResponseRef) {
      const assignmentRef = await resolveLatestAssignmentAnchorRef({
        calleeDialogId: subdialogId,
        callId: resolvedCallId,
        status: parentDialog.status,
      });
      if (!assignmentRef) {
        log.error('Missing assignment anchor for teammate response anchor', undefined, {
          parentId: parentDialog.id.selfId,
          subdialogId: subdialogId.selfId,
          callId: resolvedCallId,
          responseCourse: calleeResponseRef.course,
          responseGenseq: calleeResponseRef.genseq,
        });
      }
      const anchorRecord: TeammateCallAnchorRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'teammate_call_anchor_record',
        anchorRole: 'response',
        callId: resolvedCallId,
        genseq: calleeResponseRef.genseq,
        assignmentCourse: assignmentRef?.course,
        assignmentGenseq: assignmentRef?.genseq,
        callerDialogId: parentDialog.id.selfId,
        callerCourse: result.callingCourse,
      };
      await DialogPersistence.appendEvent(
        subdialogId,
        calleeResponseRef.course,
        anchorRecord,
        parentDialog.status,
      );
    }

    await syncPendingTellaskReminderBestEffort(parentDialog, 'driver-v2:supplyResponseToSupdialog');

    await parentDialog.receiveTeammateResponse(
      result.responderId,
      result.callName,
      result.mentionList,
      result.tellaskContent,
      status,
      subdialogId,
      {
        response: upstreamResponseText,
        agentId: result.responderAgentId ?? result.responderId,
        callId: resolvedCallId,
        originMemberId: requesterId,
        sessionSlug: result.sessionSlug,
        calleeCourse: calleeResponseRef?.course,
        calleeGenseq: calleeResponseRef?.genseq,
      },
    );

    // Keep in-memory dialog context in sync with live teammate-response events immediately.
    // v2 context assembly now relies on dialog msgs + persisted teammate_response_record only.
    const immediateMirror: ChatMessage = {
      type: 'tellask_result_msg',
      role: 'tool',
      responderId: result.responderId,
      mentionList: result.mentionList,
      tellaskContent: result.tellaskContent,
      status,
      callId: resolvedCallId,
      content: upstreamResponseText,
    };
    await parentDialog.addChatMessages(immediateMirror);

    if (result.shouldRevive) {
      const isRoot = parentDialog instanceof RootDialog;
      const hasRegistryEntry = isRoot
        ? globalDialogRegistry.get(parentDialog.id.rootId) !== undefined
        : false;

      log.debug(
        `All Type ${callType} subdialogs complete, parent ${parentDialog.id.selfId} scheduling auto-revive`,
        undefined,
        {
          rootId: parentDialog.id.rootId,
          selfId: parentDialog.id.selfId,
          via: isRoot && hasRegistryEntry ? 'backend_loop_trigger' : 'direct_schedule_drive',
          isRoot,
          hasRegistryEntry,
        },
      );

      if (isRoot) {
        globalDialogRegistry.markNeedsDrive(parentDialog.id.rootId, {
          source: 'driver_v2_supply_response',
          reason: `all_pending_subdialogs_resolved:type_${callType}`,
        });
      }

      // Root dialogs should normally be resumed by backend loop drive-trigger.
      // Direct schedule is kept only as fallback for non-root callers or when registry
      // entry is not available yet (e.g., transient bootstrap windows).
      if (!isRoot || !hasRegistryEntry) {
        scheduleDrive(parentDialog, {
          waitInQue: true,
          driveOptions: { suppressDiligencePush: parentDialog.disableDiligencePush },
        });
      }
    }
  } catch (error) {
    log.error('driver-v2 failed to supply subdialog response', error, {
      parentId: parentDialog.id.selfId,
      subdialogId: subdialogId.selfId,
    });
    throw error;
  }
}

export async function supplySubdialogResponseToSpecificCallerIfPendingV2(args: {
  subdialog: SubDialog;
  responseText: string;
  responseGenseq: number;
  target: SubdialogReplyTarget;
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { subdialog, responseText, responseGenseq, target, scheduleDrive } = args;
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return false;
  }

  const ownerDialog = await resolveOwnerDialogBySelfId(subdialog, target.ownerDialogId);
  if (!ownerDialog) {
    return false;
  }
  if (
    !(await ensureDialogFreshOrDiscard(
      ownerDialog,
      'supplySubdialogResponseToSpecificCallerIfPendingV2:owner',
    ))
  ) {
    return false;
  }

  const pending = await DialogPersistence.loadPendingSubdialogs(ownerDialog.id, ownerDialog.status);
  const pendingRecord = pending.find((p) => p.subdialogId === subdialog.id.selfId);
  if (!pendingRecord) {
    return false;
  }
  if (pendingRecord.callType !== target.callType) {
    log.warn(
      'Reply target callType does not match pending callType; skipping stale reply target',
      undefined,
      {
        rootId: subdialog.rootDialog.id.rootId,
        subdialogId: subdialog.id.selfId,
        ownerDialogId: ownerDialog.id.selfId,
        targetCallType: target.callType,
        pendingCallType: pendingRecord.callType,
      },
    );
    return false;
  }

  await supplyResponseToSupdialogV2({
    parentDialog: ownerDialog,
    subdialogId: subdialog.id,
    responseText,
    subdialog,
    callType: pendingRecord.callType,
    callId: target.callId,
    status: 'completed',
    calleeResponseRef: { course: subdialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}

export async function supplySubdialogResponseToAssignedCallerIfPendingV2(args: {
  subdialog: SubDialog;
  responseText: string;
  responseGenseq: number;
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { subdialog, responseText, responseGenseq, scheduleDrive } = args;
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return false;
  }

  const callerDialog = await resolveOwnerDialogBySelfId(subdialog, assignment.callerDialogId);
  if (!callerDialog) {
    log.warn('Missing caller dialog for subdialog response supply', undefined, {
      rootId: subdialog.rootDialog.id.rootId,
      subdialogId: subdialog.id.selfId,
      callerDialogId: assignment.callerDialogId,
    });
    return false;
  }
  if (
    !(await ensureDialogFreshOrDiscard(
      callerDialog,
      'supplySubdialogResponseToAssignedCallerIfPendingV2:caller',
    ))
  ) {
    return false;
  }

  const pending = await DialogPersistence.loadPendingSubdialogs(
    callerDialog.id,
    callerDialog.status,
  );
  const pendingRecord = pending.find((p) => p.subdialogId === subdialog.id.selfId);
  if (!pendingRecord) {
    return false;
  }

  await supplyResponseToSupdialogV2({
    parentDialog: callerDialog,
    subdialogId: subdialog.id,
    responseText,
    subdialog,
    callType: pendingRecord.callType,
    callId: assignment.callId,
    status: 'completed',
    calleeResponseRef: { course: subdialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}
