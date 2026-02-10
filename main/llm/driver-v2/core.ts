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
  formatDomindsNoteFbrToollessViolation,
  formatReminderItemGuide,
  formatUserFacingLanguageGuide,
} from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { ContextHealthSnapshot, LlmUsageStats } from '../../shared/types/context-health';
import type { DialogInterruptionReason, DialogRunState } from '../../shared/types/run-state';
import { Team } from '../../team';
import { TellaskStreamParser, type CollectedTellaskCall } from '../../tellask';
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
import { createSayingEventsReceiver, emitSayingEvents, emitThinkingEvents } from './saying-events';
import { executeTellaskCalls } from './tellask-bridge';
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
    grammar: 'markdown',
    userLanguageCode: upNext.userLanguageCode,
  };
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
        log.warn('driver-v2 failed to parse function arguments as JSON', {
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
      const projected = projectFuncToolsForProvider(providerCfg.apiType, canonicalFuncTools);
      const funcTools = projected.tools;

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
            log.info('driver-v2 skip diligence prompt after disable toggle', {
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
            );
          }

          if (persistMode !== 'internal' && promptGrammar === 'tellask') {
            throwIfAborted(abortSignal, dlg);
            const collectedUserCalls = await emitSayingEvents(dlg, promptContent);
            throwIfAborted(abortSignal, dlg);
            const userResult = await executeTellaskCalls({
              dlg,
              agent,
              collectedCalls: collectedUserCalls,
              callbacks,
            });

            if (dlg.hasUpNext()) {
              return { lastAssistantSayingContent, interrupted: false };
            }

            if (userResult.toolOutputs.length > 0) {
              await dlg.addChatMessages(...userResult.toolOutputs);
            }
            if (userResult.suspend) {
              suspendForHuman = true;
            }
          } else if (persistMode !== 'internal') {
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

        const dialogMsgsForContext: ChatMessage[] = dlg.msgs.filter((m) => {
          if (!m) return false;
          if (m.type === 'ui_only_markdown_msg') return false;
          return true;
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
          content: formatUserFacingLanguageGuide(workingLanguage, uiLanguage),
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
          const collectedAssistantCalls: CollectedTellaskCall[] = [];

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
                  await dlg.persistAgentMessage(msg.content, msg.genseq, 'saying_msg');
                  const calls = await emitSayingEvents(dlg, msg.content);
                  collectedAssistantCalls.push(...calls);
                }
                if (msg.type === 'thinking_msg') {
                  await emitThinkingEvents(dlg, msg.content);
                }
              }
            }
          }

          const policyViolation = resolveDriverV2PolicyViolationKind({
            policy,
            tellaskCalls: collectedAssistantCalls,
            functionCallCount: 0,
          });
          if (policyViolation === 'tellask') {
            const violationText = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
              kind: 'tellask',
            });
            const genseq = dlg.activeGenSeq ?? 0;
            await dlg.addChatMessages({
              type: 'saying_msg',
              role: 'assistant',
              genseq,
              content: violationText,
            });
            lastAssistantSayingContent = violationText;
            await dlg.persistAgentMessage(violationText, genseq, 'saying_msg');
            return { lastAssistantSayingContent, interrupted: false };
          }

          if (collectedAssistantCalls.length > 0) {
            throwIfAborted(abortSignal, dlg);
            const assistantResult = await executeTellaskCalls({
              dlg,
              agent,
              collectedCalls: collectedAssistantCalls,
              callbacks,
            });
            if (dlg.hasUpNext()) {
              return { lastAssistantSayingContent, interrupted: false };
            }
            if (assistantResult.toolOutputs.length > 0) {
              await dlg.addChatMessages(...assistantResult.toolOutputs);
            }
            if (assistantResult.suspend) {
              suspendForHuman = true;
            }
          }

          const funcCalls = nonStreamMsgs.filter(
            (m): m is FuncCallMsg => m.type === 'func_call_msg',
          );
          const toolPolicyViolation = resolveDriverV2PolicyViolationKind({
            policy,
            tellaskCalls: [],
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
            await dlg.persistAgentMessage(violationText, genseq, 'saying_msg');
            return { lastAssistantSayingContent, interrupted: false };
          }

          const funcResults = await executeFunctionCalls({
            dialog: dlg,
            agent,
            agentTools,
            funcCalls,
            abortSignal,
          });

          if (funcCalls.length > 0) {
            const paired: ChatMessage[] = [];
            for (let i = 0; i < funcCalls.length; i++) {
              paired.push(funcCalls[i]);
              paired.push(funcResults[i]);
            }
            await dlg.addChatMessages(...paired);
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
            funcCalls.length > 0 || (funcResults.length > 0 && funcCalls.length === 0);
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

        const parser = new TellaskStreamParser(createSayingEventsReceiver(dlg));

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
                  await parser.takeUpstreamChunk(chunk);
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
                  await parser.finalize();

                  const sayingMessage: SayingMsg = {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq: dlg.activeGenSeq,
                    content: currentSayingContent,
                  };
                  newMsgs.push(sayingMessage);
                  lastAssistantSayingContent = currentSayingContent;

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

        const collectedCalls = parser.getCollectedCalls();

        const policyViolation = resolveDriverV2PolicyViolationKind({
          policy,
          tellaskCalls: collectedCalls,
          functionCallCount: streamedFuncCalls.length,
        });
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
          await dlg.addChatMessages(...newMsgs);
          await dlg.persistAgentMessage(violationText, genseq, 'saying_msg');
          return { lastAssistantSayingContent, interrupted: false };
        }

        const assistantResult = await executeTellaskCalls({
          dlg,
          agent,
          collectedCalls,
          callbacks,
        });
        if (dlg.hasUpNext()) {
          return { lastAssistantSayingContent, interrupted: false };
        }

        if (assistantResult.toolOutputs.length > 0) {
          newMsgs.push(...assistantResult.toolOutputs);
        }
        if (assistantResult.suspend) {
          suspendForHuman = true;
        }

        const funcResults = await executeFunctionCalls({
          dialog: dlg,
          agent,
          agentTools,
          funcCalls: streamedFuncCalls,
          abortSignal,
        });

        if (streamedFuncCalls.length > 0) {
          for (let i = 0; i < streamedFuncCalls.length; i++) {
            newMsgs.push(streamedFuncCalls[i]);
            if (i < funcResults.length) {
              newMsgs.push(funcResults[i]);
            }
          }
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

        const shouldContinue = streamedFuncCalls.length > 0 || funcResults.length > 0;
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
    return { lastAssistantSayingContent, interrupted: false };
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
      return { lastAssistantSayingContent, interrupted: true };
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
    return { lastAssistantSayingContent, interrupted: true };
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
