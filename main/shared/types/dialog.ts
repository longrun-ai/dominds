/**
 * Module: shared/types/dialog
 *
 * Strongly typed discriminated unions for dialog events.
 * These types are shared between backend and frontend for real-time dialog communication.
 */

// === DIALOG EVENT TYPE DEFINITIONS ===
import type { ContextHealthSnapshot } from './context-health';
import type { LanguageCode } from './language';
import type { DialogInterruptionReason, DialogRunState } from './run-state';
import type { FuncResultContentItem } from './storage';

export interface DialogRunStateEvent {
  type: 'dlg_run_state_evt';
  runState: DialogRunState;
}

export interface DialogTouchedEvent {
  type: 'dlg_touched_evt';
  sourceType: string;
}

export interface DiligenceBudgetEvent {
  type: 'diligence_budget_evt';
  maxInjectCount: number;
  injectedCount: number;
  remainingCount: number;
  disableDiligencePush: boolean;
}

export interface DialogRunStateMarkerEvent {
  type: 'dlg_run_state_marker_evt';
  kind: 'interrupted' | 'resumed';
  reason?: DialogInterruptionReason;
}

export interface SubdialogEvent extends DialogEventBase {
  type: 'subdialog_created_evt';
  course: number;
  parentDialog: {
    selfId: string;
    rootId: string;
  };
  subDialog: {
    selfId: string;
    rootId: string;
  };
  targetAgentId: string;
  mentionList: string[];
  tellaskContent: string;
  subDialogNode: {
    selfId: string;
    rootId: string;
    supdialogId: string;
    agentId: string;
    taskDocPath: string;
    status: 'running' | 'completed' | 'archived';
    currentCourse: number;
    createdAt: string;
    lastModified: string;
    runState?: DialogRunState;
    sessionSlug?: string;
    assignmentFromSup?: {
      mentionList: string[];
      tellaskContent: string;
      originMemberId: string;
      callerDialogId: string;
      callId: string;
    };
  };
  genseq?: number;
}

export interface StreamErrorEvent {
  type: 'stream_error_evt';
  course: number;
  error: string;
  genseq?: number;
}

export type GeneratingStartEvent = LlmGenDlgEvent & {
  type: 'generating_start_evt';
};

export type GeneratingFinishEvent = LlmGenDlgEvent & {
  type: 'generating_finish_evt';
  llmGenModel?: string;
};

export type ContextHealthEvent = LlmGenDlgEvent & {
  type: 'context_health_evt';
  contextHealth: ContextHealthSnapshot;
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
  course: number;
  genseq: number;
};

export interface FunctionResultEvent {
  type: 'func_result_evt';
  id: string;
  name: string;
  content: string;
  contentItems?: FuncResultContentItem[];
  course: number;
  genseq?: number;
}

export type WebSearchActionType = 'search' | 'open_page' | 'find_in_page';

export type WebSearchCallAction =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type WebSearchCallEvent = LlmGenDlgEvent & {
  type: 'web_search_call_evt';
  phase: 'added' | 'done';
  itemId?: string;
  status?: string;
  action?: WebSearchCallAction;
};

// Teammate-call lifecycle events (function-call based tellask-special channel)
export type TeammateCallStartEvent = LlmGenDlgEvent & {
  type: 'teammate_call_start_evt';
  callId: string;
  mentionList: string[];
  tellaskContent: string;
};

export interface TeammateCallResponseEvent {
  type: 'teammate_call_response_evt';
  course: number;
  calling_genseq?: number;
  responderId: string;
  mentionList: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  result: string;
  callId: string;
}

// Anchor event in callee dialog for locating assignment/response bubbles by tellask callId.
export interface TeammateCallAnchorEvent {
  type: 'teammate_call_anchor_evt';
  course: number;
  genseq: number;
  anchorRole: 'assignment' | 'response';
  callId: string;
  assignmentCourse?: number;
  assignmentGenseq?: number;
  callerDialogId?: string;
  callerCourse?: number;
}

export interface ReminderContent {
  content: string;
  meta?: Record<string, unknown>;
}

export interface FullRemindersEvent {
  type: 'full_reminders_update';
  reminders: ReminderContent[];
}

// Teammate response event - separate bubble for @teammate tellasks
// calleeDialogId: ID of the callee dialog (subdialog or supdialog being called)
export interface TeammateResponseEvent {
  type: 'teammate_response_evt';
  course: number;
  calling_genseq?: number;
  responderId: string;
  calleeDialogId?: string; // ID of the callee dialog (subdialog OR supdialog)
  calleeCourse?: number;
  calleeGenseq?: number;
  mentionList: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  result: string;
  response: string; // full subdialog response text (no truncation)
  agentId: string;
  callId: string; // For navigation from response back to call site
  originMemberId: string;
}

// End of user saying event - emitted after user content is rendered/executed.
// Used by frontend to render <hr/> separator between user content and AI response
export interface EndOfUserSayingEvent {
  type: 'end_of_user_saying_evt';
  course: number;
  genseq: number;
  msgId: string;
  content: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
}

export interface CourseEvent {
  type: 'course_update';
  course: number;
  totalCourses: number;
}

export interface NewQ4HAskedEvent {
  type: 'new_q4h_asked';
  question: {
    id: string;
    selfId: string;
    mentionList: string[];
    tellaskContent: string;
    askedAt: string;
    callId?: string;
    remainingCallIds?: string[];
    callSiteRef: {
      course: number;
      messageIndex: number;
    };
    rootId: string;
    agentId: string;
    taskDocPath: string;
  };
}

export interface Q4HAnsweredEvent {
  type: 'q4h_answered';
  questionId: string;
  selfId: string;
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
  course: number;
  genseq: number;
}

// Dialog event with common metadata merged
export type TypedDialogEvent = DialogEvent & DialogEventBase;

// Removed: duplicate QuestionsEvent interface - use Q4HUpdateEvent instead

// Union type for all dialog events
export type DialogEvent =
  | DialogTouchedEvent
  // Generation lifecycle
  | GeneratingStartEvent
  | GeneratingFinishEvent
  | ContextHealthEvent
  // Run state
  | DialogRunStateEvent
  | DialogRunStateMarkerEvent
  | DiligenceBudgetEvent
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
  | WebSearchCallEvent
  // Tellask-special call lifecycle
  | TeammateCallStartEvent
  | TeammateCallResponseEvent
  | TeammateCallAnchorEvent
  | TeammateResponseEvent
  // Subdialog events
  | SubdialogEvent
  // User events
  | EndOfUserSayingEvent
  | FullRemindersEvent
  | CourseEvent
  | NewQ4HAskedEvent
  | Q4HAnsweredEvent
  // Errors
  | StreamErrorEvent;

// Modern TypeScript patterns encourage direct discriminated union usage
// Instead of type guards and helpers, use pattern matching in switch statements
// This encourages better type safety and cleaner code at usage sites
