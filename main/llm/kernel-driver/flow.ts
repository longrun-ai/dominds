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
import { cancelIdleReminderWake, maybeStartIdleReminderWake } from './idle-reminder-wake';
import {
  buildReplyObligationReassertionPrompt,
  resolvePromptReplyGuidance,
  resolveReplyTargetAgentId,
} from './reply-guidance';
import type { ScheduleDriveFn, SideDialogReplyTarget } from './sideDialog';
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
  userLanguageCode?: string;
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
  userLanguageCode?: string;
  runControl?: undefined;
  origin: 'runtime';
  tellaskReplyDirective: KernelDriverRuntimeSideDialogPrompt['tellaskReplyDirective'];
  skipTaskdoc?: undefined;
  sideDialogReplyTarget: KernelDriverRuntimeSideDialogPrompt['sideDialogReplyTarget'];
}>;

type UpNextPrompt =
  | DialogQueuedPromptState
  | RuntimeReplyReminderPrompt
  | RuntimeSideDialogReplyReminderPrompt;

const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';

function isReplyToolReminderPrompt(prompt: KernelDriverPrompt | undefined): boolean {
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
  directive: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>;
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

function entitlementAllowsPendingSideDialog(args: {
  pending: { callSiteCourse: number; callSiteGenseq: number };
  driveOptions: KernelDriverDriveOptions | undefined;
  dialog: Dialog;
}): boolean {
  const entitlement = args.driveOptions?.noPromptSideDialogResumeEntitlement;
  if (
    args.driveOptions?.source !== 'kernel_driver_supply_response_parent_revive' ||
    entitlement?.ownerDialogId !== args.dialog.id.selfId
  ) {
    return false;
  }
  if (entitlement.reason === 'reply_tellask_back_delivered') {
    return true;
  }
  if (entitlement.reason === 'replaced_pending_sideDialog_reply') {
    return false;
  }
  if (entitlement.reason !== 'resolved_pending_sideDialog_reply') {
    return false;
  }
  if (!isPositiveInteger(entitlement.callSiteCourse)) {
    return false;
  }
  if (!isPositiveInteger(entitlement.callSiteGenseq)) {
    return false;
  }
  return (
    args.pending.callSiteCourse !== entitlement.callSiteCourse ||
    args.pending.callSiteGenseq !== entitlement.callSiteGenseq
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function loadFreshSuspensionStatusFromPersistence(
  dialog: Dialog,
  driveOptions?: KernelDriverDriveOptions,
): Promise<{
  q4h: boolean;
  sideDialogs: boolean;
  blockingSideDialogs: boolean;
  canDrive: boolean;
}> {
  const q4h = await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status);
  const pendingSideDialogs = await DialogPersistence.loadPendingSideDialogs(
    dialog.id,
    dialog.status,
  );
  const hasQ4H = q4h.length > 0;
  const hasSideDialogs = pendingSideDialogs.length > 0;
  const blockingSideDialogs = pendingSideDialogs.some(
    (pending) => !entitlementAllowsPendingSideDialog({ pending, driveOptions, dialog }),
  );
  return {
    q4h: hasQ4H,
    sideDialogs: hasSideDialogs,
    blockingSideDialogs,
    canDrive: !hasQ4H && !blockingSideDialogs,
  };
}

function buildDisplayStateFromSuspensionStatus(args: {
  q4h: boolean;
  sideDialogs: boolean;
}): DialogDisplayState {
  if (args.q4h && args.sideDialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_sideDialogs' } };
  }
  if (args.q4h) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (args.sideDialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } };
  }
  return { kind: 'idle_waiting_user' };
}

type PendingDiagnosticsSnapshot =
  | {
      kind: 'loaded';
      ownerDialogId: string;
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
      ownerDialogId: string;
      status: 'running' | 'completed' | 'archived';
      error: string;
    };

