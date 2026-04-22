/**
 * Module: kernel/types/storage
 *
 * Strongly typed disk storage formats for dialog persistence.
 * Uses modern TypeScript patterns for statically verifiable field access.
 */

import type { ContextHealthSnapshot } from './context-health';
import type {
  DialogDeadReason,
  DialogDisplayState,
  DialogInterruptionReason,
} from './display-state';
import type { DialogRuntimePrompt } from './drive-intent';
import type { LanguageCode } from './language';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type ProviderData = JsonObject;
export type ToolArguments = JsonObject;

export type ReasoningSummaryItem = {
  type: 'summary_text';
  text: string;
};

export type ReasoningContentItem =
  | { type: 'reasoning_text'; text: string }
  | { type: 'text'; text: string };

export interface ReasoningPayload {
  summary: ReasoningSummaryItem[];
  content?: ReasoningContentItem[];
  encrypted_content?: string;
}

export type FuncResultContentItem =
  | { type: 'input_text'; text: string }
  | {
      type: 'input_image';
      mimeType: string;
      byteLength: number;
      artifact: ToolResultImageArtifact;
    };

export type ToolResultImageArtifact = {
  rootId: string;
  selfId: string;
  status: 'running' | 'completed' | 'archived';
  relPath: string;
};

export type ToolResultImageDisposition =
  | 'fed_native'
  | 'fed_provider_transformed'
  | 'filtered_provider_unsupported'
  | 'filtered_model_unsupported'
  | 'filtered_mime_unsupported'
  | 'filtered_size_limit'
  | 'filtered_read_failed'
  | 'filtered_missing';

export interface MainDialogMetadataFile {
  id: string;
  agentId: string;
  taskDocPath: string;
  createdAt: string;
  askerDialogId?: undefined;
  sessionSlug?: undefined;
  assignmentFromAsker?: undefined;
  priming?: {
    scriptRefs: string[];
    showInUi: boolean;
  };
}

export interface SideDialogMetadataFile {
  id: string;
  agentId: string;
  taskDocPath: string;
  createdAt: string;
  askerDialogId: string;
  sessionSlug?: string;
  assignmentFromAsker: {
    callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
    mentionList?: string[];
    tellaskContent: string;
    originMemberId: string;
    callerDialogId: string;
    callId: string;
    collectiveTargets?: string[];
    effectiveFbrEffort?: number;
  };
}

export type DialogMetadataFile = MainDialogMetadataFile | SideDialogMetadataFile;

export interface AskerDialogStackFrame {
  kind: 'asker_dialog_stack_frame';
  askerDialogId: string;
  assignmentFromAsker?: SideDialogMetadataFile['assignmentFromAsker'];
  tellaskReplyObligation?: TellaskReplyDirective;
}

export interface DialogAskerStackState {
  askerStack: AskerDialogStackFrame[];
}

export type DialogDeferredReplyReassertion = Readonly<{
  reason: 'user_interjection_with_parked_original_task';
  directive: TellaskReplyDirective;
  resumeGuideSurfaced?: boolean;
}>;

export type DialogSideDialogReplyTarget = Readonly<{
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
}>;

export type DialogPendingCourseStartPrompt = DialogRuntimePrompt;

export interface DialogLatestFile {
  currentCourse: number;
  lastModified: string;
  messageCount?: number;
  functionCallCount?: number;
  sideDialogCount?: number;
  status: 'active' | 'completed' | 'archived';
  generating?: boolean;
  needsDrive?: boolean;
  displayState?: DialogDisplayState;
  executionMarker?: DialogExecutionMarker;
  fbrState?: DialogFbrState;
  deferredReplyReassertion?: DialogDeferredReplyReassertion;
  pendingCourseStartPrompt?: DialogPendingCourseStartPrompt;
  disableDiligencePush?: boolean;
  diligencePushRemainingBudget?: number;
}

export type DialogExecutionMarker =
  | {
      kind: 'interrupted';
      reason: DialogInterruptionReason;
    }
  | {
      kind: 'dead';
      reason: DialogDeadReason;
    };

export type DialogFbrState = Readonly<{
  kind: 'serial';
  effort: number;
  phase: 'divergence' | 'convergence' | 'finalization';
  iteration: number;
  promptDelivered: boolean;
}>;

