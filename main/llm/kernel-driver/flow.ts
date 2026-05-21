import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type { DialogQueuedPromptState } from '@longrun-ai/kernel/types/drive-intent';
import type {
  DialogBusinessContinuation,
  DialogPendingRuntimePrompt,
  DialogReplyDeliveryState,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import {
  applyRegisteredAppDialogRunControls,
  renderAppRunControlBlockForPreDrive,
} from '../../apps/run-control';
import { DialogID, SideDialog, type Dialog } from '../../dialog';
import {
  clearActiveRun,
  computeIdleDisplayState,
  createActiveRun,
  getActiveRunSignal,
  getStopRequestedReason,
  hasActiveRun,
  setDialogDisplayState,
} from '../../dialog-display-state';
import {
  hasDurableDriveWork,
  hasRecoverableGenerationBeyondFinalResponse,
} from '../../dialog-drive-work';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { isInterruptedDialogBlockedWithoutExplicitResume } from '../../dialog-interruption';
import { createEmptyDialogNextStepState } from '../../dialog-latest-state';
import { postDialogEvent } from '../../evt-registry';
import { log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatNewCourseStartPrompt,
  isAgentFacingCriticalUserInterjectionRemediationGuideContent,
} from '../../runtime/driver-messages';
import { isUserInterjectionPauseStopReason } from '../../runtime/interjection-pause-stop';
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
  recoverPendingReplyDelivery,
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

type QueuedPrompt = DialogQueuedPromptState;

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

function hasSameReplyDirective(
  left: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>,
  right: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>,
): boolean {
  return (
    left.expectedReplyCallName === right.expectedReplyCallName &&
    left.targetDialogId === right.targetDialogId &&
    left.targetCallId === right.targetCallId &&
    left.tellaskContent === right.tellaskContent
  );
}

function hasSameCalleeReplyTarget(
  left: NonNullable<KernelDriverPrompt['calleeDialogReplyTarget']>,
  right: NonNullable<KernelDriverPrompt['calleeDialogReplyTarget']>,
): boolean {
  return (
    left.callerDialogId === right.callerDialogId &&
    left.callId === right.callId &&
    left.callType === right.callType &&
    left.callSiteCourse === right.callSiteCourse &&
    left.callSiteGenseq === right.callSiteGenseq
  );
}

function buildCurrentSideDialogAssignmentReplyDirective(
  dialog: SideDialog,
): NonNullable<KernelDriverPrompt['tellaskReplyDirective']> {
  switch (dialog.assignmentFromAsker.callName) {
    case 'tellask':
      return {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dialog.assignmentFromAsker.askerDialogId,
        targetCallId: dialog.assignmentFromAsker.callId,
        tellaskContent: dialog.assignmentFromAsker.tellaskContent,
      };
    case 'tellaskSessionless':
    case 'freshBootsReasoning':
      return {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: dialog.assignmentFromAsker.askerDialogId,
        targetCallId: dialog.assignmentFromAsker.callId,
        tellaskContent: dialog.assignmentFromAsker.tellaskContent,
      };
    default: {
      const _exhaustive: never = dialog.assignmentFromAsker.callName;
      throw new Error(`Unsupported sideDialog assignment callName: ${_exhaustive}`);
    }
  }
}

function isQueuedReplyObligationContinuation(
  prompt: QueuedPrompt,
): prompt is Extract<
  QueuedPrompt,
  { kind: 'new_course_runtime_reply' | 'new_course_runtime_sideDialog' }
> {
  return (
    (prompt.kind === 'new_course_runtime_reply' ||
      prompt.kind === 'new_course_runtime_sideDialog') &&
    isReplyToolReminderPromptContent(prompt.prompt)
  );
}

function isPendingRuntimePromptFollowUp(prompt: QueuedPrompt): boolean {
  switch (prompt.kind) {
    case 'new_course_runtime_guide':
    case 'new_course_runtime_reply':
    case 'new_course_runtime_sideDialog':
      return true;
    case 'user_generation_boundary':
    case 'deferred_q4h_answer':
    case 'registered_assignment_update':
      return false;
    default: {
      const _exhaustive: never = prompt;
      throw new Error(`Unsupported queued prompt kind for pending-runtime follow-up check`);
    }
  }
}

function latestHasTellaskResultForCallId(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
  targetCallId: string,
): boolean {
  return (
    latest?.tellaskResults.results.some((entry) => entry.callId.trim() === targetCallId) === true
  );
}

async function claimQueuedReplyObligationContinuation(args: {
  dialog: KernelDriverDriveArgs[0];
  prompt: Extract<
    QueuedPrompt,
    { kind: 'new_course_runtime_reply' | 'new_course_runtime_sideDialog' }
  >;
}): Promise<'claimed' | 'stale'> {
  const directive = args.prompt.tellaskReplyDirective;
  const targetCallId = directive.targetCallId.trim();
  const targetDialogId = directive.targetDialogId.trim();
  if (targetCallId === '' || targetDialogId === '') {
    throw new Error(
      `reply obligation continuation invariant violation: empty target identity ` +
        `(dialog=${args.dialog.id.valueOf()}, targetDialogId=${directive.targetDialogId}, targetCallId=${directive.targetCallId})`,
    );
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (latest?.sideDialogFinalResponse?.callId.trim() === targetCallId) {
    return 'stale';
  }
  if (latestHasTellaskResultForCallId(latest, targetCallId)) {
    return 'stale';
  }
  const targetLatest =
    targetDialogId === args.dialog.id.selfId
      ? latest
      : await DialogPersistence.loadDialogLatest(
          new DialogID(targetDialogId, args.dialog.id.rootId),
          args.dialog.status,
        );
  if (latestHasTellaskResultForCallId(targetLatest, targetCallId)) {
    return 'stale';
  }

  if (args.dialog instanceof SideDialog) {
    const assignmentDirective = buildCurrentSideDialogAssignmentReplyDirective(args.dialog);
    if (hasSameReplyDirective(assignmentDirective, directive)) {
      return 'claimed';
    }
  }

  const activeDirective = await loadActiveTellaskReplyDirective(args.dialog);
  if (!activeDirective) {
    return 'stale';
  }
  if (activeDirective.targetCallId !== directive.targetCallId) {
    return 'stale';
  }
  if (!hasSameReplyDirective(activeDirective, directive)) {
    throw new Error(
      `reply obligation continuation invariant violation: active obligation changed for callId=${directive.targetCallId} ` +
        `(dialog=${args.dialog.id.valueOf()}, expectedReplyCallName=${directive.expectedReplyCallName}, ` +
        `activeReplyCallName=${activeDirective.expectedReplyCallName}, targetDialogId=${directive.targetDialogId}, ` +
        `activeTargetDialogId=${activeDirective.targetDialogId})`,
    );
  }
  return 'claimed';
}

async function resolveSideDialogReplyDirectiveForAssistantOutput(args: {
  dialog: SideDialog;
  responseGenseq: number;
  replyTarget: CalleeReplyTarget | undefined;
  currentDirective: KernelDriverPrompt['tellaskReplyDirective'];
}): Promise<KernelDriverPrompt['tellaskReplyDirective']> {
  const replyTarget = args.replyTarget;
  const targetCallId = replyTarget?.callId.trim();
  if (!replyTarget || !targetCallId) {
    return args.currentDirective;
  }
  if (args.currentDirective?.targetCallId === targetCallId) {
    return args.currentDirective;
  }

  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (!latest) {
    return args.currentDirective;
  }
  if (latest.sideDialogFinalResponse?.callId.trim() === targetCallId) {
    return args.currentDirective;
  }
  if (latestHasTellaskResultForCallId(latest, targetCallId)) {
    return args.currentDirective;
  }

  const assignmentDirective = buildCurrentSideDialogAssignmentReplyDirective(args.dialog);
  if (assignmentDirective.targetCallId !== targetCallId) {
    return args.currentDirective;
  }
  if (
    assignmentDirective.targetDialogId !== replyTarget.callerDialogId ||
    assignmentDirective.targetCallId !== replyTarget.callId
  ) {
    return args.currentDirective;
  }

  const latestAssignmentAnchor = latest.latestAssignmentAnchor;
  if (
    latestAssignmentAnchor?.callId !== targetCallId ||
    args.responseGenseq < latestAssignmentAnchor.assignmentGenseq
  ) {
    return args.currentDirective;
  }

  const activeDirective = await loadActiveTellaskReplyDirective(args.dialog);
  if (activeDirective && !hasSameReplyDirective(activeDirective, assignmentDirective)) {
    throw new Error(
      `sideDialog assistant output reply directive invariant violation: active obligation does not match latest assignment ` +
        `(dialog=${args.dialog.id.valueOf()}, targetCallId=${targetCallId}, ` +
        `activeTargetCallId=${activeDirective.targetCallId}, assignmentTargetCallId=${assignmentDirective.targetCallId})`,
    );
  }
  return activeDirective ?? assignmentDirective;
}

function hasQ4HAnswerCallId(callId: string | undefined): boolean {
  return typeof callId === 'string' && callId.trim() !== '';
}

function isEffectiveUserPromptForContextHealth(prompt: KernelDriverPrompt | undefined): boolean {
  return prompt?.origin === 'user' && !hasQ4HAnswerCallId(prompt.q4hAnswerCallId);
}

function isQueuedUserPromptForContextHealth(prompt: QueuedPrompt | undefined): boolean {
  return prompt?.kind === 'user_generation_boundary' && !hasQ4HAnswerCallId(prompt.q4hAnswerCallId);
}

function isNonIdleDisplayProjection(state: DialogDisplayState | undefined): boolean {
  return state !== undefined && state.kind !== 'idle_waiting_user';
}

function hasPendingNextStepTriggers(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
): boolean {
  return (latest?.nextStep.triggers.length ?? 0) > 0;
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

async function clearConsumedRootRuntimeWakeIfIdle(dialog: Dialog): Promise<void> {
  if (dialog.id.selfId !== dialog.id.rootId) {
    return;
  }
  if (!globalDialogRegistry.get(dialog.id.rootId)) {
    return;
  }
  const suspension = await dialog.getSuspensionStatus();
  if (dialog.hasQueuedPrompt() || !suspension.canDrive) {
    return;
  }
  const hasRootRuntimeWake = await DialogPersistence.hasRootRuntimeWake(dialog.id, dialog.status);
  if (!hasRootRuntimeWake) {
    return;
  }
  try {
    await DialogPersistence.removeRootRuntimeWake(dialog.id, dialog.status);
  } catch (error: unknown) {
    log.error('kernel-driver failed to persist consumed root runtime wake cleanup', error, {
      dialogId: dialog.id.valueOf(),
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
    });
    return;
  }
  globalDialogRegistry.clearRootDriveQueue(dialog.id.rootId, {
    source: 'kernel_driver_flow_tail',
    reason: 'root_idle_after_consuming_deferred_queue',
  });
}

function formatPreDriveExecutionFactsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function restoreRootRuntimeWakeAfterDriveFailure(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
  reason: 'core_stopped' | 'tail_error';
  error?: unknown;
  hadRootRuntimeWakeBeforeCore?: boolean;
}): Promise<void> {
  if (args.dialog.id.selfId !== args.dialog.id.rootId) {
    return;
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (args.hadRootRuntimeWakeBeforeCore !== true) {
    return;
  }
  if (args.reason === 'core_stopped' && latest?.executionMarker?.kind !== 'interrupted') {
    return;
  }
  const reason = `${args.reason}_requeue:${args.driveOptions?.reason ?? 'unknown'}`;
  await DialogPersistence.upsertRootRuntimeWake(args.dialog.id, reason, args.dialog.status);
  globalDialogRegistry.queueRootDrive(args.dialog.id.rootId, {
    source: 'kernel_driver_flow_tail',
    reason,
  });
  log.warn('kernel-driver requeued root runtime wake after drive failure', args.error, {
    dialogId: args.dialog.id.valueOf(),
    rootId: args.dialog.id.rootId,
    selfId: args.dialog.id.selfId,
    requeueReason: args.reason,
    hadRootRuntimeWakeBeforeCore: args.hadRootRuntimeWakeBeforeCore === true,
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
      previousNextStepTriggerCount: latest?.nextStep.triggers.length ?? null,
    };
  }

  await DialogPersistence.mutateDialogLatest(
    args.dialog.id,
    () => ({
      kind: 'patch',
      patch: {
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        displayState: { kind: 'idle_waiting_user' } as const,
        executionMarker: undefined,
      },
    }),
    args.dialog.status,
  );
  await DialogPersistence.removeWakeQueueEntriesForDialog(args.dialog.id, args.dialog.status);
  return {
    cleared: true,
    previousGenerating: latest.generating ?? null,
    previousNextStepTriggerCount: latest.nextStep.triggers.length,
  };
}

function hasResultArrivalTriggerForBatch(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
  batchId: string,
): boolean {
  return (
    latest?.nextStep.triggers.some(
      (trigger) => trigger.kind === 'result_arrival' && trigger.batchId === batchId,
    ) === true
  );
}

function listResultArrivalBatchIds(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
): readonly string[] {
  const batchIds: string[] = [];
  const seen = new Set<string>();
  for (const trigger of latest?.nextStep.triggers ?? []) {
    if (trigger.kind !== 'result_arrival') {
      continue;
    }
    if (seen.has(trigger.batchId)) {
      continue;
    }
    seen.add(trigger.batchId);
    batchIds.push(trigger.batchId);
  }
  return batchIds;
}

function hasSupplyResponseBusinessContinuation(
  dialog: Dialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const continuation = driveOptions?.businessContinuation;
  if (!continuation) {
    return false;
  }
  if (driveOptions?.source !== 'kernel_driver_business_continuation') {
    return false;
  }
  if (continuation.kind === 'local_tellask_result') {
    return continuation.callerDialogId === dialog.id.selfId;
  }
  return (
    continuation.kind === 'requested_work_reply' &&
    continuation.callerDialogId === dialog.id.selfId &&
    isPositiveInteger(continuation.callSiteCourse) &&
    isPositiveInteger(continuation.callSiteGenseq)
  );
}

function hasRequestedWorkReplyContinuation(
  dialog: Dialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const continuation = driveOptions?.businessContinuation;
  return (
    driveOptions?.source === 'kernel_driver_business_continuation' &&
    continuation?.kind === 'requested_work_reply' &&
    continuation.callerDialogId === dialog.id.selfId &&
    isPositiveInteger(continuation.callSiteCourse) &&
    isPositiveInteger(continuation.callSiteGenseq)
  );
}

type RequestedWorkReplyContinuationClaim =
  | Readonly<{ status: 'claimed'; batchId: string }>
  | Readonly<{ status: 'stale'; batchId: string }>
  | Readonly<{ status: 'not_applicable' }>;

type ReplyDeliveryRecoveryContinuationClaim =
  | Readonly<{ status: 'claimed'; replyDelivery: DialogReplyDeliveryState }>
  | Readonly<{
      status: 'stale';
      replyDeliveryId: string;
      reason: 'missing_reply_delivery' | 'completed_reply_delivery';
    }>
  | Readonly<{ status: 'not_applicable' }>;

type ToolFollowupContinuationClaim =
  | Readonly<{ status: 'claimed'; triggerIds: readonly string[] }>
  | Readonly<{ status: 'not_applicable' }>;

type PendingRuntimePromptClaim =
  | Readonly<{ status: 'claimed'; pendingRuntimePrompt: DialogPendingRuntimePrompt }>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'not_applicable' }>;

function resolveDirectRequestedWorkRepliedBatchId(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): string | undefined {
  const continuation = args.driveOptions?.businessContinuation;
  if (
    args.driveOptions?.source !== 'kernel_driver_business_continuation' ||
    continuation?.kind !== 'requested_work_reply' ||
    continuation.callerDialogId !== args.dialog.id.selfId
  ) {
    return undefined;
  }
  const batchId = continuation.batchId.trim();
  if (batchId === '') {
    throw new Error(
      `requested work reply continuation invariant violation: empty batchId ` +
        `(dialog=${args.dialog.id.valueOf()}, reason=${args.driveOptions.reason})`,
    );
  }
  return batchId;
}

async function removeStaleRequestedWorkReplyTriggers(args: {
  dialog: Dialog;
  batchIds: readonly string[];
}): Promise<void> {
  const staleBatchIds = new Set(args.batchIds);
  if (staleBatchIds.size === 0) {
    return;
  }
  await DialogPersistence.removeNextStepTriggers(
    args.dialog.id,
    (trigger) => trigger.kind === 'result_arrival' && staleBatchIds.has(trigger.batchId),
    args.dialog.status,
  );
}

function assertResolvedRequestedWorkReplyBatch(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
  batchId: string;
  status: string;
}): void {
  if (args.status === 'resolved') {
    return;
  }
  const reason = args.driveOptions?.reason ?? 'unknown';
  throw new Error(
    `requested work reply continuation invariant violation: unresolved active callee batch ` +
      `(dialog=${args.dialog.id.valueOf()}, reason=${reason}, ` +
      `batchId=${args.batchId}, status=${args.status})`,
  );
}

async function claimRequestedWorkRepliedBatchForDrive(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
  batchId: string;
}): Promise<RequestedWorkReplyContinuationClaim> {
  const activeCallees = await DialogPersistence.loadActiveCallees(
    args.dialog.id,
    args.dialog.status,
  );
  const batch = activeCallees.batches.find((entry) => entry.batchId === args.batchId);
  if (batch === undefined) {
    await removeStaleRequestedWorkReplyTriggers({
      dialog: args.dialog,
      batchIds: [args.batchId],
    });
    return { status: 'stale', batchId: args.batchId };
  }
  assertResolvedRequestedWorkReplyBatch({
    dialog: args.dialog,
    driveOptions: args.driveOptions,
    batchId: args.batchId,
    status: batch.status,
  });
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (!hasResultArrivalTriggerForBatch(latest, args.batchId)) {
    // `active-callees` is the authority for whether the reply batch is still unconsumed. The
    // `result_arrival` trigger is just the gen-start handoff that will consume that active-callees
    // batch. If a resolved batch survived but its trigger was lost, rebuild this business-local
    // trigger instead of treating trigger absence as stale.
    await DialogPersistence.upsertNextStepTrigger(
      args.dialog.id,
      {
        triggerId: `result-arrival:${args.batchId}`,
        kind: 'result_arrival',
        batchId: args.batchId,
      },
      args.dialog.status,
    );
  }
  return { status: 'claimed', batchId: args.batchId };
}

