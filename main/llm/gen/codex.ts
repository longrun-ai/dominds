/**
 * Module: llm/gen/codex
 *
 * ChatGPT Codex responses integration (streaming-only).
 * Isolation principle: this wrapper owns Codex-native request/stream semantics and must not reuse
 * OpenAI Responses parameter namespaces or event interpretations.
 */
import type {
  ChatGptEventReceiver,
  ChatGptFunctionCallOutputContentItem,
  ChatGptFunctionTool,
  ChatGptMessageItem,
  ChatGptMessageRole,
  ChatGptReasoningItem,
  ChatGptResponseItem,
  ChatGptResponsesRequest,
  ChatGptResponsesStreamEvent,
  ChatGptTextControls,
  ChatGptTool,
  ChatGptWebSearchCallItem,
  ChatGptWebSearchTool,
} from '@longrun-ai/codex-auth';
import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';
import { createLogger } from '../../log';
import { getTextForLanguage } from '../../runtime/i18n-text';
import { getWorkLanguage } from '../../runtime/work-language';
import type { Team } from '../../team';
import type { FuncTool } from '../../tool';
import type { ChatMessage, FuncResultMsg, ProviderConfig } from '../client';
import type {
  CodexLlmWebSearchCall,
  LlmBatchResult,
  LlmFailureDisposition,
  LlmGenerator,
  LlmRequestContext,
  LlmStreamReceiver,
  LlmStreamResult,
  ToolResultImageIngest,
  UserImageIngest,
} from '../gen';
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
  CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
  readToolResultImageBytesSafe,
  resolveModelImageInputSupport,
  selectLatestImagesWithinBudget,
} from './tool-result-image-ingest';

const log = createLogger('llm/codex');
const codexFallbackInstructions = 'You are Codex CLI.';

export function resolveCodexServiceTier(
  serviceTier: ChatGptResponsesRequest['service_tier'] | undefined,
): Exclude<NonNullable<ChatGptResponsesRequest['service_tier']>, 'default'> | undefined {
  // The ChatGPT codex backend rejects the literal `default` tier even though some SDK typings
  // still list it. Omitting the field preserves the standard tier semantics without a 400.
  if (serviceTier === undefined || serviceTier === null || serviceTier === 'default') {
    return undefined;
  }
  return serviceTier;
}

function limitCodexToolOutputText(text: string, msg: FuncResultMsg, limitChars: number): string {
  const limited = truncateProviderToolOutputText(text, limitChars);
  if (limited.truncated) {
    log.warn('CODEX tool output truncated before provider request', undefined, {
      callId: msg.id,
      toolName: msg.name,
      originalChars: limited.originalChars,
      limitChars: limited.limitChars,
    });
  }
  return limited.text;
}

