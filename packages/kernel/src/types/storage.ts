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
  metadata?: {
    itemId?: string;
    itemType?: 'reasoning';
    status?: 'in_progress' | 'completed' | 'incomplete';
  };
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
  sessionSlug?: string;
}

export type DialogMetadataFile = MainDialogMetadataFile | SideDialogMetadataFile;

export interface SideDialogAssignmentFromAsker {
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  originMemberId: string;
  askerDialogId: string;
  callId: string;
  callSiteCourse: CallSiteCourseNo;
  callSiteGenseq: CallSiteGenseqNo;
  collectiveTargets?: string[];
  effectiveFbrEffort?: number;
}

export interface AskerDialogStackFrame {
  kind: 'asker_dialog_stack_frame';
  askerDialogId: string;
  assignmentFromAsker?: SideDialogAssignmentFromAsker;
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

export type DialogCalleeReplyTarget = Readonly<{
  callerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
  callSiteCourse: CallSiteCourseNo;
  callSiteGenseq: CallSiteGenseqNo;
}>;

export type DialogPendingRuntimePrompt = DialogRuntimePrompt;

export type DialogGenerationRunState = Readonly<
  | {
      kind: 'open';
      course: DialogCourseNumber;
      genseq: CallSiteGenseqNo;
      phase: 'streaming' | 'tool_round' | 'finishing';
      acceptedTriggerIds: readonly string[];
      openedAt: string;
      msgId?: string;
    }
  | {
      kind: 'closed';
      course: DialogCourseNumber;
      genseq: CallSiteGenseqNo;
      closedAt: string;
    }
>;

export type DialogBackendDriveStallState = Readonly<{
  kind: 'backend_drive_error';
  recordId: string;
  durableWorkFingerprint: string;
  failedAt: string;
  errorName?: string;
  errorMessage: string;
}>;

export type DialogLatestAssignmentAnchorState = Readonly<{
  callId: string;
  assignmentCourse: AssignmentCourseNumber;
  assignmentGenseq: AssignmentGenerationSeqNumber;
}>;

export type DialogFollowupReason = Readonly<
  | { kind: 'ordinary_tool_result'; callIds: readonly string[] }
  | { kind: 'invalid_tool_recovery'; callIds: readonly string[] }
  | { kind: 'reply_delivery_result'; replyDeliveryId: string; replyCallId: string }
  | { kind: 'result_arrival'; batchId: string }
  | { kind: 'runtime_guidance'; msgId: string }
>;

/**
 * Business continuations must be self-contained.
 *
 * A next-step trigger is a durable handoff between driver iterations and often between process
 * lifetimes. It must carry the business identity needed for the next action. Consumers must not
 * reconstruct reply routing by scanning transcript history, assignment anchors, or other
 * opportunistic projections.
 */
export type DialogBusinessContinuation = Readonly<
  | {
      kind: 'none';
    }
  | {
      kind: 'requested_work_reply';
      callerDialogId: string;
      batchId: string;
      callSiteCourse: CallSiteCourseNo;
      callSiteGenseq: CallSiteGenseqNo;
      sideDialogId?: string;
      callType?: 'A' | 'B' | 'C';
      callId?: string;
      resolvedCallIds?: readonly string[];
      triggerCallId?: string;
    }
  | {
      kind: 'local_tellask_result';
      callerDialogId: string;
      reason: 'reply_tellask_back_delivered' | 'replaced_pending_sideDialog_reply';
    }
  | {
      kind: 'inter_dialog_reply';
      tellaskReplyDirective: TellaskReplyDirective;
      calleeDialogReplyTarget?: DialogCalleeReplyTarget;
    }
>;

export type DialogNextStepTriggerPayload = Readonly<
  | { triggerId: string; kind: 'user_input'; course: DialogCourseNumber; genseq: CallSiteGenseqNo }
  | { triggerId: string; kind: 'queued_prompt'; promptId: string; course: DialogCourseNumber }
  | {
      triggerId: string;
      kind: 'followup';
      sourceGeneration: { course: DialogCourseNumber; genseq: CallSiteGenseqNo };
      reasons: readonly DialogFollowupReason[];
      continuation?: DialogBusinessContinuation;
    }
  | {
      triggerId: string;
      kind: 'mainline_diligence';
      diligenceId: string;
      pendingTellaskCount: number;
    }
  | { triggerId: string; kind: 'result_arrival'; batchId: string }
  | {
      triggerId: string;
      kind: 'open_generation_recovery';
      course: DialogCourseNumber;
      genseq: CallSiteGenseqNo;
    }
  | {
      triggerId: string;
      kind: 'reply_delivery_recovery';
      replyDeliveryId: string;
      targetDialogId: string;
    }
>;

export type DialogNextStepTriggerDraft = Readonly<
  DialogNextStepTriggerPayload & { createdAt?: string }
>;

export type DialogNextStepTrigger = Readonly<
  DialogNextStepTriggerPayload & {
    createdAt: string;
    seq: number;
  }
>;

export type DialogNextStepTriggerState = Readonly<{
  nextSeq: number;
  triggers: readonly DialogNextStepTrigger[];
}>;

export type DialogUserWaitState = Readonly<{
  kind: 'awaiting_user_answer';
  questionId: string;
  callId: string;
  course: DialogCourseNumber;
  genseq?: CallSiteGenseqNo;
  askedAt: string;
}>;

export type DialogReplyDeliveryState = Readonly<{
  replyDeliveryId: string;
  status: 'pending' | 'delivered';
  toolResultStatus: 'pending' | 'recorded';
  expectedReplyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
  targetDialogId: string;
  targetCallId: string;
  replyCallId: string;
  replyGenseq: CallSiteGenseqNo;
  replyContent: string;
  createdAt: string;
  deliveredAt?: string;
}>;

export type DialogTellaskResultIndexEntry = Readonly<{
  callId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'tellaskBack' | 'askHuman' | 'freshBootsReasoning';
  course: DialogCourseNumber;
  recordedAt: string;
  resultRecordId: string;
}>;

export type DialogTellaskResultState = Readonly<{
  results: readonly DialogTellaskResultIndexEntry[];
}>;

export type DialogTellaskCallIndexEntry = Readonly<{
  callId: string;
  callName:
    | 'tellask'
    | 'tellaskSessionless'
    | 'tellaskBack'
    | 'replyTellask'
    | 'replyTellaskSessionless'
    | 'replyTellaskBack'
    | 'askHuman'
    | 'freshBootsReasoning';
  course: DialogCourseNumber;
  genseq: CallSiteGenseqNo;
  recordedAt: string;
  callRecordId: string;
}>;

export type DialogTellaskCallState = Readonly<{
  calls: readonly DialogTellaskCallIndexEntry[];
}>;

export interface DialogLatestFile {
  currentCourse: number;
  lastModified: string;
  messageCount?: number;
  functionCallCount?: number;
  sideDialogCount?: number;
  status: 'active' | 'completed' | 'archived';
  generating?: boolean;
  displayState?: DialogDisplayState;
  executionMarker?: DialogExecutionMarker;
  generationRunState?: DialogGenerationRunState;
  backendDriveStall?: DialogBackendDriveStallState;
  nextStep: DialogNextStepTriggerState;
  userWait?: DialogUserWaitState;
  replyDelivery?: DialogReplyDeliveryState;
  tellaskCalls: DialogTellaskCallState;
  tellaskResults: DialogTellaskResultState;
  latestAssignmentAnchor?: DialogLatestAssignmentAnchorState;
  sideDialogFinalResponse?: DialogSideDialogFinalResponseState;
  fbrState?: DialogFbrState;
  deferredReplyReassertion?: DialogDeferredReplyReassertion;
  // Durable runtime prompt that must survive restart and be consumed before ordinary
  // business-continuation driving, including new-course prompts and reply-tool reminders after
  // direct sideline replies.
  pendingRuntimePrompt?: DialogPendingRuntimePrompt;
  disableDiligencePush?: boolean;
  diligencePushRemainingBudget?: number;
}

export type DialogSideDialogFinalResponseState = Readonly<{
  callId: string;
  responseCourse: DialogCourseNumber;
  responseGenseq: CalleeGenerationSeqNumber;
  askerDialogId: string;
  askerCourse: AskerCourseNumber;
}>;

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
export type CallSiteCourseNo = number & { readonly __callSiteCourseBrand: unique symbol };
export type CallSiteGenseqNo = number & {
  readonly __callSiteGenseqBrand: unique symbol;
};
export type AssignmentCourseNumber = number & { readonly __assignmentCourseBrand: unique symbol };
export type AssignmentGenerationSeqNumber = number & {
  readonly __assignmentGenerationSeqBrand: unique symbol;
};
export type AskerCourseNumber = number & { readonly __askerCourseBrand: unique symbol };
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

export function toCallSiteCourseNo(value: number): CallSiteCourseNo {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid call-site course number: ${String(value)}`);
  }
  return Math.floor(value) as CallSiteCourseNo;
}

export function toCallSiteGenseqNo(value: number): CallSiteGenseqNo {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid call-site generation sequence number: ${String(value)}`);
  }
  return Math.floor(value) as CallSiteGenseqNo;
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

