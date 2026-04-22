import {
  toAskerCourseNumber,
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteGenseqNo,
  toRootGenerationAnchor,
  type AskerCourseNumber,
  type PendingSideDialogStateRecord,
  type TellaskCallAnchorRecord,
  type TellaskReplyResolutionRecord,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { Dialog, DialogID, MainDialog, SideDialog } from '../../dialog';
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
import { withSideDialogTxnLock } from './sideDialog-txn';
import type { KernelDriverDriveCallOptions, KernelDriverSideDialogReplyTarget } from './types';

export type SideDialogReplyTarget = KernelDriverSideDialogReplyTarget;

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
  sideDialog: SideDialog,
  ownerDialogId: string,
): Promise<Dialog | undefined> {
  const mainDialog = sideDialog.mainDialog;
  if (!(await ensureDialogFreshOrDiscard(mainDialog, 'resolveOwnerDialogBySelfId:root'))) {
    return undefined;
  }
  if (ownerDialogId === mainDialog.id.selfId) {
    return mainDialog;
  }
  const existing = mainDialog.lookupDialog(ownerDialogId);
  if (existing) {
    if (!(await ensureDialogFreshOrDiscard(existing, 'resolveOwnerDialogBySelfId:lookup'))) {
      return undefined;
    }
    return existing;
  }
  const restored = await ensureDialogLoaded(
    mainDialog,
    new DialogID(ownerDialogId, mainDialog.id.rootId),
    mainDialog.status,
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
        if (dialog instanceof MainDialog) {
          globalDialogRegistry.unregister(dialog.id.rootId);
        }
        return false;
      }
    }

    if (dialog instanceof MainDialog && dialog.status === 'running') {
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
      log.warn('kernel-driver auto-persisted missing main dialog metadata', undefined, {
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
  if (dialog instanceof MainDialog) {
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

export async function supplyResponseToAskerDialog(args: {
  parentDialog: Dialog;
  sideDialogId: DialogID;
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
  askerCourseOverride?: AskerCourseNumber;
  scheduleDrive: ScheduleDriveFn;
  sideDialog?: SideDialog;
}): Promise<void> {
  const {
    parentDialog,
    sideDialogId,
    responseText,
    callType,
    callId,
    status = 'completed',
    deliveryMode = 'reply_tool',
    calleeResponseRef,
    askerCourseOverride,
    scheduleDrive,
    sideDialog: maybeSideDialog,
  } = args;
  try {
    const result = await withSideDialogTxnLock(parentDialog.id, async () => {
      const pendingSideDialogs = await DialogPersistence.loadPendingSideDialogs(
        parentDialog.id,
        parentDialog.status,
      );
      let pendingRecord: PendingSideDialogStateRecord | undefined;
      const filteredPending: typeof pendingSideDialogs = [];
      const requestedCallId = typeof callId === 'string' ? callId.trim() : '';
      for (const pending of pendingSideDialogs) {
        if (
          pending.sideDialogId === sideDialogId.selfId &&
          (requestedCallId === '' || pending.callId === requestedCallId) &&
          pendingRecord === undefined
        ) {
          pendingRecord = pending;
        } else {
          filteredPending.push(pending);
        }
      }

      let responderId = sideDialogId.rootId;
      let responderAgentId: string | undefined;
      let callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning' =
        'tellaskSessionless';
      let mentionList: string[] | undefined;
      let tellaskContent = responseText;
      let originMemberId: string | undefined;
      let sessionSlug: string | undefined;

      try {
        const metadata = await DialogPersistence.loadDialogMetadata(
          sideDialogId,
          parentDialog.status,
        );
        if (metadata && metadata.assignmentFromAsker) {
          originMemberId = metadata.assignmentFromAsker.originMemberId;
          if (!pendingRecord) {
            callName = metadata.assignmentFromAsker.callName;
            mentionList = metadata.assignmentFromAsker.mentionList;
            tellaskContent = metadata.assignmentFromAsker.tellaskContent;
          }
        }
        if (!pendingRecord && metadata && typeof metadata.agentId === 'string') {
          if (metadata.agentId.trim() !== '') {
            responderId = metadata.agentId;
            responderAgentId = metadata.agentId;
          }
        }
      } catch (err) {
        log.warn('Failed to load sideDialog metadata for response record', undefined, {
          parentId: parentDialog.id.selfId,
          sideDialogId: sideDialogId.selfId,
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

      await DialogPersistence.savePendingSideDialogs(
        parentDialog.id,
        filteredPending,
        toRootGenerationAnchor({
          rootCourse:
            parentDialog instanceof SideDialog
              ? parentDialog.mainDialog.currentCourse
              : parentDialog.currentCourse,
          rootGenseq:
            parentDialog instanceof SideDialog
              ? (parentDialog.mainDialog.activeGenSeqOrUndefined ?? 0)
              : (parentDialog.activeGenSeqOrUndefined ?? 0),
        }),
        parentDialog.status,
      );

      const sameWaitGroupPending =
        pendingRecord === undefined
          ? []
          : filteredPending.filter(
              (pending) =>
                pending.callSiteCourse === pendingRecord.callSiteCourse &&
                pending.callSiteGenseq === pendingRecord.callSiteGenseq,
            );
      const hasQ4H = await parentDialog.hasPendingQ4H();
      const shouldRevive =
        pendingRecord !== undefined && !hasQ4H && sameWaitGroupPending.length === 0;
      if (shouldRevive && parentDialog instanceof MainDialog) {
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
        callSiteCourse: pendingRecord?.callSiteCourse,
        callSiteGenseq: pendingRecord?.callSiteGenseq,
        resolvedCallIds: pendingRecord ? [pendingRecord.callId] : [],
        askerCourse:
          pendingRecord?.callSiteCourse !== undefined
            ? toAskerCourseNumber(pendingRecord.callSiteCourse)
            : askerCourseOverride,
        shouldRevive,
      };
    });

    const normalizedCallId = typeof callId === 'string' ? callId.trim() : '';
    const fallbackCallId = typeof result.callId === 'string' ? result.callId.trim() : '';
    const resolvedCallId = normalizedCallId !== '' ? normalizedCallId : fallbackCallId;
    const rootForLookup =
      parentDialog instanceof MainDialog
        ? parentDialog
        : parentDialog instanceof SideDialog
          ? parentDialog.mainDialog
          : undefined;
    const lookedUpSideDialog = rootForLookup?.lookupDialog(sideDialogId.selfId);
    const resolvedSideDialog =
      maybeSideDialog ??
      (lookedUpSideDialog instanceof SideDialog ? lookedUpSideDialog : undefined);
    const tellaskerResponseBody = responseText;
    const tellaskerId = result.originMemberId ?? parentDialog.agentId;
    const tellaskerResponseText = formatTellaskResponseContent({
      callName: result.callName,
      callId: resolvedCallId,
      responderId: result.responderId,
      tellaskerId,
      mentionList: result.mentionList,
      sessionSlug: result.sessionSlug,
      tellaskContent: result.tellaskContent,
      responseBody: tellaskerResponseBody,
      status,
      deliveryMode,
      language: getWorkLanguage(),
    });
    const carryoverCallSiteCourse = result.callSiteCourse;
    let assignmentRef:
      | {
          course: number;
          genseq: number;
        }
      | undefined;
    const carryoverContent =
      carryoverCallSiteCourse !== undefined &&
      carryoverCallSiteCourse !== parentDialog.currentCourse
        ? formatTellaskCarryoverResultContent({
            callSiteCourse: carryoverCallSiteCourse,
            callName: result.callName,
            callId: resolvedCallId,
            responderId: result.responderId,
            mentionList: result.mentionList,
            sessionSlug: result.sessionSlug,
            tellaskContent: result.tellaskContent,
            responseBody: tellaskerResponseBody,
            status,
            language: getWorkLanguage(),
          })
        : undefined;
    if (resolvedCallId !== '' && calleeResponseRef) {
      if (result.askerCourse === undefined) {
        throw new Error(
          `tellask response anchor invariant violation: missing askerCourse ` +
            `(parentId=${parentDialog.id.selfId}, sideDialogId=${sideDialogId.selfId}, callId=${resolvedCallId})`,
        );
      }
      assignmentRef = await resolveLatestAssignmentAnchorRef({
        calleeDialogId: sideDialogId,
        callId: resolvedCallId,
        status: parentDialog.status,
      });
      if (!assignmentRef) {
        // A Side Dialog can legitimately finish a pending tellask before the queued assignment
        // prompt for that call is rendered locally, for example after a direct user nudge inside
        // the Side Dialog. Keep the asker deep-link anchor, but do not treat the missing
        // local assignment bubble as an invariant violation.
        log.debug('Tellask response anchor has no local assignment anchor', undefined, {
          parentId: parentDialog.id.selfId,
          sideDialogId: sideDialogId.selfId,
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
              parentDialog instanceof SideDialog
                ? parentDialog.mainDialog.currentCourse
                : parentDialog.currentCourse,
            rootGenseq:
              parentDialog instanceof SideDialog
                ? (parentDialog.mainDialog.activeGenSeqOrUndefined ?? 0)
                : (parentDialog.activeGenSeqOrUndefined ?? 0),
          }),
        };
        await DialogPersistence.appendEvent(
          sideDialogId,
          calleeResponseRef.course,
          replyResolutionRecord,
          parentDialog.status,
        );
        const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
          sideDialogId,
          parentDialog.status,
        );
        if (deferredReplyReassertion?.directive.targetCallId === resolvedCallId) {
          await DialogPersistence.setDeferredReplyReassertion(
            sideDialogId,
            undefined,
            parentDialog.status,
          );
        }
        const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
          sideDialogId,
          parentDialog.status,
        );
        if (activeReplyObligation?.targetCallId === resolvedCallId) {
          await DialogPersistence.setActiveTellaskReplyObligation(
            sideDialogId,
            undefined,
            parentDialog.status,
          );
          if (maybeSideDialog) {
            const nextAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
              maybeSideDialog.id,
              maybeSideDialog.status,
            );
            if (!nextAskerStackState) {
              throw new Error(
                `Missing asker stack after reply obligation pop: ${maybeSideDialog.id.valueOf()}`,
              );
            }
            maybeSideDialog.askerStack = nextAskerStackState;
          }
        }
      }
      const anchorRecord: TellaskCallAnchorRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'tellask_call_anchor_record',
        anchorRole: 'response',
        callId: resolvedCallId,
        genseq: calleeResponseRef.genseq,
        ...toRootGenerationAnchor({
          rootCourse:
            parentDialog instanceof SideDialog
              ? parentDialog.mainDialog.currentCourse
              : parentDialog.currentCourse,
          rootGenseq:
            parentDialog instanceof SideDialog
              ? (parentDialog.mainDialog.activeGenSeqOrUndefined ?? 0)
              : (parentDialog.activeGenSeqOrUndefined ?? 0),
        }),
        assignmentCourse:
          assignmentRef !== undefined ? toAssignmentCourseNumber(assignmentRef.course) : undefined,
        assignmentGenseq:
          assignmentRef !== undefined
            ? toAssignmentGenerationSeqNumber(assignmentRef.genseq)
            : undefined,
        askerDialogId: parentDialog.id.selfId,
        askerCourse: result.askerCourse,
      };
      await DialogPersistence.appendEvent(
        sideDialogId,
        calleeResponseRef.course,
        anchorRecord,
        parentDialog.status,
      );
    }

    await syncPendingTellaskReminderBestEffort(
      parentDialog,
      'kernel-driver:supplyResponseToAskerDialog',
    );

    await parentDialog.receiveTellaskResponse(
      result.responderId,
      result.callName,
      result.mentionList,
      result.tellaskContent,
      status,
      sideDialogId,
      {
        response: tellaskerResponseText,
        agentId: result.responderAgentId ?? result.responderId,
        callId: resolvedCallId,
        originMemberId: tellaskerId,
        callSiteCourse: carryoverCallSiteCourse,
        callSiteGenseq:
          result.callSiteGenseq !== undefined
            ? toCallSiteGenseqNo(result.callSiteGenseq)
            : assignmentRef !== undefined
              ? toCallSiteGenseqNo(assignmentRef.genseq)
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
            callSiteCourse: carryoverCallSiteCourse!,
            carryoverCourse: parentDialog.currentCourse,
            responderId: result.responderId,
            callName: result.callName,
            tellaskContent: result.tellaskContent,
            status,
            response: tellaskerResponseText,
            agentId: result.responderAgentId ?? result.responderId,
            callId: resolvedCallId,
            originMemberId: tellaskerId,
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
                  calleeDialogId: sideDialogId.selfId,
                  calleeCourse: calleeResponseRef.course,
                  calleeGenseq: calleeResponseRef.genseq,
                }
              : {
                  calleeDialogId: sideDialogId.selfId,
                }),
          }
        : {
            type: 'tellask_result_msg',
            role: 'tool',
            callId: resolvedCallId,
            callName: result.callName,
            status,
            content: tellaskerResponseText,
            ...(result.callSiteCourse !== undefined
              ? { callSiteCourse: result.callSiteCourse }
              : {}),
            ...(result.callSiteGenseq !== undefined
              ? { callSiteGenseq: result.callSiteGenseq }
              : assignmentRef !== undefined
                ? { callSiteGenseq: assignmentRef.genseq }
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
              originMemberId: tellaskerId,
            },
            route: {
              calleeDialogId: sideDialogId.selfId,
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
      const isRoot = parentDialog instanceof MainDialog;
      const hasRegistryEntry = isRoot
        ? globalDialogRegistry.get(parentDialog.id.rootId) !== undefined
        : false;

      log.debug(
        `All Type ${callType} sideDialogs complete, parent ${parentDialog.id.selfId} scheduling auto-revive`,
        undefined,
        {
          rootId: parentDialog.id.rootId,
          selfId: parentDialog.id.selfId,
          callSiteCourse: result.callSiteCourse,
          callSiteGenseq: result.callSiteGenseq,
          via: isRoot && hasRegistryEntry ? 'backend_loop_trigger' : 'direct_schedule_drive',
          isRoot,
          hasRegistryEntry,
        },
      );

      if (isRoot) {
        globalDialogRegistry.markNeedsDrive(parentDialog.id.rootId, {
          source: 'kernel_driver_supply_response',
          reason: `all_pending_sideDialogs_resolved:type_${callType}`,
        });
      }

      if (result.callSiteCourse === undefined || result.callSiteGenseq === undefined) {
        throw new Error(
          `sideDialog revive entitlement invariant violation: missing wait-group coordinates ` +
            `(rootId=${parentDialog.id.rootId}, selfId=${parentDialog.id.selfId}, callId=${resolvedCallId})`,
        );
      }
      scheduleDrive(parentDialog, {
        waitInQue: true,
        driveOptions: {
          suppressDiligencePush: parentDialog.disableDiligencePush,
          noPromptSideDialogResumeEntitlement: {
            ownerDialogId: parentDialog.id.selfId,
            reason: 'resolved_pending_sideDialog_reply',
            sideDialogId: sideDialogId.selfId,
            callType,
            callId: resolvedCallId,
            callSiteCourse: result.callSiteCourse,
            callSiteGenseq: result.callSiteGenseq,
            resolvedCallIds: result.resolvedCallIds,
            triggerCallId: resolvedCallId,
          },
          source: 'kernel_driver_supply_response_parent_revive',
          reason: `wait_group_resolved:type_${callType}:c${result.callSiteCourse}:g${result.callSiteGenseq}`,
        },
      });
    }
  } catch (error) {
    log.error('kernel-driver failed to supply sideDialog response', error, {
      parentId: parentDialog.id.selfId,
      sideDialogId: sideDialogId.selfId,
    });
    throw error;
  }
}

export async function supplySideDialogResponseToSpecificAskerIfPendingV2(args: {
  sideDialog: SideDialog;
  responseText: string;
  responseGenseq: number;
  target: SideDialogReplyTarget;
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  replyResolution?: {
    callId: string;
    replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  };
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { sideDialog, responseText, responseGenseq, target, scheduleDrive } = args;
  const assignment = sideDialog.assignmentFromAsker;
  if (!assignment) {
    return false;
  }

  const ownerDialog = await resolveOwnerDialogBySelfId(sideDialog, target.ownerDialogId);
  if (!ownerDialog) {
    return false;
  }
  if (
    !(await ensureDialogFreshOrDiscard(
      ownerDialog,
      'supplySideDialogResponseToSpecificAskerIfPendingV2:owner',
    ))
  ) {
    return false;
  }

  const pending = await DialogPersistence.loadPendingSideDialogs(
    ownerDialog.id,
    ownerDialog.status,
  );
  const pendingRecord = pending.find(
    (p) => p.sideDialogId === sideDialog.id.selfId && p.callId === target.callId,
  );
  if (!pendingRecord) {
    return false;
  }
  if (pendingRecord.callType !== target.callType) {
    log.warn(
      'Reply target callType does not match pending callType; skipping stale reply target',
      undefined,
      {
        rootId: sideDialog.mainDialog.id.rootId,
        sideDialogId: sideDialog.id.selfId,
        ownerDialogId: ownerDialog.id.selfId,
        targetCallType: target.callType,
        pendingCallType: pendingRecord.callType,
      },
    );
    return false;
  }
  if (pendingRecord.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: sideDialog.id,
      callId: pendingRecord.callId,
      status: sideDialog.status,
    });
    if (!assignmentAnchorRef) {
      log.debug(
        'Skip Type B response supply before updated assignment is rendered locally',
        undefined,
        {
          rootId: sideDialog.mainDialog.id.rootId,
          sideDialogId: sideDialog.id.selfId,
          ownerDialogId: ownerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseGenseq,
        },
      );
      return false;
    }
    if (
      sideDialog.currentCourse < assignmentAnchorRef.course ||
      (sideDialog.currentCourse === assignmentAnchorRef.course &&
        responseGenseq < assignmentAnchorRef.genseq)
    ) {
      log.debug(
        'Skip stale Type B response supply from before latest local assignment',
        undefined,
        {
          rootId: sideDialog.mainDialog.id.rootId,
          sideDialogId: sideDialog.id.selfId,
          ownerDialogId: ownerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseCourse: sideDialog.currentCourse,
          responseGenseq,
          assignmentCourse: assignmentAnchorRef.course,
          assignmentGenseq: assignmentAnchorRef.genseq,
        },
      );
      return false;
    }
  }

  await supplyResponseToAskerDialog({
    parentDialog: ownerDialog,
    sideDialogId: sideDialog.id,
    responseText,
    sideDialog,
    callType: pendingRecord.callType,
    callId: target.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    replyResolution: args.replyResolution,
    calleeResponseRef: { course: sideDialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}

export async function supplySideDialogResponseToAssignedAskerIfPendingV2(args: {
  sideDialog: SideDialog;
  responseText: string;
  responseGenseq: number;
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  replyResolution?: {
    callId: string;
    replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  };
  scheduleDrive: ScheduleDriveFn;
}): Promise<boolean> {
  const { sideDialog, responseText, responseGenseq, scheduleDrive } = args;
  const assignment = sideDialog.assignmentFromAsker;
  if (!assignment) {
    return false;
  }

  const askerDialog = await resolveOwnerDialogBySelfId(sideDialog, assignment.askerDialogId);
  if (!askerDialog) {
    log.warn('Missing tellasker for sideDialog response supply', undefined, {
      rootId: sideDialog.mainDialog.id.rootId,
      sideDialogId: sideDialog.id.selfId,
      askerDialogId: assignment.askerDialogId,
    });
    return false;
  }
  if (
    !(await ensureDialogFreshOrDiscard(
      askerDialog,
      'supplySideDialogResponseToAssignedAskerIfPendingV2:asker',
    ))
  ) {
    return false;
  }

  const pending = await DialogPersistence.loadPendingSideDialogs(
    askerDialog.id,
    askerDialog.status,
  );
  const pendingRecord = pending.find(
    (p) => p.sideDialogId === sideDialog.id.selfId && p.callId === assignment.callId,
  );
  if (!pendingRecord) {
    return false;
  }
  if (pendingRecord.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: sideDialog.id,
      callId: pendingRecord.callId,
      status: sideDialog.status,
    });
    if (!assignmentAnchorRef) {
      log.debug(
        'Skip assigned Type B response supply before updated assignment is rendered locally',
        undefined,
        {
          rootId: sideDialog.mainDialog.id.rootId,
          sideDialogId: sideDialog.id.selfId,
          askerDialogId: askerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseGenseq,
        },
      );
      return false;
    }
    if (
      sideDialog.currentCourse < assignmentAnchorRef.course ||
      (sideDialog.currentCourse === assignmentAnchorRef.course &&
        responseGenseq < assignmentAnchorRef.genseq)
    ) {
      log.debug(
        'Skip assigned stale Type B response supply from before latest local assignment',
        undefined,
        {
          rootId: sideDialog.mainDialog.id.rootId,
          sideDialogId: sideDialog.id.selfId,
          askerDialogId: askerDialog.id.selfId,
          callId: pendingRecord.callId,
          responseCourse: sideDialog.currentCourse,
          responseGenseq,
          assignmentCourse: assignmentAnchorRef.course,
          assignmentGenseq: assignmentAnchorRef.genseq,
        },
      );
      return false;
    }
  }

  await supplyResponseToAskerDialog({
    parentDialog: askerDialog,
    sideDialogId: sideDialog.id,
    responseText,
    sideDialog,
    callType: pendingRecord.callType,
    callId: assignment.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    replyResolution: args.replyResolution,
    calleeResponseRef: { course: sideDialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}
