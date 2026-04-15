import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import {
  applyRegisteredAppDialogRunControls,
  renderAppRunControlBlockForPreDrive,
} from '../../apps/run-control';
import { DialogID, SubDialog, type Dialog } from '../../dialog';
import {
  broadcastDisplayStateMarker,
  clearActiveRun,
  createActiveRun,
  getActiveRunSignal,
  getStopRequestedReason,
  hasActiveRun,
  setDialogDisplayState,
} from '../../dialog-display-state';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { doesInterruptionReasonRequireExplicitResume } from '../../dialog-interruption';
import { postDialogEvent } from '../../evt-registry';
import { log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatNewCourseStartPrompt,
} from '../../runtime/driver-messages';
import {
  buildUserInterjectionPauseStopReason,
  isUserInterjectionPauseStopReason,
} from '../../runtime/interjection-pause-stop';
import { buildReplyToolReminderText } from '../../runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../runtime/work-language';
import { LlmConfig } from '../client';
import {
  consumeCriticalCountdown,
  decideKernelDriverContextHealth,
  KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCautionRemediationCadenceGenerations,
  resolveCriticalCountdownRemaining,
} from './context-health';
import { driveDialogStreamCore } from './drive';
import { buildKernelDriverPolicy, validateKernelDriverPolicyInvariants } from './guardrails';
import {
  buildReplyObligationReassertionPrompt,
  resolvePromptReplyGuidance,
  resolveReplyTargetAgentId,
} from './reply-guidance';
import type { ScheduleDriveFn, SubdialogReplyTarget } from './subdialog';
import {
  supplySubdialogResponseToAssignedCallerIfPendingV2,
  supplySubdialogResponseToSpecificCallerIfPendingV2,
} from './subdialog';
import {
  deliverTellaskBackReplyFromDirective,
  loadLatestActiveTellaskReplyDirective,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveInvoker,
  KernelDriverDriveOptions,
  KernelDriverDriveResult,
  KernelDriverDriveScheduler,
  KernelDriverDriveSource,
  KernelDriverHumanPrompt,
  KernelDriverRunControl,
  KernelDriverRuntimeState,
} from './types';

type UpNextPrompt = {
  prompt: string;
  msgId: string;
  grammar?: KernelDriverHumanPrompt['grammar'];
  userLanguageCode?: string;
  origin: KernelDriverHumanPrompt['origin'];
  q4hAnswerCallId?: string;
  tellaskReplyDirective?: KernelDriverHumanPrompt['tellaskReplyDirective'];
  skipTaskdoc?: boolean;
  subdialogReplyTarget?: KernelDriverHumanPrompt['subdialogReplyTarget'];
  runControl?: KernelDriverRunControl;
};

const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';

function isReplyToolReminderPrompt(prompt: KernelDriverHumanPrompt | undefined): boolean {
  return (
    typeof prompt?.content === 'string' &&
    (prompt.content.startsWith(REPLY_TOOL_REMINDER_PREFIX_EN) ||
      prompt.content.startsWith(REPLY_TOOL_REMINDER_PREFIX_ZH))
  );
}

function isIgnorablePostResponseAnchorTailEvent(type: string): boolean {
  return type === 'tellask_reply_resolution_record' || type === 'gen_finish_record';
}

async function buildReplyToolReminderPrompt(args: {
  dlg: Dialog;
  directive: NonNullable<KernelDriverHumanPrompt['tellaskReplyDirective']>;
  language: 'zh' | 'en';
}): Promise<string> {
  return buildReplyToolReminderText({
    language: args.language,
    directive: args.directive,
    prefix: args.language === 'zh' ? REPLY_TOOL_REMINDER_PREFIX_ZH : REPLY_TOOL_REMINDER_PREFIX_EN,
    replyTargetAgentId: await resolveReplyTargetAgentId({
      dlg: args.dlg,
      directive: args.directive,
    }),
  });
}

