import { DEFAULT_DILIGENCE_PUSH_MAX } from '@longrun-ai/kernel/diligence';
import type { ContextHealthSnapshot, LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type {
  DialogDisplayState,
  DialogInterruptionReason,
  DialogLlmRetryExhaustedReason,
} from '@longrun-ai/kernel/types/display-state';
import {
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toRootGenerationAnchor,
  type DialogFbrState,
  type TellaskAnchorRecord,
  type TellaskCalleeRecord,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp, parseUnifiedTimestampMs } from '@longrun-ai/kernel/utils/time';
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
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatAgentFacingCriticalUserInterjectionRemediationGuide,
  formatDomindsNoteFbrToollessViolation,
  formatNewCourseStartPrompt,
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  type ReminderContextFollowingDialogState,
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
} from '../gen/tool-call-context';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';
import { projectFuncToolsForProvider } from '../tools-projection';
import { assembleDriveContextMessages } from './context';
import {
  consumeCriticalCountdown,
  decideKernelDriverContextHealth,
  KERNEL_DRIVER_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCautionRemediationCadenceGenerations,
  resolveCriticalCountdownRemaining,
} from './context-health';
import { emitThinkingEvents } from './events';
import {
  advanceFbrState,
  buildFbrPromptForState,
  buildProgrammaticFbrUnreasonableSituationContent,
  inspectFbrConclusionAttempt,
  isFbrFinalizationState,
  markFbrPromptDelivered,
} from './fbr';
import {
  buildKernelDriverPolicy,
  resolveKernelDriverPolicyViolationKind,
  validateKernelDriverPolicyInvariants,
  type KernelDriverPolicyState,
} from './guardrails';
import { resolvePromptReplyGuidance } from './reply-guidance';
import {
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
  type TellaskCallFunctionName,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveCallbacks,
  KernelDriverPrompt,
  KernelDriverRuntimeGuidePrompt,
  KernelDriverRuntimeReplyPrompt,
  KernelDriverRuntimeSideDialogPrompt,
  KernelDriverUserPrompt,
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
  await DialogPersistence.mutateDialogLatest(dialog.id, () => ({
    kind: 'patch',
    patch: { fbrState },
  }));
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

function normalizeQ4HAnswerCallId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const callId = raw.trim();
  return callId !== '' ? callId : undefined;
}

function isUserOriginPrompt(prompt: KernelDriverPrompt | undefined): boolean {
  if (!prompt) return false;
  return prompt.origin === 'user' && normalizeQ4HAnswerCallId(prompt.q4hAnswerCallId) === undefined;
}

function resolveReminderContextFollowingDialogState(
  prompt: KernelDriverPrompt | undefined,
  currentTurnDialogMsgsForContext: readonly ChatMessage[],
): ReminderContextFollowingDialogState {
  if (prompt === undefined || currentTurnDialogMsgsForContext.length === 0) return 'none';
  return prompt.origin === 'user' ? 'user_message' : 'runtime_notice';
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
  // in plain text instead of calling askHuman/tellask/reply tools.
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
    description: 'Create or resume a teammate Side Dialog with sessionSlug.',
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
      'Create a one-shot teammate Side Dialog with no assignment-update channel; later tellaskSessionless calls create new dialogs rather than updating or stopping this one.',
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
];

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

function resolveUpNextPrompt(dlg: Dialog): KernelDriverPrompt | undefined {
  const upNext = dlg.takeUpNext();
  if (!upNext) return undefined;
  const normalizedRunControl = (() => {
    const runControl = upNext.runControl;
    if (!runControl) return undefined;
    if (
      runControl.source !== 'drive_dlg_by_user_msg' &&
      runControl.source !== 'drive_dialog_by_user_answer'
    ) {
      return undefined;
    }
    return {
      controlId: runControl.controlId,
      input: runControl.input,
      source: runControl.source,
      q4h: runControl.q4h,
    };
  })();
  const common = {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: upNext.grammar ?? 'markdown',
    ...(upNext.userLanguageCode === undefined ? {} : { userLanguageCode: upNext.userLanguageCode }),
    ...(normalizedRunControl === undefined ? {} : { runControl: normalizedRunControl }),
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
      const prompt: KernelDriverRuntimeGuidePrompt = runtimeCommon;
      return prompt;
    }
  }
}

