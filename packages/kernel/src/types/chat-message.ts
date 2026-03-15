import type { FuncResultContentItem, ProviderData, ReasoningPayload } from './storage';

export type EnvironmentMsg = Readonly<{
  type: 'environment_msg';
  role: 'user';
  content: string;
}>;

export type TransientGuideMsg = Readonly<{
  type: 'transient_guide_msg';
  role: 'assistant';
  content: string;
}>;

export type PromptingMsg = Readonly<{
  type: 'prompting_msg';
  role: 'user';
  genseq: number;
  msgId: string;
  content: string;
  grammar: 'markdown';
}>;

export type SayingMsg = Readonly<{
  type: 'saying_msg';
  role: 'assistant';
  genseq: number;
  content: string;
  provider_data?: ProviderData;
}>;

export type UiOnlyMarkdownMsg = Readonly<{
  type: 'ui_only_markdown_msg';
  role: 'assistant';
  genseq: number;
  content: string;
}>;

export type ThinkingMsg = Readonly<{
  type: 'thinking_msg';
  role: 'assistant';
  genseq: number;
  content: string;
  reasoning?: ReasoningPayload;
  provider_data?: ProviderData;
}>;

export type FuncCallMsg = Readonly<{
  type: 'func_call_msg';
  role: 'assistant';
  genseq: number;
  id: string;
  name: string;
  arguments: string;
  provider_data?: ProviderData;
}>;

export type FuncResultMsg = Readonly<{
  type: 'func_result_msg';
  role: 'tool';
  genseq: number;
  id: string;
  name: string;
  content: string;
  contentItems?: FuncResultContentItem[];
}>;

export type TellaskCallResultMsg = Readonly<{
  type: 'tellask_result_msg';
  role: 'tool';
  responderId: string;
  mentionList?: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  content: string;
  callId?: string;
}>;

export type TellaskCarryoverResultMsg = Readonly<{
  type: 'tellask_carryover_result_msg';
  role: 'user';
  content: string;
  originCourse: number;
  responderId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  tellaskContent: string;
  status: 'completed' | 'failed';
  callId: string;
}>;

export type ChatMessage =
  | EnvironmentMsg
  | TransientGuideMsg
  | PromptingMsg
  | SayingMsg
  | UiOnlyMarkdownMsg
  | ThinkingMsg
  | FuncCallMsg
  | FuncResultMsg
  | TellaskCallResultMsg
  | TellaskCarryoverResultMsg;
