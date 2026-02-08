import type { LlmUsageStats } from '../shared/types/context-health';
import { Team } from '../team';
import { FuncTool } from '../tool';
import { ChatMessage, ProviderConfig } from './client';

export interface LlmStreamResult {
  usage: LlmUsageStats;
  llmGenModel?: string;
}

export interface LlmBatchResult {
  messages: ChatMessage[];
  usage: LlmUsageStats;
  llmGenModel?: string;
}

export type LlmWebSearchAction =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type LlmWebSearchCall = {
  phase: 'added' | 'done';
  itemId?: string;
  status?: string;
  action?: LlmWebSearchAction;
};

export interface LlmStreamReceiver {
  thinkingStart: () => Promise<void>;
  thinkingChunk: (chunk: string) => Promise<void>;
  thinkingFinish: () => Promise<void>;
  sayingStart: () => Promise<void>;
  sayingChunk: (chunk: string) => Promise<void>;
  sayingFinish: () => Promise<void>;
  funcCall: (callId: string, name: string, args: string) => Promise<void>;
  webSearchCall?: (call: LlmWebSearchCall) => Promise<void>;

  // Optional hook for generators to surface protocol/streaming anomalies (e.g. overlap) via the runtime.
  // Used only for debugging; generators should still attempt best-effort recovery.
  streamError?: (detail: string) => Promise<void>;
}

export interface LlmGenerator {
  readonly apiType: string;

  genToReceiver: (
    providerConfig: ProviderConfig,
    agent: Team.Member,
    systemPrompt: string,
    funcTools: FuncTool[],
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
    context: ChatMessage[],
    genseq: number,
    abortSignal?: AbortSignal,
  ) => Promise<LlmBatchResult>;
}
