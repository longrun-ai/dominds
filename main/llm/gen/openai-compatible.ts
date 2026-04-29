/**
 * Module: llm/gen/openai-compatible
 *
 * OpenAI Chat Completions compatible integration implementing streaming and batch generation.
 *
 * Rationale:
 * - Many "OpenAI-compatible" providers implement the Chat Completions API but not the newer
 *   Responses API. Dominds' `apiType: openai` uses the Responses API; this generator targets
 *   chat-completions-only providers (e.g. Volcano Engine Ark `.../api/v3`).
 * - Isolation principle: this wrapper owns the `model_params.openai-compatible.*` namespace and
 *   must not inherit OpenAI Responses or Codex-specific request meanings.
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

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
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
  OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/openai-compatible');

type ChatCompletionMessageWithReasoning = ChatCompletionMessageParam & {
  reasoning_content?: string;
};

function limitOpenAiCompatibleToolOutputText(
  text: string,
  msg: FuncResultMsg,
  limitChars: number,
): string {
  const limited = truncateProviderToolOutputText(text, limitChars);
  if (limited.truncated) {
    log.warn('OPENAI-COMPATIBLE tool output truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalChars: limited.originalChars,
      limitChars: limited.limitChars,
    });
  }
  return limited.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLlmRequestContext(value: unknown): value is LlmRequestContext {
  return (
    isRecord(value) &&
    typeof value.dialogSelfId === 'string' &&
    typeof value.dialogRootId === 'string' &&
    typeof value.providerKey === 'string' &&
    typeof value.modelKey === 'string'
  );
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

function buildChatCompletionResponseFormat(
  openAiParams: NonNullable<Team.ModelParams['openai']>,
): ChatCompletionCreateParamsStreaming['response_format'] | undefined {
  const textFormat = openAiParams.text_format;
  if (textFormat === 'text' || textFormat === 'json_object') {
    return { type: textFormat };
  }
  if (textFormat !== 'json_schema') return undefined;

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

  return {
    type: 'json_schema',
    json_schema: {
      name: schemaName,
      schema: parsedSchema,
      ...(openAiParams.text_format_json_schema_strict !== undefined
        ? { strict: openAiParams.text_format_json_schema_strict }
        : {}),
    },
  };
}

function buildReasoningPayloadFromText(text: string): ReasoningPayload | undefined {
  if (text.trim().length === 0) return undefined;
  return {
    summary: [{ type: 'summary_text', text }],
  };
}

function extractThinkingReasoningText(msg: Extract<ChatMessage, { type: 'thinking_msg' }>): string {
  const fromSummary = msg.reasoning?.summary.map((part) => part.text).join('') ?? '';
  const fromContent = msg.reasoning?.content?.map((part) => part.text).join('') ?? '';
  const combined = `${fromSummary}${fromContent}`;
  return combined.length > 0 ? combined : msg.content;
}

function extractReasoningContentField(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const content = value.reasoning_content;
  if (typeof content !== 'string') return undefined;
  return content.length > 0 ? content : undefined;
}

function attachReasoningContent(
  message: ChatCompletionMessageParam,
  reasoningContent: string | undefined,
): ChatCompletionMessageParam {
  if (!reasoningContent) return message;
  if (!isRecord(message) || message.role !== 'assistant') return message;
  return {
    ...message,
    reasoning_content: reasoningContent,
  } as ChatCompletionMessageWithReasoning;
}

function resolveOpenAiCompatibleReasoningContentMode(
  providerConfig: ProviderConfig,
  agent: Team.Member,
): boolean {
  const model = (agent.model ?? '').toLowerCase();
  if (model.includes('deepseek-reasoner')) return true;
  const baseUrl = providerConfig.baseUrl.toLowerCase();
  return baseUrl.includes('deepseek.com') && model.includes('reasoner');
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
    case 'tellask_carryover_msg':
      return { role: 'user', content: msg.content };
    case 'transient_guide_msg':
    case 'saying_msg':
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

async function userLikeMessageToChatCompletionMessageWithImages(
  msg: Extract<
    ChatMessage,
    { type: 'prompting_msg' | 'tellask_result_msg' | 'tellask_carryover_msg' }
  >,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ChatCompletionMessageParam> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToChatCompletionMessage(msg);
  }

  const content: ChatCompletionContentPart[] = [{ type: 'text', text: msg.content }];
  const supportsImageInput = resolveModelImageInputSupport(
    requestContext.modelKey === undefined
      ? undefined
      : providerConfig?.models[requestContext.modelKey],
    false,
  );
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      content.push({ type: 'text', text: item.text });
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
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
                budgetBytes: OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({
          type: 'text',
          text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image missing: ${item.artifact.relPath}]` });
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
              providerPathLabel: 'OpenAI-compatible Chat Completions path',
            }),
          );
        }
        content.push({ type: 'text', text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onUserImageIngest) {
        await onUserImageIngest(
          buildUserImageIngest({
            requestContext,
            ...(msg.type === 'prompting_msg' ? { msgId: msg.msgId } : {}),
            artifact: item.artifact,
            disposition: 'fed_provider_transformed',
            providerPathLabel: 'OpenAI-compatible Chat Completions path',
          }),
        );
      }
      content.push({
        type: 'image_url',
        image_url: {
          url: bytesToDataUrl({ mimeType: item.mimeType, bytes: bytesResult.bytes }),
          detail: 'auto',
        },
      });
      continue;
    }
    const _exhaustive: never = item;
    throw new Error(`Unsupported user content item: ${String(_exhaustive)}`);
  }

  return { role: 'user', content };
}

async function funcResultToChatCompletionMessages(
  msg: FuncResultMsg,
  limitChars: number,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<ChatCompletionMessageParam[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return [
      {
        role: 'tool',
        tool_call_id: msg.id,
        content: limitOpenAiCompatibleToolOutputText(msg.content, msg, limitChars),
      },
    ];
  }

  const out: ChatCompletionMessageParam[] = [];
  out.push({
    role: 'tool',
    tool_call_id: msg.id,
    content: limitOpenAiCompatibleToolOutputText(msg.content, msg, limitChars),
  });

  const parts: ChatCompletionContentPart[] = [];
  let sawImageUrl = false;
  let sawAnyImage = false;

  parts.push({
    type: 'text',
    text: `Tool output images (${msg.name}, call_id=${msg.id}):`,
  });

  const modelKey =
    typeof requestContext.modelKey === 'string' ? requestContext.modelKey.trim() : '';
  const modelInfo =
    modelKey.length > 0 && providerConfig ? providerConfig.models[modelKey] : undefined;
  const supportsImageInput = resolveModelImageInputSupport(modelInfo, false);
  const imageUnsupportedDisposition =
    modelInfo?.['supports_image_input'] === false
      ? 'filtered_model_unsupported'
      : 'filtered_provider_unsupported';

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') continue;

    if (item.type === 'input_image') {
      sawAnyImage = true;
      if (!supportsImageInput) {
        if (onToolResultImageIngest) {
          await onToolResultImageIngest(
            buildToolResultImageIngest({
              requestContext,
              toolCallId: msg.id,
              toolName: msg.name,
              artifact: item.artifact,
              disposition: imageUnsupportedDisposition,
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image not sent: current openai-compatible image input is disabled for model=${typeof requestContext.modelKey === 'string' && requestContext.modelKey.trim().length > 0 ? requestContext.modelKey.trim() : 'unknown'}]`,
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
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
                budgetBytes: OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
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
              providerPathLabel: 'OpenAI-compatible path',
            }),
          );
        }
        parts.push({
          type: 'text',
          text: `[image unreadable: ${item.artifact.relPath}]`,
        });
        continue;
      }
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: msg.id,
            toolName: msg.name,
            artifact: item.artifact,
            disposition: 'fed_provider_transformed',
            providerPathLabel: 'OpenAI-compatible path',
          }),
        );
      }
      const bytes = bytesResult.bytes;
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
    const hasReasoningContent =
      'reasoning_content' in item && typeof item.reasoning_content === 'string';
    if (
      (role !== 'user' && role !== 'assistant' && role !== 'system') ||
      typeof content !== 'string' ||
      hasToolCalls ||
      hasReasoningContent
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
      !('tool_calls' in prev && Array.isArray(prev.tool_calls)) &&
      !('reasoning_content' in prev && typeof prev.reasoning_content === 'string')
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
  requestContext: LlmRequestContext,
  options?: {
    reasoningContentMode?: boolean;
    providerConfig?: ProviderConfig;
    onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>;
    onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>;
  },
): Promise<ChatCompletionMessageParam[]> {
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(
      violation,
      'OPENAI-COMPATIBLE provider projection',
    );
    log.error(detail, new Error('openai_compatible_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const input: ChatCompletionMessageParam[] = [];
  const reasoningContentMode = options?.reasoningContentMode === true;
  const toolResultMaxChars = resolveProviderToolResultMaxChars(options?.providerConfig);
  const allowedImageKeys = selectLatestImagesWithinBudget(
    normalized,
    OPENAI_COMPATIBLE_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  );
  let pendingReasoningContent: string | undefined;

  const takePendingReasoningContent = (): string | undefined => {
    const current = pendingReasoningContent;
    pendingReasoningContent = undefined;
    return current;
  };

  const appendReasoningContent = (value: string): void => {
    if (value.length === 0) return;
    pendingReasoningContent =
      pendingReasoningContent && pendingReasoningContent.length > 0
        ? `${pendingReasoningContent}\n${value}`
        : value;
  };

  const flushPendingReasoningAsAssistantMessage = (): void => {
    const reasoningContent = takePendingReasoningContent();
    if (!reasoningContent) return;
    input.push(
      attachReasoningContent(
        {
          role: 'assistant',
          content: '',
        },
        reasoningContent,
      ),
    );
  };

  if (systemPrompt.trim().length > 0) {
    input.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const msg of normalized) {
    if (msg.type === 'thinking_msg' && reasoningContentMode) {
      appendReasoningContent(extractThinkingReasoningText(msg));
      continue;
    }

    if (msg.type === 'func_call_msg') {
      const mapped = chatMessageToChatCompletionMessage(msg);
      input.push(attachReasoningContent(mapped, takePendingReasoningContent()));
      continue;
    }

    if (msg.type === 'func_result_msg') {
      flushPendingReasoningAsAssistantMessage();
      input.push(
        ...(await funcResultToChatCompletionMessages(
          msg,
          toolResultMaxChars,
          requestContext,
          options?.providerConfig,
          allowedImageKeys,
          options?.onToolResultImageIngest,
        )),
      );
      continue;
    }

    const mapped =
      (msg.type === 'prompting_msg' ||
        msg.type === 'tellask_result_msg' ||
        msg.type === 'tellask_carryover_msg') &&
      Array.isArray(msg.contentItems) &&
      msg.contentItems.length > 0
        ? await userLikeMessageToChatCompletionMessageWithImages(
            msg,
            requestContext,
            options?.providerConfig,
            allowedImageKeys,
            options?.onUserImageIngest,
          )
        : chatMessageToChatCompletionMessage(msg);
    input.push(attachReasoningContent(mapped, takePendingReasoningContent()));
  }

  flushPendingReasoningAsAssistantMessage();

  return mergeAdjacentMessages(input);
}

export async function buildOpenAiCompatibleRequestMessagesWrapper(
  systemPrompt: string,
  context: ChatMessage[],
  requestContextOrOptions?:
    | LlmRequestContext
    | { reasoningContentMode?: boolean; providerConfig?: ProviderConfig },
  optionsMaybe?: { reasoningContentMode?: boolean; providerConfig?: ProviderConfig },
): Promise<ChatCompletionMessageParam[]> {
  const requestContext = isLlmRequestContext(requestContextOrOptions)
    ? requestContextOrOptions
    : {
        dialogSelfId: '',
        dialogRootId: '',
        providerKey: 'openai-compatible',
        modelKey: 'unknown',
      };
  const options = isLlmRequestContext(requestContextOrOptions)
    ? optionsMaybe
    : requestContextOrOptions;
  return await buildChatCompletionMessages(systemPrompt, context, requestContext, options);
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

  const reasoningContent = extractReasoningContentField(msg as unknown);
  if (reasoningContent && reasoningContent.length > 0) {
    out.push({
      type: 'thinking_msg',
      role: 'assistant',
      genseq,
      content: reasoningContent,
      reasoning: buildReasoningPayloadFromText(reasoningContent),
    });
  }

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
    genseq: number,
    abortSignal?: AbortSignal,
  ): Promise<LlmStreamResult> {
    const apiKey = process.env[providerConfig.apiKeyEnvVar];
    if (!apiKey) throw new Error(`Missing API key env var ${providerConfig.apiKeyEnvVar}`);

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }

    const client = new OpenAI({ apiKey, baseURL: providerConfig.baseUrl });

    const reasoningContentMode = resolveOpenAiCompatibleReasoningContentMode(providerConfig, agent);
    const messages = await buildChatCompletionMessages(systemPrompt, context, requestContext, {
      reasoningContentMode,
      providerConfig,
      onToolResultImageIngest: receiver.toolResultImageIngest,
      onUserImageIngest: receiver.userImageIngest,
    });

    const openAiParams = agent.model_params?.['openai-compatible'] || {};
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;
    const responseFormat = buildChatCompletionResponseFormat(openAiParams);

    const payload: ChatCompletionCreateParamsStreaming = {
      model: agent.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(openAiParams.service_tier !== undefined && { service_tier: openAiParams.service_tier }),
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(responseFormat !== undefined && { response_format: responseFormat }),
      ...(funcTools.length > 0
        ? { tools: funcTools.map(funcToolToChatCompletionTool), tool_choice: 'auto' as const }
        : { tool_choice: 'none' as const }),
      parallel_tool_calls: parallelToolCalls,
    };

    let sayingStarted = false;
    let thinkingStarted = false;
    let currentThinkingContent = '';
    type ActiveStream = 'idle' | 'thinking' | 'saying';
    let activeStream: ActiveStream = 'idle';
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
        const reasoningDelta = extractReasoningContentField(delta as unknown);
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          if (activeStream === 'saying') {
            const detail =
              'OPENAI-COMPATIBLE stream overlap violation: received reasoning while saying stream still active';
            log.error(detail, new Error('openai_compatible_stream_overlap_violation'));
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
          currentThinkingContent += reasoningDelta;
          await receiver.thinkingChunk(reasoningDelta);
        }

        const content = delta.content;
        if (typeof content === 'string' && content.length > 0) {
          if (activeStream === 'thinking') {
            const detail =
              'OPENAI-COMPATIBLE stream overlap violation: received output text while thinking stream still active';
            log.error(detail, new Error('openai_compatible_stream_overlap_violation'));
            if (receiver.streamError) {
              await receiver.streamError(detail);
            }
            if (thinkingStarted) {
              await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
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
          await receiver.sayingChunk(content);
        }

        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const rawIndex: unknown = call.index;
            if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0) {
              const detail = `OPENAI-COMPATIBLE invalid tool call index: ${JSON.stringify(rawIndex)}`;
              log.error(detail, new Error('openai_compatible_invalid_tool_call_index'));
              if (receiver.streamError) {
                await receiver.streamError(detail);
              }
              throw new LlmStreamErrorEmittedError({
                detail,
                i18nStopReason: buildHumanSystemStopReasonTextI18n({
                  detail,
                  kind: 'invalid_tool_call',
                }),
              });
            }
            const index = rawIndex;
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
          for (const state of activeCallsByIndex.values()) {
            await maybeEmitFuncCall(state, receiver, genseq);
          }
        }

        if (
          choice.finish_reason === 'stop' ||
          choice.finish_reason === 'length' ||
          choice.finish_reason === 'content_filter'
        ) {
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
      if (thinkingStarted) {
        await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
      }
      if (sayingStarted) await receiver.sayingFinish();
    }

    return { usage, ...(returnedModel ? { llmGenModel: returnedModel } : {}) };
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
    const reasoningContentMode = resolveOpenAiCompatibleReasoningContentMode(providerConfig, agent);
    const outputs: LlmBatchOutput[] = [];
    const messages = await buildChatCompletionMessages(systemPrompt, context, requestContext, {
      reasoningContentMode,
      providerConfig,
      onToolResultImageIngest: async (ingest) => {
        outputs.push({ kind: 'tool_result_image_ingest', ingest });
      },
      onUserImageIngest: async (ingest) => {
        outputs.push({ kind: 'user_image_ingest', ingest });
      },
    });

    const openAiParams = agent.model_params?.['openai-compatible'] || {};
    const parallelToolCalls = openAiParams.parallel_tool_calls ?? true;
    const responseFormat = buildChatCompletionResponseFormat(openAiParams);

    const payload: ChatCompletionCreateParamsNonStreaming = {
      model: agent.model,
      messages,
      ...(openAiParams.safety_identifier !== undefined && {
        safety_identifier: openAiParams.safety_identifier,
      }),
      ...(openAiParams.temperature !== undefined && { temperature: openAiParams.temperature }),
      ...(openAiParams.top_p !== undefined && { top_p: openAiParams.top_p }),
      ...(responseFormat !== undefined && { response_format: responseFormat }),
      ...(funcTools.length > 0 && { tools: funcTools.map(funcToolToChatCompletionTool) }),
      tool_choice: 'auto',
      parallel_tool_calls: parallelToolCalls,
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
        ...(outputs.length > 0 ? { outputs } : {}),
        usage,
        ...(model ? { llmGenModel: model } : {}),
      };
    } catch (error: unknown) {
      log.warn('OPENAI-COMPATIBLE batch error', error);
      throw error;
    }
  }
}