async function claimBackendLoopRequestedWorkRepliedContinuation(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<RequestedWorkReplyContinuationClaim> {
  if (args.driveOptions?.source !== 'kernel_driver_backend_loop') {
    return { status: 'not_applicable' };
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const triggerBatchIds = listResultArrivalBatchIds(latest);
  if (triggerBatchIds.length === 0) {
    return { status: 'not_applicable' };
  }
  const activeCallees = await DialogPersistence.loadActiveCallees(
    args.dialog.id,
    args.dialog.status,
  );
  const staleBatchIds: string[] = [];
  let claimedBatchId: string | undefined;
  for (const batchId of triggerBatchIds) {
    const batch = activeCallees.batches.find((entry) => entry.batchId === batchId);
    if (batch === undefined) {
      staleBatchIds.push(batchId);
      continue;
    }
    assertResolvedRequestedWorkReplyBatch({
      dialog: args.dialog,
      driveOptions: args.driveOptions,
      batchId,
      status: batch.status,
    });
    if (claimedBatchId === undefined) {
      claimedBatchId = batchId;
    }
  }
  if (staleBatchIds.length > 0) {
    // This is still requested-work reply business logic, not generic trigger cleanup. A
    // `result_arrival` trigger whose batch has left `active-callees` is already consumed. Remove
    // only those stale handoff cues so this backend wake can continue to claim any still-live batch.
    await removeStaleRequestedWorkReplyTriggers({
      dialog: args.dialog,
      batchIds: staleBatchIds,
    });
  }
  if (claimedBatchId !== undefined) {
    return { status: 'claimed', batchId: claimedBatchId };
  }
  return { status: 'stale', batchId: staleBatchIds[0] ?? triggerBatchIds[0]! };
}

async function claimRequestedWorkRepliedContinuationForDrive(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<RequestedWorkReplyContinuationClaim> {
  const directBatchId = resolveDirectRequestedWorkRepliedBatchId(args);
  if (directBatchId !== undefined) {
    return await claimRequestedWorkRepliedBatchForDrive({
      dialog: args.dialog,
      driveOptions: args.driveOptions,
      batchId: directBatchId,
    });
  }
  return await claimBackendLoopRequestedWorkRepliedContinuation({
    dialog: args.dialog,
    driveOptions: args.driveOptions,
  });
}

async function removeReplyDeliveryRecoveryTriggers(args: {
  dialog: Dialog;
  replyDeliveryIds: readonly string[];
}): Promise<void> {
  const replyDeliveryIds = new Set(args.replyDeliveryIds);
  if (replyDeliveryIds.size === 0) {
    return;
  }
  await DialogPersistence.removeNextStepTriggers(
    args.dialog.id,
    (trigger) =>
      trigger.kind === 'reply_delivery_recovery' && replyDeliveryIds.has(trigger.replyDeliveryId),
    args.dialog.status,
  );
}

async function failReplyDeliveryRecoveryInvariant(args: {
  dialog: Dialog;
  replyDelivery: DialogReplyDeliveryState;
  detail: string;
  extra?: Record<string, unknown>;
}): Promise<never> {
  const message =
    `reply delivery recovery invariant violation: ${args.detail} ` +
    `(rootId=${args.dialog.id.rootId}, selfId=${args.dialog.id.selfId}, ` +
    `replyDeliveryId=${args.replyDelivery.replyDeliveryId}, ` +
    `replyCallId=${args.replyDelivery.replyCallId}, ` +
    `targetDialogId=${args.replyDelivery.targetDialogId}, ` +
    `targetCallId=${args.replyDelivery.targetCallId})`;
  const error = new Error(message);
  log.error('Reply delivery recovery invariant violation', error, {
    rootId: args.dialog.id.rootId,
    selfId: args.dialog.id.selfId,
    course: args.dialog.currentCourse,
    genseq: args.replyDelivery.replyGenseq,
    callId: args.replyDelivery.replyCallId,
    replyDeliveryId: args.replyDelivery.replyDeliveryId,
    targetDialogId: args.replyDelivery.targetDialogId,
    targetCallId: args.replyDelivery.targetCallId,
    status: args.replyDelivery.status,
    toolResultStatus: args.replyDelivery.toolResultStatus,
    ...args.extra,
  });
  try {
    await args.dialog.streamError(message);
  } catch (streamError: unknown) {
    log.warn('Failed to emit stream_error_evt for reply delivery recovery invariant', streamError, {
      rootId: args.dialog.id.rootId,
      selfId: args.dialog.id.selfId,
      callId: args.replyDelivery.replyCallId,
      replyDeliveryId: args.replyDelivery.replyDeliveryId,
    });
  }
  throw error;
}

async function assertReplyDeliveryRecoveryCorrelation(args: {
  dialog: Dialog;
  replyDelivery: DialogReplyDeliveryState;
}): Promise<void> {
  if (args.replyDelivery.status !== 'pending') {
    return;
  }
  const activeDirective = await loadActiveTellaskReplyDirective(args.dialog);
  if (!activeDirective) {
    await failReplyDeliveryRecoveryInvariant({
      dialog: args.dialog,
      replyDelivery: args.replyDelivery,
      detail: 'pending delivery has no active reply obligation',
    });
    return;
  }
  if (
    activeDirective.expectedReplyCallName !== args.replyDelivery.expectedReplyCallName ||
    activeDirective.targetDialogId !== args.replyDelivery.targetDialogId ||
    activeDirective.targetCallId !== args.replyDelivery.targetCallId
  ) {
    await failReplyDeliveryRecoveryInvariant({
      dialog: args.dialog,
      replyDelivery: args.replyDelivery,
      detail: 'pending delivery does not match active reply obligation',
      extra: {
        activeExpectedReplyCallName: activeDirective.expectedReplyCallName,
        activeTargetDialogId: activeDirective.targetDialogId,
        activeTargetCallId: activeDirective.targetCallId,
      },
    });
  }
}

async function claimReplyDeliveryRecoveryContinuationForDrive(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<ReplyDeliveryRecoveryContinuationClaim> {
  if (args.driveOptions?.source !== 'kernel_driver_backend_loop') {
    return { status: 'not_applicable' };
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  if (!latest) {
    return { status: 'not_applicable' };
  }
  const recoveryTriggers = latest.nextStep.triggers.filter(
    (trigger) => trigger.kind === 'reply_delivery_recovery',
  );
  const replyDelivery = latest.replyDelivery;
  if (!replyDelivery) {
    await removeReplyDeliveryRecoveryTriggers({
      dialog: args.dialog,
      replyDeliveryIds: recoveryTriggers.map((trigger) => trigger.replyDeliveryId),
    });
    const firstStale = recoveryTriggers[0];
    return firstStale === undefined
      ? { status: 'not_applicable' }
      : {
          status: 'stale',
          replyDeliveryId: firstStale.replyDeliveryId,
          reason: 'missing_reply_delivery',
        };
  }

  const pending =
    replyDelivery.status === 'pending' || replyDelivery.toolResultStatus === 'pending';
  if (!pending) {
    await removeReplyDeliveryRecoveryTriggers({
      dialog: args.dialog,
      replyDeliveryIds: recoveryTriggers.map((trigger) => trigger.replyDeliveryId),
    });
    return recoveryTriggers.length === 0
      ? { status: 'not_applicable' }
      : {
          status: 'stale',
          replyDeliveryId: replyDelivery.replyDeliveryId,
          reason: 'completed_reply_delivery',
        };
  }

  const staleTriggerIds: string[] = [];
  for (const trigger of recoveryTriggers) {
    if (trigger.replyDeliveryId !== replyDelivery.replyDeliveryId) {
      staleTriggerIds.push(trigger.replyDeliveryId);
      continue;
    }
    if (trigger.targetDialogId !== replyDelivery.targetDialogId) {
      await failReplyDeliveryRecoveryInvariant({
        dialog: args.dialog,
        replyDelivery,
        detail: 'recovery trigger target does not match reply delivery target',
        extra: {
          triggerId: trigger.triggerId,
          triggerTargetDialogId: trigger.targetDialogId,
        },
      });
    }
  }
  if (staleTriggerIds.length > 0) {
    await removeReplyDeliveryRecoveryTriggers({
      dialog: args.dialog,
      replyDeliveryIds: staleTriggerIds,
    });
    log.warn(
      'Dropped stale reply delivery recovery trigger(s) before claiming current delivery',
      undefined,
      {
        rootId: args.dialog.id.rootId,
        selfId: args.dialog.id.selfId,
        replyDeliveryId: replyDelivery.replyDeliveryId,
        staleReplyDeliveryIds: staleTriggerIds,
      },
    );
  }

  await assertReplyDeliveryRecoveryCorrelation({
    dialog: args.dialog,
    replyDelivery,
  });
  return { status: 'claimed', replyDelivery };
}

async function claimToolFollowupContinuationForDrive(args: {
  dialog: Dialog;
  driveOptions: KernelDriverDriveOptions | undefined;
}): Promise<ToolFollowupContinuationClaim> {
  if (args.driveOptions?.source !== 'kernel_driver_backend_loop') {
    return { status: 'not_applicable' };
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const followupTriggers =
    latest?.nextStep.triggers.filter((trigger) => trigger.kind === 'followup') ?? [];
  if (followupTriggers.length === 0) {
    return { status: 'not_applicable' };
  }
  return {
    status: 'claimed',
    triggerIds: followupTriggers.map((trigger) => trigger.triggerId),
  };
}

function isPendingRuntimePromptQueuePrompt(prompt: QueuedPrompt): boolean {
  switch (prompt.kind) {
    case 'new_course_runtime_guide':
    case 'new_course_runtime_reply':
    case 'new_course_runtime_sideDialog':
      return true;
    case 'user_generation_boundary':
    case 'deferred_q4h_answer':
    case 'registered_assignment_update':
      return false;
    default: {
      const _exhaustive: never = prompt;
      throw new Error(`Unsupported queued prompt kind for pending-runtime claim`);
    }
  }
}

function pendingRuntimePromptMatchesQueuePrompt(args: {
  pendingRuntimePrompt: DialogPendingRuntimePrompt;
  prompt: QueuedPrompt;
}): boolean {
  if (!isPendingRuntimePromptQueuePrompt(args.prompt)) {
    return false;
  }
  if (
    args.pendingRuntimePrompt.msgId !== args.prompt.msgId ||
    args.pendingRuntimePrompt.content !== args.prompt.prompt ||
    args.pendingRuntimePrompt.grammar !== (args.prompt.grammar ?? 'markdown') ||
    args.pendingRuntimePrompt.origin !== args.prompt.origin ||
    args.pendingRuntimePrompt.skipTaskdoc !== args.prompt.skipTaskdoc
  ) {
    return false;
  }
  if (args.pendingRuntimePrompt.userLanguageCode !== args.prompt.userLanguageCode) {
    return false;
  }
  if (args.pendingRuntimePrompt.tellaskReplyDirective === undefined) {
    return args.prompt.kind === 'new_course_runtime_guide';
  }
  if (
    args.prompt.kind === 'new_course_runtime_guide' ||
    !hasSameReplyDirective(
      args.pendingRuntimePrompt.tellaskReplyDirective,
      args.prompt.tellaskReplyDirective,
    )
  ) {
    return false;
  }
  if (args.pendingRuntimePrompt.calleeDialogReplyTarget === undefined) {
    return args.prompt.kind === 'new_course_runtime_reply';
  }
  return (
    args.prompt.kind === 'new_course_runtime_sideDialog' &&
    hasSameCalleeReplyTarget(
      args.pendingRuntimePrompt.calleeDialogReplyTarget,
      args.prompt.calleeDialogReplyTarget,
    )
  );
}

async function claimPendingRuntimePromptForDrive(args: {
  dialog: Dialog;
  prompt: QueuedPrompt;
}): Promise<PendingRuntimePromptClaim> {
  if (!isPendingRuntimePromptQueuePrompt(args.prompt)) {
    return { status: 'not_applicable' };
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dialog.id, args.dialog.status);
  const pendingRuntimePrompt = latest?.pendingRuntimePrompt;
  if (pendingRuntimePrompt === undefined) {
    return { status: 'stale' };
  }
  if (pendingRuntimePrompt.msgId !== args.prompt.msgId) {
    throw new Error(
      `pending runtime prompt invariant violation: queued prompt msgId does not match durable pending prompt ` +
        `(rootId=${args.dialog.id.rootId}, selfId=${args.dialog.id.selfId}, ` +
        `queuedMsgId=${args.prompt.msgId}, pendingMsgId=${pendingRuntimePrompt.msgId})`,
    );
  }
  if (!pendingRuntimePromptMatchesQueuePrompt({ pendingRuntimePrompt, prompt: args.prompt })) {
    throw new Error(
      `pending runtime prompt invariant violation: queued prompt does not match durable pending prompt ` +
        `(rootId=${args.dialog.id.rootId}, selfId=${args.dialog.id.selfId}, msgId=${args.prompt.msgId})`,
    );
  }
  return { status: 'claimed', pendingRuntimePrompt };
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

async function inspectSideDialogBusinessContinuationDrive(args: {
  dialog: SideDialog;
  driveOptions: KernelDriverDriveOptions | undefined;
  requestedWorkReplyClaim: RequestedWorkReplyContinuationClaim;
  replyDeliveryRecoveryClaim: ReplyDeliveryRecoveryContinuationClaim;
  toolFollowupClaim: ToolFollowupContinuationClaim;
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
        | 'stale_consumed_result_arrival'
        | 'missing_explicit_continuation';
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
  const inProgressGenerationResumeAllowed =
    args.driveOptions?.resumeInProgressGeneration === true &&
    latest !== null &&
    latest !== undefined &&
    hasRecoverableGenerationBeyondFinalResponse(latest);
  const requestedWorkReplyContinuation = hasRequestedWorkReplyContinuation(
    args.dialog,
    args.driveOptions,
  );
  const sameBatchResultArrivalClaimed = args.requestedWorkReplyClaim.status === 'claimed';
  const toolFollowupClaimed = args.toolFollowupClaim.status === 'claimed';
  const replyDeliveryRecoveryClaimed = args.replyDeliveryRecoveryClaim.status === 'claimed';
  const supplyResponseBusinessContinuationAllowed =
    hasSupplyResponseBusinessContinuation(args.dialog, args.driveOptions) &&
    (!requestedWorkReplyContinuation || sameBatchResultArrivalClaimed);
  const backendLoopDurableWorkAllowed =
    source === 'kernel_driver_backend_loop' &&
    (sameBatchResultArrivalClaimed || toolFollowupClaimed || replyDeliveryRecoveryClaimed);
  const finalResponseContinuationAllowed =
    sideDialogFinalResponseCallId !== undefined &&
    ((requestedWorkReplyContinuation && sameBatchResultArrivalClaimed) ||
      backendLoopDurableWorkAllowed ||
      inProgressGenerationResumeAllowed);
  if (sideDialogFinalResponseCallId !== undefined && !finalResponseContinuationAllowed) {
    return {
      shouldReject: true,
      source,
      rejection: 'finalized_after_response_anchor',
      displayState,
      currentCourse,
      sideDialogFinalResponseCallId,
    };
  }
  if (requestedWorkReplyContinuation && args.requestedWorkReplyClaim.status !== 'claimed') {
    return {
      shouldReject: true,
      source,
      rejection: 'stale_consumed_result_arrival',
      displayState,
      currentCourse,
      sideDialogFinalResponseCallId,
    };
  }
  if (
    !explicitInterruptedResumeAllowed &&
    !inProgressGenerationResumeAllowed &&
    !supplyResponseBusinessContinuationAllowed &&
    !backendLoopDurableWorkAllowed
  ) {
    return {
      shouldReject: true,
      source,
      rejection: 'missing_explicit_continuation',
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
  // once a legacy blocked Continue path surfaces the guide, it becomes a first-class historical
  // context fact and later real driving should need no special duplicate reassertion path.
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
    fromQueuedPrompt: boolean;
    droppedStaleQueuedContinuation: boolean;
  }>
> {
  if (humanPrompt) {
    return { prompt: humanPrompt, fromQueuedPrompt: false, droppedStaleQueuedContinuation: false };
  }
  let droppedStaleQueuedContinuation = false;
  for (;;) {
    const queuedPrompt: QueuedPrompt | undefined = dialog.peekQueuedPrompt();
    if (!queuedPrompt) {
      return {
        prompt: await maybeResolveDeferredReplyReassertionPrompt(dialog),
        fromQueuedPrompt: false,
        droppedStaleQueuedContinuation,
      };
    }

    if (isQueuedReplyObligationContinuation(queuedPrompt)) {
      const claim = await claimQueuedReplyObligationContinuation({ dialog, prompt: queuedPrompt });
      if (claim === 'stale') {
        const discarded = dialog.takeQueuedPrompt();
        if (!discarded || discarded.msgId !== queuedPrompt.msgId) {
          throw new Error(
            `reply obligation continuation invariant violation: expected queued prompt ${queuedPrompt.msgId} before stale discard`,
          );
        }
        await DialogPersistence.clearPendingRuntimePrompt(
          dialog.id,
          queuedPrompt.msgId,
          dialog.status,
        );
        log.debug('kernel-driver dropped stale reply obligation continuation', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          msgId: queuedPrompt.msgId,
          targetCallId: queuedPrompt.tellaskReplyDirective.targetCallId,
          expectedReplyCallName: queuedPrompt.tellaskReplyDirective.expectedReplyCallName,
        });
        droppedStaleQueuedContinuation = true;
        continue;
      }
    }

    const pendingRuntimePromptClaim = await claimPendingRuntimePromptForDrive({
      dialog,
      prompt: queuedPrompt,
    });
    if (pendingRuntimePromptClaim.status === 'stale') {
      const discarded = dialog.takeQueuedPrompt();
      if (!discarded || discarded.msgId !== queuedPrompt.msgId) {
        throw new Error(
          `pending runtime prompt invariant violation: expected queued prompt ${queuedPrompt.msgId} before stale discard`,
        );
      }
      log.debug('kernel-driver dropped stale pending runtime prompt continuation', undefined, {
        dialogId: dialog.id.valueOf(),
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        msgId: queuedPrompt.msgId,
        kind: queuedPrompt.kind,
      });
      droppedStaleQueuedContinuation = true;
      continue;
    }

    return {
      fromQueuedPrompt: true,
      droppedStaleQueuedContinuation,
      prompt: (() => {
        const normalizedUserLanguageCode: KernelDriverPrompt['userLanguageCode'] =
          queuedPrompt.userLanguageCode === 'zh' || queuedPrompt.userLanguageCode === 'en'
            ? queuedPrompt.userLanguageCode
            : undefined;
        const common = {
          content: queuedPrompt.prompt,
          msgId: queuedPrompt.msgId,
          grammar: queuedPrompt.grammar ?? 'markdown',
          userLanguageCode: normalizedUserLanguageCode,
          runControl: queuedPrompt.runControl,
        };
        switch (queuedPrompt.kind) {
          case 'user_generation_boundary':
          case 'deferred_q4h_answer': {
            const prompt: KernelDriverUserPrompt = {
              ...common,
              origin: 'user',
              ...(queuedPrompt.q4hAnswerCallId === undefined
                ? {}
                : { q4hAnswerCallId: queuedPrompt.q4hAnswerCallId }),
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
              ...(queuedPrompt.skipTaskdoc === undefined
                ? {}
                : { skipTaskdoc: queuedPrompt.skipTaskdoc }),
            };
            if (
              queuedPrompt.kind === 'registered_assignment_update' ||
              queuedPrompt.kind === 'new_course_runtime_sideDialog'
            ) {
              const prompt: KernelDriverRuntimeSideDialogPrompt = {
                ...runtimeCommon,
                tellaskReplyDirective: queuedPrompt.tellaskReplyDirective,
                calleeDialogReplyTarget: queuedPrompt.calleeDialogReplyTarget,
              };
              return prompt;
            }
            if (queuedPrompt.kind === 'new_course_runtime_reply') {
              const prompt: KernelDriverRuntimeReplyPrompt = {
                ...runtimeCommon,
                tellaskReplyDirective: queuedPrompt.tellaskReplyDirective,
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
  let shouldDriveQueuedPromptAfterCore = false;
  let activeBusinessContinuation: DialogBusinessContinuation =
    driveOptions?.businessContinuation ?? { kind: 'none' };
  const replyContinuationScope = {
    refresh(continuation: DialogBusinessContinuation): void {
      activeBusinessContinuation = continuation;
    },
    directive(): KernelDriverPrompt['tellaskReplyDirective'] | undefined {
      switch (activeBusinessContinuation.kind) {
        case 'none':
          return undefined;
        case 'inter_dialog_reply':
          return activeBusinessContinuation.tellaskReplyDirective;
        case 'requested_work_reply':
        case 'local_tellask_result':
          return undefined;
        default: {
          const _exhaustive: never = activeBusinessContinuation;
          throw new Error(`Unhandled business continuation kind: ${String(_exhaustive)}`);
        }
      }
    },
    target(): CalleeReplyTarget | undefined {
      switch (activeBusinessContinuation.kind) {
        case 'none':
          return undefined;
        case 'inter_dialog_reply':
          return activeBusinessContinuation.calleeDialogReplyTarget;
        case 'requested_work_reply':
        case 'local_tellask_result':
          return undefined;
        default: {
          const _exhaustive: never = activeBusinessContinuation;
          throw new Error(`Unhandled business continuation kind: ${String(_exhaustive)}`);
        }
      }
    },
  };
  let calleeDialogReplyTarget: CalleeReplyTarget | undefined = replyContinuationScope.target();
  let activeTellaskReplyDirective: KernelDriverPrompt['tellaskReplyDirective'] | undefined =
    replyContinuationScope.directive();
  let activePromptWasReplyToolReminder = false;
  let shouldPauseAfterLocalUserInterjection = false;
  let resumeFromInterjectionPause = false;
  let hadRootRuntimeWakeBeforeCore = false;
  let coreEndedInterrupted = false;
  const allowResumeFromInterrupted =
    driveOptions?.allowResumeFromInterrupted === true || humanPrompt?.origin === 'user';
  const driveSource = resolveDriveRequestSource(humanPrompt, driveOptions);
  let requestedWorkReplyClaim: RequestedWorkReplyContinuationClaim = { status: 'not_applicable' };
  let replyDeliveryRecoveryClaim: ReplyDeliveryRecoveryContinuationClaim = {
    status: 'not_applicable',
  };
  let toolFollowupClaim: ToolFollowupContinuationClaim = { status: 'not_applicable' };
  try {
    // Prime active-run registration right after acquiring dialog lock so user stop can
    // reliably interrupt queued continuation drives during preflight.
    const hadActiveRunBefore = hasActiveRun(dialog.id);
    createActiveRun(dialog.id);
    activeRunPrimed = true;
    ownsActiveRun = !hadActiveRunBefore;

    // "dead" is irreversible for sideDialogs. Skip drive if marked dead.
    try {
      const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
      if (dialog.id.selfId === dialog.id.rootId) {
        hadRootRuntimeWakeBeforeCore ||= await DialogPersistence.hasRootRuntimeWake(
          dialog.id,
          dialog.status,
        );
      }
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
        isInterruptedDialogBlockedWithoutExplicitResume(
          latest.executionMarker,
          allowResumeFromInterrupted,
        )
      ) {
        const executionMarker = latest.executionMarker;
        if (executionMarker?.kind !== 'interrupted') {
          throw new Error(
            `kernel-driver interruption invariant violation: expected interrupted marker after explicit-resume gate`,
          );
        }
        log.debug(
          'kernel-driver skip drive for interrupted dialog without explicit resume/user prompt',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            reason: executionMarker.reason,
          },
        );
        return;
      }
      resumeFromInterjectionPause =
        humanPrompt === undefined &&
        allowResumeFromInterrupted &&
        latest?.executionMarker?.kind === 'interrupted' &&
        isUserInterjectionPauseStopReason(latest.executionMarker.reason);
    } catch (error: unknown) {
      const message =
        `kernel-driver failed to check execution facts before drive; refusing unsafe drive ` +
        `(rootId=${dialog.id.rootId}, selfId=${dialog.id.selfId}, ` +
        `source=${driveSource}, reason=${driveOptions?.reason ?? 'unknown'}): ` +
        formatPreDriveExecutionFactsError(error);
      log.error('kernel-driver refused unsafe drive after execution fact load failure', error, {
        dialogId: dialog.id.valueOf(),
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        source: driveSource,
        reason: driveOptions?.reason ?? null,
      });
      try {
        await dialog.streamError(message);
      } catch (streamError: unknown) {
        log.warn(
          'kernel-driver failed to emit stream_error_evt for pre-drive execution fact failure',
          streamError,
          {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          },
        );
      }
      throw error;
    }

    if (!humanPrompt) {
      requestedWorkReplyClaim = await claimRequestedWorkRepliedContinuationForDrive({
        dialog,
        driveOptions,
      });
      if (requestedWorkReplyClaim.status === 'stale') {
        log.debug('kernel-driver dropped stale requested-work reply continuation', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          source: driveSource,
          reason: driveOptions?.reason ?? null,
          batchId: requestedWorkReplyClaim.batchId,
        });
        return;
      }
      replyDeliveryRecoveryClaim = await claimReplyDeliveryRecoveryContinuationForDrive({
        dialog,
        driveOptions,
      });
      if (replyDeliveryRecoveryClaim.status === 'stale') {
        log.debug('kernel-driver dropped stale reply delivery recovery continuation', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          source: driveSource,
          reason: driveOptions?.reason ?? null,
          replyDeliveryId: replyDeliveryRecoveryClaim.replyDeliveryId,
          staleReason: replyDeliveryRecoveryClaim.reason,
        });
        return;
      }
      if (replyDeliveryRecoveryClaim.status === 'claimed') {
        await recoverPendingReplyDelivery({
          dlg: dialog,
          replyDelivery: replyDeliveryRecoveryClaim.replyDelivery,
          callbacks: {
            scheduleDrive: args.scheduleDrive,
            driveDialog: args.driveDialog,
          },
        });
        log.debug('kernel-driver recovered pending reply delivery continuation', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          source: driveSource,
          reason: driveOptions?.reason ?? null,
          replyDeliveryId: replyDeliveryRecoveryClaim.replyDelivery.replyDeliveryId,
          replyCallId: replyDeliveryRecoveryClaim.replyDelivery.replyCallId,
          targetDialogId: replyDeliveryRecoveryClaim.replyDelivery.targetDialogId,
          targetCallId: replyDeliveryRecoveryClaim.replyDelivery.targetCallId,
        });
        return;
      }
      toolFollowupClaim = await claimToolFollowupContinuationForDrive({
        dialog,
        driveOptions,
      });
    }
    if (!humanPrompt && dialog instanceof SideDialog && !dialog.hasQueuedPrompt()) {
      const inspection = await inspectSideDialogBusinessContinuationDrive({
        dialog,
        driveOptions,
        requestedWorkReplyClaim,
        replyDeliveryRecoveryClaim,
        toolFollowupClaim,
      });
      if (inspection.shouldReject) {
        if (inspection.rejection === 'finalized_after_response_anchor') {
          const cleanup = await clearStaleSideDialogRunControlForFinalResponse({ dialog });
          if (!cleanup.cleared) {
            await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
          }
          log.debug('Dropped stale sideDialog drive after final response anchor', undefined, {
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
          });
          return;
        }
        if (inspection.rejection === 'stale_consumed_result_arrival') {
          log.debug(
            'Dropped stale sideDialog requested-work reply after result arrival',
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
              waitInQue,
            },
          );
          return;
        }
        log.error('Rejected unexpected sideDialog drive request', undefined, {
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
    }

    if (!humanPrompt) {
      // WARNING:
      // `allowResumeFromInterrupted` covers multiple stop reasons, but the interjection-pause case
      // is semantically special. Continue here does NOT mean "blindly clear stopped and drive". We
      // must re-read the fresh persistence facts first because there are three distinct true-source
      // cases behind the same visible resumption panel:
      // - no active reply obligation / not suspended anymore -> continue real driving now
      // - active reply obligation + suspended -> restore the true suspension state
      // - active reply obligation + still proceeding continuation (for example queued prompt) ->
      //   continue real driving now
      //
      // Do not refactor this branch using only `displayState` or only the previous interrupted
      // marker. The correct behavior emerges from combining fresh suspension facts, queued prompt
      // state, and the deferred reply reassertion logic elsewhere.
      const hasSupplyResponseContinuation = hasSupplyResponseBusinessContinuation(
        dialog,
        driveOptions,
      );
      const suspension = resumeFromInterjectionPause
        ? await loadFreshSuspensionStatusFromPersistence(dialog)
        : hasSupplyResponseContinuation
          ? await loadFreshSuspensionStatusFromPersistence(dialog)
          : await dialog.getSuspensionStatus();
      const queuedPrompt: QueuedPrompt | undefined = dialog.peekQueuedPrompt();
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
          hasQueuedPrompt: dialog.hasQueuedPrompt(),
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
                previousDriveQueued: lastTrigger.previousDriveQueued,
                nextDriveQueued: lastTrigger.nextDriveQueued,
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
            hasQueuedPrompt: dialog.hasQueuedPrompt(),
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
    const queuedPromptBeforeHealth = dialog.peekQueuedPrompt();
    const hasQueuedPrompt = queuedPromptBeforeHealth !== undefined;
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
    const userPromptContentForHealth =
      humanPrompt?.origin === 'user'
        ? humanPrompt.content
        : queuedPromptBeforeHealth?.origin === 'user'
          ? queuedPromptBeforeHealth.prompt
          : undefined;
    const healthDecision = decideKernelDriverContextHealth({
      dialogKey: dialog.id.key(),
      snapshot,
      hadUserPromptThisGen:
        isEffectiveUserPromptForContextHealth(humanPrompt) ||
        (humanPrompt === undefined && isQueuedUserPromptForContextHealth(queuedPromptBeforeHealth)),
      userPromptCriticalRemediationAlreadyApplied:
        userPromptContentForHealth !== undefined &&
        isAgentFacingCriticalUserInterjectionRemediationGuideContent(userPromptContentForHealth),
      canInjectPromptThisGen: !hasQueuedPrompt,
      cautionRemediationCadenceGenerations,
      criticalCountdownRemaining,
    });
    let healthPrompt: KernelDriverRuntimePrompt | undefined;
    if (healthDecision.kind === 'continue') {
      if (healthDecision.reason === 'critical_force_new_course') {
        const language = getWorkLanguage();
        const newCoursePrompt = formatNewCourseStartPrompt(language, {
          nextCourse: dialog.currentCourse + 1,
          source: 'critical_auto_clear',
        });
        healthPrompt = await dialog.startNewCourse(newCoursePrompt);
        dialog.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
        resetContextHealthRoundState(dialog.id.key());
      } else if (healthDecision.reason === 'critical_user_prompt_remediation') {
        if (
          userPromptContentForHealth === undefined ||
          !isAgentFacingCriticalUserInterjectionRemediationGuideContent(userPromptContentForHealth)
        ) {
          log.warn(
            'kernel-driver observed unwrapped critical user prompt; critical user interjection wrapping must happen at ingress',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              msgId:
                humanPrompt?.origin === 'user'
                  ? humanPrompt.msgId
                  : queuedPromptBeforeHealth?.origin === 'user'
                    ? queuedPromptBeforeHealth.msgId
                    : null,
            },
          );
        }
      } else if (!hasQueuedPrompt) {
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

    const promptForCore = healthPrompt ?? humanPrompt;
    const resolvedPrompt = await resolveEffectivePrompt(dialog, promptForCore);
    const effectivePrompt = resolvedPrompt.prompt;
    const latestBeforeCore = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    if (dialog.id.selfId === dialog.id.rootId) {
      hadRootRuntimeWakeBeforeCore ||= await DialogPersistence.hasRootRuntimeWake(
        dialog.id,
        dialog.status,
      );
    }
    if (
      resolvedPrompt.droppedStaleQueuedContinuation &&
      effectivePrompt === undefined &&
      !hasDurableDriveWork(latestBeforeCore)
    ) {
      log.debug('kernel-driver stopped after dropping stale queued continuation', undefined, {
        dialogId: dialog.id.valueOf(),
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        source: driveSource,
        reason: driveOptions?.reason ?? null,
      });
      return;
    }
    await applyRegisteredDialogRunControlsBeforeDrive({
      dialog,
      humanPrompt,
      effectivePrompt,
      driveSource,
      genIterNo: args.runtime.totalGenIterations,
    });
    if (resolvedPrompt.fromQueuedPrompt) {
      const consumed: QueuedPrompt | undefined = dialog.takeQueuedPrompt();
      if (!consumed || consumed.msgId !== effectivePrompt?.msgId) {
        throw new Error(
          `kernel-driver queued prompt invariant violation: expected queued prompt ${effectivePrompt?.msgId ?? 'unknown'} before drive`,
        );
      }
    }
    if (effectivePrompt?.tellaskReplyDirective !== undefined) {
      replyContinuationScope.refresh({
        kind: 'inter_dialog_reply',
        tellaskReplyDirective: effectivePrompt.tellaskReplyDirective,
        ...(effectivePrompt.calleeDialogReplyTarget === undefined
          ? {}
          : { calleeDialogReplyTarget: effectivePrompt.calleeDialogReplyTarget }),
      });
    }
    calleeDialogReplyTarget =
      effectivePrompt?.calleeDialogReplyTarget ?? replyContinuationScope.target();
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
    if (
      effectivePrompt?.origin === 'user' &&
      !replyGuidance.isQ4HAnswerPrompt &&
      !replyGuidance.suppressInterDialogReplyGuidance &&
      replyGuidance.deferredReplyReassertionDirective !== undefined
    ) {
      await DialogPersistence.setDeferredReplyReassertion(
        dialog.id,
        {
          reason: 'user_interjection_with_parked_original_task',
          directive: replyGuidance.deferredReplyReassertionDirective,
        },
        dialog.status,
      );
    }
    activeTellaskReplyDirective =
      replyGuidance.activeReplyDirective ?? replyContinuationScope.directive();
    activePromptWasReplyToolReminder = isReplyToolReminderPrompt(effectivePrompt);
    let activePromptCarriesReplyDirective =
      effectivePrompt?.tellaskReplyDirective !== undefined &&
      activeTellaskReplyDirective !== undefined &&
      effectivePrompt.tellaskReplyDirective.targetCallId ===
        activeTellaskReplyDirective.targetCallId;
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
    const latestAfterCore = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    coreEndedInterrupted = latestAfterCore?.executionMarker?.kind === 'interrupted';
    await restoreRootRuntimeWakeAfterDriveFailure({
      dialog,
      driveOptions,
      reason: 'core_stopped',
      hadRootRuntimeWakeBeforeCore,
    });
    replyContinuationScope.refresh(driveResult.lastBusinessContinuation);
    calleeDialogReplyTarget =
      driveResult.lastAssistantReplyTarget ??
      replyContinuationScope.target() ??
      calleeDialogReplyTarget;
    activeTellaskReplyDirective = activeTellaskReplyDirective ?? replyContinuationScope.directive();
    interruptedBySignal = getActiveRunSignal(dialog.id)?.aborted === true;
    if (!interruptedBySignal) {
      const queuedFollowUp = dialog.peekQueuedPrompt();
      if (queuedFollowUp && isPendingRuntimePromptFollowUp(queuedFollowUp)) {
        followUp = undefined;
      } else if (queuedFollowUp && isQueuedReplyObligationContinuation(queuedFollowUp)) {
        const claim = await claimQueuedReplyObligationContinuation({
          dialog,
          prompt: queuedFollowUp,
        });
        if (claim === 'stale') {
          const discarded = dialog.takeQueuedPrompt();
          if (!discarded || discarded.msgId !== queuedFollowUp.msgId) {
            throw new Error(
              `reply obligation continuation invariant violation: expected queued prompt ${queuedFollowUp.msgId} before stale discard after core`,
            );
          }
          await DialogPersistence.clearPendingRuntimePrompt(
            dialog.id,
            queuedFollowUp.msgId,
            dialog.status,
          );
          log.debug(
            'kernel-driver dropped stale reply obligation follow-up after core',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              msgId: queuedFollowUp.msgId,
              targetCallId: queuedFollowUp.tellaskReplyDirective.targetCallId,
              expectedReplyCallName: queuedFollowUp.tellaskReplyDirective.expectedReplyCallName,
            },
          );
          followUp = undefined;
        } else {
          followUp = dialog.takeQueuedPrompt();
          if (!followUp || followUp.msgId !== queuedFollowUp.msgId) {
            throw new Error(
              `reply obligation continuation invariant violation: expected queued prompt ${queuedFollowUp.msgId} before claimed follow-up after core`,
            );
          }
        }
      } else {
        followUp = dialog.takeQueuedPrompt();
      }
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
            const replyDirectiveForAssistantOutput =
              await resolveSideDialogReplyDirectiveForAssistantOutput({
                dialog,
                responseGenseq: directFallbackResponse.responseGenseq,
                replyTarget: driveResult.lastAssistantReplyTarget,
                currentDirective: activeTellaskReplyDirective,
              });
            if (
              replyDirectiveForAssistantOutput !== undefined &&
              replyDirectiveForAssistantOutput.targetCallId !==
                activeTellaskReplyDirective?.targetCallId
            ) {
              // Business continuation identity should already come from the accepted next-step
              // trigger or the current runtime prompt. This branch only handles an explicit
              // assistant-output reply target surfaced by the core; do not broaden it into
              // transcript/assignment-anchor reconstruction.
              log.debug(
                'kernel-driver rebound sideDialog reply directive to latest assistant output target',
                undefined,
                {
                  dialogId: dialog.id.valueOf(),
                  previousTargetCallId: activeTellaskReplyDirective?.targetCallId ?? null,
                  nextTargetCallId: replyDirectiveForAssistantOutput.targetCallId,
                  responseGenseq: directFallbackResponse.responseGenseq,
                  replyTargetCallId: driveResult.lastAssistantReplyTarget?.callId ?? null,
                },
              );
            }
            activeTellaskReplyDirective = replyDirectiveForAssistantOutput;
            activePromptCarriesReplyDirective =
              activePromptCarriesReplyDirective ||
              (activeTellaskReplyDirective !== undefined &&
                driveResult.lastAssistantReplyTarget?.callId ===
                  activeTellaskReplyDirective.targetCallId);
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

      if (
        shouldPauseAfterLocalUserInterjection &&
        !interruptedBySignal &&
        followUp === undefined &&
        driveResult?.lastAssistantSayingContent !== null
      ) {
        const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
          dialog.id,
          dialog.status,
        );
        if (deferredReplyReassertion?.reason === 'user_interjection_with_parked_original_task') {
          const language = getWorkLanguage();
          const prompt = await buildReplyObligationReassertionPrompt({
            dlg: dialog,
            directive: deferredReplyReassertion.directive,
            language,
          });
          followUp = {
            kind: 'runtime_reply_reminder',
            prompt,
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            userLanguageCode: language,
            tellaskReplyDirective: deferredReplyReassertion.directive,
          };
          await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
          log.debug(
            'kernel-driver queued automatic reply-obligation reassertion after user interjection answer',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              targetCallId: deferredReplyReassertion.directive.targetCallId,
            },
          );
        }
      }

      if (followUp) {
        if (
          followUp.kind === 'runtime_reply_reminder' ||
          followUp.kind === 'runtime_sideDialog_reply_reminder'
        ) {
          await queueReplyReminderFollowUp({ dialog, followUp });
          const businessContinuation: DialogBusinessContinuation = {
            kind: 'inter_dialog_reply',
            tellaskReplyDirective: followUp.tellaskReplyDirective,
            ...(followUp.kind === 'runtime_sideDialog_reply_reminder' &&
            followUp.calleeDialogReplyTarget !== undefined
              ? { calleeDialogReplyTarget: followUp.calleeDialogReplyTarget }
              : {}),
          };
          args.scheduleDrive(dialog, {
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_follow_up',
              reason: 'follow_up_prompt',
              businessContinuation,
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
      if (dialog.hasQueuedPrompt()) {
        shouldDriveQueuedPromptAfterCore = true;
        return driveResult;
      }
      if (shouldPauseAfterLocalUserInterjection && !interruptedBySignal && followUp === undefined) {
        log.debug(
          'kernel-driver observed local user interjection pause condition, but continuation is now fully automatic',
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
        await clearConsumedRootRuntimeWakeIfIdle(dialog);
      } catch (error: unknown) {
        log.error(
          'kernel-driver failed to reconcile consumed root runtime wake after tail',
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
        await restoreRootRuntimeWakeAfterDriveFailure({
          dialog,
          driveOptions,
          reason: 'tail_error',
          error: tailError,
          hadRootRuntimeWakeBeforeCore,
        });
      } catch (error: unknown) {
        log.error('kernel-driver failed to requeue root runtime wake after tail failure', error, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
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
    if (shouldDriveQueuedPromptAfterCore) {
      return await args.driveDialog(dialog, {
        waitInQue: true,
        driveOptions: {
          source: 'kernel_driver_follow_up',
          reason: 'queued_prompt_after_core',
        },
      });
    }
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
