// Wire Protocol Types for Dominds WebUI
// Network communication protocols and message definitions

import type { TypedDialogEvent } from './dialog';
import type { LanguageCode } from './language';
import type {
  ClearResolvedProblemsRequest,
  ClearResolvedProblemsResultMessage,
  GetProblemsRequest,
  ProblemsSnapshotMessage,
} from './problems';

export type {
  ClearResolvedProblemsRequest,
  ClearResolvedProblemsResultMessage,
  GetProblemsRequest,
  ProblemsSnapshotMessage,
} from './problems';

export type DialogStatusKind = 'running' | 'completed' | 'archived';

// Dialog Identification Structure
export interface DialogIdent {
  selfId: string;
  rootId: string;
  // Persistence status directory of this dialog tree.
  // Callers should always provide it for read/navigation operations.
  status?: DialogStatusKind;
}

export interface AssignmentFromSup {
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  collectiveTargets?: string[];
  effectiveFbrEffort?: number;
}

// Utility function to create DialogIdent from various formats
export function createDialogIdent(
  selfId: string,
  rootId?: string,
  status?: DialogStatusKind,
): DialogIdent {
  return status
    ? {
        selfId,
        rootId: rootId || selfId,
        status,
      }
    : {
        selfId,
        rootId: rootId || selfId,
      };
}

// WebSocket Protocol Discriminated Union for Dominds WebUI
export type WebSocketMessage =
  | WelcomeMessage
  | DomindsRuntimeStatusMessage
  | ErrorMessage
  | SetUiLanguageRequest
  | UiLanguageSetMessage
  | TeamConfigUpdatedMessage
  | GetProblemsRequest
  | ClearResolvedProblemsRequest
  | ProblemsSnapshotMessage
  | ClearResolvedProblemsResultMessage
  | CreateDialogRequest
  | DisplayDialogRequest
  | SetDiligencePushRequest
  | RefillDiligencePushBudgetRequest
  | DiligencePushUpdatedMessage
  | GetQ4HStateRequest
  | Q4HStateResponse
  | DialogsMovedMessage
  | DialogsDeletedMessage
  | DialogsCreatedMessage
  | RunControlRefreshMessage
  | RunControlCountsMessage
  | InterruptDialogRequest
  | EmergencyStopRequest
  | ResumeDialogRequest
  | ResumeAllRequest
  | DeclareSubdialogDeadRequest
  | DisplayRemindersRequest
  | DisplayCourseRequest
  | DriveDialogRequest
  | DriveDialogByUserAnswer
  | DialogReadyMessage
  | TypedDialogEvent;

// Connection and Status Messages
export type DomindsRuntimeMode = 'development' | 'production';

export type DomindsSelfUpdateRunKind = 'disabled' | 'npm_global' | 'npx_latest';
export type DomindsSelfUpdateAction = 'none' | 'install' | 'restart';
export type DomindsSelfUpdateBusy = 'idle' | 'installing' | 'restarting';
export type DomindsSelfUpdateReason =
  | 'dev_mode'
  | 'latest_check_failed'
  | 'install_available'
  | 'restart_required'
  | 'restart_available_via_npx'
  | null;

export interface DomindsSelfUpdateStatus {
  enabled: boolean;
  mode: DomindsRuntimeMode;
  currentVersion: string;
  installedVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  runKind: DomindsSelfUpdateRunKind;
  action: DomindsSelfUpdateAction;
  busy: DomindsSelfUpdateBusy;
  reason: DomindsSelfUpdateReason;
  message: string | null;
  targetVersion: string | null;
}

export interface DomindsRuntimeStatus {
  workspace: string;
  version: string;
  mode: DomindsRuntimeMode;
  selfUpdate: DomindsSelfUpdateStatus;
}

export interface WelcomeMessage {
  type: 'welcome';
  message: string;
  serverWorkLanguage: LanguageCode;
  supportedLanguageCodes: LanguageCode[];
  runtimeStatus: DomindsRuntimeStatus;
  timestamp: string;
}