function limitCodexToolOutputItems(
  output: ChatGptFunctionCallOutputContentItem[],
  msg: FuncResultMsg,
  limitChars: number,
): ChatGptFunctionCallOutputContentItem[] {
  let remainingChars = limitChars;
  let truncated = false;
  const limited: ChatGptFunctionCallOutputContentItem[] = [];

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
    log.warn('CODEX tool output items truncated before provider request', undefined, {
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

export function resolveCodexInstructions(systemPrompt: string): string {
  return systemPrompt.trim().length > 0 ? systemPrompt : codexFallbackInstructions;
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

type CodexWebSearchMode = 'disabled' | 'cached' | 'live';
const CODEX_JSON_RESPONSE_FORMAT_NAME = 'dominds_json_response';
const CODEX_JSON_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

function resolveCodexWebSearchMode(agent: Team.Member): CodexWebSearchMode {
  return agent.model_params?.codex?.web_search ?? 'live';
}

function resolveCodexJsonResponseEnabled(agent: Team.Member): boolean {
  const providerSpecific = agent.model_params?.codex?.json_response;
  if (providerSpecific !== undefined) return providerSpecific;
  return agent.model_params?.json_response === true;
}

function buildCodexNativeTools(agent: Team.Member): ChatGptTool[] {
  const webSearchMode = resolveCodexWebSearchMode(agent);
  if (webSearchMode === 'disabled') return [];

  const webSearchTool: ChatGptWebSearchTool = {
    type: 'web_search',
    external_web_access: webSearchMode === 'live',
  };
  return [webSearchTool];
}

function buildCodexTextControls(agent: Team.Member): ChatGptTextControls | undefined {
  // Provider isolation rule: the Codex wrapper only consumes `model_params.codex.*`.
  const codexParams = agent.model_params?.codex;
  const text: ChatGptTextControls = {};
  if (codexParams && codexParams.verbosity) {
    text.verbosity = codexParams.verbosity;
  }
  if (resolveCodexJsonResponseEnabled(agent)) {
    text.format = {
      type: 'json_schema',
      name: CODEX_JSON_RESPONSE_FORMAT_NAME,
      strict: true,
      schema: CODEX_JSON_RESPONSE_SCHEMA,
    };
  }
  return Object.keys(text).length > 0 ? text : undefined;
}

function buildCodexReasoning(agent: Team.Member): ChatGptResponsesRequest['reasoning'] | null {
  // Provider isolation rule: do not borrow OpenAI Responses params inside the Codex wrapper.
  const codexParams = agent.model_params?.codex;
  if (codexParams?.reasoning_effort === undefined && codexParams?.reasoning_summary === undefined) {
    return null;
  }

  return {
    ...(codexParams?.reasoning_effort !== undefined
      ? { effort: codexParams.reasoning_effort }
      : {}),
    ...(codexParams?.reasoning_summary !== undefined
      ? { summary: codexParams.reasoning_summary }
      : { summary: 'auto' }),
  };
}

function assertNoCodexNativeToolCollisions(
  funcTools: FuncTool[],
  nativeTools: ChatGptTool[],
): void {
  const names = new Set<string>();
  for (const t of funcTools) {
    names.add(t.name);
  }

  for (const nativeTool of nativeTools) {
    if (nativeTool.type !== 'web_search' && nativeTool.type !== 'local_shell') {
      continue;
    }
    const nativeName = nativeTool.type;
    if (names.has(nativeName)) {
      throw new Error(
        `Codex native tool name collision: function tool '${nativeName}' conflicts with native '${nativeName}' tool.`,
      );
    }
  }
}

function toLlmWebSearchCall(
  item: ChatGptWebSearchCallItem,
  itemId: string,
  phase: 'added' | 'done',
): CodexLlmWebSearchCall {
  return {
    source: 'codex',
    phase,
    itemId,
    status: item.status,
    action: item.action,
  };
}

function tryGetWebSearchCallItemId(item: ChatGptWebSearchCallItem): string | null {
  const raw = typeof item.id === 'string' ? item.id.trim() : '';
  return raw.length > 0 ? raw : null;
}

function extractReasoningText(item: ChatGptReasoningItem): string {
  const reasoning = extractReasoningPayload(item);
  let text = '';
  for (const part of reasoning.summary) {
    text += part.text;
  }
  for (const part of reasoning.content ?? []) {
    text += part.text;
  }
  return text;
}

function extractReasoningPayload(item: ChatGptReasoningItem): ReasoningPayload {
  const summary: ReasoningPayload['summary'] = [];
  for (const part of item.summary) {
    summary.push({ type: 'summary_text', text: part.text });
  }
  const content = item.content?.map((part) => ({ type: part.type, text: part.text }));
  const encrypted =
    typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
      ? item.encrypted_content
      : undefined;
  const reasoning: ReasoningPayload = { summary };
  if (content && content.length > 0) reasoning.content = content;
  if (encrypted) reasoning.encrypted_content = encrypted;
  return reasoning;
}

function buildReasoningPayloadFromText(text: string): ReasoningPayload | undefined {
  if (text.trim().length === 0) return undefined;
  return {
    summary: [{ type: 'summary_text', text }],
  };
}

function thinkingMessageToCodexReasoningItem(
  msg: Extract<ChatMessage, { type: 'thinking_msg' }>,
): ChatGptReasoningItem {
  const reasoning = msg.reasoning ?? buildReasoningPayloadFromText(msg.content);
  if (!reasoning) {
    return { type: 'reasoning', summary: [] };
  }
  return {
    type: 'reasoning',
    summary: reasoning.summary.map((part) => ({ type: 'summary_text', text: part.text })),
    ...(reasoning.content ? { content: reasoning.content.map((part) => ({ ...part })) } : {}),
    ...(reasoning.encrypted_content ? { encrypted_content: reasoning.encrypted_content } : {}),
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
      return [messageItem('assistant', msg.content)];
    case 'thinking_msg':
      return [thinkingMessageToCodexReasoningItem(msg)];
    case 'tellask_result_msg':
    case 'tellask_carryover_msg':
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

async function userLikeMessageToCodexItemsWithImages(
  msg: Extract<
    ChatMessage,
    { type: 'prompting_msg' | 'tellask_result_msg' | 'tellask_carryover_msg' }
  >,
  requestContext: LlmRequestContext,
  providerConfig: ProviderConfig | undefined,
  allowedImageKeys: ReadonlySet<string>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ChatGptResponseItem[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return chatMessageToCodexItems(msg);
  }

  const content: Array<
    { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }
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
              providerPathLabel: 'Codex Responses path',
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
              providerPathLabel: 'Codex Responses path',
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
                budgetBytes: CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'Codex Responses path',
            }),
          );
        }
        content.push({
          type: 'input_text',
          text: `[image not sent: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'Codex Responses path',
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
              providerPathLabel: 'Codex Responses path',
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
            providerPathLabel: 'Codex Responses path',
          }),
        );
      }
      content.push({
        type: 'input_image',
        image_url: bytesToDataUrl({ mimeType: item.mimeType, bytes: bytesResult.bytes }),
      });
      continue;
    }
    const _exhaustive: never = item;
    throw new Error(`Unsupported user content item: ${String(_exhaustive)}`);
  }

  return [
    {
      type: 'message',
      role: 'user',
      content,
    } as ChatGptResponseItem,
  ];
}

async function buildCodexFunctionCallOutput(
  msg: FuncResultMsg,
  limitChars: number,
  requestContext: LlmRequestContext,
  allowedImageKeys: ReadonlySet<string>,
  supportsImageInput: boolean,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
): Promise<string | ChatGptFunctionCallOutputContentItem[]> {
  const items = msg.contentItems;
  if (!Array.isArray(items) || items.length === 0) {
    return limitCodexToolOutputText(msg.content, msg, limitChars);
  }

  const out: ChatGptFunctionCallOutputContentItem[] = [];
  for (const [itemIndex, item] of items.entries()) {
    if (item.type === 'input_text') {
      out.push({ type: 'input_text', text: item.text });
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
              providerPathLabel: 'Codex path',
            }),
          );
        }
        out.push({
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
              providerPathLabel: 'Codex path',
            }),
          );
        }
        out.push({
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
                budgetBytes: CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
              }),
              providerPathLabel: 'Codex path',
            }),
          );
        }
        out.push({
          type: 'input_text',
          text: `[image omitted: request image budget exceeded bytes=${String(item.byteLength)} budget=${String(
            CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
              providerPathLabel: 'Codex path',
            }),
          );
        }
        out.push({ type: 'input_text', text: `[image missing: ${item.artifact.relPath}]` });
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
              providerPathLabel: 'Codex path',
            }),
          );
        }
        out.push({ type: 'input_text', text: `[image unreadable: ${item.artifact.relPath}]` });
        continue;
      }
      if (onToolResultImageIngest) {
        await onToolResultImageIngest(
          buildToolResultImageIngest({
            requestContext,
            toolCallId: msg.id,
            toolName: msg.name,
            artifact: item.artifact,
            disposition: 'fed_native',
            providerPathLabel: 'Codex path',
          }),
        );
      }
      const bytes = bytesResult.bytes;
      out.push({
        type: 'input_image',
        image_url: bytesToDataUrl({ mimeType: item.mimeType, bytes }),
      });
      continue;
    }

    const _exhaustive: never = item;
    out.push({ type: 'input_text', text: `[unknown content item: ${String(_exhaustive)}]` });
  }

  return out.length > 0
    ? limitCodexToolOutputItems(out, msg, limitChars)
    : limitCodexToolOutputText(msg.content, msg, limitChars);
}

