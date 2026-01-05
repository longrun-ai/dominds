// Wire Protocol Types for Dominds WebUI
// Network communication protocols and message definitions

import type { TypedDialogEvent } from './dialog';

// Dialog Identification Structure
export interface DialogIdent {
  selfId: string;
  rootId: string;
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
  | CreateDialogRequest
  | DisplayDialogRequest
  | GetQ4HStateRequest
  | Q4HStateResponse
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
}

export interface ErrorMessage {
  type: 'error';
  message: string;
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
}

export interface DriveDialogByUserAnswer {
  type: 'drive_dialog_by_user_answer';
  dialog: DialogIdent;
  content: string;
  msgId: string;
  questionId: string;
  continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
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

export interface DialogReadyMessage {
  type: 'dialog_ready';
  dialog: DialogIdent;
  agentId: string;
  taskDocPath: string;
}
