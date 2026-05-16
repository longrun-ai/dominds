import {
  toAskerCourseNumber,
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
  toRootGenerationAnchor,
  type ActiveCalleeDispatchRecord,
  type AskerCourseNumber,
  type AssignmentCourseNumber,
  type AssignmentGenerationSeqNumber,
  type TellaskAnchorRecord,
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
import type { KernelDriverCalleeReplyTarget, KernelDriverDriveCallOptions } from './types';

export type CalleeReplyTarget = KernelDriverCalleeReplyTarget;

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

async function resolveCallerDialogBySelfId(
  sideDialog: SideDialog,
  callerDialogId: string,
): Promise<Dialog | undefined> {
  const mainDialog = sideDialog.mainDialog;
  if (!(await ensureDialogFreshOrDiscard(mainDialog, 'resolveCallerDialogBySelfId:root'))) {
    return undefined;
  }
  if (callerDialogId === mainDialog.id.selfId) {
    return mainDialog;
  }
  const existing = mainDialog.lookupDialog(callerDialogId);
  if (existing) {
    if (!(await ensureDialogFreshOrDiscard(existing, 'resolveCallerDialogBySelfId:lookup'))) {
      return undefined;
    }
    return existing;
  }
  const restored = await ensureDialogLoaded(
    mainDialog,
    new DialogID(callerDialogId, mainDialog.id.rootId),
    mainDialog.status,
  );
  if (!restored) {
    return undefined;
  }
  if (!(await ensureDialogFreshOrDiscard(restored, 'resolveCallerDialogBySelfId:restore'))) {
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
}): Promise<
  | {
      course: AssignmentCourseNumber;
      genseq: AssignmentGenerationSeqNumber;
    }
  | undefined
> {
  const normalizedCallId = args.callId.trim();
  if (normalizedCallId === '') {
    return undefined;
  }

  const latest = await DialogPersistence.loadDialogLatest(args.calleeDialogId, args.status);
  if (!latest) {
    return undefined;
  }
  const latestAssignmentAnchor = latest.latestAssignmentAnchor;
  if (latestAssignmentAnchor?.callId !== normalizedCallId) {
    return undefined;
  }
  return {
    course: latestAssignmentAnchor.assignmentCourse,
    genseq: latestAssignmentAnchor.assignmentGenseq,
  };
}

export async function supplyResponseToAskerDialog(args: {
  parentDialog: Dialog;
  sideDialogId: DialogID;
  responseText: string;
  callType: 'A' | 'B' | 'C';
  callId?: string;
  status?: 'completed' | 'failed';
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  directFallbackSource?: 'saying' | 'thinking_only';
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
    directFallbackSource,
    calleeResponseRef,
    askerCourseOverride,
    scheduleDrive,
    sideDialog: maybeSideDialog,
  } = args;
  try {
    const result = await withSideDialogTxnLock(parentDialog.id, async () => {
      const activeCalleeDispatches = await DialogPersistence.loadActiveCalleeDispatches(
        parentDialog.id,
        parentDialog.status,
      );
      let activeCalleeDispatch: ActiveCalleeDispatchRecord | undefined;
      const requestedCallId = typeof callId === 'string' ? callId.trim() : '';
      for (const dispatch of activeCalleeDispatches) {
        if (
          dispatch.calleeDialogId === sideDialogId.selfId &&
          (requestedCallId === '' || dispatch.callId === requestedCallId) &&
          activeCalleeDispatch === undefined
        ) {
          activeCalleeDispatch = dispatch;
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
        if (metadata) {
          const assignmentFromAsker = await DialogPersistence.loadSideDialogAssignmentFromAsker(
            sideDialogId,
            parentDialog.status,
          );
          originMemberId = assignmentFromAsker.originMemberId;
          if (!activeCalleeDispatch) {
            callName = assignmentFromAsker.callName;
            mentionList = assignmentFromAsker.mentionList;
            tellaskContent = assignmentFromAsker.tellaskContent;
          }
          if (!activeCalleeDispatch && metadata.agentId.trim() !== '') {
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

      if (activeCalleeDispatch) {
        callName = activeCalleeDispatch.callName;
        responderId = activeCalleeDispatch.targetAgentId;
        responderAgentId = activeCalleeDispatch.targetAgentId;
        mentionList = activeCalleeDispatch.mentionList;
        tellaskContent = activeCalleeDispatch.tellaskContent;
        sessionSlug = activeCalleeDispatch.sessionSlug;
      }

      if (
        (callName === 'tellask' || callName === 'tellaskSessionless') &&
        (!Array.isArray(mentionList) || mentionList.length < 1)
      ) {
        mentionList = [`@${responderId}`];
      }

      const activeCalleeOutcome =
        activeCalleeDispatch === undefined
          ? undefined
          : await DialogPersistence.resolveActiveCallee(
              parentDialog.id,
              {
                batchId: activeCalleeDispatch.batchId,
                callId: activeCalleeDispatch.callId,
                sideDialogId: sideDialogId.selfId,
                deliveryMode,
                directFallbackSource,
              },
              parentDialog.status,
            );
      const hasQ4H = await parentDialog.hasPendingQ4H();
      const batchCompleted = activeCalleeOutcome?.batchCompleted === true;
      const shouldRevive = batchCompleted && !hasQ4H;
      if (batchCompleted && activeCalleeOutcome !== undefined) {
        await DialogPersistence.upsertNextStepTrigger(
          parentDialog.id,
          {
            triggerId: `result-arrival:${activeCalleeOutcome.batchId}`,
            kind: 'result_arrival',
            batchId: activeCalleeOutcome.batchId,
          },
          parentDialog.status,
        );
      }
      return {
        responderId,
        responderAgentId,
        callName,
        mentionList,
        tellaskContent,
        originMemberId,
        sessionSlug,
        callId: activeCalleeDispatch?.callId,
        callSiteCourse: activeCalleeOutcome?.callSiteCourse ?? activeCalleeDispatch?.callSiteCourse,
        callSiteGenseq: activeCalleeOutcome?.callSiteGenseq ?? activeCalleeDispatch?.callSiteGenseq,
        batchId: activeCalleeOutcome?.batchId ?? activeCalleeDispatch?.batchId,
        resolvedCallIds: activeCalleeOutcome?.resolvedCallIds ?? [],
        askerCourse:
          activeCalleeDispatch?.callSiteCourse !== undefined
            ? toAskerCourseNumber(activeCalleeDispatch.callSiteCourse)
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
      directFallbackSource,
      language: getWorkLanguage(),
    });
    const carryoverCallSiteCourse = result.callSiteCourse;
    let assignmentRef:
      | {
          course: AssignmentCourseNumber;
          genseq: AssignmentGenerationSeqNumber;
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
      const askerCourse = result.askerCourse;
      if (askerCourse === undefined) {
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
      const anchorRecord: TellaskAnchorRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'tellask_anchor_record',
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
        assignmentCourse: assignmentRef?.course,
        assignmentGenseq: assignmentRef?.genseq,
        askerDialogId: parentDialog.id.selfId,
        askerCourse,
      };
      await DialogPersistence.appendEvent(
        sideDialogId,
        calleeResponseRef.course,
        anchorRecord,
        parentDialog.status,
      );
      await DialogPersistence.mutateDialogLatest(
        sideDialogId,
        () => ({
          kind: 'patch',
          patch: {
            sideDialogFinalResponse: {
              callId: resolvedCallId,
              responseCourse: toDialogCourseNumber(calleeResponseRef.course),
              responseGenseq: toCalleeGenerationSeqNumber(calleeResponseRef.genseq),
              askerDialogId: parentDialog.id.selfId,
              askerCourse,
            },
          },
        }),
        parentDialog.status,
      );
    }

    await syncPendingTellaskReminderBestEffort(
      parentDialog,
      'kernel-driver:supplyResponseToAskerDialog',
    );

    const responseRouteRef = calleeResponseRef;

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
          responseRouteRef !== undefined
            ? toCalleeCourseNumber(responseRouteRef.course)
            : undefined,
        calleeGenseq:
          responseRouteRef !== undefined
            ? toCalleeGenerationSeqNumber(responseRouteRef.genseq)
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
            ...(responseRouteRef !== undefined
              ? {
                  calleeDialogId: sideDialogId.selfId,
                  calleeCourse: responseRouteRef.course,
                  calleeGenseq: responseRouteRef.genseq,
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
              ...(responseRouteRef !== undefined
                ? {
                    calleeCourse: responseRouteRef.course,
                    calleeGenseq: responseRouteRef.genseq,
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
        globalDialogRegistry.wakeDrive(parentDialog.id.rootId, {
          source: 'kernel_driver_supply_response',
          reason: `all_active_callees_resolved:type_${callType}`,
        });
      }

      if (result.callSiteCourse === undefined || result.callSiteGenseq === undefined) {
        throw new Error(
          `sideDialog result-arrival invariant violation: missing dispatch batch coordinates ` +
            `(rootId=${parentDialog.id.rootId}, selfId=${parentDialog.id.selfId}, callId=${resolvedCallId})`,
        );
      }
      if (result.batchId === undefined) {
        throw new Error(
          `sideDialog result-arrival invariant violation: missing batchId ` +
            `(rootId=${parentDialog.id.rootId}, selfId=${parentDialog.id.selfId}, callId=${resolvedCallId})`,
        );
      }
      scheduleDrive(parentDialog, {
        waitInQue: true,
        driveOptions: {
          suppressDiligencePush: parentDialog.disableDiligencePush,
          noPromptSideDialogResumeEntitlement: {
            callerDialogId: parentDialog.id.selfId,
            reason: 'resolved_pending_sideDialog_reply',
            sideDialogId: sideDialogId.selfId,
            callType,
            callId: resolvedCallId,
            callSiteCourse: result.callSiteCourse,
            callSiteGenseq: result.callSiteGenseq,
            batchId: result.batchId,
            resolvedCallIds: result.resolvedCallIds,
            triggerCallId: resolvedCallId,
          },
          source: 'kernel_driver_supply_response_parent_revive',
          reason: `dispatch_batch_resolved:type_${callType}:c${result.callSiteCourse}:g${result.callSiteGenseq}`,
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
  target: CalleeReplyTarget;
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  directFallbackSource?: 'saying' | 'thinking_only';
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

  const callerDialog = await resolveCallerDialogBySelfId(sideDialog, target.callerDialogId);
  if (!callerDialog) {
    return false;
  }
  if (
    !(await ensureDialogFreshOrDiscard(
      callerDialog,
      'supplySideDialogResponseToSpecificAskerIfPendingV2:caller',
    ))
  ) {
    return false;
  }

  const activeCalleeDispatches = await DialogPersistence.loadActiveCalleeDispatches(
    callerDialog.id,
    callerDialog.status,
  );
  const activeCalleeDispatch = activeCalleeDispatches.find(
    (dispatch) =>
      dispatch.calleeDialogId === sideDialog.id.selfId && dispatch.callId === target.callId,
  );
  if (!activeCalleeDispatch) {
    return false;
  }
  if (activeCalleeDispatch.callType !== target.callType) {
    log.warn(
      'Reply target callType does not match pending callType; skipping stale reply target',
      undefined,
      {
        rootId: sideDialog.mainDialog.id.rootId,
        sideDialogId: sideDialog.id.selfId,
        callerDialogId: callerDialog.id.selfId,
        targetCallType: target.callType,
        activeCalleeCallType: activeCalleeDispatch.callType,
      },
    );
    return false;
  }
  if (activeCalleeDispatch.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: sideDialog.id,
      callId: activeCalleeDispatch.callId,
      status: sideDialog.status,
    });
    if (!assignmentAnchorRef) {
      log.debug(
        'Skip Type B response supply before updated assignment is rendered locally',
        undefined,
        {
          rootId: sideDialog.mainDialog.id.rootId,
          sideDialogId: sideDialog.id.selfId,
          callerDialogId: callerDialog.id.selfId,
          callId: activeCalleeDispatch.callId,
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
          callerDialogId: callerDialog.id.selfId,
          callId: activeCalleeDispatch.callId,
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
    parentDialog: callerDialog,
    sideDialogId: sideDialog.id,
    responseText,
    sideDialog,
    callType: activeCalleeDispatch.callType,
    callId: target.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    directFallbackSource: args.directFallbackSource,
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
  directFallbackSource?: 'saying' | 'thinking_only';
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

  const askerDialog = await resolveCallerDialogBySelfId(sideDialog, assignment.askerDialogId);
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

  const activeCalleeDispatches = await DialogPersistence.loadActiveCalleeDispatches(
    askerDialog.id,
    askerDialog.status,
  );
  const activeCalleeDispatch = activeCalleeDispatches.find(
    (dispatch) =>
      dispatch.calleeDialogId === sideDialog.id.selfId && dispatch.callId === assignment.callId,
  );
  if (!activeCalleeDispatch) {
    return false;
  }
  if (activeCalleeDispatch.callType === 'B') {
    const assignmentAnchorRef = await resolveLatestAssignmentAnchorRef({
      calleeDialogId: sideDialog.id,
      callId: activeCalleeDispatch.callId,
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
          callId: activeCalleeDispatch.callId,
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
          callId: activeCalleeDispatch.callId,
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
    callType: activeCalleeDispatch.callType,
    callId: assignment.callId,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    directFallbackSource: args.directFallbackSource,
    replyResolution: args.replyResolution,
    calleeResponseRef: { course: sideDialog.currentCourse, genseq: responseGenseq },
    scheduleDrive,
  });
  return true;
}