export interface CourseMetadataFile {
  course: number;
  startedAt: string;
  completedAt?: string;
  messageCount: number;
  functionCallCount: number;
  sideDialogCount: number;
  status: 'active' | 'completed';
  taskDoc?: string;
}

export type RootCourseNumber = number & { readonly __rootCourseBrand: unique symbol };
export type RootGenerationSeqNumber = number & { readonly __rootGenerationSeqBrand: unique symbol };
export type DialogCourseNumber = number & { readonly __dialogCourseBrand: unique symbol };
export type CallingCourseNumber = number & { readonly __callingCourseBrand: unique symbol };
export type CallingGenerationSeqNumber = number & {
  readonly __callingGenerationSeqBrand: unique symbol;
};
export type AssignmentCourseNumber = number & { readonly __assignmentCourseBrand: unique symbol };
export type AssignmentGenerationSeqNumber = number & {
  readonly __assignmentGenerationSeqBrand: unique symbol;
};
export type CallerCourseNumber = number & { readonly __callerCourseBrand: unique symbol };
export type CalleeCourseNumber = number & { readonly __calleeCourseBrand: unique symbol };
export type CalleeGenerationSeqNumber = number & {
  readonly __calleeGenerationSeqBrand: unique symbol;
};

export interface RootGenerationAnchor {
  rootCourse: RootCourseNumber;
  rootGenseq: RootGenerationSeqNumber;
}

export type ReconciledRecordWriteTarget =
  | {
      kind: 'dialog_course';
      rootAnchor: RootGenerationAnchor;
      dialogCourse: DialogCourseNumber;
    }
  | {
      kind: 'root_anchor';
      rootAnchor: RootGenerationAnchor;
    };

export interface RootGenerationRef {
  rootCourse?: RootCourseNumber;
  rootGenseq?: RootGenerationSeqNumber;
}

export function toRootCourseNumber(value: number): RootCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid root course number: ${String(value)}`);
  }
  return Math.floor(value) as RootCourseNumber;
}

export function toRootGenerationSeqNumber(value: number): RootGenerationSeqNumber {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid root generation sequence number: ${String(value)}`);
  }
  return Math.floor(value) as RootGenerationSeqNumber;
}

export function toDialogCourseNumber(value: number): DialogCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid dialog course number: ${String(value)}`);
  }
  return Math.floor(value) as DialogCourseNumber;
}

export function toCallingCourseNumber(value: number): CallingCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid calling course number: ${String(value)}`);
  }
  return Math.floor(value) as CallingCourseNumber;
}

export function toCallingGenerationSeqNumber(value: number): CallingGenerationSeqNumber {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid calling generation sequence number: ${String(value)}`);
  }
  return Math.floor(value) as CallingGenerationSeqNumber;
}

export function toAssignmentCourseNumber(value: number): AssignmentCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid assignment course number: ${String(value)}`);
  }
  return Math.floor(value) as AssignmentCourseNumber;
}

export function toAssignmentGenerationSeqNumber(value: number): AssignmentGenerationSeqNumber {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid assignment generation sequence number: ${String(value)}`);
  }
  return Math.floor(value) as AssignmentGenerationSeqNumber;
}

export function toCallerCourseNumber(value: number): CallerCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid caller course number: ${String(value)}`);
  }
  return Math.floor(value) as CallerCourseNumber;
}

export function toCalleeCourseNumber(value: number): CalleeCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid callee course number: ${String(value)}`);
  }
  return Math.floor(value) as CalleeCourseNumber;
}

export function toCalleeGenerationSeqNumber(value: number): CalleeGenerationSeqNumber {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid callee generation sequence number: ${String(value)}`);
  }
  return Math.floor(value) as CalleeGenerationSeqNumber;
}

export function toRootGenerationAnchor(args: {
  rootCourse: number;
  rootGenseq: number;
}): RootGenerationAnchor {
  return {
    rootCourse: toRootCourseNumber(args.rootCourse),
    rootGenseq: toRootGenerationSeqNumber(args.rootGenseq),
  };
}

export interface ReminderSnapshotItem {
  id: string;
  content: string;
  // Stable serialized route for re-binding the reminder to its owner after reload.
  // Storage/runtime code may use this to look up the owner, but must not infer owner
  // semantics from `meta` when `ownerName` is absent or unknown.
  ownerName?: string;
  // Opaque owner-defined payload. The framework persists it verbatim and must treat it
  // as a black box outside the resolved owner implementation.
  meta?: JsonValue;
  echoback?: boolean;
  scope?: 'dialog' | 'personal' | 'agent_shared';
  renderMode?: 'plain' | 'markdown';
  createdAt: string;
  priority: 'high' | 'medium' | 'low';
}