async function buildCodexInput(
  context: ChatMessage[],
  requestContext: LlmRequestContext,
  providerConfig?: ProviderConfig,
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ChatGptResponseItem[]> {
  const normalized = normalizeToolCallPairs(context);
  const violation = findFirstToolCallAdjacencyViolation(normalized);
  if (violation) {
    const detail = formatToolCallAdjacencyViolation(violation, 'CODEX provider projection');
    log.error(detail, new Error('codex_tool_call_adjacency_violation'), {
      callId: violation.callId,
      toolName: violation.toolName,
      violationKind: violation.kind,
      index: violation.index,
    });
    throw new Error(detail);
  }
  const input: ChatGptResponseItem[] = [];
  const toolResultMaxChars = resolveProviderToolResultMaxChars(providerConfig);
  const allowedImageKeys = selectLatestImagesWithinBudget(
    normalized,
    CODEX_TOOL_RESULT_IMAGE_BUDGET_BYTES,
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
        ...(await userLikeMessageToCodexItemsWithImages(
          msg,
          requestContext,
          providerConfig,
          allowedImageKeys,
          onUserImageIngest,
        )),
      );
      continue;
    }

    if (msg.type === 'func_call_msg') {
      input.push({
        type: 'function_call',
        name: msg.name,
        arguments: msg.arguments,
        call_id: msg.id,
      });
      continue;
    }

    if (msg.type === 'func_result_msg') {
      input.push({
        type: 'function_call_output',
        call_id: msg.id,
        output: await buildCodexFunctionCallOutput(
          msg,
          toolResultMaxChars,
          requestContext,
          allowedImageKeys,
          supportsImageInput,
          onToolResultImageIngest,
        ),
      });
      continue;
    }

    const items = chatMessageToCodexItems(msg);
    for (const item of items) {
      input.push(item);
    }
  }

  return input;
}

