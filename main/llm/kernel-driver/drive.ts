import { DEFAULT_DILIGENCE_PUSH_MAX } from '@longrun-ai/kernel/diligence';
import type { ContextHealthSnapshot, LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import {
  toRootGenerationAnchor,
  type TellaskCallAnchorRecord,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { Dialog, RootDialog, SubDialog } from '../../dialog';
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
import { postDialogEvent } from '../../evt-registry';
import { extractErrorDetails, log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatDomindsNoteFbrToollessViolation,
  formatNewCourseStartPrompt,
  formatReminderItemGuide,
} from '../../runtime/driver-messages';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import {
  computeReminderNoByIndex,
  reminderEchoBackEnabled,
  type FuncTool,
  type Tool,
  type ToolArguments,
  type ToolCallOutput,
} from '../../tool';
import { formatTaskDocContent } from '../../utils/taskdoc';
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
import type { LlmStreamReceiver } from '../gen';
import { getLlmGenerator } from '../gen/registry';
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
import { isFbrConclusionToolName } from './fbr';
import {
  buildKernelDriverPolicy,
  resolveKernelDriverPolicyViolationKind,
  validateKernelDriverPolicyInvariants,
} from './guardrails';
import {
  maybePrepareDiligenceAutoContinuePrompt,
  runLlmRequestWithRetry,
  suspendForKeepGoingBudgetExhausted,
  validateFuncToolArguments,
} from './runtime';
import {
  classifyTellaskSpecialFunctionCalls,
  executeTellaskSpecialCalls,
  isTellaskSpecialFunctionName,
  loadLatestActiveTellaskReplyDirective,
  type TellaskSpecialFunctionName,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveCallbacks,
  KernelDriverHumanPrompt,
} from './types';

type KernelDriverRetryPolicy = Readonly<{
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}>;

const KERNEL_DRIVER_DEFAULT_RETRY_POLICY: KernelDriverRetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

const KERNEL_DRIVER_EMPTY_LLM_RESPONSE_ERROR_CODE = 'DOMINDS_LLM_EMPTY_RESPONSE';

class KernelDriverInterruptedError extends Error {
  public readonly reason: DialogInterruptionReason;

  constructor(reason: DialogInterruptionReason) {
    super('Dialog interrupted');
    this.reason = reason;
  }
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
  throw new KernelDriverInterruptedError({ kind: 'system_stop', detail: 'Aborted.' });
}

function normalizeQ4HAnswerCallIds(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of raw) {
    const callId = value.trim();
    if (callId === '' || seen.has(callId)) continue;
    seen.add(callId);
    normalized.push(callId);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function isUserOriginPrompt(prompt: KernelDriverHumanPrompt | undefined): boolean {
  if (!prompt) return false;
  return prompt.origin === 'user';
}

function resolveModelInfo(providerCfg: ProviderConfig, model: string): ModelInfo | undefined {
  return providerCfg.models[model];
}

function resolveRetryMaxRetries(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.maxRetries;
  }
  const normalized = Math.floor(raw);
  if (normalized < 0) {
    return KERNEL_DRIVER_DEFAULT_RETRY_POLICY.maxRetries;
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
  const maxRetries = resolveRetryMaxRetries(providerCfg.llm_retry_max_retries);
  const initialDelayMs = resolveRetryInitialDelayMs(providerCfg.llm_retry_initial_delay_ms);
  const backoffMultiplier = resolveRetryBackoffMultiplier(providerCfg.llm_retry_backoff_multiplier);
  const maxDelayMs = resolveRetryMaxDelayMs(providerCfg.llm_retry_max_delay_ms);

  return {
    maxRetries,
    initialDelayMs,
    backoffMultiplier,
    maxDelayMs: Math.max(initialDelayMs, maxDelayMs),
  };
}

function hasMeaningfulBatchOutput(messages: readonly ChatMessage[]): boolean {
  for (const msg of messages) {
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
      ? `Runtime default for \`effort\` is current member \`fbr_effort=${fbrDefault}\` when omitted.`
      : 'Runtime default for `effort` is current member `fbr_effort=0` (FBR disabled unless reconfigured).';
  return {
    type: 'func',
    name: 'freshBootsReasoning',
    description:
      'Start an FBR sideline dialog for tool-less fresh-boots reasoning. tellaskContent MUST stay neutral and fact-oriented (Goal/Facts/Constraints/Evidence[/Unknowns]); do not issue analysis directives (for example “from the following dimensions”, “analyze in steps 1..N”, or “N rounds per dimension”). ' +
      fbrDefaultHint,
    parameters: {
      type: 'object',
      properties: {
        tellaskContent: {
          type: 'string',
          description:
            'Use a neutral factual body: Goal/Facts/Constraints/Evidence (optional Unknowns). Avoid dimension checklists and stepwise directives (e.g. “from the following dimensions/aspects”, “analyze in steps 1..N”, “N rounds per dimension”).',
        },
        effort: {
          type: 'integer',
          description: `Optional FBR intensity override (0..100 integer). Runtime maps intensity N to N serial FBR passes in one sideline window. When omitted, runtime defaults to current member fbr_effort=${fbrDefault}.`,
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
    description: 'Ask back to the requester dialog in sideline context.',
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
    description: 'Create or resume a teammate sideline dialog with sessionSlug.',
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
      'Create a one-shot teammate sideline dialog with no assignment-update channel; later tellaskSessionless calls create new dialogs rather than updating or stopping this one.',
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

function mergeTellaskSpecialVirtualTools(
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
  dlg: RootDialog,
  options: { maxInjectCount: number; nextRemainingBudget: number },
): void {
  const maxInjectCount = Math.max(0, Math.floor(options.maxInjectCount));
  const remainingCount = Math.max(0, Math.floor(options.nextRemainingBudget));
  postDialogEvent(dlg, {
    type: 'diligence_budget_evt',
    maxInjectCount,
    injectedCount: Math.max(0, maxInjectCount - remainingCount),
    remainingCount,
    disableDiligencePush: dlg.disableDiligencePush,
  });
}

function resolveUpNextPrompt(dlg: Dialog): KernelDriverHumanPrompt | undefined {
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
  return {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: upNext.grammar ?? 'markdown',
    origin: upNext.origin,
    userLanguageCode: upNext.userLanguageCode,
    q4hAnswerCallIds: upNext.q4hAnswerCallIds,
    tellaskReplyDirective: upNext.tellaskReplyDirective,
    skipTaskdoc: upNext.skipTaskdoc,
    subdialogReplyTarget: upNext.subdialogReplyTarget,
    runControl: normalizedRunControl,
  };
}

async function renderRemindersForContext(dlg: Dialog): Promise<ChatMessage[]> {
  if (dlg.reminders.length === 0) return [];
  const language = getWorkLanguage();
  const reminderNoByIndex = computeReminderNoByIndex(dlg.reminders);
  const rendered: ChatMessage[] = [];
  for (let index = 0; index < dlg.reminders.length; index += 1) {
    const reminder = dlg.reminders[index];
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    const reminderNo = reminderNoByIndex.get(index);
    if (reminderNo === undefined) {
      continue;
    }
    if (reminder.owner) {
      rendered.push(await reminder.owner.renderReminder(dlg, reminder, reminderNo - 1));
      continue;
    }
    rendered.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: formatReminderItemGuide(language, reminderNo, reminder.content, {
        meta: reminder.meta,
      }),
    });
  }
  return rendered;
}

function parseUnifiedTimestampMs(ts: string): number | null {
  const normalized = ts.trim();
  if (normalized === '') {
    return null;
  }
  const parsed = Date.parse(normalized.replace(' ', 'T'));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function formatElapsedSecondsText(startedAtMs: number | null): string {
  const language = getWorkLanguage();
  if (startedAtMs === null) {
    return language === 'zh' ? '未知时长' : 'unknown elapsed time';
  }
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return language === 'zh' ? `${elapsedSec} 秒` : `${elapsedSec}s`;
}

function formatPendingSpecialFuncResult(name: string, startedAtMs: number | null): string {
  const language = getWorkLanguage();
  const elapsed = formatElapsedSecondsText(startedAtMs);
  if (name === 'askHuman') {
    return language === 'zh'
      ? `Q4H 仍在等待人类回复，已持续 ${elapsed}。`
      : `Q4H is still waiting for human reply (elapsed ${elapsed}).`;
  }
  return language === 'zh'
    ? `支线对话仍在进行中，已持续 ${elapsed}。`
    : `Sideline dialog is still running (elapsed ${elapsed}).`;
}

function formatResolvedAskHumanResult(): string {
  return getWorkLanguage() === 'zh'
    ? 'Q4H 已结束等待状态，请参考后续用户消息。'
    : 'Q4H wait is resolved; refer to subsequent user messages.';
}

async function projectTellaskSpecialFuncResultsForContext(args: {
  dialog: Dialog;
  dialogMsgsForContext: readonly ChatMessage[];
}): Promise<ChatMessage[]> {
  const hasSpecialFuncCall = args.dialogMsgsForContext.some(
    (msg) => msg.type === 'func_call_msg' && isTellaskSpecialFunctionName(msg.name),
  );
  if (!hasSpecialFuncCall) {
    return [...args.dialogMsgsForContext];
  }

  const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(
    args.dialog.id,
    args.dialog.status,
  );
  const pendingSubByCallId = new Map<string, { createdAt: string }>();
  for (const pending of pendingSubdialogs) {
    const callId = pending.callId.trim();
    if (callId === '') {
      continue;
    }
    pendingSubByCallId.set(callId, { createdAt: pending.createdAt });
  }

  const pendingQ4H = await DialogPersistence.loadQuestions4HumanState(
    args.dialog.id,
    args.dialog.status,
  );
  const pendingQ4HByCallId = new Map<string, { askedAt: string }>();
  for (const question of pendingQ4H) {
    if (typeof question.callId !== 'string') {
      continue;
    }
    const callId = question.callId.trim();
    if (callId === '') {
      continue;
    }
    pendingQ4HByCallId.set(callId, { askedAt: question.askedAt });
  }

  const settledByCallId = new Map<string, string>();
  const existingSpecialFuncResults = new Map<string, FuncResultMsg>();
  for (const msg of args.dialogMsgsForContext) {
    if (msg.type === 'tellask_result_msg') {
      const callId = typeof msg.callId === 'string' ? msg.callId.trim() : '';
      if (callId !== '') {
        settledByCallId.set(callId, msg.content);
      }
      continue;
    }
    if (msg.type === 'func_result_msg' && isTellaskSpecialFunctionName(msg.name)) {
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
    if (!isTellaskSpecialFunctionName(msg.name)) {
      continue;
    }

    specialCallIds.add(msg.id);
    const settled = settledByCallId.get(msg.id);
    if (settled !== undefined) {
      projected.push({
        type: 'func_result_msg',
        role: 'tool',
        genseq: msg.genseq,
        id: msg.id,
        name: msg.name,
        content: settled,
      });
      continue;
    }

    const existingResult = existingSpecialFuncResults.get(msg.id);
    if (existingResult) {
      projected.push(existingResult);
      continue;
    }

    if (msg.name === 'askHuman') {
      const pendingQ4HState = pendingQ4HByCallId.get(msg.id);
      const content = pendingQ4HState
        ? formatPendingSpecialFuncResult(msg.name, parseUnifiedTimestampMs(pendingQ4HState.askedAt))
        : formatResolvedAskHumanResult();
      projected.push({
        type: 'func_result_msg',
        role: 'tool',
        genseq: msg.genseq,
        id: msg.id,
        name: msg.name,
        content,
      });
      continue;
    }

    const pendingSubState = pendingSubByCallId.get(msg.id);
    projected.push({
      type: 'func_result_msg',
      role: 'tool',
      genseq: msg.genseq,
      id: msg.id,
      name: msg.name,
      content: formatPendingSpecialFuncResult(
        msg.name,
        pendingSubState ? parseUnifiedTimestampMs(pendingSubState.createdAt) : null,
      ),
    });
  }

  return projected;
}

async function buildDialogMsgsForContext(dlg: Dialog): Promise<ChatMessage[]> {
  const rawDialogMsgsForContext: ChatMessage[] = dlg.msgs.filter((m) => {
    if (!m) return false;
    if (m.type === 'ui_only_markdown_msg') return false;
    return true;
  });
  const projected = await projectTellaskSpecialFuncResultsForContext({
    dialog: dlg,
    dialogMsgsForContext: rawDialogMsgsForContext,
  });
  return projected.filter((msg) => msg.type !== 'tellask_result_msg');
}

async function emitAssistantSaying(dlg: Dialog, content: string): Promise<void> {
  if (content.trim() === '') return;
  await dlg.sayingStart();
  await dlg.sayingChunk(content);
  await dlg.sayingFinish();
}

function buildPromptContentWithExactReplyToolName(args: {
  dlg: Dialog;
  prompt: KernelDriverHumanPrompt;
  activeReplyDirective: KernelDriverHumanPrompt['tellaskReplyDirective'];
  language: 'zh' | 'en';
}): string {
  const isFbrSubdialog =
    args.dlg instanceof SubDialog && args.dlg.assignmentFromSup.callName === 'freshBootsReasoning';
  const noActivePrefix =
    args.language === 'zh'
      ? '[Dominds 当前无跨对话回复义务]'
      : '[Dominds no active inter-dialog reply]';
  const activePrefix =
    args.language === 'zh' ? '[Dominds 当前回复工具]' : '[Dominds active reply tool]';
  const reminderPrefixes = ['[Dominds replyTellask required]', '[Dominds 必须调用回复工具]'];
  const directive = args.activeReplyDirective;
  if (!directive) {
    if (isFbrSubdialog) {
      return args.prompt.content;
    }
    if (!(args.dlg instanceof SubDialog)) {
      return args.prompt.content;
    }
    if (args.prompt.content.startsWith(noActivePrefix)) {
      return args.prompt.content;
    }
    const note =
      args.language === 'zh'
        ? [
            noActivePrefix,
            '当前没有待完成的跨对话回复义务。',
            '这轮不要调用任何 `reply*`；直接按当前本地对话继续即可。',
          ].join('\n')
        : [
            noActivePrefix,
            'There is no active inter-dialog reply obligation right now.',
            'Do not call any `reply*` tool in this turn; just continue the current local conversation.',
          ].join('\n');
    return `${note}\n\n${args.prompt.content}`;
  }
  if (args.prompt.content.startsWith(activePrefix)) {
    return args.prompt.content;
  }
  const toolName = directive.expectedReplyCallName;
  if (reminderPrefixes.some((prefix) => args.prompt.content.startsWith(prefix))) {
    return args.prompt.content;
  }
  const note =
    args.language === 'zh'
      ? [
          activePrefix,
          `当前这轮若完成交付，精确应调用 \`${toolName}\`。`,
          '不要自己判断该选哪个 `reply*`；以上述函数名为准。',
        ].join('\n')
      : [
          activePrefix,
          `If this round is ready for final delivery, the exact reply tool is \`${toolName}\`.`,
          'Do not decide among `reply*` variants by yourself; follow that exact function name.',
        ].join('\n');
  return `${note}\n\n${args.prompt.content}`;
}

type RoutedFunctionResult = {
  hadNormalToolCalls: boolean;
  shouldStopAfterReplyTool: boolean;
  pairedMessages: ChatMessage[];
  tellaskToolOutputs: ChatMessage[];
};

function isReplyTellaskCallName(
  name: string,
): name is 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack' {
  return (
    name === 'replyTellask' || name === 'replyTellaskSessionless' || name === 'replyTellaskBack'
  );
}

function isToolArgumentsObject(value: unknown): value is ToolArguments {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PreparedFuncCallArguments =
  | {
      ok: true;
      raw: ToolArguments;
      contextArguments: string;
    }
  | {
      ok: false;
      error: string;
      contextArguments: string;
    };

function prepareFuncCallArguments(argumentsStr: string): PreparedFuncCallArguments {
  if (argumentsStr.trim() === '') {
    return {
      ok: true,
      raw: {},
      contextArguments: '{}',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsStr);
  } catch (err) {
    return {
      ok: false,
      error: `Arguments must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      contextArguments: '{}',
    };
  }

  if (!isToolArgumentsObject(parsed)) {
    return {
      ok: false,
      error: 'Arguments must be an object',
      contextArguments: '{}',
    };
  }

  return {
    ok: true,
    raw: parsed,
    contextArguments: argumentsStr,
  };
}

async function executeFunctionCalls(args: {
  dlg: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  abortSignal: AbortSignal | undefined;
}): Promise<FuncResultMsg[]> {
  const functionPromises = args.funcCalls.map(async (func): Promise<FuncResultMsg> => {
    throwIfAborted(args.abortSignal, args.dlg);

    const callGenseq = func.genseq;
    const argsStr =
      typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments ?? {});
    const preparedArgs = prepareFuncCallArguments(argsStr);

    const tool = args.agentTools.find(
      (t): t is FuncTool => t.type === 'func' && t.name === func.name,
    );
    if (!tool) {
      const errorResult: FuncResultMsg = {
        type: 'func_result_msg',
        id: func.id,
        name: func.name,
        content: `Tool '${func.name}' not found`,
        role: 'tool',
        genseq: callGenseq,
      };
      await args.dlg.receiveFuncResult(errorResult);
      return errorResult;
    }

    let result: FuncResultMsg;
    if (!preparedArgs.ok) {
      log.warn('kernel-driver rejected function call arguments before execution', undefined, {
        funcName: func.name,
        arguments: argsStr,
        error: preparedArgs.error,
      });
      result = {
        type: 'func_result_msg',
        id: func.id,
        name: func.name,
        content: `Invalid arguments: ${preparedArgs.error}`,
        role: 'tool',
        genseq: callGenseq,
      };
    } else {
      const argsValidation = validateFuncToolArguments(tool, preparedArgs.raw);
      if (!argsValidation.ok) {
        result = {
          type: 'func_result_msg',
          id: func.id,
          name: func.name,
          content: `Invalid arguments: ${argsValidation.error}`,
          role: 'tool',
          genseq: callGenseq,
        };
        await args.dlg.receiveFuncResult(result);
        return result;
      }

      const argsObj: ToolArguments = argsValidation.args;

      await args.dlg.funcCallRequested(func.id, func.name, preparedArgs.contextArguments);
      await args.dlg.persistFunctionCall(func.id, func.name, argsObj, callGenseq);

      try {
        throwIfAborted(args.abortSignal, args.dlg);
        const output: ToolCallOutput = await tool.call(args.dlg, args.agent, argsObj);
        throwIfAborted(args.abortSignal, args.dlg);
        const normalized =
          typeof output === 'string'
            ? { content: output, contentItems: undefined }
            : {
                content: typeof output.content === 'string' ? output.content : String(output),
                contentItems: Array.isArray(output.contentItems) ? output.contentItems : undefined,
              };
        result = {
          type: 'func_result_msg',
          id: func.id,
          name: func.name,
          content: String(normalized.content),
          contentItems: normalized.contentItems,
          role: 'tool',
          genseq: callGenseq,
        };
      } catch (err) {
        const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        result = {
          type: 'func_result_msg',
          id: func.id,
          name: func.name,
          content: `Function '${func.name}' execution failed: ${errText}`,
          role: 'tool',
          genseq: callGenseq,
        };
        if (args.abortSignal?.aborted || err instanceof KernelDriverInterruptedError) {
          throw err;
        }
      }
    }

    await args.dlg.receiveFuncResult(result);
    return result;
  });

  return await Promise.all(functionPromises);
}

async function executeFunctionRound(args: {
  dlg: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  callbacks: KernelDriverDriveCallbacks;
  abortSignal: AbortSignal | undefined;
  allowTellaskSpecialFunctions: boolean;
}): Promise<RoutedFunctionResult> {
  if (args.funcCalls.length === 0) {
    return {
      hadNormalToolCalls: false,
      shouldStopAfterReplyTool: false,
      pairedMessages: [],
      tellaskToolOutputs: [],
    };
  }
  throwIfAborted(args.abortSignal, args.dlg);

  const allowTellaskBack =
    args.allowTellaskSpecialFunctions && args.dlg.id.rootId !== args.dlg.id.selfId;
  const allowedSpecials = args.allowTellaskSpecialFunctions
    ? new Set<TellaskSpecialFunctionName>([
        'tellask',
        'tellaskSessionless',
        'replyTellask',
        'replyTellaskSessionless',
        'replyTellaskBack',
        'askHuman',
        'freshBootsReasoning',
        ...(allowTellaskBack ? (['tellaskBack'] as const) : []),
      ])
    : new Set<TellaskSpecialFunctionName>();
  const classified = classifyTellaskSpecialFunctionCalls(args.funcCalls, { allowedSpecials });
  const specialCallById = new Map(
    classified.specialCalls.map((call) => [call.callId, call] as const),
  );

  const toPersistedSpecialCallArgs = (
    call: ReturnType<typeof classifyTellaskSpecialFunctionCalls>['specialCalls'][number],
  ): ToolArguments => {
    switch (call.callName) {
      case 'tellaskBack':
        return { tellaskContent: call.tellaskContent };
      case 'askHuman':
        return { tellaskContent: call.tellaskContent };
      case 'freshBootsReasoning':
        return {
          tellaskContent: call.tellaskContent,
          ...(call.effort !== undefined ? { effort: call.effort } : {}),
        };
      case 'tellask':
        return {
          targetAgentId: call.targetAgentId,
          sessionSlug: call.sessionSlug,
          tellaskContent: call.tellaskContent,
        };
      case 'tellaskSessionless':
        return {
          targetAgentId: call.targetAgentId,
          tellaskContent: call.tellaskContent,
        };
      case 'replyTellask':
      case 'replyTellaskSessionless':
      case 'replyTellaskBack':
        return { replyContent: call.replyContent };
    }
  };

  for (const callMsg of args.funcCalls) {
    throwIfAborted(args.abortSignal, args.dlg);
    const special = specialCallById.get(callMsg.id);
    if (!special) {
      continue;
    }
    const argumentsStr =
      typeof callMsg.arguments === 'string'
        ? callMsg.arguments
        : JSON.stringify(callMsg.arguments ?? {});
    if (isReplyTellaskCallName(callMsg.name)) {
      await args.dlg.funcCallRequested(callMsg.id, callMsg.name, argumentsStr);
    }
    await args.dlg.persistFunctionCall(
      callMsg.id,
      callMsg.name,
      toPersistedSpecialCallArgs(special),
      callMsg.genseq,
    );
  }

  const issueResults: FuncResultMsg[] = [];
  for (const issue of classified.parseIssues) {
    const result: FuncResultMsg = {
      type: 'func_result_msg',
      id: issue.call.id,
      name: issue.call.name,
      content: `Invalid arguments for tellask special function '${issue.call.name}': ${issue.error}`,
      role: 'tool',
      genseq: issue.call.genseq,
    };
    await args.dlg.receiveFuncResult(result);
    issueResults.push(result);
  }

  throwIfAborted(args.abortSignal, args.dlg);
  const tellaskExecution = await executeTellaskSpecialCalls({
    dlg: args.dlg,
    calls: classified.specialCalls,
    callbacks: args.callbacks,
  });
  const tellaskFuncResults: FuncResultMsg[] = [];
  const tellaskToolOutputs: ChatMessage[] = [];
  for (const output of tellaskExecution.toolOutputs) {
    if (output.type === 'func_result_msg') {
      await args.dlg.receiveFuncResult(output);
      tellaskFuncResults.push(output);
      continue;
    }
    tellaskToolOutputs.push(output);
  }
  const shouldStopAfterReplyTool = tellaskExecution.successfulReplyCallIds.length > 0;
  throwIfAborted(args.abortSignal, args.dlg);
  const specialCallIds = new Set(classified.specialCalls.map((call) => call.callId));

  const genericResults = await executeFunctionCalls({
    dlg: args.dlg,
    agent: args.agent,
    agentTools: args.agentTools,
    funcCalls: classified.normalCalls,
    abortSignal: args.abortSignal,
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
  for (const result of issueResults) {
    register(result);
  }
  for (const result of tellaskFuncResults) {
    register(result);
  }
  for (const result of genericResults) {
    register(result);
  }

  const pairedMessages: ChatMessage[] = [];
  for (const call of args.funcCalls) {
    const originalArgsStr =
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    const preparedArgs = prepareFuncCallArguments(originalArgsStr);
    pairedMessages.push({
      type: 'func_call_msg',
      role: 'assistant',
      genseq: call.genseq,
      id: call.id,
      name: call.name,
      arguments: preparedArgs.contextArguments,
    });
    const result = resultByCallId.get(call.id);
    if (result) {
      pairedMessages.push(result);
      continue;
    }
    if (specialCallIds.has(call.id)) {
      continue;
    }
    throw new Error(
      `kernel-driver function result invariant violation: missing result for call id '${call.id}' (${call.name})`,
    );
  }

  return {
    hadNormalToolCalls: classified.normalCalls.length > 0,
    shouldStopAfterReplyTool,
    pairedMessages,
    tellaskToolOutputs,
  };
}

async function resetDiligenceBudgetAfterQ4H(dlg: Dialog, team: Team): Promise<void> {
  try {
    if (!(await dlg.hasPendingQ4H())) {
      return;
    }
    const configuredMax = resolveMemberDiligencePushMax(team, dlg.agentId);
    if (typeof configuredMax === 'number' && Number.isFinite(configuredMax)) {
      const next = Math.floor(configuredMax);
      dlg.diligencePushRemainingBudget =
        next > 0 ? next : Math.max(0, Math.floor(dlg.diligencePushRemainingBudget));
    } else {
      dlg.diligencePushRemainingBudget = Math.max(0, Math.floor(dlg.diligencePushRemainingBudget));
    }
    void DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
    }));
  } catch (err) {
    log.error('kernel-driver failed to reset Diligence Push budget after Q4H', err, {
      dialogId: dlg.id.valueOf(),
    });
    throw err;
  }
}

async function maybeContinueWithDiligencePrompt(args: {
  dlg: Dialog;
  team: Team;
  suppressDiligencePushForDrive: boolean;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: KernelDriverHumanPrompt }> {
  const { dlg, team, suppressDiligencePushForDrive } = args;

  if (!(dlg instanceof RootDialog)) {
    return { kind: 'break' };
  }

  const suspension = await dlg.getSuspensionStatus();
  if (!suspension.canDrive) {
    if (suspension.q4h) {
      await resetDiligenceBudgetAfterQ4H(dlg, team);
    }
    return { kind: 'break' };
  }

  const prepared = await maybePrepareDiligenceAutoContinuePrompt({
    dlg,
    isRootDialog: true,
    remainingBudget: dlg.diligencePushRemainingBudget,
    diligencePushMax: resolveMemberDiligencePushMax(team, dlg.agentId),
    suppressDiligencePush: suppressDiligencePushForDrive,
  });

  dlg.diligencePushRemainingBudget = prepared.nextRemainingBudget;
  void DialogPersistence.mutateDialogLatest(dlg.id, () => ({
    kind: 'patch',
    patch: { diligencePushRemainingBudget: dlg.diligencePushRemainingBudget },
  }));

  if (prepared.kind !== 'disabled') {
    emitDiligenceBudgetEvent(dlg, {
      maxInjectCount: prepared.maxInjectCount,
      nextRemainingBudget: prepared.nextRemainingBudget,
    });
  }

  if (prepared.kind === 'budget_exhausted') {
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

async function maybeContinueWithHealthPromptBeforeDiligence(args: {
  dlg: Dialog;
  providerCfg: ProviderConfig;
  model: string;
}): Promise<
  | { kind: 'no_health_prompt' }
  | { kind: 'health_suspend' }
  | { kind: 'health_continue'; prompt: KernelDriverHumanPrompt; resetTaskdoc: boolean }
> {
  const { dlg, providerCfg, model } = args;

  // This path is only used as a higher-priority alternative to Diligence Push.
  if (!(dlg instanceof RootDialog)) {
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

  if (healthDecision.kind === 'suspend') {
    return { kind: 'health_suspend' };
  }
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
  const guideText =
    healthDecision.reason === 'caution_soft_remediation'
      ? formatAgentFacingContextHealthV3RemediationGuide(language, {
          kind: 'caution',
          mode: 'soft',
        })
      : formatAgentFacingContextHealthV3RemediationGuide(language, {
          kind: 'critical',
          mode: 'countdown',
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
  const suppressDiligencePushForDrive = driveOptions?.suppressDiligencePush === true;
  const abortSignal = getActiveRunSignal(dlg.id) ?? createActiveRun(dlg.id);

  let finalDisplayState: DialogDisplayState | undefined;
  let lastAssistantSayingContent: string | null = null;
  let lastAssistantSayingGenseq: number | null = null;
  let lastFunctionCallGenseq: number | null = null;
  let lastAssistantReplyTarget: KernelDriverHumanPrompt['subdialogReplyTarget'] | undefined;
  let pubRemindersVer = dlg.remindersVer;

  let pendingPrompt: KernelDriverHumanPrompt | undefined = humanPrompt;
  let skipTaskdocForThisDrive = humanPrompt?.skipTaskdoc === true;
  let genIterNo = 0;

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

  try {
    for (;;) {
      genIterNo += 1;
      throwIfAborted(abortSignal, dlg);

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
      const retryPolicy = resolveKernelDriverRetryPolicy(providerCfg);

      const canonicalFuncTools: FuncTool[] = agentTools.filter(
        (t): t is FuncTool => t.type === 'func',
      );
      const isSubdialog = dlg.id.rootId !== dlg.id.selfId;
      const fbrEffortDefault = resolveFbrEffortDefaultForTool(agent);
      const effectiveFuncTools: FuncTool[] =
        policy.mode === 'default'
          ? mergeTellaskSpecialVirtualTools(canonicalFuncTools, {
              includeTellaskBack: isSubdialog,
              fbrEffortDefault,
            })
          : canonicalFuncTools;
      const projected = projectFuncToolsForProvider(providerCfg.apiType, effectiveFuncTools);
      const funcTools = projected.tools;

      if (genIterNo > 1) {
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
          hadUserPromptThisGen: isUserOriginPrompt(pendingPrompt),
          canInjectPromptThisGen: !hasQueuedUpNext,
          cautionRemediationCadenceGenerations,
          criticalCountdownRemaining,
        });

        if (healthDecision.kind === 'suspend') {
          log.debug(
            'kernel-driver suspend iterative generation due to critical context while waiting for human prompt',
            undefined,
            {
              dialogId: dlg.id.valueOf(),
              rootId: dlg.id.rootId,
              selfId: dlg.id.selfId,
              genIterNo,
              pendingPromptOrigin: pendingPrompt?.origin ?? null,
            },
          );
          break;
        }

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
      const currentReplyTarget = currentPrompt?.subdialogReplyTarget;
      pendingPrompt = undefined;

      await dlg.notifyGeneratingStart(currentPrompt?.msgId);
      try {
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
          const q4hAnswerCallIds = normalizeQ4HAnswerCallIds(currentPrompt.q4hAnswerCallIds);
          const promptLanguage =
            persistedUserLanguageCode === 'zh' || persistedUserLanguageCode === 'en'
              ? persistedUserLanguageCode
              : getWorkLanguage();
          const activeReplyDirective =
            currentPrompt.tellaskReplyDirective ??
            (await loadLatestActiveTellaskReplyDirective(dlg));
          const promptContent = buildPromptContentWithExactReplyToolName({
            dlg,
            prompt: currentPrompt,
            activeReplyDirective,
            language: promptLanguage,
          });

          await dlg.addChatMessages({
            type: 'prompting_msg',
            role: 'user',
            genseq: dlg.activeGenSeq,
            msgId: currentPrompt.msgId,
            grammar: 'markdown',
            content: promptContent,
          });
          await dlg.persistUserMessage(
            promptContent,
            currentPrompt.msgId,
            'markdown',
            origin,
            persistedUserLanguageCode,
            q4hAnswerCallIds,
            activeReplyDirective,
          );

          // Emit the live user-side boundary event for UI generation bubbles.
          // Without this, realtime turns can miss user content + divider (<hr/>),
          // while replay (from persisted human_text_record) still looks correct.
          postDialogEvent(dlg, {
            type: 'end_of_user_saying_evt',
            course: dlg.currentCourse,
            genseq: dlg.activeGenSeq,
            msgId: currentPrompt.msgId,
            content: promptContent,
            grammar: 'markdown',
            origin,
            userLanguageCode: persistedUserLanguageCode,
            q4hAnswerCallIds,
          });

          // Ideal: provider SDKs should support a dedicated role='environment' for runtime
          // metadata. Today, most providers only accept user/assistant (and tool as a special
          // case), so Dominds must project environment/system-like content as role='user'.
          const replyTarget = currentPrompt.subdialogReplyTarget;
          if (replyTarget) {
            const normalizedCallId = replyTarget.callId.trim();
            if (normalizedCallId === '') {
              throw new Error(
                `kernel-driver assignment anchor invariant violation: empty callId (dialog=${dlg.id.valueOf()})`,
              );
            }
            const record: TellaskCallAnchorRecord = {
              ts: formatUnifiedTimestamp(new Date()),
              type: 'tellask_call_anchor_record',
              anchorRole: 'assignment',
              callId: normalizedCallId,
              genseq: dlg.activeGenSeq,
              ...toRootGenerationAnchor({
                rootCourse: (dlg instanceof SubDialog ? dlg.rootDialog : dlg).currentCourse,
                rootGenseq:
                  (dlg instanceof SubDialog ? dlg.rootDialog : dlg).activeGenSeqOrUndefined ?? 0,
              }),
            };
            const course = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
            await DialogPersistence.appendEvent(dlg.id, course, record, dlg.status);
          }
        }

        await dlg.processReminderUpdates();
        pubRemindersVer = dlg.remindersVer;

        const taskDocMsg =
          dlg.taskDocPath && !skipTaskdocForThisDrive ? await formatTaskDocContent(dlg) : undefined;

        const renderedReminders = await renderRemindersForContext(dlg);
        const ctxMsgs: ChatMessage[] = assembleDriveContextMessages({
          base: {
            prependedContextMessages: policy.prependedContextMessages,
            memories: minds.memories,
            taskDocMsg,
            coursePrefixMsgs: dlg.getCoursePrefixMsgs(),
            dialogMsgsForContext: await buildDialogMsgsForContext(dlg),
          },
          ephemeral: {},
          tail: { renderedReminders },
        });

        const newMsgs: ChatMessage[] = [];
        const streamedFuncCalls: FuncCallMsg[] = [];

        const streamOrBatch = async (): Promise<{
          usage: LlmUsageStats;
          llmGenModel?: string;
          batchMessages?: ChatMessage[];
        }> => {
          if (agent.streaming === false) {
            const batch = await runLlmRequestWithRetry({
              dlg,
              provider,
              abortSignal,
              maxRetries: retryPolicy.maxRetries,
              retryInitialDelayMs: retryPolicy.initialDelayMs,
              retryBackoffMultiplier: retryPolicy.backoffMultiplier,
              retryMaxDelayMs: retryPolicy.maxDelayMs,
              canRetry: () => true,
              doRequest: async () => {
                const batchResult = await llmGen.genMoreMessages(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  {
                    dialogSelfId: dlg.id.selfId,
                    dialogRootId: dlg.id.rootId,
                    promptCacheKey: `${dlg.id.selfId}:c${String(dlg.currentCourse)}`,
                  },
                  ctxMsgs,
                  dlg.activeGenSeq,
                  abortSignal,
                );
                if (!hasMeaningfulBatchOutput(batchResult.messages)) {
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
            };
          }

          let currentSayingContent = '';
          let currentThinkingContent = '';
          let currentThinkingReasoning: ThinkingMsg['reasoning'] = undefined;
          let streamAttemptCourse: number | undefined;
          let streamAttemptCheckpointOffset: number | undefined;
          let streamAttemptSayingContent: string | undefined;
          let streamAttemptSayingGenseq: number | undefined;
          let streamSawWebSearchCall = false;
          type StreamActiveState = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'saying' };
          let streamActive: StreamActiveState = { kind: 'idle' };
          const rollbackStreamAttempt = async (): Promise<void> => {
            if (streamAttemptCourse === undefined || streamAttemptCheckpointOffset === undefined) {
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
            streamSawWebSearchCall = false;
            streamedFuncCalls.length = 0;
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
                throw new Error(detail);
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
                throw new Error(detail);
              }
              streamActive = { kind: 'idle' };
              if (reasoning) currentThinkingReasoning = reasoning;
              await dlg.thinkingFinish(reasoning);
              if (currentThinkingContent.length > 0 || currentThinkingReasoning !== undefined) {
                newMsgs.push({
                  type: 'thinking_msg',
                  role: 'assistant',
                  genseq: dlg.activeGenSeq,
                  content: currentThinkingContent,
                  reasoning: currentThinkingReasoning,
                });
              }
              currentThinkingContent = '';
              currentThinkingReasoning = undefined;
            },
            sayingStart: async () => {
              throwIfAborted(abortSignal, dlg);
              if (streamActive.kind !== 'idle') {
                const detail = `Protocol violation: sayingStart while ${streamActive.kind} is active`;
                await dlg.streamError(detail);
                throw new Error(detail);
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
                throw new Error(detail);
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
            funcCall: async (callId: string, name: string, argsStr: string) => {
              throwIfAborted(abortSignal, dlg);
              streamedFuncCalls.push({
                type: 'func_call_msg',
                role: 'assistant',
                genseq: dlg.activeGenSeq,
                id: callId,
                name,
                arguments: argsStr,
              });
            },
            webSearchCall: async (call) => {
              throwIfAborted(abortSignal, dlg);
              streamSawWebSearchCall = true;
              await dlg.webSearchCall(call);
            },
          };

          const res = await runLlmRequestWithRetry({
            dlg,
            provider,
            abortSignal,
            maxRetries: retryPolicy.maxRetries,
            retryInitialDelayMs: retryPolicy.initialDelayMs,
            retryBackoffMultiplier: retryPolicy.backoffMultiplier,
            retryMaxDelayMs: retryPolicy.maxDelayMs,
            canRetry: () => true,
            onRetry: rollbackStreamAttempt,
            onGiveUp: rollbackStreamAttempt,
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
              streamSawWebSearchCall = false;
              streamedFuncCalls.length = 0;
              newMsgs.length = 0;
              const streamResult = await llmGen.genToReceiver(
                providerCfg,
                agent,
                systemPrompt,
                funcTools,
                {
                  dialogSelfId: dlg.id.selfId,
                  dialogRootId: dlg.id.rootId,
                  promptCacheKey: `${dlg.id.selfId}:c${String(dlg.currentCourse)}`,
                },
                ctxMsgs,
                receiver,
                dlg.activeGenSeq,
                abortSignal,
              );
              const hasThinkingContent = currentThinkingContent.trim() !== '';
              const hasSayingContent = (streamAttemptSayingContent ?? '').trim() !== '';
              const hasFunctionCall = streamedFuncCalls.length > 0;
              if (
                !hasThinkingContent &&
                !hasSayingContent &&
                !hasFunctionCall &&
                !streamSawWebSearchCall
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

        if (Array.isArray(llmOutput.batchMessages)) {
          const assistantMsgs = llmOutput.batchMessages.filter(
            (m): m is SayingMsg | ThinkingMsg =>
              m.type === 'saying_msg' || m.type === 'thinking_msg',
          );
          for (const msg of assistantMsgs) {
            newMsgs.push(msg);
            if (msg.type === 'thinking_msg') {
              await emitThinkingEvents(dlg, msg.content, msg.reasoning);
            } else if (msg.type === 'saying_msg') {
              lastAssistantSayingContent = msg.content;
              lastAssistantSayingGenseq = msg.genseq;
              lastAssistantReplyTarget = currentReplyTarget;
              await emitAssistantSaying(dlg, msg.content);
            }
          }
          const funcCalls = llmOutput.batchMessages.filter(
            (m): m is FuncCallMsg => m.type === 'func_call_msg',
          );
          streamedFuncCalls.push(...funcCalls);
        }

        const tellaskCallCount = policy.allowTellaskSpecialFunctions
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
          await dlg.addChatMessages(...newMsgs, violationMsg);
          lastAssistantSayingContent = violationText;
          lastAssistantSayingGenseq = genseq;
          lastAssistantReplyTarget = currentReplyTarget;
          return {
            lastAssistantSayingContent,
            lastAssistantSayingGenseq,
            lastFunctionCallGenseq,
            lastAssistantReplyTarget,
          };
        }

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
          allowTellaskSpecialFunctions: policy.allowTellaskSpecialFunctions,
        });
        if (routed.tellaskToolOutputs.length > 0) {
          newMsgs.push(...routed.tellaskToolOutputs);
        }
        if (routed.pairedMessages.length > 0) {
          newMsgs.push(...routed.pairedMessages);
        }
        await dlg.addChatMessages(...newMsgs);

        const shouldStopAfterFbrConclusionAttempt =
          policy.mode === 'fbr_conclusion_only' &&
          streamedFuncCalls.some((call) => isFbrConclusionToolName(call.name));
        if (shouldStopAfterFbrConclusionAttempt) {
          log.debug('kernel-driver stop FBR round after conclusion function attempt', undefined, {
            dialogId: dlg.id.valueOf(),
            toolNames: streamedFuncCalls
              .filter((call) => isFbrConclusionToolName(call.name))
              .map((call) => call.name),
          });
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

        // Tool execution may have created pending Q4H/subdialogs mid-round. Respect the
        // dialog's actual suspension state here so auto-continue is decided in one place.
        const suspensionAfterToolRound = await dlg.getSuspensionStatus({
          allowPendingSubdialogs: routed.hadNormalToolCalls,
        });
        if (!suspensionAfterToolRound.canDrive) {
          await resetDiligenceBudgetAfterQ4H(dlg, team);
          break;
        }

        const shouldContinue =
          streamedFuncCalls.length > 0 ||
          routed.pairedMessages.length > 0 ||
          routed.tellaskToolOutputs.length > 0;
        if (!shouldContinue) {
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
          if (healthFirst.kind === 'health_suspend') {
            break;
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
        if (shouldContinue) {
          continue;
        }
      } finally {
        await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
      }
    }

    throwIfAborted(abortSignal, dlg);
    finalDisplayState = await computeIdleDisplayState(dlg);
  } catch (err) {
    const stopRequested = getStopRequestedReason(dlg.id);
    const interruptedReason: DialogInterruptionReason | undefined =
      err instanceof KernelDriverInterruptedError
        ? err.reason
        : abortSignal.aborted
          ? stopRequested === 'emergency_stop'
            ? { kind: 'emergency_stop' }
            : stopRequested === 'user_stop'
              ? { kind: 'user_stop' }
              : { kind: 'system_stop', detail: 'Aborted.' }
          : undefined;

    if (interruptedReason) {
      finalDisplayState = { kind: 'interrupted', reason: interruptedReason };
      broadcastDisplayStateMarker(dlg.id, { kind: 'interrupted', reason: interruptedReason });
    } else {
      const errText = extractErrorDetails(err).message;
      try {
        await dlg.streamError(errText);
      } catch {
        // best-effort
      }
      finalDisplayState = { kind: 'interrupted', reason: { kind: 'system_stop', detail: errText } };
      broadcastDisplayStateMarker(dlg.id, {
        kind: 'interrupted',
        reason: { kind: 'system_stop', detail: errText },
      });
    }
  } finally {
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
      finalDisplayState.kind !== 'interrupted' &&
      finalDisplayState.kind !== 'dead'
    ) {
      const stopRequested = getStopRequestedReason(dlg.id);
      const lateInterruptedReason: DialogInterruptionReason =
        stopRequested === 'emergency_stop'
          ? { kind: 'emergency_stop' }
          : stopRequested === 'user_stop'
            ? { kind: 'user_stop' }
            : { kind: 'system_stop', detail: 'Aborted.' };
      finalDisplayState = { kind: 'interrupted', reason: lateInterruptedReason };
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

    if (finalDisplayState.kind === 'interrupted') {
      await setDialogExecutionMarker(dlg.id, {
        kind: 'interrupted',
        reason: finalDisplayState.reason,
      });
    } else if (finalDisplayState.kind !== 'dead') {
      await clearDialogInterruptedExecutionMarker(dlg.id);
    }
    await setDialogDisplayState(dlg.id, finalDisplayState);
  }

  return {
    lastAssistantSayingContent,
    lastAssistantSayingGenseq,
    lastFunctionCallGenseq,
    lastAssistantReplyTarget,
  };
}
