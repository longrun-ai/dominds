/**
 * Module: llm/gen/openai
 *
 * OpenAI-compatible Responses API integration implementing streaming and batch generation.
 */

import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  Tool,
} from 'openai/resources/responses/responses';

import { createLogger } from '../../log';
import { getTextForLanguage } from '../../shared/i18n/text';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncCallMsg, FuncResultMsg, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';
import { bytesToDataUrl, isVisionImageMimeType, readDialogArtifactBytes } from './artifacts';

const log = createLogger('llm/openai');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryExtractApiReturnedModel(value: unknown): string | undefined {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(value)) return undefined;
  if (!('model' in value)) return undefined;
  const model = value.model;
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tryExtractResponseErrorMessage(value: unknown): string | null {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(value)) return null;
  if (!('error' in value)) return null;
  const error = value.error;
  if (!isRecord(error)) return null;
  if (!('message' in error)) return null;
  const message = error.message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
}

function funcToolToOpenAiTool(funcTool: FuncTool): Tool {
  // MCP schemas are passed through to providers. OpenAI Responses types expect a narrower schema
  // shape; runtime compatibility is handled by provider validation + the driver stop policy.
  const parameters = funcTool.parameters as unknown as FunctionTool['parameters'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  const tool: FunctionTool = {
    type: 'function',
    name: funcTool.name,
    description,
    parameters,
    strict: false,
  };
  return tool;
}

function chatMessageToOpenAiInputItem(msg: ChatMessage): ResponseInputItem {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
      return {
        type: 'message',
        role: 'user',
        content: msg.content,
      };
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'ui_only_markdown_msg':
    case 'thinking_msg':
      return {
        type: 'message',
        role: 'assistant',
        content: msg.content,
      };
    case 'tellask_result_msg':
      return {
        type: 'message',
        role: 'user',
        content: msg.content,
      };
    case 'func_call_msg':
      return {
        type: 'function_call',
        call_id: msg.id,
        name: msg.name,
        arguments: msg.arguments,
      };
    case 'func_result_msg':
      return {
        type: 'function_call_output',
        call_id: msg.id,
        output: msg.content,
      };
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

async function funcResultToOpenAiInputItem(msg: FuncResultMsg): Promise<ResponseInputItem> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return {
      type: 'function_call_output',
      call_id: msg.id,
      output: msg.content,
    };
  }

  const output: ResponseFunctionCallOutputItemList = [];
  for (const item of items) {
    if (item.type === 'input_text') {
      output.push({ type: 'input_text', text: item.text });
      continue;
    }

    if (item.type === 'input_image') {
      if (!isVisionImageMimeType(item.mimeType)) {
        output.push({
          type: 'input_text',
          text: `[image omitted: unsupported mimeType=${item.mimeType}]`,
        });
        continue;
      }

      const bytes = await readDialogArtifactBytes({
        rootId: item.artifact.rootId,
        selfId: item.artifact.selfId,
        status: item.artifact.status,
        relPath: item.artifact.relPath,
      });
      if (!bytes) {
        output.push({
          type: 'input_text',
          text: `[image missing: ${item.artifact.relPath}]`,
        });
        continue;
      }

      output.push({
        type: 'input_image',
        detail: 'auto',
        image_url: bytesToDataUrl({ mimeType: item.mimeType, bytes }),
      });
      continue;
    }

    const _exhaustive: never = item;
    output.push({ type: 'input_text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  if (output.length === 0) {
    return {
      type: 'function_call_output',
      call_id: msg.id,
      output: msg.content,
    };
  }

  return {
    type: 'function_call_output',
    call_id: msg.id,
    output,
  };
}

function normalizeToolCallPairs(context: ChatMessage[]): ChatMessage[] {
  // Providers differ in how strictly they validate tool call/result ordering. In particular,
  // OpenAI-compatible endpoints may reject `function_call_output` items unless they appear
  // immediately after their matching `function_call`.
  //
  // Dominds may produce call blocks followed by result blocks (due to parallel execution). This
  // normalizer interleaves obvious call/result runs so we can emit a valid input sequence.
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

function mergeAdjacentOpenAiMessages(input: ResponseInputItem[]): ResponseInputItem[] {
  // Some OpenAI-compatible proxies are stricter than OpenAI itself and may behave poorly with
  // long runs of same-role `message` items (Dominds persists thinking/saying as separate msgs).
  // Merge adjacent message items by role to improve compatibility and reduce token overhead.
  const merged: ResponseInputItem[] = [];

  for (const item of input) {
    if (
      !isRecord(item) ||
      item.type !== 'message' ||
      (item.role !== 'user' && item.role !== 'assistant') ||
      typeof item.content !== 'string'
    ) {
      merged.push(item);
      continue;
    }

    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (
      prev &&
      isRecord(prev) &&
      prev.type === 'message' &&
      prev.role === item.role &&
      typeof prev.content === 'string'
    ) {
      prev.content = `${prev.content}\n${item.content}`;
      continue;
    }

    merged.push(item);
  }

  return merged;
}

async function buildOpenAiRequestInput(context: ChatMessage[]): Promise<ResponseInputItem[]> {
  const normalized = normalizeToolCallPairs(context);
  const input: ResponseInputItem[] = [];

  let lastFuncCallId: string | null = null;
  for (const msg of normalized) {
    if (msg.type === 'func_call_msg') {
      input.push(chatMessageToOpenAiInputItem(msg));
      lastFuncCallId = msg.id;
      continue;
    }

    if (msg.type === 'func_result_msg') {
      // Many OpenAI-compatible providers require the tool result to directly follow the matching
      // tool call. If it doesn't, downgrade to a plain text message so the request remains valid.
      if (lastFuncCallId === msg.id) {
        input.push(await funcResultToOpenAiInputItem(msg));
      } else {
        input.push({
          type: 'message',
          role: 'user',
          content: `[orphaned_tool_output:${msg.name}:${msg.id}] ${msg.content}`,
        });
      }
      lastFuncCallId = null;
      continue;
    }

    input.push(chatMessageToOpenAiInputItem(msg));
    lastFuncCallId = null;
  }

  return mergeAdjacentOpenAiMessages(input);
}

function parseOpenAiUsage(usage: unknown): LlmUsageStats {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(usage)) return { kind: 'unavailable' };
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'available',
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: typeof totalTokens === 'number' ? totalTokens : inputTokens + outputTokens,
  };
}

export async function buildOpenAiRequestInputWrapper(
  context: ChatMessage[],
): Promise<ResponseInputItem[]> {
  return await buildOpenAiRequestInput(context);
}

function extractOutputMessageText(item: ResponseOutputItem): string {
  if (!isRecord(item) || item.type !== 'message') return '';
  const content = item.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue;
    if (part.type === 'output_text' && typeof part.text === 'string') {
      text += part.text;
    }
    if (part.type === 'refusal' && typeof part.refusal === 'string') {
      text += part.refusal;
    }
  }
  return text;
}