export interface PendingSideDialogStateRecord {
  sideDialogId: string;
  createdAt: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  targetAgentId: string;
  callId: string;
  callingCourse: CallingCourseNumber;
  callingGenseq: CallingGenerationSeqNumber;
  callType: 'A' | 'B' | 'C';
  sessionSlug?: string;
}

export interface SideDialogRegistryStateRecord {
  key: string;
  sideDialogId: string;
  agentId: string;
  sessionSlug?: string;
}

export interface SideDialogResponseStateRecord {
  responseId: string;
  sideDialogId: string;
  response: string;
  completedAt: string;
  status?: 'completed' | 'failed';
  callType: 'A' | 'B' | 'C';
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  responderId: string;
  originMemberId: string;
  callId: string;
}

export interface AgentThoughtRecord extends RootGenerationRef {
  ts: string;
  type: 'agent_thought_record';
  genseq: number;
  content: string;
  reasoning?: ReasoningPayload;
  provider_data?: ProviderData;
  sourceTag?: 'priming_script';
}

export interface AgentWordsRecord extends RootGenerationRef {
  ts: string;
  type: 'agent_words_record';
  genseq: number;
  content: string;
  sourceTag?: 'priming_script';
}

export interface UiOnlyMarkdownRecord extends RootGenerationRef {
  ts: string;
  type: 'ui_only_markdown_record';
  genseq: number;
  content: string;
  sourceTag?: 'priming_script';
}

export interface RuntimeGuideRecord extends RootGenerationRef {
  ts: string;
  type: 'runtime_guide_record';
  genseq: number;
  content: string;
  sourceTag?: 'priming_script';
}

export interface FuncCallRecord extends RootGenerationRef {
  ts: string;
  type: 'func_call_record';
  genseq: number;
  id: string;
  name: string;
  rawArgumentsText: string;
  sourceTag?: 'priming_script';
}

export type TellaskCallRecordName =
  | 'tellaskBack'
  | 'tellask'
  | 'tellaskSessionless'
  | 'replyTellask'
  | 'replyTellaskSessionless'
  | 'replyTellaskBack'
  | 'askHuman'
  | 'freshBootsReasoning';

export interface TellaskCallRecord extends RootGenerationRef {
  ts: string;
  type: 'tellask_call_record';
  genseq: number;
  id: string;
  name: TellaskCallRecordName;
  rawArgumentsText: string;
  deliveryMode: 'tellask_call_start' | 'func_call_requested';
  sourceTag?: 'priming_script';
}

type TellaskResultRecordBase = RootGenerationRef & {
  ts: string;
  type: 'tellask_result_record';
  callId: string;
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  status: 'pending' | 'completed' | 'failed';
  content: string;
  contentItems?: FuncResultContentItem[];
  originCourse?: CallingCourseNumber;
  calling_genseq?: CallingGenerationSeqNumber;
  call: {
    tellaskContent: string;
    mentionList?: string[];
    sessionSlug?: string;
  };
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
  sourceTag?: 'priming_script';
};

export type TellaskResultRecord =
  | (TellaskResultRecordBase & {
      callName: 'tellask';
      call: {
        tellaskContent: string;
        mentionList: string[];
        sessionSlug: string;
      };
      responder: {
        responderId: string;
        agentId?: string;
        originMemberId?: string;
      };
    })
  | (TellaskResultRecordBase & {
      callName: 'tellaskSessionless';
      call: {
        tellaskContent: string;
        mentionList: string[];
        sessionSlug?: undefined;
      };
      responder: {
        responderId: string;
        agentId?: string;
        originMemberId?: string;
      };
    })
  | (TellaskResultRecordBase & {
      callName: 'tellaskBack' | 'askHuman' | 'freshBootsReasoning';
      call: {
        tellaskContent: string;
        mentionList?: undefined;
        sessionSlug?: undefined;
      };
      responder: {
        responderId: string;
        agentId?: string;
        originMemberId?: string;
      };
    });

export type WebSearchCallSourceRecord = 'codex' | 'openai_responses';

