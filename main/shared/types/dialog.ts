/**
 * Module: shared/types/dialog
 *
 * Strongly typed discriminated unions for dialog events.
 * These types are shared between backend and frontend for real-time dialog communication.
 */

// === DIALOG EVENT TYPE DEFINITIONS ===
import type { UserTextGrammar } from './storage';

export interface SubdialogEvent extends DialogEventBase {
  type: 'subdialog_created_evt';
  round: number;
  parentDialog: {
    selfId: string;
    rootId: string;
  };
  subDialog: {
    selfId: string;
    rootId: string;
  };
  targetAgentId: string;
  headLine: string;
  callBody: string;
  genseq?: number;
}

export interface StreamErrorEvent {
  type: 'stream_error_evt';
  round: number;
  error: string;
  genseq?: number;
}

export type GeneratingStartEvent = LlmGenDlgEvent & {
  type: 'generating_start_evt';
};

export type GeneratingFinishEvent = LlmGenDlgEvent & {
  type: 'generating_finish_evt';
};

export type ThinkingStartEvent = LlmGenDlgEvent & {
  type: 'thinking_start_evt';
};

export type ThinkingChunkEvent = LlmGenDlgEvent & {
  type: 'thinking_chunk_evt';
  chunk: string;
};

export type ThinkingFinishEvent = LlmGenDlgEvent & {
  type: 'thinking_finish_evt';
};

export type SayingStartEvent = LlmGenDlgEvent & {
  type: 'saying_start_evt';
};

export type SayingFinishEvent = LlmGenDlgEvent & {
  type: 'saying_finish_evt';
};

export type MarkdownStartEvent = LlmGenDlgEvent & {
  type: 'markdown_start_evt';
};

export type MarkdownChunkEvent = LlmGenDlgEvent & {
  type: 'markdown_chunk_evt';
  chunk: string;
};

export type MarkdownFinishEvent = LlmGenDlgEvent & {
  type: 'markdown_finish_evt';
};

export type FuncCallStartEvent = LlmGenDlgEvent & {
  type: 'func_call_requested_evt';
  funcName: string;
  funcId: string;
  arguments: string; // JSON stringified
  round: number;
  genseq: number;
};

export interface FunctionResultEvent {
  type: 'func_result_evt';
  id: string;
  name: string;
  content: string;
  round: number;
  genseq?: number;
}

// Tool call events (streaming mode - @tool_name mentions)
// callId is determined at finish event via content-hash (see shared/utils/id.ts)
export type ToolCallStartEvent = LlmGenDlgEvent & {
  type: 'tool_call_start_evt';
  firstMention: string;
};

export type ToolCallHeadlineChunkEvent = LlmGenDlgEvent & {
  type: 'tool_call_headline_chunk_evt';
  chunk: string;
};

export type ToolCallHeadlineFinishEvent = LlmGenDlgEvent & {
  type: 'tool_call_headline_finish_evt';
};

export type ToolCallBodyStartEvent = LlmGenDlgEvent & {
  type: 'tool_call_body_start_evt';
  infoLine?: string;
};

export type ToolCallBodyChunkEvent = LlmGenDlgEvent & {
  type: 'tool_call_body_chunk_evt';
  chunk: string;
};

export type ToolCallBodyFinishEvent = LlmGenDlgEvent & {
  type: 'tool_call_body_finish_evt';
  endQuote?: string;
};

export type ToolCallFinishEvent = LlmGenDlgEvent & {
  type: 'tool_call_finish_evt';
  callId: string; // Content-hash for replay correlation
};

export interface ToolCallResponseEvent {
  type: 'tool_call_response_evt';
  round: number;
  calling_genseq?: number;
  responderId: string;
  headLine: string;
  status: 'completed' | 'failed';
  result: string;
  callId: string; // Content-hash for replay correlation
}

// Teammate call events (streaming mode - @agentName and @human mentions)
export type TeammateCallStartEvent = LlmGenDlgEvent & {
  type: 'teammate_call_start_evt';
  firstMention: string;
  calleeDialogId?: string; // For @agentName: subdialog ID; For @human: "human"
};

export type TeammateCallHeadlineChunkEvent = LlmGenDlgEvent & {
  type: 'teammate_call_headline_chunk_evt';
  chunk: string;
};

export type TeammateCallHeadlineFinishEvent = LlmGenDlgEvent & {
  type: 'teammate_call_headline_finish_evt';
};

export type TeammateCallBodyStartEvent = LlmGenDlgEvent & {
  type: 'teammate_call_body_start_evt';
  infoLine?: string;
};

export type TeammateCallBodyChunkEvent = LlmGenDlgEvent & {
  type: 'teammate_call_body_chunk_evt';
  chunk: string;
};

