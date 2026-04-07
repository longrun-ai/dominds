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
  ResponseReasoningItem,
  ResponseStreamEvent,
  Tool,
} from 'openai/resources/responses/responses';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncResultMsg, ProviderConfig } from '../client';
import type {
  LlmBatchResult,
  LlmFailureDisposition,
  LlmGenerator,
  LlmRequestContext,
  LlmStreamReceiver,
  LlmStreamResult,
  LlmWebSearchCall,
} from '../gen';
import { bytesToDataUrl, isVisionImageMimeType, readDialogArtifactBytes } from './artifacts';
import { classifyOpenAiLikeFailure } from './failure-classifier';
import {
  findFirstToolCallAdjacencyViolation,
  formatToolCallAdjacencyViolation,
  normalizeToolCallPairs,
} from './tool-call-context';
import {
  resolveProviderToolResultMaxChars,
  truncateProviderToolOutputText,
} from './tool-output-limit';

const log = createLogger('llm/openai');

function limitOpenAiToolOutputText(text: string, msg: FuncResultMsg, limitChars: number): string {
  const limited = truncateProviderToolOutputText(text, limitChars);
  if (limited.truncated) {
    log.warn('OPENAI tool output truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalChars: limited.originalChars,
      limitChars: limited.limitChars,
    });
  }
  return limited.text;
}

function limitOpenAiToolOutputItems(
  output: ResponseFunctionCallOutputItemList,
  msg: FuncResultMsg,
  limitChars: number,
): ResponseFunctionCallOutputItemList {
  let remainingChars = limitChars;
  let truncated = false;
  const limited: ResponseFunctionCallOutputItemList = [];

  for (const item of output) {
    if (item.type !== 'input_text') {
      limited.push(item);
      continue;
    }

    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    const next = truncateProviderToolOutputText(item.text, remainingChars);
    limited.push({ type: 'input_text', text: next.text });
    remainingChars -= next.text.length;
    if (next.truncated) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    const originalChars = output.reduce(
      (sum, item) => sum + (item.type === 'input_text' ? item.text.length : 0),
      0,
    );
    log.warn('OPENAI tool output items truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalTextChars: originalChars,
    });
  }

  return limited;
}

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
      return {
        type: 'message',
        role: 'assistant',
        content: msg.content,
      };
    case 'thinking_msg':
      return thinkingMessageToOpenAiReasoningItem(msg);
    case 'tellask_result_msg':
    case 'tellask_carryover_msg':
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

function buildReasoningPayloadFromText(text: string): ReasoningPayload | undefined {
  if (text.trim().length === 0) return undefined;
  return {
    summary: [{ type: 'summary_text', text }],
  };
}

function thinkingMessageToOpenAiReasoningItem(
  msg: Extract<ChatMessage, { type: 'thinking_msg' }>,
): ResponseInputItem {
  const reasoning = msg.reasoning ?? buildReasoningPayloadFromText(msg.content);
  if (!reasoning) {
    return { type: 'reasoning', summary: [] } as unknown as ResponseReasoningItem;
  }
  // Some Responses-compatible gateways reject client-fabricated reasoning IDs and only accept
  // provider-issued IDs (for example `rs_*`). We therefore omit `id` when replaying persisted
  // reasoning and rely on encrypted_content when available.
  const out = {
    type: 'reasoning',
    summary: reasoning.summary.map((part) => ({ type: 'summary_text', text: part.text })),
  } as Omit<ResponseReasoningItem, 'id'> & { id?: string };
  if (reasoning.content && reasoning.content.length > 0) {
    out.content = reasoning.content.map((part) => ({ type: 'reasoning_text', text: part.text }));
  }
  if (typeof reasoning.encrypted_content === 'string' && reasoning.encrypted_content.length > 0) {
    out.encrypted_content = reasoning.encrypted_content;
  }
  return out as unknown as ResponseReasoningItem;
}

async function funcResultToOpenAiInputItemWithLimit(
  msg: FuncResultMsg,
  limitChars: number,
): Promise<ResponseInputItem> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return {
      type: 'function_call_output',
      call_id: msg.id,
      output: limitOpenAiToolOutputText(msg.content, msg, limitChars),
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
      output: limitOpenAiToolOutputText(msg.content, msg, limitChars),
    };
  }

  return {
    type: 'function_call_output',
    call_id: msg.id,
    output: limitOpenAiToolOutputItems(output, msg, limitChars),
  };
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

