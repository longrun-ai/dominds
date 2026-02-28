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
import { getWorkLanguage } from '../../shared/runtime-language';
import { driveDialogStreamCore } from './drive';
import { buildKernelDriverPolicy, validateKernelDriverPolicyInvariants } from './guardrails';
import type { ScheduleDriveFn, SubdialogReplyTarget } from './subdialog';
import {
  supplySubdialogResponseToAssignedCallerIfPendingV2,
  supplySubdialogResponseToSpecificCallerIfPendingV2,
} from './subdialog';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveInvoker,
  KernelDriverDriveResult,
  KernelDriverDriveScheduler,
  KernelDriverHumanPrompt,
  KernelDriverRunControl,
  KernelDriverRuntimeState,
} from './types';

type UpNextPrompt = {
  prompt: string;
  msgId: string;
  grammar?: KernelDriverHumanPrompt['grammar'];
  userLanguageCode?: string;
  q4hAnswerCallIds?: string[];
  runControl?: KernelDriverRunControl;
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
  dialog: KernelDriverDriveArgs[0],
  humanPrompt?: KernelDriverHumanPrompt,
): KernelDriverHumanPrompt | undefined {
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
    runControl: upNext.runControl,
  };
}

export async function executeDriveRound(args: {
  runtime: KernelDriverRuntimeState;
  driveArgs: KernelDriverDriveArgs;
  scheduleDrive: KernelDriverDriveScheduler & ScheduleDriveFn;
  driveDialog: KernelDriverDriveInvoker;
}): KernelDriverDriveResult {
  const [dialog, humanPrompt, waitInQue, driveOptions] = args.driveArgs;
  if (!waitInQue && dialog.isLocked()) {
    throw new Error('Dialog busy driven, see how it proceeded and try again.');
  }

  const release = await dialog.acquire();
  let activeRunPrimed = false;
  let ownsActiveRun = false;
  let interruptedBySignal = false;
  let followUp: UpNextPrompt | undefined;
  let driveResult: KernelDriverCoreResult | undefined;
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
        log.debug(
          'kernel-driver skip drive while stop request is still being processed',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: latest.runState.reason,
          },
        );
        return;
      }
      if (
        latest &&
        latest.runState &&
        latest.runState.kind === 'interrupted' &&
        !allowResumeFromInterrupted
      ) {
        log.debug(
          'kernel-driver skip drive for interrupted dialog without explicit resume/user prompt',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: latest.runState.reason,
          },
        );
        return;
      }
    } catch (err) {
      log.warn('kernel-driver failed to check runState before drive; proceeding best-effort', err, {
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
        log.debug('kernel-driver skip queued auto-drive while dialog is suspended', undefined, {
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
    const policy = buildKernelDriverPolicy({
      dlg: dialog,
      agent: minds.agent,
      systemPrompt: minds.systemPrompt,
      agentTools: minds.agentTools,
      language: getWorkLanguage(),
    });
    const policyResult = validateKernelDriverPolicyInvariants(policy, getWorkLanguage());
    if (!policyResult.ok) {
      throw new Error(`kernel-driver policy invariant violation: ${policyResult.detail}`);
    }

    args.runtime.driveCount += 1;
    args.runtime.totalGenIterations += 1;
    args.runtime.usedLegacyDriveCore = false;

    const effectivePrompt = resolveEffectivePrompt(dialog, humanPrompt);
    subdialogReplyTarget = effectivePrompt?.subdialogReplyTarget;
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dialog.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    driveResult = await driveDialogStreamCore(dialog, effectivePrompt, driveOptions, {
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
    const hasFollowUp = followUp !== undefined;
    const suspension = await dialog.getSuspensionStatus();
    const hasInProgressFunctionCall =
      typeof driveResult.lastFunctionCallGenseq === 'number' &&
      Number.isFinite(driveResult.lastFunctionCallGenseq) &&
      driveResult.lastFunctionCallGenseq > 0 &&
      (typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
        !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
        driveResult.lastAssistantSayingGenseq <= driveResult.lastFunctionCallGenseq);

    let allowEarlySupplyForNestedTellask = false;
    if (hasInProgressFunctionCall && suspension.subdialogs && !suspension.q4h && !hasFollowUp) {
      const lastFuncCallMsg = (() => {
        for (let i = dialog.msgs.length - 1; i >= 0; i -= 1) {
          const msg = dialog.msgs[i];
          if (msg && msg.type === 'func_call_msg') {
            return msg;
          }
        }
        return undefined;
      })();
      if (
        lastFuncCallMsg &&
        typeof driveResult.lastFunctionCallGenseq === 'number' &&
        Number.isFinite(driveResult.lastFunctionCallGenseq) &&
        lastFuncCallMsg.genseq === Math.floor(driveResult.lastFunctionCallGenseq) &&
        (lastFuncCallMsg.name === 'tellask' ||
          lastFuncCallMsg.name === 'tellaskSessionless' ||
          lastFuncCallMsg.name === 'tellaskBack')
      ) {
        allowEarlySupplyForNestedTellask = true;
      }
    }

    if (hasFollowUp || suspension.q4h) {
      log.debug(
        'kernel-driver skip subdialog response supply while callee is not finalized',
        undefined,
        {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          waitingQ4H: suspension.q4h,
          waitingSubdialogs: suspension.subdialogs,
          hasFollowUp,
        },
      );
    } else if (hasInProgressFunctionCall && !allowEarlySupplyForNestedTellask) {
      // Any function call means execution is still in-progress. Only supply when the callee
      // has produced a newer assistant saying after the latest function call.
      log.debug(
        'kernel-driver skip subdialog response supply because latest saying is not after function calls',
        undefined,
        {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          lastAssistantSayingGenseq: driveResult.lastAssistantSayingGenseq,
          lastFunctionCallGenseq: driveResult.lastFunctionCallGenseq,
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
        const diagnostics = await loadPendingDiagnosticsSnapshot({
          rootId: dialog.id.rootId,
          ownerDialogId: subdialogReplyTarget.ownerDialogId,
          expectedSubdialogId: dialog.id.selfId,
          status: dialog.status,
        });
        log.debug(
          'kernel-driver failed to supply subdialog response to specific caller',
          undefined,
          {
            calleeId: dialog.id.valueOf(),
            targetOwner: subdialogReplyTarget.ownerDialogId,
            targetOwnerDialogId: subdialogReplyTarget.ownerDialogId,
            targetCallType: subdialogReplyTarget.callType,
            targetCallId: subdialogReplyTarget.callId,
            diagnostics,
          },
        );
      }
    }
  }
}
