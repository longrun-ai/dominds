import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type { DialogQueuedPromptState } from '@longrun-ai/kernel/types/drive-intent';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import {
  applyRegisteredAppDialogRunControls,
  renderAppRunControlBlockForPreDrive,
} from '../../apps/run-control';
import { DialogID, SideDialog, type Dialog } from '../../dialog';
import {
  broadcastDisplayStateMarker,
  clearActiveRun,
  computeIdleDisplayState,
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
  formatAgentFacingCriticalUserInterjectionRemediationGuide,
  formatNewCourseStartPrompt,
} from '../../runtime/driver-messages';
import {
  buildUserInterjectionPauseStopReason,
  isUserInterjectionPauseStopReason,
} from '../../runtime/interjection-pause-stop';
import {
  buildReplyToolReminderText,
  isReplyToolReminderPromptContent,
} from '../../runtime/reply-prompt-copy';
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
import { cancelIdleReminderWake, maybeStartIdleReminderWake } from './idle-reminder-wake';
import {
  buildReplyObligationReassertionPrompt,
  resolvePromptReplyGuidance,
  resolveReplyTargetAgentId,
} from './reply-guidance';
import type { CalleeReplyTarget, ScheduleDriveFn } from './sideDialog';
import {
  supplySideDialogResponseToAssignedAskerIfPendingV2,
  supplySideDialogResponseToSpecificAskerIfPendingV2,
} from './sideDialog';
import {
  deliverTellaskBackReplyFromDirective,
  loadActiveTellaskReplyDirective,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveInvoker,
  KernelDriverDriveOptions,
  KernelDriverDriveResult,
  KernelDriverDriveScheduler,
  KernelDriverDriveSource,
  KernelDriverPrompt,
  KernelDriverRuntimePrompt,
  KernelDriverRuntimeReplyPrompt,
  KernelDriverRuntimeSideDialogPrompt,
  KernelDriverRuntimeState,
  KernelDriverUserPrompt,
} from './types';

type RuntimeReplyReminderPrompt = Readonly<{
  kind: 'runtime_reply_reminder';
  prompt: string;
  msgId: string;
  grammar?: KernelDriverPrompt['grammar'];
  userLanguageCode?: KernelDriverPrompt['userLanguageCode'];
  runControl?: undefined;
  origin: 'runtime';
  tellaskReplyDirective: KernelDriverRuntimeReplyPrompt['tellaskReplyDirective'];
  skipTaskdoc?: undefined;
}>;

type RuntimeSideDialogReplyReminderPrompt = Readonly<{
  kind: 'runtime_sideDialog_reply_reminder';
  prompt: string;
  msgId: string;
  grammar?: KernelDriverPrompt['grammar'];
  userLanguageCode?: KernelDriverPrompt['userLanguageCode'];
  runControl?: undefined;
  origin: 'runtime';
  tellaskReplyDirective: KernelDriverRuntimeSideDialogPrompt['tellaskReplyDirective'];
  skipTaskdoc?: undefined;
  calleeDialogReplyTarget: KernelDriverRuntimeSideDialogPrompt['calleeDialogReplyTarget'];
}>;

type UpNextPrompt = DialogQueuedPromptState;

type FollowUpPrompt =
  | DialogQueuedPromptState
  | RuntimeReplyReminderPrompt
  | RuntimeSideDialogReplyReminderPrompt;

function buildRuntimeReplyReminderFollowUp(args: {
  directive: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>;
  prompt: string;
  language: 'zh' | 'en';
  calleeDialogReplyTarget?: CalleeReplyTarget;
}): RuntimeReplyReminderPrompt | RuntimeSideDialogReplyReminderPrompt {
  const common = {
    prompt: args.prompt,
    msgId: generateShortId(),
    grammar: 'markdown' as const,
    origin: 'runtime' as const,
    userLanguageCode: args.language,
    tellaskReplyDirective: args.directive,
  };
  return args.calleeDialogReplyTarget === undefined
    ? {
        kind: 'runtime_reply_reminder',
        ...common,
      }
    : {
        kind: 'runtime_sideDialog_reply_reminder',
        ...common,
        calleeDialogReplyTarget: args.calleeDialogReplyTarget,
      };
}

async function queueReplyReminderFollowUp(args: {
  dialog: Dialog;
  followUp: RuntimeReplyReminderPrompt | RuntimeSideDialogReplyReminderPrompt;
}): Promise<void> {
  if (args.followUp.kind === 'runtime_sideDialog_reply_reminder') {
    await args.dialog.queueRuntimeSideDialogPrompt({
      prompt: args.followUp.prompt,
      msgId: args.followUp.msgId,
      grammar: args.followUp.grammar ?? 'markdown',
      userLanguageCode: args.followUp.userLanguageCode,
      tellaskReplyDirective: args.followUp.tellaskReplyDirective,
      skipTaskdoc: args.followUp.skipTaskdoc,
      calleeDialogReplyTarget: args.followUp.calleeDialogReplyTarget,
    });
    return;
  }

  await args.dialog.queueRuntimeReplyPrompt({
    prompt: args.followUp.prompt,
    msgId: args.followUp.msgId,
    grammar: args.followUp.grammar ?? 'markdown',
    userLanguageCode: args.followUp.userLanguageCode,
    tellaskReplyDirective: args.followUp.tellaskReplyDirective,
    skipTaskdoc: args.followUp.skipTaskdoc,
  });
}

function isReplyToolReminderPrompt(prompt: KernelDriverPrompt | undefined): boolean {
  return typeof prompt?.content === 'string' && isReplyToolReminderPromptContent(prompt.content);
}

function hasQ4HAnswerCallId(callId: string | undefined): boolean {
  return typeof callId === 'string' && callId.trim() !== '';
}

