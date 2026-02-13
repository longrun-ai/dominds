import { DialogID, SubDialog } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import {
  clearActiveRun,
  createActiveRun,
  getActiveRunSignal,
  hasActiveRun,
} from '../../dialog-run-state';
import { log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import { formatAgentFacingContextHealthV3RemediationGuide } from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import { generateShortId } from '../../shared/utils/id';
import {
  consumeCriticalCountdown,
  decideDriverV2ContextHealth,
  DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCriticalCountdownRemaining,
} from './context-health';
import { driveDialogStreamCoreV2 } from './core';
import { buildDriverV2Policy, validateDriverV2PolicyInvariants } from './policy';
import type { ScheduleDriveFn, SubdialogReplyTarget } from './supdialog-response';
import {
  supplySubdialogResponseToAssignedCallerIfPendingV2,
  supplySubdialogResponseToSpecificCallerIfPendingV2,
} from './supdialog-response';
import type {
  DriverV2CoreResult,
  DriverV2DriveArgs,
  DriverV2DriveInvoker,
  DriverV2DriveResult,
  DriverV2DriveScheduler,
  DriverV2HumanPrompt,
  DriverV2RuntimeState,
} from './types';

type UpNextPrompt = {
  prompt: string;
  msgId: string;
  grammar?: DriverV2HumanPrompt['grammar'];
  userLanguageCode?: string;
  q4hAnswerCallIds?: string[];
};

type PendingDiagnosticsSnapshot =
  | {
      kind: 'loaded';
      ownerDialogId: string;
      status: 'running' | 'completed' | 'archived';
      totalCount: number;
      matchedSubdialogIds: string[];
      records: Array<{
        subdialogId: string;
        callType: 'A' | 'B' | 'C';
        targetAgentId: string;
        sessionSlug?: string;
        createdAt: string;
        tellaskSummary: string;
      }>;
    }
  | {
      kind: 'error';
      ownerDialogId: string;
      status: 'running' | 'completed' | 'archived';
      error: string;
    };

async function loadPendingDiagnosticsSnapshot(args: {
  rootId: string;
  ownerDialogId: string;
  expectedSubdialogId: string;
  status: 'running' | 'completed' | 'archived';
}): Promise<PendingDiagnosticsSnapshot> {
  const ownerDialogIdObj = new DialogID(args.ownerDialogId, args.rootId);
  try {
    const pending = await DialogPersistence.loadPendingSubdialogs(ownerDialogIdObj, args.status);
    const matchedSubdialogIds = pending
      .filter((record) => record.subdialogId === args.expectedSubdialogId)
      .map((record) => record.subdialogId);
    return {
      kind: 'loaded',
      ownerDialogId: args.ownerDialogId,
      status: args.status,
      totalCount: pending.length,
      matchedSubdialogIds,
      records: pending.map((record) => ({
        subdialogId: record.subdialogId,
        callType: record.callType,
        targetAgentId: record.targetAgentId,
        sessionSlug: record.sessionSlug,
        createdAt: record.createdAt,
        tellaskSummary: `${(record.mentionList ?? []).join(' ')} ${record.tellaskContent}`
          .trim()
          .slice(0, 160),
      })),
    };
  } catch (err) {
    return {
      kind: 'error',
      ownerDialogId: args.ownerDialogId,
      status: args.status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveEffectivePrompt(
  dialog: DriverV2DriveArgs[0],
  humanPrompt?: DriverV2HumanPrompt,
): DriverV2HumanPrompt | undefined {
  if (humanPrompt) {
    return humanPrompt;
  }
  const upNext = dialog.takeUpNext() as UpNextPrompt | undefined;
  if (!upNext) {
    return undefined;
  }
  return {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: upNext.grammar ?? 'markdown',
    userLanguageCode:
      upNext.userLanguageCode === 'zh' || upNext.userLanguageCode === 'en'
        ? upNext.userLanguageCode
        : undefined,
    q4hAnswerCallIds: upNext.q4hAnswerCallIds,
  };
}

export async function executeDriveRound(args: {
  runtime: DriverV2RuntimeState;
  driveArgs: DriverV2DriveArgs;
  scheduleDrive: DriverV2DriveScheduler & ScheduleDriveFn;
  driveDialog: DriverV2DriveInvoker;
}): DriverV2DriveResult {
  const [dialog, humanPrompt, waitInQue, driveOptions] = args.driveArgs;
  if (!waitInQue && dialog.isLocked()) {
    throw new Error('Dialog busy driven, see how it proceeded and try again.');
  }

  const release = await dialog.acquire();
  let activeRunPrimed = false;
  let ownsActiveRun = false;
  let interruptedBySignal = false;
  let followUp: UpNextPrompt | undefined;
  let driveResult: DriverV2CoreResult | undefined;
  let subdialogReplyTarget: SubdialogReplyTarget | undefined;
  const allowResumeFromInterrupted =
    driveOptions?.allowResumeFromInterrupted === true || humanPrompt?.origin === 'user';
  try {
    // Prime active-run registration right after acquiring dialog lock so user stop can
    // reliably interrupt queued auto-revive drives during preflight.
    const hadActiveRunBefore = hasActiveRun(dialog.id);
    createActiveRun(dialog.id);
    activeRunPrimed = true;
    ownsActiveRun = !hadActiveRunBefore;

    // "dead" is irreversible for subdialogs. Skip drive if marked dead.
    try {
      const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
      if (
        dialog.id.selfId !== dialog.id.rootId &&
        latest &&
        latest.runState &&
        latest.runState.kind === 'dead'
      ) {
        return;
      }
      if (latest && latest.runState && latest.runState.kind === 'proceeding_stop_requested') {
        log.debug('driver-v2 skip drive while stop request is still being processed', undefined, {
          dialogId: dialog.id.valueOf(),
          reason: latest.runState.reason,
        });
        return;
      }
      if (
        latest &&
        latest.runState &&
        latest.runState.kind === 'interrupted' &&
        !allowResumeFromInterrupted
      ) {
        log.debug(
          'driver-v2 skip drive for interrupted dialog without explicit resume/user prompt',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: latest.runState.reason,
          },
        );
        return;
      }
    } catch (err) {
      log.warn('driver-v2 failed to check runState before drive; proceeding best-effort', err, {
        dialogId: dialog.id.valueOf(),
      });
    }

    // Queued/auto drive (without fresh human input) must not proceed while dialog is
    // suspended by pending Q4H or subdialogs. This prevents duplicate generations when
    // multiple wake-ups race around the same subdialog completion boundary.
    if (!humanPrompt) {
      const suspension = await dialog.getSuspensionStatus();
      if (!suspension.canDrive) {
        const lastTrigger = globalDialogRegistry.getLastDriveTrigger(dialog.id.rootId);
        const lastTriggerAgeMs =
          lastTrigger !== undefined ? Math.max(0, Date.now() - lastTrigger.emittedAtMs) : undefined;
        log.debug('driver-v2 skip queued auto-drive while dialog is suspended', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          waitInQue,
          hasQueuedUpNext: dialog.hasUpNext(),
          waitingQ4H: suspension.q4h,
          waitingSubdialogs: suspension.subdialogs,
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousNeedsDrive: lastTrigger.previousNeedsDrive,
                nextNeedsDrive: lastTrigger.nextNeedsDrive,
              }
            : null,
        });
        return;
      }
    }

    const minds = await loadAgentMinds(dialog.agentId, dialog);
    const policy = buildDriverV2Policy({
      dlg: dialog,
      agent: minds.agent,
      systemPrompt: minds.systemPrompt,
      agentTools: minds.agentTools,
      language: getWorkLanguage(),
    });
    const validation = validateDriverV2PolicyInvariants(policy, getWorkLanguage());
    if (!validation.ok) {
      throw new Error(`driver-v2 policy invariant violation: ${validation.detail}`);
    }

    const snapshot = dialog.getLastContextHealth();
    const hasQueuedUpNext = dialog.hasUpNext();
    const criticalCountdownRemaining = resolveCriticalCountdownRemaining(dialog.id.key(), snapshot);
    const healthDecision = decideDriverV2ContextHealth({
      snapshot,
      hadUserPromptThisGen: humanPrompt !== undefined,
      criticalCountdownRemaining,
    });
    if (healthDecision.kind === 'suspend') {
      return;
    }

    let healthPrompt: DriverV2HumanPrompt | undefined;
    if (healthDecision.kind === 'continue') {
      if (healthDecision.reason === 'critical_force_new_course') {
        const language = getWorkLanguage();
        const newCoursePrompt =
          language === 'zh'
            ? '系统因上下文已告急（critical）而自动开启新一程对话，请继续推进任务。'
            : 'System auto-started a new dialog course because context health is critical. Please continue the task.';
        await dialog.startNewCourse(newCoursePrompt);
        dialog.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
        resetContextHealthRoundState(dialog.id.key());
      } else if (!hasQueuedUpNext) {
        const language = getWorkLanguage();
        const guideText =
          healthDecision.reason === 'caution_soft_remediation'
            ? formatAgentFacingContextHealthV3RemediationGuide(language, {
                kind: 'caution',
                mode: 'soft',
              })
            : formatAgentFacingContextHealthV3RemediationGuide(language, {
                kind: 'critical',
                mode: 'countdown',
                promptsRemainingAfterThis: consumeCriticalCountdown(dialog.id.key()),
                promptsTotal: DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
              });
        healthPrompt = {
          content: guideText,
          msgId: generateShortId(),
          grammar: 'markdown',
          userLanguageCode: language,
        };
      }
    }

    args.runtime.driveCount += 1;
    args.runtime.totalGenIterations += 1;
    args.runtime.usedLegacyDriveCore = false;

    const promptForCore =
      healthDecision.kind === 'continue' && healthDecision.reason === 'critical_force_new_course'
        ? undefined
        : (healthPrompt ?? humanPrompt);
    const effectivePrompt = resolveEffectivePrompt(dialog, promptForCore);
    subdialogReplyTarget = effectivePrompt?.subdialogReplyTarget;
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dialog.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    driveResult = await driveDialogStreamCoreV2(dialog, effectivePrompt, driveOptions, {
      scheduleDrive: args.scheduleDrive,
      driveDialog: args.driveDialog,
    });
    interruptedBySignal = getActiveRunSignal(dialog.id)?.aborted === true;
    if (!interruptedBySignal) {
      followUp = dialog.takeUpNext() as UpNextPrompt | undefined;
    }
  } finally {
    if (activeRunPrimed && ownsActiveRun) {
      clearActiveRun(dialog.id);
    }
    release();
  }

  if (
    dialog instanceof SubDialog &&
    driveResult &&
    !interruptedBySignal &&
    driveResult.lastAssistantSayingContent !== null
  ) {
    if (
      typeof driveResult.lastFunctionCallGenseq === 'number' &&
      Number.isFinite(driveResult.lastFunctionCallGenseq) &&
      driveResult.lastFunctionCallGenseq > 0 &&
      (typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
        !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
        driveResult.lastAssistantSayingGenseq <= driveResult.lastFunctionCallGenseq)
    ) {
      // Any function call means execution is still in-progress. Only supply when the callee
      // has produced a newer assistant saying after the latest function call.
      log.debug(
        'driver-v2 skip subdialog response supply because latest saying is not after function calls',
        undefined,
        {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          lastAssistantSayingGenseq: driveResult.lastAssistantSayingGenseq,
          lastFunctionCallGenseq: driveResult.lastFunctionCallGenseq,
        },
      );
    } else {
      const suspension = await dialog.getSuspensionStatus();
      if (!suspension.canDrive || followUp !== undefined) {
        log.debug(
          'driver-v2 skip subdialog response supply while callee is not finalized',
          undefined,
          {
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
            waitingQ4H: suspension.q4h,
            waitingSubdialogs: suspension.subdialogs,
            hasFollowUp: followUp !== undefined,
          },
        );
      } else {
        if (
          typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
          !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
          driveResult.lastAssistantSayingGenseq <= 0
        ) {
          throw new Error(
            `Subdialog response supply invariant violation: missing lastAssistantSayingGenseq for dialog=${dialog.id.valueOf()}`,
          );
        }
        const responseGenseq = Math.floor(driveResult.lastAssistantSayingGenseq);
        let supplied = false;
        if (subdialogReplyTarget) {
          supplied = await supplySubdialogResponseToSpecificCallerIfPendingV2({
            subdialog: dialog,
            responseText: driveResult.lastAssistantSayingContent,
            responseGenseq,
            target: subdialogReplyTarget,
            scheduleDrive: args.scheduleDrive,
          });
          if (!supplied) {
            supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
              subdialog: dialog,
              responseText: driveResult.lastAssistantSayingContent,
              responseGenseq,
              scheduleDrive: args.scheduleDrive,
            });
          }
        } else {
          supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
            subdialog: dialog,
            responseText: driveResult.lastAssistantSayingContent,
            responseGenseq,
            scheduleDrive: args.scheduleDrive,
          });
        }

        if (!supplied && subdialogReplyTarget) {
          const assignment = dialog.assignmentFromSup;
          const ownerDialogIds = Array.from(
            new Set([subdialogReplyTarget.ownerDialogId, assignment.callerDialogId]),
          );
          const pendingSnapshots = await Promise.all(
            ownerDialogIds.map(async (ownerDialogId) =>
              loadPendingDiagnosticsSnapshot({
                rootId: dialog.id.rootId,
                ownerDialogId,
                expectedSubdialogId: dialog.id.selfId,
                status: dialog.status,
              }),
            ),
          );
          const streamErr =
            `Subdialog response supply invariant violation: ` +
            `subdialog=${dialog.id.selfId} root=${dialog.id.rootId} ` +
            `targetOwner=${subdialogReplyTarget.ownerDialogId} targetCallType=${subdialogReplyTarget.callType} targetCallId=${subdialogReplyTarget.callId} ` +
            `assignmentCaller=${assignment.callerDialogId} assignmentCallId=${assignment.callId} ` +
            `pendingSnapshots=${pendingSnapshots.length}`;
          try {
            await dialog.streamError(streamErr);
          } catch (streamErrPost) {
            log.warn(
              'driver-v2 failed to emit stream_error_evt for response supply violation',
              undefined,
              {
                rootId: dialog.id.rootId,
                selfId: dialog.id.selfId,
                targetOwnerDialogId: subdialogReplyTarget.ownerDialogId,
                targetCallType: subdialogReplyTarget.callType,
                targetCallId: subdialogReplyTarget.callId,
                assignmentCallerDialogId: assignment.callerDialogId,
                assignmentCallId: assignment.callId,
                pendingSnapshots,
                error:
                  streamErrPost instanceof Error ? streamErrPost.message : String(streamErrPost),
              },
            );
          }
          log.error(
            'driver-v2 subdialog produced response but found no pending caller to supply',
            undefined,
            {
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              targetOwnerDialogId: subdialogReplyTarget.ownerDialogId,
              targetCallType: subdialogReplyTarget.callType,
              targetCallId: subdialogReplyTarget.callId,
              assignmentCallerDialogId: assignment.callerDialogId,
              assignmentCallId: assignment.callId,
              pendingSnapshots,
            },
          );
        }
      }
    }
  }

  if (followUp) {
    args.scheduleDrive(dialog, {
      waitInQue: true,
      humanPrompt: {
        content: followUp.prompt,
        msgId: followUp.msgId,
        grammar: followUp.grammar ?? 'markdown',
        userLanguageCode:
          followUp.userLanguageCode === 'zh' || followUp.userLanguageCode === 'en'
            ? followUp.userLanguageCode
            : undefined,
      },
    });
  }
}