export type WebSearchCallActionRecord =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export interface WebSearchCallRecord extends RootGenerationRef {
  ts: string;
  type: 'web_search_call_record';
  genseq: number;
  source?: WebSearchCallSourceRecord;
  phase: 'added' | 'done';
  itemId?: string;
  status?: string;
  action?: WebSearchCallActionRecord;
  sourceTag?: 'priming_script';
}

export type NativeToolCallSourceRecord = 'openai_responses';

export type NativeToolCallItemTypeRecord =
  | 'file_search_call'
  | 'code_interpreter_call'
  | 'image_generation_call'
  | 'mcp_call'
  | 'mcp_list_tools'
  | 'mcp_approval_request'
  | 'custom_tool_call';

export type NonCustomNativeToolCallItemTypeRecord = Exclude<
  NativeToolCallItemTypeRecord,
  'custom_tool_call'
>;

export interface NonCustomNativeToolCallRecord extends RootGenerationRef {
  ts: string;
  type: 'native_tool_call_record';
  genseq: number;
  source?: NativeToolCallSourceRecord;
  itemType: NonCustomNativeToolCallItemTypeRecord;
  phase: 'added' | 'done';
  itemId: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
  sourceTag?: 'priming_script';
}

export interface CustomNativeToolCallRecord extends RootGenerationRef {
  ts: string;
  type: 'native_tool_call_record';
  genseq: number;
  source?: NativeToolCallSourceRecord;
  itemType: 'custom_tool_call';
  phase: 'added' | 'done';
  callId: string;
  itemId?: string;
  status?: string;
  title?: string;
  summary?: string;
  detail?: string;
  sourceTag?: 'priming_script';
}

export type NativeToolCallRecord = NonCustomNativeToolCallRecord | CustomNativeToolCallRecord;

export interface HumanTextRecord extends RootGenerationRef {
  ts: string;
  type: 'human_text_record';
  genseq: number;
  msgId: string;
  content: string;
  contentItems?: FuncResultContentItem[];
  grammar: 'markdown';
  origin?: 'user' | 'diligence_push' | 'runtime';
  userLanguageCode?: LanguageCode;
  sourceTag?: 'priming_script';
  // Technical continuation marker for a resumed round after askHuman is answered. The canonical
  // answer fact lives in tellask result/carryover records instead of this human_text_record.
  q4hAnswerCallId?: string;
  tellaskReplyDirective?: TellaskReplyDirective;
}

export type TellaskReplyDirective =
  | Readonly<{
      expectedReplyCallName: 'replyTellask';
      targetDialogId: string;
      targetCallId: string;
      tellaskContent: string;
    }>
  | Readonly<{
      expectedReplyCallName: 'replyTellaskSessionless';
      targetDialogId: string;
      targetCallId: string;
      tellaskContent: string;
    }>
  | Readonly<{
      expectedReplyCallName: 'replyTellaskBack';
      targetCallId: string;
      targetDialogId: string;
      tellaskContent: string;
    }>;

export interface FuncResultRecord extends RootGenerationRef {
  ts: string;
  type: 'func_result_record';
  genseq: number;
  id: string;
  name: string;
  content: string;
  contentItems?: FuncResultContentItem[];
  sourceTag?: 'priming_script';
}

export interface ToolResultImageIngestRecord extends RootGenerationRef {
  // Attempt-scoped UI diagnostic for how the current generation projected a tool-result image into
  // the provider request. These records are safe to append before request success is known because
  // failed/retried generation attempts are truncated by course-file rollback, and live UIs are
  // expected to clear the corresponding state on genseq_discard_evt.
  ts: string;
  type: 'tool_result_image_ingest_record';
  genseq: number;
  toolCallId: string;
  toolName: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
  sourceTag?: 'priming_script';
}

export interface UserImageIngestRecord extends RootGenerationRef {
  // Attempt-scoped UI diagnostic for how the current generation projected a user-provided image
  // attachment into the provider request. Like tool-result image ingest records, these are rolled
  // back with failed generation attempts.
  ts: string;
  type: 'user_image_ingest_record';
  genseq: number;
  msgId?: string;
  artifact: ToolResultImageArtifact;
  provider: string;
  model: string;
  disposition: ToolResultImageDisposition;
  message: string;
  detail?: string;
  sourceTag?: 'priming_script';
}

