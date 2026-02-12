import { Dialog, RootDialog } from '../../dialog';
import {
  broadcastRunStateMarker,
  clearActiveRun,
  computeIdleRunState,
  createActiveRun,
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
import { Team } from '../../team';
import type { FuncTool, Tool, ToolArguments, ToolCallOutput } from '../../tool';
import { formatTaskDocContent } from '../../utils/taskdoc';
import {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  LlmConfig,
  SayingMsg,
  ThinkingMsg,
  type ModelInfo,
  type ProviderConfig,
} from '../client';
import { getLlmGenerator } from '../gen/registry';
import { projectFuncToolsForProvider } from '../tools-projection';
import { assembleDriveContextMessages } from './context';
import {
  consumeCriticalCountdown,
  decideDriverV2ContextHealth,
  DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
  resetContextHealthRoundState,
  resolveCriticalCountdownRemaining,
} from './context-health';
import {
  buildDriverV2Policy,
  resolveDriverV2PolicyViolationKind,
  validateDriverV2PolicyInvariants,
} from './policy';
import {
  maybePrepareDiligenceAutoContinuePrompt,
  runLlmRequestWithRetry,
  suspendForKeepGoingBudgetExhausted,
  validateFuncToolArguments,
} from './runtime-utils';
import { emitThinkingEvents } from './saying-events';
import {
  classifyTellaskSpecialFunctionCalls,
  executeTellaskSpecialCalls,
  isTellaskSpecialFunctionName,
} from './tellask-bridge';
import type {
  DriverV2CoreResult,
  DriverV2DriveInvoker,
  DriverV2DriveOptions,
  DriverV2DriveScheduler,
  DriverV2HumanPrompt,
} from './types';

class DialogInterruptedError extends Error {
  public readonly reason: DialogInterruptionReason;

  constructor(reason: DialogInterruptionReason) {
    super('Dialog interrupted');
    this.reason = reason;
  }
}

function throwIfAborted(abortSignal: AbortSignal | undefined, dialog: Dialog): void {
  if (!abortSignal?.aborted) {
    return;
  }

  const stopRequested = getStopRequestedReason(dialog.id);
  if (stopRequested === 'emergency_stop') {
    throw new DialogInterruptedError({ kind: 'emergency_stop' });
  }
  if (stopRequested === 'user_stop') {
    throw new DialogInterruptedError({ kind: 'user_stop' });
  }
  throw new DialogInterruptedError({ kind: 'system_stop', detail: 'Aborted.' });
}

function resolveMemberDiligencePushMax(team: Team, agentId: string): number {
  const member = team.getMember(agentId);
  if (member && member.diligence_push_max !== undefined) {
    return member.diligence_push_max;
  }
  return DEFAULT_DILIGENCE_PUSH_MAX;
}

function resolveUpNextPrompt(dlg: Dialog): DriverV2HumanPrompt | undefined {
  const upNext = dlg.takeUpNext();
  if (!upNext) {
    return undefined;
  }
  return {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: upNext.grammar ?? 'markdown',
    userLanguageCode: upNext.userLanguageCode,
    q4hAnswerCallIds: upNext.q4hAnswerCallIds,
  };
}

function isUserOriginPrompt(prompt: DriverV2HumanPrompt | undefined): boolean {
  if (!prompt) {
    return false;
  }
  return (prompt.origin ?? 'user') === 'user';
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

async function emitUserMarkdown(dlg: Dialog, content: string): Promise<void> {
  if (!content.trim()) {
    return;
  }
  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();
}

function resolveModelInfo(providerCfg: ProviderConfig, model: string): ModelInfo | undefined {
  return providerCfg.models[model];
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

function resolveEffectiveOptimalMaxTokens(args: {
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
      throw new Error('tellaskBack is handled by driver-v2 tellask-special channel');
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
      throw new Error('tellask is handled by driver-v2 tellask-special channel');
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
      throw new Error('tellaskSessionless is handled by driver-v2 tellask-special channel');
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
      throw new Error('askHuman is handled by driver-v2 tellask-special channel');
    },
  },
  {
    type: 'func',
    name: 'freshBootsReasoning',
    description: 'Start an FBR sideline dialog for tool-less fresh-boots reasoning.',
    parameters: {
      type: 'object',
      properties: {
        tellaskContent: { type: 'string' },
      },
      required: ['tellaskContent'],
      additionalProperties: false,
    },
    call: async (): Promise<ToolCallOutput> => {
      throw new Error('freshBootsReasoning is handled by driver-v2 tellask-special channel');
    },
  },
];

function mergeTellaskSpecialVirtualTools(baseTools: readonly FuncTool[]): FuncTool[] {
  const merged: FuncTool[] = [...baseTools];
  const seen = new Set(merged.map((tool) => tool.name));
  for (const virtualTool of TELLASK_SPECIAL_VIRTUAL_TOOLS) {
    if (seen.has(virtualTool.name)) {
      throw new Error(
        `driver-v2 tool invariant violation: function tool name '${virtualTool.name}' collides with tellask-special virtual tool`,
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
  } = resolveEffectiveOptimalMaxTokens({
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

async function buildProviderContext(args: {
  dialog: Dialog;
  team: Team;
  agent: Team.Member;
}): Promise<{
  provider: string;
  model: string;
  providerCfg: ProviderConfig;
}> {
  const provider = args.agent.provider ?? args.team.memberDefaults.provider;
  const model = args.agent.model ?? args.team.memberDefaults.model;

  if (!provider) {
    throw new Error(
      `Configuration Error: No provider configured for agent '${args.dialog.agentId}'. Please specify a provider in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
    );
  }

  if (!model) {
    throw new Error(
      `Configuration Error: No model configured for agent '${args.dialog.agentId}'. Please specify a model in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
    );
  }

  const llmCfg = await LlmConfig.load();
  const providerCfg = llmCfg.getProvider(provider);
  if (!providerCfg) {
    throw new Error(
      `Provider configuration error: Provider '${provider}' not found for agent '${args.dialog.agentId}'. Please check .minds/llm.yaml and .minds/team.yaml configuration.`,
    );
  }

  const modelInfo = resolveModelInfo(providerCfg, model);
  if (!modelInfo) {
    const uiLanguage = args.dialog.getUiLanguage();
    const msg =
      uiLanguage === 'zh'
        ? [
            '配置错误：当前成员的模型配置无效。',
            '',
            `- member: ${args.agent.name} (${args.dialog.agentId})`,
            `- provider: ${provider}`,
            `- model: ${model}（这是 model key；在该 provider 的 models 列表中不存在，或该 provider 缺少 models 配置）`,
            '',
            '请联系团队管理者修复：',
            `- 在 .minds/team.yaml 中把该成员的 provider/model 改成有效 key；或`,
            `- 在 .minds/llm.yaml 的 providers.${provider}.models 下补齐该 model key。`,
            '',
            '提示：你也可以打开 WebUI 的 `/setup` 查看当前 rtws（运行时工作区）可用的 provider/model 列表。',
            '',
            '团队管理者修复后建议运行：`team_mgmt_validate_team_cfg({})`。',
          ].join('\n')
        : [
            'Configuration error: invalid model selection for this member.',
            '',
            `- member: ${args.agent.name} (${args.dialog.agentId})`,
            `- provider: ${provider}`,
            `- model: ${model} (this is a model key; not found under this provider's models list, or the provider has no models configured)`,
            '',
            'Please contact your team manager to fix:',
            `- Update the member\'s provider/model keys in .minds/team.yaml, or`,
            `- Add the model key under .minds/llm.yaml providers.${provider}.models.`,
            '',
            'Tip: you can also open the WebUI `/setup` page to see available provider/model keys for this rtws (runtime workspace).',
            '',
            'After the fix, the team manager should run: `team_mgmt_validate_team_cfg({})`.',
          ].join('\n');
    throw new Error(msg);
  }

  return { provider, model, providerCfg };
}

async function executeFunctionCalls(args: {
  dialog: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  abortSignal: AbortSignal;
}): Promise<FuncResultMsg[]> {
  const { dialog, agent, agentTools, funcCalls, abortSignal } = args;
  const functionPromises = funcCalls.map(async (func): Promise<FuncResultMsg> => {
    throwIfAborted(abortSignal, dialog);

    const callGenseq = func.genseq;
    const argsStr =
      typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments ?? {});

    const tool = agentTools.find((t): t is FuncTool => t.type === 'func' && t.name === func.name);
    if (!tool) {
      const errorResult: FuncResultMsg = {
        type: 'func_result_msg',
        id: func.id,
        name: func.name,
        content: `Tool '${func.name}' not found`,
        role: 'tool',
        genseq: callGenseq,
      };
      await dialog.receiveFuncResult(errorResult);
      return errorResult;
    }

    let rawArgs: unknown = {};
    if (typeof func.arguments === 'string' && func.arguments.trim()) {
      try {
        rawArgs = JSON.parse(func.arguments);
      } catch (parseErr) {
        rawArgs = null;
        log.warn('driver-v2 failed to parse function arguments as JSON', undefined, {
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

      try {
        await dialog.funcCallRequested(func.id, func.name, argsStr);
      } catch (err) {
        log.warn('driver-v2 failed to emit func_call_requested event', err);
      }

      try {
        await dialog.persistFunctionCall(func.id, func.name, argsObj, callGenseq);
      } catch (err) {
        log.warn('driver-v2 failed to persist function call', err);
      }

      try {
        throwIfAborted(abortSignal, dialog);
        const output: ToolCallOutput = await tool.call(dialog, agent, argsObj);
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

    await dialog.receiveFuncResult(result);
    return result;
  });

  return await Promise.all(functionPromises);
}

async function executeRoutedFunctionCalls(args: {
  dialog: Dialog;
  agent: Team.Member;
  agentTools: readonly Tool[];
  funcCalls: readonly FuncCallMsg[];
  callbacks?: {
    scheduleDrive: DriverV2DriveScheduler;
    driveDialog: DriverV2DriveInvoker;
  };
  abortSignal: AbortSignal;
}): Promise<{
  suspendForHuman: boolean;
  pairedMessages: ChatMessage[];
  tellaskToolOutputs: ChatMessage[];
}> {
  const { dialog, agent, agentTools, funcCalls, callbacks, abortSignal } = args;
  if (funcCalls.length === 0) {
    return { suspendForHuman: false, pairedMessages: [], tellaskToolOutputs: [] };
  }

  const classified = classifyTellaskSpecialFunctionCalls(funcCalls);
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
        return { tellaskContent: call.tellaskContent };
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

  for (const callMsg of funcCalls) {
    const special = specialCallById.get(callMsg.id);
    if (!special) {
      continue;
    }
    try {
      await dialog.persistFunctionCall(
        callMsg.id,
        callMsg.name,
        toPersistedSpecialCallArgs(special),
        callMsg.genseq,
      );
    } catch (err) {
      log.warn('driver-v2 failed to persist special function call', err, {
        dialogId: dialog.id.valueOf(),
        callId: callMsg.id,
        callName: callMsg.name,
      });
    }
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
    await dialog.receiveFuncResult(result);
    issueResults.push(result);
  }

  const specialResult = await executeTellaskSpecialCalls({
    dlg: dialog,
    agent,
    calls: classified.specialCalls,
    callbacks,
  });
  const specialCallIds = new Set(classified.specialCalls.map((call) => call.callId));

  const genericResults = await executeFunctionCalls({
    dialog,
    agent,
    agentTools,
    funcCalls: classified.normalCalls,
    abortSignal,
  });

  const resultByCallId = new Map<string, FuncResultMsg>();
  const register = (result: FuncResultMsg): void => {
    const existing = resultByCallId.get(result.id);
    if (existing) {
      throw new Error(
        `driver-v2 function result invariant violation: duplicate call id '${result.id}'`,
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
  for (const call of funcCalls) {
    pairedMessages.push(call);
    const result = resultByCallId.get(call.id);
    if (result) {
      pairedMessages.push(result);
      continue;
    }
    if (specialCallIds.has(call.id)) {
      // Tellask-special calls get func_result via dynamic context projection instead of persisted records.
      continue;
    }
    if (!result) {
      throw new Error(
        `driver-v2 function result invariant violation: missing result for call id '${call.id}' (${call.name})`,
      );
    }
  }

  return {
    suspendForHuman: specialResult.suspend,
    pairedMessages,
    tellaskToolOutputs: specialResult.toolOutputs,
  };
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
    log.warn('driver-v2 failed to reset Diligence Push budget after Q4H', err, {
      dialogId: dlg.id.valueOf(),
    });
  }
}

async function maybeContinueWithDiligencePrompt(args: {
  dlg: Dialog;
  team: Team;
  suppressDiligencePushForDrive: boolean;
}): Promise<{ kind: 'break' } | { kind: 'continue'; prompt: DriverV2HumanPrompt }> {
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

export async function driveDialogStreamCoreV2(
  dlg: Dialog,
  humanPrompt?: DriverV2HumanPrompt,
  driveOptions?: DriverV2DriveOptions,
  callbacks?: {
    scheduleDrive: DriverV2DriveScheduler;
    driveDialog: DriverV2DriveInvoker;
  },
): Promise<DriverV2CoreResult> {
  const suppressDiligencePushForDrive = driveOptions?.suppressDiligencePush === true;
  const abortSignal = createActiveRun(dlg.id);

  let finalRunState: DialogRunState | undefined;
  let shouldEmitResumedMarker = false;
  if (!humanPrompt) {
    try {
      const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
      shouldEmitResumedMarker =
        latest !== null &&
        latest !== undefined &&
        latest.runState !== undefined &&
        latest.runState.kind === 'interrupted';
    } catch (err) {
      log.warn('driver-v2 failed to load latest.yaml for resumption marker', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
  }

  if (shouldEmitResumedMarker) {
    broadcastRunStateMarker(dlg.id, { kind: 'resumed' });
  }

  await setDialogRunState(dlg.id, { kind: 'proceeding' });

  let pubRemindersVer = dlg.remindersVer;
  let lastAssistantSayingContent: string | null = null;
  let lastAssistantSayingGenseq: number | null = null;
  let lastFunctionCallGenseq: number | null = null;
  let internalDrivePromptMsg: ChatMessage | undefined;

  let genIterNo = 0;
  let pendingPrompt: DriverV2HumanPrompt | undefined = humanPrompt;
  let skipTaskdocForThisDrive = humanPrompt?.skipTaskdoc === true;

  try {
    while (true) {
      genIterNo += 1;
      throwIfAborted(abortSignal, dlg);

      const minds = await loadAgentMinds(dlg.agentId, dlg);
      const team = minds.team;
      const policy = buildDriverV2Policy({
        dlg,
        agent: minds.agent,
        systemPrompt: minds.systemPrompt,
        agentTools: minds.agentTools,
        language: getWorkLanguage(),
      });
      const policyValidation = validateDriverV2PolicyInvariants(policy, getWorkLanguage());
      if (!policyValidation.ok) {
        throw new Error(`driver-v2 policy invariant violation: ${policyValidation.detail}`);
      }

      let agent = policy.effectiveAgent;
      let systemPrompt = policy.effectiveSystemPrompt;
      const memories = minds.memories;
      const agentTools = policy.effectiveAgentTools;

      const { provider, model, providerCfg } = await buildProviderContext({
        dialog: dlg,
        team,
        agent,
      });

      const llmGen = getLlmGenerator(providerCfg.apiType);
      if (!llmGen) {
        throw new Error(
          `LLM generator not found: API type '${providerCfg.apiType}' for provider '${provider}' in agent '${dlg.agentId}'. Please check .minds/llm.yaml configuration.`,
        );
      }

      const canonicalFuncTools: FuncTool[] = agentTools.filter(
        (t): t is FuncTool => t.type === 'func',
      );
      const effectiveFuncTools: FuncTool[] = policy.allowFunctionCalls
        ? mergeTellaskSpecialVirtualTools(canonicalFuncTools)
        : canonicalFuncTools;
      const projected = projectFuncToolsForProvider(providerCfg.apiType, effectiveFuncTools);
      const funcTools = projected.tools;

      if (genIterNo > 1) {
        const snapshot = dlg.getLastContextHealth();
        const hasQueuedUpNext = dlg.hasUpNext() || pendingPrompt !== undefined;
        const criticalCountdownRemaining = resolveCriticalCountdownRemaining(
          dlg.id.key(),
          snapshot,
        );
        const healthDecision = decideDriverV2ContextHealth({
          snapshot,
          hadUserPromptThisGen: isUserOriginPrompt(pendingPrompt),
          criticalCountdownRemaining,
        });

        if (healthDecision.kind === 'suspend') {
          log.debug(
            'driver-v2 suspend iterative generation due to critical context while waiting for human prompt',
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
            const newCoursePrompt =
              language === 'zh'
                ? '系统因上下文已告急（critical）而自动开启新一程对话，请继续推进任务。'
                : 'System auto-started a new dialog course because context health is critical. Please continue the task.';
            await dlg.startNewCourse(newCoursePrompt);
            dlg.setLastContextHealth({ kind: 'unavailable', reason: 'usage_unavailable' });
            resetContextHealthRoundState(dlg.id.key());

            const nextPrompt = resolveUpNextPrompt(dlg);
            if (!nextPrompt) {
              throw new Error(
                `driver-v2 critical force-new-course invariant violation: missing upNext prompt after startNewCourse for dialog=${dlg.id.valueOf()}`,
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
                    promptsTotal: DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS,
                  });
            pendingPrompt = {
              content: guideText,
              msgId: generateShortId(),
              grammar: 'markdown',
              userLanguageCode: language,
            };
          }
        }
      }

      let suspendForHuman = false;
      let llmGenModelForGen: string = model;
      let contextHealthForGen: ContextHealthSnapshot | undefined;

      await dlg.notifyGeneratingStart();
      try {
        const currentPrompt = pendingPrompt;
        pendingPrompt = undefined;

        if (currentPrompt) {
          const promptOrigin = currentPrompt.origin ?? 'user';
          const isDiligencePrompt = promptOrigin === 'diligence_push';
          if (isDiligencePrompt && (dlg.disableDiligencePush || suppressDiligencePushForDrive)) {
            log.debug('driver-v2 skip diligence prompt after disable toggle', undefined, {
              dialogId: dlg.id.valueOf(),
              msgId: currentPrompt.msgId,
            });
            break;
          }

          if (currentPrompt.skipTaskdoc === true) {
            skipTaskdocForThisDrive = true;
          }

          const promptContent = currentPrompt.content;
          const msgId = currentPrompt.msgId;
          const promptGrammar = currentPrompt.grammar;
          const persistedUserLanguageCode =
            currentPrompt.userLanguageCode ?? dlg.getLastUserLanguageCode();
          const q4hAnswerCallIds = normalizeQ4HAnswerCallIds(currentPrompt.q4hAnswerCallIds);

          const requestedPersistMode = currentPrompt.persistMode ?? 'persist';
          const persistMode = isDiligencePrompt ? 'persist' : requestedPersistMode;

          if (persistMode === 'internal') {
            const injected = currentPrompt.content.trim();
            internalDrivePromptMsg = injected
              ? {
                  type: 'environment_msg',
                  role: 'user',
                  content: injected,
                }
              : undefined;
          } else {
            await dlg.addChatMessages({
              type: 'prompting_msg',
              role: 'user',
              genseq: dlg.activeGenSeq,
              content: promptContent,
              msgId,
              grammar: promptGrammar,
            });
            await dlg.persistUserMessage(
              promptContent,
              msgId,
              promptGrammar,
              persistedUserLanguageCode,
              q4hAnswerCallIds,
            );
            if (currentPrompt.subdialogReplyTarget) {
              const normalizedCallId = currentPrompt.subdialogReplyTarget.callId.trim();
              if (normalizedCallId === '') {
                throw new Error(
                  `driver-v2 assignment anchor invariant violation: empty callId for subdialogReplyTarget (dialog=${dlg.id.valueOf()})`,
                );
              }
              const rawCourse = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
              if (!Number.isFinite(rawCourse) || rawCourse <= 0) {
                throw new Error(
                  `driver-v2 assignment anchor invariant violation: invalid course=${String(rawCourse)} (dialog=${dlg.id.valueOf()})`,
                );
              }
              const rawGenseq = dlg.activeGenSeq;
              if (!Number.isFinite(rawGenseq) || rawGenseq <= 0) {
                throw new Error(
                  `driver-v2 assignment anchor invariant violation: invalid genseq=${String(rawGenseq)} (dialog=${dlg.id.valueOf()})`,
                );
              }
              const assignmentAnchor: TeammateCallAnchorRecord = {
                ts: formatUnifiedTimestamp(new Date()),
                type: 'teammate_call_anchor_record',
                anchorRole: 'assignment',
                callId: normalizedCallId,
                genseq: Math.floor(rawGenseq),
              };
              await DialogPersistence.appendEvent(dlg.id, Math.floor(rawCourse), assignmentAnchor);
            }
          }

          if (persistMode !== 'internal') {
            await emitUserMarkdown(dlg, promptContent);
          }

          if (persistMode !== 'internal') {
            try {
              postDialogEvent(dlg, {
                type: 'end_of_user_saying_evt',
                course: dlg.currentCourse,
                genseq: dlg.activeGenSeq,
                msgId,
                content: promptContent,
                grammar: promptGrammar,
                userLanguageCode: persistedUserLanguageCode,
                q4hAnswerCallIds,
              });
            } catch (err) {
              log.warn('driver-v2 failed to emit end_of_user_saying_evt', err);
            }
          }
        }

        if (suspendForHuman) {
          await resetDiligenceBudgetAfterQ4H(dlg, team);
          break;
        }

        const taskDocMsg: ChatMessage | undefined =
          dlg.taskDocPath && !skipTaskdocForThisDrive ? await formatTaskDocContent(dlg) : undefined;

        const coursePrefixMsgs: ChatMessage[] = (() => {
          const msgs = dlg.getCoursePrefixMsgs();
          return msgs.length > 0 ? [...msgs] : [];
        })();

        const rawDialogMsgsForContext: ChatMessage[] = dlg.msgs.filter((m) => {
          if (!m) return false;
          if (m.type === 'ui_only_markdown_msg') return false;
          return true;
        });
        const dialogMsgsForContext = await projectTellaskSpecialFuncResultsForContext({
          dialog: dlg,
          dialogMsgsForContext: rawDialogMsgsForContext,
        });

        await dlg.processReminderUpdates();
        const renderedReminders: ChatMessage[] =
          dlg.reminders.length > 0
            ? await Promise.all(
                dlg.reminders.map(async (reminder, index): Promise<ChatMessage> => {
                  if (reminder.owner) {
                    return await reminder.owner.renderReminder(dlg, reminder, index);
                  }
                  return {
                    type: 'environment_msg',
                    role: 'user',
                    content: formatReminderItemGuide(
                      getWorkLanguage(),
                      index + 1,
                      reminder.content,
                      {
                        meta: reminder.meta,
                      },
                    ),
                  };
                }),
              )
            : [];

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
            memories,
            taskDocMsg,
            coursePrefixMsgs,
            dialogMsgsForContext,
          },
          ephemeral: {
            internalDrivePromptMsg,
          },
          tail: {
            renderedReminders,
            languageGuideMsg: guideMsg,
          },
        });

        if (agent.streaming === false) {
          const nonStreamResult = await runLlmRequestWithRetry({
            dlg,
            provider,
            abortSignal,
            maxRetries: 5,
            canRetry: () => true,
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

          if (
            typeof nonStreamResult.llmGenModel === 'string' &&
            nonStreamResult.llmGenModel.trim() !== ''
          ) {
            llmGenModelForGen = nonStreamResult.llmGenModel.trim();
          }
          contextHealthForGen = computeContextHealthSnapshot({
            providerCfg,
            model,
            usage: nonStreamResult.usage,
          });
          dlg.setLastContextHealth(contextHealthForGen);

          const nonStreamMsgs = nonStreamResult.messages;
          const assistantMsgs = nonStreamMsgs.filter(
            (m): m is SayingMsg | ThinkingMsg =>
              m.type === 'saying_msg' || m.type === 'thinking_msg',
          );

          if (assistantMsgs.length > 0) {
            await dlg.addChatMessages(...assistantMsgs);

            for (const msg of assistantMsgs) {
              if (
                msg.role === 'assistant' &&
                msg.genseq !== undefined &&
                (msg.type === 'thinking_msg' || msg.type === 'saying_msg')
              ) {
                if (msg.type === 'saying_msg') {
                  lastAssistantSayingContent = msg.content;
                  lastAssistantSayingGenseq = msg.genseq;
                  await dlg.persistAgentMessage(msg.content, msg.genseq, 'saying_msg');
                  await emitUserMarkdown(dlg, msg.content);
                }
                if (msg.type === 'thinking_msg') {
                  await emitThinkingEvents(dlg, msg.content);
                }
              }
            }
          }

          const funcCalls = nonStreamMsgs.filter(
            (m): m is FuncCallMsg => m.type === 'func_call_msg',
          );
          for (const call of funcCalls) {
            const rawCallGenseq = call.genseq;
            if (!Number.isFinite(rawCallGenseq) || rawCallGenseq <= 0) {
              continue;
            }
            const callGenseq = Math.floor(rawCallGenseq);
            if (lastFunctionCallGenseq === null || callGenseq > lastFunctionCallGenseq) {
              lastFunctionCallGenseq = callGenseq;
            }
          }
          const toolPolicyViolation = resolveDriverV2PolicyViolationKind({
            policy,
            tellaskCallCount: 0,
            functionCallCount: funcCalls.length,
          });
          if (toolPolicyViolation === 'tool') {
            const violationText = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
              kind: 'tool',
            });
            const genseq = dlg.activeGenSeq ?? 0;
            await dlg.addChatMessages({
              type: 'saying_msg',
              role: 'assistant',
              genseq,
              content: violationText,
            });
            lastAssistantSayingContent = violationText;
            lastAssistantSayingGenseq = genseq;
            await dlg.persistAgentMessage(violationText, genseq, 'saying_msg');
            return {
              lastAssistantSayingContent,
              lastAssistantSayingGenseq,
              lastFunctionCallGenseq,
              interrupted: false,
            };
          }

          const routedFunctionResult = await executeRoutedFunctionCalls({
            dialog: dlg,
            agent,
            agentTools,
            funcCalls,
            callbacks,
            abortSignal,
          });

          if (routedFunctionResult.tellaskToolOutputs.length > 0) {
            await dlg.addChatMessages(...routedFunctionResult.tellaskToolOutputs);
          }

          if (routedFunctionResult.pairedMessages.length > 0) {
            await dlg.addChatMessages(...routedFunctionResult.pairedMessages);
          }

          if (routedFunctionResult.suspendForHuman) {
            suspendForHuman = true;
          }

          if (dlg.hasUpNext()) {
            pendingPrompt = resolveUpNextPrompt(dlg);
            continue;
          }

          if (suspendForHuman) {
            await resetDiligenceBudgetAfterQ4H(dlg, team);
            break;
          }

          const shouldContinue =
            funcCalls.length > 0 ||
            routedFunctionResult.pairedMessages.length > 0 ||
            routedFunctionResult.tellaskToolOutputs.length > 0;
          if (!shouldContinue) {
            const next = await maybeContinueWithDiligencePrompt({
              dlg,
              team,
              suppressDiligencePushForDrive,
            });
            if (next.kind === 'continue') {
              pendingPrompt = next.prompt;
              continue;
            }
            break;
          }

          continue;
        }

        const newMsgs: ChatMessage[] = [];
        const streamedFuncCalls: FuncCallMsg[] = [];

        let currentThinkingContent = '';
        let currentThinkingSignature = '';
        let currentSayingContent = '';
        let sawAnyStreamContent = false;

        type StreamActiveState = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'saying' };
        let streamActive: StreamActiveState = { kind: 'idle' };

        const streamResult = await runLlmRequestWithRetry({
          dlg,
          provider,
          abortSignal,
          maxRetries: 5,
          canRetry: () => !sawAnyStreamContent,
          doRequest: async () => {
            return await llmGen.genToReceiver(
              providerCfg,
              agent,
              systemPrompt,
              funcTools,
              ctxMsgs,
              {
                streamError: async (detail: string) => {
                  await dlg.streamError(detail);
                },
                thinkingStart: async () => {
                  throwIfAborted(abortSignal, dlg);
                  sawAnyStreamContent = true;
                  if (streamActive.kind !== 'idle') {
                    const detail = `Protocol violation: thinkingStart while ${streamActive.kind} is active`;
                    await dlg.streamError(detail);
                    throw new Error(detail);
                  }
                  streamActive = { kind: 'thinking' };
                  currentThinkingContent = '';
                  currentThinkingSignature = '';
                  await dlg.thinkingStart();
                },
                thinkingChunk: async (chunk: string) => {
                  throwIfAborted(abortSignal, dlg);
                  sawAnyStreamContent = true;
                  currentThinkingContent += chunk;
                  const signatureMatch = currentThinkingContent.match(
                    /<thinking[^>]*>(.*?)<\/thinking>/s,
                  );
                  if (signatureMatch && signatureMatch[1]) {
                    currentThinkingSignature = signatureMatch[1].trim();
                  }
                  await dlg.thinkingChunk(chunk);
                },
                thinkingFinish: async () => {
                  throwIfAborted(abortSignal, dlg);
                  if (streamActive.kind !== 'thinking') {
                    const detail = `Protocol violation: thinkingFinish while ${streamActive.kind} is active`;
                    await dlg.streamError(detail);
                    throw new Error(detail);
                  }
                  streamActive = { kind: 'idle' };
                  const genseq = dlg.activeGenSeq;
                  if (genseq) {
                    const thinkingMessage: ThinkingMsg = {
                      type: 'thinking_msg',
                      role: 'assistant',
                      genseq,
                      content: currentThinkingContent,
                      provider_data: currentThinkingSignature
                        ? { signature: currentThinkingSignature }
                        : undefined,
                    };
                    newMsgs.push(thinkingMessage);
                  }
                  await dlg.thinkingFinish();
                },
                sayingStart: async () => {
                  throwIfAborted(abortSignal, dlg);
                  sawAnyStreamContent = true;
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
                  sawAnyStreamContent = true;
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

                  const sayingMessage: SayingMsg = {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq: dlg.activeGenSeq,
                    content: currentSayingContent,
                  };
                  newMsgs.push(sayingMessage);
                  lastAssistantSayingContent = currentSayingContent;
                  lastAssistantSayingGenseq = sayingMessage.genseq;

                  await dlg.sayingFinish();
                },
                funcCall: async (callId: string, name: string, args: string) => {
                  throwIfAborted(abortSignal, dlg);
                  sawAnyStreamContent = true;
                  const genseq = dlg.activeGenSeq;
                  if (genseq === undefined) {
                    return;
                  }
                  streamedFuncCalls.push({
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id: callId,
                    name,
                    arguments: args,
                  });
                },
                webSearchCall: async (call) => {
                  throwIfAborted(abortSignal, dlg);
                  sawAnyStreamContent = true;
                  await dlg.webSearchCall(call);
                },
              },
              dlg.activeGenSeq,
              abortSignal,
            );
          },
        });

        if (
          typeof streamResult.llmGenModel === 'string' &&
          streamResult.llmGenModel.trim() !== ''
        ) {
          llmGenModelForGen = streamResult.llmGenModel.trim();
        }
        contextHealthForGen = computeContextHealthSnapshot({
          providerCfg,
          model,
          usage: streamResult.usage,
        });
        dlg.setLastContextHealth(contextHealthForGen);

        const policyViolation = resolveDriverV2PolicyViolationKind({
          policy,
          tellaskCallCount: 0,
          functionCallCount: streamedFuncCalls.length,
        });
        for (const call of streamedFuncCalls) {
          const rawCallGenseq = call.genseq;
          if (!Number.isFinite(rawCallGenseq) || rawCallGenseq <= 0) {
            continue;
          }
          const callGenseq = Math.floor(rawCallGenseq);
          if (lastFunctionCallGenseq === null || callGenseq > lastFunctionCallGenseq) {
            lastFunctionCallGenseq = callGenseq;
          }
        }
        if (policyViolation) {
          const violationText = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
            kind: policyViolation,
          });
          const genseq = dlg.activeGenSeq ?? 0;
          newMsgs.push({
            type: 'saying_msg',
            role: 'assistant',
            genseq,
            content: violationText,
          });
          lastAssistantSayingContent = violationText;
          lastAssistantSayingGenseq = genseq;
          await dlg.addChatMessages(...newMsgs);
          await dlg.persistAgentMessage(violationText, genseq, 'saying_msg');
          return {
            lastAssistantSayingContent,
            lastAssistantSayingGenseq,
            lastFunctionCallGenseq,
            interrupted: false,
          };
        }

        const routedFunctionResult = await executeRoutedFunctionCalls({
          dialog: dlg,
          agent,
          agentTools,
          funcCalls: streamedFuncCalls,
          callbacks,
          abortSignal,
        });

        if (routedFunctionResult.tellaskToolOutputs.length > 0) {
          newMsgs.push(...routedFunctionResult.tellaskToolOutputs);
        }
        if (routedFunctionResult.pairedMessages.length > 0) {
          newMsgs.push(...routedFunctionResult.pairedMessages);
        }
        if (routedFunctionResult.suspendForHuman) {
          suspendForHuman = true;
        }

        await dlg.addChatMessages(...newMsgs);

        if (dlg.hasUpNext()) {
          pendingPrompt = resolveUpNextPrompt(dlg);
          continue;
        }

        if (dlg.remindersVer > pubRemindersVer) {
          try {
            await dlg.processReminderUpdates();
            pubRemindersVer = dlg.remindersVer;
          } catch (err) {
            log.warn('driver-v2 failed to propagate reminder text after tools', err);
          }
        }

        if (suspendForHuman) {
          await resetDiligenceBudgetAfterQ4H(dlg, team);
          break;
        }

        const shouldContinue =
          streamedFuncCalls.length > 0 ||
          routedFunctionResult.pairedMessages.length > 0 ||
          routedFunctionResult.tellaskToolOutputs.length > 0;
        if (!shouldContinue) {
          const next = await maybeContinueWithDiligencePrompt({
            dlg,
            team,
            suppressDiligencePushForDrive,
          });
          if (next.kind === 'continue') {
            pendingPrompt = next.prompt;
            continue;
          }
          break;
        }
      } finally {
        await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
      }
    }

    finalRunState = await computeIdleRunState(dlg);
    return {
      lastAssistantSayingContent,
      lastAssistantSayingGenseq,
      lastFunctionCallGenseq,
      interrupted: false,
    };
  } catch (err) {
    const stopRequested = getStopRequestedReason(dlg.id);
    const interruptedReason: DialogInterruptionReason | undefined =
      err instanceof DialogInterruptedError
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
      return {
        lastAssistantSayingContent,
        lastAssistantSayingGenseq,
        lastFunctionCallGenseq,
        interrupted: true,
      };
    }

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
    return {
      lastAssistantSayingContent,
      lastAssistantSayingGenseq,
      lastFunctionCallGenseq,
      interrupted: true,
    };
  } finally {
    clearActiveRun(dlg.id);

    if (!finalRunState) {
      try {
        finalRunState = await computeIdleRunState(dlg);
      } catch (stateErr) {
        log.warn('driver-v2 failed to compute final run state; falling back to idle', stateErr, {
          dialogId: dlg.id.valueOf(),
        });
        finalRunState = { kind: 'idle_waiting_user' };
      }
    }

    try {
      const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
      if (
        dlg.id.selfId !== dlg.id.rootId &&
        latest &&
        latest.runState &&
        latest.runState.kind === 'dead'
      ) {
        finalRunState = latest.runState;
      }
    } catch (err) {
      log.warn('driver-v2 failed to re-check runState before finalizing', err, {
        dialogId: dlg.id.valueOf(),
      });
    }

    await setDialogRunState(dlg.id, finalRunState);
  }
}