async function renderRemindersForContext(dlg: Dialog): Promise<ChatMessage[]> {
  const reminders = await dlg.listVisibleReminders();
  if (reminders.length === 0) return [];
  const language = getWorkLanguage();
  const renderedItems: ChatMessage[] = [];
  for (const reminder of reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
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
  return [
    {
      type: 'environment_msg',
      role: 'user',
      content: formatReminderContextGuide(language),
    },
    ...renderedItems,
  ];
}

function hasSameReplyDirective(
  left: KernelDriverPrompt['tellaskReplyDirective'],
  right: KernelDriverPrompt['tellaskReplyDirective'],
): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.expectedReplyCallName !== right.expectedReplyCallName) {
    return false;
  }
  if (
    left.targetDialogId !== right.targetDialogId ||
    left.targetCallId !== right.targetCallId ||
    left.tellaskContent !== right.tellaskContent
  ) {
    return false;
  }
  return true;
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

  const pendingSideDialogs = await DialogPersistence.loadPendingSideDialogs(
    dialog.id,
    dialog.status,
  );
  for (const pending of pendingSideDialogs) {
    const callId = pending.callId.trim();
    if (callId === '') {
      continue;
    }
    pendingByCallId.set(callId, {
      callName: pending.callName,
      startedAtMs: parseUnifiedTimestampMs(pending.createdAt),
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

async function buildDialogMsgsForContext(dlg: Dialog): Promise<ChatMessage[]> {
  const rawDialogMsgsForContext: ChatMessage[] = dlg.msgs.filter((m) => !!m);
  const projected = await projectTellaskFuncResultsForContext({
    dialog: dlg,
    dialogMsgsForContext: rawDialogMsgsForContext,
  });
  const businessFiltered = projected.messages.filter((msg) => {
    return msg.type !== 'tellask_result_msg' || msg.content.trim() !== '';
  });
  const sanitized = sanitizeToolContextForProvider(businessFiltered);
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
  }
  return sanitized.messages;
}

async function emitAssistantSaying(dlg: Dialog, content: string): Promise<void> {
  if (content.trim() === '') return;
  await dlg.sayingStart();
  await dlg.sayingChunk(content);
  await dlg.sayingFinish();
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
      '[Runtime notice] The previous model output contained an invalid tool-call payload that could not be represented as a normal provider tool call in the next generation context.',
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
      'Treat that payload as failed. Do not assume the tool ran. Continue from the current task, and if a tool call is still needed, emit a new valid tool call with a non-empty function name and valid arguments.',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }
  return [
    '[运行时提示] 上一轮模型输出包含一个无效工具调用载荷，无法按正常 provider tool call 形态进入下一轮生成上下文。',
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
    '请把该载荷视为调用失败，不要假设工具已经执行。继续当前任务；如果仍需要调用工具，请重新发起一个函数名非空、参数有效的新工具调用。',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
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
  shouldStopAfterReplyTool: boolean;
  pairedMessages: ChatMessage[];
  tellaskToolOutputs: ChatMessage[];
};

function resolveFuncToolFollowupMode(tool: FuncTool | undefined): FuncToolFollowupMode {
  return tool?.followupMode ?? 'immediate';
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

type ExecutedFuncCallResult = Readonly<{
  func: FuncCallMsg;
  originalFunc: FuncCallMsg;
  outcome: ToolOutcome;
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

async function loadKnownFunctionCallIdsForCurrentCourse(
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
  const events = await DialogPersistence.loadCourseEvents(dialog.id, course, dialog.status);
  for (const event of events) {
    if (event.type === 'func_call_record' || event.type === 'tellask_call_record') {
      addKnown(event.id);
      if (event.type === 'func_call_record') {
        addKnown(event.rawId);
        addKnown(event.effectiveId);
      }
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
    knownCallIds: new Set(await loadKnownFunctionCallIdsForCurrentCourse(args.dialog)),
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

  const functionPromises = preparedCalls.map(
    async ({
      func,
      originalFunc,
      callGenseq,
      argsStr,
      tool,
      preparedInvocationArgs,
    }): Promise<ExecutedFuncCallResult> => {
      throwIfAborted(args.abortSignal, args.dlg);

      let result: FuncResultMsg;
      let outcome: ToolOutcome = 'success';
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
            outcome = output.outcome;
            result = {
              type: 'func_result_msg',
              id: func.id,
              rawId: func.rawId,
              effectiveId: func.effectiveId,
              name: func.name,
              content: output.content,
              contentItems: Array.isArray(output.contentItems)
                ? [...output.contentItems]
                : undefined,
              role: 'tool',
              genseq: callGenseq,
            };
          } catch (err) {
            outcome = 'failure';
            const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            const failureOutput = toolFailure(
              `Function '${func.name}' execution failed: ${errText}`,
            );
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
              const interruptedOutput = toolFailure(
                `Function '${func.name}' interrupted before completion: ${errText}`,
              );
              result = {
                type: 'func_result_msg',
                id: func.id,
                rawId: func.rawId,
                effectiveId: func.effectiveId,
                name: func.name,
                content: interruptedOutput.content,
                role: 'tool',
                genseq: callGenseq,
              };
              rethrowError = err;
            }
          }
        }
      }

      await args.dlg.receiveFuncResult(result);
      if (rethrowError !== undefined) {
        throw rethrowError;
      }
      return { func, originalFunc, outcome, result };
    },
  );

  return await Promise.all(functionPromises);
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
}): Promise<RoutedFunctionResult> {
  if (args.funcCalls.length === 0) {
    return {
      hasImmediateFollowupToolCalls: false,
      shouldStopAfterReplyTool: false,
      pairedMessages: [],
      tellaskToolOutputs: [],
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

  const genericExecutions = await executeFunctionCalls({
    dlg: args.dlg,
    agent: args.agent,
    agentTools: args.agentTools,
    funcCalls: tellaskRound.normalCalls,
    abortSignal: args.abortSignal,
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
  const hasImmediateFollowupToolCalls = tellaskRound.normalCalls.some((call) => {
    const tool = funcToolByName.get(call.name);
    const outcome = genericOutcomeByCallId.get(call.id);
    if (outcome === undefined) {
      throw new Error(
        `kernel-driver function outcome invariant violation: missing outcome for call id '${call.id}' (${call.name})`,
      );
    }
    return shouldImmediatelyFollowUpToolOutcome(tool, outcome);
  });

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
    shouldStopAfterReplyTool: tellaskRound.shouldStopAfterReplyTool,
    pairedMessages,
    tellaskToolOutputs: [...tellaskRound.toolOutputs],
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
    void DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
    }));
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
  allowPendingSideDialogs?: boolean;
  ignoreBudgetExhaustion?: boolean;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: KernelDriverPrompt }> {
  const {
    dlg,
    team,
    suppressDiligencePushForDrive,
    allowPendingSideDialogs,
    ignoreBudgetExhaustion,
  } = args;

  const suspension = await dlg.getSuspensionStatus({
    allowPendingSideDialogs: allowPendingSideDialogs === true,
  });
  if (!suspension.canDrive) {
    if (suspension.q4h && dlg instanceof MainDialog) {
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
    void DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
    }));
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
    return { kind: 'continue', prompt: prepared.prompt };
  }

  return { kind: 'break' };
}