export interface SideDialogRequestRecord extends RootGenerationRef {
  ts: string;
  type: 'sideDialog_request_record';
  genseq: number;
  mentionList: string[];
  tellaskContent: string;
  sideDialogId: string;
  sourceTag?: 'priming_script';
}

export interface TellaskReplyResolutionRecord extends RootGenerationRef {
  ts: string;
  type: 'tellask_reply_resolution_record';
  genseq: number;
  callId: string;
  replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  targetCallId: string;
  sourceTag?: 'priming_script';
}

type TellaskCallAnchorRecordBase = {
  ts: string;
  type: 'tellask_call_anchor_record';
  rootCourse: RootCourseNumber;
  rootGenseq: RootGenerationSeqNumber;
  callId: string;
  genseq: number;
  assignmentCourse?: AssignmentCourseNumber;
  assignmentGenseq?: AssignmentGenerationSeqNumber;
  sourceTag?: 'priming_script';
};

export type TellaskCallAnchorRecord =
  | (TellaskCallAnchorRecordBase & {
      anchorRole: 'assignment';
      callerDialogId?: undefined;
      callerCourse?: undefined;
    })
  | (TellaskCallAnchorRecordBase & {
      anchorRole: 'response';
      callerDialogId: string;
      callerCourse: CallerCourseNumber;
    });

export type TellaskCarryoverRecord =
  | (RootGenerationRef & {
      ts: string;
      type: 'tellask_carryover_record';
      genseq: number;
      // Provenance only: where the original tellask call was issued.
      originCourse: CallingCourseNumber;
      // Ownership: the latest/current course that now stores the canonical carryover context.
      carryoverCourse: DialogCourseNumber;
      responderId: string;
      callName: 'tellask';
      sessionSlug: string;
      mentionList: string[];
      tellaskContent: string;
      status: 'completed' | 'failed';
      response: string;
      // Canonical latest-course carryover payload. UI/LLM should read this directly instead of
      // treating it as a tool-result pair for an older-course call.
      content: string;
      contentItems?: FuncResultContentItem[];
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
      sourceTag?: 'priming_script';
    })
  | (RootGenerationRef & {
      ts: string;
      type: 'tellask_carryover_record';
      genseq: number;
      // Provenance only: where the original tellask call was issued.
      originCourse: CallingCourseNumber;
      // Ownership: the latest/current course that now stores the canonical carryover context.
      carryoverCourse: DialogCourseNumber;
      responderId: string;
      callName: 'askHuman';
      tellaskContent: string;
      status: 'completed' | 'failed';
      response: string;
      // Canonical latest-course carryover payload. UI/LLM should read this directly instead of
      // treating it as a tool-result pair for an older-course call.
      content: string;
      contentItems?: FuncResultContentItem[];
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
      sourceTag?: 'priming_script';
    })
  | (RootGenerationRef & {
      ts: string;
      type: 'tellask_carryover_record';
      genseq: number;
      // Provenance only: where the original tellask call was issued.
      originCourse: CallingCourseNumber;
      // Ownership: the latest/current course that now stores the canonical carryover context.
      carryoverCourse: DialogCourseNumber;
      responderId: string;
      callName: 'tellaskSessionless';
      mentionList: string[];
      tellaskContent: string;
      status: 'completed' | 'failed';
      response: string;
      // Canonical latest-course carryover payload. UI/LLM should read this directly instead of
      // treating it as a tool-result pair for an older-course call.
      content: string;
      contentItems?: FuncResultContentItem[];
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
      sourceTag?: 'priming_script';
    })
  | (RootGenerationRef & {
      ts: string;
      type: 'tellask_carryover_record';
      genseq: number;
      // Provenance only: where the original tellask call was issued.
      originCourse: CallingCourseNumber;
      // Ownership: the latest/current course that now stores the canonical carryover context.
      carryoverCourse: DialogCourseNumber;
      responderId: string;
      callName: 'freshBootsReasoning';
      tellaskContent: string;
      status: 'completed' | 'failed';
      response: string;
      // Canonical latest-course carryover payload. UI/LLM should read this directly instead of
      // treating it as a tool-result pair for an older-course call.
      content: string;
      contentItems?: FuncResultContentItem[];
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeDialogId?: string;
      calleeCourse?: CalleeCourseNumber;
      calleeGenseq?: CalleeGenerationSeqNumber;
      sourceTag?: 'priming_script';
    });