export interface DomindsRuntimeStatusMessage {
  type: 'dominds_runtime_status';
  runtimeStatus: DomindsRuntimeStatus;
  timestamp: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export function parseWebSocketMessage(raw: string): WebSocketMessage {
  return JSON.parse(raw) as WebSocketMessage;
}

export interface SetUiLanguageRequest {
  type: 'set_ui_language';
  uiLanguage: LanguageCode;
}

export interface UiLanguageSetMessage {
  type: 'ui_language_set';
  uiLanguage: LanguageCode;
}

export interface TeamConfigUpdatedMessage {
  type: 'team_config_updated';
  path: string;
  exists: boolean;
  timestamp: string;
  trigger?: string;
}

// Team and Dialog Management Messages

export type CreateDialogErrorCode =
  | 'TEAM_NOT_READY'
  | 'TEAM_MEMBER_INVALID'
  | 'TASKDOC_INVALID'
  | 'AUTH_REQUIRED'
  | 'CREATE_FAILED';

export interface DialogPrimingInput {
  scriptRefs: string[];
  showInUi: boolean;
}

export interface CreateDialogInput {
  requestId: string;
  agentId: string;
  taskDocPath: string;
  priming?: DialogPrimingInput;
}

export interface CreateDialogRequest extends CreateDialogInput {
  type: 'create_dialog';
}

export interface CreateDialogSuccess {
  kind: 'success';
  requestId: string;
  selfId: string;
  rootId: string;
  agentId: string;
  taskDocPath: string;
}

export interface CreateDialogFailure {
  kind: 'failure';
  requestId: string;
  errorCode: CreateDialogErrorCode;
  error: string;
}

export type CreateDialogResult = CreateDialogSuccess | CreateDialogFailure;

export interface DisplayDialogRequest {
  type: 'display_dialog';
  dialog: DialogIdent;
}

export interface SetDiligencePushRequest {
  type: 'set_diligence_push';
  dialog: DialogIdent;
  disableDiligencePush: boolean;
}

export interface RefillDiligencePushBudgetRequest {
  type: 'refill_diligence_push_budget';
  dialog: DialogIdent;
}

export interface DiligencePushUpdatedMessage {
  type: 'diligence_push_updated';
  dialog: DialogIdent;
  disableDiligencePush: boolean;
  timestamp: string;
}

export interface DriveDialogRequest {
  type: 'drive_dlg_by_user_msg';
  dialog: DialogIdent;
  content: string;
  msgId: string;
  userLanguageCode: LanguageCode;
}

export interface DriveDialogByUserAnswer {
  type: 'drive_dialog_by_user_answer';
  dialog: DialogIdent;
  content: string;
  msgId: string;
  questionId: string;
  continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
  userLanguageCode: LanguageCode;
}

export interface InterruptDialogRequest {
  type: 'interrupt_dialog';
  dialog: DialogIdent;
}

export interface EmergencyStopRequest {
  type: 'emergency_stop';
}

export interface ResumeDialogRequest {
  type: 'resume_dialog';
  dialog: DialogIdent;
}

export interface ResumeAllRequest {
  type: 'resume_all';
}

export interface DeclareSubdialogDeadRequest {
  type: 'declare_subdialog_dead';
  dialog: DialogIdent;
  note?: string;
}

export interface DisplayRemindersRequest {
  type: 'display_reminders';
  dialog: DialogIdent;
}

export interface DisplayCourseRequest {
  type: 'display_course';
  dialog: DialogIdent;
  course: number;
}

export interface GetQ4HStateRequest {
  type: 'get_q4h_state';
}

export interface Q4HStateResponse {
  type: 'q4h_state_response';
  questions: Array<{
    id: string;
    selfId: string;
    rootId: string;
    agentId: string;
    taskDocPath: string;
    tellaskContent: string;
    askedAt: string;
    callId: string;
    callSiteRef: {
      course: number;
      messageIndex: number;
    };
  }>;
}

export type DialogsMovedScope =
  | { kind: 'root'; rootId: string }
  | { kind: 'task'; taskDocPath: string };

export interface DialogsMovedMessage {
  type: 'dialogs_moved';
  scope: DialogsMovedScope;
  fromStatus: DialogStatusKind;
  toStatus: DialogStatusKind;
  movedRootIds: string[];
  timestamp: string;
}

export type DialogsDeletedScope =
  | { kind: 'root'; rootId: string }
  | { kind: 'task'; taskDocPath: string };

export interface DialogsDeletedMessage {
  type: 'dialogs_deleted';
  scope: DialogsDeletedScope;
  fromStatus: DialogStatusKind;
  deletedRootIds: string[];
  timestamp: string;
}

export type DialogsCreatedScope =
  | { kind: 'root'; rootId: string }
  | { kind: 'task'; taskDocPath: string };

export interface DialogsCreatedMessage {
  type: 'dialogs_created';
  scope: DialogsCreatedScope;
  status: DialogStatusKind;
  createdRootIds: string[];
  timestamp: string;
}

export type RunControlRefreshReason =
  | 'resume_all'
  | 'emergency_stop'
  | 'run_state_marker_resumed'
  | 'run_state_marker_interrupted';

export interface RunControlRefreshMessage {
  type: 'run_control_refresh';
  reason: RunControlRefreshReason;
  timestamp: string;
}

export interface RunControlCountsMessage {
  type: 'run_control_counts_evt';
  proceeding: number;
  resumable: number;
  timestamp: string;
}

export interface DialogReadyMessage {
  type: 'dialog_ready';
  dialog: DialogIdent;
  agentId: string;
  taskDocPath: string;
  supdialogId?: string;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
  disableDiligencePush?: boolean;
  diligencePushMax?: number;
  diligencePushRemainingBudget?: number;
}