export type TeammateCallBodyFinishEvent = LlmGenDlgEvent & {
  type: 'teammate_call_body_finish_evt';
  endQuote?: string;
};

export type TeammateCallFinishEvent = LlmGenDlgEvent & {
  type: 'teammate_call_finish_evt';
};

export interface ReminderContent {
  content: string;
  meta?: Record<string, unknown>;
}

export interface FullRemindersEvent {
  type: 'full_reminders_update';
  reminders: ReminderContent[];
}

// Teammate response event - separate bubble for @teammate calls
// calleeDialogId: ID of the callee dialog (subdialog or supdialog being called)
export interface TeammateResponseEvent {
  type: 'teammate_response_evt';
  round: number;
  calling_genseq?: number;
  responderId: string;
  calleeDialogId?: string; // ID of the callee dialog (subdialog OR supdialog)
  headLine: string;
  status: 'completed' | 'failed';
  result: string;
  response: string; // full subdialog response text (no truncation)
  agentId: string;
  callId: string; // For navigation from response back to call site
  originMemberId: string;
}

// End of user saying event - emitted after user texting calls are parsed/executed
// Used by frontend to render <hr/> separator between user content and AI response
export interface EndOfUserSayingEvent {
  type: 'end_of_user_saying_evt';
  round: number;
  genseq: number;
  msgId: string;
  content: string;
  grammar: UserTextGrammar;
}

export type CodeBlockStartEvent = LlmGenDlgEvent & {
  type: 'codeblock_start_evt';
  infoLine?: string;
};

export type CodeBlockChunkEvent = LlmGenDlgEvent & {
  type: 'codeblock_chunk_evt';
  chunk: string;
};

export type CodeBlockFinishEvent = LlmGenDlgEvent & {
  type: 'codeblock_finish_evt';
  endQuote?: string;
};

export interface RoundEvent {
  type: 'round_update';
  round: number;
  totalRounds: number;
}

export interface NewQ4HAskedEvent {
  type: 'new_q4h_asked';
  question: {
    id: string;
    dialogId: string;
    headLine: string;
    bodyContent: string;
    askedAt: string;
    callSiteRef: {
      round: number;
      messageIndex: number;
    };
    rootId?: string;
    agentId?: string;
    taskDocPath?: string;
  };
}

export interface Q4HAnsweredEvent {
  type: 'q4h_answered';
  questionId: string;
  dialogId: string;
}

// === UNION TYPES ===

// Base interface that every event has (common metadata)
export interface DialogEventBase {
  dialog: {
    selfId: string;
    rootId: string;
  };
  timestamp: string;
}

export interface LlmGenDlgEvent {
  round: number;
  genseq: number;
}

// Dialog event with common metadata merged
export type TypedDialogEvent = DialogEvent & DialogEventBase;

// Removed: duplicate QuestionsEvent interface - use Q4HUpdateEvent instead

// Union type for all dialog events
export type DialogEvent =
  // Generation lifecycle
  | GeneratingStartEvent
  | GeneratingFinishEvent
  // Thinking stream
  | ThinkingStartEvent
  | ThinkingChunkEvent
  | ThinkingFinishEvent
  // Saying stream
  | SayingStartEvent
  | SayingFinishEvent
  // Markdown stream
  | MarkdownStartEvent
  | MarkdownChunkEvent
  | MarkdownFinishEvent
  // Function calls (LLM native)
  | FuncCallStartEvent
  | FunctionResultEvent
  // Tool calls (@tool_name)
  | ToolCallStartEvent
  | ToolCallHeadlineChunkEvent
  | ToolCallHeadlineFinishEvent
  | ToolCallBodyStartEvent
  | ToolCallBodyChunkEvent
  | ToolCallBodyFinishEvent
  | ToolCallFinishEvent
  | ToolCallResponseEvent
  // Teammate calls (@agentName, @human)
  | TeammateCallStartEvent
  | TeammateCallHeadlineChunkEvent
  | TeammateCallHeadlineFinishEvent
  | TeammateCallBodyStartEvent
  | TeammateCallBodyChunkEvent
  | TeammateCallBodyFinishEvent
  | TeammateCallFinishEvent
  | TeammateResponseEvent
  // Code blocks
  | CodeBlockStartEvent
  | CodeBlockChunkEvent
  | CodeBlockFinishEvent
  // Subdialog events
  | SubdialogEvent
  // User events
  | EndOfUserSayingEvent
  | FullRemindersEvent
  | RoundEvent
  | NewQ4HAskedEvent
  | Q4HAnsweredEvent
  // Errors
  | StreamErrorEvent;

// Modern TypeScript patterns encourage direct discriminated union usage
// Instead of type guards and helpers, use pattern matching in switch statements
// This encourages better type safety and cleaner code at usage sites
