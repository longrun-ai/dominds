/**
 * Module: shared/types/storage
 *
 * Strongly typed disk storage formats for dialog persistence.
 * Uses modern TypeScript patterns for statically verifiable field access.
 */

// === DIALOG METADATA STORAGE ===

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type ProviderData = JsonObject;

export type ToolArguments = JsonObject;

export interface DialogMetadataFile {
  /** Unique dialog identifier (selfDlgId only) */
  id: string;

  /** Agent responsible for this dialog */
  agentId: string;

  /** Path to the task document associated with this dialog */
  taskDocPath: string;

  /** ISO timestamp when dialog was created */
  createdAt: string;

  /** Parent dialog ID for subdialogs */
  supdialogId?: string;

  /** Assignment context from parent dialog for subdialogs */
  assignmentFromSup?: {
    headLine: string;
    callBody: string;
    originRole: 'user' | 'assistant';
    originMemberId?: string;
  };
}

// === LATEST STATUS STORAGE (latest.yaml) ===

export interface DialogLatestFile {
  /** Current round number (1-based) */
  currentRound: number;

  /** ISO timestamp of last activity/modification */
  lastModified: string;

  /** Total number of messages in current round */
  messageCount?: number;

  /** Total number of function calls in current round */
  functionCallCount?: number;

  /** Total number of subdialogs created */
  subdialogCount?: number;

  /** Current status of the dialog */
  status: 'active' | 'completed' | 'archived';

  /** Whether LLM generation is currently active */
  generating?: boolean;
}

// === ROUND TRACKING ===

export interface RoundMetadataFile {
  /** Round number */
  round: number;

  /** ISO timestamp when round started */
  startedAt: string;

  /** ISO timestamp when round completed (if finished) */
  completedAt?: string;

  /** Number of messages in this round */
  messageCount: number;

  /** Number of function calls in this round */
  functionCallCount: number;

  /** Number of subdialogs created in this round */
  subdialogCount: number;

  /** Round status */
  status: 'active' | 'completed';

  /** Optional task document for this round */
  taskDoc?: string;
}

// === PERSISTED EVENTS ===

export type PersistedDialogRecord =
  | AgentThoughtRecord
  | AgentWordsRecord
  | FuncCallRecord
  | HumanTextRecord
  | FuncResultRecord
  | QuestForSupRecord
  | ToolCallResultRecord
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

export interface FuncCallRecord {
  ts: string;
  type: 'func_call_record';
  genseq: number;
  id: string;
  name: string;
  arguments: ToolArguments;
}

export interface HumanTextRecord {
  ts: string;
  type: 'human_text_record';
  genseq: number;
  msgId: string;
  content: string;
}

export interface FuncResultRecord {
  ts: string;
  type: 'func_result_record';
  genseq: number; // matching FuncCallRecord's genseq
  id: string;
  name: string;
  content: string;
}

export interface QuestForSupRecord {
  ts: string;
  type: 'quest_for_sup_record';
  genseq: number;
  headLine: string;
  callBody: string;
  subDialogId: string; // this is selfId, rootId always be the same as selfId of the supdialog
}

export interface ToolCallResultRecord {
  ts: string;
  type: 'tool_call_result_record';
  calling_genseq?: number;
  responderId: string;
  headLine: string;
  status: 'completed' | 'failed';
  result: string;
  callId: string; // Content-hash for replay correlation
}

// Teammate response record - separate bubble for @teammate calls
// calleeDialogId: ID of the callee dialog (subdialog or supdialog being called)
export interface TeammateResponseRecord {
  ts: string;
  type: 'teammate_response_record';
  calling_genseq?: number;
  responderId: string;
  calleeDialogId?: string; // ID of the callee dialog (subdialog OR supdialog)
  headLine: string;
  status: 'completed' | 'failed';
  result: string;
  summary?: string; // merged from subdialog_final_summary_evt
  agentId?: string; // merged from subdialog_final_summary_evt
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
}

// === REMINDER AND QUESTIONS STORAGE ===

export interface ReminderStateFile {
  reminders: Array<{
    id: string;
    content: string;
    createdAt: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  updatedAt: string;
}

export interface HumanQuestion {
  id: string;
  headLine: string;
  bodyContent: string;
  askedAt: string;
  callSiteRef: {
    round: number;
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

  /** Path to round.curr */
  roundCurrPath: string;

  /** Path to reminders.json */
  remindersPath: string;

  /** Path to questions-for-human.json */
  questionsPath: string;

  /** Pattern for round JSONL files */
  roundJsonlPattern: string;

  /** Pattern for round YAML metadata files */
  roundYamlPattern: string;

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
  currentRound: number;
  messageCount: number;
  subdialogCount: number;

  /** Optional preview content */
  preview?: string;

  /** Parent dialog info for subdialogs */
  supdialogId?: string;
  assignmentFromSup?: {
    headLine: string;
    callBody: string;
    originRole: 'user' | 'assistant';
    originMemberId?: string;
  };
}

// always use switch statement for descriminated unions as modern typescript idiom,
// no type guards and other helper functions should be defined and used