async function loadFreshSuspensionStatusFromPersistence(dialog: Dialog): Promise<{
  q4h: boolean;
  subdialogs: boolean;
  blockingSubdialogs: boolean;
  canDrive: boolean;
}> {
  const q4h = await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status);
  const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(dialog.id, dialog.status);
  const hasQ4H = q4h.length > 0;
  const hasSubdialogs = pendingSubdialogs.length > 0;
  return {
    q4h: hasQ4H,
    subdialogs: hasSubdialogs,
    blockingSubdialogs: hasSubdialogs,
    canDrive: !hasQ4H && !hasSubdialogs,
  };
}

function buildDisplayStateFromSuspensionStatus(args: {
  q4h: boolean;
  subdialogs: boolean;
}): DialogDisplayState {
  if (args.q4h && args.subdialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } };
  }
  if (args.q4h) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (args.subdialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } };
  }
  return { kind: 'idle_waiting_user' };
}

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

async function clearConsumedDeferredRootQueueIfIdle(dialog: Dialog): Promise<void> {
  if (dialog.id.selfId !== dialog.id.rootId) {
    return;
  }
  if (!globalDialogRegistry.get(dialog.id.rootId)) {
    return;
  }
  const suspension = await dialog.getSuspensionStatus();
  if (dialog.hasUpNext() || !suspension.canDrive) {
    return;
  }
  const persistedNeedsDrive = await DialogPersistence.getNeedsDrive(dialog.id);
  const registryNeedsDrive = globalDialogRegistry.isMarkedNeedingDrive(dialog.id.rootId);
  if (!registryNeedsDrive && !persistedNeedsDrive) {
    return;
  }
  try {
    await DialogPersistence.setNeedsDrive(dialog.id, false, dialog.status);
  } catch (error: unknown) {
    log.error('kernel-driver failed to persist consumed deferred root queue cleanup', error, {
      dialogId: dialog.id.valueOf(),
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
    });
    return;
  }
  globalDialogRegistry.markNotNeedingDrive(dialog.id.rootId, {
    source: 'kernel_driver_flow_tail',
    reason: 'root_idle_after_consuming_deferred_queue',
  });
}

function hasNoPromptSubdialogResumeEntitlement(
  dialog: SubDialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const entitlement = driveOptions?.noPromptSubdialogResumeEntitlement;
  if (!entitlement) {
    return false;
  }
  return entitlement.ownerDialogId === dialog.id.selfId;
}

function resolveDriveRequestSource(
  humanPrompt: KernelDriverHumanPrompt | undefined,
  driveOptions: KernelDriverDriveOptions | undefined,
): KernelDriverDriveSource {
  if (driveOptions?.source) {
    return driveOptions.source;
  }
  if (humanPrompt?.origin === 'user') {
    return 'ws_user_message';
  }
  return 'unspecified';
}

function resolveAppRunControlSource(args: {
  humanPrompt: KernelDriverHumanPrompt | undefined;
  effectivePrompt: KernelDriverHumanPrompt | undefined;
  driveSource: KernelDriverDriveSource;
}): 'drive_dlg_by_user_msg' | 'drive_dialog_by_user_answer' | null {
  if (args.driveSource === 'ws_user_message') {
    return 'drive_dlg_by_user_msg';
  }
  if (args.driveSource === 'ws_user_answer') {
    return 'drive_dialog_by_user_answer';
  }
  const prompt =
    args.humanPrompt?.origin === 'user'
      ? args.humanPrompt
      : args.effectivePrompt?.origin === 'user'
        ? args.effectivePrompt
        : undefined;
  if (!prompt) {
    return null;
  }
  return typeof prompt.q4hAnswerCallId === 'string' && prompt.q4hAnswerCallId.trim() !== ''
    ? 'drive_dialog_by_user_answer'
    : 'drive_dlg_by_user_msg';
}

