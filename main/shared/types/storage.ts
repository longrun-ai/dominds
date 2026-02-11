/**
 * Module: shared/types/storage
 *
 * Strongly typed disk storage formats for dialog persistence.
 * Uses modern TypeScript patterns for statically verifiable field access.
 */

import type { ContextHealthSnapshot } from './context-health';
import type { LanguageCode } from './language';
import type { DialogRunState } from './run-state';

// === DIALOG METADATA STORAGE ===

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type ProviderData = JsonObject;

export type ToolArguments = JsonObject;

// === TOOL RESULT CONTENT ITEMS (MULTIMODAL) ===

export type FuncResultContentItem =
  | { type: 'input_text'; text: string }
  | {
      type: 'input_image';
      mimeType: string;
      byteLength: number;
      artifact: {
        rootId: string;
        selfId: string;
        // Relative to the dialog events directory (DialogPersistence.getDialogEventsPath).
        // Must start with "artifacts/".
        relPath: string;
      };
    };

export interface RootDialogMetadataFile {
  /** Unique dialog identifier (selfDlgId only) */
  id: string;

  /** Agent responsible for this dialog */
  agentId: string;

  /** Path to the Taskdoc associated with this dialog */
  taskDocPath: string;

  /** ISO timestamp when dialog was created */
  createdAt: string;

  /** Root dialogs have no parent */
  supdialogId?: undefined;

  /** Root dialogs do not have a session slug */
  sessionSlug?: undefined;

  /** Root dialogs have no assignment */
  assignmentFromSup?: undefined;

  /**
   * Inherited Agent Priming mode for newly created subdialogs under this root.
   * - `do`: always run fresh priming on subdialogs
   * - `reuse`: reuse cache when available, otherwise run priming
   * - `skip`: skip subdialog priming
   */
  subdialogAgentPrimingMode?: 'do' | 'reuse' | 'skip';
}

export interface SubdialogMetadataFile {
  /** Unique dialog identifier (selfDlgId only) */
  id: string;

  /** Agent responsible for this dialog */
  agentId: string;

  /** Path to the Taskdoc associated with this dialog */
  taskDocPath: string;

  /** ISO timestamp when dialog was created */
  createdAt: string;

  /** Parent dialog ID for subdialogs */
  supdialogId: string;

  /** Session slug for registered subdialogs (Type B) */
  sessionSlug?: string;

  /** Assignment context from supdialog for subdialogs */
  assignmentFromSup: {
    callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
    mentionList?: string[];
    tellaskContent: string;
    originMemberId: string;
    callerDialogId: string;
    callId: string;
    collectiveTargets?: string[];
  };
}

export type DialogMetadataFile = RootDialogMetadataFile | SubdialogMetadataFile;

// === LATEST STATUS STORAGE (latest.yaml) ===

export interface DialogLatestFile {
  /** Current course number (1-based) */
  currentCourse: number;

  /** ISO timestamp of last activity/modification */
  lastModified: string;

  /** Total number of messages in current course */
  messageCount?: number;

  /** Total number of function calls in current course */
  functionCallCount?: number;

  /** Total number of subdialogs created */
  subdialogCount?: number;

  /** Current status of the dialog */
  status: 'active' | 'completed' | 'archived';

  /** Whether LLM generation is currently active */
  generating?: boolean;

  /**
   * Whether the backend driver should attempt to drive this dialog.
   * This is persisted to survive process restarts and is treated as the source of truth
   * for background revival scheduling.
   */
  needsDrive?: boolean;

  /**
   * Authoritative dialog run state for WebUI controls (Send↔Stop, Continue, etc.).
   * Persisted to survive process restarts.
   */
  runState?: DialogRunState;

  /**
   * Disable Diligence Push for this dialog.
   * Persisted to survive process restarts.
   */
  disableDiligencePush?: boolean;

