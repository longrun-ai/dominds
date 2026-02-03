/**
 * Module: llm/gen/codex
 *
 * ChatGPT Codex responses integration (streaming-only).
 */
import type {
  ChatGptEventReceiver,
  ChatGptFunctionTool,
  ChatGptMessageItem,
  ChatGptMessageRole,
  ChatGptReasoning,
  ChatGptResponseItem,
  ChatGptResponsesRequest,
  ChatGptResponsesStreamEvent,
  ChatGptTextControls,
} from '@longrun-ai/codex-auth';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../shared/i18n/text';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncCallMsg, FuncResultMsg, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';

const log = createLogger('llm/codex');
const codexFallbackInstructions = 'You are Codex CLI.';

type CodexPromptLoader = (model: string) => Promise<string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryExtractApiReturnedModel(value: unknown): string | undefined {
  // NOTE: This payload is derived from an external API / transport layer.
  // Some upstream variants include `model`, but the exported TS types may not.
  // A runtime check is unavoidable here.
  if (!isRecord(value)) return undefined;
  if (!('model' in value)) return undefined;
  const model = value.model;
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveCodexInstructions(
  model: string,
  systemPrompt: string,
  loadPrompt: CodexPromptLoader,
): Promise<{ instructions: string; assistantPrelude: string | null }> {
  const basePrompt = await loadPrompt(model);
  const trimmedSystemPrompt = systemPrompt.trim();
  if (!basePrompt) {
    return {
      instructions: trimmedSystemPrompt.length > 0 ? systemPrompt : codexFallbackInstructions,
      assistantPrelude: null,
    };
  }
  return {
    instructions: basePrompt,
    assistantPrelude: trimmedSystemPrompt.length > 0 ? trimmedSystemPrompt : null,
  };
}

function funcToolToCodex(funcTool: FuncTool): ChatGptFunctionTool {
  // MCP schemas are passed through to providers. Codex tool schema types are narrower; runtime
  // validation is handled by provider rejection + the driver stop policy.
  const parameters = funcTool.parameters as unknown as ChatGptFunctionTool['parameters'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    type: 'function',
    name: funcTool.name,
    description,
    strict: false,
    parameters,
  };
}

function messageItem(role: ChatGptMessageRole, text: string): ChatGptMessageItem {
  const contentType = role === 'assistant' ? 'output_text' : 'input_text';
  return {
    type: 'message',
    role,
    content: [
      {
        type: contentType,
        text,
      },
    ],
  };
}

function chatMessageToCodexItems(msg: ChatMessage): ChatGptResponseItem[] {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
      return [messageItem('user', msg.content)];
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'thinking_msg':
      return [messageItem('assistant', msg.content)];
    case 'tellask_result_msg':
      return [messageItem('user', msg.content)];
    case 'func_call_msg':
      return [
        {
          type: 'function_call',
          name: msg.name,
          arguments: msg.arguments,
          call_id: msg.id,
        },
      ];
    case 'func_result_msg':
      return [
        {
          type: 'function_call_output',
          call_id: msg.id,
          output: msg.content,
        },
      ];
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unsupported chat message: ${_exhaustive}`);
    }
  }
}

function normalizeToolCallPairs(context: ChatMessage[]): ChatMessage[] {
  // Codex/OpenAI-compatible backends may reject `function_call_output` items unless they appear
  // immediately after their matching `function_call`. Dominds can temporarily produce a call block
  // followed by a result block when tools run in parallel, so we interleave obvious runs here.
  const out: ChatMessage[] = [];

  let i = 0;
  while (i < context.length) {
    const msg = context[i];
    if (msg.type !== 'func_call_msg') {
      out.push(msg);
      i++;
      continue;
    }

    const calls: FuncCallMsg[] = [];
    while (i < context.length && context[i].type === 'func_call_msg') {
      calls.push(context[i] as FuncCallMsg);
      i++;
    }

    const results: FuncResultMsg[] = [];
    while (i < context.length && context[i].type === 'func_result_msg') {
      results.push(context[i] as FuncResultMsg);
      i++;
    }

    if (results.length === 0) {
      out.push(...calls);
      continue;
    }

    const resultsById = new Map<string, FuncResultMsg[]>();
    for (const result of results) {
      const existing = resultsById.get(result.id);
      if (existing) {
        existing.push(result);
      } else {
        resultsById.set(result.id, [result]);
      }
    }

    const used = new Set<FuncResultMsg>();
    for (const call of calls) {
      out.push(call);
      const queue = resultsById.get(call.id);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (next) {
          out.push(next);
          used.add(next);
        }
      }
    }

    for (const result of results) {
      if (!used.has(result)) {
        out.push(result);
      }
    }
  }

  return out;
}

function buildCodexInput(context: ChatMessage[]): ChatGptResponseItem[] {
  const normalized = normalizeToolCallPairs(context);
  const input: ChatGptResponseItem[] = [];

  let lastFuncCallId: string | null = null;
  for (const msg of normalized) {
    if (msg.type === 'func_call_msg') {
      input.push({
        type: 'function_call',
        name: msg.name,
        arguments: msg.arguments,
        call_id: msg.id,
      });
      lastFuncCallId = msg.id;
      continue;
    }

    if (msg.type === 'func_result_msg') {
      if (lastFuncCallId === msg.id) {
        input.push({
          type: 'function_call_output',
          call_id: msg.id,
          output: msg.content,
        });
      } else {
        input.push(
          messageItem('user', `[orphaned_tool_output:${msg.name}:${msg.id}] ${msg.content}`),
        );
      }
      lastFuncCallId = null;
      continue;
    }

    const items = chatMessageToCodexItems(msg);
    for (const item of items) {
      input.push(item);
    }
    lastFuncCallId = null;
  }

  return input;
}

function buildCodexRequest(
  agent: Team.Member,
  instructions: string,
  assistantPrelude: string | null,
  funcTools: FuncTool[],
  context: ChatMessage[],
): ChatGptResponsesRequest {
  if (!agent.model) {
    throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
  }

  const input: ChatGptResponseItem[] = [];
  if (assistantPrelude) {
    // Codex backend rejects system messages; pass extra instructions as prior assistant context.
    input.push(messageItem('assistant', assistantPrelude));
  }
  input.push(...buildCodexInput(context));

  const codexParams = agent.model_params?.codex ?? agent.model_params?.openai;
  let reasoning: ChatGptReasoning | null = null;
  let text: ChatGptTextControls | undefined;
  const parallelToolCalls = codexParams?.parallel_tool_calls ?? true;
  let include: ChatGptResponsesRequest['include'] = [];

  if (codexParams && codexParams.reasoning_effort) {
    reasoning = {
      effort: codexParams.reasoning_effort,
      summary: 'auto',
    };
    include = ['reasoning.encrypted_content'];
  }
  if (codexParams && codexParams.verbosity) {
    text = {
      verbosity: codexParams.verbosity,
    };
  }

  return {
    model: agent.model,
    instructions,
    input,
    tools: funcTools.map(funcToolToCodex),
    tool_choice: 'auto',
    parallel_tool_calls: parallelToolCalls,
    reasoning,
    store: false,
    stream: true,
    include,
    text,
  };
}

export class CodexGen implements LlmGenerator {
  get apiType(): string {
    return 'codex';
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    _genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const codexHomeValue: string = process.env[providerConfig.apiKeyEnvVar] || '~/.codex';
    const codexHome = codexHomeValue.startsWith('~')
      ? process.env['HOME'] + codexHomeValue.substring(1)
      : codexHomeValue;
    // NOTE: `@longrun-ai/codex-auth` is an ESM package (`"type": "module"`). The Dominds backend is
    // compiled as CommonJS, so Node.js requires a dynamic `import()` for runtime access here.
    const codexAuth: typeof import('@longrun-ai/codex-auth') =
      await import('@longrun-ai/codex-auth');
    const manager = new codexAuth.AuthManager({ codexHome });
    const client = await codexAuth.createChatGptClientFromManager(manager, {
      baseUrl: providerConfig.baseUrl,
    });

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }
    const resolvedInstructions = await resolveCodexInstructions(
      agent.model,
      systemPrompt,
      codexAuth.loadCodexPrompt,
    );
    const payload = buildCodexRequest(
      agent,
      resolvedInstructions.instructions,
      resolvedInstructions.assistantPrelude,
      funcTools,
      context,
    );

    let sayingStarted = false;
    let thinkingStarted = false;
    let sawOutputText = false;
    type ActiveStream = 'idle' | 'thinking' | 'saying';
    let activeStream: ActiveStream = 'idle';
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;

    const eventReceiver: ChatGptEventReceiver = {
      onEvent: async (event: ChatGptResponsesStreamEvent) => {
        switch (event.type) {
          case 'response.created':
          case 'response.in_progress':
            if (returnedModel === undefined) {
              returnedModel = tryExtractApiReturnedModel(event.response);
            }
            return;
          case 'response.failed': {
            const error = event.response.error;
            const message =
              error && typeof error.message === 'string' && error.message.length > 0
                ? error.message
                : 'Codex response failed.';
            throw new Error(message);
          }
          case 'response.output_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (activeStream === 'thinking') {
                log.error(
                  'CODEX stream overlap violation: received output_text while thinking stream still active',
                  new Error('codex_stream_overlap_violation'),
                );
                if (thinkingStarted) {
                  await receiver.thinkingFinish();
                  thinkingStarted = false;
                }
                activeStream = 'idle';
              }
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
                activeStream = 'saying';
              }
              await receiver.sayingChunk(delta);
              sawOutputText = true;
            }
            return;
          }
          case 'response.output_text.done': {
            if (!sawOutputText && event.text.length > 0) {
              if (activeStream === 'thinking') {
                log.error(
                  'CODEX stream overlap violation: received output_text while thinking stream still active',
                  new Error('codex_stream_overlap_violation'),
                );
                if (thinkingStarted) {
                  await receiver.thinkingFinish();
                  thinkingStarted = false;
                }
                activeStream = 'idle';
              }
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
                activeStream = 'saying';
              }
              await receiver.sayingChunk(event.text);
              sawOutputText = true;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
              if (activeStream === 'saying') activeStream = 'idle';
            }
            return;
          }
          case 'response.content_part.added':
          case 'response.content_part.done':
            return;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (activeStream === 'saying') {
                const detail =
                  'CODEX stream overlap violation: received reasoning while saying stream still active';
                log.error(detail, new Error('codex_stream_overlap_violation'));
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
                if (sayingStarted) {
                  await receiver.sayingFinish();
                  sayingStarted = false;
                }
                activeStream = 'idle';
              }
              if (!thinkingStarted) {
                thinkingStarted = true;
                await receiver.thinkingStart();
                activeStream = 'thinking';
              }
              await receiver.thinkingChunk(delta);
            }
            return;
          }
          case 'response.reasoning_summary_part.added': {
            if (activeStream === 'saying') {
              const detail =
                'CODEX stream overlap violation: received reasoning while saying stream still active';
              log.error(detail, new Error('codex_stream_overlap_violation'));
              if (receiver.streamError) {
                await receiver.streamError(detail);
              }
              if (sayingStarted) {
                await receiver.sayingFinish();
                sayingStarted = false;
              }
              activeStream = 'idle';
            }
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
              activeStream = 'thinking';
            }
            return;
          }
          case 'response.reasoning_summary_text.done':
          case 'response.reasoning_text.done':
          case 'response.reasoning_summary_part.done': {
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
              if (activeStream === 'thinking') activeStream = 'idle';
            }
            return;
          }
          case 'response.output_item.added':
            return;
          case 'response.output_item.done': {
            switch (event.item.type) {
              case 'function_call':
                await receiver.funcCall(event.item.call_id, event.item.name, event.item.arguments);
                return;
              case 'message': {
                if (!sawOutputText) {
                  let text = '';
                  for (const part of event.item.content) {
                    switch (part.type) {
                      case 'output_text':
                        text += part.text;
                        break;
                      case 'input_text':
                      case 'input_image':
                        break;
                      default: {
                        const _exhaustive: never = part;
                        return _exhaustive;
                      }
                    }
                  }
                  if (text.length > 0) {
                    if (activeStream === 'thinking') {
                      const detail =
                        'CODEX stream overlap violation: received output_text while thinking stream still active';
                      log.error(detail, new Error('codex_stream_overlap_violation'));
                      if (receiver.streamError) {
                        await receiver.streamError(detail);
                      }
                      if (thinkingStarted) {
                        await receiver.thinkingFinish();
                        thinkingStarted = false;
                      }
                      activeStream = 'idle';
                    }
                    if (!sayingStarted) {
                      sayingStarted = true;
                      await receiver.sayingStart();
                      activeStream = 'saying';
                    }
                    await receiver.sayingChunk(text);
                    await receiver.sayingFinish();
                    sayingStarted = false;
                    if (activeStream === 'saying') activeStream = 'idle';
                    sawOutputText = true;
                  }
                }
                return;
              }
              case 'reasoning':
              case 'local_shell_call':
              case 'function_call_output':
              case 'custom_tool_call':
              case 'custom_tool_call_output':
              case 'web_search_call':
              case 'ghost_snapshot':
              case 'compaction':
              case 'compaction_summary':
                return;
              default: {
                const _exhaustive: never = event.item;
                return _exhaustive;
              }
            }
          }
          case 'response.completed': {
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            activeStream = 'idle';
            if (returnedModel === undefined) {
              returnedModel = tryExtractApiReturnedModel(event.response);
            }
            const responseUsage = event.response.usage;
            if (
              responseUsage &&
              typeof responseUsage.input_tokens === 'number' &&
              typeof responseUsage.output_tokens === 'number'
            ) {
              usage = {
                kind: 'available',
                promptTokens: responseUsage.input_tokens,
                completionTokens: responseUsage.output_tokens,
                totalTokens:
                  typeof responseUsage.total_tokens === 'number'
                    ? responseUsage.total_tokens
                    : responseUsage.input_tokens + responseUsage.output_tokens,
              };
            }
            return;
          }
          default: {
            const _exhaustive: never = event;
            return _exhaustive;
          }
        }
      },
    };

    try {
      await client.trigger(payload, eventReceiver, abortSignal ? { signal: abortSignal } : {});
    } catch (error: unknown) {
      log.warn('CODEX streaming error', error);
      throw error;
    } finally {
      if (thinkingStarted) {
        await receiver.thinkingFinish();
      }
      if (sayingStarted) {
        await receiver.sayingFinish();
      }
    }

    return { usage, llmGenModel: returnedModel };
  }

  async genMoreMessages(
    _providerConfig: ProviderConfig,
    _agent: Team.Member,
    _systemPrompt: string,
    _funcTools: FuncTool[],
    _context: ChatMessage[],
    _genseq: number,
  ): Promise<LlmBatchResult> {
    throw new Error('Codex generator only supports streaming mode.');
  }
}