function isEffectiveUserPromptForContextHealth(prompt: KernelDriverPrompt | undefined): boolean {
  return prompt?.origin === 'user' && !hasQ4HAnswerCallId(prompt.q4hAnswerCallId);
}

function isQueuedUserPromptForContextHealth(prompt: UpNextPrompt | undefined): boolean {
  return prompt?.kind === 'user_generation_boundary' && !hasQ4HAnswerCallId(prompt.q4hAnswerCallId);
}

function isNonIdleDisplayProjection(state: DialogDisplayState | undefined): boolean {
  return state !== undefined && state.kind !== 'idle_waiting_user';
}

function hasPendingNextStepTriggers(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
): boolean {
  return (latest?.nextStep?.triggers.length ?? 0) > 0;
}

type DirectFallbackResponse = Readonly<{
  responseText: string;
  responseGenseq: number;
  source: 'saying' | 'thinking_only';
}>;

function resolveDirectFallbackResponse(args: {
  driveResult: KernelDriverCoreResult;
  dialog: Dialog;
}): DirectFallbackResponse | undefined {
  let saying: DirectFallbackResponse | undefined;
  if (
    args.driveResult.lastAssistantSayingContent !== null &&
    args.driveResult.lastAssistantSayingContent.trim() !== ''
  ) {
    if (
      typeof args.driveResult.lastAssistantSayingGenseq !== 'number' ||
      !Number.isFinite(args.driveResult.lastAssistantSayingGenseq) ||
      args.driveResult.lastAssistantSayingGenseq <= 0
    ) {
      throw new Error(
        `Direct reply fallback invariant violation: missing lastAssistantSayingGenseq for dialog=${args.dialog.id.valueOf()}`,
      );
    }
    saying = {
      responseText: args.driveResult.lastAssistantSayingContent,
      responseGenseq: Math.floor(args.driveResult.lastAssistantSayingGenseq),
      source: 'saying',
    };
  }

  // Thinking output is intentionally a fallback candidate: some providers/models can finish a
  // Side Dialog with useful content in thinking and no public saying. Pick the newest non-empty
  // assistant generation candidate across the whole drive, preferring public saying over thinking
  // on the same generation. A post-tool thinking segment must not be shadowed by an older pre-tool
  // saying segment from an earlier generation iteration.
  //
  // This helper only extracts the candidate; callers below must still reject it when a same-round
  // function/tellask call needs auto-continuation, when the dialog is suspended, or when another
  // follow-up prompt is queued.
  let thinking: DirectFallbackResponse | undefined;
  if (
    args.driveResult.lastAssistantThinkingContent !== null &&
    args.driveResult.lastAssistantThinkingContent.trim() !== ''
  ) {
    if (
      typeof args.driveResult.lastAssistantThinkingGenseq !== 'number' ||
      !Number.isFinite(args.driveResult.lastAssistantThinkingGenseq) ||
      args.driveResult.lastAssistantThinkingGenseq <= 0
    ) {
      throw new Error(
        `Direct reply fallback invariant violation: missing lastAssistantThinkingGenseq for dialog=${args.dialog.id.valueOf()}`,
      );
    }
    thinking = {
      responseText: args.driveResult.lastAssistantThinkingContent,
      responseGenseq: Math.floor(args.driveResult.lastAssistantThinkingGenseq),
      source: 'thinking_only',
    };
  }

  if (saying !== undefined && thinking !== undefined) {
    return saying.responseGenseq >= thinking.responseGenseq ? saying : thinking;
  }
  return saying ?? thinking;
}

