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

export type TellaskResultMsg = Readonly<{
  type: 'tellask_result_msg';
  role: 'tool';
  callId: string;
  callName: string;
  status: 'pending' | 'completed' | 'failed';
  content: string;
  originCourse?: number;
  responderId?: string;
  mentionList?: string[];
  tellaskContent?: string;
  agentId?: string;
  originMemberId?: string;
  sessionSlug?: string;
  calleeDialogId?: string;
  calleeCourse?: number;
  calleeGenseq?: number;
  calling_genseq?: number;
  call?: Readonly<{
    tellaskContent: string;
    mentionList?: string[];
    sessionSlug?: string;
  }>;
  responder?: Readonly<{
    responderId: string;
    agentId?: string;
    originMemberId?: string;
  }>;
  route?: Readonly<{
    calleeDialogId?: string;
    calleeCourse?: number;
    calleeGenseq?: number;
  }>;
}>;

export type TellaskCarryoverMsg = Readonly<{
  type: 'tellask_carryover_msg';
  role: 'user';
  genseq: number;
  // Canonical latest-course carryover context. UI and LLM should read this directly when the
  // original tellask call lived in an older course and is therefore absent from current context.
  content: string;
  // Provenance only: where the original tellask call was issued.
  originCourse: number;
  // Ownership: the current/latest course that now contains the usable carryover context.
  carryoverCourse: number;
  responderId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  tellaskContent: string;
  status: 'completed' | 'failed';
  // Raw tellask response body before it is wrapped into current-course carryover narration.
  response: string;
  agentId: string;
  callId: string;
  originMemberId: string;
  mentionList?: string[];
  sessionSlug?: string;
  calleeDialogId?: string;
  calleeCourse?: number;
  calleeGenseq?: number;
}>;

export type ChatMessage =
  | EnvironmentMsg
  | TransientGuideMsg
  | PromptingMsg
  | SayingMsg
  | ThinkingMsg
  | FuncCallMsg
  | FuncResultMsg
  | TellaskResultMsg
  | TellaskCarryoverMsg;
