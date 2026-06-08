import { DEFAULT_DILIGENCE_PUSH_MAX } from '@longrun-ai/kernel/diligence';
import type { ContextHealthSnapshot, LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { NewA2HAnsweredEvent } from '@longrun-ai/kernel/types/dialog';
import type {
  DialogDisplayState,
  DialogInterruptionReason,
  DialogLlmRetryExhaustedReason,
} from '@longrun-ai/kernel/types/display-state';
import type { DialogQueuedPromptState } from '@longrun-ai/kernel/types/drive-intent';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
  toRootGenerationAnchor,
  type AnswerToHumanItem,
  type DialogBusinessContinuation,
  type DialogCalleeReplyTarget,
  type DialogFbrState,
  type DialogFollowupReason,
  type DialogGenerationRunState,
  type DialogNextStepTriggerDraft,
  type DialogPendingUserInterjectionReply,
  type FuncResultRecord,
  type TellaskAnchorRecord,
  type TellaskCalleeRecord,
  type TellaskReplyDirective,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp, parseUnifiedTimestampMs } from '@longrun-ai/kernel/utils/time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Dialog, DialogID, MainDialog, SideDialog } from '../../dialog';
import {
  broadcastDisplayStateMarker,
  clearDialogInterruptedExecutionMarker,
  computeIdleDisplayState,
  createActiveRun,
  getActiveRunSignal,
  getStopRequestedReason,
  loadDialogExecutionMarker,
  setDialogDisplayState,
  setDialogExecutionMarker,
} from '../../dialog-display-state';
import { isInterruptionReasonManualResumeEligible } from '../../dialog-interruption';
import { postDialogEvent, postDialogEventById } from '../../evt-registry';
import { extractErrorDetails, log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import { domindsRtwsRootAbs } from '../../rtws';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatDomindsNoteFbrToollessViolation,
  formatNewCourseStartPrompt,
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  formatReminderMaintenanceReference,
  isAgentFacingCriticalUserInterjectionRemediationGuideContent,
  type ReminderContextFooterState,
  type ReminderMaintenanceReferenceItem,
} from '../../runtime/driver-messages';
import {
  buildActiveReplyObligationContextText,
  isStandaloneRuntimeGuidePromptContent,
} from '../../runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import {
  reminderEchoBackEnabled,
  resolveFuncToolInvocationArguments,
  toolFailure,
  type FuncTool,
  type FuncToolFollowupMode,
  type FuncToolInvocationResolution,
  type Tool,
  type ToolCallOutput,
  type ToolOutcome,
} from '../../tool';
import { formatTaskDocContent } from '../../utils/taskdoc';
import {
  createLlmFailureQuirkHandlerSession,
  type LlmFailureQuirkHandlerSession,
} from '../api-quirks';
import type {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  ModelInfo,
  ProviderConfig,
  SayingMsg,
  ThinkingMsg,
} from '../client';
import { LlmConfig } from '../client';
import {
  LlmStreamErrorEmittedError,
  type LlmBatchOutput,
  type LlmBatchResult,
  type LlmInvalidFuncCall,
  type LlmStreamReceiver,
  type LlmWebSearchCall,
  type OpenAiResponsesNativeToolCall,
} from '../gen';
import { getLlmGenerator } from '../gen/registry';
import {
  formatToolCallAdjacencyViolation,
  sanitizeToolContextForProvider,
  type ToolCallAdjacencyViolation,
} from '../gen/tool-call-context';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';
import { projectFuncToolsForProvider } from '../tools-projection';
import { assembleDriveContextMessages } from './context';
import {
  consumeCriticalCountdown,
  decideKernelDriverContextHealth,
  getContextHealthRemediationLevel,
  KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCautionRemediationCadenceGenerations,
  resolveCriticalCountdownRemaining,
} from './context-health';
import { emitThinkingEvents } from './events';
import {
  advanceFbrState,
  buildFbrPromptForState,
  buildProgrammaticFbrContextCriticalContent,
  buildProgrammaticFbrUnreasonableSituationContent,
  forceFbrContextCautionFinalizationState,
  inspectFbrConclusionAttempt,
  isFbrContextCautionFinalizationState,
  isFbrFinalizationState,
  markFbrPromptDelivered,
} from './fbr';
import {
  buildKernelDriverPolicy,
  resolveKernelDriverPolicyViolationKind,
  validateKernelDriverPolicyInvariants,
  type KernelDriverPolicyState,
} from './guardrails';
import { resolveReminderContextFooterStateFromSignals } from './reminder-context';
import { resolvePromptReplyGuidance } from './reply-guidance';
import {
  evaluateDiligenceAutoContinueGate,
  LlmRequestFailedError,
  LlmRetryStoppedError,
  maybePrepareDiligenceAutoContinuePrompt,
  runLlmRequestWithRetry,
  suspendForKeepGoingBudgetExhausted,
} from './runtime';
import {
  formatPendingTellaskFuncResultContent,
  formatResolvedTellaskFuncResultContent,
  isTellaskCallFunctionName,
  processTellaskFunctionRound,
  recordAnswerToHuman,
  type AnswerHumanStructuredOutput,
  type TellaskCallFunctionName,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveCallbacks,
  KernelDriverPrompt,
  KernelDriverRuntimeGuidePrompt,
  KernelDriverRuntimePrompt,
} from './types';

type KernelDriverRetryPolicy = Readonly<{
  aggressiveMaxRetries: number;
  initialDelayMs: number;
  conservativeDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}>;

const KERNEL_DRIVER_DEFAULT_RETRY_POLICY: KernelDriverRetryPolicy = {
  aggressiveMaxRetries: 3, // short fast burst; persistent failures automatically downgrade to conservative
  initialDelayMs: 1000,
  conservativeDelayMs: 30_000,
  backoffMultiplier: 1.5,
  maxDelayMs: 30 * 60 * 1000, // 30 minutes
};

const CLEAR_MIND_TOOL_NAME = 'clear_mind';

const KERNEL_DRIVER_EMPTY_LLM_RESPONSE_ERROR_CODE = 'DOMINDS_LLM_EMPTY_RESPONSE';

// Wrapper isolation boundary:
// - Wrappers emit provider-native web-search events.
// - The driver is the first place allowed to project them into a narrower shared dialog shape.
function projectLlmWebSearchCall(call: LlmWebSearchCall): {
  source: 'codex' | 'openai_responses';
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  action?:
    | { type: 'search'; query?: string }
    | { type: 'open_page'; url?: string }
    | { type: 'find_in_page'; url?: string; pattern?: string };
} {
  if (call.source === 'codex') {
    return call;
  }

  const action = call.action;
  if (!action) {
    return {
      source: call.source,
      phase: call.phase,
      itemId: call.itemId,
      status: call.status,
    };
  }

  if (action.type === 'search') {
    const query =
      typeof action.query === 'string' && action.query.trim().length > 0
        ? action.query
        : Array.isArray(action.queries)
          ? action.queries.find((entry) => entry.trim().length > 0)
          : undefined;
    return {
      source: call.source,
      phase: call.phase,
      itemId: call.itemId,
      status: call.status,
      action: query !== undefined ? { type: 'search', query } : { type: 'search' },
    };
  }

  if (action.type === 'open_page') {
    return {
      source: call.source,
      phase: call.phase,
      itemId: call.itemId,
      status: call.status,
      action: typeof action.url === 'string' ? { type: 'open_page', url: action.url } : action,
    };
  }

  return {
    source: call.source,
    phase: call.phase,
    itemId: call.itemId,
    status: call.status,
    action: {
      type: 'find_in_page',
      ...(typeof action.url === 'string' ? { url: action.url } : {}),
      ...(typeof action.pattern === 'string' ? { pattern: action.pattern } : {}),
    },
  };
}

class KernelDriverInterruptedError extends Error {
  public readonly reason: DialogInterruptionReason;

  constructor(reason: DialogInterruptionReason) {
    super('Dialog interrupted');
    this.reason = reason;
  }
}

function resolveStoppedContinueEnabled(reason: DialogInterruptionReason): boolean {
  return isInterruptionReasonManualResumeEligible(reason);
}

function buildAbortedSystemStopReason(): Extract<
  DialogInterruptionReason,
  { kind: 'system_stop' }
> {
  return {
    kind: 'system_stop',
    detail: 'Aborted.',
    i18nStopReason: buildHumanSystemStopReasonTextI18n({
      detail: 'Aborted.',
      kind: 'aborted',
    }),
  };
}

function throwIfAborted(abortSignal: AbortSignal | undefined, dlg: Dialog): void {
  if (!abortSignal?.aborted) return;
  const stopRequested = getStopRequestedReason(dlg.id);
  if (stopRequested === 'emergency_stop') {
    throw new KernelDriverInterruptedError({ kind: 'emergency_stop' });
  }
  if (stopRequested === 'user_stop') {
    throw new KernelDriverInterruptedError({ kind: 'user_stop' });
  }
  throw new KernelDriverInterruptedError(buildAbortedSystemStopReason());
}

function buildInterruptedFuncResult(args: {
  func: FuncCallMsg;
  callGenseq: number;
  err: unknown;
}): FuncResultMsg {
  const errText =
    args.err instanceof Error
      ? `${args.err.name}: ${args.err.message}`
      : extractErrorDetails(args.err).message;
  return {
    type: 'func_result_msg',
    id: args.func.id,
    rawId: args.func.rawId,
    effectiveId: args.func.effectiveId,
    name: args.func.name,
    content: toolFailure(`Function '${args.func.name}' interrupted before completion: ${errText}`)
      .content,
    role: 'tool',
    genseq: args.callGenseq,
  };
}

function sameOpenGenerationRun(
  state: DialogGenerationRunState | undefined,
  course: number,
  genseq: number | undefined,
): boolean {
  return (
    state?.kind === 'open' &&
    state.course === course &&
    genseq !== undefined &&
    state.genseq === genseq
  );
}

function sameDialogBusinessContinuation(
  left: DialogBusinessContinuation,
  right: DialogBusinessContinuation,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'none':
      return true;
    case 'requested_work_reply': {
      if (right.kind !== 'requested_work_reply') return false;
      return (
        left.callerDialogId === right.callerDialogId &&
        left.batchId === right.batchId &&
        left.callSiteCourse === right.callSiteCourse &&
        left.callSiteGenseq === right.callSiteGenseq &&
        left.sideDialogId === right.sideDialogId &&
        left.callType === right.callType &&
        left.callId === right.callId &&
        sameStringArray(left.resolvedCallIds, right.resolvedCallIds) &&
        left.triggerCallId === right.triggerCallId
      );
    }
    case 'local_tellask_result': {
      if (right.kind !== 'local_tellask_result') return false;
      return left.callerDialogId === right.callerDialogId && left.reason === right.reason;
    }
    case 'inter_dialog_reply': {
      if (right.kind !== 'inter_dialog_reply') return false;
      return (
        sameTellaskReplyDirective(left.tellaskReplyDirective, right.tellaskReplyDirective) &&
        sameDialogCalleeReplyTarget(left.calleeDialogReplyTarget, right.calleeDialogReplyTarget)
      );
    }
    default: {
      const _exhaustive: never = left;
      throw new Error(`Unhandled business continuation kind: ${String(_exhaustive)}`);
    }
  }
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameTellaskReplyDirective(
  left: TellaskReplyDirective,
  right: TellaskReplyDirective,
): boolean {
  return (
    left.expectedReplyCallName === right.expectedReplyCallName &&
    left.targetDialogId === right.targetDialogId &&
    left.targetCallId === right.targetCallId &&
    left.tellaskContent === right.tellaskContent
  );
}

function sameDialogCalleeReplyTarget(
  left: DialogCalleeReplyTarget | undefined,
  right: DialogCalleeReplyTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.callerDialogId === right.callerDialogId &&
    left.callType === right.callType &&
    left.callId === right.callId &&
    left.callSiteCourse === right.callSiteCourse &&
    left.callSiteGenseq === right.callSiteGenseq
  );
}

function isFbrSideDialog(dlg: Dialog): dlg is SideDialog {
  return dlg instanceof SideDialog && dlg.assignmentFromAsker.callName === 'freshBootsReasoning';
}

async function loadDialogFbrState(dialog: Dialog): Promise<DialogFbrState | undefined> {
  if (!isFbrSideDialog(dialog)) return undefined;
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  return latest?.fbrState;
}

async function persistDialogFbrState(
  dialog: Dialog,
  fbrState: DialogFbrState | undefined,
): Promise<void> {
  await DialogPersistence.mutateDialogLatest(
    dialog.id,
    () => ({
      kind: 'patch',
      patch: { fbrState },
    }),
    dialog.status,
  );
}

function buildKernelDriverFbrPrompt(
  dlg: SideDialog,
  state: DialogFbrState,
): KernelDriverRuntimeGuidePrompt {
  const collectiveTargets =
    dlg.assignmentFromAsker.collectiveTargets &&
    dlg.assignmentFromAsker.collectiveTargets.length > 0
      ? [...dlg.assignmentFromAsker.collectiveTargets]
      : [dlg.agentId];
  return {
    content: buildFbrPromptForState({
      state,
      tellaskContent: dlg.assignmentFromAsker.tellaskContent,
      fromAgentId: dlg.assignmentFromAsker.originMemberId,
      toAgentId: dlg.agentId,
      language: getWorkLanguage(),
      collectiveTargets,
    }),
    msgId: generateShortId(),
    grammar: 'markdown',
    origin: 'runtime',
  };
}

function resolveLatestModelOutputGenseq(dlg: Dialog): number | undefined {
  for (let index = dlg.msgs.length - 1; index >= 0; index -= 1) {
    const msg = dlg.msgs[index];
    if (msg === undefined) {
      continue;
    }
    switch (msg.type) {
      case 'saying_msg':
      case 'thinking_msg':
      case 'func_call_msg': {
        const genseq = Math.floor(msg.genseq);
        if (Number.isFinite(genseq) && genseq > 0) {
          return genseq;
        }
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

function resolveProgrammaticFbrConclusionGenseq(args: {
  dlg: Dialog;
  lastAssistantSayingGenseq: number | null;
  lastFunctionCallGenseq: number | null;
}): number {
  return (
    args.lastAssistantSayingGenseq ??
    args.lastFunctionCallGenseq ??
    resolveLatestModelOutputGenseq(args.dlg) ??
    args.dlg.activeGenSeqOrUndefined ??
    1
  );
}

function normalizeQ4HAnswerCallId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const callId = raw.trim();
  return callId !== '' ? callId : undefined;
}

function isUserOriginPrompt(prompt: KernelDriverPrompt | undefined): boolean {
  if (!prompt) return false;
  return prompt.origin === 'user' && normalizeQ4HAnswerCallId(prompt.q4hAnswerCallId) === undefined;
}

async function resolveReminderContextFooterState(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt | undefined;
  currentTurnDialogMsgsForContext: readonly ChatMessage[];
}): Promise<ReminderContextFooterState> {
  const latest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    args.dlg.id,
    args.dlg.status,
  );
  const pendingUserInterjectionReply = latest?.pendingUserInterjectionReply !== undefined;
  const hasActiveReplyObligation = activeReplyObligation !== undefined;
  // Business scenario: a user can reopen a completed Side Dialog to ask a follow-up. A recorded
  // final response with no active reply task means the old handoff has already been
  // reported back; if a real user message is now present, the footer should say "talk with the
  // user now" instead of making the model infer that from old transcript/reminder context.
  const hasCompletedHandoffWithoutPendingReply =
    latest?.sideDialogFinalResponse !== undefined && !hasActiveReplyObligation;
  const dialogScope: ReminderContextFooterState['dialogScope'] =
    args.dlg instanceof SideDialog ? { kind: 'side_dialog' } : { kind: 'main_dialog' };
  return resolveReminderContextFooterStateFromSignals({
    dialogScope,
    prompt: args.prompt,
    currentTurnDialogMsgsForContext: args.currentTurnDialogMsgsForContext,
    contextHealth: args.dlg.getLastContextHealth(),
    pendingUserInterjectionReply,
    hasCompletedHandoffWithoutPendingReply,
    hasActiveReplyObligation,
  });
}

function splitDialogMsgsForReminderInsertion(args: {
  msgs: readonly ChatMessage[];
  currentPrompt: KernelDriverPrompt | undefined;
}): {
  historicalDialogMsgsForContext: ChatMessage[];
  currentTurnDialogMsgsForContext: ChatMessage[];
} {
  const msgId = args.currentPrompt?.msgId;
  if (typeof msgId !== 'string' || msgId.trim() === '') {
    return {
      historicalDialogMsgsForContext: [...args.msgs],
      currentTurnDialogMsgsForContext: [],
    };
  }
  const currentTurnStart = args.msgs.findIndex(
    (msg) => msg.type === 'prompting_msg' && msg.msgId === msgId,
  );
  if (currentTurnStart < 0) {
    return {
      historicalDialogMsgsForContext: [...args.msgs],
      currentTurnDialogMsgsForContext: [],
    };
  }
  return {
    historicalDialogMsgsForContext: args.msgs.slice(0, currentTurnStart),
    currentTurnDialogMsgsForContext: args.msgs.slice(currentTurnStart),
  };
}

function getUserOriginPromptMsgId(prompt: KernelDriverPrompt | undefined): string | undefined {
  if (!prompt) return undefined;
  return prompt.origin === 'user' && normalizeQ4HAnswerCallId(prompt.q4hAnswerCallId) === undefined
    ? prompt.msgId
    : undefined;
}

function samePendingUserInterjectionCoordinate(
  left: DialogPendingUserInterjectionReply,
  right: DialogPendingUserInterjectionReply,
): boolean {
  return left.msgId === right.msgId && left.course === right.course && left.genseq === right.genseq;
}

type VisibleUserInterjectionAnswerCandidate = Readonly<{
  userPromptMsgId: string;
  assistantSayingContent: string | null;
  assistantSayingGenseq: number | null;
  functionCallGenseqs: readonly number[];
}>;

async function maybeResolveAnsweredUserInterjection(args: {
  dlg: Dialog;
  userPromptMsgId: string | undefined;
  assistantSayingContent: string | null;
  assistantSayingGenseq: number | null;
  functionCallGenseqs: readonly number[];
  recordAnswerToHuman: boolean;
}): Promise<AnswerToHumanItem | undefined> {
  if (
    args.userPromptMsgId === undefined ||
    args.assistantSayingContent === null ||
    args.assistantSayingContent.trim() === '' ||
    args.assistantSayingGenseq === null
  ) {
    return undefined;
  }
  for (const rawGenseq of args.functionCallGenseqs) {
    if (!Number.isFinite(rawGenseq) || rawGenseq <= 0) {
      continue;
    }
    if (args.assistantSayingGenseq <= Math.floor(rawGenseq)) {
      return undefined;
    }
  }

  const latest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  const pending = latest?.pendingUserInterjectionReply;
  if (pending === undefined || pending.msgId !== args.userPromptMsgId) {
    return undefined;
  }

  const course = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  const answer: AnswerToHumanItem | undefined = args.recordAnswerToHuman
    ? {
        id: `a2h-${Buffer.from(
          [
            args.dlg.id.rootId,
            args.dlg.id.selfId,
            `c${String(course)}`,
            `g${String(args.assistantSayingGenseq)}`,
            pending.msgId,
          ].join('|'),
        ).toString('base64url')}`,
        content: args.assistantSayingContent,
        answeredAt: formatUnifiedTimestamp(new Date()),
        answerRef: {
          course,
          genseq: args.assistantSayingGenseq,
        },
      }
    : undefined;

  if (answer !== undefined) {
    const existingAnswers = await DialogPersistence.loadAnswersToHumanState(
      args.dlg.id,
      args.dlg.status,
    );
    if (!existingAnswers.some((item) => item.id === answer.id)) {
      await DialogPersistence.appendAnswerToHumanState(args.dlg.id, answer, args.dlg.status);
      const metadata = await DialogPersistence.loadDialogMetadata(args.dlg.id, args.dlg.status);
      const taskDocPath = metadata?.taskDocPath ?? args.dlg.taskDocPath ?? '';
      const event: NewA2HAnsweredEvent = {
        type: 'new_a2h_answered',
        answer: {
          ...answer,
          selfId: args.dlg.id.selfId,
          rootId: args.dlg.id.rootId,
          agentId: metadata?.agentId ?? args.dlg.agentId,
          taskDocPath,
        },
      };
      postDialogEvent(args.dlg, event);
    }
  }
  await DialogPersistence.mutateDialogLatest(
    args.dlg.id,
    (previous) => {
      const previousPending = previous.pendingUserInterjectionReply;
      const userPromptMsgId = args.userPromptMsgId;
      if (
        previousPending === undefined ||
        userPromptMsgId === undefined ||
        userPromptMsgId !== pending.msgId ||
        !samePendingUserInterjectionCoordinate(previousPending, pending)
      ) {
        return { kind: 'noop' };
      }
      const next = { ...previous };
      delete next.pendingUserInterjectionReply;
      return {
        kind: 'replace',
        next,
      };
    },
    args.dlg.status,
  );
  return answer;
}

async function persistAndEmitRuntimeGuide(dlg: Dialog, content: string): Promise<void> {
  await dlg.addChatMessages({
    type: 'transient_guide_msg',
    role: 'assistant',
    content,
  });
  await persistAndPostRuntimeGuide(dlg, content);
}

async function persistAndPostRuntimeGuide(dlg: Dialog, content: string): Promise<void> {
  await DialogPersistence.persistRuntimeGuide(dlg, content, dlg.activeGenSeq);
  postDialogEvent(dlg, {
    type: 'runtime_guide_evt',
    course: dlg.currentCourse,
    genseq: dlg.activeGenSeq,
    content,
  });
}

function resolveToolUseRequirement(
  dlg: Dialog,
  policy: KernelDriverPolicyState,
): 'none' | 'auto' | 'required' {
  // FBR middle rounds are deliberately isolated from callable tools. Final closure is the opposite:
  // the model must call one of the FBR conclusion tools instead of ending in plain text.
  if (policy.mode === 'fbr_toolless') return 'none';
  if (policy.mode === 'fbr_conclusion_only') return 'required';

  // For ordinary Dominds dialog rounds, the Diligence Push checkbox controls the provider-level
  // obligation directly. The numeric Diligence Push budget only limits automatic runtime prompts;
  // it must not downgrade the round into ordinary chat where the model can stop by asking/answering
  // in plain text instead of calling askHuman/answerHuman/tellask/reply tools.
  return dlg.disableDiligencePush ? 'auto' : 'required';
}

function resolveModelInfo(providerCfg: ProviderConfig, model: string): ModelInfo | undefined {
  return providerCfg.models[model];
}

function resolveRetryAggressiveMaxRetries(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.aggressiveMaxRetries;
  }
  const normalized = Math.floor(raw);
  if (normalized < 0) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.aggressiveMaxRetries;
  }
  return normalized;
}

function resolveRetryInitialDelayMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.initialDelayMs;
  }
  const normalized = Math.floor(raw);
  if (normalized < 0) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.initialDelayMs;
  }
  return normalized;
}

function resolveRetryBackoffMultiplier(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.backoffMultiplier;
  }
  if (raw < 1) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.backoffMultiplier;
  }
  return raw;
}

function resolveRetryConservativeDelayMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.conservativeDelayMs;
  }
  const normalized = Math.floor(raw);
  if (normalized < 0) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.conservativeDelayMs;
  }
  return normalized;
}

function resolveRetryMaxDelayMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.maxDelayMs;
  }
  const normalized = Math.floor(raw);
  if (normalized < 0) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.maxDelayMs;
  }
  return normalized;
}

function resolveKernelDriverRetryPolicy(providerCfg: ProviderConfig): KernelDriverRetryPolicy {
  const aggressiveMaxRetries = resolveRetryAggressiveMaxRetries(
    providerCfg.llm_retry_aggressive_max_retries,
  );
  const initialDelayMs = resolveRetryInitialDelayMs(providerCfg.llm_retry_initial_delay_ms);
  const conservativeDelayMs = resolveRetryConservativeDelayMs(
    providerCfg.llm_retry_conservative_delay_ms,
  );
  const backoffMultiplier = resolveRetryBackoffMultiplier(providerCfg.llm_retry_backoff_multiplier);
  const maxDelayMs = resolveRetryMaxDelayMs(providerCfg.llm_retry_max_delay_ms);

  return {
    aggressiveMaxRetries,
    initialDelayMs,
    conservativeDelayMs: Math.max(initialDelayMs, conservativeDelayMs),
    backoffMultiplier,
    maxDelayMs: Math.max(initialDelayMs, conservativeDelayMs, maxDelayMs),
  };
}