function extractReasoningText(item: ResponseOutputItem): string {
  if (!isRecord(item) || item.type !== 'reasoning') return '';
  let text = '';
  const summary = item.summary;
  if (Array.isArray(summary)) {
    for (const part of summary) {
      if (!isRecord(part) || part.type !== 'summary_text') continue;
      if (typeof part.text === 'string' && part.text.length > 0) {
        text += part.text;
      }
    }
  }
  const content = item.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'reasoning_text') continue;
      if (typeof part.text === 'string' && part.text.length > 0) {
        text += part.text;
      }
    }
  }
  return text;
}

function openAiResponseToChatMessages(response: Response, genseq: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const output = response.output;
  if (!Array.isArray(output)) return messages;

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;

    if (item.type === 'reasoning') {
      const content = extractReasoningText(item as unknown as ResponseOutputItem);
      if (content.length > 0) {
        messages.push({
          type: 'thinking_msg',
          role: 'assistant',
          genseq,
          content,
        });
      }
      continue;
    }

    if (item.type === 'message') {
      const content = extractOutputMessageText(item as unknown as ResponseOutputItem);
      if (content.length > 0) {
        messages.push({
          type: 'saying_msg',
          role: 'assistant',
          genseq,
          content,
        });
      }
      continue;
    }

    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      if (callId.length > 0 && name.length > 0) {
        messages.push({
          type: 'func_call_msg',
          role: 'assistant',
          genseq,
          id: callId,
          name,
          arguments: args,
        });
      }
      continue;
    }
  }

  return messages;
}

