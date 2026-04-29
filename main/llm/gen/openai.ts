/**
 * Module: llm/gen/openai
 *
 * OpenAI Responses API integration implementing streaming and batch generation.
 * Isolation principle: this wrapper owns OpenAI Responses request/stream semantics and must not
 * inherit Codex-specific abstractions or parameter aliases.
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
import { normalizeProviderApiQuirks, XCODE_BEST_STREAM_INTERNAL_ERROR_CODE } from '../api-quirks';
import type { ChatMessage, FuncResultMsg, ProviderConfig } from '../client';
import {
  LlmStreamErrorEmittedError,
  type LlmBatchOutput,
  type LlmBatchResult,
  type LlmFailureDisposition,
  type LlmGenerator,
  type LlmRequestContext,
  type LlmStreamReceiver,
  type LlmStreamResult,
  type OpenAiResponsesLlmWebSearchAction,
  type OpenAiResponsesLlmWebSearchCall,
  type OpenAiResponsesNativeToolCall,
  type OpenAiResponsesNativeToolItemType,
  type OpenAiResponsesNonCustomNativeToolItemType,
  type ToolResultImageIngest,
  type UserImageIngest,
} from '../gen';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';
import { bytesToDataUrl, isVisionImageMimeType } from './artifacts';
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
import {
  buildImageBudgetKeyForContentItem,
  buildImageBudgetLimitDetail,
  buildToolResultImageIngest,
  buildUserImageIngest,
  OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/openai');

const OPENAI_API_QUIRK_VENDOR_HEARTBEAT_EVENT_TYPES: Record<string, readonly string[]> = {
  'xcode.best': ['keepalive'],
};

const OPENAI_NATIVE_TOOL_ITEM_TYPES = new Set<OpenAiResponsesNativeToolItemType>([
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
  'mcp_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'custom_tool_call',
]);

const OPENAI_MALFORMED_BATCH_OUTPUT_ITEM_ERROR_CODE = 'OPENAI_MALFORMED_BATCH_OUTPUT_ITEM';

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

function readEventType(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  return value.type;
}

function resolveOpenAiVendorHeartbeatEventTypes(providerConfig: ProviderConfig): Set<string> {
  const eventTypes = new Set<string>();
  for (const quirk of normalizeProviderApiQuirks(providerConfig)) {
    const vendorEventTypes = OPENAI_API_QUIRK_VENDOR_HEARTBEAT_EVENT_TYPES[quirk];
    if (!vendorEventTypes) continue;
    for (const eventType of vendorEventTypes) {
      eventTypes.add(eventType);
    }
  }
  return eventTypes;
}

function maybeAnnotateOpenAiQuirkFailure(providerConfig: ProviderConfig, error: unknown): unknown {
  const quirks = normalizeProviderApiQuirks(providerConfig);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : isRecord(error) && typeof error.message === 'string'
          ? error.message
          : '';
  const lowerMessage = message.toLowerCase();

  if (
    quirks.has('xcode.best') &&
    lowerMessage.includes('stream error:') &&
    lowerMessage.includes('internal_error') &&
    lowerMessage.includes('received from peer')
  ) {
    if (error instanceof Error) {
      const out = error as Error & { code?: string };
      out.code = XCODE_BEST_STREAM_INTERNAL_ERROR_CODE;
      return out;
    }
    const out = new Error(message.length > 0 ? message : 'xcode.best stream internal error');
    (out as Error & { code?: string }).code = XCODE_BEST_STREAM_INTERNAL_ERROR_CODE;
    return out;
  }

  return error;
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

async function userLikeMessageToOpenAiInputItemWithImages(
  msg: Extract<
    ChatMessage,
    { type: 'prompting_msg' | 'tellask_result_msg' | 'tellask_carryover_msg' }
  >,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ResponseInputItem> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToOpenAiInputItem(msg);
  }

  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; detail: 'auto'; image_url: string }
  > = [{ type: 'input_text', text: msg.content }];
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    true,
  );
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      content.push({ type: 'input_text', text: item.text });
      continue;
    }
    if (item.type === 'input_image') {
      if (!supportsImageInput) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_model_unsupported',
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        content.push({
          type: 'input_text',
          text: `[image not sent: current model does not support image input]`,
        });
        continue;
      }
      if (!isVisionImageMimeType(item.mimeType)) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_mime_unsupported',
              mimeType: item.mimeType,
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        content.push({
          type: 'input_text',
          text: `[image not sent: unsupported mimeType=${item.mimeType}]`,
        });
        continue;
      }
      if (
        !allowedImageKeys.has(
          buildImageBudgetKeyForContentItem({ msg, itemIndex, artifact: item.artifact }),
        )
      ) {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_size_limit',
              detail: buildImageBudgetLimitDetail({
                byteLength: item.byteLength,
                budgetBytes: OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        content.push({
          type: 'input_text',
          text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
          )}]`,
        });
        continue;
      }
      const bytesResult = await readToolResultImageBytesSafe(item.artifact);
      if (bytesResult.kind === 'missing') {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_missing',
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        content.push({ type: 'input_text', text: `[image missing: ${item.artifact.relPath}]` });
        continue;
      }
      if (bytesResult.kind === 'read_failed') {
        if (onUserImageIngest) {
          await onUserImageIngest(
            buildUserImageIngest({
              requestContext,
              ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
              artifact: item.artifact,
              disposition: 'filtered_read_failed',
              detail: bytesResult.detail,
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        content.push({ type: 'input_text', text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onUserImageIngest) {
        await onUserImageIngest(
          buildUserImageIngest({
            requestContext,
            ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'OpenAI Responses path',
          }),
        );
      }
      content.push({
        type: 'input_image',
        detail: 'auto',
        image_url: bytesToDataUrl({ mimeType: item.mimeType, bytes: bytesResult.bytes }),
      });
      continue;
    }
    const _exhaustive: never = item;
    throw new Error(`Unsupported user content item: ${String(_exhaustive)}`);
  }

  return {
    type: 'message',
    role: 'user',
    content,
  } as ResponseInputItem;
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
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
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
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      output.push({ type: 'input_text', text: item.text });
      continue;
    }

    if (item.type === 'input_image') {
      if (!supportsImageInput) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_model_unsupported',
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        output.push({
          type: 'input_text',
          text: `[image not sent: current model does not support image input]`,
        });
        continue;
      }
      if (!isVisionImageMimeType(item.mimeType)) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_mime_unsupported',
              mimeType: item.mimeType,
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        output.push({
          type: 'input_text',
          text: `[image omitted: unsupported mimeType=${item.mimeType}]`,
        });
        continue;
      }
      if (
        !allowedImageKeys.has(
          buildImageBudgetKeyForContentItem({ msg, itemIndex, artifact: item.artifact }),
        )
      ) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_size_limit',
              detail: buildImageBudgetLimitDetail({
                byteLength: item.byteLength,
                budgetBytes: OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        output.push({
          type: 'input_text',
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
          )}]`,
        });
        continue;
      }

      const bytesResult = await readToolResultImageBytesSafe(item.artifact);
      if (bytesResult.kind === 'missing') {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_missing',
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        output.push({
          type: 'input_text',
          text: `[image missing: ${item.artifact.relPath}]`,
        });
        continue;
      }
      if (bytesResult.kind === 'read_failed') {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: 'filtered_read_failed',
              detail: bytesResult.detail,
              providerPathLabel: 'OpenAI Responses path',
            }),
          );
        }
        output.push({
          type: 'input_text',
          text: `[image unreadable: ${item.artifact.relPath}]`,
        });
        continue;
      }
      const bytes = bytesResult.bytes;
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: msg.id,
            toolName: msg.name,
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'OpenAI Responses path',
          }),
        );
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
  requestContext: LlmRequestContext,
  providerConfig?: ProviderConfig,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
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
  const allowedImageKeys = selectLatestImagesWithinBudget(
    normalized,
    OPENAI_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    true,
  );

  for (const msg of normalized) {
    if (
      (msg.type === 'prompting_msg' ||
        msg.type === 'tellask_result_msg' ||
        msg.type === 'tellask_carryover_msg') &&
      Array.isArray(msg.contentItems) &&
      msg.contentItems.length > 0
    ) {
      input.push(
        await userLikeMessageToOpenAiInputItemWithImages(
          msg,
          requestContext,
          providerConfig,
          allowedImageKeys,
          onUserImageIngest,
        ),
      );
      continue;
    }
    if (msg.type === 'func_result_msg') {
      input.push(
        await funcResultToOpenAiInputItemWithLimit(
          msg,
          toolResultMaxChars,
          requestContext,
          allowedImageKeys,
          supportsImageInput,
          onToolResultImageIngest,
        ),
      );
      continue;
    }
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
): OpenAiResponsesLlmWebSearchCall {
  const rawAction = isRecord(item.action) ? item.action : null;
  let action: OpenAiResponsesLlmWebSearchAction | undefined;
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

function buildOpenAiWebSearchProgressCall(
  itemId: string,
  phase: 'added' | 'done',
  status: string,
  action?: OpenAiResponsesLlmWebSearchAction,
): OpenAiResponsesLlmWebSearchCall {
  return {
    source: 'openai_responses',
    phase,
    itemId,
    status,
    ...(action !== undefined ? { action } : {}),
  };
}

function throwOpenAiMalformedBatchOutputItem(itemType: string, detail: string): never {
  const message = `OPENAI malformed batch output item ${itemType}: ${detail}`;
  const error = new Error(message) as Error & { code?: string };
  error.code = OPENAI_MALFORMED_BATCH_OUTPUT_ITEM_ERROR_CODE;
  log.error(message, error);
  throw error;
}

async function throwOpenAiMalformedStreamEvent(
  receiver: LlmStreamReceiver,
  eventType: string,
  detail: string,
): Promise<never> {
  const message = `OPENAI malformed stream event ${eventType}: ${detail}`;
  log.error(message, new Error('openai_malformed_stream_event'));
  if (receiver.streamError) {
    await receiver.streamError(message);
  }
  throw new LlmStreamErrorEmittedError({
    detail: message,
    i18nStopReason: buildHumanSystemStopReasonTextI18n({
      detail: message,
      kind: 'malformed_stream',
    }),
  });
}

type OpenAiItemNativeToolState = {
  itemType: OpenAiResponsesNonCustomNativeToolItemType;
  itemId: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

type OpenAiCustomToolState = {
  itemType: 'custom_tool_call';
  callId: string;
  itemId?: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

type OpenAiNativeToolState = OpenAiItemNativeToolState | OpenAiCustomToolState;

type OpenAiItemNativeToolSeed = {
  itemType: OpenAiResponsesNonCustomNativeToolItemType;
  itemId: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

type OpenAiCustomToolSeed = {
  itemType: 'custom_tool_call';
  callId: string;
  itemId?: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

type OpenAiNativeToolSeed = OpenAiItemNativeToolSeed | OpenAiCustomToolSeed;

function buildOpenAiNativeToolCallFromState(
  state: OpenAiNativeToolState,
  phase: 'added' | 'done',
): OpenAiResponsesNativeToolCall {
  if (state.itemType === 'custom_tool_call') {
    return {
      source: 'openai_responses',
      itemType: state.itemType,
      phase,
      callId: state.callId,
      ...(state.itemId !== undefined ? { itemId: state.itemId } : {}),
      ...(state.status !== undefined ? { status: state.status } : {}),
      ...(state.title !== undefined ? { title: state.title } : {}),
      ...(state.summary !== undefined ? { summary: state.summary } : {}),
      ...(state.detail !== undefined ? { detail: state.detail } : {}),
    };
  }
  return {
    source: 'openai_responses',
    itemType: state.itemType,
    phase,
    itemId: state.itemId,
    ...(state.status !== undefined ? { status: state.status } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.summary !== undefined ? { summary: state.summary } : {}),
    ...(state.detail !== undefined ? { detail: state.detail } : {}),
  };
}

function mergeOpenAiNativeToolSeedIntoState(
  state: OpenAiNativeToolState,
  seed: OpenAiNativeToolSeed,
): OpenAiNativeToolState {
  if (state.itemType !== seed.itemType) {
    throw new Error(
      `OPENAI native tool tracker invariant violation: itemType mismatch (${state.itemType} !== ${seed.itemType})`,
    );
  }
  if (state.itemType === 'custom_tool_call' && seed.itemType === 'custom_tool_call') {
    if (state.callId !== seed.callId) {
      throw new Error(
        `OPENAI native tool tracker invariant violation: custom callId mismatch (${state.callId} !== ${seed.callId})`,
      );
    }
    if (seed.itemId !== undefined && seed.itemId.trim() !== '') {
      const normalizedItemId = seed.itemId.trim();
      if (state.itemId !== undefined && state.itemId !== normalizedItemId) {
        throw new Error(
          `OPENAI native tool tracker invariant violation: custom itemId mismatch (${state.itemId} !== ${normalizedItemId})`,
        );
      }
      state.itemId = normalizedItemId;
    }
  } else if (state.itemType !== 'custom_tool_call' && seed.itemType !== 'custom_tool_call') {
    if (state.itemId !== seed.itemId) {
      throw new Error(
        `OPENAI native tool tracker invariant violation: item tool itemId mismatch (${state.itemId} !== ${seed.itemId})`,
      );
    }
  }
  if (seed.status !== undefined) {
    state.status = seed.status;
  }
  if (seed.title !== undefined) {
    state.title = seed.title;
  }
  if (seed.summary !== undefined) {
    state.summary = seed.summary;
  }
  if (seed.detail !== undefined) {
    state.detail = seed.detail;
  }
  return state;
}

class OpenAiNativeToolTracker {
  private readonly itemToolByItemId = new Map<string, OpenAiItemNativeToolState>();
  private readonly customToolByCallId = new Map<string, OpenAiCustomToolState>();
  private readonly customCallIdByItemId = new Map<string, string>();

  private upsertItemTool(seed: OpenAiItemNativeToolSeed): OpenAiItemNativeToolState {
    const existing = this.itemToolByItemId.get(seed.itemId);
    const state =
      existing ??
      ({
        itemType: seed.itemType,
        itemId: seed.itemId,
      } satisfies OpenAiItemNativeToolState);
    mergeOpenAiNativeToolSeedIntoState(state, seed);
    if (!existing) {
      this.itemToolByItemId.set(seed.itemId, state);
    }
    return state;
  }

  private upsertCustomTool(seed: OpenAiCustomToolSeed): OpenAiCustomToolState {
    const existing = this.customToolByCallId.get(seed.callId);
    const state =
      existing ??
      ({
        itemType: 'custom_tool_call',
        callId: seed.callId,
      } satisfies OpenAiCustomToolState);
    if (seed.itemId !== undefined && seed.itemId.trim() !== '') {
      const normalizedItemId = seed.itemId.trim();
      const existingCallId = this.customCallIdByItemId.get(normalizedItemId);
      if (existingCallId !== undefined && existingCallId !== seed.callId) {
        throw new Error(
          `OPENAI native tool tracker invariant violation: custom itemId ${normalizedItemId} already bound to a different callId`,
        );
      }
    }
    mergeOpenAiNativeToolSeedIntoState(state, seed);
    if (!existing) {
      this.customToolByCallId.set(seed.callId, state);
    }
    if (state.itemId !== undefined) {
      this.customCallIdByItemId.set(state.itemId, state.callId);
    }
    return state;
  }

  public claimCustomToolByItemId(itemId: string): OpenAiCustomToolState {
    const mappedCallId = this.customCallIdByItemId.get(itemId);
    if (mappedCallId !== undefined) {
      const existing = this.customToolByCallId.get(mappedCallId);
      if (!existing) {
        throw new Error(
          `OPENAI native tool tracker invariant violation: missing custom tool state for mapped itemId=${itemId}`,
        );
      }
      return existing;
    }
    const unresolved = Array.from(this.customToolByCallId.values()).filter(
      (state) => state.itemId === undefined,
    );
    if (unresolved.length === 1) {
      const claimed = unresolved[0]!;
      claimed.itemId = itemId;
      this.customCallIdByItemId.set(itemId, claimed.callId);
      return claimed;
    }
    if (unresolved.length === 0) {
      throw new Error(
        `OPENAI native tool tracker invariant violation: missing unresolved custom tool state for itemId=${itemId}`,
      );
    }
    throw new Error(
      `OPENAI native tool tracker invariant violation: ambiguous custom tool itemId correlation for itemId=${itemId}`,
    );
  }

  public upsert(seed: OpenAiNativeToolSeed): OpenAiNativeToolState {
    return seed.itemType === 'custom_tool_call'
      ? this.upsertCustomTool(seed)
      : this.upsertItemTool(seed);
  }
}

function summarizeCodeInterpreterOutputs(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts: string[] = [];
  let imageCount = 0;
  for (const output of value) {
    if (!isRecord(output) || typeof output.type !== 'string') continue;
    if (output.type === 'logs' && typeof output.logs === 'string' && output.logs.trim() !== '') {
      parts.push(output.logs.trim());
      continue;
    }
    if (output.type === 'image') {
      imageCount += 1;
    }
  }
  if (imageCount > 0) {
    parts.push(`images=${String(imageCount)}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function buildOpenAiNativeToolSeed(
  item: Record<string, unknown>,
  itemId?: string,
): OpenAiNativeToolSeed | null {
  if (
    typeof item.type !== 'string' ||
    !OPENAI_NATIVE_TOOL_ITEM_TYPES.has(item.type as OpenAiResponsesNativeToolItemType)
  ) {
    return null;
  }

  const itemType = item.type as OpenAiResponsesNativeToolItemType;
  if (itemType === 'custom_tool_call') {
    const callId = typeof item.call_id === 'string' ? item.call_id.trim() : '';
    if (callId === '') {
      throwOpenAiMalformedBatchOutputItem(itemType, 'missing call_id');
    }
    const base = {
      itemType,
      callId,
      ...(typeof itemId === 'string' && itemId.trim() !== '' ? { itemId: itemId.trim() } : {}),
    } satisfies OpenAiCustomToolSeed;
    const namespace = typeof item.namespace === 'string' ? item.namespace.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const summary =
      namespace !== '' && name !== ''
        ? `${namespace}:${name}`
        : namespace !== ''
          ? namespace
          : name;
    return {
      ...base,
      title: 'Custom Tool Call',
      ...(summary !== '' ? { summary } : {}),
      ...(typeof item.input === 'string' && item.input.trim() !== ''
        ? { detail: item.input.trim() }
        : {}),
    };
  }

  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throwOpenAiMalformedBatchOutputItem(itemType, 'missing itemId');
  }
  const base = {
    itemType,
    itemId: itemId.trim(),
  } satisfies OpenAiItemNativeToolSeed;
  switch (itemType) {
    case 'file_search_call': {
      const queries =
        Array.isArray(item.queries) && item.queries.every((entry) => typeof entry === 'string')
          ? item.queries
          : [];
      const results = Array.isArray(item.results) ? item.results.length : 0;
      return {
        ...base,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        title: 'File Search',
        ...(queries.length > 0 ? { summary: queries.join('\n') } : {}),
        ...(results > 0 ? { detail: `results=${String(results)}` } : {}),
      };
    }
    case 'code_interpreter_call': {
      return {
        ...base,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        title: 'Code Interpreter',
        ...(typeof item.code === 'string' && item.code.trim() !== ''
          ? { summary: item.code.trim() }
          : {}),
        ...(typeof item.container_id === 'string' && item.container_id.trim() !== ''
          ? {
              detail: `container=${item.container_id.trim()}${summarizeCodeInterpreterOutputs(item.outputs) ? `\n${summarizeCodeInterpreterOutputs(item.outputs)}` : ''}`,
            }
          : summarizeCodeInterpreterOutputs(item.outputs)
            ? { detail: summarizeCodeInterpreterOutputs(item.outputs) }
            : {}),
      };
    }
    case 'image_generation_call': {
      return {
        ...base,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        title: 'Image Generation',
        summary:
          typeof item.result === 'string' && item.result.length > 0
            ? 'image_ready'
            : 'image_pending',
      };
    }
    case 'mcp_call': {
      const serverLabel = typeof item.server_label === 'string' ? item.server_label.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const summary =
        serverLabel !== '' && name !== ''
          ? `${serverLabel}: ${name}`
          : serverLabel !== ''
            ? serverLabel
            : name;
      const detailParts = [
        typeof item.arguments === 'string' && item.arguments.trim() !== ''
          ? item.arguments.trim()
          : '',
        typeof item.output === 'string' && item.output.trim() !== '' ? item.output.trim() : '',
        typeof item.error === 'string' && item.error.trim() !== ''
          ? `error=${item.error.trim()}`
          : '',
      ].filter((part) => part.length > 0);
      return {
        ...base,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        title: 'MCP Tool Call',
        ...(summary !== '' ? { summary } : {}),
        ...(detailParts.length > 0 ? { detail: detailParts.join('\n') } : {}),
      };
    }
    case 'mcp_list_tools': {
      const serverLabel = typeof item.server_label === 'string' ? item.server_label.trim() : '';
      const toolNames = Array.isArray(item.tools)
        ? item.tools
            .filter((entry): entry is Record<string, unknown> => isRecord(entry))
            .map((entry) => (typeof entry.name === 'string' ? entry.name.trim() : ''))
            .filter((entry) => entry.length > 0)
        : [];
      const error = typeof item.error === 'string' ? item.error.trim() : '';
      return {
        ...base,
        title: 'MCP Tool Discovery',
        ...(serverLabel !== '' ? { summary: serverLabel } : {}),
        ...(toolNames.length > 0 || error !== ''
          ? { detail: [...toolNames, ...(error !== '' ? [`error=${error}`] : [])].join('\n') }
          : {}),
      };
    }
    case 'mcp_approval_request': {
      const serverLabel = typeof item.server_label === 'string' ? item.server_label.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      return {
        ...base,
        title: 'MCP Approval Request',
        ...(serverLabel !== '' || name !== ''
          ? { summary: [serverLabel, name].filter(Boolean).join(': ') }
          : {}),
        ...(typeof item.arguments === 'string' && item.arguments.trim() !== ''
          ? { detail: item.arguments.trim() }
          : {}),
      };
    }
    default: {
      const _exhaustive: never = itemType;
      return _exhaustive;
    }
  }
}

export async function buildOpenAiRequestInputWrapper(
  context: ChatMessage[],
  providerConfig?: ProviderConfig,
): Promise<ResponseInputItem[]> {
  return await buildOpenAiRequestInput(
    context,
    {
      dialogSelfId: '',
      dialogRootId: '',
      providerKey: 'openai',
      modelKey: 'unknown',
    },
    providerConfig,
  );
}

function extractOutputMessageText(item: ResponseOutputItem): string {
  if (!isRecord(item) || item.type !== 'message') return '';
  const content = item.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  let transcript = '';
  let sawOutputText = false;
  for (const rawPart of content as unknown[]) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') continue;
    if (rawPart.type === 'output_text' && typeof rawPart.text === 'string') {
      sawOutputText = true;
      text += rawPart.text;
    }
    if (rawPart.type === 'output_audio' && typeof rawPart.transcript === 'string') {
      transcript += rawPart.transcript;
    }
    if (rawPart.type === 'refusal' && typeof rawPart.refusal === 'string') {
      text += rawPart.refusal;
    }
  }
  // Keep batch-mode message extraction aligned with streaming semantics: transcript text is only a
  // fallback when the response item did not already carry canonical output_text content.
  if (!sawOutputText && transcript.length > 0) {
    text += transcript;
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

function openAiResponseToBatchOutputs(response: Response, genseq: number): LlmBatchOutput[] {
  const outputs: LlmBatchOutput[] = [];
  const output = response.output;
  if (!Array.isArray(output)) return outputs;
  const nativeToolTracker = new OpenAiNativeToolTracker();

  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;

    if (item.type === 'reasoning') {
      const reasoning = extractReasoningPayload(item as unknown as ResponseOutputItem);
      const content = extractReasoningText(item as unknown as ResponseOutputItem);
      if (content.length > 0 || reasoning !== null) {
        outputs.push({
          kind: 'message',
          message: {
            type: 'thinking_msg',
            role: 'assistant',
            genseq,
            content,
            reasoning: reasoning ?? undefined,
          },
        });
      }
      continue;
    }

    if (item.type === 'message') {
      const content = extractOutputMessageText(item as unknown as ResponseOutputItem);
      if (content.length > 0) {
        outputs.push({
          kind: 'message',
          message: {
            type: 'saying_msg',
            role: 'assistant',
            genseq,
            content,
          },
        });
      }
      continue;
    }

    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      if (callId.length > 0 && name.length > 0) {
        outputs.push({
          kind: 'message',
          message: {
            type: 'func_call_msg',
            role: 'assistant',
            genseq,
            id: callId,
            name,
            arguments: args,
          },
        });
      }
      continue;
    }

    if (item.type === 'web_search_call') {
      const itemId = typeof item.id === 'string' ? item.id.trim() : '';
      if (itemId.length === 0) {
        throwOpenAiMalformedBatchOutputItem(item.type, 'missing itemId');
      }
      outputs.push({
        kind: 'web_search_call',
        call: toOpenAiLlmWebSearchCall(item, itemId, 'done'),
      });
      continue;
    }

    if (OPENAI_NATIVE_TOOL_ITEM_TYPES.has(item.type as OpenAiResponsesNativeToolItemType)) {
      const itemId = typeof item.id === 'string' ? item.id.trim() : undefined;
      const seed = buildOpenAiNativeToolSeed(item, itemId);
      if (seed) {
        const state = nativeToolTracker.upsert(seed);
        outputs.push({
          kind: 'native_tool_call',
          call: buildOpenAiNativeToolCallFromState(state, 'done'),
        });
      }
    }
  }

  return outputs;
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
    requestContext: LlmRequestContext,
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
      requestContext,
      providerConfig,
      receiver.toolResultImageIngest,
      receiver.userImageIngest,
    );

    const openAiParams = agent.model_params?.openai || {};
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;
    const textConfig = buildOpenAiTextConfig(openAiParams);
    const reasoning = buildOpenAiReasoning(openAiParams);
    const nativeTools = buildOpenAiNativeTools(openAiParams);
    const include = buildOpenAiInclude(requestInput, reasoning, openAiParams);
    const tools = [...funcTools.map(funcToolToOpenAiTool), ...nativeTools];
    const vendorHeartbeatEventTypes = resolveOpenAiVendorHeartbeatEventTypes(providerConfig);

    const payload: ResponseCreateParamsStreaming = {
      model: agent.model,
      input: requestInput,
      instructions: systemPrompt.trim().length > 0 ? systemPrompt : undefined,
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
    let sawOutputText = false;
    let currentAudioTranscript = '';
    type ActiveStream = 'idle' | 'thinking' | 'saying';
    let activeStream: ActiveStream = 'idle';
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;
    const streamedReasoningItemIds = new Set<string>();
    let sawReasoningDeltaWithoutItemId = false;

    type ActiveFuncCall = {
      itemId: string;
      callId: string;
      name: string;
      argsJson: string;
      emitted: boolean;
    };

    type ActiveWebSearchCall = {
      itemId: string;
      action?: OpenAiResponsesLlmWebSearchAction;
    };

    const nativeToolTracker = new OpenAiNativeToolTracker();

    function claimNativeToolStateByEventItemId(
      itemId: string,
      itemType: OpenAiResponsesNativeToolItemType,
      title: string,
    ): Promise<OpenAiNativeToolState> | OpenAiNativeToolState {
      try {
        if (itemType === 'custom_tool_call') {
          const existing = nativeToolTracker.claimCustomToolByItemId(itemId);
          if (existing.title === undefined || existing.title.trim() === '') {
            existing.title = title;
          }
          return existing;
        }
        return nativeToolTracker.upsert({
          itemType,
          itemId,
          title,
        });
      } catch (error: unknown) {
        const detail =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : `failed to resolve native tool state for ${itemType}`;
        return throwOpenAiMalformedStreamEvent(receiver, itemType, detail);
      }
    }

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

    async function emitNativeToolCall(
      state: OpenAiNativeToolState,
      phase: 'added' | 'done',
    ): Promise<void> {
      if (!receiver.nativeToolCall) return;
      await receiver.nativeToolCall(buildOpenAiNativeToolCallFromState(state, phase));
    }

    const activeFuncCallsByItemId = new Map<string, ActiveFuncCall>();
    const activeWebSearchCallsByItemId = new Map<string, ActiveWebSearchCall>();

    function readOptionalEventString(value: unknown): string {
      return typeof value === 'string' ? value : '';
    }

    async function requireEventString(
      value: unknown,
      eventType: string,
      field: string,
    ): Promise<string> {
      if (typeof value === 'string') return value;
      return await throwOpenAiMalformedStreamEvent(receiver, eventType, `missing string ${field}`);
    }

    async function requireNonEmptyEventItemId(value: unknown, eventType: string): Promise<string> {
      const itemId = (await requireEventString(value, eventType, 'item_id')).trim();
      if (itemId.length === 0) {
        await throwOpenAiMalformedStreamEvent(receiver, eventType, 'empty item_id');
      }
      return itemId;
    }

    try {
      const stream: AsyncIterable<ResponseStreamEvent> = await client.responses.create(payload, {
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      for await (const event of stream) {
        if (abortSignal?.aborted) {
          throw new Error('AbortError');
        }
        const providerEvent: unknown = event;
        const providerEventType = readEventType(providerEvent);
        if (providerEventType !== null && vendorHeartbeatEventTypes.has(providerEventType)) {
          // Some Responses-compatible gateways emit out-of-band heartbeat frames to keep idle
          // streams alive. They are not part of the official OpenAI event taxonomy and carry no
          // model semantics, so the OpenAI wrapper ignores them locally.
          continue;
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
              if (!sawOutputText && currentAudioTranscript.trim().length > 0) {
                if (!sayingStarted) {
                  await receiver.sayingStart();
                }
                await receiver.sayingChunk(currentAudioTranscript);
                await receiver.sayingFinish();
                sayingStarted = false;
                sawOutputText = true;
              }
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
              if (typeof event.item_id === 'string' && event.item_id.length > 0) {
                streamedReasoningItemIds.add(event.item_id);
              } else {
                sawReasoningDeltaWithoutItemId = true;
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
              if (activeStream === 'thinking') activeStream = 'idle';
            }
            break;
          }

          case 'response.audio.delta':
          case 'response.audio.done':
            break;
          case 'response.audio.transcript.delta': {
            currentAudioTranscript += await requireEventString(event.delta, event.type, 'delta');
            break;
          }
          case 'response.audio.transcript.done':
            break;

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
              if (itemId.length === 0) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing itemId');
              }
              const call = toOpenAiLlmWebSearchCall(item, itemId, 'done');
              activeWebSearchCallsByItemId.set(itemId, {
                itemId,
                action: call.action,
              });
              await receiver.webSearchCall(call);
              break;
            }

            if (
              isRecord(item) &&
              typeof item.type === 'string' &&
              OPENAI_NATIVE_TOOL_ITEM_TYPES.has(item.type as OpenAiResponsesNativeToolItemType)
            ) {
              const itemId = typeof item.id === 'string' ? item.id.trim() : '';
              if (item.type !== 'custom_tool_call' && itemId.length === 0) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing itemId');
              }
              if (
                item.type === 'custom_tool_call' &&
                !(typeof item.call_id === 'string' && item.call_id.trim().length > 0)
              ) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing call_id');
              }
              const seed = buildOpenAiNativeToolSeed(item, itemId.length > 0 ? itemId : undefined);
              if (seed) {
                const state = nativeToolTracker.upsert(seed);
                await emitNativeToolCall(state, 'done');
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
              const itemId = typeof item.id === 'string' && item.id.length > 0 ? item.id : null;
              const sawReasoningDelta =
                itemId !== null
                  ? streamedReasoningItemIds.has(itemId)
                  : sawReasoningDeltaWithoutItemId;
              if (sawReasoningDelta) {
                if (itemId !== null) {
                  streamedReasoningItemIds.delete(itemId);
                } else {
                  sawReasoningDeltaWithoutItemId = false;
                }
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
              if (itemId.length === 0) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing itemId');
              }
              const call = toOpenAiLlmWebSearchCall(item, itemId, 'added');
              activeWebSearchCallsByItemId.set(itemId, {
                itemId,
                action: call.action,
              });
              await receiver.webSearchCall(call);
            }
            if (
              isRecord(item) &&
              typeof item.type === 'string' &&
              OPENAI_NATIVE_TOOL_ITEM_TYPES.has(item.type as OpenAiResponsesNativeToolItemType)
            ) {
              const itemId = typeof item.id === 'string' ? item.id.trim() : '';
              if (item.type !== 'custom_tool_call' && itemId.length === 0) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing itemId');
              }
              if (
                item.type === 'custom_tool_call' &&
                !(typeof item.call_id === 'string' && item.call_id.trim().length > 0)
              ) {
                await throwOpenAiMalformedStreamEvent(receiver, item.type, 'missing call_id');
              }
              const seed = buildOpenAiNativeToolSeed(item, itemId.length > 0 ? itemId : undefined);
              if (seed) {
                const state = nativeToolTracker.upsert(seed);
                await emitNativeToolCall(state, 'added');
              }
            }
            break;
          }
          case 'response.web_search_call.in_progress':
          case 'response.web_search_call.searching':
          case 'response.web_search_call.completed': {
            if (!receiver.webSearchCall) {
              break;
            }
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = activeWebSearchCallsByItemId.get(itemId);
            const status =
              event.type === 'response.web_search_call.in_progress'
                ? 'in_progress'
                : event.type === 'response.web_search_call.searching'
                  ? 'searching'
                  : 'completed';
            const phase = event.type === 'response.web_search_call.completed' ? 'done' : 'added';
            await receiver.webSearchCall(
              buildOpenAiWebSearchProgressCall(itemId, phase, status, existing?.action),
            );
            break;
          }
          case 'response.file_search_call.in_progress':
          case 'response.file_search_call.searching':
          case 'response.file_search_call.completed': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'file_search_call',
              'File Search',
            );
            existing.status =
              event.type === 'response.file_search_call.in_progress'
                ? 'in_progress'
                : event.type === 'response.file_search_call.searching'
                  ? 'searching'
                  : 'completed';
            await emitNativeToolCall(
              existing,
              event.type === 'response.file_search_call.completed' ? 'done' : 'added',
            );
            break;
          }
          case 'response.code_interpreter_call.in_progress':
          case 'response.code_interpreter_call.interpreting':
          case 'response.code_interpreter_call.completed': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'code_interpreter_call',
              'Code Interpreter',
            );
            existing.status =
              event.type === 'response.code_interpreter_call.in_progress'
                ? 'in_progress'
                : event.type === 'response.code_interpreter_call.interpreting'
                  ? 'interpreting'
                  : 'completed';
            await emitNativeToolCall(
              existing,
              event.type === 'response.code_interpreter_call.completed' ? 'done' : 'added',
            );
            break;
          }
          case 'response.code_interpreter_call_code.delta': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const delta = await requireEventString(event.delta, event.type, 'delta');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'code_interpreter_call',
              'Code Interpreter',
            );
            existing.summary = `${existing.summary ?? ''}${delta}`;
            break;
          }
          case 'response.code_interpreter_call_code.done': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const code = await requireEventString(event.code, event.type, 'code');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'code_interpreter_call',
              'Code Interpreter',
            );
            existing.summary = code;
            await emitNativeToolCall(existing, 'added');
            break;
          }
          case 'response.image_generation_call.in_progress':
          case 'response.image_generation_call.generating':
          case 'response.image_generation_call.completed': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'image_generation_call',
              'Image Generation',
            );
            existing.status =
              event.type === 'response.image_generation_call.in_progress'
                ? 'in_progress'
                : event.type === 'response.image_generation_call.generating'
                  ? 'generating'
                  : 'completed';
            await emitNativeToolCall(
              existing,
              event.type === 'response.image_generation_call.completed' ? 'done' : 'added',
            );
            break;
          }
          case 'response.image_generation_call.partial_image': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'image_generation_call',
              'Image Generation',
            );
            const currentIndex =
              typeof event.partial_image_index === 'number' ? event.partial_image_index + 1 : 1;
            existing.detail = `partial_images=${String(currentIndex)}`;
            break;
          }
          case 'response.mcp_call.in_progress':
          case 'response.mcp_call.failed':
          case 'response.mcp_call.completed': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'mcp_call',
              'MCP Tool Call',
            );
            existing.status =
              event.type === 'response.mcp_call.in_progress'
                ? 'in_progress'
                : event.type === 'response.mcp_call.failed'
                  ? 'failed'
                  : 'completed';
            await emitNativeToolCall(
              existing,
              event.type === 'response.mcp_call.completed' ? 'done' : 'added',
            );
            break;
          }
          case 'response.mcp_call_arguments.delta': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const delta = await requireEventString(event.delta, event.type, 'delta');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'mcp_call',
              'MCP Tool Call',
            );
            existing.detail = `${existing.detail ?? ''}${delta}`;
            break;
          }
          case 'response.mcp_call_arguments.done': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const args = await requireEventString(event.arguments, event.type, 'arguments');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'mcp_call',
              'MCP Tool Call',
            );
            existing.detail = args;
            await emitNativeToolCall(existing, 'added');
            break;
          }
          case 'response.mcp_list_tools.in_progress':
          case 'response.mcp_list_tools.failed':
          case 'response.mcp_list_tools.completed': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'mcp_list_tools',
              'MCP Tool Discovery',
            );
            existing.status =
              event.type === 'response.mcp_list_tools.in_progress'
                ? 'in_progress'
                : event.type === 'response.mcp_list_tools.failed'
                  ? 'failed'
                  : 'completed';
            await emitNativeToolCall(
              existing,
              event.type === 'response.mcp_list_tools.completed' ? 'done' : 'added',
            );
            break;
          }
          case 'response.custom_tool_call_input.delta': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const delta = await requireEventString(event.delta, event.type, 'delta');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'custom_tool_call',
              'Custom Tool Call',
            );
            existing.detail = `${existing.detail ?? ''}${delta}`;
            break;
          }
          case 'response.custom_tool_call_input.done': {
            const itemId = await requireNonEmptyEventItemId(event.item_id, event.type);
            const input = await requireEventString(event.input, event.type, 'input');
            const existing = await claimNativeToolStateByEventItemId(
              itemId,
              'custom_tool_call',
              'Custom Tool Call',
            );
            existing.detail = input;
            await emitNativeToolCall(existing, 'added');
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
        throw new LlmStreamErrorEmittedError({
          detail,
          i18nStopReason: buildHumanSystemStopReasonTextI18n({
            detail,
            kind: 'incomplete_tool_call_stream',
          }),
        });
      }
    } catch (error: unknown) {
      const annotatedError = maybeAnnotateOpenAiQuirkFailure(providerConfig, error);
      log.warn('OPENAI streaming error', annotatedError);
      throw annotatedError;
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
    requestContext: LlmRequestContext,
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

    const outputs: LlmBatchOutput[] = [];
    const requestInput: ResponseInputItem[] = await buildOpenAiRequestInput(
      context,
      requestContext,
      providerConfig,
      async (ingest) => {
        outputs.push({ kind: 'tool_result_image_ingest', ingest });
      },
      async (ingest) => {
        outputs.push({ kind: 'user_image_ingest', ingest });
      },
    );
    const openAiParams = agent.model_params?.openai || {};
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
    outputs.push(...openAiResponseToBatchOutputs(response, genseq));

    return {
      messages: outputs
        .filter(
          (entry): entry is Extract<LlmBatchOutput, { kind: 'message' }> =>
            entry.kind === 'message',
        )
        .map((entry) => entry.message),
      outputs,
      usage,
      llmGenModel: returnedModel,
    };
  }
}
