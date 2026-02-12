// Shared types for frontend and backend

export * from './language';
export * from './problems';
export * from './setup';
export * from './snippets';
export * from './tools-registry';
export * from './wire';

export * from './context-health';
export * from './dialog';
export * from './run-state';

import type { DialogRunState } from './run-state';
import type { AssignmentFromSup, DialogStatusKind } from './wire';

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

// API response types for dialogs from server
export interface ApiRootDialogResponse {
  rootId: string; // For root dialogs, this is the dialog's root ID; for subdialogs, this is the supdialog's root ID
  selfId?: string; // Optional: subdialog's own unique identifier (undefined for root dialogs)
  agentId: string;
  taskDocPath: string;
  status: 'running' | 'completed' | 'archived';
  currentCourse: number;
  createdAt: string;
  lastModified: string;
  runState?: DialogRunState;
  supdialogId?: string; // Optional: supdialog ID for subdialogs in flattened lists
  sessionSlug?: string;
  // Optional: present for subdialogs (when available) so the UI can render special cases like FBR.
  assignmentFromSup?: AssignmentFromSup;
  subdialogCount?: number; // Number of subdialogs (only present in root dialog responses)
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
  runState?: DialogRunState;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
}

export interface ApiDialogHierarchyResponse {
  success: boolean;
  hierarchy: {
    root: {
      id: string; // Root ID
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      runState?: DialogRunState;
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
