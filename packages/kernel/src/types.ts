export * from './types/chat-message';
export * from './types/context-health';
export * from './types/dialog';
export * from './types/display-state';
export * from './types/drive-intent';
export * from './types/i18n';
export * from './types/language';
export * from './types/priming';
export type {
  ProblemI18nText,
  ProblemSeverity,
  WorkspaceProblem,
  WorkspaceProblemLifecycle,
  WorkspaceProblemRecord,
} from './types/problems';
export * from './types/q4h';
export * from './types/setup';
export * from './types/snippets';
export * from './types/storage';
export * from './types/taskdoc';
export * from './types/tools-registry';
export * from './types/wire';

import type { DialogDisplayState } from './types/display-state';
import type { AssignmentFromAsker, DialogStatusKind } from './types/wire';

export interface DialogInfo {
  selfId: string;
  rootId: string;
  agentId: string;
  agentName: string;
  taskDocPath: string;
  status?: Exclude<DialogStatusKind, 'quarantining'>;
  askerDialogId?: string;
  sessionSlug?: string;
  assignmentFromAsker?: AssignmentFromAsker;
}

export interface ApiMainDialogResponse {
  rootId: string;
  selfId?: string;
  agentId: string;
  taskDocPath: string;
  status: Exclude<DialogStatusKind, 'quarantining'>;
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  displayState?: DialogDisplayState;
  askerDialogId?: string;
  sessionSlug?: string;
  assignmentFromAsker?: AssignmentFromAsker;
  waitingForFreshBootsReasoning?: boolean;
  sideDialogCount?: number;
}

export interface ApiSideDialogResponse {
  selfId: string;
  rootId: string;
  askerDialogId?: string;
  agentId: string;
  taskDocPath: string;
  status: Exclude<DialogStatusKind, 'quarantining'>;
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  displayState?: DialogDisplayState;
  sessionSlug?: string;
  assignmentFromAsker?: AssignmentFromAsker;
  waitingForFreshBootsReasoning?: boolean;
}

export interface ApiDialogListSideDialogNode {
  selfId: string;
  rootId: string;
  rootSideDialogCount: number;
  askerDialogId?: string;
  agentId: string;
  taskDocPath: string;
  status: Exclude<DialogStatusKind, 'quarantining'>;
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  displayState?: DialogDisplayState;
  sessionSlug?: string;
  assignmentFromAsker?: AssignmentFromAsker;
  waitingForFreshBootsReasoning?: boolean;
}

export interface ApiDialogListSideDialogNodeResponse {
  success: boolean;
  sideDialogNode: ApiDialogListSideDialogNode;
}

export interface ApiDialogHierarchyResponse {
  success: boolean;
  hierarchy: {
    root: {
      id: string;
      agentId: string;
      taskDocPath: string;
      status: Exclude<DialogStatusKind, 'quarantining'>;
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      sideDialogCount: number;
      displayState?: DialogDisplayState;
      waitingForFreshBootsReasoning?: boolean;
    };
    sideDialogs: ApiSideDialogResponse[];
  };
}

export interface ApiDialogListResponse {
  success: boolean;
  dialogs: ApiMainDialogResponse[];
}

export type ApiMoveDialogsRequest =
  | {
      kind: 'root';
      rootId: string;
      fromStatus: Exclude<DialogStatusKind, 'quarantining'>;
      toStatus: Exclude<DialogStatusKind, 'quarantining'>;
    }
  | {
      kind: 'task';
      taskDocPath: string;
      fromStatus: Exclude<DialogStatusKind, 'quarantining'>;
      toStatus: Exclude<DialogStatusKind, 'quarantining'>;
    };

export interface ApiMoveDialogsResponse {
  success: boolean;
  movedRootIds?: string[];
  error?: string;
}

export interface ApiForkDialogRequest {
  course: number;
  genseq: number;
  status?: Exclude<DialogStatusKind, 'quarantining'>;
}

export type ApiForkDialogAction =
  | {
      kind: 'draft_user_text';
      userText: string;
    }
  | {
      kind: 'restore_pending';
      pendingQ4H: boolean;
      pendingSideDialogs: boolean;
    }
  | {
      kind: 'auto_continue';
    };

export interface ApiForkDialogResponse {
  success: boolean;
  dialog?: DialogInfo;
  action?: ApiForkDialogAction;
  error?: string;
}
