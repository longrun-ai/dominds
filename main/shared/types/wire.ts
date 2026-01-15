// Wire Protocol Types for Dominds WebUI
// Network communication protocols and message definitions

import type { TypedDialogEvent } from './dialog';
import type { LanguageCode } from './language';

export type DialogStatusKind = 'running' | 'completed' | 'archived';

// Dialog Identification Structure
export interface DialogIdent {
  selfId: string;
  rootId: string;
}

export interface AssignmentFromSup {
  headLine: string;
  callBody: string;
  originMemberId: string;
  callerDialogId: string;
  callId: string;
}

// Utility function to create DialogIdent from various formats
export function createDialogIdent(selfId: string, rootId?: string): DialogIdent {
  return {
    selfId,
    rootId: rootId || selfId,
  };
}

// WebSocket Protocol Discriminated Union for Dominds WebUI
export type WebSocketMessage =
  | WelcomeMessage
  | ErrorMessage
  | SetUiLanguageRequest
  | UiLanguageSetMessage
  | CreateDialogRequest
  | DisplayDialogRequest
  | GetQ4HStateRequest
  | Q4HStateResponse
  | DialogsMovedMessage
  | DialogsDeletedMessage
  | InterruptDialogRequest
  | EmergencyStopRequest
  | ResumeDialogRequest
  | ResumeAllRequest
  | DisplayRemindersRequest
  | DisplayRoundRequest
  | DriveDialogRequest
  | DriveDialogByUserAnswer
  | DialogReadyMessage
  | TypedDialogEvent;

// Connection and Status Messages
export interface WelcomeMessage {
  type: 'welcome';
  message: string;
  serverWorkLanguage: LanguageCode;
  supportedLanguageCodes: LanguageCode[];
  timestamp: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface SetUiLanguageRequest {
  type: 'set_ui_language';
  uiLanguage: LanguageCode;
}

export interface UiLanguageSetMessage {
  type: 'ui_language_set';
  uiLanguage: LanguageCode;
}

// Team and Dialog Management Messages

export interface CreateDialogRequest {
  type: 'create_dialog';
  agentId?: string; // Optional - will auto-fill from default_responder if not provided
  taskDocPath: string; // Mandatory - every dialog must have a task document
}

export interface DisplayDialogRequest {
  type: 'display_dialog';
  dialog: DialogIdent;
}

export interface DriveDialogRequest {
  type: 'drive_dlg_by_user_msg';
  dialog: DialogIdent;
  content: string;
  msgId: string; // Message ID for tracking and error recovery (mandatory)
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

export interface DisplayRemindersRequest {
  type: 'display_reminders';
  dialog: DialogIdent;
}

export interface DisplayRoundRequest {
  type: 'display_round';
  dialog: DialogIdent;
  round: number;
}

export interface GetQ4HStateRequest {
  type: 'get_q4h_state';
}

export interface Q4HStateResponse {
  type: 'q4h_state_response';
  questions: Array<{
    id: string;
    dialogId: string;
    headLine: string;
    bodyContent: string;
    askedAt: string;
    callSiteRef: {
      round: number;
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

export interface DialogReadyMessage {
  type: 'dialog_ready';
  dialog: DialogIdent;
  agentId: string;
  taskDocPath: string;
  supdialogId?: string;
  topicId?: string;
  assignmentFromSup?: AssignmentFromSup;
}
