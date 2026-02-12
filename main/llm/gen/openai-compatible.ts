/**
 * Module: llm/gen/openai-compatible
 *
 * OpenAI Chat Completions compatible integration implementing streaming and batch generation.
 *
 * Rationale:
 * - Many "OpenAI-compatible" providers implement the Chat Completions API but not the newer
 *   Responses API. Dominds' `apiType: openai` uses the Responses API; this generator targets
 *   chat-completions-only providers (e.g. Volcano Engine Ark `.../api/v3`).
 */

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { FunctionDefinition } from 'openai/resources/shared';

import { createLogger } from '../../log';
import { getTextForLanguage } from '../../shared/i18n/text';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { LlmUsageStats } from '../../shared/types/context-health';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncCallMsg, FuncResultMsg, ProviderConfig } from '../client';
import type { LlmBatchResult, LlmGenerator, LlmStreamReceiver, LlmStreamResult } from '../gen';
import { bytesToDataUrl, isVisionImageMimeType, readDialogArtifactBytes } from './artifacts';

const log = createLogger('llm/openai-compatible');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryExtractChatUsage(usage: unknown): LlmUsageStats {
  // NOTE: External API payload; a runtime check is unavoidable.
  if (!isRecord(usage)) return { kind: 'unavailable' };
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return { kind: 'unavailable' };
  return {
    kind: 'available',
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === 'number' ? total : prompt + completion,
  };
}

function funcToolToChatCompletionTool(funcTool: FuncTool): ChatCompletionTool {
  // MCP schemas are passed through to providers. Chat Completions expects a narrower JSON schema
  // shape; runtime compatibility is handled by provider validation + the driver stop policy.
  const parameters = funcTool.parameters as unknown as FunctionDefinition['parameters'];
  const description = getTextForLanguage(
    { i18n: funcTool.descriptionI18n, fallback: funcTool.description },
    getWorkLanguage(),
  );
  return {
    type: 'function',
    function: {
      name: funcTool.name,
      description,
      parameters,
      strict: false,
    },
  };
}

function chatMessageToChatCompletionMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.type) {
    case 'environment_msg':
    case 'prompting_msg':
    case 'tellask_result_msg':
      return { role: 'user', content: msg.content };
    case 'transient_guide_msg':
    case 'saying_msg':
    case 'ui_only_markdown_msg':
    case 'thinking_msg':
      return { role: 'assistant', content: msg.content };
    case 'func_call_msg':
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: msg.id,
            type: 'function',
            function: { name: msg.name, arguments: msg.arguments },
          },
        ],
      };
    case 'func_result_msg':
      return { role: 'tool', tool_call_id: msg.id, content: msg.content };
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