async function maybePrepareRetryStoppedRecoveryPrompt(args: {
  dlg: Dialog;
  team: Team;
  suppressDiligencePushForDrive: boolean;
  reason: DialogLlmRetryExhaustedReason;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: KernelDriverPrompt }> {
  if (args.reason.recoveryAction.kind !== 'diligence_push_once') {
    return { kind: 'break' };
  }
  return await maybeContinueWithDiligencePrompt({
    dlg: args.dlg,
    team: args.team,
    suppressDiligencePushForDrive: args.suppressDiligencePushForDrive,
    // `diligence_push_once` is a provider-quirk deadlock breaker rather than the ordinary
    // "dialog is about to go idle" auto-continue path. In practice this can happen in a
    // function-result-driven generation round right after the main dialog has already registered
    // a pending tellask/sideDialog, or after the normal Diligence Push budget has been exhausted.
    // Keep Q4H / explicit disable as hard blockers, but do not let pending sideDialogs or the
    // ordinary keep-going budget veto this one-time recovery injection or the same-context
    // deadlock cannot be broken.
    allowPendingSideDialogs: true,
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
    await dlg.startNewCourse(newCoursePrompt);
    dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
    resetContextHealthRoundState(dlg.id.key());

    const nextPrompt = resolveUpNextPrompt(dlg);
    if (!nextPrompt) {
      throw new Error(
        `kernel-driver critical force-new-course invariant violation: missing upNext prompt after startNewCourse for dialog=${dlg.id.valueOf()}`,
      );
    }
    return { kind: 'health_continue', prompt: nextPrompt, resetTaskdoc: true };
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
  let criticalUserInterjectionRuntimeGuide = driveOptions?.criticalUserInterjectionRuntimeGuide;
  let lastAssistantSayingContent: string | null = null;
  let lastAssistantSayingGenseq: number | null = null;
  let lastAssistantThinkingContent: string | null = null;
  let lastAssistantThinkingGenseq: number | null = null;
  let lastFunctionCallGenseq: number | null = null;
  let lastAssistantReplyTarget: KernelDriverPrompt['sideDialogReplyTarget'] | undefined;
  let fbrConclusion:
    | {
        responseText: string;
        responseGenseq: number;
        replyResolutionCallId: string;
      }
    | undefined;
  let pubRemindersVer = dlg.remindersVer;

  let pendingPrompt: KernelDriverPrompt | undefined = humanPrompt;
  let resolvingImmediateToolResultForUserPrompt = false;
  let resolvingImmediateToolResultUserPromptMsgId: string | undefined;
  let criticalRemediationAppliedUserPromptMsgId =
    driveOptions?.criticalUserInterjectionRuntimeGuide !== undefined &&
    humanPrompt?.origin === 'user'
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

        const activeFbrState = await loadDialogFbrState(dlg);
        if (isFbrSideDialog(dlg)) {
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
          const hasQueuedUpNext = dlg.hasUpNext() || pendingPrompt !== undefined;
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
              criticalRemediationAppliedUserPromptMsgId !== undefined &&
              criticalRemediationAppliedUserPromptMsgId === currentUserPromptMsgId,
            canInjectPromptThisGen: !hasQueuedUpNext,
            cautionRemediationCadenceGenerations,
            criticalCountdownRemaining,
          });

          if (healthDecision.kind === 'continue') {
            if (healthDecision.reason === 'critical_force_new_course') {
              const language = getWorkLanguage();
              const newCoursePrompt = formatNewCourseStartPrompt(language, {
                nextCourse: dlg.currentCourse + 1,
                source: 'critical_auto_clear',
              });
              await dlg.startNewCourse(newCoursePrompt);
              dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
              resetContextHealthRoundState(dlg.id.key());

              const nextPrompt = resolveUpNextPrompt(dlg);
              if (!nextPrompt) {
                throw new Error(
                  `kernel-driver critical force-new-course invariant violation: missing upNext prompt after startNewCourse for dialog=${dlg.id.valueOf()}`,
                );
              }
              pendingPrompt = nextPrompt;
              skipTaskdocForThisDrive = false;
            } else if (healthDecision.reason === 'critical_user_prompt_remediation') {
              const language = getWorkLanguage();
              const dialogScope = dlg instanceof SideDialog ? 'sideDialog' : 'mainDialog';
              criticalUserInterjectionRuntimeGuide =
                formatAgentFacingCriticalUserInterjectionRemediationGuide(language, {
                  dialogScope,
                  promptsRemainingAfterThis: consumeCriticalCountdown(dlg.id.key()),
                });
              criticalRemediationAppliedUserPromptMsgId = currentUserPromptMsgId;
            } else if (!hasQueuedUpNext) {
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
        const currentReplyTarget = currentPrompt?.sideDialogReplyTarget;
        const currentFbrState = await loadDialogFbrState(dlg);
        let currentRuntimeGuideMsg:
          | Extract<ChatMessage, { type: 'transient_guide_msg' }>
          | undefined;
        const currentPromptFromFbrState =
          currentPrompt !== undefined &&
          currentFbrState !== undefined &&
          currentFbrState.promptDelivered !== true;
        pendingPrompt = undefined;

        await dlg.notifyGeneratingStart(currentPrompt?.msgId);
        try {
          if (criticalUserInterjectionRuntimeGuide !== undefined) {
            await persistAndEmitRuntimeGuide(dlg, criticalUserInterjectionRuntimeGuide);
            criticalUserInterjectionRuntimeGuide = undefined;
          }
          if (currentPrompt) {
            const origin = currentPrompt.origin;
            if (
              origin === 'diligence_push' &&
              (dlg.disableDiligencePush || suppressDiligencePushForDrive)
            ) {
              log.debug('kernel-driver skip diligence prompt after disable toggle', undefined, {
                dialogId: dlg.id.valueOf(),
                msgId: currentPrompt.msgId,
              });
              break;
            }

            if (currentPrompt.skipTaskdoc === true) {
              skipTaskdocForThisDrive = true;
            }

            const persistedUserLanguageCode =
              currentPrompt.userLanguageCode ?? dlg.getLastUserLanguageCode();
            const q4hAnswerCallId = normalizeQ4HAnswerCallId(currentPrompt.q4hAnswerCallId);
            // `q4hAnswerCallId` marks a continuation input for an already-materialized askHuman
            // answer. It is not a second business-level user prompt that should re-enter transcript.
            const isQ4HAnswerPrompt = q4hAnswerCallId !== undefined;
            const promptLanguage =
              persistedUserLanguageCode === 'zh' || persistedUserLanguageCode === 'en'
                ? persistedUserLanguageCode
                : getWorkLanguage();
            const replyGuidance = await resolvePromptReplyGuidance({
              dlg,
              prompt: currentPrompt,
              language: promptLanguage,
            });
            if (
              currentPrompt.origin === 'user' &&
              replyGuidance.suppressInterDialogReplyGuidance &&
              replyGuidance.deferredReplyReassertionDirective !== undefined
            ) {
              // WARNING:
              // User interjection suppression is a reversible state transition, not a one-shot
              // latch. The normal cycle is:
              // - user interjects -> suppress reply obligation
              // - operator clicks Continue -> restore reply obligation
              // - user interjects again -> suppress it again
              //
              // Therefore a repeated interjection after a blocked Continue MUST re-arm the deferred
              // state and re-materialize the suppression guide, even when the underlying reply
              // directive itself did not change.
              const existingDeferredReplyReassertion =
                await DialogPersistence.getDeferredReplyReassertion(dlg.id, dlg.status);
              const nextDeferredReplyReassertion = {
                reason: 'user_interjection_with_parked_original_task' as const,
                directive: replyGuidance.deferredReplyReassertionDirective,
              };
              const mustRearmDeferredReplyReassertion =
                existingDeferredReplyReassertion === undefined ||
                existingDeferredReplyReassertion.resumeGuideSurfaced === true ||
                !hasSameReplyDirective(
                  existingDeferredReplyReassertion.directive,
                  nextDeferredReplyReassertion.directive,
                );
              if (mustRearmDeferredReplyReassertion) {
                await DialogPersistence.setDeferredReplyReassertion(
                  dlg.id,
                  nextDeferredReplyReassertion,
                  dlg.status,
                );
              }
              if (mustRearmDeferredReplyReassertion) {
                currentRuntimeGuideMsg = replyGuidance.transientGuideContent
                  ? {
                      type: 'transient_guide_msg',
                      role: 'assistant',
                      content: replyGuidance.transientGuideContent,
                    }
                  : undefined;
              }
            } else if (
              currentPrompt.origin === 'user' &&
              !replyGuidance.suppressInterDialogReplyGuidance
            ) {
              await DialogPersistence.setDeferredReplyReassertion(dlg.id, undefined, dlg.status);
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
            const renderPromptAsRuntimeGuideBubble =
              origin === 'runtime' &&
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
                origin,
                persistedUserLanguageCode,
                q4hAnswerCallId,
                replyGuidance.persistedTellaskReplyDirective,
                currentPrompt.contentItems,
              );
              await DialogPersistence.clearPendingCourseStartPrompt(
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
                origin,
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
            const replyTarget = currentPrompt.sideDialogReplyTarget;
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
              if (dlg instanceof SideDialog) {
                const ownerDialogId = new DialogID(replyTarget.ownerDialogId, dlg.id.rootId);
                const ownerDialogStatus =
                  ownerDialogId.selfId === dlg.mainDialog.id.selfId
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
                  ownerDialogId,
                  replyTarget.callSiteCourse,
                  calleeRecord,
                  ownerDialogStatus,
                );
                postDialogEventById(ownerDialogId, {
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
                      resolveReminderContextFollowingDialogState(
                        currentPrompt,
                        splitDialogMsgs.currentTurnDialogMsgsForContext,
                      ),
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
              thinkingFinish: async (reasoning) => {
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
                await dlg.thinkingFinish(reasoning);
                if (currentThinkingContent.length > 0 || currentThinkingReasoning !== undefined) {
                  const thinkingMessage: ThinkingMsg = {
                    type: 'thinking_msg',
                    role: 'assistant',
                    genseq: dlg.activeGenSeq,
                    content: currentThinkingContent,
                    reasoning: currentThinkingReasoning,
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
            return { usage: res.usage, llmGenModel: res.llmGenModel };
          };

          const llmOutput = await streamOrBatch();
          if (typeof llmOutput.llmGenModel === 'string' && llmOutput.llmGenModel.trim() !== '') {
            llmGenModelForGen = llmOutput.llmGenModel.trim();
          }

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
                lastFunctionCallGenseq,
                lastAssistantReplyTarget,
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

          for (const call of streamedFuncCalls) {
            const rawCallGenseq = call.genseq;
            if (!Number.isFinite(rawCallGenseq) || rawCallGenseq <= 0) continue;
            const callGenseq = Math.floor(rawCallGenseq);
            if (lastFunctionCallGenseq === null || callGenseq > lastFunctionCallGenseq) {
              lastFunctionCallGenseq = callGenseq;
            }
          }

          const routed = await executeFunctionRound({
            dlg,
            agent,
            agentTools,
            funcCalls: streamedFuncCalls,
            callbacks,
            abortSignal,
            allowTellaskFunctions: policy.allowTellaskFunctions,
            activePromptReplyDirective: currentPrompt?.tellaskReplyDirective,
          });
          if (routed.tellaskToolOutputs.length > 0) {
            newMsgs.push(...routed.tellaskToolOutputs);
          }
          if (routed.pairedMessages.length > 0) {
            newMsgs.push(...routed.pairedMessages);
          }
          await dlg.addChatMessages(...newMsgs);

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
              continue;
            }

            fbrConclusion = {
              responseText: buildProgrammaticFbrUnreasonableSituationContent({
                language: getWorkLanguage(),
                finalizationAttempts: persistedFbrState.effort,
              }),
              responseGenseq:
                lastAssistantSayingGenseq ??
                lastFunctionCallGenseq ??
                dlg.activeGenSeqOrUndefined ??
                1,
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

          if (routed.shouldStopAfterReplyTool) {
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
            break;
          }

          if (dlg.hasUpNext()) {
            pendingPrompt = resolveUpNextPrompt(dlg);
            continue;
          }

          if (dlg.remindersVer > pubRemindersVer) {
            await dlg.processReminderUpdates();
            pubRemindersVer = dlg.remindersVer;
          }

          // Tool execution may have created pending Q4H/sideDialogs mid-round. Respect the
          // dialog's actual suspension state here so auto-continue is decided in one place.
          const suspensionAfterToolRound = await dlg.getSuspensionStatus({
            allowPendingSideDialogs: routed.hasImmediateFollowupToolCalls,
          });
          if (!suspensionAfterToolRound.canDrive) {
            await preserveDiligenceBudgetAcrossQ4H(dlg);
            break;
          }

          // Start an immediate post-tool generation only when this round produced tool outputs that
          // warrant same-drive LLM reaction right away. Provider-native side-channel UI events are
          // meaningful output, but they are not transcript/context inputs and therefore must not
          // trigger another immediate generation round by themselves.
          const shouldStartImmediatePostToolGeneration =
            routed.hasImmediateFollowupToolCalls ||
            routed.tellaskToolOutputs.length > 0 ||
            invalidFuncCallCount > 0;
          if (!shouldStartImmediatePostToolGeneration) {
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
              continue;
            }
            const next = await maybeContinueWithDiligencePrompt({
              dlg,
              team,
              suppressDiligencePushForDrive: suppressDiligencePushForDrive,
            });
            if (next.kind === 'continue') {
              pendingPrompt = next.prompt;
              continue;
            }
            break;
          }
          if (shouldStartImmediatePostToolGeneration) {
            resolvingImmediateToolResultForUserPrompt =
              currentGenerationBelongsToUserPrompt ||
              currentGenerationBelongsToUserToolChain ||
              isUserOriginPrompt(currentPrompt);
            resolvingImmediateToolResultUserPromptMsgId = resolvingImmediateToolResultForUserPrompt
              ? currentUserPromptMsgId
              : undefined;
            continue;
          }
        } finally {
          await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
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
    broadcastDisplayStateMarker(dlg.id, { kind: 'interrupted', reason: lateInterruptedReason });
  }

  try {
    const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
    if (dlg.id.selfId !== dlg.id.rootId && latest?.executionMarker?.kind === 'dead') {
      finalDisplayState = { kind: 'dead', reason: latest.executionMarker.reason };
    }
  } catch (err) {
    log.warn('kernel-driver failed to re-check displayState before finalizing', err, {
      dialogId: dlg.id.valueOf(),
    });
  }

  if (finalDisplayState.kind === 'stopped') {
    await setDialogExecutionMarker(dlg.id, {
      kind: 'interrupted',
      reason: finalDisplayState.reason,
    });
  } else if (finalDisplayState.kind !== 'dead') {
    await clearDialogInterruptedExecutionMarker(dlg.id);
  }
  await setDialogDisplayState(dlg.id, finalDisplayState);

  return {
    lastAssistantSayingContent,
    lastAssistantSayingGenseq,
    lastAssistantThinkingContent,
    lastAssistantThinkingGenseq,
    lastFunctionCallGenseq,
    lastAssistantReplyTarget,
    fbrConclusion,
  };
}