async function buildReplyToolReminderPrompt(args: {
  dlg: Dialog;
  directive: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>;
  language: 'zh' | 'en';
}): Promise<string> {
  return buildReplyToolReminderText({
    language: args.language,
    directive: args.directive,
    replyTargetAgentId: await resolveReplyTargetAgentId({
      dlg: args.dlg,
      directive: args.directive,
    }),
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function loadFreshSuspensionStatusFromPersistence(dialog: Dialog): Promise<{
  q4h: boolean;
  backgroundCalleeDialogs: boolean;
  canDrive: boolean;
}> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  const activeCallees = await DialogPersistence.loadActiveCallees(dialog.id, dialog.status);
  const hasQ4H = latest?.userWait?.kind === 'awaiting_user_answer';
  const hasSideDialogs = activeCallees.batches.some((batch) =>
    batch.callees.some((callee) => callee.status === 'pending'),
  );
  return {
    q4h: hasQ4H,
    backgroundCalleeDialogs: hasSideDialogs,
    canDrive: !hasQ4H,
  };
}

function buildDisplayStateFromSuspensionStatus(args: {
  q4h: boolean;
  backgroundCalleeDialogs: boolean;
}): DialogDisplayState {
  if (args.q4h && args.backgroundCalleeDialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (args.q4h) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  return { kind: 'idle_waiting_user' };
}

type PendingDiagnosticsSnapshot =
  | {
      kind: 'loaded';
      callerDialogId: string;
      status: 'running' | 'completed' | 'archived';
      totalCount: number;
      matchedSideDialogIds: string[];
      records: Array<{
        sideDialogId: string;
        callType: 'A' | 'B' | 'C';
        targetAgentId: string;
        sessionSlug?: string;
        createdAt: string;
        tellaskSummary: string;
      }>;
    }
  | {
      kind: 'error';
      callerDialogId: string;
      status: 'running' | 'completed' | 'archived';
      error: string;
    };

async function loadPendingDiagnosticsSnapshot(args: {
  rootId: string;
  callerDialogId: string;
  expectedSideDialogId: string;
  status: 'running' | 'completed' | 'archived';
}): Promise<PendingDiagnosticsSnapshot> {
  const callerDialogIdObj = new DialogID(args.callerDialogId, args.rootId);
  try {
    const activeCalleeDispatches = await DialogPersistence.loadActiveCalleeDispatches(
      callerDialogIdObj,
      args.status,
    );
    const matchedSideDialogIds = activeCalleeDispatches
      .filter((record) => record.calleeDialogId === args.expectedSideDialogId)
      .map((record) => record.calleeDialogId);
    return {
      kind: 'loaded',
      callerDialogId: args.callerDialogId,
      status: args.status,
      totalCount: activeCalleeDispatches.length,
      matchedSideDialogIds,
      records: activeCalleeDispatches.map((record) => ({
        sideDialogId: record.calleeDialogId,
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
      callerDialogId: args.callerDialogId,
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
  const persistedNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(dialog.id);
  if (!persistedNextStepTriggers) {
    return;
  }
  try {
    await DialogPersistence.setBackendQueueDrive(
      dialog.id,
      false,
      'root_idle_after_consuming_deferred_queue',
      dialog.status,
    );
  } catch (error: unknown) {
    log.error('kernel-driver failed to persist consumed deferred root queue cleanup', error, {
      dialogId: dialog.id.valueOf(),
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
    });
    return;
  }
  globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
    source: 'kernel_driver_flow_tail',
    reason: 'root_idle_after_consuming_deferred_queue',
  });
}

function hasRootBackendQueueTrigger(args: {
  dialog: Dialog;
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
}): boolean {
  if (args.dialog.id.selfId !== args.dialog.id.rootId) {
    return false;
  }
  return (
    args.latest?.nextStep?.triggers.some(
      (trigger) =>
        trigger.kind === 'backend_queue' &&
        trigger.triggerId === `backend-queue:${args.dialog.id.selfId}`,
    ) === true
  );
}

async function restoreAcceptedRootBackendQueueAfterDriveFailure(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
  reason: 'core_stopped' | 'tail_error';
  error?: unknown;
  hadRootBackendQueueBeforeCore?: boolean;
}): Promise<void> {
  if (args.dialog.id.selfId !== args.dialog.id.rootId) {
    return;
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const acceptedTriggerIds =
    latest?.generationRunState?.kind === 'open' ? latest.generationRunState.acceptedTriggerIds : [];
  const acceptedBackendQueue = acceptedTriggerIds.some((triggerId) =>
    triggerId.startsWith(`backend-queue:${args.dialog.id.selfId}`),
  );
  if (!acceptedBackendQueue && args.hadRootBackendQueueBeforeCore !== true) {
    return;
  }
  if (args.reason === 'core_stopped' && latest?.executionMarker?.kind !== 'interrupted') {
    return;
  }
  const reason = `${args.reason}_requeue:${args.driveOptions?.reason ?? 'unknown'}`;
  await DialogPersistence.setBackendQueueDrive(args.dialog.id, true, reason, args.dialog.status);
  globalDialogRegistry.wakeDrive(args.dialog.id.rootId, {
    source: 'kernel_driver_flow_tail',
    reason,
  });
  log.warn('kernel-driver requeued accepted root backend_queue after drive failure', args.error, {
    dialogId: args.dialog.id.valueOf(),
    rootId: args.dialog.id.rootId,
    selfId: args.dialog.id.selfId,
    requeueReason: args.reason,
    acceptedTriggerIds,
    hadRootBackendQueueBeforeCore: args.hadRootBackendQueueBeforeCore === true,
    source: args.driveOptions?.source ?? null,
    reason: args.driveOptions?.reason ?? null,
  });
}

async function clearStaleSideDialogRunControlForFinalResponse(args: {
  dialog: SideDialog;
}): Promise<{
  cleared: boolean;
  previousGenerating: boolean | null;
  previousNextStepTriggerCount: number | null;
}> {
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (
    !latest ||
    (!hasPendingNextStepTriggers(latest) &&
      latest.generating !== true &&
      latest.executionMarker?.kind !== 'interrupted' &&
      !isNonIdleDisplayProjection(latest.displayState)) ||
    latest.executionMarker?.kind === 'dead' ||
    latest.pendingRuntimePrompt
  ) {
    return {
      cleared: false,
      previousGenerating: latest?.generating ?? null,
      previousNextStepTriggerCount: latest?.nextStep?.triggers.length ?? null,
    };
  }

  await DialogPersistence.mutateDialogLatest(
    args.dialog.id,
    () => ({
      kind: 'patch',
      patch: {
        generating: false,
        nextStep: undefined,
        displayState: { kind: 'idle_waiting_user' } as const,
        executionMarker: undefined,
      },
    }),
    args.dialog.status,
  );
  await DialogPersistence.removeDriveWatchForDialog(args.dialog.id, args.dialog.status);
  return {
    cleared: true,
    previousGenerating: latest.generating ?? null,
    previousNextStepTriggerCount: latest.nextStep?.triggers.length ?? 0,
  };
}

function hasNoPromptSideDialogResumeEntitlement(
  dialog: SideDialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const entitlement = driveOptions?.noPromptSideDialogResumeEntitlement;
  if (!entitlement) {
    return false;
  }
  return entitlement.callerDialogId === dialog.id.selfId;
}

function hasCallerReviveEntitlement(
  dialog: Dialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const entitlement = driveOptions?.noPromptSideDialogResumeEntitlement;
  if (!entitlement) {
    return false;
  }
  if (
    driveOptions?.source !== 'kernel_driver_supply_response_caller_revive' ||
    entitlement.callerDialogId !== dialog.id.selfId
  ) {
    return false;
  }
  if (entitlement.reason === 'reply_tellask_back_delivered') {
    return true;
  }
  if (entitlement.reason === 'replaced_pending_sideDialog_reply') {
    return true;
  }
  return (
    entitlement.reason === 'resolved_pending_sideDialog_reply' &&
    isPositiveInteger(entitlement.callSiteCourse) &&
    isPositiveInteger(entitlement.callSiteGenseq)
  );
}

function resolveDriveRequestSource(
  humanPrompt: KernelDriverPrompt | undefined,
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
  humanPrompt: KernelDriverPrompt | undefined;
  effectivePrompt: KernelDriverPrompt | undefined;
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
  humanPrompt: KernelDriverPrompt | undefined;
  effectivePrompt: KernelDriverPrompt | undefined;
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

async function inspectNoPromptSideDialogDrive(args: {
  dialog: SideDialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<
  | {
      shouldReject: false;
      source: KernelDriverDriveSource;
      displayState: DialogDisplayState | undefined;
      currentCourse: number;
      sideDialogFinalResponseCallId: string | undefined;
    }
  | {
      shouldReject: true;
      source: KernelDriverDriveSource;
      rejection:
        | 'finalized_after_response_anchor'
        | 'missing_explicit_interrupted_resume_entitlement';
      displayState: DialogDisplayState | undefined;
      currentCourse: number;
      sideDialogFinalResponseCallId: string | undefined;
    }
> {
  const source = resolveDriveRequestSource(undefined, args.driveOptions);
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const displayState = latest?.displayState;
  const rawCourse = latest?.currentCourse ?? args.dialog.currentCourse;
  const currentCourse = Number.isFinite(rawCourse) && rawCourse > 0 ? Math.floor(rawCourse) : 1;
  const sideDialogFinalResponseCallId = latest?.sideDialogFinalResponse?.callId;

  const explicitInterruptedResumeAllowed =
    args.driveOptions?.allowResumeFromInterrupted === true &&
    latest?.executionMarker?.kind === 'interrupted';
  const inProgressGenerationResumeAllowed = args.driveOptions?.resumeInProgressGeneration === true;
  const supplyResponseCallerReviveAllowed =
    source === 'kernel_driver_supply_response_caller_revive' &&
    hasNoPromptSideDialogResumeEntitlement(args.dialog, args.driveOptions);
  const backendLoopDurableWorkAllowed =
    source === 'kernel_driver_backend_loop' && (latest?.nextStep?.triggers.length ?? 0) > 0;
  const replyObligationFollowUpAllowed =
    source === 'kernel_driver_follow_up' &&
    args.driveOptions?.noPromptSideDialogResumeEntitlement?.reason ===
      'reply_obligation_follow_up' &&
    hasNoPromptSideDialogResumeEntitlement(args.dialog, args.driveOptions);
  if (sideDialogFinalResponseCallId !== undefined) {
    return {
      shouldReject: true,
      source,
      rejection: 'finalized_after_response_anchor',
      displayState,
      currentCourse,
      sideDialogFinalResponseCallId,
    };
  }
  if (
    !explicitInterruptedResumeAllowed &&
    !inProgressGenerationResumeAllowed &&
    !supplyResponseCallerReviveAllowed &&
    !backendLoopDurableWorkAllowed &&
    !replyObligationFollowUpAllowed
  ) {
    return {
      shouldReject: true,
      source,
      rejection: 'missing_explicit_interrupted_resume_entitlement',
      displayState,
      currentCourse,
      sideDialogFinalResponseCallId,
    };
  }
  return {
    shouldReject: false,
    source,
    displayState,
    currentCourse,
    sideDialogFinalResponseCallId,
  };
}

async function maybeResolveDeferredReplyReassertionPrompt(
  dialog: KernelDriverDriveArgs[0],
): Promise<KernelDriverRuntimePrompt | undefined> {
  const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
    dialog.id,
    dialog.status,
  );
  if (!deferredReplyReassertion) {
    return undefined;
  }
  const activeDirective = await loadActiveTellaskReplyDirective(dialog);
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
  const activeDirective = await loadActiveTellaskReplyDirective(dialog);
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
  await surfaceRuntimeGuide(dialog, content);
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

async function surfaceRuntimeGuide(dialog: Dialog, content: string): Promise<void> {
  const genseq = dialog.activeGenSeqOrUndefined ?? 1;
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
}

async function resolveEffectivePrompt(
  dialog: KernelDriverDriveArgs[0],
  humanPrompt?: KernelDriverPrompt,
): Promise<
  Readonly<{
    prompt: KernelDriverPrompt | undefined;
    fromUpNext: boolean;
  }>
> {
  if (humanPrompt) {
    return { prompt: humanPrompt, fromUpNext: false };
  }
  const upNext: UpNextPrompt | undefined = dialog.peekUpNext();
  if (!upNext) {
    return {
      prompt: await maybeResolveDeferredReplyReassertionPrompt(dialog),
      fromUpNext: false,
    };
  }
  return {
    fromUpNext: true,
    prompt: (() => {
      const normalizedUserLanguageCode: KernelDriverPrompt['userLanguageCode'] =
        upNext.userLanguageCode === 'zh' || upNext.userLanguageCode === 'en'
          ? upNext.userLanguageCode
          : undefined;
      const common = {
        content: upNext.prompt,
        msgId: upNext.msgId,
        grammar: upNext.grammar ?? 'markdown',
        userLanguageCode: normalizedUserLanguageCode,
        runControl: upNext.runControl,
      };
      switch (upNext.kind) {
        case 'user_generation_boundary':
        case 'deferred_q4h_answer': {
          const prompt: KernelDriverUserPrompt = {
            ...common,
            origin: 'user',
            ...(upNext.q4hAnswerCallId === undefined
              ? {}
              : { q4hAnswerCallId: upNext.q4hAnswerCallId }),
          };
          return prompt;
        }
        case 'registered_assignment_update':
        case 'new_course_runtime_guide':
        case 'new_course_runtime_reply':
        case 'new_course_runtime_sideDialog': {
          const runtimeCommon = {
            ...common,
            origin: 'runtime' as const,
            ...(upNext.skipTaskdoc === undefined ? {} : { skipTaskdoc: upNext.skipTaskdoc }),
          };
          if (
            upNext.kind === 'registered_assignment_update' ||
            upNext.kind === 'new_course_runtime_sideDialog'
          ) {
            const prompt: KernelDriverRuntimeSideDialogPrompt = {
              ...runtimeCommon,
              tellaskReplyDirective: upNext.tellaskReplyDirective,
              calleeDialogReplyTarget: upNext.calleeDialogReplyTarget,
            };
            return prompt;
          }
          if (upNext.kind === 'new_course_runtime_reply') {
            const prompt: KernelDriverRuntimeReplyPrompt = {
              ...runtimeCommon,
              tellaskReplyDirective: upNext.tellaskReplyDirective,
            };
            return prompt;
          }
          const prompt: KernelDriverRuntimePrompt = runtimeCommon;
          return prompt;
        }
      }
    })(),
  };
}

export async function executeDriveRound(args: {
  runtime: KernelDriverRuntimeState;
  driveArgs: KernelDriverDriveArgs;
  scheduleDrive: KernelDriverDriveScheduler & ScheduleDriveFn;
  driveDialog: KernelDriverDriveInvoker;
}): KernelDriverDriveResult {
  const [dialog, humanPrompt, waitInQue, driveOptions] = args.driveArgs;
  cancelIdleReminderWake(dialog.id, driveOptions?.reason ?? 'drive_start');
  if (!waitInQue && dialog.isLocked()) {
    throw new Error('Dialog busy driven, see how it proceeded and try again.');
  }

  const release = await dialog.acquire();
  let activeRunPrimed = false;
  let ownsActiveRun = false;
  let interruptedBySignal = false;
  let shouldRefreshDisplayStateAfterActiveRunCleared = false;
  let followUp: FollowUpPrompt | undefined;
  let driveResult: KernelDriverCoreResult | undefined;
  let calleeDialogReplyTarget: CalleeReplyTarget | undefined;
  let activeTellaskReplyDirective: KernelDriverPrompt['tellaskReplyDirective'] | undefined;
  let activePromptWasReplyToolReminder = false;
  let shouldPauseAfterLocalUserInterjection = false;
  let resumeFromInterjectionPause = false;
  let hadRootBackendQueueBeforeCore = false;
  let coreEndedInterrupted = false;
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

    // "dead" is irreversible for sideDialogs. Skip drive if marked dead.
    try {
      const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
      hadRootBackendQueueBeforeCore ||= hasRootBackendQueueTrigger({ dialog, latest });
      if (
        dialog.id.selfId !== dialog.id.rootId &&
        latest &&
        latest.executionMarker &&
        latest.executionMarker.kind === 'dead'
      ) {
        return;
      }
      if (dialog instanceof SideDialog && !dialog.hasUpNext()) {
        const inspection = await inspectNoPromptSideDialogDrive({ dialog, driveOptions });
        if (inspection.shouldReject && inspection.rejection === 'finalized_after_response_anchor') {
          const cleanup = await clearStaleSideDialogRunControlForFinalResponse({ dialog });
          if (!cleanup.cleared) {
            await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
          }
          log.warn(
            'Dropped stale no-prompt sideDialog drive after final response anchor',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              source: inspection.source,
              reason: driveOptions?.reason ?? null,
              rejection: inspection.rejection,
              allowResumeFromInterrupted: driveOptions?.allowResumeFromInterrupted === true,
              displayState: inspection.displayState ?? null,
              currentCourse: inspection.currentCourse,
              sideDialogFinalResponseCallId: inspection.sideDialogFinalResponseCallId ?? null,
              clearedStaleRunControl: cleanup.cleared,
              previousGenerating: cleanup.previousGenerating,
              previousNextStepTriggerCount: cleanup.previousNextStepTriggerCount,
              waitInQue,
            },
          );
          return;
        }
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

    // Queued/auto drive (without fresh human input) must not proceed while dialog is suspended by
    // Q4H. SideDialogs have an extra no-prompt entitlement gate below so background wake-ups cannot
    // duplicate final-response or reply-obligation work.
    if (!humanPrompt) {
      if (dialog instanceof SideDialog && !dialog.hasUpNext()) {
        try {
          const inspection = await inspectNoPromptSideDialogDrive({ dialog, driveOptions });
          if (inspection.shouldReject) {
            log.error('Rejected unexpected no-prompt sideDialog drive request', undefined, {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              source: inspection.source,
              reason: driveOptions?.reason ?? null,
              rejection: inspection.rejection,
              allowResumeFromInterrupted: driveOptions?.allowResumeFromInterrupted === true,
              displayState: inspection.displayState ?? null,
              currentCourse: inspection.currentCourse,
              sideDialogFinalResponseCallId: inspection.sideDialogFinalResponseCallId ?? null,
              waitInQue,
            });
            return;
          }
        } catch (err) {
          log.error('Failed to inspect unexpected no-prompt sideDialog drive request', err, {
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
      // - active reply obligation + suspended -> restore the true suspension state
      // - active reply obligation + still proceeding entitlement (for example queued upNext) ->
      //   continue real driving now
      //
      // Do not refactor this branch using only `displayState` or only the previous interrupted
      // marker. The correct behavior emerges from combining fresh suspension facts, queued prompt
      // state, and the deferred reply reassertion logic elsewhere.
      const hasEntitledCallerRevive = hasCallerReviveEntitlement(dialog, driveOptions);
      const suspension = resumeFromInterjectionPause
        ? await loadFreshSuspensionStatusFromPersistence(dialog)
        : hasEntitledCallerRevive
          ? await loadFreshSuspensionStatusFromPersistence(dialog)
          : await dialog.getSuspensionStatus();
      const queuedPrompt: UpNextPrompt | undefined = dialog.peekUpNext();
      const queuedSideDialogPromptCanResume =
        dialog instanceof SideDialog && queuedPrompt !== undefined;
      if (!suspension.canDrive && !queuedSideDialogPromptCanResume) {
        if (resumeFromInterjectionPause) {
          const restoredState = buildDisplayStateFromSuspensionStatus({
            q4h: suspension.q4h,
            backgroundCalleeDialogs: suspension.backgroundCalleeDialogs,
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
              backgroundCalleeDialogs: suspension.backgroundCalleeDialogs,
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
          backgroundCalleeDialogs: suspension.backgroundCalleeDialogs,
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousWakeQueued: lastTrigger.previousWakeQueued,
                nextWakeQueued: lastTrigger.nextWakeQueued,
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
            backgroundCalleeDialogs: suspension.backgroundCalleeDialogs,
            hasQueuedUpNext: dialog.hasUpNext(),
            queuedSideDialogPromptCanResume,
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
    const queuedUpNextBeforeHealth = dialog.peekUpNext();
    const hasQueuedUpNext = queuedUpNextBeforeHealth !== undefined;
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
      hadUserPromptThisGen:
        isEffectiveUserPromptForContextHealth(humanPrompt) ||
        (humanPrompt === undefined && isQueuedUserPromptForContextHealth(queuedUpNextBeforeHealth)),
      userPromptCriticalRemediationAlreadyApplied: false,
      canInjectPromptThisGen: !hasQueuedUpNext,
      cautionRemediationCadenceGenerations,
      criticalCountdownRemaining,
    });
    let healthPrompt: KernelDriverRuntimePrompt | undefined;
    let criticalUserInterjectionRuntimeGuide: string | undefined;
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
      } else if (healthDecision.reason === 'critical_user_prompt_remediation') {
        const language = getWorkLanguage();
        const dialogScope = dialog instanceof SideDialog ? 'sideDialog' : 'mainDialog';
        criticalUserInterjectionRuntimeGuide =
          formatAgentFacingCriticalUserInterjectionRemediationGuide(language, {
            dialogScope,
            promptsRemainingAfterThis: consumeCriticalCountdown(dialog.id.key()),
          });
      } else if (!hasQueuedUpNext) {
        const language = getWorkLanguage();
        const dialogScope = dialog instanceof SideDialog ? 'sideDialog' : 'mainDialog';
        const guideText =
          healthDecision.reason === 'caution_soft_remediation'
            ? formatAgentFacingContextHealthV3RemediationGuide(language, {
                kind: 'caution',
                mode: 'soft',
                dialogScope,
              })
            : formatAgentFacingContextHealthV3RemediationGuide(language, {
                kind: 'critical',
                mode: 'countdown',
                dialogScope,
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
    const latestBeforeCore = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    hadRootBackendQueueBeforeCore ||= hasRootBackendQueueTrigger({
      dialog,
      latest: latestBeforeCore,
    });
    await applyRegisteredDialogRunControlsBeforeDrive({
      dialog,
      humanPrompt,
      effectivePrompt,
      driveSource,
      genIterNo: args.runtime.totalGenIterations,
    });
    if (resolvedPrompt.fromUpNext) {
      const consumed: UpNextPrompt | undefined = dialog.takeUpNext();
      if (!consumed || consumed.msgId !== effectivePrompt?.msgId) {
        throw new Error(
          `kernel-driver upNext invariant violation: expected queued prompt ${effectivePrompt?.msgId ?? 'unknown'} before drive`,
        );
      }
    }
    calleeDialogReplyTarget = effectivePrompt?.calleeDialogReplyTarget;
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
    const activePromptCarriesReplyDirective =
      effectivePrompt?.tellaskReplyDirective !== undefined &&
      activeTellaskReplyDirective !== undefined &&
      effectivePrompt.tellaskReplyDirective.targetCallId ===
        activeTellaskReplyDirective.targetCallId;
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dialog.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    const coreDriveOptions =
      criticalUserInterjectionRuntimeGuide === undefined
        ? driveOptions
        : {
            ...(driveOptions ?? {
              source: driveSource,
              reason: 'critical_user_prompt_remediation',
            }),
            criticalUserInterjectionRuntimeGuide,
          };
    driveResult = await driveDialogStreamCore(
      dialog,
      {
        scheduleDrive: args.scheduleDrive,
        driveDialog: args.driveDialog,
      },
      effectivePrompt,
      coreDriveOptions,
    );
    const latestAfterCore = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    coreEndedInterrupted = latestAfterCore?.executionMarker?.kind === 'interrupted';
    await restoreAcceptedRootBackendQueueAfterDriveFailure({
      dialog,
      driveOptions,
      reason: 'core_stopped',
      hadRootBackendQueueBeforeCore,
    });
    calleeDialogReplyTarget = driveResult.lastAssistantReplyTarget ?? calleeDialogReplyTarget;
    interruptedBySignal = getActiveRunSignal(dialog.id)?.aborted === true;
    if (!interruptedBySignal) {
      followUp = dialog.takeUpNext();
    }

    let tailError: unknown;
    try {
      if (
        dialog instanceof SideDialog &&
        driveResult &&
        !interruptedBySignal &&
        (driveResult.fbrConclusion !== undefined ||
          resolveDirectFallbackResponse({ driveResult, dialog }) !== undefined)
      ) {
        if (driveResult.fbrConclusion) {
          const suppliedFbrConclusion = await supplySideDialogResponseToAssignedAskerIfPendingV2({
            sideDialog: dialog,
            responseText: driveResult.fbrConclusion.responseText,
            responseGenseq: driveResult.fbrConclusion.responseGenseq,
            replyResolution: {
              callId: driveResult.fbrConclusion.replyResolutionCallId,
              replyCallName: 'replyTellaskSessionless',
            },
            scheduleDrive: args.scheduleDrive,
          });
          if (!suppliedFbrConclusion) {
            throw new Error(
              `FBR conclusion delivery invariant violation: no pending asker target for dialog=${dialog.id.valueOf()}`,
            );
          }
          shouldRefreshDisplayStateAfterActiveRunCleared = true;
        } else {
          const directFallbackResponse = resolveDirectFallbackResponse({ driveResult, dialog });
          if (directFallbackResponse === undefined) {
            throw new Error(
              `SideDialog response supply invariant violation: missing direct fallback response for dialog=${dialog.id.valueOf()}`,
            );
          }
          const hasInProgressFunctionCall =
            typeof driveResult.lastFunctionCallGenseq === 'number' &&
            Number.isFinite(driveResult.lastFunctionCallGenseq) &&
            driveResult.lastFunctionCallGenseq > 0 &&
            directFallbackResponse.responseGenseq <= driveResult.lastFunctionCallGenseq;
          if (hasInProgressFunctionCall) {
            // A candidate direct fallback, including thinking-only output, must be newer than the
            // latest same-round function/tellask call. Otherwise the call is still the active move
            // and may auto-continue; the candidate is merely pre-tool reasoning/progress, not final
            // tellasker delivery.
            log.debug(
              'kernel-driver skip sideDialog response supply because latest assistant output is not after function calls',
              undefined,
              {
                rootId: dialog.id.rootId,
                selfId: dialog.id.selfId,
                responseGenseq: directFallbackResponse.responseGenseq,
                responseSource: directFallbackResponse.source,
                lastFunctionCallGenseq: driveResult.lastFunctionCallGenseq,
              },
            );
          } else {
            const hasFollowUp = followUp !== undefined;
            const suspension = await dialog.getSuspensionStatus();
            const backgroundCalleeBlocksImplicitReply =
              suspension.backgroundCalleeDialogs &&
              !activePromptWasReplyToolReminder &&
              !activePromptCarriesReplyDirective;
            if (!suspension.canDrive || backgroundCalleeBlocksImplicitReply || hasFollowUp) {
              log.debug(
                'kernel-driver skip sideDialog response supply while tellaskee is not finalized',
                undefined,
                {
                  rootId: dialog.id.rootId,
                  selfId: dialog.id.selfId,
                  waitingQ4H: suspension.q4h,
                  backgroundCalleeDialogs: suspension.backgroundCalleeDialogs,
                  backgroundCalleeBlocksImplicitReply,
                  hasFollowUp,
                },
              );
            }
            if (suspension.canDrive && !backgroundCalleeBlocksImplicitReply && !hasFollowUp) {
              if (!activeTellaskReplyDirective) {
                log.debug(
                  'kernel-driver skip implicit sideDialog reply because no active tellask reply directive is bound to this drive',
                  undefined,
                  {
                    rootId: dialog.id.rootId,
                    selfId: dialog.id.selfId,
                  },
                );
              } else {
                if (!activePromptWasReplyToolReminder) {
                  const language = getWorkLanguage();
                  followUp = buildRuntimeReplyReminderFollowUp({
                    directive: activeTellaskReplyDirective,
                    prompt: await buildReplyToolReminderPrompt({
                      dlg: dialog,
                      directive: activeTellaskReplyDirective,
                      language,
                    }),
                    language,
                    calleeDialogReplyTarget,
                  });
                  log.debug(
                    'kernel-driver queued sideDialog replyTellask reminder after plain reply',
                    undefined,
                    {
                      dialogId: dialog.id.valueOf(),
                      targetCallId: activeTellaskReplyDirective.targetCallId,
                      targetCallerDialogId: calleeDialogReplyTarget?.callerDialogId,
                    },
                  );
                } else {
                  const directFallbackCallId = `direct-fallback-${generateShortId()}`;
                  let supplied = false;
                  if (calleeDialogReplyTarget) {
                    supplied = await supplySideDialogResponseToSpecificAskerIfPendingV2({
                      sideDialog: dialog,
                      responseText: directFallbackResponse.responseText,
                      responseGenseq: directFallbackResponse.responseGenseq,
                      target: calleeDialogReplyTarget,
                      deliveryMode: 'direct_fallback',
                      directFallbackSource: directFallbackResponse.source,
                      replyResolution: {
                        callId: directFallbackCallId,
                        replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                      },
                      scheduleDrive: args.scheduleDrive,
                    });
                    if (!supplied) {
                      supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
                        sideDialog: dialog,
                        responseText: directFallbackResponse.responseText,
                        responseGenseq: directFallbackResponse.responseGenseq,
                        deliveryMode: 'direct_fallback',
                        directFallbackSource: directFallbackResponse.source,
                        replyResolution: {
                          callId: directFallbackCallId,
                          replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                        },
                        scheduleDrive: args.scheduleDrive,
                      });
                    }
                  } else {
                    supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
                      sideDialog: dialog,
                      responseText: directFallbackResponse.responseText,
                      responseGenseq: directFallbackResponse.responseGenseq,
                      deliveryMode: 'direct_fallback',
                      directFallbackSource: directFallbackResponse.source,
                      replyResolution: {
                        callId: directFallbackCallId,
                        replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                      },
                      scheduleDrive: args.scheduleDrive,
                    });
                  }

                  if (!supplied && calleeDialogReplyTarget) {
                    const diagnostics = await loadPendingDiagnosticsSnapshot({
                      rootId: dialog.id.rootId,
                      callerDialogId: calleeDialogReplyTarget.callerDialogId,
                      expectedSideDialogId: dialog.id.selfId,
                      status: dialog.status,
                    });
                    log.debug(
                      'kernel-driver failed to supply sideDialog response to specific asker',
                      undefined,
                      {
                        calleeId: dialog.id.valueOf(),
                        targetCallerDialogId: calleeDialogReplyTarget.callerDialogId,
                        targetCallType: calleeDialogReplyTarget.callType,
                        targetCallId: calleeDialogReplyTarget.callId,
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
        !(dialog instanceof SideDialog) &&
        driveResult &&
        !interruptedBySignal &&
        resolveDirectFallbackResponse({ driveResult, dialog }) !== undefined &&
        activeTellaskReplyDirective?.expectedReplyCallName === 'replyTellaskBack' &&
        followUp === undefined
      ) {
        const directFallbackResponse = resolveDirectFallbackResponse({ driveResult, dialog });
        if (directFallbackResponse === undefined) {
          throw new Error(
            `replyTellaskBack fallback invariant violation: missing direct fallback response for dialog=${dialog.id.valueOf()}`,
          );
        }
        const hasInProgressFunctionCall =
          typeof driveResult.lastFunctionCallGenseq === 'number' &&
          Number.isFinite(driveResult.lastFunctionCallGenseq) &&
          driveResult.lastFunctionCallGenseq > 0 &&
          directFallbackResponse.responseGenseq <= driveResult.lastFunctionCallGenseq;
        // Same rule as Side Dialog final delivery: direct fallback is allowed only after the
        // candidate content is known to be post-tool and no same-round call is waiting to continue.
        if (!hasInProgressFunctionCall) {
          if (!activePromptWasReplyToolReminder) {
            const language = getWorkLanguage();
            followUp = {
              kind: 'runtime_reply_reminder',
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
              replyContent: directFallbackResponse.responseText,
              callbacks: {
                scheduleDrive: args.scheduleDrive,
                driveDialog: args.driveDialog,
              },
              deliveryMode: 'direct_fallback',
              directFallbackSource: directFallbackResponse.source,
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
        if (
          followUp.kind === 'runtime_reply_reminder' ||
          followUp.kind === 'runtime_sideDialog_reply_reminder'
        ) {
          await queueReplyReminderFollowUp({ dialog, followUp });
          args.scheduleDrive(dialog, {
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_follow_up',
              reason: 'follow_up_prompt',
              noPromptSideDialogResumeEntitlement:
                dialog instanceof SideDialog
                  ? {
                      callerDialogId: dialog.id.selfId,
                      reason: 'reply_obligation_follow_up',
                    }
                  : undefined,
            },
          });
          return driveResult;
        }
        args.scheduleDrive(dialog, {
          waitInQue: true,
          driveOptions: {
            source: 'kernel_driver_follow_up',
            reason: 'follow_up_prompt',
          },
          humanPrompt: (() => {
            const normalizedUserLanguageCode: KernelDriverPrompt['userLanguageCode'] =
              followUp.userLanguageCode === 'zh' || followUp.userLanguageCode === 'en'
                ? followUp.userLanguageCode
                : undefined;
            const common = {
              content: followUp.prompt,
              msgId: followUp.msgId,
              grammar: followUp.grammar ?? 'markdown',
              userLanguageCode: normalizedUserLanguageCode,
              runControl: followUp.runControl,
            };
            switch (followUp.kind) {
              case 'user_generation_boundary':
              case 'deferred_q4h_answer': {
                const prompt: KernelDriverUserPrompt = {
                  ...common,
                  origin: 'user',
                  ...(followUp.q4hAnswerCallId === undefined
                    ? {}
                    : { q4hAnswerCallId: followUp.q4hAnswerCallId }),
                };
                return prompt;
              }
              case 'registered_assignment_update':
              case 'new_course_runtime_guide':
              case 'new_course_runtime_reply':
              case 'new_course_runtime_sideDialog': {
                const runtimeCommon = {
                  ...common,
                  origin: 'runtime' as const,
                  ...(followUp.skipTaskdoc === undefined
                    ? {}
                    : { skipTaskdoc: followUp.skipTaskdoc }),
                };
                if (
                  followUp.kind === 'registered_assignment_update' ||
                  followUp.kind === 'new_course_runtime_sideDialog'
                ) {
                  const prompt: KernelDriverRuntimeSideDialogPrompt = {
                    ...runtimeCommon,
                    tellaskReplyDirective: followUp.tellaskReplyDirective,
                    calleeDialogReplyTarget: followUp.calleeDialogReplyTarget,
                  };
                  return prompt;
                }
                if (followUp.kind === 'new_course_runtime_reply') {
                  const prompt: KernelDriverRuntimeReplyPrompt = {
                    ...runtimeCommon,
                    tellaskReplyDirective: followUp.tellaskReplyDirective,
                  };
                  return prompt;
                }
                const prompt: KernelDriverRuntimePrompt = runtimeCommon;
                return prompt;
              }
            }
          })(),
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

    if (tailError === undefined && !coreEndedInterrupted) {
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
      try {
        await restoreAcceptedRootBackendQueueAfterDriveFailure({
          dialog,
          driveOptions,
          reason: 'tail_error',
          error: tailError,
          hadRootBackendQueueBeforeCore,
        });
      } catch (error: unknown) {
        log.error(
          'kernel-driver failed to requeue accepted root backend_queue after tail failure',
          error,
          {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          },
        );
      }
      throw tailError;
    }
    return driveResult;
  } finally {
    if (activeRunPrimed && ownsActiveRun) {
      clearActiveRun(dialog.id);
    }
    if (shouldRefreshDisplayStateAfterActiveRunCleared && !hasActiveRun(dialog.id)) {
      try {
        await setDialogDisplayState(dialog.id, await computeIdleDisplayState(dialog));
      } catch (error: unknown) {
        log.warn('kernel-driver failed to refresh display state after FBR auto-delivery', error, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
      }
    }
    release();
    maybeStartIdleReminderWake(
      dialog,
      {
        scheduleDrive: args.scheduleDrive,
        driveDialog: args.driveDialog,
      },
      driveOptions?.reason ?? 'drive_finished',
    );
  }
}
