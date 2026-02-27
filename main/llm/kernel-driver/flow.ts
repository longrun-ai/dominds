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
import { LlmConfig } from '../client';
import { driveDialogStreamCore } from './engine';
import { buildDriverV2Policy, validateDriverV2PolicyInvariants } from './guardrails';
import {
  consumeCriticalCountdown,
  decideDriverV2ContextHealth,
  DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCautionRemediationCadenceGenerations,
  resolveCriticalCountdownRemaining,
} from './health';
import type { ScheduleDriveFn, SubdialogReplyTarget } from './subdialog';
import {
  supplySubdialogResponseToAssignedCallerIfPendingV2,
  supplySubdialogResponseToSpecificCallerIfPendingV2,
} from './subdialog';
import type {
  DriverV2CoreResult,
  DriverV2DriveArgs,
  DriverV2DriveInvoker,
  DriverV2DriveResult,
  DriverV2DriveScheduler,
  DriverV2HumanPrompt,
  DriverV2RunControl,
  DriverV2RuntimeState,
} from './types';

type UpNextPrompt = {
  prompt: string;
  msgId: string;
  grammar?: DriverV2HumanPrompt['grammar'];
  userLanguageCode?: string;
  q4hAnswerCallIds?: string[];
  runControl?: DriverV2RunControl;
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
    runControl: upNext.runControl,
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
    const policyResult = validateDriverV2PolicyInvariants(policy, getWorkLanguage());
    if (!policyResult.ok) {
      throw new Error(`driver-v2 policy invariant violation: ${policyResult.detail}`);
    }

    const contextHealth = dialog.getLastContextHealth();
    const hasQueuedUpNext = dialog.hasUpNext();
    const provider = policy.effectiveAgent.provider ?? minds.team.memberDefaults.provider;
    const model = policy.effectiveAgent.model ?? minds.team.memberDefaults.model;
    let cautionRemediationCadenceGenerations =
      resolveCautionRemediationCadenceGenerations(undefined);
    if (provider && model) {
      const llmCfg = await LlmConfig.load();
      const providerCfg = llmCfg.getProvider(provider);
      cautionRemediationCadenceGenerations = resolveCautionRemediationCadenceGenerations(
        providerCfg?.models[model]?.caution_remediation_cadence_generations,
      );
    }
    const criticalCountdownRemaining = resolveCriticalCountdownRemaining(
      dialog.id.key(),
      contextHealth,
    );
    const healthDecision = decideDriverV2ContextHealth({
      dialogKey: dialog.id.key(),
      snapshot: contextHealth,
      hadUserPromptThisGen: humanPrompt !== undefined,
      canInjectPromptThisGen: !hasQueuedUpNext,
      cautionRemediationCadenceGenerations,
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
        'driver-v2 skip subdialog response supply while callee is not finalized',
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
        log.debug('driver-v2 failed to supply subdialog response to specific caller', undefined, {
          calleeId: dialog.id.valueOf(),
          targetOwner: subdialogReplyTarget.ownerDialogId,
          targetOwnerDialogId: subdialogReplyTarget.ownerDialogId,
          targetCallType: subdialogReplyTarget.callType,
          targetCallId: subdialogReplyTarget.callId,
          diagnostics,
        });
      }
    }
  }
}