export class OpenAiGen implements LlmGenerator {
  get apiType(): string {
    return 'openai';
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
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const requestInput: ResponseInputItem[] = await buildOpenAiRequestInput(context);

    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;

    const payload: ResponseCreateParamsStreaming = {
      model: agent.model,
      input: requestInput,
      instructions: systemPrompt.trim().length > 0 ? systemPrompt : undefined,
      max_output_tokens: maxOutputTokens,
      parallel_tool_calls: parallelToolCalls,
      store: false,
      stream: true,
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(openAiParams.reasoning_effort !== undefined && {
        reasoning: { effort: openAiParams.reasoning_effort },
      }),
      ...(openAiParams.verbosity !== undefined && { text: { verbosity: openAiParams.verbosity } }),
      ...(funcTools.length > 0
        ? { tools: funcTools.map(funcToolToOpenAiTool), tool_choice: 'auto' as const }
        : { tool_choice: 'none' as const }),
    };

    let sayingStarted = false;
    let thinkingStarted = false;
    let sawOutputText = false;
    type ActiveStream = 'idle' | 'thinking' | 'saying';
    let activeStream: ActiveStream = 'idle';
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;

    type ActiveFuncCall = {
      itemId: string;
      callId: string;
      name: string;
      argsJson: string;
      emitted: boolean;
    };

    function applyArgsDelta(state: ActiveFuncCall, chunk: string): void {
      if (chunk.length === 0) return;
      if (state.argsJson.length === 0) {
        state.argsJson = chunk;
        return;
      }
      // Support both delta and cumulative streaming implementations.
      if (chunk.startsWith(state.argsJson)) {
        state.argsJson = chunk;
        return;
      }
      if (state.argsJson.startsWith(chunk)) {
        return;
      }
      state.argsJson += chunk;
    }

    async function maybeEmitFuncCall(
      state: ActiveFuncCall,
      receiver_: LlmStreamReceiver,
    ): Promise<void> {
      if (state.emitted) return;
      if (state.callId.trim().length === 0) return;
      if (state.name.trim().length === 0) return;
      const args = state.argsJson.trim().length > 0 ? state.argsJson : '{}';
      state.emitted = true;
      await receiver_.funcCall(state.callId, state.name, args);
    }

    const activeFuncCallsByItemId = new Map<string, ActiveFuncCall>();

    try {
      const stream: AsyncIterable<ResponseStreamEvent> = await client.responses.create(payload, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      for await (const event of stream) {
        if (abortSignal?.aborted) {
          throw new Error('AbortError');
        }

        switch (event.type) {
          case 'response.created':
          case 'response.in_progress':
          case 'response.queued':
          case 'response.completed': {
            if (returnedModel === undefined) {
              returnedModel = tryExtractApiReturnedModel(event.response);
            }
            if (event.type === 'response.completed') {
              if (thinkingStarted) {
                await receiver.thinkingFinish();
                thinkingStarted = false;
              }
              if (sayingStarted) {
                await receiver.sayingFinish();
                sayingStarted = false;
              }
              activeStream = 'idle';
              usage = parseOpenAiUsage(event.response.usage);
            }
            break;
          }

          case 'response.incomplete': {
            if (returnedModel === undefined) {
              returnedModel = tryExtractApiReturnedModel(event.response);
            }
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            activeStream = 'idle';
            usage = parseOpenAiUsage(event.response.usage);
            break;
          }

          case 'response.failed': {
            const message =
              tryExtractResponseErrorMessage(event.response) ?? 'OpenAI response failed.';
            throw new Error(message);
          }

          case 'error': {
            const message =
              typeof event.message === 'string' && event.message.trim().length > 0
                ? event.message.trim()
                : 'OpenAI response error.';
            throw new Error(message);
          }

          case 'response.output_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (activeStream === 'thinking') {
                const detail =
                  'OPENAI stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('openai_stream_overlap_violation'));
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
              await receiver.sayingChunk(delta);
              sawOutputText = true;
            }
            break;
          }

          case 'response.output_text.done': {
            if (!sawOutputText && event.text.length > 0) {
              if (activeStream === 'thinking') {
                const detail =
                  'OPENAI stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('openai_stream_overlap_violation'));
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
              await receiver.sayingChunk(event.text);
              sawOutputText = true;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
              if (activeStream === 'saying') activeStream = 'idle';
            }
            break;
          }

          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (activeStream === 'saying') {
                const detail =
                  'OPENAI stream overlap violation: received reasoning while saying stream still active';
                log.error(detail, new Error('openai_stream_overlap_violation'));
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
            break;
          }

          case 'response.reasoning_summary_part.added': {
            if (activeStream === 'saying') {
              const detail =
                'OPENAI stream overlap violation: received reasoning while saying stream still active';
              log.error(detail, new Error('openai_stream_overlap_violation'));
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
            break;
          }
          case 'response.reasoning_summary_text.done':
          case 'response.reasoning_text.done':
          case 'response.reasoning_summary_part.done': {
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
              if (activeStream === 'thinking') activeStream = 'idle';
            }
            break;
          }

          case 'response.output_item.done': {
            const item = event.item;

            if (isRecord(item) && item.type === 'function_call') {
              const itemId = typeof item.id === 'string' ? item.id : '';
              const callId = typeof item.call_id === 'string' ? item.call_id : '';
              const name = typeof item.name === 'string' ? item.name : '';
              const args = typeof item.arguments === 'string' ? item.arguments : '';

              if (itemId.length > 0) {
                const existing = activeFuncCallsByItemId.get(itemId);
                const state: ActiveFuncCall =
                  existing ??
                  ({
                    itemId,
                    callId: '',
                    name: '',
                    argsJson: '',
                    emitted: false,
                  } satisfies ActiveFuncCall);

                if (callId.length > 0) state.callId = callId;
                if (name.length > 0) state.name = name;
                if (args.length > 0) state.argsJson = args;

                activeFuncCallsByItemId.set(itemId, state);
                await maybeEmitFuncCall(state, receiver);
              } else if (callId.length > 0 && name.length > 0) {
                // Fallback: emit directly when item lacks an ID (should not happen on OpenAI).
                await receiver.funcCall(callId, name, args.length > 0 ? args : '{}');
              }
              break;
            }

            if (isRecord(item) && item.type === 'message' && !sawOutputText) {
              const text = extractOutputMessageText(item as unknown as ResponseOutputItem);
              if (text.length > 0) {
                if (activeStream === 'thinking') {
                  const detail =
                    'OPENAI stream overlap violation: received output_text while thinking stream still active';
                  log.error(detail, new Error('openai_stream_overlap_violation'));
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
              break;
            }

            break;
          }

          // Ignored events (kept explicit for future debugging)
          case 'response.output_item.added': {
            const item = event.item;
            if (isRecord(item) && item.type === 'function_call') {
              const itemId = typeof item.id === 'string' ? item.id : '';
              if (itemId.length > 0) {
                const existing = activeFuncCallsByItemId.get(itemId);
                const state: ActiveFuncCall =
                  existing ??
                  ({
                    itemId,
                    callId: '',
                    name: '',
                    argsJson: '',
                    emitted: false,
                  } satisfies ActiveFuncCall);

                const callId = typeof item.call_id === 'string' ? item.call_id : '';
                const name = typeof item.name === 'string' ? item.name : '';
                const args = typeof item.arguments === 'string' ? item.arguments : '';
                if (callId.length > 0) state.callId = callId;
                if (name.length > 0) state.name = name;
                if (args.length > 0) state.argsJson = args;
                activeFuncCallsByItemId.set(itemId, state);
              }
            }
            break;
          }
          case 'response.content_part.added':
          case 'response.content_part.done':
            break;
          case 'response.function_call_arguments.delta': {
            const itemId = event.item_id;
            const delta = event.delta;
            if (itemId.length > 0 && delta.length > 0) {
              const existing = activeFuncCallsByItemId.get(itemId);
              const state: ActiveFuncCall =
                existing ??
                ({
                  itemId,
                  callId: '',
                  name: '',
                  argsJson: '',
                  emitted: false,
                } satisfies ActiveFuncCall);
              applyArgsDelta(state, delta);
              activeFuncCallsByItemId.set(itemId, state);
            }
            break;
          }
          case 'response.function_call_arguments.done': {
            const itemId = event.item_id;
            const name = event.name;
            const args = event.arguments;
            if (itemId.length > 0) {
              const existing = activeFuncCallsByItemId.get(itemId);
              const state: ActiveFuncCall =
                existing ??
                ({
                  itemId,
                  callId: '',
                  name: '',
                  argsJson: '',
                  emitted: false,
                } satisfies ActiveFuncCall);
              if (name.length > 0) state.name = name;
              if (args.length > 0) state.argsJson = args;
              activeFuncCallsByItemId.set(itemId, state);
              await maybeEmitFuncCall(state, receiver);
            }
            break;
          }
          case 'response.refusal.delta':
          case 'response.refusal.done':
          case 'response.output_text.annotation.added':
          case 'response.reasoning_summary_text.done':
          case 'response.reasoning_text.done':
          case 'response.reasoning_summary_part.done':
            break;

          default: {
            const unknownEvent: unknown = event;
            const eventType =
              isRecord(unknownEvent) && typeof unknownEvent.type === 'string'
                ? unknownEvent.type
                : 'unknown';
            log.warn('OPENAI unexpected llm event', new Error('Unknown event type'), {
              eventType,
            });
            break;
          }
        }
      }
    } catch (error: unknown) {
      log.warn('OPENAI streaming error', error);
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
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmBatchResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const requestInput: ResponseInputItem[] = await buildOpenAiRequestInput(context);
    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;

    const payload: ResponseCreateParamsNonStreaming = {
      model: agent.model,
      input: requestInput,
      instructions: systemPrompt.trim().length > 0 ? systemPrompt : undefined,
      max_output_tokens: maxOutputTokens,
      parallel_tool_calls: parallelToolCalls,
      store: false,
      stream: false,
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(openAiParams.reasoning_effort !== undefined && {
        reasoning: { effort: openAiParams.reasoning_effort },
      }),
      ...(openAiParams.verbosity !== undefined && { text: { verbosity: openAiParams.verbosity } }),
      ...(funcTools.length > 0
        ? { tools: funcTools.map(funcToolToOpenAiTool), tool_choice: 'auto' as const }
        : { tool_choice: 'none' as const }),
    };

    const response = await client.responses.create(payload, {
      ...(abortSignal ? { signal: abortSignal } : {}),
    });

    if (!response) {
      throw new Error('No response from OpenAI API');
    }

    const returnedModel = typeof response.model === 'string' ? response.model : undefined;
    const usage = parseOpenAiUsage(response.usage);

    return {
      messages: openAiResponseToChatMessages(response, genseq),
      usage,
      llmGenModel: returnedModel,
    };
  }
}
