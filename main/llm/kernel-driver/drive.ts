import { Dialog, RootDialog } from '../../dialog';
import {
  broadcastRunStateMarker,
  computeIdleRunState,
  createActiveRun,
  getActiveRunSignal,
  getStopRequestedReason,
  setDialogRunState,
} from '../../dialog-run-state';
import { postDialogEvent } from '../../evt-registry';
import { extractErrorDetails, log } from '../../log';
import { loadAgentMinds } from '../../minds/load';
import { DialogPersistence } from '../../persistence';
import { DEFAULT_DILIGENCE_PUSH_MAX } from '../../shared/diligence';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatCurrentUserLanguagePreference,
  formatDomindsNoteFbrToollessViolation,
  formatReminderItemGuide,
} from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { ContextHealthSnapshot, LlmUsageStats } from '../../shared/types/context-health';
import type { DialogInterruptionReason, DialogRunState } from '../../shared/types/run-state';
import type { TeammateCallAnchorRecord } from '../../shared/types/storage';
import { generateShortId } from '../../shared/utils/id';
import { formatUnifiedTimestamp } from '../../shared/utils/time';
import type { Team } from '../../team';
import type { FuncTool, Tool, ToolArguments, ToolCallOutput } from '../../tool';
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
import { emitThinkingEvents } from './events';
import { buildKernelDriverPolicy, resolveKernelDriverPolicyViolationKind } from './guardrails';
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
  type TellaskSpecialFunctionName,
} from './tellask-special';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverHumanPrompt,
} from './types';

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

function createFreshBootsReasoningTool(args: {
  fbrEffortDefault: number;
  providerApiType: ProviderConfig['apiType'];
}): FuncTool {
  const fbrDefault = args.fbrEffortDefault;
  const fbrDefaultHint =
    fbrDefault > 0
      ? `Runtime default for \`effort\` is current member \`fbr_effort=${fbrDefault}\` when omitted.`
      : 'Runtime default for `effort` is current member `fbr_effort=0` (FBR disabled unless reconfigured).';
  const codexAuthHint =
    args.providerApiType === 'codex'
      ? ` Codex-auth note: function arguments are often emitted with all fields present; if user did not specify intensity, pass \`effort: ${fbrDefault}\` explicitly.`
      : '';
  return {
    type: 'func',
    name: 'freshBootsReasoning',
    description:
      'Start an FBR sideline dialog for tool-less fresh-boots reasoning. tellaskContent MUST stay neutral and fact-oriented (Goal/Facts/Constraints/Evidence[/Unknowns]); do not issue analysis directives (for example “from the following dimensions”, “analyze in steps 1..N”, or “N rounds per dimension”). ' +
      fbrDefaultHint +
      codexAuthHint,
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
    description: 'Create a one-shot teammate sideline dialog.',
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
    providerApiType: ProviderConfig['apiType'];
  },
): FuncTool[] {
  const merged: FuncTool[] = [...baseTools];
  const seen = new Set(merged.map((tool) => tool.name));
  const freshBootsReasoning = createFreshBootsReasoningTool({
    fbrEffortDefault: options.fbrEffortDefault,
    providerApiType: options.providerApiType,
  });
  const specialTools = options.includeTellaskBack
    ? [...TELLASK_SPECIAL_VIRTUAL_TOOLS, freshBootsReasoning]
    : [
        ...TELLASK_SPECIAL_VIRTUAL_TOOLS.filter((tool) => tool.name !== 'tellaskBack'),
        freshBootsReasoning,
      ];
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
    userLanguageCode: upNext.userLanguageCode,
    q4hAnswerCallIds: upNext.q4hAnswerCallIds,
    runControl: normalizedRunControl,
  };
}

