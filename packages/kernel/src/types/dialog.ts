/**
 * Module: kernel/types/dialog
 *
 * Strongly typed discriminated unions for dialog events.
 * These types are shared between backend and frontend for real-time dialog communication.
 */

import type { ContextHealthSnapshot } from './context-health';
import type {
  DialogDisplayState,
  DialogInterruptionReason,
  DialogLlmRetryExhaustedReason,
  DialogRetryDisplay,
} from './display-state';
import type { LanguageCode } from './language';
import type {
  AskerCourseNumber,
  AssignmentCourseNumber,
  AssignmentGenerationSeqNumber,
  CalleeCourseNumber,
  CalleeGenerationSeqNumber,
  CallSiteCourseNo,
  CallSiteGenseqNo,
  DialogCourseNumber,
  FuncResultContentItem,
  SideDialogAssignmentFromAsker,
  ToolResultImageArtifact,
  ToolResultImageDisposition,
} from './storage';

export interface DialogDisplayStateEvent {
  type: 'dlg_display_state_evt';
  displayState: DialogDisplayState;
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

export interface DialogDisplayStateMarkerEvent {
  type: 'dlg_display_state_marker_evt';
  kind: 'interrupted' | 'resumed';
  reason?: DialogInterruptionReason;
}

export interface SideDialogEvent extends DialogEventBase {
  type: 'sideDialog_created_evt';
  course: number;
  parentDialog: {
    selfId: string;
    rootId: string;
  };
  sideDialog: {
    selfId: string;
    rootId: string;
  };
  targetAgentId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  rootSideDialogCount: number;
  sideDialogNode: {
    selfId: string;
    rootId: string;
    askerDialogId: string;
    agentId: string;
    taskDocPath: string;
    status: 'running' | 'completed' | 'archived';
    currentCourse: number;
    createdAt: string;
    lastModified: string;
    displayState?: DialogDisplayState;
    sessionSlug?: string;
    assignmentFromAsker?: SideDialogAssignmentFromAsker;
  };
  genseq?: number;
}

export interface StreamErrorEvent {
  type: 'stream_error_evt';
  course: number;
  error: string;
  genseq?: number;
}

type LlmRetryEventBase = LlmGenDlgEvent & {
  type: 'llm_retry_evt';
  display: DialogRetryDisplay;
};

export type LlmRetryEvent =
  | (LlmRetryEventBase & {
      phase: 'waiting';
      error: string;
      nextRetryAtMs: number;
    })
  | (LlmRetryEventBase & {
      phase: 'running';
      error: string;
    })
  | (LlmRetryEventBase & {
      phase: 'resolved';
    })
  | {
      type: 'llm_retry_evt';
      course: number;
      genseq: number;
      phase: 'stopped';
      continueEnabled: boolean;
      reason: DialogLlmRetryExhaustedReason;
    };

export type GeneratingStartEvent = LlmGenDlgEvent & {
  type: 'generating_start_evt';
  msgId?: string;
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

export type UiOnlyMarkdownEvent = LlmGenDlgEvent & {
  type: 'ui_only_markdown_evt';
  content: string;
};

export type FuncCallStartEvent = LlmGenDlgEvent & {
  type: 'func_call_requested_evt';
  funcName: string;
  funcId: string;
  arguments: string;
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
  genseq: number;
}

export interface ToolResultImageIngestEvent extends LlmGenDlgEvent {
  type: 'tool_result_image_ingest_evt';
  toolCallId: string;
  toolName: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
}

export interface UserImageIngestEvent extends LlmGenDlgEvent {
  type: 'user_image_ingest_evt';
  msgId?: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
}

export type WebSearchCallSource = 'codex' | 'openai_responses';

export type WebSearchCallAction =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type WebSearchCallEvent = LlmGenDlgEvent & {
  type: 'web_search_call_evt';
  source?: WebSearchCallSource;
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  action?: WebSearchCallAction;
};

export type NativeToolCallSource = 'openai_responses';

export type NativeToolCallItemType =
  | 'file_search_call'
  | 'code_interpreter_call'
  | 'image_generation_call'
  | 'mcp_call'
  | 'mcp_list_tools'
  | 'mcp_approval_request'
  | 'custom_tool_call';

export type NonCustomNativeToolCallItemType = Exclude<NativeToolCallItemType, 'custom_tool_call'>;

export type NonCustomNativeToolCallEvent = LlmGenDlgEvent & {
  type: 'native_tool_call_evt';
  source?: NativeToolCallSource;
  itemType: NonCustomNativeToolCallItemType;
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

export type CustomNativeToolCallEvent = LlmGenDlgEvent & {
  type: 'native_tool_call_evt';
  source?: NativeToolCallSource;
  itemType: 'custom_tool_call';
  phase: 'added' | 'done';
  callId: string;
  itemId?: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
};

export type NativeToolCallEvent = NonCustomNativeToolCallEvent | CustomNativeToolCallEvent;

export type NativeToolCallPayload =
  | Omit<NonCustomNativeToolCallEvent, 'type' | 'course' | 'genseq' | 'dialog' | 'timestamp'>
  | Omit<CustomNativeToolCallEvent, 'type' | 'course' | 'genseq' | 'dialog' | 'timestamp'>;

export type GenerationDiscardEvent = LlmGenDlgEvent & {
  type: 'genseq_discard_evt';
  reason: 'retry';
};

export type TellaskCallStartEvent =
  | (LlmGenDlgEvent & {
      type: 'tellask_call_start_evt';
      callName: 'tellask';
      callId: string;
      mentionList: string[];
      sessionSlug: string;
      tellaskContent: string;
    })
  | (LlmGenDlgEvent & {
      type: 'tellask_call_start_evt';
      callName: 'tellaskSessionless';
      callId: string;
      mentionList: string[];
      tellaskContent: string;
    })
  | (LlmGenDlgEvent & {
      type: 'tellask_call_start_evt';
      callName: 'tellaskBack' | 'askHuman' | 'freshBootsReasoning';
      callId: string;
      tellaskContent: string;
    });

type TellaskResultEventBase = {
  type: 'tellask_result_evt';
  course: number;
  callSiteCourse?: CallSiteCourseNo;
  callSiteGenseq?: CallSiteGenseqNo;
  callId: string;
  status: 'pending' | 'completed' | 'failed';
  content: string;
  responder: {
    responderId: string;
    agentId?: string;
    originMemberId?: string;
  };
  route?: {
    calleeDialogId?: string;
    calleeCourse?: CalleeCourseNumber;
    calleeGenseq?: CalleeGenerationSeqNumber;
  };
};

export type TellaskResultEvent =
  | (TellaskResultEventBase & {
      callName: 'tellask';
      call: {
        tellaskContent: string;
        mentionList: string[];
        sessionSlug: string;
      };
    })
  | (TellaskResultEventBase & {
      callName: 'tellaskSessionless';
      call: {
        tellaskContent: string;
        mentionList: string[];
      };
    })
  | (TellaskResultEventBase & {
      callName: 'tellaskBack' | 'askHuman' | 'freshBootsReasoning';
      call: {
        tellaskContent: string;
      };
    });

type TellaskCallAnchorEventBase = {
  type: 'tellask_call_anchor_evt';
  course: number;
  genseq: number;
  callId: string;
  assignmentCourse?: AssignmentCourseNumber;
  assignmentGenseq?: AssignmentGenerationSeqNumber;
};

export type TellaskCallAnchorEvent =
  | (TellaskCallAnchorEventBase & {
      anchorRole: 'assignment';
      askerDialogId?: undefined;
      askerCourse?: undefined;
    })
  | (TellaskCallAnchorEventBase & {
      anchorRole: 'response';
      askerDialogId: string;
      askerCourse: AskerCourseNumber;
    });

export type TellaskCallCalleeEvent = LlmGenDlgEvent & {
  type: 'tellask_call_callee_evt';
  callId: string;
  calleeDialogId: string;
};

export interface ReminderContent {
  content: string;
  meta?: Record<string, unknown>;
  reminder_id: string;
  renderRevision: string;
  echoback?: boolean;
  scope?: 'dialog' | 'personal' | 'agent_shared';
  renderMode?: 'plain' | 'markdown';
}

export interface FullRemindersEvent {
  type: 'full_reminders_update';
  reminders: ReminderContent[];
}

export type TellaskCarryoverEvent =
  | {
      type: 'tellask_carryover_evt';
      course: number;
      genseq: number;
      responderId: string;
      status: 'completed' | 'failed';
      // Provenance only: where the original tellask call was issued.
      callSiteCourse: CallSiteCourseNo;
      // Ownership: the latest/current course that now carries the usable context.
      carryoverCourse: DialogCourseNumber;
      callName: 'tellask';
      sessionSlug: string;
      mentionList: string[];
      tellaskContent: string;
      response: string;
      // Canonical latest-course carryover payload. UI should render this instead of `response`,
      // and LLM context should read it as ordinary current-course user context rather than as a
      // tool-result pair for an older-course call.
      content: string;
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
    }
  | {
      type: 'tellask_carryover_evt';
      course: number;
      genseq: number;
      responderId: string;
      status: 'completed' | 'failed';
      // Provenance only: where the original tellask call was issued.
      callSiteCourse: CallSiteCourseNo;
      // Ownership: the latest/current course that now carries the usable context.
      carryoverCourse: DialogCourseNumber;
      callName: 'askHuman';
      tellaskContent: string;
      response: string;
      // Canonical latest-course carryover payload. UI should render this instead of `response`,
      // and LLM context should read it as ordinary current-course user context rather than as a
      // tool-result pair for an older-course call.
      content: string;
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
    }
  | {
      type: 'tellask_carryover_evt';
      course: number;
      genseq: number;
      responderId: string;
      status: 'completed' | 'failed';
      // Provenance only: where the original tellask call was issued.
      callSiteCourse: CallSiteCourseNo;
      // Ownership: the latest/current course that now carries the usable context.
      carryoverCourse: DialogCourseNumber;
      callName: 'tellaskSessionless';
      mentionList: string[];
      tellaskContent: string;
      response: string;
      // Canonical latest-course carryover payload. UI should render this instead of `response`,
      // and LLM context should read it as ordinary current-course user context rather than as a
      // tool-result pair for an older-course call.
      content: string;
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
    }
  | {
      type: 'tellask_carryover_evt';
      course: number;
      genseq: number;
      responderId: string;
      status: 'completed' | 'failed';
      // Provenance only: where the original tellask call was issued.
      callSiteCourse: CallSiteCourseNo;
      // Ownership: the latest/current course that now carries the usable context.
      carryoverCourse: DialogCourseNumber;
      callName: 'freshBootsReasoning';
      tellaskContent: string;
      response: string;
      // Canonical latest-course carryover payload. UI should render this instead of `response`,
      // and LLM context should read it as ordinary current-course user context rather than as a
      // tool-result pair for an older-course call.
      content: string;
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
    };

export interface EndOfUserSayingEvent {
  type: 'end_of_user_saying_evt';
  course: number;
  genseq: number;
  msgId: string;
  content: string;
  contentItems?: FuncResultContentItem[];
  grammar: 'markdown';
  origin: 'user' | 'diligence_push' | 'runtime';
  userLanguageCode?: LanguageCode;
  // Technical correlation for a resumed round after askHuman; not a signal that a new prompt fact
  // should be created from the same human answer.
  q4hAnswerCallId?: string;
}

export interface QueueUserMsgEvent {
  type: 'queue_user_msg_evt';
  course: number;
  msgId: string;
  content: string;
  contentItems?: FuncResultContentItem[];
  grammar: 'markdown';
  origin?: 'user' | 'diligence_push' | 'runtime';
  userLanguageCode?: LanguageCode;
}

export interface RuntimeGuideEvent {
  type: 'runtime_guide_evt';
  course: number;
  genseq: number;
  content: string;
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
    tellaskContent: string;
    askedAt: string;
    callId: string;
    callSiteRef: {
      course: number;
      messageIndex: number;
      callSiteGenseq?: CallSiteGenseqNo;
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

export type TypedDialogEvent = DialogEvent & DialogEventBase;

export type DialogEvent =
  | DialogTouchedEvent
  | GeneratingStartEvent
  | GeneratingFinishEvent
  | ContextHealthEvent
  | DialogDisplayStateEvent
  | DialogDisplayStateMarkerEvent
  | DiligenceBudgetEvent
  | ThinkingStartEvent
  | ThinkingChunkEvent
  | ThinkingFinishEvent
  | SayingStartEvent
  | SayingFinishEvent
  | MarkdownStartEvent
  | MarkdownChunkEvent
  | MarkdownFinishEvent
  | UiOnlyMarkdownEvent
  | FuncCallStartEvent
  | FunctionResultEvent
  | ToolResultImageIngestEvent
  | UserImageIngestEvent
  | WebSearchCallEvent
  | NativeToolCallEvent
  | GenerationDiscardEvent
  | TellaskCallStartEvent
  | TellaskResultEvent
  | TellaskCallAnchorEvent
  | TellaskCallCalleeEvent
  | TellaskCarryoverEvent
  | SideDialogEvent
  | QueueUserMsgEvent
  | RuntimeGuideEvent
  | EndOfUserSayingEvent
  | FullRemindersEvent
  | CourseEvent
  | NewQ4HAskedEvent
  | Q4HAnsweredEvent
  | StreamErrorEvent
  | LlmRetryEvent;