export interface GenStartRecord extends RootGenerationRef {
  ts: string;
  type: 'gen_start_record';
  genseq: number;
  sourceTag?: 'priming_script';
}

export interface GenFinishRecord extends RootGenerationRef {
  ts: string;
  type: 'gen_finish_record';
  genseq: number;
  contextHealth?: ContextHealthSnapshot;
  llmGenModel?: string;
  sourceTag?: 'priming_script';
}

export interface SideDialogCreatedRecord extends RootGenerationAnchor {
  ts: string;
  type: 'sideDialog_created_record';
  sideDialogId: string;
  askerDialogId: string;
  agentId: string;
  taskDocPath: string;
  createdAt: string;
  sessionSlug?: string;
  assignmentFromAsker: {
    callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
    mentionList?: string[];
    tellaskContent: string;
    originMemberId: string;
    callerDialogId: string;
    callId: string;
    collectiveTargets?: string[];
    effectiveFbrEffort?: number;
  };
}

export interface RemindersReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'reminders_reconciled_record';
  reminders: ReminderSnapshotItem[];
}

export interface Questions4HumanReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'questions4human_reconciled_record';
  questions: HumanQuestion[];
}

export interface PendingSideDialogsReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'pending_sideDialogs_reconciled_record';
  pendingSideDialogs: PendingSideDialogStateRecord[];
}

export interface SideDialogRegistryReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'sideDialog_registry_reconciled_record';
  entries: SideDialogRegistryStateRecord[];
}

export interface SideDialogResponsesReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'sideDialog_responses_reconciled_record';
  responses: SideDialogResponseStateRecord[];
}

export interface ReminderStateFile {
  reminders: Array<{
    id: string;
    content: string;
    ownerName?: string;
    meta?: JsonValue;
    echoback?: boolean;
    scope?: 'dialog' | 'personal' | 'agent_shared';
    renderMode?: 'plain' | 'markdown';
    createdAt: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  updatedAt: string;
}

export interface HumanQuestion {
  id: string;
  tellaskContent: string;
  askedAt: string;
  callId: string;
  callSiteRef: {
    course: number;
    messageIndex: number;
    callingGenseq?: CallingGenerationSeqNumber;
  };
}

export interface Questions4HumanFile {
  questions: HumanQuestion[];
  updatedAt: string;
}

export interface DialogDirectoryStructure {
  rootPath: string;
  statusDir: 'run' | 'done' | 'archive';
  selfId: string;
  rootId: string;
  isSideDialog: boolean;
  metadataPath: string;
  latestPath: string;
  courseCurrPath: string;
  remindersPath: string;
  questionsPath: string;
  courseJsonlPattern: string;
  courseYamlPattern: string;
  sideDialogsPath?: string;
}

export interface DialogListItem {
  id: string;
  selfId: string;
  rootId: string;
  agentId: string;
  taskDocPath: string;
  status: 'active' | 'completed' | 'archived';
  createdAt: string;
  lastModified: string;
  currentCourse: number;
  messageCount: number;
  sideDialogCount: number;
  preview?: string;
  askerDialogId?: string;
  sessionSlug?: string;
  assignmentFromAsker?: {
    callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
    mentionList?: string[];
    tellaskContent: string;
    originMemberId: string;
    callerDialogId: string;
    callId: string;
  };
}

export type PersistedDialogRecord =
  | AgentThoughtRecord
  | AgentWordsRecord
  | UiOnlyMarkdownRecord
  | RuntimeGuideRecord
  | FuncCallRecord
  | TellaskCallRecord
  | TellaskResultRecord
  | WebSearchCallRecord
  | NativeToolCallRecord
  | HumanTextRecord
  | FuncResultRecord
  | ToolResultImageIngestRecord
  | UserImageIngestRecord
  | SideDialogRequestRecord
  | TellaskReplyResolutionRecord
  | TellaskCallAnchorRecord
  | TellaskCarryoverRecord
  | GenStartRecord
  | GenFinishRecord
  | SideDialogCreatedRecord
  | RemindersReconciledRecord
  | Questions4HumanReconciledRecord
  | PendingSideDialogsReconciledRecord
  | SideDialogRegistryReconciledRecord
  | SideDialogResponsesReconciledRecord;