export function toAskerCourseNumber(value: number): AskerCourseNumber {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid asker course number: ${String(value)}`);
  }
  return Math.floor(value) as AskerCourseNumber;
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

export interface ActiveCalleeDispatchRecord {
  calleeDialogId: string;
  createdAt: string;
  batchId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  targetAgentId: string;
  callId: string;
  callSiteCourse: CallSiteCourseNo;
  callSiteGenseq: CallSiteGenseqNo;
  callType: 'A' | 'B' | 'C';
  sessionSlug?: string;
}

export type ActiveCalleeCompletion = Readonly<
  | { kind: 'reply_tool'; resultRecordId: string }
  | { kind: 'direct_fallback'; memo: string; resultRecordId: string }
>;

export interface ActiveCalleeRecord {
  callId: string;
  calleeDialogId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'tellaskBack' | 'freshBootsReasoning';
  status: 'pending' | 'resolved' | 'final';
  targetAgentId: string;
  tellaskContent: string;
  callType: 'A' | 'B' | 'C';
  mentionList?: string[];
  sessionSlug?: string;
  completion?: ActiveCalleeCompletion;
  createdAt: string;
  resolvedAt?: string;
}

export interface ActiveCalleeBatch {
  batchId: string;
  callSite: { course: CallSiteCourseNo; genseq: CallSiteGenseqNo };
  status: 'open' | 'resolved';
  callees: ActiveCalleeRecord[];
  createdAt: string;
  resolvedAt?: string;
}

export interface ActiveCalleesFile {
  batches: ActiveCalleeBatch[];
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
  rawId?: string;
  effectiveId?: string;
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
  callSiteCourse?: CallSiteCourseNo;
  callSiteGenseq?: CallSiteGenseqNo;
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
  rawId?: string;
  effectiveId?: string;
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

type TellaskAnchorRecordBase = {
  ts: string;
  type: 'tellask_anchor_record';
  rootCourse: RootCourseNumber;
  rootGenseq: RootGenerationSeqNumber;
  callId: string;
  genseq: number;
  assignmentCourse?: AssignmentCourseNumber;
  assignmentGenseq?: AssignmentGenerationSeqNumber;
  sourceTag?: 'priming_script';
};

export type TellaskAnchorRecord =
  | (TellaskAnchorRecordBase & {
      anchorRole: 'assignment';
      askerDialogId?: undefined;
      askerCourse?: undefined;
    })
  | (TellaskAnchorRecordBase & {
      anchorRole: 'response';
      askerDialogId: string;
      askerCourse: AskerCourseNumber;
    });

// Requester-course UI navigation metadata for a tellask call-site. `genseq`/`callId` identify
// the requester call-site bubble; the callee fields identify either the target sideDialog only or,
// once assignment delivery is known, the concrete callee `course/genseq`.
type TellaskCalleeRecordBase = RootGenerationRef & {
  ts: string;
  type: 'tellask_callee_record';
  genseq: number;
  callId: string;
  calleeDialogId: string;
  sourceTag?: 'priming_script';
};

export type TellaskCalleeRecord =
  | (TellaskCalleeRecordBase & {
      calleeCourse?: undefined;
      calleeGenseq?: undefined;
    })
  | (TellaskCalleeRecordBase & {
      calleeCourse: CalleeCourseNumber;
      calleeGenseq: CalleeGenerationSeqNumber;
    });

export type TellaskCarryoverRecord =
  | (RootGenerationRef & {
      ts: string;
      type: 'tellask_carryover_record';
      genseq: number;
      // Provenance only: where the original tellask call was issued.
      callSiteCourse: CallSiteCourseNo;
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
      callSiteCourse: CallSiteCourseNo;
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
      callSiteCourse: CallSiteCourseNo;
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
      callSiteCourse: CallSiteCourseNo;
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
  assignmentFromAsker: SideDialogAssignmentFromAsker;
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

export interface ActiveCalleesReconciledRecord extends RootGenerationAnchor {
  ts: string;
  type: 'active_callees_reconciled_record';
  activeCalleeDispatches: ActiveCalleeDispatchRecord[];
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
    callSiteGenseq?: CallSiteGenseqNo;
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
  assignmentFromAsker?: SideDialogAssignmentFromAsker;
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
  | TellaskAnchorRecord
  | TellaskCalleeRecord
  | TellaskCarryoverRecord
  | GenStartRecord
  | GenFinishRecord
  | SideDialogCreatedRecord
  | RemindersReconciledRecord
  | Questions4HumanReconciledRecord
  | ActiveCalleesReconciledRecord
  | SideDialogRegistryReconciledRecord
  | SideDialogResponsesReconciledRecord;