async function funcResultToChatCompletionMessages(
  msg: FuncResultMsg,
): Promise<ChatCompletionMessageParam[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return [{ role: 'tool', tool_call_id: msg.id, content: msg.content }];
  }

  const out: ChatCompletionMessageParam[] = [];
  out.push({ role: 'tool', tool_call_id: msg.id, content: msg.content });

  const parts: ChatCompletionContentPart[] = [];
  let sawImageUrl = false;
  let sawAnyImage = false;

  parts.push({
    type: 'text',
    text: `Tool output images (${msg.name}, call_id=${msg.id}):`,
  });

  for (const item of items) {
    if (item.type === 'input_text') continue;

    if (item.type === 'input_image') {
      sawAnyImage = true;
      if (!isVisionImageMimeType(item.mimeType)) {
        parts.push({
          type: 'text',
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
        parts.push({
          type: 'text',
          text: `[image missing: ${item.artifact.relPath}]`,
        });
        continue;
      }

      parts.push({
        type: 'image_url',
        image_url: {
          url: bytesToDataUrl({ mimeType: item.mimeType, bytes }),
          detail: 'auto',
        },
      });
      sawImageUrl = true;
      continue;
    }

    const _exhaustive: never = item;
    parts.push({ type: 'text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  if (sawAnyImage) {
    if (sawImageUrl) {
      out.push({ role: 'user', content: parts });
    } else {
      const text = parts
        .filter((p): p is Extract<ChatCompletionContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text.length > 0) {
        out.push({ role: 'user', content: text });
      }
    }
  }

  return out;
}

async function orphanedFuncResultToChatCompletionMessages(
  msg: FuncResultMsg,
): Promise<ChatCompletionMessageParam[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return [
      {
        role: 'user',
        content: `[orphaned_tool_output:${msg.name}:${msg.id}] ${msg.content}`,
      },
    ];
  }

  const parts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: `[orphaned_tool_output:${msg.name}:${msg.id}] ${msg.content}`,
    },
  ];
  let sawImageUrl = false;
  let sawAnyImage = false;

  for (const item of items) {
    if (item.type === 'input_text') continue;

    if (item.type === 'input_image') {
      sawAnyImage = true;
      if (!isVisionImageMimeType(item.mimeType)) {
        parts.push({
          type: 'text',
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
        parts.push({
          type: 'text',
          text: `[image missing: ${item.artifact.relPath}]`,
        });
        continue;
      }

      parts.push({
        type: 'image_url',
        image_url: { url: bytesToDataUrl({ mimeType: item.mimeType, bytes }), detail: 'auto' },
      });
      sawImageUrl = true;
      continue;
    }

    const _exhaustive: never = item;
    parts.push({ type: 'text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  if (sawImageUrl) {
    return [{ role: 'user', content: parts }];
  }
  if (sawAnyImage) {
    const text = parts
      .filter((p): p is Extract<ChatCompletionContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    return [{ role: 'user', content: text }];
  }

  return [{ role: 'user', content: msg.content }];
}

function normalizeToolCallPairs(context: ChatMessage[]): ChatMessage[] {
  // Providers differ in how strictly they validate tool call/result ordering. Many
  // ChatCompletions-compatible endpoints reject tool results unless they appear immediately
  // after their matching tool_calls.
  //
  // Dominds may produce call blocks followed by result blocks (due to parallel execution). This
  // normalizer interleaves obvious call/result runs so we can emit a valid message sequence.
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
      if (existing) existing.push(result);
      else resultsById.set(result.id, [result]);
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
      if (!used.has(result)) out.push(result);
    }
  }

  return out;
}

function mergeAdjacentMessages(input: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  // Some proxies behave poorly with long runs of same-role messages (Dominds persists thinking/saying
  // as separate msgs). Merge adjacent user/assistant/system messages where safe.
  const merged: ChatCompletionMessageParam[] = [];

  for (const item of input) {
    if (!isRecord(item)) {
      merged.push(item);
      continue;
    }

    const role = item.role;
    const content = item.content;
    const hasToolCalls = 'tool_calls' in item && Array.isArray(item.tool_calls);
    if (
      (role !== 'user' && role !== 'assistant' && role !== 'system') ||
      typeof content !== 'string' ||
      hasToolCalls
    ) {
      merged.push(item);
      continue;
    }

    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (
      prev &&
      isRecord(prev) &&
      prev.role === role &&
      typeof prev.content === 'string' &&
      !('tool_calls' in prev && Array.isArray(prev.tool_calls))
    ) {
      prev.content = `${prev.content}\n${content}`;
      continue;
    }

    merged.push(item);
  }

  return merged;
}

async function buildChatCompletionMessages(
  systemPrompt: string,
  context: ChatMessage[],
): Promise<ChatCompletionMessageParam[]> {
  const normalized = normalizeToolCallPairs(context);
  const input: ChatCompletionMessageParam[] = [];

  if (systemPrompt.trim().length > 0) {
    input.push({ role: 'system', content: systemPrompt.trim() });
  }

  let lastFuncCallId: string | null = null;
  for (const msg of normalized) {
    if (msg.type === 'func_call_msg') {
      input.push(chatMessageToChatCompletionMessage(msg));
      lastFuncCallId = msg.id;
      continue;
    }

    if (msg.type === 'func_result_msg') {
      // Many OpenAI-compatible providers require the tool result to directly follow the matching
      // tool call. If it doesn't, downgrade to a plain text message so the request remains valid.
      if (lastFuncCallId === msg.id) {
        input.push(...(await funcResultToChatCompletionMessages(msg)));
      } else {
        input.push(...(await orphanedFuncResultToChatCompletionMessages(msg)));
      }
      lastFuncCallId = null;
      continue;
    }

    input.push(chatMessageToChatCompletionMessage(msg));
    lastFuncCallId = null;
  }

  return mergeAdjacentMessages(input);
}

export async function buildOpenAiCompatibleRequestMessagesWrapper(
  systemPrompt: string,
  context: ChatMessage[],
): Promise<ChatCompletionMessageParam[]> {
  return await buildChatCompletionMessages(systemPrompt, context);
}

function applyArgsDelta(state: { argsJson: string }, chunk: string): void {
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

type ActiveFuncCall = {
  index: number;
  callId: string;
  name: string;
  argsJson: string;
  emitted: boolean;
};

function synthesizeCallId(genseq: number, index: number): string {
  // Some OpenAI-compatible proxies omit `id` in tool call deltas. Dominds requires a stable call id
  // for correlating tool outputs across turns; synthesize one that is stable for this generation.
  return `toolcall_${genseq}_${index}`;
}

async function maybeEmitFuncCall(
  state: ActiveFuncCall,
  receiver: LlmStreamReceiver,
  genseq: number,
): Promise<void> {
  if (state.emitted) return;
  if (state.callId.trim().length === 0) {
    state.callId = synthesizeCallId(genseq, state.index);
  }
  if (state.name.trim().length === 0) return;
  const args = state.argsJson.trim().length > 0 ? state.argsJson : '{}';
  state.emitted = true;
  await receiver.funcCall(state.callId, state.name, args);
}

function chatCompletionToChatMessages(response: ChatCompletion, genseq: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  const choice = response.choices && response.choices.length > 0 ? response.choices[0] : undefined;
  const msg = choice ? choice.message : undefined;
  if (!msg) return out;

  const content = typeof msg.content === 'string' ? msg.content : null;
  if (content && content.length > 0) {
    out.push({ type: 'saying_msg', role: 'assistant', genseq, content });
  }

  const toolCalls = msg.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || call.type !== 'function') continue;
      const callId = typeof call.id === 'string' ? call.id : '';
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
      if (callId.trim().length > 0 && name.trim().length > 0) {
        out.push({
          type: 'func_call_msg',
          role: 'assistant',
          genseq,
          id: callId,
          name,
          arguments: args,
        });
      }
    }
  }

  return out;
}

export class OpenAiCompatibleGen implements LlmGenerator {
  get apiType(): string {
    return 'openai-compatible';
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const messages = await buildChatCompletionMessages(systemPrompt, context);

    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;

    const payload: ChatCompletionCreateParamsStreaming = {
      model: agent.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(openAiParams.stop !== undefined && { stop: openAiParams.stop }),
      ...(openAiParams.presence_penalty !== undefined && {
        presence_penalty: openAiParams.presence_penalty,
      }),
      ...(openAiParams.frequency_penalty !== undefined && {
        frequency_penalty: openAiParams.frequency_penalty,
      }),
      ...(openAiParams.seed !== undefined && { seed: openAiParams.seed }),
      ...(openAiParams.logprobs !== undefined && { logprobs: openAiParams.logprobs }),
      ...(openAiParams.top_logprobs !== undefined && { top_logprobs: openAiParams.top_logprobs }),
      ...(openAiParams.logit_bias !== undefined && { logit_bias: openAiParams.logit_bias }),
      ...(openAiParams.user !== undefined && { user: openAiParams.user }),
      ...(funcTools.length > 0
        ? { tools: funcTools.map(funcToolToChatCompletionTool), tool_choice: 'auto' as const }
        : { tool_choice: 'none' as const }),
      parallel_tool_calls: parallelToolCalls,
      max_tokens: maxOutputTokens,
    };

    let sayingStarted = false;
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;

    const activeCallsByIndex = new Map<number, ActiveFuncCall>();

    try {
      const stream: AsyncIterable<ChatCompletionChunk> = await client.chat.completions.create(
        payload,
        {
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );

      for await (const chunk of stream) {
        if (abortSignal?.aborted) throw new Error('AbortError');

        if (
          returnedModel === undefined &&
          typeof chunk.model === 'string' &&
          chunk.model.length > 0
        ) {
          returnedModel = chunk.model;
        }

        if (chunk.usage) {
          usage = tryExtractChatUsage(chunk.usage);
        }

        const choice = chunk.choices && chunk.choices.length > 0 ? chunk.choices[0] : undefined;
        if (!choice) continue;

        const delta = choice.delta;
        const content = delta.content;
        if (typeof content === 'string' && content.length > 0) {
          if (!sayingStarted) {
            sayingStarted = true;
            await receiver.sayingStart();
          }
          await receiver.sayingChunk(content);
        }

        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const index = call.index;
            const existing = activeCallsByIndex.get(index);
            const state: ActiveFuncCall =
              existing ??
              ({
                index,
                callId: '',
                name: '',
                argsJson: '',
                emitted: false,
              } satisfies ActiveFuncCall);

            if (typeof call.id === 'string' && call.id.length > 0) state.callId = call.id;
            if (call.function) {
              if (typeof call.function.name === 'string' && call.function.name.length > 0) {
                state.name = call.function.name;
              }
              if (
                typeof call.function.arguments === 'string' &&
                call.function.arguments.length > 0
              ) {
                applyArgsDelta(state, call.function.arguments);
              }
            }

            activeCallsByIndex.set(index, state);
          }
        }

        if (choice.finish_reason === 'tool_calls') {
          for (const state of activeCallsByIndex.values()) {
            await maybeEmitFuncCall(state, receiver, genseq);
          }
        }
      }

      // Best-effort: if the provider never sets finish_reason='tool_calls' but streamed tool deltas,
      // emit any collected calls at stream end.
      for (const state of activeCallsByIndex.values()) {
        await maybeEmitFuncCall(state, receiver, genseq);
      }
    } catch (error: unknown) {
      log.warn('OPENAI-COMPATIBLE streaming error', error);
      throw error;
    } finally {
      if (sayingStarted) await receiver.sayingFinish();
    }

    return { usage, ...(returnedModel ? { llmGenModel: returnedModel } : {}) };
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
    const messages = await buildChatCompletionMessages(systemPrompt, context);

    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;

    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;

    const payload: ChatCompletionCreateParamsNonStreaming = {
      model: agent.model,
      messages,
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(openAiParams.stop !== undefined && { stop: openAiParams.stop }),
      ...(openAiParams.presence_penalty !== undefined && {
        presence_penalty: openAiParams.presence_penalty,
      }),
      ...(openAiParams.frequency_penalty !== undefined && {
        frequency_penalty: openAiParams.frequency_penalty,
      }),
      ...(openAiParams.seed !== undefined && { seed: openAiParams.seed }),
      ...(openAiParams.logprobs !== undefined && { logprobs: openAiParams.logprobs }),
      ...(openAiParams.top_logprobs !== undefined && { top_logprobs: openAiParams.top_logprobs }),
      ...(openAiParams.logit_bias !== undefined && { logit_bias: openAiParams.logit_bias }),
      ...(openAiParams.user !== undefined && { user: openAiParams.user }),
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToChatCompletionTool) }),
      tool_choice: 'auto',
      parallel_tool_calls: parallelToolCalls,
      max_tokens: maxOutputTokens,
    };

    try {
      const response = await client.chat.completions.create(payload, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      const messagesOut = chatCompletionToChatMessages(response, genseq);
      const usage: LlmUsageStats = response.usage
        ? tryExtractChatUsage(response.usage)
        : ({ kind: 'unavailable' } satisfies LlmUsageStats);
      const model =
        typeof response.model === 'string' && response.model.length > 0
          ? response.model
          : undefined;
      return {
        messages: messagesOut,
        usage,
        ...(model ? { llmGenModel: model } : {}),
      };
    } catch (error: unknown) {
      log.warn('OPENAI-COMPATIBLE batch error', error);
      throw error;
    }
  }
}