  /**
   * Remaining Diligence Push budget for this root dialog.
   * Persisted to survive process restarts and restore accurate UI state.
   *
   * Notes:
   * - Root dialogs only; subdialogs should leave it undefined.
   * - Always treat negative / non-finite values as 0.
   */
  diligencePushRemainingBudget?: number;
}

// === COURSE TRACKING ===

export interface CourseMetadataFile {
  /** Course number */
  course: number;

  /** ISO timestamp when course started */
  startedAt: string;

  /** ISO timestamp when course completed (if finished) */
  completedAt?: string;

  /** Number of messages in this course */
  messageCount: number;

  /** Number of function calls in this course */
  functionCallCount: number;

  /** Number of subdialogs created in this course */
  subdialogCount: number;

  /** Course status */
  status: 'active' | 'completed';

  /** Optional Taskdoc for this course */
  taskDoc?: string;
}

// === PERSISTED EVENTS ===

export type PersistedDialogRecord =
  | AgentThoughtRecord
  | AgentWordsRecord
  | UiOnlyMarkdownRecord
  | FuncCallRecord
  | WebSearchCallRecord
  | HumanTextRecord
  | FuncResultRecord
  | QuestForSupRecord
  | TeammateCallResultRecord
  | TeammateCallAnchorRecord
  | TeammateResponseRecord
  | GenStartRecord
  | GenFinishRecord;

export interface AgentThoughtRecord {
  ts: string;
  type: 'agent_thought_record';
  genseq: number;
  content: string;
  provider_data?: ProviderData;
}

export interface AgentWordsRecord {
  ts: string;
  type: 'agent_words_record';
  genseq: number;
  content: string;
}

/**
 * UI-only assistant markdown.
 *
 * - Persisted for timeline fidelity and course replay.
 * - Must NOT be injected into LLM context.
 * - Replayed as markdown-only (no tellask parsing).
 */
export interface UiOnlyMarkdownRecord {
  ts: string;
  type: 'ui_only_markdown_record';
  genseq: number;
  content: string;
}

export interface FuncCallRecord {
  ts: string;
  type: 'func_call_record';
  genseq: number;
  id: string;
  name: string;
  arguments: ToolArguments;
}

export type WebSearchCallActionRecord =
  | { type: 'search'; query?: string }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export interface WebSearchCallRecord {
  ts: string;
  type: 'web_search_call_record';
  genseq: number;
  phase: 'added' | 'done';
  itemId?: string;
  status?: string;
  action?: WebSearchCallActionRecord;
}

export interface HumanTextRecord {
  ts: string;
  type: 'human_text_record';
  genseq: number;
  msgId: string;
  content: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
}

export interface FuncResultRecord {
  ts: string;
  type: 'func_result_record';
  genseq: number; // matching FuncCallRecord's genseq
  id: string;
  name: string;
  content: string;
  contentItems?: FuncResultContentItem[];
}

export interface QuestForSupRecord {
  ts: string;
  type: 'quest_for_sup_record';
  genseq: number;
  mentionList: string[];
  tellaskContent: string;
  subDialogId: string; // this is selfId, rootId always be the same as selfId of the supdialog
}

export interface TeammateCallResultRecord {
  ts: string;
  type: 'teammate_call_result_record';
  calling_genseq?: number;
  responderId: string;
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  result: string;
  callId: string;
}

// Anchor record in callee dialog for locating assignment/response bubbles by tellask callId.
export interface TeammateCallAnchorRecord {
  ts: string;
  type: 'teammate_call_anchor_record';
  anchorRole: 'assignment' | 'response';
  callId: string;
  genseq: number;
  assignmentCourse?: number;
  assignmentGenseq?: number;
  callerDialogId?: string;
  callerCourse?: number;
}

