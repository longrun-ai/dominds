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

export interface LlmStreamReceiver {
  thinkingStart: () => Promise<void>;
  thinkingChunk: (chunk: string) => Promise<void>;
  thinkingFinish: () => Promise<void>;
  sayingStart: () => Promise<void>;
  sayingChunk: (chunk: string) => Promise<void>;
  sayingFinish: () => Promise<void>;
  funcCall: (callId: string, name: string, args: string) => Promise<void>;
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