async function renderRemindersForContext(dlg: Dialog): Promise<ChatMessage[]> {
  if (dlg.reminders.length === 0) return [];
  const language = getWorkLanguage();
  return await Promise.all(
    dlg.reminders.map(async (reminder, index): Promise<ChatMessage> => {
      if (reminder.owner) {
        return await reminder.owner.renderReminder(dlg, reminder, index);
      }
      return {
        type: 'environment_msg',
        role: 'user',
        content: formatReminderItemGuide(language, index + 1, reminder.content, {
          meta: reminder.meta,
        }),
      };
    }),
  );
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

type RoutedFunctionResult = {
  suspendForHuman: boolean;
  pairedMessages: ChatMessage[];
  tellaskToolOutputs: ChatMessage[];
};

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

    let rawArgs: unknown = {};
    if (typeof func.arguments === 'string' && func.arguments.trim()) {
      try {
        rawArgs = JSON.parse(func.arguments);
      } catch (parseErr) {
        rawArgs = null;
        log.warn('kernel-driver failed to parse function arguments as JSON', undefined, {
          funcName: func.name,
          arguments: func.arguments,
          error: parseErr,
        });
      }
    }

    let result: FuncResultMsg;
    const argsValidation = validateFuncToolArguments(tool, rawArgs);
    if (argsValidation.ok) {
      const argsObj: ToolArguments = argsValidation.args;

      await args.dlg.funcCallRequested(func.id, func.name, argsStr);
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
    } else {
      result = {
        type: 'func_result_msg',
        id: func.id,
        name: func.name,
        content: `Invalid arguments: ${argsValidation.error}`,
        role: 'tool',
        genseq: callGenseq,
      };
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
  callbacks?: {
    scheduleDrive: (
      dialog: Dialog,
      options: {
        humanPrompt?: KernelDriverDriveArgs[1];
        waitInQue: boolean;
        driveOptions?: KernelDriverDriveArgs[3];
      },
    ) => void;
    driveDialog: (
      dialog: Dialog,
      options: {
        humanPrompt?: KernelDriverDriveArgs[1];
        waitInQue: boolean;
        driveOptions?: KernelDriverDriveArgs[3];
      },
    ) => Promise<void>;
  };
  abortSignal: AbortSignal | undefined;
}): Promise<RoutedFunctionResult> {
  if (args.funcCalls.length === 0) {
    return { suspendForHuman: false, pairedMessages: [], tellaskToolOutputs: [] };
  }
  throwIfAborted(args.abortSignal, args.dlg);

  const allowTellaskBack = args.dlg.id.rootId !== args.dlg.id.selfId;
  const allowedSpecials = new Set<TellaskSpecialFunctionName>([
    'tellask',
    'tellaskSessionless',
    'askHuman',
    'freshBootsReasoning',
    ...(allowTellaskBack ? (['tellaskBack'] as const) : []),
  ]);
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
    }
  };

  for (const callMsg of args.funcCalls) {
    throwIfAborted(args.abortSignal, args.dlg);
    const special = specialCallById.get(callMsg.id);
    if (!special) {
      continue;
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
  const specialResult = await executeTellaskSpecialCalls({
    dlg: args.dlg,
    agent: args.agent,
    calls: classified.specialCalls,
    callbacks: args.callbacks,
  });
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
  for (const result of genericResults) {
    register(result);
  }

  const pairedMessages: ChatMessage[] = [];
  for (const call of args.funcCalls) {
    const argsStr =
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    pairedMessages.push({
      type: 'func_call_msg',
      role: 'assistant',
      genseq: call.genseq,
      id: call.id,
      name: call.name,
      arguments: argsStr,
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
    suspendForHuman: specialResult.suspend,
    pairedMessages,
    tellaskToolOutputs: specialResult.toolOutputs,
  };
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

export async function driveDialogStreamCore(
  dlg: Dialog,
  humanPrompt?: KernelDriverDriveArgs[1],
  driveOptions?: KernelDriverDriveArgs[3],
  callbacks?: {
    scheduleDrive: (
      dialog: Dialog,
      options: {
        humanPrompt?: KernelDriverDriveArgs[1];
        waitInQue: boolean;
        driveOptions?: KernelDriverDriveArgs[3];
      },
    ) => void;
    driveDialog: (
      dialog: Dialog,
      options: {
        humanPrompt?: KernelDriverDriveArgs[1];
        waitInQue: boolean;
        driveOptions?: KernelDriverDriveArgs[3];
      },
    ) => Promise<void>;
  },
): Promise<KernelDriverCoreResult> {
  const suppressDiligencePushForDrive = driveOptions?.suppressDiligencePush === true;
  const abortSignal = getActiveRunSignal(dlg.id) ?? createActiveRun(dlg.id);

  let finalRunState: DialogRunState | undefined;
  let lastAssistantSayingContent: string | null = null;
  let lastAssistantSayingGenseq: number | null = null;
  let lastFunctionCallGenseq: number | null = null;

  let pendingPrompt: KernelDriverHumanPrompt | undefined = humanPrompt;
  let skipTaskdocForThisDrive = humanPrompt?.skipTaskdoc === true;
  let genIterNo = 0;
  let injectedCautionRemediation = false;
  let previousRoundHadToolCalls = false;

  if (!humanPrompt) {
    try {
      const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
      if (latest?.runState?.kind === 'interrupted') {
        broadcastRunStateMarker(dlg.id, { kind: 'resumed' });
      }
    } catch (err) {
      log.warn('kernel-driver failed to load latest.yaml for resumption marker', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
  }

  await setDialogRunState(dlg.id, { kind: 'proceeding' });

  try {
    for (;;) {
      genIterNo += 1;
      throwIfAborted(abortSignal, dlg);

      if (!pendingPrompt && previousRoundHadToolCalls && !injectedCautionRemediation) {
        const snapshot = dlg.getLastContextHealth();
        if (snapshot && snapshot.kind === 'available' && snapshot.level === 'caution') {
          const language = getWorkLanguage();
          pendingPrompt = {
            content: formatAgentFacingContextHealthV3RemediationGuide(language, {
              kind: 'caution',
              mode: 'soft',
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            userLanguageCode: language,
          };
          injectedCautionRemediation = true;
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

      const canonicalFuncTools: FuncTool[] = agentTools.filter(
        (t): t is FuncTool => t.type === 'func',
      );
      const isSubdialog = dlg.id.rootId !== dlg.id.selfId;
      const fbrEffortDefault = resolveFbrEffortDefaultForTool(agent);
      const effectiveFuncTools: FuncTool[] = policy.allowFunctionCalls
        ? mergeTellaskSpecialVirtualTools(canonicalFuncTools, {
            includeTellaskBack: isSubdialog,
            fbrEffortDefault,
            providerApiType: providerCfg.apiType,
          })
        : canonicalFuncTools;
      const projected = projectFuncToolsForProvider(providerCfg.apiType, effectiveFuncTools);
      const funcTools = projected.tools;

      let contextHealthForGen: ContextHealthSnapshot | undefined;
      let llmGenModelForGen: string = model;
      let suspendForHuman = false;
      previousRoundHadToolCalls = false;

      await dlg.notifyGeneratingStart();
      try {
        const currentPrompt = pendingPrompt;
        pendingPrompt = undefined;

        if (currentPrompt) {
          const origin = currentPrompt.origin ?? 'user';
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

          await dlg.addChatMessages({
            type: 'prompting_msg',
            role: 'user',
            genseq: dlg.activeGenSeq,
            msgId: currentPrompt.msgId,
            grammar: 'markdown',
            content: currentPrompt.content,
          });
          await dlg.persistUserMessage(
            currentPrompt.content,
            currentPrompt.msgId,
            'markdown',
            persistedUserLanguageCode,
            q4hAnswerCallIds,
          );

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
            const record: TeammateCallAnchorRecord = {
              ts: formatUnifiedTimestamp(new Date()),
              type: 'teammate_call_anchor_record',
              anchorRole: 'assignment',
              callId: normalizedCallId,
              genseq: dlg.activeGenSeq,
            };
            const course = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
            await DialogPersistence.appendEvent(dlg.id, course, record, dlg.status);
          }
        }

        const taskDocMsg =
          dlg.taskDocPath && !skipTaskdocForThisDrive ? await formatTaskDocContent(dlg) : undefined;

        const renderedReminders = await renderRemindersForContext(dlg);
        const uiLanguage = dlg.getLastUserLanguageCode();
        const workingLanguage = getWorkLanguage();
        const guideMsg: ChatMessage = {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: formatCurrentUserLanguagePreference(workingLanguage, uiLanguage),
        };

        const ctxMsgs: ChatMessage[] = assembleDriveContextMessages({
          base: {
            prependedContextMessages: policy.prependedContextMessages,
            memories: minds.memories,
            taskDocMsg,
            coursePrefixMsgs: dlg.getCoursePrefixMsgs(),
            dialogMsgsForContext: await buildDialogMsgsForContext(dlg),
          },
          ephemeral: {},
          tail: { renderedReminders, languageGuideMsg: guideMsg },
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
              maxRetries: 0,
              canRetry: () => false,
              doRequest: async () => {
                return await llmGen.genMoreMessages(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  ctxMsgs,
                  dlg.activeGenSeq,
                  abortSignal,
                );
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
          const receiver: LlmStreamReceiver = {
            streamError: async (detail: string) => {
              await dlg.streamError(detail);
            },
            thinkingStart: async () => {
              throwIfAborted(abortSignal, dlg);
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
              await dlg.sayingFinish();
              const sayingMessage: SayingMsg = {
                type: 'saying_msg',
                role: 'assistant',
                genseq: dlg.activeGenSeq,
                content: currentSayingContent,
              };
              newMsgs.push(sayingMessage);
              lastAssistantSayingContent = currentSayingContent;
              lastAssistantSayingGenseq = sayingMessage.genseq;
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
          };

          const res = await runLlmRequestWithRetry({
            dlg,
            provider,
            abortSignal,
            maxRetries: 0,
            canRetry: () => false,
            doRequest: async () => {
              return await llmGen.genToReceiver(
                providerCfg,
                agent,
                systemPrompt,
                funcTools,
                ctxMsgs,
                receiver,
                dlg.activeGenSeq,
                abortSignal,
              );
            },
          });
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
              await emitAssistantSaying(dlg, msg.content);
            }
          }
          const funcCalls = llmOutput.batchMessages.filter(
            (m): m is FuncCallMsg => m.type === 'func_call_msg',
          );
          streamedFuncCalls.push(...funcCalls);
        }

        const tellaskCallCount = streamedFuncCalls.filter(
          (c) =>
            c.name === 'tellask' ||
            c.name === 'tellaskSessionless' ||
            c.name === 'tellaskBack' ||
            c.name === 'askHuman' ||
            c.name === 'freshBootsReasoning',
        ).length;
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
          return {
            lastAssistantSayingContent,
            lastAssistantSayingGenseq,
            lastFunctionCallGenseq,
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
        });
        if (routed.tellaskToolOutputs.length > 0) {
          newMsgs.push(...routed.tellaskToolOutputs);
        }
        if (routed.pairedMessages.length > 0) {
          newMsgs.push(...routed.pairedMessages);
        }
        if (routed.suspendForHuman) {
          suspendForHuman = true;
        }

        await dlg.addChatMessages(...newMsgs);

        if (dlg.hasUpNext()) {
          pendingPrompt = resolveUpNextPrompt(dlg);
          previousRoundHadToolCalls =
            routed.pairedMessages.some((m) => m.type === 'func_result_msg') ||
            routed.tellaskToolOutputs.length > 0;
          continue;
        }

        if (suspendForHuman) {
          break;
        }

        const shouldContinue =
          streamedFuncCalls.length > 0 ||
          routed.pairedMessages.length > 0 ||
          routed.tellaskToolOutputs.length > 0;
        if (shouldContinue) {
          previousRoundHadToolCalls =
            streamedFuncCalls.length > 0 || routed.tellaskToolOutputs.length > 0;
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
      } finally {
        await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
      }
    }

    throwIfAborted(abortSignal, dlg);
    finalRunState = await computeIdleRunState(dlg);
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
      finalRunState = { kind: 'interrupted', reason: interruptedReason };
      broadcastRunStateMarker(dlg.id, { kind: 'interrupted', reason: interruptedReason });
    } else {
      const errText = extractErrorDetails(err).message;
      try {
        await dlg.streamError(errText);
      } catch {
        // best-effort
      }
      finalRunState = { kind: 'interrupted', reason: { kind: 'system_stop', detail: errText } };
      broadcastRunStateMarker(dlg.id, {
        kind: 'interrupted',
        reason: { kind: 'system_stop', detail: errText },
      });
    }
  } finally {
    if (!finalRunState) {
      try {
        finalRunState = await computeIdleRunState(dlg);
      } catch (stateErr) {
        log.warn(
          'kernel-driver failed to compute final run state; falling back to idle',
          stateErr,
          {
            dialogId: dlg.id.valueOf(),
          },
        );
        finalRunState = { kind: 'idle_waiting_user' };
      }
    }

    if (
      abortSignal.aborted &&
      finalRunState.kind !== 'interrupted' &&
      finalRunState.kind !== 'dead'
    ) {
      const stopRequested = getStopRequestedReason(dlg.id);
      const lateInterruptedReason: DialogInterruptionReason =
        stopRequested === 'emergency_stop'
          ? { kind: 'emergency_stop' }
          : stopRequested === 'user_stop'
            ? { kind: 'user_stop' }
            : { kind: 'system_stop', detail: 'Aborted.' };
      finalRunState = { kind: 'interrupted', reason: lateInterruptedReason };
      broadcastRunStateMarker(dlg.id, { kind: 'interrupted', reason: lateInterruptedReason });
    }

    try {
      const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
      if (dlg.id.selfId !== dlg.id.rootId && latest?.runState?.kind === 'dead') {
        finalRunState = latest.runState;
      }
    } catch (err) {
      log.warn('kernel-driver failed to re-check runState before finalizing', err, {
        dialogId: dlg.id.valueOf(),
      });
    }

    await setDialogRunState(dlg.id, finalRunState);
  }

  return {
    lastAssistantSayingContent,
    lastAssistantSayingGenseq,
    lastFunctionCallGenseq,
  };
}