async function applyRegisteredDialogRunControlsBeforeDrive(args: {
  dialog: KernelDriverDriveArgs[0];
  humanPrompt: KernelDriverHumanPrompt | undefined;
  effectivePrompt: KernelDriverHumanPrompt | undefined;
  driveSource: KernelDriverDriveSource;
  genIterNo: number;
}): Promise<void> {
  const source = resolveAppRunControlSource({
    humanPrompt: args.humanPrompt,
    effectivePrompt: args.effectivePrompt,
    driveSource: args.driveSource,
  });
  if (!source) {
    return;
  }
  const prompt =
    args.humanPrompt?.origin === 'user'
      ? args.humanPrompt
      : args.effectivePrompt?.origin === 'user'
        ? args.effectivePrompt
        : undefined;
  const result = await applyRegisteredAppDialogRunControls({
    dialog: {
      selfId: args.dialog.id.selfId,
      rootId: args.dialog.id.rootId,
    },
    agentId: args.dialog.agentId,
    taskDocPath: args.dialog.taskDocPath,
    genIterNo: args.genIterNo,
    prompt: prompt
      ? {
          content: prompt.content,
          msgId: prompt.msgId,
          grammar: prompt.grammar,
          userLanguageCode: prompt.userLanguageCode ?? getWorkLanguage(),
          origin: prompt.origin,
        }
      : undefined,
    source,
    input: {},
  });
  if (result.kind === 'reject') {
    throw new Error(result.errorText);
  }
  if (result.kind === 'block') {
    throw new Error(renderAppRunControlBlockForPreDrive(result.block));
  }
}

async function inspectNoPromptSubdialogDrive(args: {
  dialog: SubDialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<
  | {
      shouldReject: false;
      source: KernelDriverDriveSource;
      displayState: DialogDisplayState | undefined;
      currentCourse: number;
      lastEvent:
        | {
            type: string;
            anchorRole?: 'assignment' | 'response';
          }
        | undefined;
    }
  | {
      shouldReject: true;
      source: KernelDriverDriveSource;
      rejection:
        | 'finalized_after_response_anchor'
        | 'missing_explicit_interrupted_resume_entitlement';
      displayState: DialogDisplayState | undefined;
      currentCourse: number;
      lastEvent:
        | {
            type: string;
            anchorRole?: 'assignment' | 'response';
          }
        | undefined;
    }
> {
  const source = resolveDriveRequestSource(undefined, args.driveOptions);
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const displayState = latest?.displayState;
  const rawCourse = latest?.currentCourse ?? args.dialog.currentCourse;
  const currentCourse = Number.isFinite(rawCourse) && rawCourse > 0 ? Math.floor(rawCourse) : 1;
  const courseEvents = await DialogPersistence.loadCourseEvents(
    args.dialog.id,
    currentCourse,
    args.dialog.status,
  );
  const rawLastEvent = (() => {
    for (let index = courseEvents.length - 1; index >= 0; index -= 1) {
      const event = courseEvents[index];
      if (!isIgnorablePostResponseAnchorTailEvent(event.type)) {
        return event;
      }
    }
    return courseEvents[courseEvents.length - 1];
  })();
  const lastEvent =
    rawLastEvent?.type === 'tellask_call_anchor_record'
      ? { type: rawLastEvent.type, anchorRole: rawLastEvent.anchorRole }
      : rawLastEvent
        ? { type: rawLastEvent.type }
        : undefined;

  const explicitInterruptedResumeAllowed =
    args.driveOptions?.allowResumeFromInterrupted === true &&
    latest?.executionMarker?.kind === 'interrupted';
  const supplyResponseParentReviveAllowed =
    source === 'kernel_driver_supply_response_parent_revive' &&
    hasNoPromptSubdialogResumeEntitlement(args.dialog, args.driveOptions);
  if (lastEvent?.type === 'tellask_call_anchor_record' && lastEvent.anchorRole === 'response') {
    return {
      shouldReject: true,
      source,
      rejection: 'finalized_after_response_anchor',
      displayState,
      currentCourse,
      lastEvent,
    };
  }
  if (!explicitInterruptedResumeAllowed && !supplyResponseParentReviveAllowed) {
    return {
      shouldReject: true,
      source,
      rejection: 'missing_explicit_interrupted_resume_entitlement',
      displayState,
      currentCourse,
      lastEvent,
    };
  }
  return {
    shouldReject: false,
    source,
    displayState,
    currentCourse,
    lastEvent,
  };
}

async function maybeResolveDeferredReplyReassertionPrompt(
  dialog: KernelDriverDriveArgs[0],
): Promise<KernelDriverHumanPrompt | undefined> {
  const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
    dialog.id,
    dialog.status,
  );
  if (!deferredReplyReassertion) {
    return undefined;
  }
  const activeDirective = await loadLatestActiveTellaskReplyDirective(dialog);
  if (
    !activeDirective ||
    activeDirective.targetCallId !== deferredReplyReassertion.directive.targetCallId
  ) {
    await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
    return undefined;
  }
  // WARNING:
  // `resumeGuideSurfaced` means the reply-obligation reassertion has already been materialized as a
  // runtime guide and injected into both dialog.msgs and persisted course history at blocked
  // Continue time. Once that has happened, later real resume must not emit a second visible prompt:
  // normal context replay is now the source of truth for the model-facing reminder.
  if (deferredReplyReassertion.resumeGuideSurfaced === true) {
    await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
    return undefined;
  }
  await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
  const language = getWorkLanguage();
  return {
    content: await buildReplyObligationReassertionPrompt({
      dlg: dialog,
      directive: deferredReplyReassertion.directive,
      language,
    }),
    msgId: generateShortId(),
    grammar: 'markdown',
    origin: 'runtime',
    userLanguageCode: language,
    tellaskReplyDirective: deferredReplyReassertion.directive,
  };
}

async function maybeSurfaceDeferredReplyReassertionGuideForBlockedContinue(
  dialog: Dialog,
): Promise<void> {
  const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
    dialog.id,
    dialog.status,
  );
  if (!deferredReplyReassertion || deferredReplyReassertion.resumeGuideSurfaced === true) {
    return;
  }
  const activeDirective = await loadLatestActiveTellaskReplyDirective(dialog);
  if (
    !activeDirective ||
    activeDirective.targetCallId !== deferredReplyReassertion.directive.targetCallId
  ) {
    await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
    return;
  }
  const language = getWorkLanguage();
  const content = await buildReplyObligationReassertionPrompt({
    dlg: dialog,
    directive: deferredReplyReassertion.directive,
    language,
  });
  const genseq = dialog.activeGenSeqOrUndefined ?? 1;
  // WARNING:
  // This helper intentionally does three things at once:
  // 1. append the guide into dialog.msgs so an in-memory later resume sees it naturally;
  // 2. persist a runtime_guide_record so reload/replay reconstructs the same context;
  // 3. emit runtime_guide_evt so the user immediately sees the reassertion bubble after Continue.
  //
  // Do not "optimize" this into only an event or only a deferred prompt. The whole point is that
  // once blocked Continue is clicked, the guide becomes a first-class historical context fact and
  // later real driving should need no special duplicate reassertion path.
  await dialog.addChatMessages({
    type: 'transient_guide_msg',
    role: 'assistant',
    content,
  });
  await DialogPersistence.persistRuntimeGuide(dialog, content, genseq);
  postDialogEvent(dialog, {
    type: 'runtime_guide_evt',
    course: dialog.currentCourse,
    genseq,
    content,
  });
  await DialogPersistence.setDeferredReplyReassertion(
    dialog.id,
    {
      reason: 'user_interjection_with_parked_original_task',
      directive: deferredReplyReassertion.directive,
      resumeGuideSurfaced: true,
    },
    dialog.status,
  );
}

