import { SubDialog } from '../../dialog';
import { clearActiveRun, createActiveRun } from '../../dialog-run-state';
import { log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import { getWorkLanguage } from '../../shared/runtime-language';
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

    const healthDecision = decideDriverV2ContextHealth({
      snapshot: dialog.getLastContextHealth(),
      hadUserPromptThisGen: args.driveArgs[1] !== undefined,
      criticalCountdownRemaining: 1,
    });
    if (healthDecision.kind === 'suspend') {
      return;
    }

    args.runtime.driveCount += 1;
    args.runtime.totalGenIterations += 1;
    args.runtime.usedLegacyDriveCore = false;

    const effectivePrompt = resolveEffectivePrompt(dialog, humanPrompt);
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