async function buildCodexRequest(
  providerConfig: ProviderConfig,
  agent: Team.Member,
  instructions: string,
  funcTools: FuncTool[],
  requestContext: LlmRequestContext,
  context: ChatMessage[],
  onToolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>,
  onUserImageIngest?: (ingest: UserImageIngest) => Promise<void>,
): Promise<ChatGptResponsesRequest> {
  if (!agent.model) {
    throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
  }

  const input = await buildCodexInput(
    context,
    requestContext,
    providerConfig,
    onToolResultImageIngest,
    onUserImageIngest,
  );

  // Provider isolation rule: request construction must only read Codex-native params here.
  const codexParams = agent.model_params?.codex;
  const parallelToolCalls = codexParams?.parallel_tool_calls ?? true;
  const reasoning = buildCodexReasoning(agent);
  const include: ChatGptResponsesRequest['include'] =
    reasoning !== null ? ['reasoning.encrypted_content'] : [];
  const serviceTier = resolveCodexServiceTier(codexParams?.service_tier);
  const text = buildCodexTextControls(agent);
  const nativeTools = buildCodexNativeTools(agent);
  assertNoCodexNativeToolCollisions(funcTools, nativeTools);
  const tools: ChatGptTool[] = [...funcTools.map(funcToolToCodex), ...nativeTools];

  return {
    model: agent.model,
    instructions,
    input,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: parallelToolCalls,
    reasoning,
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
    store: false,
    stream: true,
    include,
    ...(requestContext.promptCacheKey !== undefined &&
    requestContext.promptCacheKey.trim().length > 0
      ? { prompt_cache_key: requestContext.promptCacheKey }
      : {}),
    text,
  };
}

