// Shared types for frontend and backend

export * from './wire';

export * from './dialog';

export interface DialogInfo {
  selfId: string;
  rootId: string;
  agentId: string;
  agentName: string;
  taskDocPath: string;
}

// API response types for dialogs from server
export interface ApiRootDialogResponse {
  rootId: string; // For root dialogs, this is the dialog's root ID; for subdialogs, this is the supdialog's root ID
  selfId?: string; // Optional: subdialog's own unique identifier (undefined for root dialogs)
  agentId: string;
  taskDocPath: string;
  status: 'running' | 'completed' | 'archived';
  currentRound: number;
  createdAt: string;
  lastModified: string;
  supdialogId?: string; // Optional: parent dialog ID for subdialogs in flattened lists
  subdialogCount?: number; // Number of subdialogs (only present in root dialog responses)
}

export interface ApiSubdialogResponse {
  selfId: string;
  rootId: string;
  agentId: string;
  taskDocPath: string;
  status: 'running' | 'completed' | 'archived';
  currentRound: number;
  createdAt: string;
  lastModified: string;
}

export interface ApiDialogHierarchyResponse {
  success: boolean;
  hierarchy: {
    root: {
      id: string; // Root ID
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentRound: number;
      createdAt: string;
      lastModified: string;
    };
    subdialogs: ApiSubdialogResponse[];
  };
}

export interface ApiDialogListResponse {
  success: boolean;
  dialogs: ApiRootDialogResponse[];
}
