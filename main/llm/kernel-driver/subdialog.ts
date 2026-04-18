import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallerCourseNumber,
  toCallingGenerationSeqNumber,
  toRootGenerationAnchor,
  type CallerCourseNumber,
  type PendingSubdialogStateRecord,
  type TellaskCallAnchorRecord,
  type TellaskReplyResolutionRecord,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { Dialog, DialogID, RootDialog, SubDialog } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { ensureDialogLoaded, type DialogPersistenceStatus } from '../../dialog-instance-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import {
  formatTellaskCarryoverResultContent,
  formatTellaskResponseContent,
} from '../../runtime/inter-dialog-format';
import { getWorkLanguage } from '../../runtime/work-language';
import { syncPendingTellaskReminderState } from '../../tools/pending-tellask-reminder';
import type { ChatMessage } from '../client';
import { withSubdialogTxnLock } from './subdialog-txn';
import type { KernelDriverDriveCallOptions, KernelDriverSubdialogReplyTarget } from './types';

export type SubdialogReplyTarget = KernelDriverSubdialogReplyTarget;

export type ScheduleDriveFn = (dialog: Dialog, options: KernelDriverDriveCallOptions) => void;

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
          'kernel-driver discarding stale dialog object due to persisted status mismatch',
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
      log.warn('kernel-driver auto-persisted missing root dialog metadata', undefined, {
        where,
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
      });
      return true;
    }
  } catch (err) {
    log.warn(
      'kernel-driver failed to verify dialog freshness against persisted status',
      undefined,
      {
        where,
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        status: dialog.status,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  log.warn('kernel-driver discarding stale dialog object due to status/path mismatch', undefined, {
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
      if (event.type !== 'tellask_call_anchor_record') {
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

export async function supplyResponseToSupdialog(args: {
  parentDialog: Dialog;
  subdialogId: DialogID;
  responseText: string;
  callType: 'A' | 'B' | 'C';
  callId?: string;
  status?: 'completed' | 'failed';
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  replyResolution?: {
    callId: string;
    replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  };
  calleeResponseRef?: { course: number; genseq: number };
  callerCourseOverride?: CallerCourseNumber;
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
    deliveryMode = 'reply_tool',
    calleeResponseRef,
    callerCourseOverride,
    scheduleDrive,
    subdialog: maybeSubdialog,
  } = args;
  try {
    const result = await withSubdialogTxnLock(parentDialog.id, async () => {
      const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(
        parentDialog.id,
        parentDialog.status,
      );
      let pendingRecord: PendingSubdialogStateRecord | undefined;
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
        toRootGenerationAnchor({
          rootCourse:
            parentDialog instanceof SubDialog
              ? parentDialog.rootDialog.currentCourse
              : parentDialog.currentCourse,
          rootGenseq:
            parentDialog instanceof SubDialog
              ? (parentDialog.rootDialog.activeGenSeqOrUndefined ?? 0)
              : (parentDialog.activeGenSeqOrUndefined ?? 0),
        }),
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
        callingCourse: pendingRecord?.callingCourse,
        callingGenseq: pendingRecord?.callingGenseq,
        callerCourse:
          pendingRecord?.callingCourse !== undefined
            ? toCallerCourseNumber(pendingRecord.callingCourse)
            : callerCourseOverride,
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
    const upstreamResponseBody = responseText;
    const requesterId = result.originMemberId ?? parentDialog.agentId;
    const upstreamResponseText = formatTellaskResponseContent({
      callName: result.callName,
      responderId: result.responderId,
      requesterId,
      mentionList: result.mentionList,
      sessionSlug: result.sessionSlug,
      tellaskContent: result.tellaskContent,
      responseBody: upstreamResponseBody,
      status,
      deliveryMode,
      language: getWorkLanguage(),
    });
    const carryoverOriginCourse = result.callingCourse;
    let assignmentRef:
      | {
          course: number;
          genseq: number;
        }
      | undefined;
    const carryoverContent =
      carryoverOriginCourse !== undefined && carryoverOriginCourse !== parentDialog.currentCourse
        ? formatTellaskCarryoverResultContent({
            originCourse: carryoverOriginCourse,
            callName: result.callName,
            responderId: result.responderId,
            mentionList: result.mentionList,
            sessionSlug: result.sessionSlug,
            tellaskContent: result.tellaskContent,
            responseBody: upstreamResponseBody,
            status,
            language: getWorkLanguage(),
          })
        : undefined;
    if (resolvedCallId !== '' && calleeResponseRef) {
      if (result.callerCourse === undefined) {
        throw new Error(
          `tellask response anchor invariant violation: missing callerCourse ` +
            `(parentId=${parentDialog.id.selfId}, subdialogId=${subdialogId.selfId}, callId=${resolvedCallId})`,
        );
      }
      assignmentRef = await resolveLatestAssignmentAnchorRef({
        calleeDialogId: subdialogId,
        callId: resolvedCallId,
        status: parentDialog.status,
      });
      if (!assignmentRef) {
        // A sideline can legitimately finish a pending tellask before the queued assignment
        // prompt for that call is rendered locally, for example after a direct user nudge inside
        // the sideline dialog. Keep the caller deep-link anchor, but do not treat the missing
        // local assignment bubble as an invariant violation.
        log.debug('Tellask response anchor has no local assignment anchor', undefined, {
          parentId: parentDialog.id.selfId,
          subdialogId: subdialogId.selfId,
          callId: resolvedCallId,
          responseCourse: calleeResponseRef.course,
          responseGenseq: calleeResponseRef.genseq,
        });
      }
      if (args.replyResolution) {
        const replyResolutionRecord: TellaskReplyResolutionRecord = {
          ts: formatUnifiedTimestamp(new Date()),
          type: 'tellask_reply_resolution_record',
          genseq: calleeResponseRef.genseq,
          callId: args.replyResolution.callId,
          replyCallName: args.replyResolution.replyCallName,
          targetCallId: resolvedCallId,
          ...toRootGenerationAnchor({
            rootCourse:
              parentDialog instanceof SubDialog
                ? parentDialog.rootDialog.currentCourse
                : parentDialog.currentCourse,
            rootGenseq:
              parentDialog instanceof SubDialog
                ? (parentDialog.rootDialog.activeGenSeqOrUndefined ?? 0)
                : (parentDialog.activeGenSeqOrUndefined ?? 0),
          }),
        };
        await DialogPersistence.appendEvent(
          subdialogId,
          calleeResponseRef.course,
          replyResolutionRecord,
          parentDialog.status,
        );
      }
      const anchorRecord: TellaskCallAnchorRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'tellask_call_anchor_record',
        anchorRole: 'response',
        callId: resolvedCallId,
        genseq: calleeResponseRef.genseq,
        ...toRootGenerationAnchor({
          rootCourse:
            parentDialog instanceof SubDialog
              ? parentDialog.rootDialog.currentCourse
              : parentDialog.currentCourse,
          rootGenseq:
            parentDialog instanceof SubDialog
              ? (parentDialog.rootDialog.activeGenSeqOrUndefined ?? 0)
              : (parentDialog.activeGenSeqOrUndefined ?? 0),
        }),
        assignmentCourse:
          assignmentRef !== undefined ? toAssignmentCourseNumber(assignmentRef.course) : undefined,
        assignmentGenseq:
          assignmentRef !== undefined
            ? toAssignmentGenerationSeqNumber(assignmentRef.genseq)
            : undefined,
        callerDialogId: parentDialog.id.selfId,
        callerCourse: result.callerCourse,
      };
      await DialogPersistence.appendEvent(
        subdialogId,
        calleeResponseRef.course,
        anchorRecord,
        parentDialog.status,
      );
    }

    await syncPendingTellaskReminderBestEffort(
      parentDialog,
      'kernel-driver:supplyResponseToSupdialog',
    );

    await parentDialog.receiveTellaskResponse(
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
        originCourse: carryoverOriginCourse,
        calling_genseq:
          result.callingGenseq !== undefined
            ? toCallingGenerationSeqNumber(result.callingGenseq)
            : assignmentRef !== undefined
              ? toCallingGenerationSeqNumber(assignmentRef.genseq)
              : undefined,
        carryoverContent,
        sessionSlug: result.sessionSlug,
        calleeCourse:
          calleeResponseRef !== undefined
            ? toCalleeCourseNumber(calleeResponseRef.course)
            : undefined,
        calleeGenseq:
          calleeResponseRef !== undefined
            ? toCalleeGenerationSeqNumber(calleeResponseRef.genseq)
            : undefined,
      },
    );

    const immediateMirror: ChatMessage =
      carryoverContent !== undefined
        ? {
            type: 'tellask_carryover_msg',
            role: 'user',
            genseq: parentDialog.activeGenSeqOrUndefined ?? 1,
            content: carryoverContent,
            originCourse: carryoverOriginCourse!,
            carryoverCourse: parentDialog.currentCourse,
            responderId: result.responderId,
            callName: result.callName,
            tellaskContent: result.tellaskContent,
            status,
            response: upstreamResponseText,
            agentId: result.responderAgentId ?? result.responderId,
            callId: resolvedCallId,
            originMemberId: requesterId,
            ...(result.callName === 'tellask'
              ? {
                  mentionList: result.mentionList ?? [],
                  sessionSlug: result.sessionSlug,
                }
              : result.callName === 'tellaskSessionless'
                ? {
                    mentionList: result.mentionList ?? [],
                  }
                : {}),
            ...(calleeResponseRef !== undefined
              ? {
                  calleeDialogId: subdialogId.selfId,
                  calleeCourse: calleeResponseRef.course,
                  calleeGenseq: calleeResponseRef.genseq,
                }
              : {
                  calleeDialogId: subdialogId.selfId,
                }),
          }
        : {
            type: 'tellask_result_msg',
            role: 'tool',
            callId: resolvedCallId,
            callName: result.callName,
            status,
            content: upstreamResponseText,
            ...(result.callingCourse !== undefined ? { originCourse: result.callingCourse } : {}),
            ...(result.callingGenseq !== undefined
              ? { calling_genseq: result.callingGenseq }
              : assignmentRef !== undefined
                ? { calling_genseq: assignmentRef.genseq }
                : {}),
            call:
              result.callName === 'tellask'
                ? {
                    tellaskContent: result.tellaskContent,
                    mentionList: result.mentionList ?? [],
                    ...(result.sessionSlug ? { sessionSlug: result.sessionSlug } : {}),
                  }
                : result.callName === 'tellaskSessionless'
                  ? {
                      tellaskContent: result.tellaskContent,
                      mentionList: result.mentionList ?? [],
                    }
                  : {
                      tellaskContent: result.tellaskContent,
                    },
            responder: {
              responderId: result.responderId,
              agentId: result.responderAgentId ?? result.responderId,
              originMemberId: requesterId,
            },
            route: {
              calleeDialogId: subdialogId.selfId,
              ...(calleeResponseRef !== undefined
                ? {
                    calleeCourse: calleeResponseRef.course,
                    calleeGenseq: calleeResponseRef.genseq,
                  }
                : {}),
            },
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
          source: 'kernel_driver_supply_response',
          reason: `all_pending_subdialogs_resolved:type_${callType}`,
        });
      }

      if (!isRoot || !hasRegistryEntry) {
        scheduleDrive(parentDialog, {
          waitInQue: true,
          driveOptions: {
            suppressDiligencePush: parentDialog.disableDiligencePush,
            noPromptSubdialogResumeEntitlement: {
              ownerDialogId: parentDialog.id.selfId,
              reason: 'resolved_pending_subdialog_reply',
              subdialogId: subdialogId.selfId,
              callType,
              callId: resolvedCallId,
            },
            source: 'kernel_driver_supply_response_parent_revive',
            reason: `all_pending_subdialogs_resolved:type_${callType}`,
          },
        });
      }
    }
  } catch (error) {
    log.error('kernel-driver failed to supply subdialog response', error, {
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
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  replyResolution?: {
    callId: string;
    replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  };
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
  if (pendingRecord.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: subdialog.id,
      callId: pendingRecord.callId,
      status: subdialog.status,
    });
    if (!assignmentAnchorRef) {
      log.debug(
        'Skip Type B response supply before updated assignment is rendered locally',
        undefined,
        {
          rootId: subdialog.rootDialog.id.rootId,
          subdialogId: subdialog.id.selfId,
          ownerDialogId: ownerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseGenseq,
        },
      );
      return false;
    }
    if (
      subdialog.currentCourse < assignmentAnchorRef.course ||
      (subdialog.currentCourse === assignmentAnchorRef.course &&
        responseGenseq < assignmentAnchorRef.genseq)
    ) {
      log.debug(
        'Skip stale Type B response supply from before latest local assignment',
        undefined,
        {
          rootId: subdialog.rootDialog.id.rootId,
          subdialogId: subdialog.id.selfId,
          ownerDialogId: ownerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseCourse: subdialog.currentCourse,
          responseGenseq,
          assignmentCourse: assignmentAnchorRef.course,
          assignmentGenseq: assignmentAnchorRef.genseq,
        },
      );
      return false;
    }
  }

  await supplyResponseToSupdialog({
    parentDialog: ownerDialog,
    subdialogId: subdialog.id,
    responseText,
    subdialog,
    callType: pendingRecord.callType,
    callId: target.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    replyResolution: args.replyResolution,
    calleeResponseRef: { course: subdialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}

export async function supplySubdialogResponseToAssignedCallerIfPendingV2(args: {
  subdialog: SubDialog;
  responseText: string;
  responseGenseq: number;
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  replyResolution?: {
    callId: string;
    replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  };
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
  if (pendingRecord.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: subdialog.id,
      callId: pendingRecord.callId,
      status: subdialog.status,
    });
    if (!assignmentAnchorRef) {
      log.debug(
        'Skip assigned Type B response supply before updated assignment is rendered locally',
        undefined,
        {
          rootId: subdialog.rootDialog.id.rootId,
          subdialogId: subdialog.id.selfId,
          callerDialogId: callerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseGenseq,
        },
      );
      return false;
    }
    if (
      subdialog.currentCourse < assignmentAnchorRef.course ||
      (subdialog.currentCourse === assignmentAnchorRef.course &&
        responseGenseq < assignmentAnchorRef.genseq)
    ) {
      log.debug(
        'Skip assigned stale Type B response supply from before latest local assignment',
        undefined,
        {
          rootId: subdialog.rootDialog.id.rootId,
          subdialogId: subdialog.id.selfId,
          callerDialogId: callerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseCourse: subdialog.currentCourse,
          responseGenseq,
          assignmentCourse: assignmentAnchorRef.course,
          assignmentGenseq: assignmentAnchorRef.genseq,
        },
      );
      return false;
    }
  }

  await supplyResponseToSupdialog({
    parentDialog: callerDialog,
    subdialogId: subdialog.id,
    responseText,
    subdialog,
    callType: pendingRecord.callType,
    callId: assignment.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    replyResolution: args.replyResolution,
    calleeResponseRef: { course: subdialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}