function hasMeaningfulBatchOutput(batch: Pick<LlmBatchResult, 'messages' | 'outputs'>): boolean {
  if (Array.isArray(batch.outputs) && batch.outputs.length > 0) {
    for (const output of batch.outputs) {
      if (output.kind === 'tool_result_image_ingest') {
        continue;
      }
      if (output.kind === 'user_image_ingest') {
        continue;
      }
      if (output.kind === 'invalid_func_call') {
        return true;
      }
      if (output.kind !== 'message') {
        return true;
      }
      const msg = output.message;
      if (msg.type === 'func_call_msg') {
        return true;
      }
      if ((msg.type === 'saying_msg' || msg.type === 'thinking_msg') && msg.content.trim() !== '') {
        return true;
      }
    }
    return false;
  }

  for (const msg of batch.messages) {
    if (msg.type === 'func_call_msg') {
      return true;
    }
    if ((msg.type === 'saying_msg' || msg.type === 'thinking_msg') && msg.content.trim() !== '') {
      return true;
    }
  }
  return false;
}

function resolveModelContextLimitTokens(modelInfo: ModelInfo | undefined): number | null {
  if (
    modelInfo &&
    typeof modelInfo.context_length === 'number' &&
    Number.isFinite(modelInfo.context_length)
  ) {
    const n = Math.floor(modelInfo.context_length);
    return n > 0 ? n : null;
  }
  if (
    modelInfo &&
    typeof modelInfo.input_length === 'number' &&
    Number.isFinite(modelInfo.input_length)
  ) {
    const n = Math.floor(modelInfo.input_length);
    return n > 0 ? n : null;
  }
  return null;
}

function resolveEffectiveTokenThresholds(args: {
  modelInfo: ModelInfo | undefined;
  modelContextLimitTokens: number;
}): {
  effectiveOptimalMaxTokens: number;
  optimalMaxTokensConfigured?: number;
  effectiveCriticalMaxTokens: number;
  criticalMaxTokensConfigured?: number;
} {
  const configuredOptimal =
    args.modelInfo &&
    typeof args.modelInfo.optimal_max_tokens === 'number' &&
    Number.isFinite(args.modelInfo.optimal_max_tokens)
      ? Math.floor(args.modelInfo.optimal_max_tokens)
      : undefined;
  const optimalMaxTokensConfigured =
    configuredOptimal !== undefined && configuredOptimal > 0 ? configuredOptimal : undefined;

  const configuredCritical =
    args.modelInfo &&
    typeof args.modelInfo.critical_max_tokens === 'number' &&
    Number.isFinite(args.modelInfo.critical_max_tokens)
      ? Math.floor(args.modelInfo.critical_max_tokens)
      : undefined;
  const criticalMaxTokensConfigured =
    configuredCritical !== undefined && configuredCritical > 0 ? configuredCritical : undefined;

  const defaultOptimal = 100_000;
  const effectiveOptimalMaxTokens =
    optimalMaxTokensConfigured !== undefined ? optimalMaxTokensConfigured : defaultOptimal;

  const defaultCritical = Math.max(1, Math.floor(args.modelContextLimitTokens * 0.9));
  const effectiveCriticalMaxTokens =
    criticalMaxTokensConfigured !== undefined ? criticalMaxTokensConfigured : defaultCritical;

  return {
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
  };
}