// Teammate response record - separate bubble for @teammate tellasks
// calleeDialogId: ID of the callee dialog (subdialog or supdialog being called)
export interface TeammateResponseRecord {
  ts: string;
  type: 'teammate_response_record';
  calling_genseq?: number;
  responderId: string;
  calleeDialogId?: string; // ID of the callee dialog (subdialog OR supdialog)
  calleeCourse?: number;
  calleeGenseq?: number;
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  response: string; // raw full response text for UI-only formatting
  agentId: string;
  callId: string; // For navigation from response back to call site
  originMemberId: string;
}

export interface GenStartRecord {
  ts: string;
  type: 'gen_start_record';
  genseq: number;
}

export interface GenFinishRecord {
  ts: string;
  type: 'gen_finish_record';
  genseq: number;
  contextHealth?: ContextHealthSnapshot;
  llmGenModel?: string;
}

// === REMINDER AND QUESTIONS STORAGE ===

export interface ReminderStateFile {
  reminders: Array<{
    id: string;
    content: string;
    /**
     * Optional ReminderOwner name used to rehydrate owned reminders after restart.
     * When present, the backend should resolve it via the ReminderOwner registry.
     */
    ownerName?: string;
    /**
     * Optional reminder metadata. Intended for UI display and owner lifecycle.
     * Must be JSON-serializable.
     */
    meta?: JsonValue;
    createdAt: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  updatedAt: string;
}

export interface HumanQuestion {
  id: string;
  tellaskContent: string;
  askedAt: string;
  /**
   * Optional callId when this Q4H originates from an `askHuman` function call.
   * Some system-generated Q4H questions may not have a callId.
   */
  callId?: string;
  /**
   * Optional metadata for merged multi-question Q4H:
   * when one displayed question aggregates multiple parsed tellask calls,
   * `callId` is the primary (first) call and the remaining source callIds
   * are carried here in parser order.
   */
  remainingCallIds?: string[];
  callSiteRef: {
    course: number;
    messageIndex: number;
  };
}

export interface Questions4HumanFile {
  questions: HumanQuestion[];
  updatedAt: string;
}

// === DIALOG DIRECTORY STRUCTURE ===

export interface DialogDirectoryStructure {
  /** Root dialog directory path */
  rootPath: string;

  /** Status subdirectory (run/done/archive) */
  statusDir: 'run' | 'done' | 'archive';

  /** Self dialog ID */
  selfId: string;

  /** Root dialog ID (same as selfId for root dialogs) */
  rootId: string;

  /** Whether this is a subdialog */
  isSubdialog: boolean;

  /** Path to dialog.yaml */
  metadataPath: string;

  /** Path to latest.yaml */
  latestPath: string;

  /** Path to course.curr */
  courseCurrPath: string;

  /** Path to reminders.json */
  remindersPath: string;

  /** Path to questions-for-human.json */
  questionsPath: string;

  /** Pattern for course JSONL files */
  courseJsonlPattern: string;

  /** Pattern for course YAML metadata files */
  courseYamlPattern: string;

  /** Path to subdialogs directory (for root dialogs only) */
  subdialogsPath?: string;
}

// === UI DISPLAY TYPES ===

export interface DialogListItem {
  /** Dialog identification */
  id: string;
  selfId: string;
  rootId: string;

  /** Basic metadata */
  agentId: string;
  taskDocPath: string;
  status: 'active' | 'completed' | 'archived';

  /** Timestamps for UI display */
  createdAt: string;
  lastModified: string;

  /** Current state */
  currentCourse: number;
  messageCount: number;
  subdialogCount: number;

  /** Optional preview content */
  preview?: string;

  /** Parent dialog info for subdialogs */
  supdialogId?: string;
  /** Session slug for registered subdialogs (Type B) */
  sessionSlug?: string;
  assignmentFromSup?: {
    callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
    mentionList?: string[];
    tellaskContent: string;
    originMemberId: string;
    callerDialogId: string;
    callId: string;
  };
}

// always use switch statement for descriminated unions as modern typescript idiom,
// no type guards and other helper functions should be defined and used