function shouldIncludeOpenAiEncryptedReasoning(
  input: ResponseInputItem[],
  reasoning: ResponseCreateParamsStreaming['reasoning'] | undefined,
): boolean {
  if (reasoning !== undefined) return true;
  return input.some((item) => isRecord(item) && item.type === 'reasoning');
}

async function buildOpenAiRequestInput(
  context: ChatMessage[],
  providerConfig?: ProviderConfig,
): Promise<ResponseInputItem[]> {
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(violation, 'OPENAI provider projection');
    log.error(detail, new Error('openai_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const input: ResponseInputItem[] = [];
  const toolResultMaxChars = resolveProviderToolResultMaxChars(providerConfig);

  for (const msg of normalized) {
    input.push(chatMessageToOpenAiInputItem(msg));
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

function buildOpenAiTextConfig(
  openAiParams: NonNullable<Team.ModelParams['openai']>,
): ResponseCreateParamsStreaming['text'] | undefined {
  const textConfig: NonNullable<ResponseCreateParamsStreaming['text']> = {};
  if (openAiParams.verbosity !== undefined) {
    textConfig.verbosity = openAiParams.verbosity;
  }
  const textFormat = openAiParams.text_format;
  if (textFormat === 'text' || textFormat === 'json_object') {
    textConfig.format = { type: textFormat };
  } else if (textFormat === 'json_schema') {
    const schemaName = openAiParams.text_format_json_schema_name?.trim();
    const rawSchema = openAiParams.text_format_json_schema?.trim();
    if (!schemaName || !rawSchema) {
      throw new Error(
        'Invalid openai text_format=json_schema: text_format_json_schema_name and text_format_json_schema are required.',
      );
    }
    let parsedSchema: unknown;
    try {
      parsedSchema = JSON.parse(rawSchema);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid openai text_format_json_schema: ${message}`);
    }
    if (!isRecord(parsedSchema)) {
      throw new Error(
        'Invalid openai text_format_json_schema: expected a JSON object at the top level.',
      );
    }
    textConfig.format = {
      type: 'json_schema',
      name: schemaName,
      schema: parsedSchema,
      ...(openAiParams.text_format_json_schema_strict !== undefined
        ? { strict: openAiParams.text_format_json_schema_strict }
        : {}),
    };
  }
  return textConfig.verbosity !== undefined || textConfig.format !== undefined
    ? textConfig
    : undefined;
}

function buildOpenAiReasoning(
  openAiParams: NonNullable<Team.ModelParams['openai']>,
): ResponseCreateParamsStreaming['reasoning'] | undefined {
  if (openAiParams.reasoning_effort === undefined && openAiParams.reasoning_summary === undefined) {
    return undefined;
  }

  const summary = openAiParams.reasoning_summary === 'none' ? null : openAiParams.reasoning_summary;
  return {
    ...(openAiParams.reasoning_effort !== undefined
      ? { effort: openAiParams.reasoning_effort }
      : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function buildOpenAiNativeTools(openAiParams: NonNullable<Team.ModelParams['openai']>): Tool[] {
  const enabled =
    openAiParams.web_search_tool === true ||
    openAiParams.web_search_context_size !== undefined ||
    (Array.isArray(openAiParams.web_search_allowed_domains) &&
      openAiParams.web_search_allowed_domains.length > 0);
  if (!enabled) return [];

  const webSearchTool = {
    type: 'web_search',
    ...(openAiParams.web_search_context_size !== undefined
      ? { search_context_size: openAiParams.web_search_context_size }
      : {}),
    ...(Array.isArray(openAiParams.web_search_allowed_domains) &&
    openAiParams.web_search_allowed_domains.length > 0
      ? { filters: { allowed_domains: openAiParams.web_search_allowed_domains } }
      : {}),
  } as unknown as Tool;
  return [webSearchTool];
}

function buildOpenAiInclude(
  input: ResponseInputItem[],
  reasoning: ResponseCreateParamsStreaming['reasoning'] | undefined,
  openAiParams: NonNullable<Team.ModelParams['openai']>,
): NonNullable<ResponseCreateParamsStreaming['include']> | undefined {
  const include = new Set<NonNullable<ResponseCreateParamsStreaming['include']>[number]>();
  if (shouldIncludeOpenAiEncryptedReasoning(input, reasoning)) {
    include.add('reasoning.encrypted_content');
  }
  if (openAiParams.web_search_include_sources === true) {
    include.add('web_search_call.action.sources');
  }
  return include.size > 0 ? Array.from(include) : undefined;
}

function toOpenAiLlmWebSearchCall(
  item: Record<string, unknown>,
  itemId: string,
  phase: 'added' | 'done',
): LlmWebSearchCall {
  const rawAction = isRecord(item.action) ? item.action : null;
  let action: LlmWebSearchCall['action'];
  if (rawAction?.type === 'search') {
    const queries =
      Array.isArray(rawAction.queries) &&
      rawAction.queries.every((entry) => typeof entry === 'string')
        ? rawAction.queries
        : undefined;
    action = {
      type: 'search',
      ...(typeof rawAction.query === 'string' ? { query: rawAction.query } : {}),
      ...(queries && queries.length > 0 ? { queries } : {}),
    };
  } else if (rawAction?.type === 'open_page') {
    action = {
      type: 'open_page',
      ...(typeof rawAction.url === 'string' ? { url: rawAction.url } : {}),
    };
  } else if (rawAction?.type === 'find_in_page') {
    action = {
      type: 'find_in_page',
      ...(typeof rawAction.url === 'string' ? { url: rawAction.url } : {}),
      ...(typeof rawAction.pattern === 'string' ? { pattern: rawAction.pattern } : {}),
    };
  } else {
    action = undefined;
  }

  return {
    source: 'openai_responses',
    phase,
    itemId,
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

export async function buildOpenAiRequestInputWrapper(
  context: ChatMessage[],
  providerConfig?: ProviderConfig,
): Promise<ResponseInputItem[]> {
  return await buildOpenAiRequestInput(context, providerConfig);
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
  const payload = extractReasoningPayload(item);
  if (!payload) return '';
  let text = '';
  for (const part of payload.summary) {
    text += part.text;
  }
  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      text += part.text;
    }
  }
  return text;
}

function extractReasoningPayload(item: ResponseOutputItem): ReasoningPayload | null {
  if (!isRecord(item) || item.type !== 'reasoning') return null;
  const summary: ReasoningPayload['summary'] = [];
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (!isRecord(part) || part.type !== 'summary_text') continue;
      if (typeof part.text !== 'string') continue;
      summary.push({ type: 'summary_text', text: part.text });
    }
  }

  const content: NonNullable<ReasoningPayload['content']> = [];
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!isRecord(part) || typeof part.text !== 'string') continue;
      if (part.type !== 'reasoning_text' && part.type !== 'text') continue;
      content.push({ type: part.type, text: part.text });
    }
  }

  const encrypted =
    typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
      ? item.encrypted_content
      : undefined;

  const out: ReasoningPayload = { summary };
  if (content.length > 0) out.content = content;
  if (encrypted) out.encrypted_content = encrypted;
  return out;
}

function openAiResponseToChatMessages(response: Response, genseq: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const output = response.output;
  if (!Array.isArray(output)) return messages;

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;

    if (item.type === 'reasoning') {
      const reasoning = extractReasoningPayload(item as unknown as ResponseOutputItem);
      const content = extractReasoningText(item as unknown as ResponseOutputItem);
      if (content.length > 0 || reasoning !== null) {
        messages.push({
          type: 'thinking_msg',
          role: 'assistant',
          genseq,
          content,
          reasoning: reasoning ?? undefined,
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

  classifyFailure(error: unknown): LlmFailureDisposition | undefined {
    return classifyOpenAiLikeFailure(error);
  }

  async genToReceiver(
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    _requestContext: LlmRequestContext,
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

    const requestInput: ResponseInputItem[] = await buildOpenAiRequestInput(
      context,
      providerConfig,
    );

    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;
    const textConfig = buildOpenAiTextConfig(openAiParams);
    const reasoning = buildOpenAiReasoning(openAiParams);
    const nativeTools = buildOpenAiNativeTools(openAiParams);
    const include = buildOpenAiInclude(requestInput, reasoning, openAiParams);
    const tools = [...funcTools.map(funcToolToOpenAiTool), ...nativeTools];

    const payload: ResponseCreateParamsStreaming = {
      model: agent.model,
      input: requestInput,
      instructions: systemPrompt.trim().length > 0 ? systemPrompt : undefined,
      max_output_tokens: maxOutputTokens,
      parallel_tool_calls: parallelToolCalls,
      store: false,
      stream: true,
      ...(openAiParams.service_tier !== undefined && { service_tier: openAiParams.service_tier }),
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(reasoning !== undefined && { reasoning }),
      ...(include !== undefined ? { include } : {}),
      ...(textConfig !== undefined && { text: textConfig }),
      ...(tools.length > 0
        ? { tools, tool_choice: 'auto' as const }
        : { tool_choice: 'none' as const }),
    };

    let sayingStarted = false;
    let thinkingStarted = false;
    let currentThinkingContent = '';
    let finishedThinkingFromDelta = false;
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

    function readOptionalEventString(value: unknown): string {
      return typeof value === 'string' ? value : '';
    }

    async function requireEventString(
      value: unknown,
      eventType: string,
      field: string,
    ): Promise<string> {
      if (typeof value === 'string') return value;
      const detail = `OPENAI malformed stream event ${eventType}: missing string ${field}`;
      log.error(detail, new Error('openai_malformed_stream_event'));
      if (receiver.streamError) {
        await receiver.streamError(detail);
      }
      throw new Error(detail);
    }

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
                await receiver.thinkingFinish(
                  buildReasoningPayloadFromText(currentThinkingContent),
                );
                thinkingStarted = false;
                currentThinkingContent = '';
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
              await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
              thinkingStarted = false;
              currentThinkingContent = '';
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
            const delta = await requireEventString(event.delta, event.type, 'delta');
            if (delta.length > 0) {
              if (activeStream === 'thinking') {
                const detail =
                  'OPENAI stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('openai_stream_overlap_violation'));
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
                if (thinkingStarted) {
                  await receiver.thinkingFinish(
                    buildReasoningPayloadFromText(currentThinkingContent),
                  );
                  thinkingStarted = false;
                  currentThinkingContent = '';
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
            const text = await requireEventString(event.text, event.type, 'text');
            if (!sawOutputText && text.length > 0) {
              if (activeStream === 'thinking') {
                const detail =
                  'OPENAI stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('openai_stream_overlap_violation'));
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
                if (thinkingStarted) {
                  await receiver.thinkingFinish(
                    buildReasoningPayloadFromText(currentThinkingContent),
                  );
                  thinkingStarted = false;
                  currentThinkingContent = '';
                }
                activeStream = 'idle';
              }
              if (!sayingStarted) {
                sayingStarted = true;
                await receiver.sayingStart();
                activeStream = 'saying';
              }
              await receiver.sayingChunk(text);
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
            const delta = await requireEventString(event.delta, event.type, 'delta');
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
                currentThinkingContent = '';
                await receiver.thinkingStart();
                activeStream = 'thinking';
              }
              currentThinkingContent += delta;
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
              currentThinkingContent = '';
              await receiver.thinkingStart();
              activeStream = 'thinking';
            }
            break;
          }
          case 'response.reasoning_summary_text.done':
          case 'response.reasoning_text.done':
          case 'response.reasoning_summary_part.done': {
            if (thinkingStarted) {
              await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
              thinkingStarted = false;
              currentThinkingContent = '';
              finishedThinkingFromDelta = true;
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

            if (isRecord(item) && item.type === 'web_search_call' && receiver.webSearchCall) {
              const itemId = typeof item.id === 'string' ? item.id.trim() : '';
              if (itemId.length > 0) {
                await receiver.webSearchCall(toOpenAiLlmWebSearchCall(item, itemId, 'done'));
              } else {
                const detail =
                  'Non-fatal LLM error: invalid web_search_call (missing itemId); dropping event';
                log.error(detail, new Error('openai_web_search_call_missing_item_id'), {
                  status: item.status,
                  action: item.action,
                });
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
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
                    await receiver.thinkingFinish(
                      buildReasoningPayloadFromText(currentThinkingContent),
                    );
                    thinkingStarted = false;
                    currentThinkingContent = '';
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

            if (isRecord(item) && item.type === 'reasoning') {
              if (finishedThinkingFromDelta) {
                finishedThinkingFromDelta = false;
                break;
              }
              const payload = extractReasoningPayload(item as unknown as ResponseOutputItem);
              const text = extractReasoningText(item as unknown as ResponseOutputItem);
              if (thinkingStarted) {
                if (currentThinkingContent.length === 0 && text.length > 0) {
                  currentThinkingContent = text;
                  await receiver.thinkingChunk(text);
                }
                await receiver.thinkingFinish(
                  payload ?? buildReasoningPayloadFromText(currentThinkingContent),
                );
                thinkingStarted = false;
                currentThinkingContent = '';
                if (activeStream === 'thinking') activeStream = 'idle';
                break;
              }
              if (text.length > 0 || payload !== null) {
                if (activeStream === 'saying') {
                  if (sayingStarted) {
                    await receiver.sayingFinish();
                    sayingStarted = false;
                  }
                  activeStream = 'idle';
                }
                await receiver.thinkingStart();
                if (text.length > 0) {
                  await receiver.thinkingChunk(text);
                }
                await receiver.thinkingFinish(payload ?? buildReasoningPayloadFromText(text));
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
            if (isRecord(item) && item.type === 'web_search_call' && receiver.webSearchCall) {
              const itemId = typeof item.id === 'string' ? item.id.trim() : '';
              if (itemId.length > 0) {
                await receiver.webSearchCall(toOpenAiLlmWebSearchCall(item, itemId, 'added'));
              } else {
                const detail =
                  'Non-fatal LLM error: invalid web_search_call (missing itemId); dropping event';
                log.error(detail, new Error('openai_web_search_call_missing_item_id'), {
                  status: item.status,
                  action: item.action,
                });
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
              }
            }
            break;
          }
          case 'response.content_part.added':
          case 'response.content_part.done':
            break;
          case 'response.function_call_arguments.delta': {
            const itemId = await requireEventString(event.item_id, event.type, 'item_id');
            const delta = await requireEventString(event.delta, event.type, 'delta');
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
            const itemId = await requireEventString(event.item_id, event.type, 'item_id');
            const name = readOptionalEventString(event.name);
            const args = readOptionalEventString(event.arguments);
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

      for (const state of activeFuncCallsByItemId.values()) {
        await maybeEmitFuncCall(state, receiver);
      }
      const unresolvedFuncCalls = Array.from(activeFuncCallsByItemId.values()).filter(
        (state) =>
          !state.emitted &&
          (state.callId.length > 0 || state.name.length > 0 || state.argsJson.length > 0),
      );
      if (unresolvedFuncCalls.length > 0) {
        const detail =
          'OPENAI incomplete function-call stream state: ' +
          unresolvedFuncCalls
            .map(
              (state) =>
                `itemId=${state.itemId},callId=${state.callId || '<missing>'},name=${state.name || '<missing>'}`,
            )
            .join('; ');
        log.error(detail, new Error('openai_incomplete_function_call_stream_state'));
        if (receiver.streamError) {
          await receiver.streamError(detail);
        }
        throw new Error(detail);
      }
    } catch (error: unknown) {
      log.warn('OPENAI streaming error', error);
      throw error;
    } finally {
      if (thinkingStarted) {
        await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
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
    _requestContext: LlmRequestContext,
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

    const requestInput: ResponseInputItem[] = await buildOpenAiRequestInput(
      context,
      providerConfig,
    );
    const openAiParams = agent.model_params?.openai || {};
    const maxTokens = agent.model_params?.max_tokens;
    const modelInfo = providerConfig.models[agent.model];
    const outputLength = modelInfo?.output_length;
    const maxOutputTokens = maxTokens ?? openAiParams.max_tokens ?? outputLength ?? 1024;
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;
    const textConfig = buildOpenAiTextConfig(openAiParams);
    const reasoning = buildOpenAiReasoning(openAiParams);
    const nativeTools = buildOpenAiNativeTools(openAiParams);
    const include = buildOpenAiInclude(requestInput, reasoning, openAiParams);
    const tools = [...funcTools.map(funcToolToOpenAiTool), ...nativeTools];

    const payload: ResponseCreateParamsNonStreaming = {
      model: agent.model,
      input: requestInput,
      instructions: systemPrompt.trim().length > 0 ? systemPrompt : undefined,
      max_output_tokens: maxOutputTokens,
      parallel_tool_calls: parallelToolCalls,
      store: false,
      stream: false,
      ...(openAiParams.service_tier !== undefined && { service_tier: openAiParams.service_tier }),
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(reasoning !== undefined && { reasoning }),
      ...(include !== undefined ? { include } : {}),
      ...(textConfig !== undefined && { text: textConfig }),
      ...(tools.length > 0
        ? { tools, tool_choice: 'auto' as const }
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
