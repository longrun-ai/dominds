import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import type { DialogDisplayTextI18n } from '@longrun-ai/kernel/types/display-state';
import type {
  ReasoningPayload,
  ToolResultImageArtifact,
  ToolResultImageDisposition,
} from '@longrun-ai/kernel/types/storage';
import { Team } from '../team';
import { FuncTool } from '../tool';
import { ChatMessage, ProviderConfig } from './client';

export interface LlmStreamResult {
  usage: LlmUsageStats;
  llmGenModel?: string;
}

export class LlmStreamErrorEmittedError extends Error {
  public readonly detail: string;
  public readonly i18nStopReason: DialogDisplayTextI18n;

  constructor(args: { detail: string; message?: string; i18nStopReason: DialogDisplayTextI18n }) {
    super(args.message ?? args.detail);
    this.name = 'LlmStreamErrorEmittedError';
    this.detail = args.detail;
    this.i18nStopReason = args.i18nStopReason;
  }
}

export type LlmBatchOutput =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'web_search_call'; call: LlmWebSearchCall }
  | { kind: 'native_tool_call'; call: OpenAiResponsesNativeToolCall }
  | { kind: 'tool_result_image_ingest'; ingest: ToolResultImageIngest }
  | { kind: 'user_image_ingest'; ingest: UserImageIngest };

export interface LlmBatchResult {
  messages: ChatMessage[];
  // Ordered non-streaming projection. Generators should populate this when batch mode can emit
  // provider-native side-channel outputs whose semantics would be lost if we returned messages only.
  outputs?: LlmBatchOutput[];
  usage: LlmUsageStats;
  llmGenModel?: string;
}

export type LlmRetryStrategy = 'aggressive' | 'conservative' | 'smart_rate';

export type LlmFailureDisposition = {
  kind: 'retriable' | 'rejected' | 'fatal';
  message: string;
  status?: number;
  code?: string;
  retryStrategy?: LlmRetryStrategy;
  retryAfterMs?: number;
};

export type LlmFailureClassifier = (error: unknown) => LlmFailureDisposition | undefined;

export interface LlmRequestContext {
  dialogSelfId: string;
  dialogRootId: string;
  providerKey?: string;
  modelKey?: string;
  promptCacheKey?: string;
  // Provider-adapter hint for quirks that must repair provider-assigned tool call ids before the
  // kernel driver sees them. Normal duplicate-call enforcement remains in the kernel driver.
  knownFunctionCallIds?: ReadonlySet<string>;
}

export type ToolResultImageIngest = {
  toolCallId: string;
  toolName: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
};

export type UserImageIngest = {
  msgId?: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
};

// Provider-isolated wrapper event types.
// Keep provider-native semantics inside each wrapper and only converge at the driver boundary via
// this discriminated union. Wrapper code must not read or synthesize another provider's variant.
export type CodexLlmWebSearchAction =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type OpenAiResponsesLlmWebSearchAction =
  | { type: 'search'; query?: string; queries?: string[] }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type CodexLlmWebSearchCall = {
  source: 'codex';
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  action?: CodexLlmWebSearchAction;
};

export type OpenAiResponsesLlmWebSearchCall = {
  source: 'openai_responses';
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  action?: OpenAiResponsesLlmWebSearchAction;
};

// This union is the cross-wrapper transport boundary only. Do not treat it as evidence that the
// underlying provider payloads are interchangeable.
export type LlmWebSearchCall = CodexLlmWebSearchCall | OpenAiResponsesLlmWebSearchCall;

export type OpenAiResponsesNativeToolItemType =
  | 'file_search_call'
  | 'code_interpreter_call'
  | 'image_generation_call'
  | 'mcp_call'
  | 'mcp_list_tools'
  | 'mcp_approval_request'
  | 'custom_tool_call';

export type OpenAiResponsesNonCustomNativeToolItemType = Exclude<
  OpenAiResponsesNativeToolItemType,
  'custom_tool_call'
>;

export type OpenAiResponsesNonCustomNativeToolCall = {
  source: 'openai_responses';
  itemType: OpenAiResponsesNonCustomNativeToolItemType;
  phase: 'added' | 'done';
  // Responses-native tool lifecycle events are item-driven for these tool families.
  itemId: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

export type OpenAiResponsesCustomToolCall = {
  source: 'openai_responses';
  itemType: 'custom_tool_call';
  phase: 'added' | 'done';
  // Official custom_tool_call semantics are call-driven. `itemId` may arrive later as a platform
  // item identifier, but `callId` is the stable business identity from the start.
  callId: string;
  itemId?: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

export type OpenAiResponsesNativeToolCall =
  | OpenAiResponsesNonCustomNativeToolCall
  | OpenAiResponsesCustomToolCall;

export interface LlmStreamReceiver {
  thinkingStart: () => Promise<void>;
  thinkingChunk: (chunk: string) => Promise<void>;
  thinkingFinish: (reasoning?: ReasoningPayload) => Promise<void>;
  sayingStart: () => Promise<void>;
  sayingChunk: (chunk: string) => Promise<void>;
  sayingFinish: () => Promise<void>;
  funcCall: (callId: string, name: string, args: string) => Promise<void>;
  webSearchCall?: (call: LlmWebSearchCall) => Promise<void>;
  nativeToolCall?: (call: OpenAiResponsesNativeToolCall) => Promise<void>;
  toolResultImageIngest?: (ingest: ToolResultImageIngest) => Promise<void>;
  userImageIngest?: (ingest: UserImageIngest) => Promise<void>;

  // Optional hook for generators to surface protocol/streaming anomalies (e.g. overlap) via the runtime.
  // Used only for debugging; generators should still attempt best-effort recovery.
  streamError?: (detail: string) => Promise<void>;
}

export interface LlmGenerator {
  readonly apiType: string;
  classifyFailure?: LlmFailureClassifier;

  genToReceiver: (
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    requestContext: LlmRequestContext,
    context: ChatMessage[],
    receiver: LlmStreamReceiver,
    genseq: number,
    abortSignal?: AbortSignal,
  ) => Promise<LlmStreamResult>;

  genMoreMessages: (
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
    requestContext: LlmRequestContext,
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ) => Promise<LlmBatchResult>;
}