export class CodexGen implements LlmGenerator {
  get apiType(): string {
    return 'codex';
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
    const codexHomeValue: string = process.env[providerConfig.apiKeyEnvVar] || '~/.codex';
    const codexHome = codexHomeValue.startsWith('~')
      ? process.env['HOME'] + codexHomeValue.substring(1)
      : codexHomeValue;
    // NOTE: `@longrun-ai/codex-auth` is an ESM package (`"type": "module"`). The Dominds backend is
    // compiled as CommonJS, so Node.js requires a dynamic `import()` for runtime access here.
    const codexAuth: typeof import('@longrun-ai/codex-auth') =
      await import('@longrun-ai/codex-auth');
    const authPreparation = codexAuth.prepareCodexFileAuth({
      codexHome,
      codexHomeEnvVar: providerConfig.apiKeyEnvVar,
      providerName: `Dominds codex provider '${providerConfig.name}'`,
    });
    if (authPreparation.kind === 'action_required') {
      throw new Error(codexAuth.formatCodexFileAuthActionRequired(authPreparation));
    }
    if (authPreparation.changedConfigToFile) {
      log.info(
        'Codex CLI auth storage switched to file mode for Dominds codex provider',
        undefined,
        {
          codexHome: authPreparation.codexHome,
          configPath: authPreparation.configPath,
          previousStoreMode: authPreparation.previousStoreMode,
        },
      );
    }
    const manager = new codexAuth.AuthManager({ codexHome });
    const client = await codexAuth.createChatGptClientFromManager(manager, {
      baseUrl: providerConfig.baseUrl,
    });

    if (!agent.model) {
      throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
    }
    const instructions = resolveCodexInstructions(systemPrompt);
    const payload = await buildCodexRequest(
      providerConfig,
      agent,
      instructions,
      funcTools,
      requestContext,
      context,
      receiver.toolResultImageIngest,
      receiver.userImageIngest,
    );

    let sayingStarted = false;
    let thinkingStarted = false;
    let sawOutputText = false;
    type ActiveStream = 'idle' | 'thinking' | 'saying';
    let activeStream: ActiveStream = 'idle';
    let usage: LlmUsageStats = { kind: 'unavailable' };
    let returnedModel: string | undefined;
    const streamedReasoningItemIds = new Set<string>();
    let sawReasoningDeltaWithoutItemId = false;
    let currentThinkingContent = '';

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
                const detail =
                  'CODEX stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('codex_stream_overlap_violation'));
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
            return;
          }
          case 'response.output_text.done': {
            if (!sawOutputText && event.text.length > 0) {
              if (activeStream === 'thinking') {
                const detail =
                  'CODEX stream overlap violation: received output_text while thinking stream still active';
                log.error(detail, new Error('codex_stream_overlap_violation'));
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
              if (typeof event.item_id === 'string' && event.item_id.length > 0) {
                streamedReasoningItemIds.add(event.item_id);
              } else {
                sawReasoningDeltaWithoutItemId = true;
              }
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
                currentThinkingContent = '';
                await receiver.thinkingStart();
                activeStream = 'thinking';
              }
              currentThinkingContent += delta;
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
              currentThinkingContent = '';
              await receiver.thinkingStart();
              activeStream = 'thinking';
            }
            return;
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
            return;
          }
          case 'response.output_item.added':
            if (event.item.type === 'web_search_call' && receiver.webSearchCall) {
              const itemId = tryGetWebSearchCallItemId(event.item);
              if (!itemId) {
                const detail =
                  'Non-fatal LLM error: invalid web_search_call (missing itemId); dropping event';
                log.error(detail, new Error('codex_web_search_call_missing_item_id'), {
                  status: event.item.status,
                  action: event.item.action,
                });
                if (receiver.streamError) {
                  await receiver.streamError(detail);
                }
                return;
              }
              await receiver.webSearchCall(toLlmWebSearchCall(event.item, itemId, 'added'));
            }
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
                }
                return;
              }
              case 'reasoning': {
                const payloadFromItem = extractReasoningPayload(event.item);
                const itemId =
                  typeof event.item.id === 'string' && event.item.id.length > 0
                    ? event.item.id
                    : null;
                const sawReasoningDelta =
                  itemId !== null
                    ? streamedReasoningItemIds.has(itemId)
                    : sawReasoningDeltaWithoutItemId;
                if (!sawReasoningDelta) {
                  const text = extractReasoningText(event.item);
                  if (text.length > 0) {
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
                      currentThinkingContent = '';
                      await receiver.thinkingStart();
                      activeStream = 'thinking';
                    }
                    currentThinkingContent += text;
                    await receiver.thinkingChunk(text);
                    await receiver.thinkingFinish(
                      payloadFromItem ?? buildReasoningPayloadFromText(currentThinkingContent),
                    );
                    thinkingStarted = false;
                    currentThinkingContent = '';
                    if (activeStream === 'thinking') activeStream = 'idle';
                  }
                } else if (thinkingStarted) {
                  await receiver.thinkingFinish(
                    payloadFromItem ?? buildReasoningPayloadFromText(currentThinkingContent),
                  );
                  thinkingStarted = false;
                  currentThinkingContent = '';
                  if (activeStream === 'thinking') activeStream = 'idle';
                }
                return;
              }
              case 'local_shell_call':
              case 'function_call_output':
              case 'custom_tool_call':
              case 'custom_tool_call_output':
              case 'ghost_snapshot':
              case 'compaction':
              case 'compaction_summary':
                return;
              case 'web_search_call':
                if (receiver.webSearchCall) {
                  const itemId = tryGetWebSearchCallItemId(event.item);
                  if (!itemId) {
                    const detail =
                      'Non-fatal LLM error: invalid web_search_call (missing itemId); dropping event';
                    log.error(detail, new Error('codex_web_search_call_missing_item_id'), {
                      status: event.item.status,
                      action: event.item.action,
                    });
                    if (receiver.streamError) {
                      await receiver.streamError(detail);
                    }
                    return;
                  }
                  await receiver.webSearchCall(toLlmWebSearchCall(event.item, itemId, 'done'));
                }
                return;
              default: {
                const _exhaustive: never = event.item;
                return _exhaustive;
              }
            }
          }
          case 'response.completed': {
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
        await receiver.thinkingFinish(buildReasoningPayloadFromText(currentThinkingContent));
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
    _requestContext: LlmRequestContext,
    _context: ChatMessage[],
    _genseq: number,
  ): Promise<LlmBatchResult> {
    throw new Error('Codex generator only supports streaming mode.');
  }
}
