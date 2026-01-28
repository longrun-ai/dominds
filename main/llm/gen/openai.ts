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
import type { ChatMessage, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';

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
    case 'thinking_msg':
      return {
        type: 'message',
        role: 'assistant',
        content: msg.content,
      };
    case 'call_result_msg':
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

    const requestInput: ResponseInputItem[] = context.map(chatMessageToOpenAiInputItem);

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
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToOpenAiTool) }),
      tool_choice: 'auto',
    };

    let sayingStarted = false;
    let thinkingStarted = false;
    let sawOutputText = false;
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;

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
              if (sayingStarted) {
                await receiver.sayingFinish();
                sayingStarted = false;
              }
              if (thinkingStarted) {
                await receiver.thinkingFinish();
                thinkingStarted = false;
              }
              usage = parseOpenAiUsage(event.response.usage);
            }
            break;
          }

          case 'response.incomplete': {
            if (returnedModel === undefined) {
              returnedModel = tryExtractApiReturnedModel(event.response);
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            if (thinkingStarted) {
              await receiver.thinkingFinish();
              thinkingStarted = false;
            }
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
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(delta);
              sawOutputText = true;
            }
            break;
          }

          case 'response.output_text.done': {
            if (!sawOutputText && event.text.length > 0) {
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
              }
              await receiver.sayingChunk(event.text);
              sawOutputText = true;
            }
            if (sayingStarted) {
              await receiver.sayingFinish();
              sayingStarted = false;
            }
            break;
          }

          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            const delta = event.delta;
            if (delta.length > 0) {
              if (!thinkingStarted) {
                thinkingStarted = true;
                await receiver.thinkingStart();
              }
              await receiver.thinkingChunk(delta);
            }
            break;
          }

          case 'response.reasoning_summary_part.added': {
            if (!thinkingStarted) {
              thinkingStarted = true;
              await receiver.thinkingStart();
            }
            break;
          }

          case 'response.output_item.done': {
            const item = event.item;

            if (isRecord(item) && item.type === 'function_call') {
              const callId = typeof item.call_id === 'string' ? item.call_id : '';
              const name = typeof item.name === 'string' ? item.name : '';
              const args = typeof item.arguments === 'string' ? item.arguments : '';
              if (callId.length > 0 && name.length > 0) {
                await receiver.funcCall(callId, name, args);
              }
              break;
            }

            if (isRecord(item) && item.type === 'message' && !sawOutputText) {
              const text = extractOutputMessageText(item as unknown as ResponseOutputItem);
              if (text.length > 0) {
                if (!sayingStarted) {
                  sayingStarted = true;
                  await receiver.sayingStart();
                }
                await receiver.sayingChunk(text);
                await receiver.sayingFinish();
                sayingStarted = false;
                sawOutputText = true;
              }
              break;
            }

            break;
          }

          // Ignored events (kept explicit for future debugging)
          case 'response.output_item.added':
          case 'response.content_part.added':
          case 'response.content_part.done':
          case 'response.function_call_arguments.delta':
          case 'response.function_call_arguments.done':
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
      if (sayingStarted) {
        await receiver.sayingFinish();
      }
      if (thinkingStarted) {
        await receiver.thinkingFinish();
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

    const requestInput: ResponseInputItem[] = context.map(chatMessageToOpenAiInputItem);
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
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToOpenAiTool) }),
      tool_choice: 'auto',
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