function resolveFbrEffortDefaultForTool(member: Team.Member): number {
  const raw = member.fbr_effort;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (!Number.isInteger(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 0;
  return raw;
}

function createFreshBootsReasoningTool(args: { fbrEffortDefault: number }): FuncTool {
  const fbrDefault = args.fbrEffortDefault;
  const fbrDefaultHint =
    fbrDefault > 0
      ? `If omitted, \`effort\` defaults to current member \`fbr_effort=${fbrDefault}\`.`
      : 'Runtime default for `effort` is current member `fbr_effort=0` (FBR disabled unless reconfigured).';
  return {
    type: 'func',
    name: 'freshBootsReasoning',
    description:
      'Start a tool-isolated FBR Side Dialog. `tellaskContent` must stay neutral and factual: Goal/Facts/Constraints/Evidence[/Unknowns], with no analysis scaffold. If the user says “FBR x3” or “3x FBR”, set `effort: 3`: `xN` is the absolute effort value, not “N times the current default”. ' +
      fbrDefaultHint,
    parameters: {
      type: 'object',
      properties: {
        tellaskContent: {
          type: 'string',
          description:
            'Neutral factual body only: Goal/Facts/Constraints/Evidence (optional Unknowns). Do not include dimension lists, fixed steps, or other analysis scaffolds.',
        },
        effort: {
          type: 'integer',
          description: `Optional absolute FBR effort (0..100 integer). “x3” / “3x” means \`effort: 3\`, not “3 × current fbr_effort”. Runtime maps effort N to N serial FBR passes in one Side Dialog window. When omitted, runtime defaults to current member fbr_effort=${fbrDefault}.`,
        },
      },
      required: ['tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('freshBootsReasoning is handled by kernel-driver tellask-special channel');
    },
  };
}

const TELLASK_SPECIAL_VIRTUAL_TOOLS: readonly FuncTool[] = [
  {
    type: 'func',
    name: 'tellaskBack',
    description:
      'Ask back to the tellasker in Side Dialog context when tellasker clarification/decision is required or ownership cannot be determined from SOP.',
    parameters: {
      type: 'object',
      properties: {
        tellaskContent: { type: 'string' },
      },
      required: ['tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('tellaskBack is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'tellask',
    description:
      'Ask a teammate to work on a task. Same targetAgentId + same sessionSlug continues the same task and updates it; a different sessionSlug is another independent task and will not affect other work for that teammate.',
    parameters: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string' },
        sessionSlug: { type: 'string' },
        tellaskContent: { type: 'string' },
      },
      required: ['targetAgentId', 'sessionSlug', 'tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('tellask is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'tellaskSessionless',
    description:
      'Ask a teammate to do a one-shot independent task. It does not update, affect, or stop earlier tasks.',
    parameters: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string' },
        tellaskContent: { type: 'string' },
      },
      required: ['targetAgentId', 'tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('tellaskSessionless is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'replyTellask',
    followupMode: 'deferred',
    description: 'Deliver final reply for the current tellask session.',
    parameters: {
      type: 'object',
      properties: {
        replyContent: { type: 'string' },
      },
      required: ['replyContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('replyTellask is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'replyTellaskSessionless',
    followupMode: 'deferred',
    description: 'Deliver final reply for the current one-shot tellask.',
    parameters: {
      type: 'object',
      properties: {
        replyContent: { type: 'string' },
      },
      required: ['replyContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error(
        'replyTellaskSessionless is handled by kernel-driver tellask-special channel',
      );
    },
  },
  {
    type: 'func',
    name: 'replyTellaskBack',
    followupMode: 'deferred',
    description: 'Deliver final reply for the current tellaskBack request.',
    parameters: {
      type: 'object',
      properties: {
        replyContent: { type: 'string' },
      },
      required: ['replyContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('replyTellaskBack is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'askHuman',
    followupMode: 'deferred',
    description: 'Ask for required clarification/decision from human.',
    parameters: {
      type: 'object',
      properties: {
        tellaskContent: { type: 'string' },
      },
      required: ['tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('askHuman is handled by kernel-driver tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'answerHuman',
    followupMode: 'deferred',
    description:
      'Record the current human-facing answer or status for human attention. Use this to finish the current required-tool round when no other substantive tool should be called, especially to explain that this dialog is waiting for pending active callees or tellask replies.',
    parameters: {
      type: 'object',
      properties: {
        answerContent: { type: 'string' },
      },
      required: ['answerContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('answerHuman is handled by kernel-driver tellask-special channel');
    },
  },
];

const CONTEXT_HEALTH_TOOL_RESULT_VISIBLE_BYTE_LIMIT = 2_000;
const CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_ZH =
  '这次函数返回内容太大，清理头脑之前不会显示给你。';
const CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_EN =
  'This function returned too much content. It will not be shown to you before you clear your mind.';

function pickContextHealthForLargeToolResultVisibility(args: {
  previous: ContextHealthSnapshot | undefined;
  current: ContextHealthSnapshot | undefined;
}): ContextHealthSnapshot | undefined {
  if (args.current?.kind === 'available') {
    return args.current;
  }
  return args.previous;
}

function formatContextHealthLargeToolReturnUnavailable(args: {
  dlg: Dialog;
  originalBytes: number;
  language: 'zh' | 'en';
}): string {
  const approxBytes = new Intl.NumberFormat(args.language === 'zh' ? 'zh-CN' : 'en-US').format(
    args.originalBytes,
  );

  if (args.language === 'zh') {
    if (args.dlg instanceof SideDialog) {
      return [
        CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_ZH,
        '',
        '不要再尝试获取各种大段的输出，都不会显示给你。现在先做两件事：',
        '1. 把需要回传给主线对话的结论、证据定位和风险整理清楚。',
        '2. 用当前对话范围（scope=dialog）提醒项写明本路对话任务目标，并把下一程恢复当前支线工作需要的信息带过桥。',
        '',
        '然后调用 clear_mind({}) 开启新一程，并尽快完成当前支线回复。',
        '',
        `详情：本次返回约 ${approxBytes} 字节。`,
      ].join('\n');
    }
    return [
      CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_ZH,
      '',
      '不要再尝试获取各种大段的输出，都不会显示给你。现在先做两件事：',
      '1. 把下一程对话需要知道的此程细节信息写入差遣牒合适章节。',
      '2. 对于不适合差遣牒章节覆盖、但下一程恢复当前对话需要的信息，用当前对话范围（scope=dialog）提醒项写明本路对话任务目标并带过桥。',
      '',
      '然后调用 clear_mind({}) 开启新一程。',
      '',
      `详情：本次返回约 ${approxBytes} 字节。`,
    ].join('\n');
  }

  if (args.dlg instanceof SideDialog) {
    return [
      CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_EN,
      '',
      'Do not try again to fetch any kind of large output; it still will not be shown. Do two things now:',
      '1. Organize the conclusions, evidence pointers, and risks that need to go back to the Mainline dialog.',
      '2. Use current-dialog scoped (scope=dialog) reminders to state this dialog task goal and carry over the details needed to resume this Sideline dialog in the next course.',
      '',
      'Then call clear_mind({}) to start a new course, and finish the current Sideline dialog reply as soon as possible.',
      '',
      `Detail: this return was about ${approxBytes} bytes.`,
    ].join('\n');
  }

  return [
    CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_EN,
    '',
    'Do not try again to fetch any kind of large output; it still will not be shown. Do two things now:',
    '1. Write the details from this course that the next course needs into the appropriate Taskdoc sections.',
    '2. For information that does not fit a Taskdoc section but is needed to resume this dialog in the next course, use current-dialog scoped (scope=dialog) reminders to state this dialog task goal and carry it over.',
    '',
    'Then call clear_mind({}) to start a new course.',
    '',
    `Detail: this return was about ${approxBytes} bytes.`,
  ].join('\n');
}

function countToolResultVisibleBytes(output: ToolCallOutput): number {
  const items = output.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return Buffer.byteLength(output.content, 'utf8');
  }

  let bytes = Buffer.byteLength(output.content, 'utf8');
  for (const item of items) {
    switch (item.type) {
      case 'input_text':
        bytes += Buffer.byteLength(item.text, 'utf8');
        break;
      case 'input_image':
        bytes += item.byteLength;
        break;
      default: {
        throw new Error(`Unsupported function result content item: ${String(item.type)}`);
      }
    }
  }
  return bytes;
}

function applyContextHealthToolResultVisibilityLimit(args: {
  dlg: Dialog;
  output: ToolCallOutput;
  contextHealth: ContextHealthSnapshot | undefined;
  language: 'zh' | 'en';
}): Readonly<{ output: ToolCallOutput; largeReturnUnavailable: boolean }> {
  if (isFbrSideDialog(args.dlg)) {
    return { output: args.output, largeReturnUnavailable: false };
  }
  if (getContextHealthRemediationLevel(args.contextHealth) === undefined) {
    return { output: args.output, largeReturnUnavailable: false };
  }
  const visibleBytes = countToolResultVisibleBytes(args.output);
  if (visibleBytes <= CONTEXT_HEALTH_TOOL_RESULT_VISIBLE_BYTE_LIMIT) {
    return { output: args.output, largeReturnUnavailable: false };
  }
  return {
    output: {
      content: formatContextHealthLargeToolReturnUnavailable({
        dlg: args.dlg,
        originalBytes: visibleBytes,
        language: args.language,
      }),
      outcome: args.output.outcome,
    },
    largeReturnUnavailable: true,
  };
}

function isContextHealthLargeToolReturnUnavailableResult(content: string): boolean {
  return (
    content.includes(CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_ZH) ||
    content.includes(CONTEXT_HEALTH_LARGE_TOOL_RETURN_UNAVAILABLE_EN)
  );
}

function latestInputLikeMessageIsContextHealthLargeToolReturnUnavailableResult(
  messages: readonly ChatMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg === undefined) {
      continue;
    }
    switch (msg.type) {
      case 'func_result_msg':
        return isContextHealthLargeToolReturnUnavailableResult(msg.content);
      case 'prompting_msg':
      case 'tellask_result_msg':
      case 'tellask_carryover_msg':
        return false;
      case 'environment_msg':
      case 'transient_guide_msg':
      case 'saying_msg':
      case 'thinking_msg':
      case 'func_call_msg':
        break;
      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `Unsupported chat message while checking latest input-like message: ${_exhaustive}`,
        );
      }
    }
  }
  return false;
}

function mergeTellaskVirtualTools(
  baseTools: readonly FuncTool[],
  options: {
    includeTellaskBack: boolean;
    fbrEffortDefault: number;
  },
): FuncTool[] {
  const merged: FuncTool[] = [...baseTools];
  const seen = new Set(merged.map((tool) => tool.name));
  const freshBootsReasoning = createFreshBootsReasoningTool({
    fbrEffortDefault: options.fbrEffortDefault,
  });
  const specialTools = TELLASK_SPECIAL_VIRTUAL_TOOLS.filter((tool) => {
    if (tool.name === 'tellaskBack') return options.includeTellaskBack;
    return true;
  });
  specialTools.push(freshBootsReasoning);
  for (const virtualTool of specialTools) {
    if (seen.has(virtualTool.name)) {
      throw new Error(
        `kernel-driver tool invariant violation: function tool name '${virtualTool.name}' collides with tellask-special virtual tool`,
      );
    }
    merged.push(virtualTool);
    seen.add(virtualTool.name);
  }
  return merged;
}

function computeContextHealthSnapshot(args: {
  providerCfg: ProviderConfig;
  model: string;
  usage: LlmUsageStats;
}): ContextHealthSnapshot {
  const modelInfo: ModelInfo | undefined = args.providerCfg.models[args.model];
  const modelContextWindowText =
    modelInfo && typeof modelInfo.context_window === 'string'
      ? modelInfo.context_window
      : undefined;
  const modelContextLimitTokens = resolveModelContextLimitTokens(modelInfo);
  if (modelContextLimitTokens === null) {
    return { kind: 'unavailable', reason: 'model_limit_unavailable', modelContextWindowText };
  }

  const {
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
  } = resolveEffectiveTokenThresholds({
    modelInfo,
    modelContextLimitTokens,
  });

  if (args.usage.kind !== 'available') {
    return {
      kind: 'unavailable',
      reason: 'usage_unavailable',
      modelContextWindowText,
      modelContextLimitTokens,
      effectiveOptimalMaxTokens,
      optimalMaxTokensConfigured,
      effectiveCriticalMaxTokens,
      criticalMaxTokensConfigured,
    };
  }

  const hardUtil = args.usage.promptTokens / modelContextLimitTokens;
  const optimalUtil = args.usage.promptTokens / effectiveOptimalMaxTokens;
  const level =
    args.usage.promptTokens > effectiveCriticalMaxTokens
      ? 'critical'
      : args.usage.promptTokens > effectiveOptimalMaxTokens
        ? 'caution'
        : 'healthy';

  return {
    kind: 'available',
    promptTokens: args.usage.promptTokens,
    completionTokens: args.usage.completionTokens,
    totalTokens: args.usage.totalTokens,
    modelContextWindowText,
    modelContextLimitTokens,
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
    hardUtil,
    optimalUtil,
    level,
  };
}

function resolveMemberDiligencePushMax(team: Team, agentId: string): number {
  const member = team.getMember(agentId);
  if (member && member.diligence_push_max !== undefined) {
    return member.diligence_push_max;
  }
  return DEFAULT_DILIGENCE_PUSH_MAX;
}

function emitDiligenceBudgetEvent(
  dlg: MainDialog,
  options: { maxInjectCount: number; nextRemainingBudget: number },
): void {
  const maxInjectCount = Math.max(0, Math.floor(options.maxInjectCount));
  const remainingCount = Math.max(0, Math.floor(options.nextRemainingBudget));
  const injectedCount = maxInjectCount > 0 ? Math.max(0, maxInjectCount - remainingCount) : 0;
  postDialogEvent(dlg, {
    type: 'diligence_budget_evt',
    maxInjectCount,
    injectedCount,
    remainingCount,
    disableDiligencePush: dlg.disableDiligencePush,
  });
}

async function renderRemindersForContext(dlg: Dialog): Promise<ChatMessage[]> {
  const reminders = await dlg.listVisibleReminders();
  if (reminders.length === 0) return [];
  const language = getWorkLanguage();
  const renderedItems: ChatMessage[] = [];
  const maintenanceReferenceItems: ReminderMaintenanceReferenceItem[] = [];
  for (const reminder of reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    maintenanceReferenceItems.push({
      id: reminder.id,
      meta: reminder.meta,
    });
    if (reminder.owner) {
      renderedItems.push(await reminder.owner.renderReminder(dlg, reminder));
      continue;
    }
    renderedItems.push({
      type: 'environment_msg',
      role: 'user',
      content: formatReminderItemGuide(language, reminder.id, reminder.content, {
        meta: reminder.meta,
        scope: reminder.scope,
      }),
    });
  }
  if (renderedItems.length === 0) return [];
  const maintenanceReference = formatReminderMaintenanceReference(
    language,
    maintenanceReferenceItems,
  );
  return [
    {
      type: 'environment_msg',
      role: 'user',
      content: formatReminderContextGuide(language),
    },
    ...(maintenanceReference === undefined
      ? []
      : [
          {
            type: 'transient_guide_msg' as const,
            role: 'assistant' as const,
            content: maintenanceReference,
          },
        ]),
    ...renderedItems,
  ];
}

function buildPendingTellaskFuncResult(args: {
  callId: string;
  callName: TellaskCallFunctionName;
  genseq: number;
}): FuncResultMsg {
  return {
    type: 'func_result_msg',
    role: 'tool',
    genseq: args.genseq,
    id: args.callId,
    name: args.callName,
    content: formatPendingTellaskFuncResultContent(args.callName, null, args.callId),
  };
}

type ProjectedTellaskContext = Readonly<{
  messages: ChatMessage[];
}>;

type PendingTellaskSpecialState = Readonly<{
  callName: TellaskCallFunctionName;
  startedAtMs: number | null;
}>;

async function loadPendingTellaskSpecialStates(
  dialog: Dialog,
): Promise<ReadonlyMap<string, PendingTellaskSpecialState>> {
  const pendingByCallId = new Map<string, PendingTellaskSpecialState>();

  const activeCalleeDispatches = await DialogPersistence.loadActiveCalleeDispatches(
    dialog.id,
    dialog.status,
  );
  for (const dispatch of activeCalleeDispatches) {
    const callId = dispatch.callId.trim();
    if (callId === '') {
      continue;
    }
    pendingByCallId.set(callId, {
      callName: dispatch.callName,
      startedAtMs: parseUnifiedTimestampMs(dispatch.createdAt),
    });
  }

  const pendingQ4H = await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status);
  for (const question of pendingQ4H) {
    if (typeof question.callId !== 'string') {
      continue;
    }
    const callId = question.callId.trim();
    if (callId === '') {
      continue;
    }
    pendingByCallId.set(callId, {
      callName: 'askHuman',
      startedAtMs: parseUnifiedTimestampMs(question.askedAt),
    });
  }

  return pendingByCallId;
}

async function projectTellaskFuncResultsForContext(args: {
  dialog: Dialog;
  dialogMsgsForContext: readonly ChatMessage[];
}): Promise<ProjectedTellaskContext> {
  const hasSpecialFuncCall = args.dialogMsgsForContext.some(
    (msg) => msg.type === 'func_call_msg' && isTellaskCallFunctionName(msg.name),
  );
  if (!hasSpecialFuncCall) {
    return {
      messages: [...args.dialogMsgsForContext],
    };
  }

  const pendingSpecialByCallId = await loadPendingTellaskSpecialStates(args.dialog);

  // Only technical tool-result-shaped messages can satisfy provider tool-call adjacency. Tellask
  // result/carryover messages are business facts in timeline order; the adjacent call-site
  // projection must be only a pending/pointer status, never the real reply body.
  const pairedToolResultContentByCallId = new Map<string, string>();
  const existingSpecialFuncResults = new Map<string, FuncResultMsg>();
  for (const msg of args.dialogMsgsForContext) {
    if (msg.type === 'tellask_result_msg') {
      const callId = typeof msg.callId === 'string' ? msg.callId.trim() : '';
      if (callId !== '') {
        if (!isTellaskCallFunctionName(msg.callName)) {
          throw new Error(
            `tellask result projection invariant violation: unsupported callName '${msg.callName}' for callId=${callId}`,
          );
        }
        pairedToolResultContentByCallId.set(
          callId,
          formatResolvedTellaskFuncResultContent({
            name: msg.callName,
            callId,
            status: msg.status,
          }),
        );
      }
      continue;
    }
    if (msg.type === 'func_result_msg' && isTellaskCallFunctionName(msg.name)) {
      existingSpecialFuncResults.set(msg.id, msg);
    }
  }

  const projected: ChatMessage[] = [];
  const specialCallIds = new Set<string>();
  for (const msg of args.dialogMsgsForContext) {
    if (msg.type === 'func_result_msg' && specialCallIds.has(msg.id)) {
      continue;
    }

    projected.push(msg);

    if (msg.type !== 'func_call_msg') {
      continue;
    }
    if (!isTellaskCallFunctionName(msg.name)) {
      continue;
    }

    specialCallIds.add(msg.id);
    const pairedToolResultContent = pairedToolResultContentByCallId.get(msg.id);
    if (pairedToolResultContent !== undefined) {
      projected.push({
        type: 'func_result_msg',
        role: 'tool',
        genseq: msg.genseq,
        id: msg.id,
        name: msg.name,
        content: pairedToolResultContent,
      });
      continue;
    }

    const existingResult = existingSpecialFuncResults.get(msg.id);
    if (existingResult) {
      projected.push(existingResult);
      continue;
    }

    const pendingSpecialState = pendingSpecialByCallId.get(msg.id);
    if (pendingSpecialState?.callName === msg.name) {
      projected.push({
        type: 'func_result_msg',
        role: 'tool',
        genseq: msg.genseq,
        id: msg.id,
        name: msg.name,
        content: formatPendingTellaskFuncResultContent(
          msg.name,
          pendingSpecialState.startedAtMs,
          msg.id,
        ),
      });
      continue;
    }

    projected.push(
      buildPendingTellaskFuncResult({
        callId: msg.id,
        callName: msg.name,
        genseq: msg.genseq,
      }),
    );
  }

  return {
    messages: projected,
  };
}

async function buildActiveReplyObligationContext(dlg: Dialog): Promise<ChatMessage[]> {
  const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    dlg.id,
    dlg.status,
  );
  if (activeReplyObligation === undefined) return [];
  return [
    {
      type: 'environment_msg',
      role: 'user',
      content: buildActiveReplyObligationContextText({
        language: getWorkLanguage(),
        directive: activeReplyObligation,
      }),
    },
  ];
}

function formatRecoveredUnresolvedToolCallResult(call: FuncCallMsg): string {
  return (
    `[kernel_driver_unpaired_tool_call_recovered] ` +
    `A persisted tool call was found without a matching tool result. ` +
    `The previous ${call.name} invocation did not produce a durable result record ` +
    `(callId=${call.id}). Treat that invocation as failed and retry the tool call if the task still needs it.`
  );
}

async function persistRecoveredToolCallResult(args: {
  dlg: Dialog;
  call: FuncCallMsg;
  violation: Extract<ToolCallAdjacencyViolation, { kind: 'unresolved_call' }>;
  detail: string;
}): Promise<FuncResultMsg> {
  const result: FuncResultMsg = {
    type: 'func_result_msg',
    role: 'tool',
    genseq: args.call.genseq,
    id: args.call.id,
    ...(args.call.rawId !== undefined ? { rawId: args.call.rawId } : {}),
    ...(args.call.effectiveId !== undefined ? { effectiveId: args.call.effectiveId } : {}),
    name: args.call.name,
    content: formatRecoveredUnresolvedToolCallResult(args.call),
  };
  const record: FuncResultRecord = {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'func_result_record',
    ...toRootGenerationAnchor({
      rootCourse: (args.dlg instanceof SideDialog ? args.dlg.mainDialog : args.dlg).currentCourse,
      rootGenseq:
        (args.dlg instanceof SideDialog ? args.dlg.mainDialog : args.dlg).activeGenSeqOrUndefined ??
        0,
    }),
    genseq: result.genseq,
    id: result.id,
    ...(result.rawId !== undefined ? { rawId: result.rawId } : {}),
    ...(result.effectiveId !== undefined ? { effectiveId: result.effectiveId } : {}),
    name: result.name,
    content: result.content,
  };
  const course = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  await DialogPersistence.appendEvent(args.dlg.id, course, record, args.dlg.status);
  await args.dlg.addChatMessages(result);
  log.error(
    'kernel-driver repaired unpaired persisted tool call with synthetic failure result',
    new Error('kernel_driver_repaired_unpaired_persisted_tool_call'),
    {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      course,
      callGenseq: args.call.genseq,
      callId: args.call.id,
      toolName: args.call.name,
      violationIndex: args.violation.index,
      detail: args.detail,
    },
  );
  return result;
}

function findLaterMatchingToolResultIndex(
  messages: readonly ChatMessage[],
  callIndex: number,
  call: FuncCallMsg,
): number {
  for (let index = callIndex + 1; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg?.type === 'func_result_msg' && msg.id === call.id && msg.name === call.name) {
      return index;
    }
  }
  return -1;
}

function alignLaterMatchingToolResultsForProviderContext(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const aligned: ChatMessage[] = [...messages];
  for (let index = 0; index < aligned.length; index += 1) {
    const msg = aligned[index];
    if (msg?.type !== 'func_call_msg') continue;
    const next = aligned[index + 1];
    if (next?.type === 'func_result_msg' && next.id === msg.id && next.name === msg.name) {
      continue;
    }
    const resultIndex = findLaterMatchingToolResultIndex(aligned, index, msg);
    if (resultIndex < 0) continue;
    const result = aligned[resultIndex];
    if (result?.type !== 'func_result_msg') {
      throw new Error(
        `kernel-driver tool-context alignment invariant violation: matching result disappeared ` +
          `(callId=${msg.id}, index=${resultIndex})`,
      );
    }
    aligned.splice(resultIndex, 1);
    aligned.splice(index + 1, 0, result);
  }
  return aligned;
}

async function repairUnresolvedToolCallsForProviderContext(args: {
  dlg: Dialog;
  messages: readonly ChatMessage[];
  violations: readonly ToolCallAdjacencyViolation[];
  details: readonly string[];
}): Promise<ChatMessage[] | null> {
  const repairedMessages: ChatMessage[] = [...args.messages];
  let repairedCount = 0;

  for (let violationIndex = args.violations.length - 1; violationIndex >= 0; violationIndex -= 1) {
    const violation = args.violations[violationIndex];
    if (!violation || violation.kind !== 'unresolved_call') continue;
    const call = repairedMessages[violation.index];
    if (call?.type !== 'func_call_msg') {
      throw new Error(
        `kernel-driver tool-context repair invariant violation: missing func_call_msg at violation index ` +
          `(dialog=${args.dlg.id.valueOf()}, callId=${violation.callId}, index=${violation.index})`,
      );
    }
    if (call.id !== violation.callId || call.name !== violation.toolName) {
      throw new Error(
        `kernel-driver tool-context repair invariant violation: mismatched unresolved call ` +
          `(dialog=${args.dlg.id.valueOf()}, expectedCallId=${violation.callId}, actualCallId=${call.id}, ` +
          `expectedTool=${violation.toolName}, actualTool=${call.name}, index=${violation.index})`,
      );
    }
    const existingResultIndex = findLaterMatchingToolResultIndex(
      repairedMessages,
      violation.index,
      call,
    );
    const result =
      existingResultIndex >= 0
        ? (() => {
            const existing = repairedMessages[existingResultIndex];
            if (existing?.type !== 'func_result_msg') {
              throw new Error(
                `kernel-driver tool-context repair invariant violation: matching result disappeared ` +
                  `(dialog=${args.dlg.id.valueOf()}, callId=${call.id}, index=${existingResultIndex})`,
              );
            }
            repairedMessages.splice(existingResultIndex, 1);
            return existing;
          })()
        : await persistRecoveredToolCallResult({
            dlg: args.dlg,
            call,
            violation,
            detail:
              args.details[violationIndex] ?? args.details[0] ?? 'unresolved persisted tool call',
          });
    repairedMessages.splice(violation.index + 1, 0, result);
    repairedCount += 1;
  }

  return repairedCount === 0 ? null : repairedMessages;
}

async function buildDialogMsgsForContext(dlg: Dialog): Promise<ChatMessage[]> {
  const rawDialogMsgsForContext: ChatMessage[] = dlg.msgs.filter((m) => !!m);
  const projected = await projectTellaskFuncResultsForContext({
    dialog: dlg,
    dialogMsgsForContext: rawDialogMsgsForContext,
  });
  const businessFiltered = projected.messages.filter((msg) => {
    return msg.type !== 'tellask_result_msg' || msg.content.trim() !== '';
  });
  const providerAligned = alignLaterMatchingToolResultsForProviderContext(businessFiltered);
  const sanitized = sanitizeToolContextForProvider(providerAligned);
  if (sanitized.droppedViolations.length > 0) {
    const details = sanitized.droppedViolations.map((violation) =>
      formatToolCallAdjacencyViolation(violation, 'kernel-driver provider context sanitization'),
    );
    const summary =
      `kernel-driver dropped ${sanitized.droppedViolations.length} unpaired persisted tool ` +
      `message(s) before provider projection for dialog=${dlg.id.valueOf()}; see logs for details.`;
    log.error(summary, new Error('kernel_driver_provider_context_sanitized_unpaired_tool_msgs'), {
      rootId: dlg.id.rootId,
      selfId: dlg.id.selfId,
      droppedViolationCount: sanitized.droppedViolations.length,
      droppedViolations: sanitized.droppedViolations.map((violation) => ({
        kind: violation.kind,
        callId: violation.callId,
        toolName: violation.toolName,
        index: violation.index,
      })),
      detailPreview: details.slice(0, 3),
    });
    try {
      await dlg.streamError(`${summary} ${details.slice(0, 3).join(' ')}`);
    } catch (error) {
      log.warn('kernel-driver failed to emit stream_error_evt for sanitized tool context', error, {
        rootId: dlg.id.rootId,
        selfId: dlg.id.selfId,
      });
    }
    const repaired = await repairUnresolvedToolCallsForProviderContext({
      dlg,
      messages: providerAligned,
      violations: sanitized.droppedViolations,
      details,
    });
    if (repaired !== null) {
      const repairedSanitized = sanitizeToolContextForProvider(repaired);
      if (
        repairedSanitized.droppedViolations.some(
          (violation) => violation.kind === 'unresolved_call',
        )
      ) {
        throw new Error(
          `kernel-driver tool-context repair failed to pair unresolved calls for dialog=${dlg.id.valueOf()}`,
        );
      }
      return repairedSanitized.messages;
    }
  }
  return sanitized.messages;
}

async function emitAssistantSaying(dlg: Dialog, content: string): Promise<void> {
  if (content.trim() === '') return;
  await dlg.sayingStart();
  await dlg.sayingChunk(content);
  await dlg.sayingFinish();
}

async function recordStructuredAnswering(args: {
  dlg: Dialog;
  content: string;
  source: string;
}): Promise<AnswerToHumanItem | undefined> {
  if (args.content.trim() === '') return undefined;
  const course = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  const genseq = args.dlg.activeGenSeqOrUndefined ?? 1;
  return await recordAnswerToHuman({
    dlg: args.dlg,
    answerContent: args.content,
    course,
    genseq,
    answerIdSource: [
      args.dlg.id.rootId,
      args.dlg.id.selfId,
      `c${String(course)}`,
      `g${String(genseq)}`,
      args.source,
    ].join('|'),
  });
}

function formatInvalidFuncCallRuntimeGuide(
  language: 'zh' | 'en',
  call: LlmInvalidFuncCall,
): string {
  const rawName =
    call.rawFunctionName !== undefined && call.rawFunctionName.trim() !== ''
      ? call.rawFunctionName.trim()
      : '<missing>';
  const rawArguments =
    call.rawArgumentsText !== undefined && call.rawArgumentsText.trim() !== ''
      ? call.rawArgumentsText
      : '<empty>';
  const indexLine =
    call.toolCallIndex === undefined ? undefined : `- toolCallIndex: ${String(call.toolCallIndex)}`;
  if (language === 'en') {
    return [
      '[Runtime notice] Your previous response tried to call a tool, but the tool call was malformed and could not be run.',
      '',
      `- provider: ${call.provider}`,
      `- callId: ${call.callId}`,
      `- problem: ${call.detail}`,
      `- rawFunctionName: ${rawName}`,
      `- rawArgumentsText:`,
      '```json',
      rawArguments,
      '```',
      ...(indexLine === undefined ? [] : [indexLine]),
      '',
      'Treat that tool call as failed. Do not assume the tool ran. Continue the current task; if you still need a tool, call it again with a real tool name and valid arguments.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }
  return [
    '[Dominds 提示] 你上一轮尝试调用工具，但工具调用格式无效，Dominds 没有执行它。',
    '',
    `- provider: ${call.provider}`,
    `- callId: ${call.callId}`,
    `- 问题: ${call.detail}`,
    `- rawFunctionName: ${rawName}`,
    `- rawArgumentsText:`,
    '```json',
    rawArguments,
    '```',
    ...(indexLine === undefined ? [] : [indexLine]),
    '',
    '请把这次工具调用视为失败，不要假设工具已经执行。继续当前任务；如果仍需要工具，请重新发起一次工具名明确、参数有效的调用。',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function stableJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function canonicalizeToolCallArguments(rawArguments: string): string {
  try {
    return stableJsonStringify(JSON.parse(rawArguments) as unknown);
  } catch {
    return rawArguments;
  }
}

function canonicalizeToolResult(result: FuncResultMsg): string {
  return stableJsonStringify({
    content: result.content,
    contentItems: result.contentItems ?? null,
  });
}

function buildToolResultFingerprint(
  call: FuncCallMsg,
  result: FuncResultMsg,
): ToolResultFingerprint {
  return {
    toolName: call.name,
    argumentsFingerprint: canonicalizeToolCallArguments(call.arguments),
    resultFingerprint: canonicalizeToolResult(result),
  };
}

function sameToolResultFingerprint(
  left: ToolResultFingerprint,
  right: ToolResultFingerprint,
): boolean {
  return (
    left.toolName === right.toolName &&
    left.argumentsFingerprint === right.argumentsFingerprint &&
    left.resultFingerprint === right.resultFingerprint
  );
}

function formatRepeatedToolCallRuntimeGuide(args: {
  language: 'zh' | 'en';
  toolName: string;
  callIds: readonly string[];
  argumentsFingerprint: string;
  resultContent: string;
}): string {
  const resultPreview =
    args.resultContent.length > 800
      ? `${args.resultContent.slice(0, 800)}\n...`
      : args.resultContent;
  if (args.language === 'en') {
    return [
      '[Runtime notice] You have just made the same tool call three times, with identical arguments, and Dominds observed the exact same tool result each time.',
      '',
      `- tool: ${args.toolName}`,
      `- callIds: ${args.callIds.join(', ')}`,
      '- arguments:',
      '```json',
      args.argumentsFingerprint,
      '```',
      '- repeated result:',
      '```text',
      resultPreview,
      '```',
      '',
      'Question this behavior before calling tools again. The repeated result strongly suggests the same call will not produce new information. Re-read the user request and the tool result, then correct course: answer from the available information, choose a different action, or explain what is blocked.',
    ].join('\n');
  }
  return [
    '[Dominds 提示] 你刚才连续三次调用了同一个工具，参数完全相同，Dominds 观察到三次工具返回值也完全相同。',
    '',
    `- 工具: ${args.toolName}`,
    `- callIds: ${args.callIds.join(', ')}`,
    '- 参数:',
    '```json',
    args.argumentsFingerprint,
    '```',
    '- 重复返回值:',
    '```text',
    resultPreview,
    '```',
    '',
    '请先质疑这个行为，不要机械地再次调用同一个工具。同样的调用大概率不会产生新信息。请重新阅读用户诉求和工具返回值，然后自行纠正：基于已有信息作答、换一种行动，或明确说明当前阻塞点。',
  ].join('\n');
}

function formatRepeatedToolCallStoppedDetail(args: {
  language: 'zh' | 'en';
  toolName: string;
  callIds: readonly string[];
}): string {
  if (args.language === 'en') {
    return (
      `Stopped because the LLM ignored Dominds' repeated-tool-call correction notice and again made ` +
      `the same tool call three times with identical results. This indicates an LLM behavior/personality problem: ` +
      `it is looping on ${args.toolName} instead of reconsidering the task. callIds=${args.callIds.join(', ')}`
    );
  }
  return (
    `已停止：LLM 已收到 Dominds 的重复工具调用纠正提醒，但仍然再次连续三次调用同一个工具并得到完全相同的结果。` +
    `这说明当前 LLM 存在行为/个性问题：它在 ${args.toolName} 上机械循环，而不是重新判断任务。` +
    `callIds=${args.callIds.join(', ')}`
  );
}

const REPEATED_TOOL_CALL_STOP_WINDOW_GENSEQS = 5;

function inspectRepeatedToolCallRound(args: {
  state: RepeatedToolCallMonitorState;
  currentCourse: number;
  pairedMessages: readonly ChatMessage[];
  language: 'zh' | 'en';
}): RepeatedToolCallInspection | undefined {
  ensureRepeatedToolCallMonitorCourse(args.state, args.currentCourse);
  const recentPairs: Array<
    Readonly<{
      call: FuncCallMsg;
      result: FuncResultMsg;
      fingerprint: ToolResultFingerprint;
    }>
  > = [];
  for (let index = 0; index < args.pairedMessages.length - 1; index += 1) {
    const call = args.pairedMessages[index];
    const result = args.pairedMessages[index + 1];
    if (call?.type !== 'func_call_msg' || result?.type !== 'func_result_msg') {
      continue;
    }
    if (result.id !== call.id) {
      continue;
    }
    recentPairs.push({
      call,
      result,
      fingerprint: buildToolResultFingerprint(call, result),
    });
  }

  for (const pair of recentPairs) {
    const currentSequence = args.state.sequence;
    if (
      currentSequence !== undefined &&
      sameToolResultFingerprint(currentSequence.fingerprint, pair.fingerprint)
    ) {
      currentSequence.callIds.push(pair.call.id);
      if (currentSequence.callIds.length > 3) {
        currentSequence.callIds.splice(0, currentSequence.callIds.length - 3);
      }
      currentSequence.resultContent = pair.result.content;
    } else {
      args.state.sequence = {
        fingerprint: pair.fingerprint,
        callIds: [pair.call.id],
        resultContent: pair.result.content,
      };
    }

    const sequence = args.state.sequence;
    if (sequence === undefined || sequence.callIds.length < 3) {
      continue;
    }
    const recentReminder =
      args.state.lastReminderGenseq !== undefined &&
      pair.call.genseq > args.state.lastReminderGenseq &&
      pair.call.genseq - args.state.lastReminderGenseq <= REPEATED_TOOL_CALL_STOP_WINDOW_GENSEQS;
    const callIds = [...sequence.callIds];
    return {
      toolName: pair.call.name,
      callIds,
      argumentsFingerprint: pair.fingerprint.argumentsFingerprint,
      resultContent: sequence.resultContent,
      reminderContent: formatRepeatedToolCallRuntimeGuide({
        language: args.language,
        toolName: pair.call.name,
        callIds,
        argumentsFingerprint: pair.fingerprint.argumentsFingerprint,
        resultContent: sequence.resultContent,
      }),
      repeatedAfterReminder: recentReminder,
    };
  }
  return undefined;
}

async function persistInvalidFuncCallRuntimeGuide(args: {
  dlg: Dialog;
  call: LlmInvalidFuncCall;
  source: 'streamed' | 'batch';
  newMsgs: ChatMessage[];
  emitStreamError: boolean;
}): Promise<void> {
  const { dlg, call } = args;
  const sourceText = args.source === 'streamed' ? 'streamed' : 'batch';
  log.error(
    `kernel-driver received invalid ${sourceText} function call payload`,
    new Error(`kernel_driver_invalid_${sourceText}_function_call_payload`),
    {
      rootId: dlg.id.rootId,
      selfId: dlg.id.selfId,
      course: dlg.activeGenCourseOrUndefined ?? dlg.currentCourse,
      genseq: dlg.activeGenSeq,
      callId: call.callId,
      provider: call.provider,
      detail: call.detail,
      toolCallIndex: call.toolCallIndex,
    },
  );
  if (args.emitStreamError) {
    await dlg.streamError(call.detail);
  }
  const content = formatInvalidFuncCallRuntimeGuide(getWorkLanguage(), call);
  args.newMsgs.push({
    type: 'transient_guide_msg',
    role: 'assistant',
    content,
  });
  await persistAndPostRuntimeGuide(dlg, content);
}

type RoutedFunctionResult = {
  hasImmediateFollowupToolCalls: boolean;
  hasImmediateTellaskOutputs: boolean;
  immediateFollowupCallIds: readonly string[];
  immediateTellaskOutputCallIds: readonly string[];
  invalidTellaskCallIds: readonly string[];
  repeatedToolCallReminderCallIds: readonly string[];
  shouldStopAfterReplyTool: boolean;
  shouldStopAfterPendingTellaskWait: boolean;
  pairedMessages: ChatMessage[];
  tellaskToolOutputs: ChatMessage[];
  answerHumanOutputs: readonly AnswerHumanStructuredOutput[];
};

type ToolResultFingerprint = Readonly<{
  toolName: string;
  argumentsFingerprint: string;
  resultFingerprint: string;
}>;

type RepeatedToolCallInspection = Readonly<{
  toolName: string;
  callIds: readonly string[];
  argumentsFingerprint: string;
  resultContent: string;
  reminderContent: string;
  repeatedAfterReminder: boolean;
}>;

type RepeatedToolCallMonitorState = {
  course?: number;
  sequence?: {
    fingerprint: ToolResultFingerprint;
    callIds: string[];
    resultContent: string;
  };
  lastReminderGenseq?: number;
};

function resetRepeatedToolCallMonitor(state: RepeatedToolCallMonitorState): void {
  state.sequence = undefined;
  state.lastReminderGenseq = undefined;
}

function ensureRepeatedToolCallMonitorCourse(
  state: RepeatedToolCallMonitorState,
  course: number,
): void {
  if (state.course === course) {
    return;
  }
  resetRepeatedToolCallMonitor(state);
  state.course = course;
}

type ToolRoundStopDiagnostics = Readonly<{
  course: number;
  genseq: number;
  callIds: readonly string[];
  callNames: readonly string[];
  lastBusinessContinuation: DialogBusinessContinuation;
  routed: Readonly<{
    hasImmediateFollowupToolCalls: boolean;
    hasImmediateTellaskOutputs: boolean;
    immediateFollowupCallIds: readonly string[];
    immediateTellaskOutputCallIds: readonly string[];
    invalidTellaskCallIds: readonly string[];
    repeatedToolCallReminderCallIds: readonly string[];
    shouldStopAfterReplyTool: boolean;
    shouldStopAfterPendingTellaskWait: boolean;
    pairedMessageTypes: readonly string[];
    tellaskToolOutputTypes: readonly string[];
  }>;
  decision: Readonly<{
    shouldStartImmediatePostToolGeneration: boolean;
    stopReason:
      | 'queued_prompt_after_tool_round'
      | 'suspended_after_tool_round'
      | 'reply_tool'
      | 'pending_tellask_wait'
      | 'no_post_tool_continuation';
    suspensionAfterToolRound?: Awaited<ReturnType<Dialog['getSuspensionStatus']>>;
    queuedPromptAfterToolRound?: boolean;
    remindersVer?: number;
    pubRemindersVer?: number;
  }>;
}>;

type ImmediateFollowupTriggerDraft = Extract<DialogNextStepTriggerDraft, { kind: 'followup' }>;

type ImmediateFollowupTriggerExpectation = Readonly<{
  trigger: ImmediateFollowupTriggerDraft;
  callIds: readonly string[];
  callNames: readonly string[];
  routed: ToolRoundStopDiagnostics['routed'];
  continuation: DialogBusinessContinuation;
  invalidFuncCallCount: number;
}>;

type ImmediateFollowupTriggerRepairOutcome = 'repaired' | 'repair_failed';

type QueuedNewCourseRuntimePrompt = Extract<
  DialogQueuedPromptState,
  {
    kind: 'new_course_runtime_guide' | 'new_course_runtime_reply' | 'new_course_runtime_sideDialog';
  }
>;

function isQueuedNewCourseRuntimePrompt(
  prompt: DialogQueuedPromptState | undefined,
): prompt is QueuedNewCourseRuntimePrompt {
  return (
    prompt?.kind === 'new_course_runtime_guide' ||
    prompt?.kind === 'new_course_runtime_reply' ||
    prompt?.kind === 'new_course_runtime_sideDialog'
  );
}

function queuedNewCourseRuntimePromptToKernelPrompt(
  prompt: QueuedNewCourseRuntimePrompt,
): KernelDriverRuntimePrompt {
  const common = {
    content: prompt.prompt,
    msgId: prompt.msgId,
    grammar: prompt.grammar ?? ('markdown' as const),
    userLanguageCode: prompt.userLanguageCode,
    runControl: prompt.runControl,
    origin: 'runtime' as const,
    ...(prompt.skipTaskdoc === undefined ? {} : { skipTaskdoc: prompt.skipTaskdoc }),
  };
  switch (prompt.kind) {
    case 'new_course_runtime_guide':
      return common;
    case 'new_course_runtime_reply':
      return {
        ...common,
        tellaskReplyDirective: prompt.tellaskReplyDirective,
      };
    case 'new_course_runtime_sideDialog':
      return {
        ...common,
        tellaskReplyDirective: prompt.tellaskReplyDirective,
        calleeDialogReplyTarget: prompt.calleeDialogReplyTarget,
      };
  }
}

async function consumeQueuedNewCourseRuntimePromptForSameDrive(
  dlg: Dialog,
): Promise<KernelDriverRuntimePrompt | undefined> {
  const queuedPrompt = dlg.peekQueuedPrompt();
  if (!isQueuedNewCourseRuntimePrompt(queuedPrompt)) {
    return undefined;
  }
  const consumedPrompt = dlg.takeQueuedPrompt();
  if (!consumedPrompt || consumedPrompt.msgId !== queuedPrompt.msgId) {
    throw new Error(
      `queued new-course prompt invariant violation: expected queued prompt ${queuedPrompt.msgId} before same-drive continuation`,
    );
  }
  await DialogPersistence.clearPendingRuntimePrompt(dlg.id, queuedPrompt.msgId, dlg.status);
  return queuedNewCourseRuntimePromptToKernelPrompt(queuedPrompt);
}

function resolveFuncToolFollowupMode(tool: FuncTool | undefined): FuncToolFollowupMode {
  return tool?.followupMode ?? 'immediate';
}

function summarizeRoutedFunctionResult(
  routed: RoutedFunctionResult,
): ToolRoundStopDiagnostics['routed'] {
  return {
    hasImmediateFollowupToolCalls: routed.hasImmediateFollowupToolCalls,
    hasImmediateTellaskOutputs: routed.hasImmediateTellaskOutputs,
    immediateFollowupCallIds: routed.immediateFollowupCallIds,
    immediateTellaskOutputCallIds: routed.immediateTellaskOutputCallIds,
    invalidTellaskCallIds: routed.invalidTellaskCallIds,
    repeatedToolCallReminderCallIds: routed.repeatedToolCallReminderCallIds,
    shouldStopAfterReplyTool: routed.shouldStopAfterReplyTool,
    shouldStopAfterPendingTellaskWait: routed.shouldStopAfterPendingTellaskWait,
    pairedMessageTypes: routed.pairedMessages.map((msg) => msg.type),
    tellaskToolOutputTypes: routed.tellaskToolOutputs.map((msg) => msg.type),
  };
}

function buildToolRoundStopDiagnostics(args: {
  dlg: Dialog;
  streamedFuncCalls: readonly FuncCallMsg[];
  routed: RoutedFunctionResult;
  lastBusinessContinuation: DialogBusinessContinuation;
  shouldStartImmediatePostToolGeneration: boolean;
  stopReason: ToolRoundStopDiagnostics['decision']['stopReason'];
  suspensionAfterToolRound?: Awaited<ReturnType<Dialog['getSuspensionStatus']>>;
  queuedPromptAfterToolRound?: boolean;
  remindersVer?: number;
  pubRemindersVer?: number;
}): ToolRoundStopDiagnostics {
  return {
    course: args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse,
    genseq: args.dlg.activeGenSeq,
    callIds: args.streamedFuncCalls.map((call) => call.id),
    callNames: args.streamedFuncCalls.map((call) => call.name),
    lastBusinessContinuation: args.lastBusinessContinuation,
    routed: summarizeRoutedFunctionResult(args.routed),
    decision: {
      shouldStartImmediatePostToolGeneration: args.shouldStartImmediatePostToolGeneration,
      stopReason: args.stopReason,
      ...(args.suspensionAfterToolRound === undefined
        ? {}
        : { suspensionAfterToolRound: args.suspensionAfterToolRound }),
      ...(args.queuedPromptAfterToolRound === undefined
        ? {}
        : { queuedPromptAfterToolRound: args.queuedPromptAfterToolRound }),
      ...(args.remindersVer === undefined ? {} : { remindersVer: args.remindersVer }),
      ...(args.pubRemindersVer === undefined ? {} : { pubRemindersVer: args.pubRemindersVer }),
    },
  };
}

function shouldCaptureUnexpectedIdleAfterToolRound(args: {
  finalDisplayState: DialogDisplayState;
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
  diagnostics: ToolRoundStopDiagnostics | undefined;
}): boolean {
  if (args.finalDisplayState.kind !== 'idle_waiting_user') return false;
  const diagnostics = args.diagnostics;
  if (diagnostics === undefined) return false;
  if (diagnostics.callIds.length === 0) return false;
  if ((args.latest?.nextStep.triggers.length ?? 0) > 0) return false;
  if (
    diagnostics.decision.stopReason === 'reply_tool' ||
    diagnostics.decision.stopReason === 'pending_tellask_wait'
  ) {
    return false;
  }

  const continuation = diagnostics.lastBusinessContinuation;
  if (continuation.kind !== 'none') return true;
  if (diagnostics.routed.hasImmediateFollowupToolCalls) return true;
  if (diagnostics.routed.hasImmediateTellaskOutputs) return true;
  if (diagnostics.routed.immediateFollowupCallIds.length > 0) return true;
  if (diagnostics.routed.immediateTellaskOutputCallIds.length > 0) return true;
  if (diagnostics.routed.repeatedToolCallReminderCallIds.length > 0) return true;
  return false;
}

function sanitizeDebugFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized.slice(0, 80) : 'unknown';
}

async function maybeWriteUnexpectedIdleAfterToolRoundDebugDump(args: {
  dlg: Dialog;
  finalDisplayState: DialogDisplayState;
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
  diagnostics: ToolRoundStopDiagnostics | undefined;
}): Promise<void> {
  if (
    !shouldCaptureUnexpectedIdleAfterToolRound({
      finalDisplayState: args.finalDisplayState,
      latest: args.latest,
      diagnostics: args.diagnostics,
    })
  ) {
    return;
  }

  const diagnostics = args.diagnostics;
  if (diagnostics === undefined) {
    throw new Error('unexpected idle debug invariant violation: diagnostics disappeared');
  }

  const capturedAt = formatUnifiedTimestamp(new Date());
  const debugDir = path.resolve(domindsRtwsRootAbs(), '.dialogs', 'debug');
  const fileName = [
    'kernel-driver-unexpected-idle-after-tool-round',
    sanitizeDebugFileSegment(capturedAt),
    sanitizeDebugFileSegment(args.dlg.id.rootId),
    sanitizeDebugFileSegment(args.dlg.id.selfId),
    `c${String(diagnostics.course)}`,
    `g${String(diagnostics.genseq)}`,
    `${generateShortId()}.json`,
  ].join('-');
  const activeCallees = await DialogPersistence.loadActiveCallees(args.dlg.id, args.dlg.status);
  const suspension = await args.dlg.getSuspensionStatus();
  const payload = {
    kind: 'kernel_driver_unexpected_idle_after_tool_round',
    capturedAt,
    rtwsRootAbs: domindsRtwsRootAbs(),
    dialog: {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      value: args.dlg.id.valueOf(),
      agentId: args.dlg.agentId,
      status: args.dlg.status,
      currentCourse: args.dlg.currentCourse,
      activeGenCourse: args.dlg.activeGenCourseOrUndefined ?? null,
      activeGenSeq: args.dlg.activeGenSeqOrUndefined ?? null,
      hasQueuedPrompt: args.dlg.hasQueuedPrompt(),
      queuedPrompt: args.dlg.peekQueuedPrompt() ?? null,
    },
    finalDisplayState: args.finalDisplayState,
    latest: args.latest,
    activeCallees,
    suspension,
    diagnostics,
    callstack: new Error('kernel-driver unexpected idle after tool round').stack ?? null,
  };

  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(
    path.join(debugDir, fileName),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

async function writeMissingImmediateFollowupTriggerDebugDump(args: {
  dlg: Dialog;
  expectation: ImmediateFollowupTriggerExpectation;
  latestBeforeRepair: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
  latestAfterRepair: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
  checkPoint: string;
  repairOutcome: ImmediateFollowupTriggerRepairOutcome;
}): Promise<string> {
  const capturedAt = formatUnifiedTimestamp(new Date());
  const debugDir = path.resolve(domindsRtwsRootAbs(), '.dialogs', 'debug');
  const trigger = args.expectation.trigger;
  const fileName = [
    'kernel-driver-missing-immediate-followup-trigger',
    sanitizeDebugFileSegment(capturedAt),
    sanitizeDebugFileSegment(args.dlg.id.rootId),
    sanitizeDebugFileSegment(args.dlg.id.selfId),
    sanitizeDebugFileSegment(trigger.triggerId),
    `${generateShortId()}.json`,
  ].join('-');
  const activeCallees = await DialogPersistence.loadActiveCallees(args.dlg.id, args.dlg.status);
  const suspension = await args.dlg.getSuspensionStatus();
  const payload = {
    kind:
      args.repairOutcome === 'repaired'
        ? 'kernel_driver_missing_immediate_followup_trigger_repaired'
        : 'kernel_driver_missing_immediate_followup_trigger_repair_failed',
    capturedAt,
    rtwsRootAbs: domindsRtwsRootAbs(),
    repairOutcome: args.repairOutcome,
    checkPoint: args.checkPoint,
    dialog: {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      value: args.dlg.id.valueOf(),
      agentId: args.dlg.agentId,
      status: args.dlg.status,
      currentCourse: args.dlg.currentCourse,
      activeGenCourse: args.dlg.activeGenCourseOrUndefined ?? null,
      activeGenSeq: args.dlg.activeGenSeqOrUndefined ?? null,
      hasQueuedPrompt: args.dlg.hasQueuedPrompt(),
      queuedPrompt: args.dlg.peekQueuedPrompt() ?? null,
    },
    expectation: args.expectation,
    latestBeforeRepair: args.latestBeforeRepair,
    latestAfterRepair: args.latestAfterRepair,
    activeCallees,
    suspension,
    callstack:
      new Error(
        args.repairOutcome === 'repaired'
          ? 'kernel-driver missing immediate followup trigger repaired'
          : 'kernel-driver missing immediate followup trigger repair failed',
      ).stack ?? null,
  };

  await fs.mkdir(debugDir, { recursive: true });
  const debugPath = path.join(debugDir, fileName);
  await fs.writeFile(debugPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return debugPath;
}

async function maybeWriteIdleWithActiveReplyObligationDebugDump(args: {
  dlg: Dialog;
  finalDisplayState: DialogDisplayState;
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
  activeReplyObligation: TellaskReplyDirective | undefined;
}): Promise<void> {
  if (args.finalDisplayState.kind !== 'idle_waiting_user') {
    return;
  }
  if (args.activeReplyObligation === undefined) {
    return;
  }

  const capturedAt = formatUnifiedTimestamp(new Date());
  const debugDir = path.resolve(domindsRtwsRootAbs(), '.dialogs', 'debug');
  const fileName = [
    'kernel-driver-idle-with-active-reply-obligation',
    sanitizeDebugFileSegment(capturedAt),
    sanitizeDebugFileSegment(args.dlg.id.rootId),
    sanitizeDebugFileSegment(args.dlg.id.selfId),
    sanitizeDebugFileSegment(args.activeReplyObligation.targetCallId),
    `${generateShortId()}.json`,
  ].join('-');
  const activeCallees = await DialogPersistence.loadActiveCallees(args.dlg.id, args.dlg.status);
  const suspension = await args.dlg.getSuspensionStatus();
  const payload = {
    kind: 'kernel_driver_idle_with_active_reply_obligation',
    capturedAt,
    rtwsRootAbs: domindsRtwsRootAbs(),
    dialog: {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      value: args.dlg.id.valueOf(),
      agentId: args.dlg.agentId,
      status: args.dlg.status,
      currentCourse: args.dlg.currentCourse,
      activeGenCourse: args.dlg.activeGenCourseOrUndefined ?? null,
      activeGenSeq: args.dlg.activeGenSeqOrUndefined ?? null,
      hasQueuedPrompt: args.dlg.hasQueuedPrompt(),
      queuedPrompt: args.dlg.peekQueuedPrompt() ?? null,
    },
    finalDisplayState: args.finalDisplayState,
    latest: args.latest,
    activeCallees,
    suspension,
    activeReplyObligation: args.activeReplyObligation,
    callstack: new Error('kernel-driver idle with active reply obligation').stack ?? null,
  };

  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(
    path.join(debugDir, fileName),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

function buildImmediateFollowupTriggerExpectation(args: {
  dlg: Dialog;
  routed: RoutedFunctionResult;
  invalidFuncCallCount: number;
  streamedFuncCalls: readonly FuncCallMsg[];
  continuation: DialogBusinessContinuation;
}): ImmediateFollowupTriggerExpectation | undefined {
  const reasons: DialogFollowupReason[] = [];
  if (args.routed.immediateFollowupCallIds.length > 0) {
    reasons.push({
      kind: 'ordinary_tool_result',
      callIds: args.routed.immediateFollowupCallIds,
    });
  }
  if (args.routed.immediateTellaskOutputCallIds.length > 0) {
    reasons.push({
      kind: 'reply_delivery_result',
      replyDeliveryId: `reply-delivery:${args.dlg.id.rootId}:${args.dlg.id.selfId}:${args.routed.immediateTellaskOutputCallIds.join('+')}`,
      replyCallId: args.routed.immediateTellaskOutputCallIds[0]!,
    });
  }
  const invalidRecoveryCallIds = new Set<string>(args.routed.invalidTellaskCallIds);
  if (args.invalidFuncCallCount > 0) {
    for (const call of args.streamedFuncCalls) {
      invalidRecoveryCallIds.add(call.id);
    }
    if (args.streamedFuncCalls.length === 0) {
      invalidRecoveryCallIds.add(`invalid-tool:${args.invalidFuncCallCount}`);
    }
  }
  if (invalidRecoveryCallIds.size > 0) {
    // Invalid provider tool payloads and invalid tellask specials are same-turn recovery facts,
    // not generic retry hints. Keep them inside the follow-up trigger so the next generation can
    // repair the current turn immediately, while the invalid payload itself stays loud.
    reasons.push({
      kind: 'invalid_tool_recovery',
      callIds: [...invalidRecoveryCallIds],
    });
  }
  if (args.routed.repeatedToolCallReminderCallIds.length > 0) {
    reasons.push({
      kind: 'repeated_tool_call_reminder',
      callIds: args.routed.repeatedToolCallReminderCallIds,
    });
  }
  if (reasons.length === 0) {
    return undefined;
  }
  const course = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  const genseq = args.dlg.activeGenSeq;
  const trigger: ImmediateFollowupTriggerDraft = {
    triggerId: `followup:c${String(course)}:g${String(genseq)}`,
    kind: 'followup',
    sourceGeneration: {
      course: toDialogCourseNumber(course),
      genseq: toCallSiteGenseqNo(genseq),
    },
    reasons,
    continuation: args.continuation,
  };
  return {
    trigger,
    callIds: args.streamedFuncCalls.map((call) => call.id),
    callNames: args.streamedFuncCalls.map((call) => call.name),
    routed: summarizeRoutedFunctionResult(args.routed),
    continuation: args.continuation,
    invalidFuncCallCount: args.invalidFuncCallCount,
  };
}

async function upsertImmediateFollowupTrigger(
  dlg: Dialog,
  expectation: ImmediateFollowupTriggerExpectation,
): Promise<void> {
  await DialogPersistence.upsertNextStepTrigger(dlg.id, expectation.trigger, dlg.status);
}

function hasExpectedImmediateFollowupTrigger(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
  expectation: ImmediateFollowupTriggerExpectation,
): boolean {
  return (
    latest?.nextStep.triggers.some(
      (trigger) =>
        trigger.kind === 'followup' && trigger.triggerId === expectation.trigger.triggerId,
    ) === true
  );
}

async function repairMissingImmediateFollowupTrigger(args: {
  dlg: Dialog;
  expectation: ImmediateFollowupTriggerExpectation | undefined;
  checkPoint: string;
}): Promise<void> {
  const expectation = args.expectation;
  if (expectation === undefined) {
    return;
  }
  const latestBeforeRepair = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  if (hasExpectedImmediateFollowupTrigger(latestBeforeRepair, expectation)) {
    return;
  }

  await DialogPersistence.upsertNextStepTrigger(args.dlg.id, expectation.trigger, args.dlg.status);
  const latestAfterRepair = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  const repairSucceeded = hasExpectedImmediateFollowupTrigger(latestAfterRepair, expectation);
  const repairOutcome: ImmediateFollowupTriggerRepairOutcome = repairSucceeded
    ? 'repaired'
    : 'repair_failed';
  const debugPath = await writeMissingImmediateFollowupTriggerDebugDump({
    dlg: args.dlg,
    expectation,
    latestBeforeRepair,
    latestAfterRepair,
    checkPoint: args.checkPoint,
    repairOutcome,
  });
  const message =
    `${repairSucceeded ? 'Repaired' : 'Failed to repair'} missing immediate follow-up trigger after function results ` +
    `(triggerId=${expectation.trigger.triggerId}, checkPoint=${args.checkPoint})`;
  log.error(
    message,
    new Error(`kernel_driver_missing_immediate_followup_trigger_${repairOutcome}`),
    {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      dialogId: args.dlg.id.valueOf(),
      status: args.dlg.status,
      triggerId: expectation.trigger.triggerId,
      checkPoint: args.checkPoint,
      repairSucceeded,
      sourceGeneration: expectation.trigger.sourceGeneration,
      reasonKinds: expectation.trigger.reasons.map((reason) => reason.kind),
      callIds: expectation.callIds,
      callNames: expectation.callNames,
      invalidFuncCallCount: expectation.invalidFuncCallCount,
      continuation: expectation.continuation,
      routed: expectation.routed,
      latestBeforeRepairNextStep: latestBeforeRepair?.nextStep ?? null,
      latestBeforeRepairGenerationRunState: latestBeforeRepair?.generationRunState ?? null,
      latestBeforeRepairDisplayState: latestBeforeRepair?.displayState ?? null,
      latestAfterRepairNextStep: latestAfterRepair?.nextStep ?? null,
      latestAfterRepairGenerationRunState: latestAfterRepair?.generationRunState ?? null,
      latestAfterRepairDisplayState: latestAfterRepair?.displayState ?? null,
      debugPath,
    },
  );
  await args.dlg.streamError(`${message}; debug=${debugPath}`);
  if (!repairSucceeded) {
    throw new Error(`${message}; debug=${debugPath}`);
  }
}

function shouldImmediatelyFollowUpSuccessfulToolResult(tool: FuncTool | undefined): boolean {
  return resolveFuncToolFollowupMode(tool) === 'immediate';
}

function shouldImmediatelyFollowUpToolOutcome(
  tool: FuncTool | undefined,
  outcome: ToolOutcome,
): boolean {
  if (outcome === 'failure' || outcome === 'partial_failure') {
    return true;
  }
  return shouldImmediatelyFollowUpSuccessfulToolResult(tool);
}

function isFailedToolOutcome(outcome: ToolOutcome): boolean {
  return outcome === 'failure' || outcome === 'partial_failure';
}

type FailedToolResultSummary = Readonly<{
  callId: string;
  toolName: string;
  outcome: ToolOutcome;
}>;

function formatClearMindBlockedByFailedSiblingTools(
  failedTools: readonly FailedToolResultSummary[],
): string {
  const language = getWorkLanguage();
  const details = failedTools
    .map((tool) => `- ${tool.toolName} (callId=${tool.callId}, outcome=${String(tool.outcome)})`)
    .join('\n');
  return language === 'zh'
    ? [
        '错误：本轮 clear_mind 与其它工具一起调用，但其它工具返回了失败结果。',
        '',
        details,
        '',
        'clear_mind 已拒绝开启新一程。请先确保其它工具调用正常完成（必要时修正参数、重试或处理失败），然后再次调用 clear_mind。',
      ].join('\n')
    : [
        'Error: clear_mind was called in the same round as other tools, and at least one other tool returned a failure result.',
        '',
        details,
        '',
        'clear_mind refused to start a new course. Ensure the other tool calls complete normally first (fix arguments, retry, or handle the failure), then call clear_mind again.',
      ].join('\n');
}

type ExecutedFuncCallResult = Readonly<{
  func: FuncCallMsg;
  originalFunc: FuncCallMsg;
  outcome: ToolOutcome;
  forceImmediateFollowup: boolean;
  result: FuncResultMsg;
}>;

type PreparedFuncCall = Readonly<{
  func: FuncCallMsg;
  callGenseq: number;
  argsStr: string;
  tool: FuncTool | undefined;
  preparedInvocationArgs: FuncToolInvocationResolution | null;
}>;

type FunctionCallIdReservation = {
  knownCallIds: Set<string>;
  seenRawIdsThisRound: Set<string>;
  nextDuplicateSuffixByRawId: Map<string, number>;
};

function trimOptionalCallId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function resolveRawCallId(call: FuncCallMsg): string {
  return trimOptionalCallId(call.rawId) ?? call.id;
}

function reserveKnownFunctionCallId(
  reservation: FunctionCallIdReservation,
  callId: string | undefined,
): void {
  const normalized = trimOptionalCallId(callId);
  if (normalized !== undefined) {
    reservation.knownCallIds.add(normalized);
  }
}

async function collectKnownFunctionCallIdsForCurrentCourse(
  dialog: Dialog,
): Promise<ReadonlySet<string>> {
  const known = new Set<string>();
  const addKnown = (callId: string | undefined): void => {
    const normalized = trimOptionalCallId(callId);
    if (normalized !== undefined) {
      known.add(normalized);
    }
  };
  const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
  for (const msg of dialog.msgs) {
    if (msg.type !== 'func_call_msg') {
      continue;
    }
    if (msg.genseq <= 0) {
      throw new Error(
        `kernel-driver function call id invariant violation: invalid func_call_msg genseq ` +
          `(rootId=${dialog.id.rootId}, selfId=${dialog.id.selfId}, course=${course}, callId=${msg.id})`,
      );
    }
    addKnown(msg.id);
    addKnown(msg.rawId);
    addKnown(msg.effectiveId);
  }
  const persistedEvents = await DialogPersistence.loadCourseEvents(
    dialog.id,
    course,
    dialog.status,
  );
  for (const event of persistedEvents) {
    switch (event.type) {
      case 'func_call_record': {
        addKnown(event.id);
        addKnown(event.rawId);
        addKnown(event.effectiveId);
        break;
      }
      case 'func_result_record': {
        addKnown(event.id);
        addKnown(event.rawId);
        addKnown(event.effectiveId);
        break;
      }
      case 'tellask_call_record': {
        addKnown(event.id);
        break;
      }
      default:
        break;
    }
  }
  return known;
}

function allocateDuplicateEffectiveCallId(args: {
  reservation: FunctionCallIdReservation;
  rawCallId: string;
  course: number;
  genseq: number;
}): string {
  const base = args.rawCallId.trim();
  if (base === '') {
    throw new Error('kernel-driver function call id invariant violation: empty raw callId');
  }
  let suffix = args.reservation.nextDuplicateSuffixByRawId.get(base) ?? 2;
  for (;;) {
    const candidate = `${base}__dominds_c${String(args.course)}_g${String(args.genseq)}_${String(suffix)}`;
    suffix += 1;
    if (!args.reservation.knownCallIds.has(candidate)) {
      args.reservation.nextDuplicateSuffixByRawId.set(base, suffix);
      return candidate;
    }
  }
}

function allocateEffectiveFunctionCallId(args: {
  reservation: FunctionCallIdReservation;
  rawCallId: string;
  course: number;
  genseq: number;
}): { effectiveCallId: string; duplicateRawCallId: boolean } {
  const rawCallId = args.rawCallId.trim();
  if (rawCallId === '') {
    throw new Error('kernel-driver function call id invariant violation: empty raw callId');
  }
  const duplicateRawCallId =
    args.reservation.knownCallIds.has(rawCallId) ||
    args.reservation.seenRawIdsThisRound.has(rawCallId);
  if (!duplicateRawCallId) {
    args.reservation.knownCallIds.add(rawCallId);
    args.reservation.seenRawIdsThisRound.add(rawCallId);
    return { effectiveCallId: rawCallId, duplicateRawCallId: false };
  }

  const effectiveCallId = allocateDuplicateEffectiveCallId({
    reservation: args.reservation,
    rawCallId,
    course: args.course,
    genseq: args.genseq,
  });
  args.reservation.knownCallIds.add(effectiveCallId);
  args.reservation.seenRawIdsThisRound.add(rawCallId);
  log.warn('Mapped duplicate raw function call id to unique effective id', undefined, {
    course: args.course,
    genseq: args.genseq,
    rawCallId,
    effectiveCallId,
  });
  return { effectiveCallId, duplicateRawCallId: true };
}

async function normalizeGeneratedFunctionCallIds(args: {
  calls: readonly FuncCallMsg[];
  dialog: Dialog;
}): Promise<FuncCallMsg[]> {
  const reservation: FunctionCallIdReservation = {
    knownCallIds: new Set(await collectKnownFunctionCallIdsForCurrentCourse(args.dialog)),
    seenRawIdsThisRound: new Set<string>(),
    nextDuplicateSuffixByRawId: new Map<string, number>(),
  };
  for (const call of args.calls) {
    if (isTellaskCallFunctionName(call.name)) {
      reserveKnownFunctionCallId(reservation, call.id);
      reserveKnownFunctionCallId(reservation, call.rawId);
    }
  }
  return args.calls.map((call) => {
    const rawCallId = resolveRawCallId(call);
    if (isTellaskCallFunctionName(call.name)) {
      if (rawCallId.trim() !== '') {
        reservation.seenRawIdsThisRound.add(rawCallId);
      }
      return {
        ...call,
        rawId: rawCallId,
        effectiveId: call.id,
      };
    }
    const effectiveCallId =
      rawCallId.trim() === ''
        ? call.id
        : allocateEffectiveFunctionCallId({
            reservation,
            rawCallId,
            course: args.dialog.activeGenCourseOrUndefined ?? args.dialog.currentCourse,
            genseq: call.genseq,
          }).effectiveCallId;
    return {
      ...call,
      id: effectiveCallId,
      rawId: rawCallId,
      effectiveId: effectiveCallId,
    };
  });
}

async function executeFunctionCalls(args: {
  dlg: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  abortSignal: AbortSignal | undefined;
  contextHealthForToolResultVisibility: ContextHealthSnapshot | undefined;
  failedPriorToolResults?: readonly FailedToolResultSummary[];
}): Promise<ExecutedFuncCallResult[]> {
  const preparedCalls: Array<PreparedFuncCall & { originalFunc: FuncCallMsg }> = args.funcCalls.map(
    (func) => {
      throwIfAborted(args.abortSignal, args.dlg);

      const callGenseq = func.genseq;
      const argsStr =
        typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments ?? {});
      const rawCallId = resolveRawCallId(func);
      const effectiveCallId = func.id;
      const normalizedFunc: FuncCallMsg = {
        ...func,
        id: effectiveCallId,
        rawId: rawCallId,
        effectiveId: effectiveCallId,
      };
      const tool = args.agentTools.find(
        (t): t is FuncTool => t.type === 'func' && t.name === func.name,
      );
      const preparedInvocationArgs =
        tool !== undefined ? resolveFuncToolInvocationArguments(tool, argsStr) : null;
      return {
        func: normalizedFunc,
        originalFunc: func,
        callGenseq,
        argsStr,
        tool,
        preparedInvocationArgs,
      };
    },
  );

  for (const prepared of preparedCalls) {
    throwIfAborted(args.abortSignal, args.dlg);
    await args.dlg.persistFunctionCall(
      prepared.func.id,
      prepared.func.name,
      prepared.argsStr,
      prepared.callGenseq,
      prepared.func.rawId,
    );
  }

  const executePreparedCall = async ({
    func,
    originalFunc,
    callGenseq,
    argsStr,
    tool,
    preparedInvocationArgs,
  }: PreparedFuncCall & { originalFunc: FuncCallMsg }): Promise<ExecutedFuncCallResult> => {
    let result: FuncResultMsg;
    let outcome: ToolOutcome = 'success';
    let forceImmediateFollowup = false;
    let rethrowError: unknown;
    if (!tool) {
      outcome = 'failure';
      const output = toolFailure(`Tool '${func.name}' not found`);
      result = {
        type: 'func_result_msg',
        id: func.id,
        rawId: func.rawId,
        effectiveId: func.effectiveId,
        name: func.name,
        content: output.content,
        role: 'tool',
        genseq: callGenseq,
      };
    } else {
      if (!preparedInvocationArgs || !preparedInvocationArgs.ok) {
        outcome = 'failure';
        const errorText =
          preparedInvocationArgs?.error ?? 'Arguments could not be prepared for tool invocation';
        log.debug('kernel-driver rejected function call arguments before execution', undefined, {
          funcName: func.name,
          arguments: argsStr,
          error: errorText,
        });
        result = {
          type: 'func_result_msg',
          id: func.id,
          rawId: func.rawId,
          effectiveId: func.effectiveId,
          name: func.name,
          content: toolFailure(`Invalid arguments: ${errorText}`).content,
          role: 'tool',
          genseq: callGenseq,
        };
      } else {
        try {
          throwIfAborted(args.abortSignal, args.dlg);
          const output: ToolCallOutput = await tool.call(
            args.dlg,
            args.agent,
            preparedInvocationArgs.args,
          );
          throwIfAborted(args.abortSignal, args.dlg);
          const visibleResult = applyContextHealthToolResultVisibilityLimit({
            dlg: args.dlg,
            output,
            contextHealth: args.contextHealthForToolResultVisibility,
            language: getWorkLanguage(),
          });
          const visibleOutput = visibleResult.output;
          forceImmediateFollowup = visibleResult.largeReturnUnavailable;
          outcome = visibleOutput.outcome;
          result = {
            type: 'func_result_msg',
            id: func.id,
            rawId: func.rawId,
            effectiveId: func.effectiveId,
            name: func.name,
            content: visibleOutput.content,
            contentItems: Array.isArray(visibleOutput.contentItems)
              ? [...visibleOutput.contentItems]
              : undefined,
            role: 'tool',
            genseq: callGenseq,
          };
        } catch (err) {
          outcome = 'failure';
          const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const failureOutput = toolFailure(`Function '${func.name}' execution failed: ${errText}`);
          result = {
            type: 'func_result_msg',
            id: func.id,
            rawId: func.rawId,
            effectiveId: func.effectiveId,
            name: func.name,
            content: failureOutput.content,
            role: 'tool',
            genseq: callGenseq,
          };
          if (args.abortSignal?.aborted || err instanceof KernelDriverInterruptedError) {
            result = buildInterruptedFuncResult({ func, callGenseq, err });
            rethrowError = err;
          }
        }
      }
    }

    await args.dlg.receiveFuncResult(result);
    if (rethrowError !== undefined) {
      throw rethrowError;
    }
    return { func, originalFunc, outcome, forceImmediateFollowup, result };
  };

  const blockClearMindCall = async (
    prepared: PreparedFuncCall & { originalFunc: FuncCallMsg },
    failedTools: readonly FailedToolResultSummary[],
  ): Promise<ExecutedFuncCallResult> => {
    const output = toolFailure(formatClearMindBlockedByFailedSiblingTools(failedTools));
    const result: FuncResultMsg = {
      type: 'func_result_msg',
      id: prepared.func.id,
      rawId: prepared.func.rawId,
      effectiveId: prepared.func.effectiveId,
      name: prepared.func.name,
      content: output.content,
      role: 'tool',
      genseq: prepared.callGenseq,
    };
    await args.dlg.receiveFuncResult(result);
    return {
      func: prepared.func,
      originalFunc: prepared.originalFunc,
      outcome: output.outcome,
      forceImmediateFollowup: false,
      result,
    };
  };

  const clearMindCalls = preparedCalls.filter((call) => call.func.name === CLEAR_MIND_TOOL_NAME);
  const siblingCalls = preparedCalls.filter((call) => call.func.name !== CLEAR_MIND_TOOL_NAME);
  const failedPriorToolResults = args.failedPriorToolResults ?? [];
  if (clearMindCalls.length === 0 || siblingCalls.length === 0) {
    if (clearMindCalls.length > 0 && failedPriorToolResults.length > 0) {
      return await Promise.all(
        clearMindCalls.map((call) => blockClearMindCall(call, failedPriorToolResults)),
      );
    }
    return await Promise.all(preparedCalls.map((call) => executePreparedCall(call)));
  }

  const siblingExecutions = await Promise.all(
    siblingCalls.map((call) => executePreparedCall(call)),
  );
  const failedSiblingToolResults: FailedToolResultSummary[] = [
    ...failedPriorToolResults,
    ...siblingExecutions
      .filter((execution) => isFailedToolOutcome(execution.outcome))
      .map((execution) => ({
        callId: execution.result.id,
        toolName: execution.result.name,
        outcome: execution.outcome,
      })),
  ];
  if (failedSiblingToolResults.length > 0) {
    const clearMindExecutions = await Promise.all(
      clearMindCalls.map((call) => blockClearMindCall(call, failedSiblingToolResults)),
    );
    return [...siblingExecutions, ...clearMindExecutions];
  }

  const clearMindExecutions = await Promise.all(
    clearMindCalls.map((call) => executePreparedCall(call)),
  );
  return [...siblingExecutions, ...clearMindExecutions];
}

async function executeFunctionRound(args: {
  dlg: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  callbacks: KernelDriverDriveCallbacks;
  abortSignal: AbortSignal | undefined;
  allowTellaskFunctions: boolean;
  activePromptReplyDirective?: KernelDriverPrompt['tellaskReplyDirective'];
  contextHealthForToolResultVisibility: ContextHealthSnapshot | undefined;
}): Promise<RoutedFunctionResult> {
  if (args.funcCalls.length === 0) {
    return {
      hasImmediateFollowupToolCalls: false,
      hasImmediateTellaskOutputs: false,
      immediateFollowupCallIds: [],
      immediateTellaskOutputCallIds: [],
      invalidTellaskCallIds: [],
      repeatedToolCallReminderCallIds: [],
      shouldStopAfterReplyTool: false,
      shouldStopAfterPendingTellaskWait: false,
      pairedMessages: [],
      tellaskToolOutputs: [],
      answerHumanOutputs: [],
    };
  }
  throwIfAborted(args.abortSignal, args.dlg);

  const executableCalls = [...args.funcCalls];

  const allowTellaskBack = args.allowTellaskFunctions && args.dlg.id.rootId !== args.dlg.id.selfId;
  const allowedSpecials = args.allowTellaskFunctions
    ? new Set<TellaskCallFunctionName>([
        'tellask',
        'tellaskSessionless',
        'replyTellask',
        'replyTellaskSessionless',
        'replyTellaskBack',
        'askHuman',
        'answerHuman',
        'freshBootsReasoning',
        ...(allowTellaskBack ? (['tellaskBack'] as const) : []),
      ])
    : new Set<TellaskCallFunctionName>();
  throwIfAborted(args.abortSignal, args.dlg);
  const tellaskRound = await processTellaskFunctionRound({
    dlg: args.dlg,
    funcCalls: executableCalls,
    allowedSpecials,
    callbacks: args.callbacks,
    activePromptReplyDirective: args.activePromptReplyDirective,
  });
  throwIfAborted(args.abortSignal, args.dlg);
  const failedTellaskToolResults = tellaskRound.invalidTellaskCallIds.map((callId) => {
    const call = args.funcCalls.find((candidate) => candidate.id === callId);
    if (call === undefined) {
      throw new Error(
        `kernel-driver tellask result invariant violation: missing invalid tellask call '${callId}'`,
      );
    }
    return {
      callId,
      toolName: call.name,
      outcome: 'failure' as const,
    };
  });

  const genericExecutions = await executeFunctionCalls({
    dlg: args.dlg,
    agent: args.agent,
    agentTools: args.agentTools,
    funcCalls: tellaskRound.normalCalls,
    abortSignal: args.abortSignal,
    contextHealthForToolResultVisibility: args.contextHealthForToolResultVisibility,
    failedPriorToolResults: failedTellaskToolResults,
  });
  const genericExecutionByOriginalCall = new Map(
    genericExecutions.map((execution) => [execution.originalFunc, execution] as const),
  );
  const funcToolByName = new Map(
    args.agentTools
      .filter((tool): tool is FuncTool => tool.type === 'func')
      .map((tool) => [tool.name, tool] as const),
  );
  const genericOutcomeByCallId = new Map(
    genericExecutions.map((execution) => [execution.result.id, execution.outcome] as const),
  );
  const forceImmediateFollowupCallIds = new Set(
    genericExecutions
      .filter((execution) => execution.forceImmediateFollowup)
      .map((execution) => execution.result.id),
  );
  const immediateFollowupCallIds: string[] = [];
  for (const call of tellaskRound.normalCalls) {
    const tool = funcToolByName.get(call.name);
    const outcome = genericOutcomeByCallId.get(call.id);
    if (outcome === undefined) {
      throw new Error(
        `kernel-driver function outcome invariant violation: missing outcome for call id '${call.id}' (${call.name})`,
      );
    }
    if (
      forceImmediateFollowupCallIds.has(call.id) ||
      shouldImmediatelyFollowUpToolOutcome(tool, outcome)
    ) {
      immediateFollowupCallIds.push(call.id);
    }
  }
  const hasImmediateFollowupToolCalls = immediateFollowupCallIds.length > 0;

  const resultByCallId = new Map<string, FuncResultMsg>();
  const register = (result: FuncResultMsg): void => {
    const existing = resultByCallId.get(result.id);
    if (existing) {
      throw new Error(
        `kernel-driver function result invariant violation: duplicate call id '${result.id}'`,
      );
    }
    resultByCallId.set(result.id, result);
  };
  for (const result of tellaskRound.tellaskResults) {
    register(result);
  }
  for (const execution of genericExecutions) {
    register(execution.result);
  }

  const pairedMessages: ChatMessage[] = [];
  const tellaskCallMsgById = new Map(
    tellaskRound.tellaskCallMessages.map((msg) => [msg.id, msg] as const),
  );
  const specialCallIds = new Set(tellaskRound.handledCallIds);
  for (let callIndex = 0; callIndex < args.funcCalls.length; callIndex += 1) {
    const originalCall = args.funcCalls[callIndex];
    if (!originalCall) {
      throw new Error(`kernel-driver function call invariant violation: missing call ${callIndex}`);
    }
    const execution = genericExecutionByOriginalCall.get(originalCall);
    const call = execution?.func ?? originalCall;
    const tellaskCallMsg = tellaskCallMsgById.get(call.id);
    if (tellaskCallMsg) {
      pairedMessages.push(tellaskCallMsg);
    } else {
      const originalArgsStr =
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
      pairedMessages.push({
        type: 'func_call_msg',
        role: 'assistant',
        genseq: call.genseq,
        id: call.id,
        ...(call.rawId !== undefined ? { rawId: call.rawId } : {}),
        ...(call.effectiveId !== undefined ? { effectiveId: call.effectiveId } : {}),
        name: call.name,
        arguments: originalArgsStr,
      });
    }
    const result = resultByCallId.get(call.id);
    if (result) {
      pairedMessages.push(result);
      continue;
    }
    if (specialCallIds.has(call.id)) {
      throw new Error(
        `kernel-driver tellask result invariant violation: missing tellask result for call id '${call.id}' (${call.name})`,
      );
    }
    throw new Error(
      `kernel-driver function result invariant violation: missing result for call id '${call.id}' (${call.name})`,
    );
  }

  return {
    hasImmediateFollowupToolCalls:
      hasImmediateFollowupToolCalls || tellaskRound.hasInvalidTellaskCalls,
    hasImmediateTellaskOutputs: tellaskRound.hasImmediateTellaskOutputs,
    immediateFollowupCallIds,
    immediateTellaskOutputCallIds: tellaskRound.immediateTellaskOutputCallIds,
    invalidTellaskCallIds: tellaskRound.invalidTellaskCallIds,
    repeatedToolCallReminderCallIds: [],
    shouldStopAfterReplyTool: tellaskRound.shouldStopAfterReplyTool,
    shouldStopAfterPendingTellaskWait: tellaskRound.shouldStopAfterPendingTellaskWait,
    pairedMessages,
    tellaskToolOutputs: [...tellaskRound.toolOutputs],
    answerHumanOutputs: tellaskRound.answerHumanOutputs,
  };
}

async function preserveDiligenceBudgetAcrossQ4H(dlg: Dialog): Promise<void> {
  try {
    if (!(await dlg.hasPendingQ4H())) {
      return;
    }
    // Q4H is a suspension boundary, not a reason to reapply member defaults. Keep the dialog's
    // own remaining budget as the source of truth so operator-adjusted budgets survive Q4H.
    dlg.diligencePushRemainingBudget = Math.max(0, Math.floor(dlg.diligencePushRemainingBudget));
    void DialogPersistence.mutateDialogLatest(
      dlg.id,
      () => ({
        kind: 'patch',
        patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
      }),
      dlg.status,
    );
  } catch (err) {
    log.error('kernel-driver failed to preserve Diligence Push budget after Q4H', err, {
      dialogId: dlg.id.valueOf(),
    });
    throw err;
  }
}

async function maybeContinueWithDiligencePrompt(args: {
  dlg: Dialog;
  team: Team;
  suppressDiligencePushForDrive: boolean;
  ignoreBudgetExhaustion?: boolean;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: KernelDriverPrompt }> {
  const { dlg, team, suppressDiligencePushForDrive, ignoreBudgetExhaustion } = args;

  const gate = await evaluateDiligenceAutoContinueGate({
    dlg,
    requireIdleRunSlot: false,
  });
  if (gate.kind === 'blocked') {
    if (gate.reason === 'q4h' && dlg instanceof MainDialog) {
      await preserveDiligenceBudgetAcrossQ4H(dlg);
    }
    return { kind: 'break' };
  }

  const prepared = await maybePrepareDiligenceAutoContinuePrompt({
    dlg,
    remainingBudget: dlg.diligencePushRemainingBudget,
    diligencePushMax: resolveMemberDiligencePushMax(team, dlg.agentId),
    suppressDiligencePush: suppressDiligencePushForDrive,
    ignoreBudgetExhaustion,
  });

  if (dlg instanceof MainDialog) {
    dlg.diligencePushRemainingBudget = prepared.nextRemainingBudget;
    void DialogPersistence.mutateDialogLatest(
      dlg.id,
      () => ({
        kind: 'patch',
        patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
      }),
      dlg.status,
    );
  }

  if (dlg instanceof MainDialog && prepared.kind !== 'disabled') {
    emitDiligenceBudgetEvent(dlg, {
      maxInjectCount: prepared.maxInjectCount,
      nextRemainingBudget: prepared.nextRemainingBudget,
    });
  }

  if (prepared.kind === 'budget_exhausted') {
    if (!(dlg instanceof MainDialog)) {
      throw new Error(
        `kernel-driver Diligence Push invariant violation: non-main dialog returned budget_exhausted (${dlg.id.valueOf()})`,
      );
    }
    await suspendForKeepGoingBudgetExhausted({
      dlg,
      maxInjectCount: prepared.maxInjectCount,
    });
    dlg.diligencePushRemainingBudget = 0;
    return { kind: 'break' };
  }

  if (prepared.kind === 'prompt') {
    const activeCallees =
      dlg instanceof MainDialog
        ? await DialogPersistence.loadActiveCallees(dlg.id, dlg.status)
        : { batches: [] };
    const pendingTellaskCount = activeCallees.batches.reduce(
      (count, batch) =>
        count + batch.callees.filter((callee) => callee.status === 'pending').length,
      0,
    );
    await DialogPersistence.upsertNextStepTrigger(dlg.id, {
      triggerId: `mainline-diligence:${prepared.prompt.msgId}`,
      kind: 'mainline_diligence',
      diligenceId: prepared.prompt.msgId,
      pendingTellaskCount,
    });
    return { kind: 'continue', prompt: prepared.prompt };
  }

  return { kind: 'break' };
}

async function shouldSkipDiligencePromptBeforeGeneration(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt;
  suppressDiligencePushForDrive: boolean;
}): Promise<string | undefined> {
  if (args.prompt.origin !== 'diligence_push') {
    return undefined;
  }
  if (args.dlg.disableDiligencePush) {
    return 'disabled_on_dialog';
  }
  if (args.suppressDiligencePushForDrive) {
    return 'suppressed_for_drive';
  }
  const gate = await evaluateDiligenceAutoContinueGate({
    dlg: args.dlg,
    requireIdleRunSlot: false,
  });
  return gate.kind === 'blocked' ? gate.reason : undefined;
}

async function maybePrepareRetryStoppedRecoveryPrompt(args: {
  dlg: Dialog;
  team: Team;
  suppressDiligencePushForDrive: boolean;
  reason: DialogLlmRetryExhaustedReason;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: KernelDriverPrompt }> {
  if (args.reason.recoveryAction.kind === 'runtime_prompt_once') {
    const language = args.dlg.getLastUserLanguageCode();
    return {
      kind: 'continue',
      prompt: {
        content: args.reason.recoveryAction.content,
        msgId: generateShortId(),
        grammar: 'markdown',
        origin: 'runtime',
        userLanguageCode: language,
      },
    };
  }
  if (args.reason.recoveryAction.kind !== 'diligence_push_once') {
    return { kind: 'break' };
  }
  return await maybeContinueWithDiligencePrompt({
    dlg: args.dlg,
    team: args.team,
    suppressDiligencePushForDrive: args.suppressDiligencePushForDrive,
    ignoreBudgetExhaustion: true,
  });
}

async function maybeContinueWithHealthPromptBeforeDiligence(args: {
  dlg: Dialog;
  providerCfg: ProviderConfig;
  model: string;
}): Promise<
  | { kind: 'no_health_prompt' }
  | { kind: 'health_continue'; prompt: KernelDriverPrompt; resetTaskdoc: boolean }
> {
  const { dlg, providerCfg, model } = args;

  // This path is only used as a higher-priority alternative to Diligence Push.
  if (!(dlg instanceof MainDialog)) {
    return { kind: 'no_health_prompt' };
  }

  const snapshot = dlg.getLastContextHealth();
  const modelInfoForRemediation = resolveModelInfo(providerCfg, model);
  const cautionRemediationCadenceGenerations = resolveCautionRemediationCadenceGenerations(
    modelInfoForRemediation?.caution_remediation_cadence_generations,
  );
  const criticalCountdownRemaining = resolveCriticalCountdownRemaining(dlg.id.key(), snapshot);
  const healthDecision = decideKernelDriverContextHealth({
    dialogKey: dlg.id.key(),
    snapshot,
    hadUserPromptThisGen: false,
    canInjectPromptThisGen: true,
    cautionRemediationCadenceGenerations,
    criticalCountdownRemaining,
  });

  if (healthDecision.kind !== 'continue') {
    return { kind: 'no_health_prompt' };
  }

  if (healthDecision.reason === 'critical_force_new_course') {
    const language = getWorkLanguage();
    const newCoursePrompt = formatNewCourseStartPrompt(language, {
      nextCourse: dlg.currentCourse + 1,
      source: 'critical_auto_clear',
    });
    const normalizedNewCoursePrompt = await dlg.startNewCourse(newCoursePrompt);
    dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
    resetContextHealthRoundState(dlg.id.key());
    return {
      kind: 'health_continue',
      prompt: normalizedNewCoursePrompt,
      resetTaskdoc: true,
    };
  }

  const language = getWorkLanguage();
  const dialogScope = dlg instanceof SideDialog ? 'sideDialog' : 'mainDialog';
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
          promptsRemainingAfterThis: consumeCriticalCountdown(dlg.id.key()),
          promptsTotal: KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
        });
  return {
    kind: 'health_continue',
    prompt: {
      content: guideText,
      msgId: generateShortId(),
      grammar: 'markdown',
      origin: 'runtime',
      userLanguageCode: language,
    },
    resetTaskdoc: false,
  };
}

export async function driveDialogStreamCore(
  dlg: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  humanPrompt?: KernelDriverDriveArgs[1],
  driveOptions?: KernelDriverDriveArgs[3],
): Promise<KernelDriverCoreResult> {
  // `suppressDiligencePush` is queued together with a drive request to reflect the dialog's
  // disable state at scheduling time. If the operator re-enables Diligence Push while that run is
  // already in flight, the live dialog toggle must win so late-stage stop decisions can still
  // inject one prompt in the same run.
  const suppressDiligencePushForDrive =
    driveOptions?.suppressDiligencePush === true && dlg.disableDiligencePush;
  const abortSignal = getActiveRunSignal(dlg.id) ?? createActiveRun(dlg.id);

  let finalDisplayState: DialogDisplayState | undefined;
  let lastAssistantSayingContent: string | null = null;
  let lastAssistantSayingGenseq: number | null = null;
  let lastAssistantThinkingContent: string | null = null;
  let lastAssistantThinkingGenseq: number | null = null;
  let lastAssistantAnsweringContent: string | null = null;
  let lastAssistantAnsweringGenseq: number | null = null;
  let lastFunctionCallGenseq: number | null = null;
  let lastAssistantReplyTarget: KernelDriverPrompt['calleeDialogReplyTarget'] | undefined;
  let lastBusinessContinuation: DialogBusinessContinuation = { kind: 'none' };
  let currentPromptIsUserInterjection = false;
  let currentUserInterjectionReply: DialogPendingUserInterjectionReply | undefined;
  let fbrConclusion:
    | {
        responseText: string;
        responseGenseq: number;
        replyResolutionCallId: string;
      }
    | undefined;
  let pubRemindersVer = dlg.remindersVer;
  let lastToolRoundStopDiagnostics: ToolRoundStopDiagnostics | undefined;
  const repeatedToolCallMonitor: RepeatedToolCallMonitorState = {};

  let pendingPrompt: KernelDriverPrompt | undefined = humanPrompt;
  let resolvingImmediateToolResultForUserPrompt = false;
  let resolvingImmediateToolResultUserPromptMsgId: string | undefined;
  let criticalRemediationAppliedUserPromptMsgId =
    humanPrompt?.origin === 'user' &&
    isAgentFacingCriticalUserInterjectionRemediationGuideContent(humanPrompt.content)
      ? humanPrompt.msgId
      : undefined;
  let retryStoppedRecoveryPrompt: KernelDriverPrompt | undefined;
  let skipTaskdocForThisDrive = humanPrompt?.skipTaskdoc === true;
  let genIterNo = 0;
  // Quirk retry state intentionally spans multiple request invocations in the same driver run,
  // including course changes. Provider/API retry heuristics are tracked independently from
  // user-facing course boundaries.
  const retryQuirkSessionByProviderModel = new Map<string, LlmFailureQuirkHandlerSession>();

  if (!humanPrompt) {
    try {
      const executionMarker = await loadDialogExecutionMarker(dlg.id, 'running');
      if (executionMarker?.kind === 'interrupted') {
        broadcastDisplayStateMarker(dlg.id, { kind: 'resumed' });
      }
    } catch (err) {
      log.warn('kernel-driver failed to load latest.yaml for resumption marker', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
  }

  await clearDialogInterruptedExecutionMarker(dlg.id);
  await setDialogDisplayState(dlg.id, { kind: 'proceeding' });

  driveCoreLoop: for (;;) {
    try {
      for (;;) {
        genIterNo += 1;
        throwIfAborted(abortSignal, dlg);

        let activeFbrState = await loadDialogFbrState(dlg);
        if (isFbrSideDialog(dlg)) {
          const fbrContextHealthLevel = getContextHealthRemediationLevel(
            dlg.getLastContextHealth(),
          );
          if (activeFbrState !== undefined && fbrContextHealthLevel === 'critical') {
            log.warn('kernel-driver ending FBR with critical context fixed conclusion', undefined, {
              rootId: dlg.id.rootId,
              selfId: dlg.id.selfId,
              course: dlg.currentCourse,
              phase: activeFbrState.phase,
              iteration: activeFbrState.iteration,
            });
            fbrConclusion = {
              responseText: buildProgrammaticFbrContextCriticalContent({
                language: getWorkLanguage(),
              }),
              responseGenseq: resolveProgrammaticFbrConclusionGenseq({
                dlg,
                lastAssistantSayingGenseq,
                lastFunctionCallGenseq,
              }),
              replyResolutionCallId: `fbr-context-critical-${generateShortId()}`,
            };
            await persistDialogFbrState(dlg, undefined);
            dlg.setFbrConclusionToolsEnabled(false);
            finalDisplayState = await computeIdleDisplayState(dlg);
            break driveCoreLoop;
          }
          if (
            activeFbrState !== undefined &&
            fbrContextHealthLevel === 'caution' &&
            !isFbrContextCautionFinalizationState(activeFbrState) &&
            (pendingPrompt === undefined || pendingPrompt.origin === 'runtime')
          ) {
            activeFbrState = forceFbrContextCautionFinalizationState(activeFbrState);
            await persistDialogFbrState(dlg, activeFbrState);
            pendingPrompt = buildKernelDriverFbrPrompt(dlg, activeFbrState);
          }
          dlg.setFbrConclusionToolsEnabled(
            activeFbrState !== undefined && isFbrFinalizationState(activeFbrState),
          );
          if (
            pendingPrompt === undefined &&
            activeFbrState &&
            activeFbrState.promptDelivered !== true
          ) {
            pendingPrompt = buildKernelDriverFbrPrompt(dlg, activeFbrState);
          }
        }

        const minds = await loadAgentMinds(dlg.agentId, dlg);
        const team = minds.team;
        const policy = buildKernelDriverPolicy({
          dlg,
          agent: minds.agent,
          systemPrompt: minds.systemPrompt,
          agentTools: minds.agentTools,
          language: getWorkLanguage(),
        });
        const policyValidation = validateKernelDriverPolicyInvariants(policy, getWorkLanguage());
        if (!policyValidation.ok) {
          throw new Error(`kernel-driver policy invariant violation: ${policyValidation.detail}`);
        }

        const agent = policy.effectiveAgent;
        const systemPrompt = policy.effectiveSystemPrompt;
        const agentTools: readonly Tool[] = policy.effectiveAgentTools;
        const prepareRetryStoppedRecovery = async (
          reason: DialogLlmRetryExhaustedReason,
        ): Promise<'continue' | 'stop'> => {
          retryStoppedRecoveryPrompt = undefined;
          const recovery = await maybePrepareRetryStoppedRecoveryPrompt({
            dlg,
            team,
            suppressDiligencePushForDrive,
            reason,
          });
          if (recovery.kind !== 'continue') {
            return 'stop';
          }
          retryStoppedRecoveryPrompt = recovery.prompt;
          return 'continue';
        };

        const provider = agent.provider ?? team.memberDefaults.provider;
        const model = agent.model ?? team.memberDefaults.model;
        if (!provider) {
          throw new Error(
            `Configuration Error: No provider configured for agent '${dlg.agentId}'. Please specify a provider in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
          );
        }
        if (!model) {
          throw new Error(
            `Configuration Error: No model configured for agent '${dlg.agentId}'. Please specify a model in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
          );
        }

        const llmCfg = await LlmConfig.load();
        const providerCfg = llmCfg.getProvider(provider);
        if (!providerCfg) {
          throw new Error(
            `Provider configuration error: Provider '${provider}' not found for agent '${dlg.agentId}'. Please check .minds/llm.yaml and .minds/team.yaml configuration.`,
          );
        }
        if (!providerCfg.models || !providerCfg.models[model]) {
          throw new Error(
            `Configuration error: invalid model '${model}' for provider '${provider}' (agent='${dlg.agentId}').`,
          );
        }

        const llmGen = getLlmGenerator(providerCfg.apiType);
        if (!llmGen) {
          throw new Error(
            `LLM generator not found: API type '${providerCfg.apiType}' for provider '${provider}' in agent '${dlg.agentId}'. Please check .minds/llm.yaml configuration.`,
          );
        }
        const resolveRetryQuirkSession = (): LlmFailureQuirkHandlerSession | undefined => {
          const key = `${provider}::${model}`;
          const existing = retryQuirkSessionByProviderModel.get(key);
          if (existing) {
            return existing;
          }
          const created = createLlmFailureQuirkHandlerSession(providerCfg);
          if (!created) {
            return undefined;
          }
          retryQuirkSessionByProviderModel.set(key, created);
          return created;
        };
        const retryPolicy = resolveKernelDriverRetryPolicy(providerCfg);

        const canonicalFuncTools: FuncTool[] = agentTools.filter(
          (t): t is FuncTool => t.type === 'func',
        );
        const isSideDialog = dlg.id.rootId !== dlg.id.selfId;
        const fbrEffortDefault = resolveFbrEffortDefaultForTool(agent);
        const effectiveFuncTools: FuncTool[] =
          policy.mode === 'default'
            ? mergeTellaskVirtualTools(canonicalFuncTools, {
                includeTellaskBack: isSideDialog,
                fbrEffortDefault,
              })
            : canonicalFuncTools;
        const projected = projectFuncToolsForProvider(providerCfg.apiType, effectiveFuncTools);
        const funcTools = projected.tools;

        const currentPendingPrompt = pendingPrompt;
        let currentGenerationBelongsToUserPrompt = isUserOriginPrompt(currentPendingPrompt);
        let currentGenerationBelongsToUserToolChain = false;
        let currentUserPromptMsgId = getUserOriginPromptMsgId(currentPendingPrompt);
        if (genIterNo > 1) {
          currentGenerationBelongsToUserToolChain = resolvingImmediateToolResultForUserPrompt;
          if (currentUserPromptMsgId === undefined) {
            currentUserPromptMsgId = resolvingImmediateToolResultUserPromptMsgId;
          }
          resolvingImmediateToolResultForUserPrompt = false;
          resolvingImmediateToolResultUserPromptMsgId = undefined;
          const snapshot = dlg.getLastContextHealth();
          const hasQueuedPrompt = dlg.hasQueuedPrompt() || pendingPrompt !== undefined;
          const modelInfoForRemediation = resolveModelInfo(providerCfg, model);
          const cautionRemediationCadenceGenerations = resolveCautionRemediationCadenceGenerations(
            modelInfoForRemediation?.caution_remediation_cadence_generations,
          );
          const criticalCountdownRemaining = resolveCriticalCountdownRemaining(
            dlg.id.key(),
            snapshot,
          );
          const healthDecision = decideKernelDriverContextHealth({
            dialogKey: dlg.id.key(),
            snapshot,
            hadUserPromptThisGen: currentGenerationBelongsToUserPrompt,
            hadUserPromptInImmediateToolChain: currentGenerationBelongsToUserToolChain,
            userPromptCriticalRemediationAlreadyApplied:
              (criticalRemediationAppliedUserPromptMsgId !== undefined &&
                criticalRemediationAppliedUserPromptMsgId === currentUserPromptMsgId) ||
              (currentPendingPrompt?.origin === 'user' &&
                isAgentFacingCriticalUserInterjectionRemediationGuideContent(
                  currentPendingPrompt.content,
                )),
            canInjectPromptThisGen: !hasQueuedPrompt,
            cautionRemediationCadenceGenerations,
            criticalCountdownRemaining,
          });

          if (
            healthDecision.kind === 'continue' &&
            !latestInputLikeMessageIsContextHealthLargeToolReturnUnavailableResult(dlg.msgs)
          ) {
            if (healthDecision.reason === 'critical_force_new_course') {
              const language = getWorkLanguage();
              const newCoursePrompt = formatNewCourseStartPrompt(language, {
                nextCourse: dlg.currentCourse + 1,
                source: 'critical_auto_clear',
              });
              const normalizedNewCoursePrompt = await dlg.startNewCourse(newCoursePrompt);
              dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
              resetContextHealthRoundState(dlg.id.key());
              pendingPrompt = normalizedNewCoursePrompt;
              skipTaskdocForThisDrive = false;
            } else if (healthDecision.reason === 'critical_user_prompt_remediation') {
              if (
                currentPendingPrompt === undefined ||
                !isAgentFacingCriticalUserInterjectionRemediationGuideContent(
                  currentPendingPrompt.content,
                )
              ) {
                log.warn(
                  'kernel-driver observed unwrapped critical user prompt; critical user interjection wrapping must happen at ingress',
                  undefined,
                  {
                    dialogId: dlg.id.valueOf(),
                    msgId: currentUserPromptMsgId ?? null,
                  },
                );
              }
              criticalRemediationAppliedUserPromptMsgId = currentUserPromptMsgId;
            } else if (!hasQueuedPrompt) {
              const language = getWorkLanguage();
              const dialogScope = dlg instanceof SideDialog ? 'sideDialog' : 'mainDialog';
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
                      promptsRemainingAfterThis: consumeCriticalCountdown(dlg.id.key()),
                      promptsTotal: KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
                    });
              pendingPrompt = {
                content: guideText,
                msgId: generateShortId(),
                grammar: 'markdown',
                origin: 'runtime',
                userLanguageCode: language,
              };
            }
          }
        }

        let contextHealthForGen: ContextHealthSnapshot | undefined;
        let llmGenModelForGen: string = model;
        const currentPrompt = pendingPrompt;
        const currentReplyTarget = currentPrompt?.calleeDialogReplyTarget;
        if (currentGenerationBelongsToUserPrompt) {
          resetRepeatedToolCallMonitor(repeatedToolCallMonitor);
        }
        let currentBusinessContinuation: DialogBusinessContinuation =
          driveOptions?.businessContinuation ?? { kind: 'none' };
        if (currentPrompt?.tellaskReplyDirective !== undefined) {
          currentBusinessContinuation = {
            kind: 'inter_dialog_reply',
            tellaskReplyDirective: currentPrompt.tellaskReplyDirective,
            ...(currentPrompt.calleeDialogReplyTarget === undefined
              ? {}
              : { calleeDialogReplyTarget: currentPrompt.calleeDialogReplyTarget }),
          };
        }
        const currentFbrState = await loadDialogFbrState(dlg);
        let currentRuntimeGuideMsg:
          | Extract<ChatMessage, { type: 'transient_guide_msg' }>
          | undefined;
        const currentPromptFromFbrState =
          currentPrompt !== undefined &&
          currentFbrState !== undefined &&
          currentFbrState.promptDelivered !== true &&
          isFbrSideDialog(dlg) &&
          currentPrompt.origin === 'runtime' &&
          currentPrompt.content === buildKernelDriverFbrPrompt(dlg, currentFbrState).content;
        pendingPrompt = undefined;

        if (currentPrompt) {
          const diligenceSkipReason = await shouldSkipDiligencePromptBeforeGeneration({
            dlg,
            prompt: currentPrompt,
            suppressDiligencePushForDrive,
          });
          if (diligenceSkipReason !== undefined) {
            log.debug('kernel-driver skip diligence prompt before generation', undefined, {
              dialogId: dlg.id.valueOf(),
              msgId: currentPrompt.msgId,
              reason: diligenceSkipReason,
            });
            break;
          }
        }

        const acceptedTriggers = await dlg.notifyGeneratingStart(currentPrompt?.msgId);
        lastToolRoundStopDiagnostics = undefined;
        for (const trigger of acceptedTriggers) {
          if (trigger.kind === 'followup' && trigger.continuation !== undefined) {
            if (
              currentBusinessContinuation.kind !== 'none' &&
              !sameDialogBusinessContinuation(currentBusinessContinuation, trigger.continuation)
            ) {
              throw new Error(
                `Business continuation invariant violation: conflicting accepted followup continuations ` +
                  `(dialog=${dlg.id.valueOf()}, course=${String(dlg.activeGenCourseOrUndefined ?? dlg.currentCourse)}, ` +
                  `genseq=${String(dlg.activeGenSeq)}, triggerId=${trigger.triggerId})`,
              );
            }
            currentBusinessContinuation = trigger.continuation;
          }
        }
        lastBusinessContinuation = currentBusinessContinuation;
        currentPromptIsUserInterjection = false;
        currentUserInterjectionReply = undefined;
        let generationBodyError: unknown;
        let immediateFollowupTriggerExpectation: ImmediateFollowupTriggerExpectation | undefined;
        const q4hAnswerCallId = normalizeQ4HAnswerCallId(currentPrompt?.q4hAnswerCallId);
        const isQ4HAnswerPrompt = q4hAnswerCallId !== undefined;
        try {
          if (currentPrompt) {
            if (currentPrompt.skipTaskdoc === true) {
              skipTaskdocForThisDrive = true;
            }

            const persistedUserLanguageCode =
              currentPrompt.userLanguageCode ?? dlg.getLastUserLanguageCode();
            // `q4hAnswerCallId` marks a continuation input for an already-materialized askHuman
            // answer. It is not a second business-level user prompt that should re-enter transcript.
            const promptLanguage =
              persistedUserLanguageCode === 'zh' || persistedUserLanguageCode === 'en'
                ? persistedUserLanguageCode
                : getWorkLanguage();
            const replyGuidance = await resolvePromptReplyGuidance({
              dlg,
              prompt: currentPrompt,
              language: promptLanguage,
            });
            currentPromptIsUserInterjection =
              currentPrompt.origin === 'user' &&
              replyGuidance.suppressInterDialogReplyGuidance &&
              !replyGuidance.isQ4HAnswerPrompt;
            if (currentPromptIsUserInterjection) {
              currentUserInterjectionReply = {
                msgId: currentPrompt.msgId,
                course: toDialogCourseNumber(dlg.activeGenCourseOrUndefined ?? dlg.currentCourse),
                genseq: toCallSiteGenseqNo(dlg.activeGenSeq),
              };
              currentRuntimeGuideMsg = replyGuidance.transientGuideContent
                ? {
                    type: 'transient_guide_msg',
                    role: 'assistant',
                    content: replyGuidance.transientGuideContent,
                  }
                : undefined;
            }
            if (
              !replyGuidance.suppressInterDialogReplyGuidance &&
              !currentRuntimeGuideMsg &&
              replyGuidance.transientGuideContent
            ) {
              currentRuntimeGuideMsg = {
                type: 'transient_guide_msg',
                role: 'assistant',
                content: replyGuidance.transientGuideContent,
              };
            }
            if (replyGuidance.promptContent === undefined) {
              throw new Error(
                `kernel-driver reply guidance invariant violation: missing prompt content for dialog=${dlg.id.valueOf()} msgId=${currentPrompt.msgId}`,
              );
            }
            if (currentPromptIsUserInterjection) {
              if (currentUserInterjectionReply === undefined) {
                throw new Error(
                  `kernel-driver user interjection invariant violation: missing pending reply coordinate for dialog=${dlg.id.valueOf()} msgId=${currentPrompt.msgId}`,
                );
              }
              const pendingUserInterjectionReply = currentUserInterjectionReply;
              await DialogPersistence.mutateDialogLatest(
                dlg.id,
                () => ({
                  kind: 'patch',
                  patch: {
                    pendingUserInterjectionReply: {
                      ...pendingUserInterjectionReply,
                    },
                  },
                }),
                dlg.status,
              );
            }
            const renderPromptAsRuntimeGuideBubble =
              currentPrompt.origin === 'runtime' &&
              isStandaloneRuntimeGuidePromptContent(replyGuidance.promptContent);

            if (currentRuntimeGuideMsg) {
              await persistAndEmitRuntimeGuide(dlg, currentRuntimeGuideMsg.content);
              currentRuntimeGuideMsg = undefined;
            }

            if (isQ4HAnswerPrompt) {
              if (!replyGuidance.isQ4HAnswerPrompt) {
                throw new Error(
                  `kernel-driver q4h answer classification invariant violation: msgId=${currentPrompt.msgId} was parsed as q4h answer before reply-guidance but not after`,
                );
              }
              // Record only the answered call correlation / user language for the resumed round.
              // The actual human answer fact was already persisted via askHuman tellask result flow.
              await dlg.receiveHumanReply({
                content: replyGuidance.promptContent,
                userLanguageCode: persistedUserLanguageCode,
                q4hAnswerCallId,
              });
            } else if (replyGuidance.isQ4HAnswerPrompt) {
              throw new Error(
                `kernel-driver q4h answer classification invariant violation: msgId=${currentPrompt.msgId} was classified as q4h answer by reply-guidance without a normalized q4hAnswerCallId`,
              );
            } else {
              await dlg.addChatMessages({
                type: 'prompting_msg',
                role: 'user',
                genseq: dlg.activeGenSeq,
                msgId: currentPrompt.msgId,
                grammar: 'markdown',
                content: replyGuidance.promptContent,
                ...(currentPrompt.contentItems === undefined
                  ? {}
                  : { contentItems: currentPrompt.contentItems }),
              });
              await dlg.persistUserMessage(
                replyGuidance.promptContent,
                currentPrompt.msgId,
                'markdown',
                currentPrompt.origin,
                persistedUserLanguageCode,
                q4hAnswerCallId,
                replyGuidance.persistedTellaskReplyDirective,
                currentPrompt.contentItems,
              );
              await DialogPersistence.clearPendingRuntimePrompt(
                dlg.id,
                currentPrompt.msgId,
                dlg.status,
              );
            }

            if (renderPromptAsRuntimeGuideBubble) {
              postDialogEvent(dlg, {
                type: 'runtime_guide_evt',
                course: dlg.currentCourse,
                genseq: dlg.activeGenSeq,
                content: replyGuidance.promptContent,
              });
            } else if (!isQ4HAnswerPrompt) {
              // Emit the live user-side boundary event for UI generation bubbles.
              // Without this, realtime turns can miss user content + divider (<hr/>).
              postDialogEvent(dlg, {
                type: 'end_of_user_saying_evt',
                course: dlg.currentCourse,
                genseq: dlg.activeGenSeq,
                msgId: currentPrompt.msgId,
                content: replyGuidance.promptContent,
                ...(currentPrompt.contentItems === undefined
                  ? {}
                  : { contentItems: currentPrompt.contentItems }),
                grammar: 'markdown',
                origin: currentPrompt.origin,
                userLanguageCode: persistedUserLanguageCode,
                q4hAnswerCallId,
              });
            }

            if (currentPromptFromFbrState && currentFbrState) {
              await persistDialogFbrState(dlg, markFbrPromptDelivered(currentFbrState));
            }

            // Ideal: provider SDKs should support a dedicated role='environment' for runtime
            // metadata. Today, most providers only accept user/assistant (and tool as a special
            // case), so Dominds must project environment/system-like content as role='user'.
            const replyTarget = currentPrompt.calleeDialogReplyTarget;
            if (replyTarget) {
              const normalizedCallId = replyTarget.callId.trim();
              if (normalizedCallId === '') {
                throw new Error(
                  `kernel-driver assignment anchor invariant violation: empty callId (dialog=${dlg.id.valueOf()})`,
                );
              }
              const record: TellaskAnchorRecord = {
                ts: formatUnifiedTimestamp(new Date()),
                type: 'tellask_anchor_record',
                anchorRole: 'assignment',
                callId: normalizedCallId,
                genseq: dlg.activeGenSeq,
                ...toRootGenerationAnchor({
                  rootCourse: (dlg instanceof SideDialog ? dlg.mainDialog : dlg).currentCourse,
                  rootGenseq:
                    (dlg instanceof SideDialog ? dlg.mainDialog : dlg).activeGenSeqOrUndefined ?? 0,
                }),
              };
              const course = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
              await DialogPersistence.appendEvent(dlg.id, course, record, dlg.status);
              await DialogPersistence.mutateDialogLatest(
                dlg.id,
                () => ({
                  kind: 'patch',
                  patch: {
                    latestAssignmentAnchor: {
                      callId: normalizedCallId,
                      assignmentCourse: toAssignmentCourseNumber(course),
                      assignmentGenseq: toAssignmentGenerationSeqNumber(dlg.activeGenSeq),
                    },
                  },
                }),
                dlg.status,
              );
              if (dlg instanceof SideDialog) {
                const callerDialogId = new DialogID(replyTarget.callerDialogId, dlg.id.rootId);
                const callerDialogStatus =
                  callerDialogId.selfId === dlg.mainDialog.id.selfId
                    ? dlg.mainDialog.status
                    : dlg.status;
                const calleeCourse = toCalleeCourseNumber(course);
                const calleeGenseq = toCalleeGenerationSeqNumber(dlg.activeGenSeq);
                const calleeRecord: TellaskCalleeRecord = {
                  ts: formatUnifiedTimestamp(new Date()),
                  type: 'tellask_callee_record',
                  ...toRootGenerationAnchor({
                    rootCourse: dlg.mainDialog.currentCourse,
                    rootGenseq: dlg.mainDialog.activeGenSeqOrUndefined ?? 0,
                  }),
                  genseq: replyTarget.callSiteGenseq,
                  callId: normalizedCallId,
                  calleeDialogId: dlg.id.selfId,
                  calleeCourse,
                  calleeGenseq,
                };
                await DialogPersistence.appendEvent(
                  callerDialogId,
                  replyTarget.callSiteCourse,
                  calleeRecord,
                  callerDialogStatus,
                );
                postDialogEventById(callerDialogId, {
                  type: 'tellask_callee_evt',
                  course: replyTarget.callSiteCourse,
                  genseq: replyTarget.callSiteGenseq,
                  callId: normalizedCallId,
                  calleeDialogId: dlg.id.selfId,
                  calleeCourse,
                  calleeGenseq,
                });
              }
            }
          }

          await dlg.processReminderUpdates();
          pubRemindersVer = dlg.remindersVer;

          const taskDocMsg =
            dlg.taskDocPath && !skipTaskdocForThisDrive
              ? await formatTaskDocContent(dlg)
              : undefined;

          const renderedReminders = await renderRemindersForContext(dlg);
          const dialogMsgsForContext = await buildDialogMsgsForContext(dlg);
          const activeReplyObligationContext = await buildActiveReplyObligationContext(dlg);
          const splitDialogMsgs = splitDialogMsgsForReminderInsertion({
            msgs: dialogMsgsForContext,
            currentPrompt,
          });
          const reminderContextBlock =
            renderedReminders.length > 0
              ? [
                  ...renderedReminders,
                  {
                    type: 'environment_msg',
                    role: 'user',
                    content: formatReminderContextFooter(
                      getWorkLanguage(),
                      await resolveReminderContextFooterState({
                        dlg,
                        prompt: currentPrompt,
                        currentTurnDialogMsgsForContext:
                          splitDialogMsgs.currentTurnDialogMsgsForContext,
                      }),
                    ),
                  } satisfies ChatMessage,
                ]
              : renderedReminders;
          const ctxMsgs: ChatMessage[] = assembleDriveContextMessages({
            base: {
              prependedContextMessages: policy.prependedContextMessages,
              memories: minds.memories,
              taskDocMsg,
              coursePrefixMsgs: dlg.getCoursePrefixMsgs(),
              historicalDialogMsgsForContext: splitDialogMsgs.historicalDialogMsgsForContext,
              currentTurnDialogMsgsForContext: splitDialogMsgs.currentTurnDialogMsgsForContext,
            },
            tail: {
              renderedReminders: reminderContextBlock,
              activeReplyObligationContext,
              runtimeGuideMsgs: currentRuntimeGuideMsg ? [currentRuntimeGuideMsg] : [],
            },
          });

          const newMsgs: ChatMessage[] = [];
          const streamedFuncCalls: FuncCallMsg[] = [];
          let sawWebSearchSideChannelOutput = false;
          let sawNativeToolSideChannelOutput = false;
          let invalidFuncCallCount = 0;

          const streamOrBatch = async (): Promise<{
            usage: LlmUsageStats;
            llmGenModel?: string;
            batchMessages?: ChatMessage[];
            batchOutputs?: LlmBatchOutput[];
          }> => {
            let batchAttemptCourse: number | undefined;
            let batchAttemptCheckpointOffset: number | undefined;
            const rollbackBatchAttempt = async (): Promise<void> => {
              if (batchAttemptCourse === undefined || batchAttemptCheckpointOffset === undefined) {
                throw new Error(
                  `kernel-driver batch retry invariant violation: missing checkpoint (dialog=${dlg.id.valueOf()})`,
                );
              }
              await DialogPersistence.rollbackCourseFileToOffset(
                dlg.id,
                batchAttemptCourse,
                batchAttemptCheckpointOffset,
                dlg.status,
              );
              postDialogEvent(dlg, {
                type: 'genseq_discard_evt',
                course: batchAttemptCourse,
                genseq: dlg.activeGenSeq,
                reason: 'retry',
              });

              sawWebSearchSideChannelOutput = false;
              sawNativeToolSideChannelOutput = false;
              invalidFuncCallCount = 0;
              streamedFuncCalls.length = 0;
              newMsgs.length = 0;
            };

            const retryQuirkSession = resolveRetryQuirkSession();
            const prepareLlmRequestContextKey = (): string => {
              const promptCacheKey = `${dlg.id.selfId}:c${String(dlg.currentCourse)}`;
              retryQuirkSession?.onRequestContext?.(
                `${promptCacheKey}:g${String(dlg.activeGenSeq)}`,
              );
              return promptCacheKey;
            };

            if (agent.streaming === false) {
              const batch = await runLlmRequestWithRetry({
                dlg,
                provider,
                modelId: model,
                providerConfig: providerCfg,
                abortSignal,
                aggressiveRetryMaxRetries: retryPolicy.aggressiveMaxRetries,
                retryInitialDelayMs: retryPolicy.initialDelayMs,
                retryConservativeDelayMs: retryPolicy.conservativeDelayMs,
                retryBackoffMultiplier: retryPolicy.backoffMultiplier,
                retryMaxDelayMs: retryPolicy.maxDelayMs,
                classifyFailure: llmGen.classifyFailure?.bind(llmGen),
                quirkFailureHandlerSession: retryQuirkSession,
                canRetry: () => true,
                onRetry: rollbackBatchAttempt,
                onGiveUp: rollbackBatchAttempt,
                onRetryStopped: prepareRetryStoppedRecovery,
                doRequest: async () => {
                  batchAttemptCourse = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
                  batchAttemptCheckpointOffset = await DialogPersistence.captureCourseFileOffset(
                    dlg.id,
                    batchAttemptCourse,
                    dlg.status,
                  );
                  sawWebSearchSideChannelOutput = false;
                  sawNativeToolSideChannelOutput = false;
                  streamedFuncCalls.length = 0;
                  newMsgs.length = 0;
                  const promptCacheKey = prepareLlmRequestContextKey();
                  const batchResult = await llmGen.genMoreMessages(
                    providerCfg,
                    agent,
                    systemPrompt,
                    funcTools,
                    {
                      dialogSelfId: dlg.id.selfId,
                      dialogRootId: dlg.id.rootId,
                      providerKey: provider,
                      modelKey: model,
                      promptCacheKey,
                      toolUseRequirement: resolveToolUseRequirement(dlg, policy),
                    },
                    ctxMsgs,
                    dlg.activeGenSeq,
                    abortSignal,
                  );
                  if (!hasMeaningfulBatchOutput(batchResult)) {
                    throw {
                      status: 503,
                      code: KERNEL_DRIVER_EMPTY_LLM_RESPONSE_ERROR_CODE,
                      message: `LLM returned empty response (provider=${provider}, model=${model}, streaming=false).`,
                    };
                  }
                  return batchResult;
                },
              });
              return {
                usage: batch.usage,
                llmGenModel: batch.llmGenModel,
                batchMessages: batch.messages,
                batchOutputs: batch.outputs,
              };
            }

            let currentSayingContent = '';
            let currentThinkingContent = '';
            let currentThinkingReasoning: ThinkingMsg['reasoning'] = undefined;
            let streamAttemptCourse: number | undefined;
            let streamAttemptCheckpointOffset: number | undefined;
            let streamAttemptSayingContent: string | undefined;
            let streamAttemptSayingGenseq: number | undefined;
            let streamAttemptThinkingContent: string | undefined;
            let streamAttemptThinkingGenseq: number | undefined;
            let streamAttemptAnsweringContent: string | undefined;
            let streamAttemptAnsweringGenseq: number | undefined;
            type StreamActiveState = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'saying' };
            let streamActive: StreamActiveState = { kind: 'idle' };
            const rollbackStreamAttempt = async (): Promise<void> => {
              if (
                streamAttemptCourse === undefined ||
                streamAttemptCheckpointOffset === undefined
              ) {
                throw new Error(
                  `kernel-driver stream retry invariant violation: missing checkpoint (dialog=${dlg.id.valueOf()})`,
                );
              }
              await DialogPersistence.rollbackCourseFileToOffset(
                dlg.id,
                streamAttemptCourse,
                streamAttemptCheckpointOffset,
                dlg.status,
              );
              postDialogEvent(dlg, {
                type: 'genseq_discard_evt',
                course: streamAttemptCourse,
                genseq: dlg.activeGenSeq,
                reason: 'retry',
              });

              streamActive = { kind: 'idle' };
              currentThinkingContent = '';
              currentThinkingReasoning = undefined;
              currentSayingContent = '';
              streamAttemptSayingContent = undefined;
              streamAttemptSayingGenseq = undefined;
              streamAttemptThinkingContent = undefined;
              streamAttemptThinkingGenseq = undefined;
              streamAttemptAnsweringContent = undefined;
              streamAttemptAnsweringGenseq = undefined;
              sawWebSearchSideChannelOutput = false;
              sawNativeToolSideChannelOutput = false;
              streamedFuncCalls.length = 0;
              invalidFuncCallCount = 0;
              newMsgs.length = 0;
            };

            const receiver: LlmStreamReceiver = {
              streamError: async (detail: string) => {
                await dlg.streamError(detail);
              },
              thinkingStart: async () => {
                throwIfAborted(abortSignal, dlg);
                if (streamActive.kind !== 'idle') {
                  const detail = `Protocol violation: thinkingStart while ${streamActive.kind} is active`;
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                streamActive = { kind: 'thinking' };
                currentThinkingContent = '';
                currentThinkingReasoning = undefined;
                await dlg.thinkingStart();
              },
              thinkingChunk: async (chunk: string) => {
                throwIfAborted(abortSignal, dlg);
                currentThinkingContent += chunk;
                await dlg.thinkingChunk(chunk);
              },
              thinkingFinish: async (reasoning, providerData) => {
                throwIfAborted(abortSignal, dlg);
                if (streamActive.kind !== 'thinking') {
                  const detail = `Protocol violation: thinkingFinish while ${streamActive.kind} is active`;
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                streamActive = { kind: 'idle' };
                if (reasoning) currentThinkingReasoning = reasoning;
                await dlg.thinkingFinish(reasoning, providerData);
                if (
                  currentThinkingContent.length > 0 ||
                  currentThinkingReasoning !== undefined ||
                  providerData !== undefined
                ) {
                  const thinkingMessage: ThinkingMsg = {
                    type: 'thinking_msg',
                    role: 'assistant',
                    genseq: dlg.activeGenSeq,
                    content: currentThinkingContent,
                    reasoning: currentThinkingReasoning,
                    ...(providerData !== undefined ? { provider_data: providerData } : {}),
                  };
                  newMsgs.push(thinkingMessage);
                  streamAttemptThinkingContent = currentThinkingContent;
                  streamAttemptThinkingGenseq = thinkingMessage.genseq;
                }
                currentThinkingContent = '';
                currentThinkingReasoning = undefined;
              },
              sayingStart: async () => {
                throwIfAborted(abortSignal, dlg);
                if (streamActive.kind !== 'idle') {
                  const detail = `Protocol violation: sayingStart while ${streamActive.kind} is active`;
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                streamActive = { kind: 'saying' };
                currentSayingContent = '';
                await dlg.sayingStart();
              },
              sayingChunk: async (chunk: string) => {
                throwIfAborted(abortSignal, dlg);
                currentSayingContent += chunk;
                await dlg.sayingChunk(chunk);
              },
              sayingFinish: async () => {
                throwIfAborted(abortSignal, dlg);
                if (streamActive.kind !== 'saying') {
                  const detail = `Protocol violation: sayingFinish while ${streamActive.kind} is active`;
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                streamActive = { kind: 'idle' };
                await dlg.sayingFinish();
                const sayingMessage: SayingMsg = {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq: dlg.activeGenSeq,
                  content: currentSayingContent,
                };
                newMsgs.push(sayingMessage);
                streamAttemptSayingContent = currentSayingContent;
                streamAttemptSayingGenseq = sayingMessage.genseq;
              },
              answering: async (content: string) => {
                throwIfAborted(abortSignal, dlg);
                if (streamActive.kind !== 'idle') {
                  const detail = `Protocol violation: answering while ${streamActive.kind} is active`;
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                if (content.trim() !== '') {
                  if (streamAttemptAnsweringContent !== undefined) {
                    const detail =
                      'Protocol violation: multiple answering outputs in one generation';
                    await dlg.streamError(detail);
                    throw new LlmStreamErrorEmittedError({
                      detail,
                      i18nStopReason: buildHumanSystemStopReasonTextI18n({
                        detail,
                        kind: 'conflicting_stream',
                      }),
                    });
                  }
                  streamAttemptAnsweringContent = content;
                  streamAttemptAnsweringGenseq = dlg.activeGenSeq;
                }
              },
              funcCall: async (
                callId: string,
                name: string,
                argsStr: string,
                ids?: { rawCallId?: string; effectiveCallId?: string },
              ) => {
                throwIfAborted(abortSignal, dlg);
                const rawCallId = trimOptionalCallId(ids?.rawCallId) ?? callId;
                const effectiveCallId = trimOptionalCallId(ids?.effectiveCallId) ?? callId;
                streamedFuncCalls.push({
                  type: 'func_call_msg',
                  role: 'assistant',
                  genseq: dlg.activeGenSeq,
                  id: effectiveCallId,
                  rawId: rawCallId,
                  effectiveId: effectiveCallId,
                  name,
                  arguments: argsStr,
                });
              },
              invalidFuncCall: async (call) => {
                throwIfAborted(abortSignal, dlg);
                invalidFuncCallCount += 1;
                await persistInvalidFuncCallRuntimeGuide({
                  dlg,
                  call,
                  source: 'streamed',
                  newMsgs,
                  emitStreamError: true,
                });
              },
              webSearchCall: async (call) => {
                throwIfAborted(abortSignal, dlg);
                sawWebSearchSideChannelOutput = true;
                await dlg.webSearchCall(projectLlmWebSearchCall(call));
              },
              nativeToolCall: async (call: OpenAiResponsesNativeToolCall) => {
                throwIfAborted(abortSignal, dlg);
                sawNativeToolSideChannelOutput = true;
                await dlg.nativeToolCall(call);
              },
              toolResultImageIngest: async (ingest) => {
                throwIfAborted(abortSignal, dlg);
                await dlg.toolResultImageIngest(ingest);
              },
              userImageIngest: async (ingest) => {
                throwIfAborted(abortSignal, dlg);
                await dlg.userImageIngest(ingest);
              },
            };

            const res = await runLlmRequestWithRetry({
              dlg,
              provider,
              modelId: model,
              providerConfig: providerCfg,
              abortSignal,
              aggressiveRetryMaxRetries: retryPolicy.aggressiveMaxRetries,
              retryInitialDelayMs: retryPolicy.initialDelayMs,
              retryConservativeDelayMs: retryPolicy.conservativeDelayMs,
              retryBackoffMultiplier: retryPolicy.backoffMultiplier,
              retryMaxDelayMs: retryPolicy.maxDelayMs,
              classifyFailure: llmGen.classifyFailure?.bind(llmGen),
              quirkFailureHandlerSession: retryQuirkSession,
              canRetry: () => true,
              onRetry: rollbackStreamAttempt,
              onGiveUp: rollbackStreamAttempt,
              onRetryStopped: prepareRetryStoppedRecovery,
              doRequest: async () => {
                streamAttemptCourse = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
                streamAttemptCheckpointOffset = await DialogPersistence.captureCourseFileOffset(
                  dlg.id,
                  streamAttemptCourse,
                  dlg.status,
                );
                streamActive = { kind: 'idle' };
                currentThinkingContent = '';
                currentThinkingReasoning = undefined;
                currentSayingContent = '';
                streamAttemptSayingContent = undefined;
                streamAttemptSayingGenseq = undefined;
                streamAttemptThinkingContent = undefined;
                streamAttemptThinkingGenseq = undefined;
                streamAttemptAnsweringContent = undefined;
                streamAttemptAnsweringGenseq = undefined;
                sawWebSearchSideChannelOutput = false;
                sawNativeToolSideChannelOutput = false;
                streamedFuncCalls.length = 0;
                invalidFuncCallCount = 0;
                newMsgs.length = 0;
                const promptCacheKey = prepareLlmRequestContextKey();
                const streamResult = await llmGen.genToReceiver(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  {
                    dialogSelfId: dlg.id.selfId,
                    dialogRootId: dlg.id.rootId,
                    providerKey: provider,
                    modelKey: model,
                    promptCacheKey,
                    toolUseRequirement: resolveToolUseRequirement(dlg, policy),
                  },
                  ctxMsgs,
                  receiver,
                  dlg.activeGenSeq,
                  abortSignal,
                );
                const hasFinishedMessageContent = newMsgs.some(
                  (msg) =>
                    (msg.type === 'thinking_msg' || msg.type === 'saying_msg') &&
                    msg.content.trim() !== '',
                );
                const hasFunctionCall = streamedFuncCalls.length > 0;
                if (
                  !hasFinishedMessageContent &&
                  streamAttemptAnsweringContent === undefined &&
                  !hasFunctionCall &&
                  invalidFuncCallCount === 0 &&
                  !sawWebSearchSideChannelOutput &&
                  !sawNativeToolSideChannelOutput
                ) {
                  throw {
                    status: 503,
                    code: KERNEL_DRIVER_EMPTY_LLM_RESPONSE_ERROR_CODE,
                    message: `LLM returned empty response (provider=${provider}, model=${model}, streaming=true).`,
                  };
                }
                return streamResult;
              },
            });
            if (streamAttemptSayingContent !== undefined) {
              lastAssistantSayingContent = streamAttemptSayingContent;
              lastAssistantSayingGenseq =
                streamAttemptSayingGenseq === undefined ? null : streamAttemptSayingGenseq;
              lastAssistantReplyTarget = currentReplyTarget;
            }
            if (streamAttemptThinkingContent !== undefined) {
              lastAssistantThinkingContent = streamAttemptThinkingContent;
              lastAssistantThinkingGenseq =
                streamAttemptThinkingGenseq === undefined ? null : streamAttemptThinkingGenseq;
              if (streamAttemptSayingContent === undefined) {
                lastAssistantReplyTarget = currentReplyTarget;
              }
            }
            if (streamAttemptAnsweringContent !== undefined) {
              const answer = await recordStructuredAnswering({
                dlg,
                content: streamAttemptAnsweringContent,
                source: 'structured-answering',
              });
              if (answer !== undefined) {
                lastAssistantAnsweringContent = answer.content;
                lastAssistantAnsweringGenseq =
                  streamAttemptAnsweringGenseq === undefined
                    ? answer.answerRef.genseq
                    : streamAttemptAnsweringGenseq;
              }
            }
            return { usage: res.usage, llmGenModel: res.llmGenModel };
          };

          const previousAssistantSayingGenseq = lastAssistantSayingGenseq;
          const contextHealthBeforeGen = dlg.getLastContextHealth();
          const llmOutput = await streamOrBatch();
          if (typeof llmOutput.llmGenModel === 'string' && llmOutput.llmGenModel.trim() !== '') {
            llmGenModelForGen = llmOutput.llmGenModel.trim();
          }
          let currentRoundAssistantSayingContent: string | null = null;
          let currentRoundAssistantSayingGenseq: number | null = null;

          contextHealthForGen = computeContextHealthSnapshot({
            providerCfg,
            model,
            usage: llmOutput.usage,
          });
          dlg.setLastContextHealth(contextHealthForGen);

          const batchOutputs =
            Array.isArray(llmOutput.batchOutputs) && llmOutput.batchOutputs.length > 0
              ? llmOutput.batchOutputs
              : Array.isArray(llmOutput.batchMessages)
                ? llmOutput.batchMessages.map(
                    (message): LlmBatchOutput => ({ kind: 'message', message }),
                  )
                : [];
          let batchAnsweringSeen = false;
          for (const output of batchOutputs) {
            switch (output.kind) {
              case 'message': {
                const msg = output.message;
                if (msg.type === 'thinking_msg' || msg.type === 'saying_msg') {
                  newMsgs.push(msg);
                  if (msg.type === 'thinking_msg') {
                    lastAssistantThinkingContent = msg.content;
                    lastAssistantThinkingGenseq = msg.genseq;
                    lastAssistantReplyTarget = currentReplyTarget;
                    await emitThinkingEvents(dlg, msg.content, msg.reasoning);
                  } else {
                    lastAssistantSayingContent = msg.content;
                    lastAssistantSayingGenseq = msg.genseq;
                    currentRoundAssistantSayingContent = msg.content;
                    currentRoundAssistantSayingGenseq = msg.genseq;
                    lastAssistantReplyTarget = currentReplyTarget;
                    await emitAssistantSaying(dlg, msg.content);
                  }
                  break;
                }
                if (msg.type === 'func_call_msg') {
                  streamedFuncCalls.push(msg);
                }
                break;
              }
              case 'answering': {
                if (output.content.trim() === '') {
                  break;
                }
                if (batchAnsweringSeen) {
                  const detail = 'Protocol violation: multiple answering outputs in one generation';
                  await dlg.streamError(detail);
                  throw new LlmStreamErrorEmittedError({
                    detail,
                    i18nStopReason: buildHumanSystemStopReasonTextI18n({
                      detail,
                      kind: 'conflicting_stream',
                    }),
                  });
                }
                batchAnsweringSeen = true;
                const answer = await recordStructuredAnswering({
                  dlg,
                  content: output.content,
                  source: 'structured-answering',
                });
                if (answer !== undefined) {
                  lastAssistantAnsweringContent = answer.content;
                  lastAssistantAnsweringGenseq = answer.answerRef.genseq;
                }
                break;
              }
              case 'invalid_func_call': {
                invalidFuncCallCount += 1;
                await persistInvalidFuncCallRuntimeGuide({
                  dlg,
                  call: output.call,
                  source: 'batch',
                  newMsgs,
                  emitStreamError: true,
                });
                break;
              }
              case 'web_search_call': {
                sawWebSearchSideChannelOutput = true;
                await dlg.webSearchCall(projectLlmWebSearchCall(output.call));
                break;
              }
              case 'native_tool_call': {
                sawNativeToolSideChannelOutput = true;
                await dlg.nativeToolCall(output.call);
                break;
              }
              case 'tool_result_image_ingest': {
                await dlg.toolResultImageIngest(output.ingest);
                break;
              }
              case 'user_image_ingest': {
                await dlg.userImageIngest(output.ingest);
                break;
              }
              default: {
                const _exhaustive: never = output;
                throw new Error(`Unhandled batch output kind: ${String(_exhaustive)}`);
              }
            }
          }

          const tellaskCallCount = policy.allowTellaskFunctions
            ? streamedFuncCalls.filter(
                (c) =>
                  c.name === 'tellask' ||
                  c.name === 'tellaskSessionless' ||
                  c.name === 'tellaskBack' ||
                  c.name === 'askHuman' ||
                  c.name === 'answerHuman' ||
                  c.name === 'freshBootsReasoning',
              ).length
            : 0;
          const policyViolationKind = resolveKernelDriverPolicyViolationKind({
            policy,
            tellaskCallCount,
            functionCallCount: streamedFuncCalls.length,
          });
          if (policyViolationKind) {
            const violationText = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
              kind: policyViolationKind,
            });
            const genseq = dlg.activeGenSeq;
            const violationMsg: SayingMsg = {
              type: 'saying_msg',
              role: 'assistant',
              genseq,
              content: violationText,
            };
            await emitAssistantSaying(dlg, violationText);
            newMsgs.push(violationMsg);
            await dlg.addChatMessages(...newMsgs);
            lastAssistantSayingContent = violationText;
            lastAssistantSayingGenseq = genseq;
            lastAssistantReplyTarget = currentReplyTarget;
            const persistedFbrState = await loadDialogFbrState(dlg);
            if (!persistedFbrState) {
              return {
                lastAssistantSayingContent,
                lastAssistantSayingGenseq,
                lastAssistantThinkingContent,
                lastAssistantThinkingGenseq,
                lastAssistantAnsweringContent,
                lastAssistantAnsweringGenseq,
                lastFunctionCallGenseq,
                lastAssistantReplyTarget,
                lastBusinessContinuation,
              };
            }
            const nextFbrState = advanceFbrState(persistedFbrState);
            if (nextFbrState) {
              if (!isFbrSideDialog(dlg)) {
                throw new Error(
                  `kernel-driver FBR invariant violation: persisted FBR state on non-FBR dialog (${dlg.id.valueOf()})`,
                );
              }
              await persistDialogFbrState(dlg, nextFbrState);
              dlg.setFbrConclusionToolsEnabled(isFbrFinalizationState(nextFbrState));
              pendingPrompt = buildKernelDriverFbrPrompt(dlg, nextFbrState);
              continue;
            }
            fbrConclusion = {
              responseText: buildProgrammaticFbrUnreasonableSituationContent({
                language: getWorkLanguage(),
                finalizationAttempts: persistedFbrState.effort,
              }),
              responseGenseq: genseq,
              replyResolutionCallId: `fbr-conclusion-${generateShortId()}`,
            };
            if (!isFbrSideDialog(dlg)) {
              throw new Error(
                `kernel-driver FBR invariant violation: persisted FBR state on non-FBR dialog (${dlg.id.valueOf()})`,
              );
            }
            await persistDialogFbrState(dlg, undefined);
            dlg.setFbrConclusionToolsEnabled(false);
            break;
          }

          const normalizedStreamedFuncCalls = await normalizeGeneratedFunctionCallIds({
            calls: streamedFuncCalls,
            dialog: dlg,
          });
          streamedFuncCalls.length = 0;
          streamedFuncCalls.push(...normalizedStreamedFuncCalls);

          const currentRoundFunctionCallGenseqs: number[] = [];
          for (const call of streamedFuncCalls) {
            const rawCallGenseq = call.genseq;
            if (!Number.isFinite(rawCallGenseq) || rawCallGenseq <= 0) continue;
            const callGenseq = Math.floor(rawCallGenseq);
            if (call.name !== 'answerHuman') {
              currentRoundFunctionCallGenseqs.push(callGenseq);
              if (lastFunctionCallGenseq === null || callGenseq > lastFunctionCallGenseq) {
                lastFunctionCallGenseq = callGenseq;
              }
            }
          }
          const userInterjectionMsgIdForVisibleAnswer =
            currentPrompt?.origin === 'user' && !isQ4HAnswerPrompt
              ? currentPrompt.msgId
              : currentGenerationBelongsToUserToolChain
                ? currentUserPromptMsgId
                : undefined;

          let routed = await executeFunctionRound({
            dlg,
            agent,
            agentTools,
            funcCalls: streamedFuncCalls,
            callbacks,
            abortSignal,
            allowTellaskFunctions: policy.allowTellaskFunctions,
            activePromptReplyDirective: currentPrompt?.tellaskReplyDirective,
            contextHealthForToolResultVisibility: pickContextHealthForLargeToolResultVisibility({
              previous: contextHealthBeforeGen,
              current: contextHealthForGen,
            }),
          });
          for (const answering of routed.answerHumanOutputs) {
            lastAssistantAnsweringContent = answering.answerContent;
            lastAssistantAnsweringGenseq = answering.genseq;
          }
          const currentRoundAnsweringGenseq = dlg.activeGenSeqOrUndefined;
          const hasCurrentRoundAnsweringOutput =
            currentRoundAnsweringGenseq !== undefined &&
            lastAssistantAnsweringGenseq === currentRoundAnsweringGenseq;
          let pendingVisibleUserInterjectionAnswer:
            | VisibleUserInterjectionAnswerCandidate
            | undefined;
          if (
            userInterjectionMsgIdForVisibleAnswer !== undefined &&
            !hasCurrentRoundAnsweringOutput
          ) {
            const streamedCurrentRoundSayingContent =
              batchOutputs.length === 0 &&
              lastAssistantSayingGenseq !== previousAssistantSayingGenseq
                ? lastAssistantSayingContent
                : null;
            const streamedCurrentRoundSayingGenseq =
              batchOutputs.length === 0 &&
              lastAssistantSayingGenseq !== previousAssistantSayingGenseq
                ? lastAssistantSayingGenseq
                : null;
            pendingVisibleUserInterjectionAnswer = {
              userPromptMsgId: userInterjectionMsgIdForVisibleAnswer,
              assistantSayingContent:
                currentRoundAssistantSayingContent ?? streamedCurrentRoundSayingContent,
              assistantSayingGenseq:
                currentRoundAssistantSayingGenseq ?? streamedCurrentRoundSayingGenseq,
              functionCallGenseqs: currentRoundFunctionCallGenseqs,
            };
          }
          const settleVisibleUserInterjectionAnswer = async (
            recordAnswerToHuman: boolean,
          ): Promise<void> => {
            const pendingAnswer = pendingVisibleUserInterjectionAnswer;
            if (pendingAnswer === undefined) {
              return;
            }
            pendingVisibleUserInterjectionAnswer = undefined;
            await maybeResolveAnsweredUserInterjection({
              dlg,
              ...pendingAnswer,
              recordAnswerToHuman,
            });
          };
          if (routed.tellaskToolOutputs.length > 0) {
            newMsgs.push(...routed.tellaskToolOutputs);
          }
          if (routed.pairedMessages.length > 0) {
            newMsgs.push(...routed.pairedMessages);
          }
          await dlg.addChatMessages(...newMsgs);

          const repeatedToolCallInspection = inspectRepeatedToolCallRound({
            state: repeatedToolCallMonitor,
            currentCourse: dlg.activeGenCourseOrUndefined ?? dlg.currentCourse,
            pairedMessages: routed.pairedMessages,
            language: getWorkLanguage(),
          });
          if (repeatedToolCallInspection !== undefined) {
            if (repeatedToolCallInspection.repeatedAfterReminder) {
              const detail = formatRepeatedToolCallStoppedDetail({
                language: getWorkLanguage(),
                toolName: repeatedToolCallInspection.toolName,
                callIds: repeatedToolCallInspection.callIds,
              });
              log.error(
                'kernel-driver stopped after repeated identical tool calls ignored guidance',
                undefined,
                {
                  rootId: dlg.id.rootId,
                  selfId: dlg.id.selfId,
                  course: dlg.activeGenCourseOrUndefined ?? dlg.currentCourse,
                  genseq: dlg.activeGenSeq,
                  toolName: repeatedToolCallInspection.toolName,
                  callIds: repeatedToolCallInspection.callIds,
                },
              );
              await dlg.streamError(detail);
              throw new LlmStreamErrorEmittedError({
                detail,
                i18nStopReason: buildHumanSystemStopReasonTextI18n({ detail }),
              });
            }
            await persistAndEmitRuntimeGuide(dlg, repeatedToolCallInspection.reminderContent);
            repeatedToolCallMonitor.lastReminderGenseq = dlg.activeGenSeq;
            repeatedToolCallMonitor.sequence = undefined;
            routed = {
              ...routed,
              repeatedToolCallReminderCallIds: repeatedToolCallInspection.callIds,
            };
          }

          const persistedFbrState = await loadDialogFbrState(dlg);
          if (persistedFbrState) {
            if (persistedFbrState.phase === 'finalization') {
              const inspection = inspectFbrConclusionAttempt(newMsgs);
              if (inspection.kind === 'accepted') {
                log.debug('kernel-driver accepted FBR conclusion attempt', undefined, {
                  dialogId: dlg.id.valueOf(),
                  toolName: inspection.toolName,
                  callId: inspection.callId,
                });
                fbrConclusion = {
                  responseText: inspection.content,
                  responseGenseq: inspection.genseq,
                  replyResolutionCallId: `fbr-conclusion-${inspection.callId}`,
                };
                if (!isFbrSideDialog(dlg)) {
                  throw new Error(
                    `kernel-driver FBR invariant violation: persisted FBR state on non-FBR dialog (${dlg.id.valueOf()})`,
                  );
                }
                await persistDialogFbrState(dlg, undefined);
                dlg.setFbrConclusionToolsEnabled(false);
                await settleVisibleUserInterjectionAnswer(false);
                break;
              }
              if (inspection.kind === 'rejected') {
                const detail = `FBR conclusion attempt rejected: ${inspection.reason}`;
                await dlg.streamError(detail);
                log.warn(detail, undefined, {
                  rootId: dlg.id.rootId,
                  selfId: dlg.id.selfId,
                });
              }
            }

            const nextFbrState = advanceFbrState(persistedFbrState);
            if (nextFbrState) {
              if (!isFbrSideDialog(dlg)) {
                throw new Error(
                  `kernel-driver FBR invariant violation: persisted FBR state on non-FBR dialog (${dlg.id.valueOf()})`,
                );
              }
              await persistDialogFbrState(dlg, nextFbrState);
              dlg.setFbrConclusionToolsEnabled(isFbrFinalizationState(nextFbrState));
              pendingPrompt = buildKernelDriverFbrPrompt(dlg, nextFbrState);
              await settleVisibleUserInterjectionAnswer(true);
              continue;
            }

            fbrConclusion = {
              responseText: buildProgrammaticFbrUnreasonableSituationContent({
                language: getWorkLanguage(),
                finalizationAttempts: persistedFbrState.effort,
              }),
              responseGenseq: resolveProgrammaticFbrConclusionGenseq({
                dlg,
                lastAssistantSayingGenseq,
                lastFunctionCallGenseq,
              }),
              replyResolutionCallId: `fbr-conclusion-${generateShortId()}`,
            };
            if (!isFbrSideDialog(dlg)) {
              throw new Error(
                `kernel-driver FBR invariant violation: persisted FBR state on non-FBR dialog (${dlg.id.valueOf()})`,
              );
            }
            await persistDialogFbrState(dlg, undefined);
            dlg.setFbrConclusionToolsEnabled(false);
            await settleVisibleUserInterjectionAnswer(false);
            break;
          }

          if (routed.shouldStopAfterReplyTool) {
            lastToolRoundStopDiagnostics = buildToolRoundStopDiagnostics({
              dlg,
              streamedFuncCalls,
              routed,
              lastBusinessContinuation,
              shouldStartImmediatePostToolGeneration: false,
              stopReason: 'reply_tool',
            });
            log.debug('kernel-driver stop round after explicit replyTellask* tool', undefined, {
              dialogId: dlg.id.valueOf(),
              toolNames: streamedFuncCalls
                .filter(
                  (call) =>
                    call.name === 'replyTellask' ||
                    call.name === 'replyTellaskSessionless' ||
                    call.name === 'replyTellaskBack',
                )
                .map((call) => call.name),
            });
            await settleVisibleUserInterjectionAnswer(false);
            break;
          }

          const queuedNewCoursePrompt = await consumeQueuedNewCourseRuntimePromptForSameDrive(dlg);
          if (queuedNewCoursePrompt !== undefined) {
            pendingPrompt = queuedNewCoursePrompt;
            skipTaskdocForThisDrive = false;
            await settleVisibleUserInterjectionAnswer(true);
            continue;
          }

          // Start an immediate post-tool generation only when this round produced tool outputs that
          // warrant same-drive LLM reaction right away. Provider-native side-channel UI events are
          // meaningful output, but they are not transcript/context inputs and therefore must not
          // trigger another immediate generation round by themselves.
          const shouldStartImmediatePostToolGeneration =
            routed.hasImmediateFollowupToolCalls ||
            routed.hasImmediateTellaskOutputs ||
            routed.repeatedToolCallReminderCallIds.length > 0 ||
            invalidFuncCallCount > 0;
          if (shouldStartImmediatePostToolGeneration) {
            const expectation = buildImmediateFollowupTriggerExpectation({
              dlg,
              routed,
              invalidFuncCallCount,
              streamedFuncCalls,
              continuation: currentBusinessContinuation,
            });
            if (expectation === undefined) {
              throw new Error(
                `Immediate follow-up trigger invariant violation: expected trigger reasons missing ` +
                  `(dialog=${dlg.id.valueOf()}, course=${String(dlg.activeGenCourseOrUndefined ?? dlg.currentCourse)}, ` +
                  `genseq=${String(dlg.activeGenSeq)}, immediateToolCalls=${String(routed.hasImmediateFollowupToolCalls)}, ` +
                  `immediateTellaskOutputs=${String(routed.hasImmediateTellaskOutputs)}, ` +
                  `repeatedToolCallReminderCallIds=${routed.repeatedToolCallReminderCallIds.join('+')}, ` +
                  `invalidFuncCallCount=${String(invalidFuncCallCount)})`,
              );
            }
            immediateFollowupTriggerExpectation = expectation;
            await upsertImmediateFollowupTrigger(dlg, immediateFollowupTriggerExpectation);
          }

          if (dlg.hasQueuedPrompt()) {
            lastToolRoundStopDiagnostics = buildToolRoundStopDiagnostics({
              dlg,
              streamedFuncCalls,
              routed,
              lastBusinessContinuation,
              shouldStartImmediatePostToolGeneration,
              stopReason: 'queued_prompt_after_tool_round',
              queuedPromptAfterToolRound: true,
              remindersVer: dlg.remindersVer,
              pubRemindersVer,
            });
            await settleVisibleUserInterjectionAnswer(true);
            break;
          }

          if (dlg.remindersVer > pubRemindersVer) {
            await dlg.processReminderUpdates();
            pubRemindersVer = dlg.remindersVer;
          }

          // Tool execution may have created pending Q4H mid-round. Pending tellask sideDialogs are
          // background work, so only Q4H can suspend this same-drive continuation point.
          const suspensionAfterToolRound = await dlg.getSuspensionStatus();
          if (!suspensionAfterToolRound.canDrive) {
            lastToolRoundStopDiagnostics = buildToolRoundStopDiagnostics({
              dlg,
              streamedFuncCalls,
              routed,
              lastBusinessContinuation,
              shouldStartImmediatePostToolGeneration,
              stopReason: 'suspended_after_tool_round',
              suspensionAfterToolRound,
              queuedPromptAfterToolRound: dlg.hasQueuedPrompt(),
              remindersVer: dlg.remindersVer,
              pubRemindersVer,
            });
            await preserveDiligenceBudgetAcrossQ4H(dlg);
            await settleVisibleUserInterjectionAnswer(false);
            break;
          }

          if (!shouldStartImmediatePostToolGeneration) {
            if (routed.shouldStopAfterPendingTellaskWait) {
              lastToolRoundStopDiagnostics = buildToolRoundStopDiagnostics({
                dlg,
                streamedFuncCalls,
                routed,
                lastBusinessContinuation,
                shouldStartImmediatePostToolGeneration,
                stopReason: 'pending_tellask_wait',
                suspensionAfterToolRound,
                queuedPromptAfterToolRound: dlg.hasQueuedPrompt(),
                remindersVer: dlg.remindersVer,
                pubRemindersVer,
              });
              log.debug('kernel-driver stop round after pending tellask wait boundary', undefined, {
                dialogId: dlg.id.valueOf(),
                rootId: dlg.id.rootId,
                selfId: dlg.id.selfId,
              });
              await settleVisibleUserInterjectionAnswer(false);
              break;
            }
            const healthFirst = await maybeContinueWithHealthPromptBeforeDiligence({
              dlg,
              providerCfg,
              model,
            });
            if (healthFirst.kind === 'health_continue') {
              pendingPrompt = healthFirst.prompt;
              if (healthFirst.resetTaskdoc) {
                skipTaskdocForThisDrive = false;
              }
              await settleVisibleUserInterjectionAnswer(true);
              continue;
            }
            const next = await maybeContinueWithDiligencePrompt({
              dlg,
              team,
              suppressDiligencePushForDrive: suppressDiligencePushForDrive,
            });
            if (next.kind === 'continue') {
              pendingPrompt = next.prompt;
              await settleVisibleUserInterjectionAnswer(true);
              continue;
            }
            lastToolRoundStopDiagnostics = buildToolRoundStopDiagnostics({
              dlg,
              streamedFuncCalls,
              routed,
              lastBusinessContinuation,
              shouldStartImmediatePostToolGeneration,
              stopReason: 'no_post_tool_continuation',
              suspensionAfterToolRound,
              queuedPromptAfterToolRound: dlg.hasQueuedPrompt(),
              remindersVer: dlg.remindersVer,
              pubRemindersVer,
            });
            await settleVisibleUserInterjectionAnswer(false);
            break;
          }
          await repairMissingImmediateFollowupTrigger({
            dlg,
            expectation: immediateFollowupTriggerExpectation,
            checkPoint: 'before_immediate_post_tool_generation_continue',
          });
          resolvingImmediateToolResultForUserPrompt =
            currentGenerationBelongsToUserPrompt ||
            currentGenerationBelongsToUserToolChain ||
            isUserOriginPrompt(currentPrompt);
          resolvingImmediateToolResultUserPromptMsgId = resolvingImmediateToolResultForUserPrompt
            ? currentUserPromptMsgId
            : undefined;
          await settleVisibleUserInterjectionAnswer(true);
          continue;
        } catch (err) {
          generationBodyError = err;
          throw err;
        } finally {
          try {
            if (generationBodyError === undefined) {
              await repairMissingImmediateFollowupTrigger({
                dlg,
                expectation: immediateFollowupTriggerExpectation,
                checkPoint: 'before_notify_generating_finish',
              });
            }
            await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
          } catch (finishErr) {
            if (generationBodyError !== undefined) {
              const combinedError = new Error(
                `kernel-driver generation finish failed after generation body error ` +
                  `(dialog=${dlg.id.valueOf()}, genseq=${String(dlg.activeGenSeqOrUndefined)})`,
              );
              (
                combinedError as Error & {
                  cause: { generationBodyError: unknown; finishErr: unknown };
                }
              ).cause = { generationBodyError, finishErr };
              throw combinedError;
            }
            throw finishErr;
          }
        }
      }

      throwIfAborted(abortSignal, dlg);
      finalDisplayState = await computeIdleDisplayState(dlg);
      break driveCoreLoop;
    } catch (err) {
      if (err instanceof LlmRetryStoppedError && retryStoppedRecoveryPrompt !== undefined) {
        pendingPrompt = retryStoppedRecoveryPrompt;
        retryStoppedRecoveryPrompt = undefined;
        continue driveCoreLoop;
      }
      retryStoppedRecoveryPrompt = undefined;

      const stopRequested = getStopRequestedReason(dlg.id);
      const interruptedReason: DialogInterruptionReason | undefined =
        err instanceof LlmRetryStoppedError
          ? err.reason
          : err instanceof KernelDriverInterruptedError
            ? err.reason
            : abortSignal.aborted
              ? stopRequested === 'emergency_stop'
                ? { kind: 'emergency_stop' }
                : stopRequested === 'user_stop'
                  ? { kind: 'user_stop' }
                  : buildAbortedSystemStopReason()
              : undefined;

      if (interruptedReason) {
        finalDisplayState = {
          kind: 'stopped',
          reason: interruptedReason,
          continueEnabled: resolveStoppedContinueEnabled(interruptedReason),
        };
        broadcastDisplayStateMarker(dlg.id, { kind: 'interrupted', reason: interruptedReason });
      } else {
        const llmRequestFailure = err instanceof LlmRequestFailedError ? err : undefined;
        const emittedStreamError = err instanceof LlmStreamErrorEmittedError ? err : undefined;
        const errText =
          llmRequestFailure?.detail ??
          emittedStreamError?.detail ??
          extractErrorDetails(err).message;
        if (!llmRequestFailure?.streamErrorEmitted && !emittedStreamError) {
          try {
            await dlg.streamError(errText);
          } catch {
            // best-effort
          }
        }
        finalDisplayState = {
          kind: 'stopped',
          reason:
            (llmRequestFailure?.i18nStopReason ?? emittedStreamError?.i18nStopReason) !== undefined
              ? {
                  kind: 'system_stop',
                  detail: errText,
                  i18nStopReason:
                    llmRequestFailure?.i18nStopReason ??
                    emittedStreamError?.i18nStopReason ??
                    buildHumanSystemStopReasonTextI18n({ detail: errText }),
                }
              : {
                  kind: 'system_stop',
                  detail: errText,
                  i18nStopReason: buildHumanSystemStopReasonTextI18n({ detail: errText }),
                },
          continueEnabled: true,
        };
        broadcastDisplayStateMarker(dlg.id, {
          kind: 'interrupted',
          reason:
            (llmRequestFailure?.i18nStopReason ?? emittedStreamError?.i18nStopReason) !== undefined
              ? {
                  kind: 'system_stop',
                  detail: errText,
                  i18nStopReason:
                    llmRequestFailure?.i18nStopReason ??
                    emittedStreamError?.i18nStopReason ??
                    buildHumanSystemStopReasonTextI18n({ detail: errText }),
                }
              : {
                  kind: 'system_stop',
                  detail: errText,
                  i18nStopReason: buildHumanSystemStopReasonTextI18n({ detail: errText }),
                },
        });
      }
      break driveCoreLoop;
    }
  }
  if (!finalDisplayState) {
    try {
      finalDisplayState = await computeIdleDisplayState(dlg);
    } catch (stateErr) {
      log.warn(
        'kernel-driver failed to compute final display-state projection; falling back to idle',
        stateErr,
        {
          dialogId: dlg.id.valueOf(),
        },
      );
      finalDisplayState = { kind: 'idle_waiting_user' };
    }
  }

  if (
    abortSignal.aborted &&
    finalDisplayState.kind !== 'stopped' &&
    finalDisplayState.kind !== 'dead'
  ) {
    const stopRequested = getStopRequestedReason(dlg.id);
    const lateInterruptedReason: DialogInterruptionReason =
      stopRequested === 'emergency_stop'
        ? { kind: 'emergency_stop' }
        : stopRequested === 'user_stop'
          ? { kind: 'user_stop' }
          : buildAbortedSystemStopReason();
    finalDisplayState = {
      kind: 'stopped',
      reason: lateInterruptedReason,
      continueEnabled: resolveStoppedContinueEnabled(lateInterruptedReason),
    };
  }

  let shouldPersistFinalDisplayProjection = true;
  try {
    const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    if (dlg.id.selfId !== dlg.id.rootId && latest?.executionMarker?.kind === 'dead') {
      finalDisplayState = { kind: 'dead', reason: latest.executionMarker.reason };
    } else if (
      finalDisplayState.kind === 'stopped' &&
      latest?.generating === true &&
      !sameOpenGenerationRun(
        latest.generationRunState,
        dlg.activeGenCourseOrUndefined ?? dlg.currentCourse,
        dlg.activeGenSeqOrUndefined,
      )
    ) {
      shouldPersistFinalDisplayProjection = false;
      log.debug(
        'Skipped stale stopped projection from superseded generation to preserve liveness',
        undefined,
        {
          dialogId: dlg.id.valueOf(),
          rootId: dlg.id.rootId,
          selfId: dlg.id.selfId,
          activeCourse: dlg.activeGenCourseOrUndefined ?? dlg.currentCourse,
          activeGenseq: dlg.activeGenSeqOrUndefined ?? null,
          latestGenerationRunState: latest.generationRunState ?? null,
          latestDisplayState: latest.displayState ?? null,
          reason: 'newer_generation_active',
        },
      );
    }
    const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      dlg.id,
      dlg.status,
    );
    try {
      await maybeWriteUnexpectedIdleAfterToolRoundDebugDump({
        dlg,
        finalDisplayState,
        latest,
        diagnostics: lastToolRoundStopDiagnostics,
      });
      await maybeWriteIdleWithActiveReplyObligationDebugDump({
        dlg,
        finalDisplayState,
        latest,
        activeReplyObligation,
      });
    } catch (debugErr) {
      log.warn('kernel-driver failed to write idle debug dump', debugErr, {
        dialogId: dlg.id.valueOf(),
        rootId: dlg.id.rootId,
        selfId: dlg.id.selfId,
        course: lastToolRoundStopDiagnostics?.course ?? null,
        genseq: lastToolRoundStopDiagnostics?.genseq ?? null,
      });
    }
  } catch (err) {
    log.warn('kernel-driver failed to re-check displayState before finalizing', err, {
      dialogId: dlg.id.valueOf(),
    });
  }

  if (shouldPersistFinalDisplayProjection) {
    if (finalDisplayState.kind === 'stopped') {
      await setDialogExecutionMarker(
        dlg.id,
        {
          kind: 'interrupted',
          reason: finalDisplayState.reason,
        },
        dlg.status,
      );
      broadcastDisplayStateMarker(dlg.id, {
        kind: 'interrupted',
        reason: finalDisplayState.reason,
      });
    } else if (finalDisplayState.kind !== 'dead') {
      await clearDialogInterruptedExecutionMarker(dlg.id, dlg.status);
    }
    await setDialogDisplayState(dlg.id, finalDisplayState, dlg.status);
  }
  return {
    lastAssistantSayingContent,
    lastAssistantSayingGenseq,
    lastAssistantThinkingContent,
    lastAssistantThinkingGenseq,
    lastAssistantAnsweringContent,
    lastAssistantAnsweringGenseq,
    lastFunctionCallGenseq,
    lastAssistantReplyTarget,
    lastBusinessContinuation,
    fbrConclusion,
  };
}