async function loadPendingDiagnosticsSnapshot(args: {
  rootId: string;
  ownerDialogId: string;
  expectedSideDialogId: string;
  status: 'running' | 'completed' | 'archived';
}): Promise<PendingDiagnosticsSnapshot> {
  const ownerDialogIdObj = new DialogID(args.ownerDialogId, args.rootId);
  try {
    const pending = await DialogPersistence.loadPendingSideDialogs(ownerDialogIdObj, args.status);
    const matchedSideDialogIds = pending
      .filter((record) => record.sideDialogId === args.expectedSideDialogId)
      .map((record) => record.sideDialogId);
    return {
      kind: 'loaded',
      ownerDialogId: args.ownerDialogId,
      status: args.status,
      totalCount: pending.length,
      matchedSideDialogIds,
      records: pending.map((record) => ({
        sideDialogId: record.sideDialogId,
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

function hasNoPromptSideDialogResumeEntitlement(
  dialog: SideDialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const entitlement = driveOptions?.noPromptSideDialogResumeEntitlement;
  if (!entitlement) {
    return false;
  }
  return entitlement.ownerDialogId === dialog.id.selfId;
}

function hasParentReviveEntitlement(
  dialog: Dialog,
  driveOptions: KernelDriverDriveOptions | undefined,
): boolean {
  const entitlement = driveOptions?.noPromptSideDialogResumeEntitlement;
  if (!entitlement) {
    return false;
  }
  if (
    driveOptions?.source !== 'kernel_driver_supply_response_parent_revive' ||
    entitlement.ownerDialogId !== dialog.id.selfId
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
    hasNoPromptSideDialogResumeEntitlement(args.dialog, args.driveOptions);
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
              sideDialogReplyTarget: upNext.sideDialogReplyTarget,
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
  let followUp: UpNextPrompt | undefined;
  let driveResult: KernelDriverCoreResult | undefined;
  let sideDialogReplyTarget: SideDialogReplyTarget | undefined;
  let activeTellaskReplyDirective: KernelDriverPrompt['tellaskReplyDirective'] | undefined;
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

    // "dead" is irreversible for sideDialogs. Skip drive if marked dead.
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
    // suspended by pending Q4H or sideDialogs. This prevents duplicate generations when
    // multiple wake-ups race around the same sideDialog completion boundary.
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
              lastEvent: inspection.lastEvent ?? null,
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
      // - active reply obligation + suspended -> restore true blocked state
      // - active reply obligation + still proceeding entitlement (for example queued upNext) ->
      //   continue real driving now
      //
      // Do not refactor this branch using only `displayState` or only the previous interrupted
      // marker. The correct behavior emerges from combining fresh blocker facts, queued prompt
      // state, and the deferred reply reassertion logic elsewhere.
      const hasEntitledParentRevive = hasParentReviveEntitlement(dialog, driveOptions);
      const suspension = resumeFromInterjectionPause
        ? await loadFreshSuspensionStatusFromPersistence(dialog, driveOptions)
        : hasEntitledParentRevive
          ? await loadFreshSuspensionStatusFromPersistence(dialog, driveOptions)
          : await dialog.getSuspensionStatus({
              allowPendingSideDialogs: false,
            });
      const queuedPrompt: UpNextPrompt | undefined = dialog.peekUpNext();
      const queuedSideDialogPromptCanResume =
        dialog instanceof SideDialog && queuedPrompt !== undefined;
      if (!suspension.canDrive && !queuedSideDialogPromptCanResume) {
        if (resumeFromInterjectionPause) {
          const restoredState = buildDisplayStateFromSuspensionStatus({
            q4h: suspension.q4h,
            sideDialogs: suspension.sideDialogs,
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
              waitingSideDialogs: suspension.sideDialogs,
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
          waitingSideDialogs: suspension.sideDialogs,
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
            waitingSideDialogs: suspension.sideDialogs,
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

    let healthPrompt: KernelDriverRuntimePrompt | undefined;
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
    sideDialogReplyTarget = effectivePrompt?.sideDialogReplyTarget;
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
    sideDialogReplyTarget = driveResult.lastAssistantReplyTarget ?? sideDialogReplyTarget;
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
        (driveResult.fbrConclusion !== undefined || driveResult.lastAssistantSayingContent !== null)
      ) {
        if (driveResult.fbrConclusion) {
          await supplySideDialogResponseToAssignedAskerIfPendingV2({
            sideDialog: dialog,
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
            // Any function call means execution is still in-progress. Only supply when the tellaskee
            // has produced a newer assistant saying after the latest function call.
            log.debug(
              'kernel-driver skip sideDialog response supply because latest saying is not after function calls',
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
                'kernel-driver skip sideDialog response supply while tellaskee is not finalized',
                undefined,
                {
                  rootId: dialog.id.rootId,
                  selfId: dialog.id.selfId,
                  waitingQ4H: suspension.q4h,
                  waitingSideDialogs: suspension.sideDialogs,
                  hasFollowUp,
                },
              );
            }
            if (suspension.canDrive && !hasFollowUp) {
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
                const shouldDirectFallbackAfterParentRevive = hasParentReviveEntitlement(
                  dialog,
                  driveOptions,
                );
                if (!activePromptWasReplyToolReminder && !shouldDirectFallbackAfterParentRevive) {
                  const language = getWorkLanguage();
                  followUp =
                    sideDialogReplyTarget === undefined
                      ? {
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
                        }
                      : {
                          kind: 'runtime_sideDialog_reply_reminder',
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
                          sideDialogReplyTarget,
                        };
                  log.debug(
                    'kernel-driver queued sideDialog replyTellask reminder after plain reply',
                    undefined,
                    {
                      dialogId: dialog.id.valueOf(),
                      targetCallId: activeTellaskReplyDirective.targetCallId,
                      targetOwnerDialogId: sideDialogReplyTarget?.ownerDialogId,
                      directFallbackAfterParentRevive: shouldDirectFallbackAfterParentRevive,
                    },
                  );
                } else {
                  if (
                    typeof driveResult.lastAssistantSayingGenseq !== 'number' ||
                    !Number.isFinite(driveResult.lastAssistantSayingGenseq) ||
                    driveResult.lastAssistantSayingGenseq <= 0
                  ) {
                    throw new Error(
                      `SideDialog response supply invariant violation: missing lastAssistantSayingGenseq for dialog=${dialog.id.valueOf()}`,
                    );
                  }
                  const responseGenseq = Math.floor(driveResult.lastAssistantSayingGenseq);
                  const directFallbackCallId = `direct-fallback-${generateShortId()}`;
                  let supplied = false;
                  if (sideDialogReplyTarget) {
                    supplied = await supplySideDialogResponseToSpecificAskerIfPendingV2({
                      sideDialog: dialog,
                      responseText: driveResult.lastAssistantSayingContent,
                      responseGenseq,
                      target: sideDialogReplyTarget,
                      deliveryMode: 'direct_fallback',
                      replyResolution: {
                        callId: directFallbackCallId,
                        replyCallName: activeTellaskReplyDirective.expectedReplyCallName,
                      },
                      scheduleDrive: args.scheduleDrive,
                    });
                    if (!supplied) {
                      supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
                        sideDialog: dialog,
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
                    supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
                      sideDialog: dialog,
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

                  if (!supplied && sideDialogReplyTarget) {
                    const diagnostics = await loadPendingDiagnosticsSnapshot({
                      rootId: dialog.id.rootId,
                      ownerDialogId: sideDialogReplyTarget.ownerDialogId,
                      expectedSideDialogId: dialog.id.selfId,
                      status: dialog.status,
                    });
                    log.debug(
                      'kernel-driver failed to supply sideDialog response to specific asker',
                      undefined,
                      {
                        calleeId: dialog.id.valueOf(),
                        targetOwnerDialogId: sideDialogReplyTarget.ownerDialogId,
                        targetCallType: sideDialogReplyTarget.callType,
                        targetCallId: sideDialogReplyTarget.callId,
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
              case 'new_course_runtime_sideDialog':
              case 'runtime_reply_reminder':
              case 'runtime_sideDialog_reply_reminder': {
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
                    sideDialogReplyTarget: followUp.sideDialogReplyTarget,
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