async function resolveEffectivePrompt(
  dialog: KernelDriverDriveArgs[0],
  humanPrompt?: KernelDriverHumanPrompt,
): Promise<
  Readonly<{
    prompt: KernelDriverHumanPrompt | undefined;
    fromUpNext: boolean;
  }>
> {
  if (humanPrompt) {
    return { prompt: humanPrompt, fromUpNext: false };
  }
  const upNext = dialog.peekUpNext() as UpNextPrompt | undefined;
  if (!upNext) {
    return {
      prompt: await maybeResolveDeferredReplyReassertionPrompt(dialog),
      fromUpNext: false,
    };
  }
  return {
    fromUpNext: true,
    prompt: {
      content: upNext.prompt,
      msgId: upNext.msgId,
      grammar: upNext.grammar ?? 'markdown',
      origin: upNext.origin,
      userLanguageCode:
        upNext.userLanguageCode === 'zh' || upNext.userLanguageCode === 'en'
          ? upNext.userLanguageCode
          : undefined,
      q4hAnswerCallId: upNext.q4hAnswerCallId,
      tellaskReplyDirective: upNext.tellaskReplyDirective,
      skipTaskdoc: upNext.skipTaskdoc,
      subdialogReplyTarget: upNext.subdialogReplyTarget,
      runControl: upNext.runControl,
    },
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
  let activeTellaskReplyDirective: KernelDriverHumanPrompt['tellaskReplyDirective'] | undefined;
  let activePromptWasReplyToolReminder = false;
  let shouldPauseAfterLocalUserInterjection = false;
  let resumeFromInterjectionPause = false;
  const allowResumeFromInterrupted =
    driveOptions?.allowResumeFromInterrupted === true || humanPrompt?.origin === 'user';
  const driveSource = resolveDriveRequestSource(humanPrompt, driveOptions);
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
        latest.executionMarker &&
        latest.executionMarker.kind === 'dead'
      ) {
        return;
      }
      const stopRequested = getStopRequestedReason(dialog.id);
      if (stopRequested !== undefined) {
        log.debug(
          'kernel-driver skip drive while stop request is still being processed',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: stopRequested,
          },
        );
        return;
      }
      if (
        latest &&
        latest.executionMarker &&
        latest.executionMarker.kind === 'interrupted' &&
        doesInterruptionReasonRequireExplicitResume(latest.executionMarker.reason) &&
        !allowResumeFromInterrupted
      ) {
        log.debug(
          'kernel-driver skip drive for interrupted dialog without explicit resume/user prompt',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: latest.executionMarker.reason,
          },
        );
        return;
      }
      resumeFromInterjectionPause =
        humanPrompt === undefined &&
        allowResumeFromInterrupted &&
        latest?.executionMarker?.kind === 'interrupted' &&
        isUserInterjectionPauseStopReason(latest.executionMarker.reason);
    } catch (err) {
      log.warn(
        'kernel-driver failed to check execution facts before drive; proceeding best-effort',
        err,
        {
          dialogId: dialog.id.valueOf(),
        },
      );
    }

    // Queued/auto drive (without fresh human input) must not proceed while dialog is
    // suspended by pending Q4H or subdialogs. This prevents duplicate generations when
    // multiple wake-ups race around the same subdialog completion boundary.
    if (!humanPrompt) {
      if (dialog instanceof SubDialog && !dialog.hasUpNext()) {
        try {
          const inspection = await inspectNoPromptSubdialogDrive({ dialog, driveOptions });
          if (inspection.shouldReject) {
            log.error('Rejected unexpected no-prompt subdialog drive request', undefined, {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              source: inspection.source,
              reason: driveOptions?.reason ?? null,
              rejection: inspection.rejection,
              allowResumeFromInterrupted: driveOptions?.allowResumeFromInterrupted === true,
              displayState: inspection.displayState ?? null,
              currentCourse: inspection.currentCourse,
              lastEvent: inspection.lastEvent ?? null,
              waitInQue,
            });
            return;
          }
        } catch (err) {
          log.error('Failed to inspect unexpected no-prompt subdialog drive request', err, {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
            source: driveSource,
            reason: driveOptions?.reason ?? null,
            allowResumeFromInterrupted: driveOptions?.allowResumeFromInterrupted === true,
          });
          return;
        }
      }

      // WARNING:
      // `allowResumeFromInterrupted` covers multiple stop reasons, but the interjection-pause case
      // is semantically special. Clicking Continue here does NOT mean "blindly clear stopped and
      // drive". We must re-read the fresh persistence facts first because there are three distinct
      // true-source cases behind the same visible resumption panel:
      // - no active reply obligation / not suspended anymore -> continue real driving now
      // - active reply obligation + suspended -> restore true blocked state
      // - active reply obligation + still proceeding entitlement (for example queued upNext) ->
      //   continue real driving now
      //
      // Do not refactor this branch using only `displayState` or only the previous interrupted
      // marker. The correct behavior emerges from combining fresh blocker facts, queued prompt
      // state, and the deferred reply reassertion logic elsewhere.
      const suspension = resumeFromInterjectionPause
        ? await loadFreshSuspensionStatusFromPersistence(dialog)
        : await dialog.getSuspensionStatus();
      const queuedPrompt = dialog.peekUpNext() as UpNextPrompt | undefined;
      const queuedSubdialogPromptCanResume =
        dialog instanceof SubDialog && queuedPrompt !== undefined;
      if (!suspension.canDrive && !queuedSubdialogPromptCanResume) {
        if (resumeFromInterjectionPause) {
          const restoredState = buildDisplayStateFromSuspensionStatus({
            q4h: suspension.q4h,
            subdialogs: suspension.subdialogs,
          });
          await setDialogDisplayState(dialog.id, restoredState);
          await maybeSurfaceDeferredReplyReassertionGuideForBlockedContinue(dialog);
          log.debug(
            'kernel-driver continue after interjection pause restored true suspended state from fresh persistence facts',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              restoredState,
              waitingQ4H: suspension.q4h,
              waitingSubdialogs: suspension.subdialogs,
            },
          );
          return;
        }
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
          source: driveSource,
          reason: driveOptions?.reason ?? null,
        });
        return;
      }
      if (resumeFromInterjectionPause) {
        log.debug(
          'kernel-driver continue after interjection pause passed fresh fact scan and will keep driving',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            waitingQ4H: suspension.q4h,
            waitingSubdialogs: suspension.subdialogs,
            hasQueuedUpNext: dialog.hasUpNext(),
            queuedSubdialogPromptCanResume,
          },
        );
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

    const snapshot = dialog.getLastContextHealth();
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
    const criticalCountdownRemaining = resolveCriticalCountdownRemaining(dialog.id.key(), snapshot);
    const healthDecision = decideKernelDriverContextHealth({
      dialogKey: dialog.id.key(),
      snapshot,
      hadUserPromptThisGen: humanPrompt !== undefined,
      canInjectPromptThisGen: !hasQueuedUpNext,
      cautionRemediationCadenceGenerations,
      criticalCountdownRemaining,
    });
    if (healthDecision.kind === 'suspend') {
      return;
    }

    let healthPrompt: KernelDriverHumanPrompt | undefined;
    if (healthDecision.kind === 'continue') {
      if (healthDecision.reason === 'critical_force_new_course') {
        const language = getWorkLanguage();
        const newCoursePrompt = formatNewCourseStartPrompt(language, {
          nextCourse: dialog.currentCourse + 1,
          source: 'critical_auto_clear',
        });
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
                promptsTotal: KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
              });
        healthPrompt = {
          content: guideText,
          msgId: generateShortId(),
          grammar: 'markdown',
          origin: 'runtime',
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
    const resolvedPrompt = await resolveEffectivePrompt(dialog, promptForCore);
    const effectivePrompt = resolvedPrompt.prompt;
    await applyRegisteredDialogRunControlsBeforeDrive({
      dialog,
      humanPrompt,
      effectivePrompt,
      driveSource,
      genIterNo: args.runtime.totalGenIterations,
    });
    if (resolvedPrompt.fromUpNext) {
      const consumed = dialog.takeUpNext() as UpNextPrompt | undefined;
      if (!consumed || consumed.msgId !== effectivePrompt?.msgId) {
        throw new Error(
          `kernel-driver upNext invariant violation: expected queued prompt ${effectivePrompt?.msgId ?? 'unknown'} before drive`,
        );
      }
    }
    subdialogReplyTarget = effectivePrompt?.subdialogReplyTarget;
    const replyGuidance = await resolvePromptReplyGuidance({
      dlg: dialog,
      prompt: effectivePrompt,
    });
    // Only park into the special interjection resumption-panel state when this user turn has
    // suppressed a still-pending inter-dialog reply obligation that must be reasserted later.
    // User interjections without a parked original task should simply finish and fall back to the
    // dialog's true underlying state, without showing the special resumption panel.
    //
    // Q4H answers are explicitly outside this branch even though they also come from the human.
    // They belong to the askHuman reply channel and must continue the suspended askHuman round,
    // never be mistaken for ad hoc interjection chat.
    shouldPauseAfterLocalUserInterjection =
      effectivePrompt?.origin === 'user' &&
      !replyGuidance.isQ4HAnswerPrompt &&
      replyGuidance.suppressInterDialogReplyGuidance &&
      replyGuidance.deferredReplyReassertionDirective !== undefined;
    activeTellaskReplyDirective = replyGuidance.activeReplyDirective;
    activePromptWasReplyToolReminder = isReplyToolReminderPrompt(effectivePrompt);
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dialog.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    driveResult = await driveDialogStreamCore(
      dialog,
      {
        scheduleDrive: args.scheduleDrive,
        driveDialog: args.driveDialog,
      },
      effectivePrompt,
      driveOptions,
    );
    subdialogReplyTarget = driveResult.lastAssistantReplyTarget ?? subdialogReplyTarget;
    interruptedBySignal = getActiveRunSignal(dialog.id)?.aborted === true;
    if (!interruptedBySignal) {
      followUp = dialog.takeUpNext() as UpNextPrompt | undefined;
    }

    let tailError: unknown;
    try {
      if (
        dialog instanceof SubDialog &&
        driveResult &&
        !interruptedBySignal &&
        (driveResult.fbrConclusion !== undefined || driveResult.lastAssistantSayingContent !== null)
      ) {
        if (driveResult.fbrConclusion) {
          await supplySubdialogResponseToAssignedCallerIfPendingV2({
            subdialog: dialog,
            responseText: driveResult.fbrConclusion.responseText,
            responseGenseq: driveResult.fbrConclusion.responseGenseq,
            scheduleDrive: args.scheduleDrive,
          });
        } else if (driveResult.lastAssistantSayingContent !== null) {
          const hasInProgressFunctionCall =
            typeof driveResult.lastFunctionCallGenseq === 'number' &&
            Number.isFinite(driveResult.lastFunctionCallGenseq) &&
            driveResult.lastFunctionCallGenseq > 0 &&
            (typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
              !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
              driveResult.lastAssistantSayingGenseq <= driveResult.lastFunctionCallGenseq);
          if (hasInProgressFunctionCall) {
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
            const hasFollowUp = followUp !== undefined;
            const suspension = await dialog.getSuspensionStatus();
            if (!suspension.canDrive || hasFollowUp) {
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
            }
            if (suspension.canDrive && !hasFollowUp) {
              if (!activeTellaskReplyDirective) {
                log.debug(
                  'kernel-driver skip implicit subdialog reply because no active tellask reply directive is bound to this drive',
                  undefined,
                  {
                    rootId: dialog.id.rootId,
                    selfId: dialog.id.selfId,
                  },
                );
              } else {
                if (!activePromptWasReplyToolReminder) {
                  const language = getWorkLanguage();
                  followUp = {
                    prompt: await buildReplyToolReminderPrompt({
                      dlg: dialog,
                      directive: activeTellaskReplyDirective,
                      language,
                    }),
                    msgId: generateShortId(),
                    grammar: 'markdown',
                    origin: 'runtime',
                    userLanguageCode: language,
                    tellaskReplyDirective: activeTellaskReplyDirective,
                    subdialogReplyTarget,
                  };
                  log.debug(
                    'kernel-driver queued subdialog replyTellask reminder after plain reply',
                    undefined,
                    {
                      dialogId: dialog.id.valueOf(),
                      targetCallId: activeTellaskReplyDirective.targetCallId,
                      targetOwnerDialogId: subdialogReplyTarget?.ownerDialogId,
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
                  const directFallbackCallId = `direct-fallback-${generateShortId()}`;
                  let supplied = false;
                  if (subdialogReplyTarget) {
                    supplied = await supplySubdialogResponseToSpecificCallerIfPendingV2({
                      subdialog: dialog,
                      responseText: driveResult.lastAssistantSayingContent,
                      responseGenseq,
                      target: subdialogReplyTarget,
                      deliveryMode: 'direct_fallback',
                      replyResolution: {
                        callId: directFallbackCallId,
                        replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                      },
                      scheduleDrive: args.scheduleDrive,
                    });
                    if (!supplied) {
                      supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
                        subdialog: dialog,
                        responseText: driveResult.lastAssistantSayingContent,
                        responseGenseq,
                        deliveryMode: 'direct_fallback',
                        replyResolution: {
                          callId: directFallbackCallId,
                          replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                        },
                        scheduleDrive: args.scheduleDrive,
                      });
                    }
                  } else {
                    supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
                      subdialog: dialog,
                      responseText: driveResult.lastAssistantSayingContent,
                      responseGenseq,
                      deliveryMode: 'direct_fallback',
                      replyResolution: {
                        callId: directFallbackCallId,
                        replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                      },
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
          }
        }
      }

      if (
        !(dialog instanceof SubDialog) &&
        driveResult &&
        !interruptedBySignal &&
        driveResult.lastAssistantSayingContent !== null &&
        activeTellaskReplyDirective?.expectedReplyCallName === 'replyTellaskBack' &&
        followUp === undefined
      ) {
        const hasInProgressFunctionCall =
          typeof driveResult.lastFunctionCallGenseq === 'number' &&
          Number.isFinite(driveResult.lastFunctionCallGenseq) &&
          driveResult.lastFunctionCallGenseq > 0 &&
          (typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
            !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
            driveResult.lastAssistantSayingGenseq <= driveResult.lastFunctionCallGenseq);
        if (!hasInProgressFunctionCall) {
          if (!activePromptWasReplyToolReminder) {
            const language = getWorkLanguage();
            followUp = {
              prompt: await buildReplyToolReminderPrompt({
                dlg: dialog,
                directive: activeTellaskReplyDirective,
                language,
              }),
              msgId: generateShortId(),
              grammar: 'markdown',
              origin: 'runtime',
              userLanguageCode: language,
              tellaskReplyDirective: activeTellaskReplyDirective,
            };
            log.debug(
              'kernel-driver queued replyTellaskBack reminder prompt after plain reply',
              undefined,
              {
                dialogId: dialog.id.valueOf(),
                targetCallId: activeTellaskReplyDirective.targetCallId,
              },
            );
          } else {
            await deliverTellaskBackReplyFromDirective({
              replyingDialog: dialog,
              directive: activeTellaskReplyDirective,
              replyContent: driveResult.lastAssistantSayingContent,
              callbacks: {
                scheduleDrive: args.scheduleDrive,
                driveDialog: args.driveDialog,
              },
              deliveryMode: 'direct_fallback',
            });
            await dialog.appendTellaskReplyResolution({
              callId: `direct-fallback-${generateShortId()}`,
              replyCallName: 'replyTellaskBack',
              targetCallId: activeTellaskReplyDirective.targetCallId,
            });
          }
        }
      }

      if (followUp) {
        args.scheduleDrive(dialog, {
          waitInQue: true,
          driveOptions: {
            source: 'kernel_driver_follow_up',
            reason: 'follow_up_prompt',
          },
          humanPrompt: {
            content: followUp.prompt,
            msgId: followUp.msgId,
            grammar: followUp.grammar ?? 'markdown',
            origin: followUp.origin,
            userLanguageCode:
              followUp.userLanguageCode === 'zh' || followUp.userLanguageCode === 'en'
                ? followUp.userLanguageCode
                : undefined,
            q4hAnswerCallId: followUp.q4hAnswerCallId,
            tellaskReplyDirective: followUp.tellaskReplyDirective,
            skipTaskdoc: followUp.skipTaskdoc,
            subdialogReplyTarget: followUp.subdialogReplyTarget,
            runControl: followUp.runControl,
          },
        });
      }
      if (
        shouldPauseAfterLocalUserInterjection &&
        !interruptedBySignal &&
        followUp === undefined &&
        driveResult?.lastAssistantSayingContent !== null
      ) {
        const pauseReason = buildUserInterjectionPauseStopReason();
        await setDialogDisplayState(dialog.id, {
          kind: 'stopped',
          reason: pauseReason,
          continueEnabled: true,
        });
        broadcastDisplayStateMarker(dialog.id, {
          kind: 'interrupted',
          reason: pauseReason,
        });
        log.debug(
          'kernel-driver paused original task after local user interjection reply',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          },
        );
      }
    } catch (error: unknown) {
      tailError = error;
    }

    if (tailError === undefined) {
      try {
        await clearConsumedDeferredRootQueueIfIdle(dialog);
      } catch (error: unknown) {
        log.error(
          'kernel-driver failed to reconcile consumed deferred root queue after tail',
          error,
          {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          },
        );
      }
    }

    if (tailError !== undefined) {
      throw tailError;
    }
  } finally {
    if (activeRunPrimed && ownsActiveRun) {
      clearActiveRun(dialog.id);
    }
    release();
  }
}
