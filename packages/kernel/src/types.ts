export * from './types/chat-message';
export * from './types/context-health';
export * from './types/dialog';
export * from './types/display-state';
export * from './types/drive-intent';
export * from './types/i18n';
export * from './types/language';
export * from './types/priming';
export type {
  ProblemSeverity,
  WorkspaceProblem,
  WorkspaceProblemLifecycle,
  WorkspaceProblemRecord,
} from './types/problems';
export * from './types/q4h';
export * from './types/setup';
export * from './types/snippets';
export * from './types/storage';
export * from './types/tools-registry';
export * from './types/wire';

import type { DialogDisplayState } from './types/display-state';
import type { AssignmentFromSup, DialogStatusKind } from './types/wire';

export interface DialogInfo {
  selfId: string;
  rootId: string;
  agentId: string;
  agentName: string;
  taskDocPath: string;
  status?: DialogStatusKind;
  supdialogId?: string;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
}

export interface ApiRootDialogResponse {
  rootId: string;
  selfId?: string;
  agentId: string;
  taskDocPath: string;
  status: 'running' | 'completed' | 'archived';
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  displayState?: DialogDisplayState;
  supdialogId?: string;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
  subdialogCount?: number;
}

export interface ApiSubdialogResponse {
  selfId: string;
  rootId: string;
  supdialogId?: string;
  agentId: string;
  taskDocPath: string;
  status: 'running' | 'completed' | 'archived';
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  displayState?: DialogDisplayState;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
}

export interface ApiDialogHierarchyResponse {
  success: boolean;
  hierarchy: {
    root: {
      id: string;
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      displayState?: DialogDisplayState;
    };
    subdialogs: ApiSubdialogResponse[];
  };
}

export interface ApiDialogListResponse {
  success: boolean;
  dialogs: ApiRootDialogResponse[];
}

export type ApiMoveDialogsRequest =
  | {
      kind: 'root';
      rootId: string;
      fromStatus: DialogStatusKind;
      toStatus: DialogStatusKind;
    }
  | {
      kind: 'task';
      taskDocPath: string;
      fromStatus: DialogStatusKind;
      toStatus: DialogStatusKind;
    };

export interface ApiMoveDialogsResponse {
  success: boolean;
  movedRootIds?: string[];
  error?: string;
}

export interface ApiForkDialogRequest {
  course: number;
  genseq: number;
  status?: DialogStatusKind;
}

export type ApiForkDialogAction =
  | {
      kind: 'draft_user_text';
      userText: string;
    }
  | {
      kind: 'restore_pending';
      pendingQ4H: boolean;
      pendingSubdialogs: boolean;
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
