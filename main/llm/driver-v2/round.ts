import { SubDialog } from '../../dialog';
import { clearActiveRun, createActiveRun } from '../../dialog-run-state';
import { log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import { formatUserFacingContextHealthV3RemediationGuide } from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { ContextHealthLevel, ContextHealthSnapshot } from '../../shared/types/context-health';
import { generateShortId } from '../../shared/utils/id';
import { decideDriverV2ContextHealth } from './context-health';
import { driveDialogStreamCoreV2 } from './core';
import { buildDriverV2Policy, validateDriverV2PolicyInvariants } from './policy';
import type { ScheduleDriveFn, SubdialogReplyTarget } from './supdialog-response';
import {
  supplySubdialogResponseToAssignedCallerIfPendingV2,
  supplySubdialogResponseToSpecificCallerIfPendingV2,
} from './supdialog-response';
import type {
  DriverV2DriveArgs,
  DriverV2DriveInvoker,
  DriverV2DriveResult,
  DriverV2DriveScheduler,
  DriverV2HumanPrompt,
  DriverV2RuntimeState,
} from './types';

type UpNextPrompt = { prompt: string; msgId: string; userLanguageCode?: string };
const defaultCriticalCountdownGenerations = 5;

type DriverV2ContextHealthRoundState = {
  lastSeenLevel?: ContextHealthLevel;
  criticalCountdownRemaining?: number;
};

const contextHealthRoundStateByDialogKey: Map<string, DriverV2ContextHealthRoundState> = new Map();

function getContextHealthRoundState(dialog: DriverV2DriveArgs[0]): DriverV2ContextHealthRoundState {
  const key = dialog.id.key();
  const existing = contextHealthRoundStateByDialogKey.get(key);
  if (existing) {
    return existing;
  }
  const created: DriverV2ContextHealthRoundState = {};
  contextHealthRoundStateByDialogKey.set(key, created);
  return created;
}

function resetContextHealthRoundState(dialog: DriverV2DriveArgs[0]): void {
  contextHealthRoundStateByDialogKey.delete(dialog.id.key());
}

function resolveCriticalCountdownRemaining(
  dialog: DriverV2DriveArgs[0],
  snapshot: ContextHealthSnapshot | undefined,
): number {
  if (!snapshot || snapshot.kind !== 'available') {
    resetContextHealthRoundState(dialog);
    return defaultCriticalCountdownGenerations;
  }

  if (snapshot.level !== 'critical') {
    if (snapshot.level === 'healthy') {
      resetContextHealthRoundState(dialog);
      return defaultCriticalCountdownGenerations;
    }
    const state = getContextHealthRoundState(dialog);
    state.lastSeenLevel = snapshot.level;
    state.criticalCountdownRemaining = undefined;
    return defaultCriticalCountdownGenerations;
  }

  const state = getContextHealthRoundState(dialog);
  if (
    state.lastSeenLevel !== 'critical' ||
    typeof state.criticalCountdownRemaining !== 'number' ||
    !Number.isFinite(state.criticalCountdownRemaining)
  ) {
    state.lastSeenLevel = 'critical';
    state.criticalCountdownRemaining = defaultCriticalCountdownGenerations;
  }

  const remaining = Math.floor(state.criticalCountdownRemaining);
  return remaining > 0 ? remaining : 0;
}

function consumeCriticalCountdown(dialog: DriverV2DriveArgs[0]): number {
  const state = getContextHealthRoundState(dialog);
  const currentRaw =
    typeof state.criticalCountdownRemaining === 'number' &&
    Number.isFinite(state.criticalCountdownRemaining)
      ? Math.floor(state.criticalCountdownRemaining)
      : defaultCriticalCountdownGenerations;
  const current = currentRaw > 0 ? currentRaw : 0;
  const next = Math.max(0, current - 1);
  state.lastSeenLevel = 'critical';
  state.criticalCountdownRemaining = next;
  return next;
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
    grammar: 'markdown',
    userLanguageCode:
      upNext.userLanguageCode === 'zh' || upNext.userLanguageCode === 'en'
        ? upNext.userLanguageCode
        : undefined,
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
  let activeRunHandedToCore = false;
  let followUp: UpNextPrompt | undefined;
  let driveResult:
    | {
        lastAssistantSayingContent: string | null;
        interrupted: boolean;
      }
    | undefined;
  let subdialogReplyTarget: SubdialogReplyTarget | undefined;
  const allowResumeFromInterrupted =
    driveOptions?.allowResumeFromInterrupted === true || humanPrompt?.origin === 'user';
  try {
    // Prime active-run registration right after acquiring dialog lock so user stop can
    // reliably interrupt queued auto-revive drives during preflight.
    createActiveRun(dialog.id);
    activeRunPrimed = true;

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
        log.info('driver-v2 skip drive while stop request is still being processed', undefined, {
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
        log.info(
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
    const criticalCountdownRemaining = resolveCriticalCountdownRemaining(dialog, snapshot);
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
        resetContextHealthRoundState(dialog);
      } else if (!hasQueuedUpNext) {
        const language = getWorkLanguage();
        const guideText =
          healthDecision.reason === 'caution_soft_remediation'
            ? formatUserFacingContextHealthV3RemediationGuide(language, {
                kind: 'caution',
                mode: 'soft',
              })
            : formatUserFacingContextHealthV3RemediationGuide(language, {
                kind: 'critical',
                mode: 'countdown',
                promptsRemainingAfterThis: consumeCriticalCountdown(dialog),
                promptsTotal: defaultCriticalCountdownGenerations,
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
    activeRunHandedToCore = true;
    if (!driveResult.interrupted) {
      followUp = dialog.takeUpNext() as UpNextPrompt | undefined;
    }
  } finally {
    if (activeRunPrimed && !activeRunHandedToCore) {
      clearActiveRun(dialog.id);
    }
    release();
  }

  if (followUp) {
    args.scheduleDrive(dialog, {
      waitInQue: true,
      humanPrompt: {
        content: followUp.prompt,
        msgId: followUp.msgId,
        grammar: 'markdown',
        userLanguageCode:
          followUp.userLanguageCode === 'zh' || followUp.userLanguageCode === 'en'
            ? followUp.userLanguageCode
            : undefined,
      },
    });
    return;
  }

  if (
    dialog instanceof SubDialog &&
    driveResult &&
    !driveResult.interrupted &&
    driveResult.lastAssistantSayingContent !== null
  ) {
    const suspension = await dialog.getSuspensionStatus();
    if (!suspension.canDrive) {
      log.info('driver-v2 skip supplying subdialog response because dialog is still suspended', {
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        waitingQ4H: suspension.q4h,
        waitingSubdialogs: suspension.subdialogs,
      });
      return;
    }

    if (subdialogReplyTarget) {
      await supplySubdialogResponseToSpecificCallerIfPendingV2({
        subdialog: dialog,
        responseText: driveResult.lastAssistantSayingContent,
        target: subdialogReplyTarget,
        scheduleDrive: args.scheduleDrive,
      });
      return;
    }

    await supplySubdialogResponseToAssignedCallerIfPendingV2({
      subdialog: dialog,
      responseText: driveResult.lastAssistantSayingContent,
      scheduleDrive: args.scheduleDrive,
    });
  }
}
