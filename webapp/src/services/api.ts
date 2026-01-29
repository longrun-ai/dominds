/**
 * HTTP API Client for Dominds WebUI
 * Handles REST API communication with the backend server
 */

import {
  ApiDialogHierarchyResponse,
  ApiMoveDialogsRequest,
  ApiMoveDialogsResponse,
  ApiRootDialogResponse,
  ApiSubdialogResponse,
  SetupFileResponse,
  SetupStatusResponse,
  SetupWriteShellEnvRequest,
  SetupWriteShellEnvResponse,
  SetupWriteTeamYamlRequest,
  SetupWriteTeamYamlResponse,
  SetupWriteWorkspaceLlmYamlRequest,
  SetupWriteWorkspaceLlmYamlResponse,
  ToolsetInfo,
} from '../shared/types';
import type { LanguageCode } from '../shared/types/language';
import type {
  CreateWorkspaceSnippetGroupRequest,
  CreateWorkspaceSnippetGroupResponse,
  SaveWorkspaceSnippetTemplateRequest,
  SaveWorkspaceSnippetTemplateResponse,
  SnippetCatalogResponse,
  SnippetTemplatesResponse,
  TeamMgmtManualRequest,
  TeamMgmtManualResponse,
} from '../shared/types/snippets';
import { formatUnifiedTimestamp } from '../shared/utils/time';

export interface FrontendTeamMember {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  gofor?: string[];
  toolsets?: string[];
  tools?: string[];
  icon?: string;
  streaming?: boolean;
  hidden?: boolean;
}

export interface FrontendTeam {
  memberDefaults: FrontendTeamMember;
  defaultResponder?: string;
  members: Record<string, FrontendTeamMember>;
}

export interface ApiResponse<T> {
  success: boolean;
  status?: number;
  data?: T;
  error?: string;
  message?: string;
  timestamp?: string;
}

export type DiligenceFileResponse = {
  success: boolean;
  path: string;
  raw: string;
  source?: 'builtin' | 'workspace';
  error?: string;
};

export type DeleteDiligenceResponse = {
  success: boolean;
  deleted?: string[];
  missing?: string[];
  error?: string;
};

export type DocsReadResponse = {
  success: boolean;
  name: string;
  path?: string;
  raw?: string;
  error?: string;
};

interface ApiError extends Error {
  status?: number;
  code?: string;
  response?: unknown;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
};

export class ApiClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;
  private timeout: number;

  constructor(baseURL: string = 'http://localhost:5556', timeout: number = 30000) {
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Make an HTTP request
   */
  private async request<T>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const { method = 'GET', headers = {}, body, timeout = this.timeout } = options;

    const url = `${this.baseURL}${endpoint}`;

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const mergedHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...headers,
    };
    if (isFormData) {
      // Let the browser set multipart boundary.
      delete mergedHeaders['Content-Type'];
    }

    const config: RequestInit = {
      method,
      headers: {
        ...mergedHeaders,
      },
      signal: AbortSignal.timeout(timeout),
    };

    if (body && method !== 'GET') {
      if (isFormData) {
        config.body = body;
      } else {
        config.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }

    try {
      const response = await fetch(url, config);
      const contentType = response.headers.get('content-type');

      let data: unknown;
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as ApiError;
        error.status = response.status;
        error.response = data;
        throw error;
      }

      return {
        success: true,
        status: response.status,
        data: data as T,
        timestamp: formatUnifiedTimestamp(new Date()),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        const timeoutError = new Error('Request timeout') as ApiError;
        timeoutError.code = 'TIMEOUT';
        throw timeoutError;
      }

      const apiError: ApiError =
        error instanceof Error ? (error as ApiError) : (new Error('Unknown error') as ApiError);
      console.error(`API request failed: ${method} ${url}`, apiError);

      return {
        success: false,
        status: apiError.status,
        error: apiError.message,
        timestamp: formatUnifiedTimestamp(new Date()),
      };
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<ApiResponse<{ status: string; uptime: number; timestamp: string }>> {
    return this.request('/api/live-reload');
  }

  async getHealth(): Promise<
    ApiResponse<{
      ok: boolean;
      timestamp: string;
      server: string;
      version: string;
      workspace: string;
      mode: string;
    }>
  > {
    return this.request('/api/health');
  }

  /**
   * Get server information
   */
  async getServerInfo(): Promise<ApiResponse<{ name: string; version: string; mode: string }>> {
    return this.request('/api/info');
  }

  /**
   * Get all root dialogs (renamed from getDialogs to clarify it only returns root dialogs)
   */
  async getRootDialogs(): Promise<ApiResponse<ApiRootDialogResponse[]>> {
    const response = await this.request('/api/dialogs');
    if (response.success && response.data) {
      const payload = response.data as
        | { dialogs: ApiRootDialogResponse[] }
        | ApiRootDialogResponse[];
      const dialogs = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.dialogs)
          ? payload.dialogs
          : [];
      return {
        success: true,
        status: response.status,
        data: dialogs,
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<ApiRootDialogResponse[]>;
  }

  /**
   * Get all dialogs (backward-compatible alias for getRootDialogs)
   */
  async getDialogs(): Promise<ApiResponse<ApiRootDialogResponse[]>> {
    return this.getRootDialogs();
  }

  /**
   * Get a specific dialog by ID
   */
  async getDialog(
    rootDialogId: string,
    selfDialogId?: string,
  ): Promise<ApiResponse<ApiSubdialogResponse | ApiRootDialogResponse>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(rootDialogId)}${seg}`);
  }

  /**
   * Get full hierarchy for a single root dialog
   */
  async getDialogHierarchy(
    rootDialogId: string,
  ): Promise<ApiResponse<ApiDialogHierarchyResponse['hierarchy']>> {
    const response = await this.request(
      `/api/dialogs/${encodeURIComponent(rootDialogId)}/hierarchy`,
    );
    if (response.success && response.data) {
      // Backend returns {success: true, hierarchy: {root, subdialogs}}
      // Unwrap to get just the hierarchy object
      const payload = response.data as { hierarchy: ApiDialogHierarchyResponse['hierarchy'] };
      if (payload && payload.hierarchy) {
        return {
          success: true,
          status: response.status,
          data: payload.hierarchy,
          timestamp: response.timestamp,
        };
      }
    }
    return response as ApiResponse<ApiDialogHierarchyResponse['hierarchy']>;
  }

  /**
   * Create a new dialog
   */
  async createDialog(
    agentId: string,
    taskDocPath?: string,
  ): Promise<
    ApiResponse<{ selfId: string; rootId: string; agentId: string; taskDocPath?: string }>
  > {
    return this.request('/api/dialogs', {
      method: 'POST',
      body: {
        agentId,
        taskDocPath,
      },
    });
  }

  /**
   * Move dialogs between status directories (running/completed/archived).
   */
  async moveDialogs(request: ApiMoveDialogsRequest): Promise<ApiResponse<ApiMoveDialogsResponse>> {
    return this.request('/api/dialogs/move', {
      method: 'POST',
      body: request,
    });
  }

  /**
   * Update dialog metadata
   */
  async updateDialog(
    rootDialogId: string,
    selfDialogId: string | undefined,
    updates: Record<string, unknown>,
  ): Promise<ApiResponse<void>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(rootDialogId)}${seg}`, {
      method: 'PATCH',
      body: updates,
    });
  }

  /**
   * Delete a dialog
   */
  async deleteDialog(
    rootDialogId: string,
    selfDialogId?: string,
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(rootDialogId)}${seg}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get messages for a dialog
   */
  async getMessages(
    rootDialogId: string,
    selfDialogId?: string,
    limit?: number,
    offset?: number,
  ): Promise<ApiResponse<unknown[]>> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (offset) params.append('offset', offset.toString());

    const query = params.toString() ? `?${params.toString()}` : '';
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    const response = await this.request(
      `/api/dialogs/${encodeURIComponent(rootDialogId)}${seg}/messages${query}`,
    );

    if (response.success && response.data) {
      return {
        success: true,
        status: response.status,
        data: Array.isArray(response.data) ? response.data : [],
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<unknown[]>;
  }

  /**
   * Send a message to a dialog
   */
  async sendMessage(
    rootDialogId: string,
    selfDialogId: string | undefined,
    content: string,
  ): Promise<ApiResponse<unknown>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(rootDialogId)}${seg}/messages`, {
      method: 'POST',
      body: {
        content,
        role: 'user',
      },
    });
  }

  // Removed legacy getTeamMembers; use getTeamConfig instead

  /**
   * Get team configuration
   */
  async getTeamConfig(): Promise<ApiResponse<{ configuration: FrontendTeam }>> {
    return this.request('/api/team/config');
  }

  /**
   * Setup status endpoint (WebUI /setup)
   */
  async getSetupStatus(): Promise<ApiResponse<SetupStatusResponse>> {
    return this.request('/api/setup/status');
  }

  async getSetupDefaultsYaml(): Promise<ApiResponse<SetupFileResponse>> {
    return this.request('/api/setup/defaults-yaml');
  }

  async getSetupWorkspaceLlmYaml(): Promise<ApiResponse<SetupFileResponse>> {
    return this.request('/api/setup/workspace-llm-yaml');
  }

  async writeTeamYaml(
    req: SetupWriteTeamYamlRequest,
  ): Promise<ApiResponse<SetupWriteTeamYamlResponse>> {
    return this.request('/api/setup/write-team-yaml', { method: 'POST', body: req });
  }

  async writeWorkspaceLlmYaml(
    req: SetupWriteWorkspaceLlmYamlRequest,
  ): Promise<ApiResponse<SetupWriteWorkspaceLlmYamlResponse>> {
    return this.request('/api/setup/write-workspace-llm-yaml', { method: 'POST', body: req });
  }

  /**
   * Write shell env var to ~/.bashrc and/or ~/.zshrc (managed block)
   */
  async writeShellEnv(
    req: SetupWriteShellEnvRequest,
  ): Promise<ApiResponse<SetupWriteShellEnvResponse>> {
    return this.request('/api/setup/write-shell-env', { method: 'POST', body: req });
  }

  async getTaskDocuments(): Promise<
    ApiResponse<{
      success: boolean;
      taskDocuments?: Array<{ path: string; relativePath: string; name: string }>;
    }>
  > {
    return this.request('/api/task-documents');
  }

  async getToolsRegistry(): Promise<
    ApiResponse<{
      toolsets: ToolsetInfo[];
      timestamp: string;
    }>
  > {
    // Cache-bust to avoid stale registry results across rapid UI toggles.
    return this.request(`/api/tools-registry?ts=${Date.now()}`);
  }

  async getRtwsDiligence(lang: LanguageCode): Promise<ApiResponse<DiligenceFileResponse>> {
    return this.request(`/api/rtws/diligence?lang=${encodeURIComponent(lang)}`);
  }

  async deleteRtwsDiligence(lang: LanguageCode): Promise<ApiResponse<DeleteDiligenceResponse>> {
    return this.request(`/api/rtws/diligence?lang=${encodeURIComponent(lang)}`, {
      method: 'DELETE',
    });
  }

  async writeRtwsDiligence(
    lang: LanguageCode,
    req: { raw: string; overwrite: boolean },
  ): Promise<ApiResponse<{ success: boolean; path: string; error?: string }>> {
    const overwrite = req.overwrite ? '1' : '0';
    return this.request(
      `/api/rtws/diligence?lang=${encodeURIComponent(lang)}&overwrite=${overwrite}`,
      {
        method: 'POST',
        body: { raw: req.raw },
      },
    );
  }

  async readDocsMarkdown(name: string, lang: LanguageCode): Promise<ApiResponse<DocsReadResponse>> {
    const normalized = name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
    return this.request(
      `/api/docs/read?name=${encodeURIComponent(normalized)}&lang=${encodeURIComponent(lang)}`,
    );
  }

  async getBuiltinSnippets(): Promise<ApiResponse<SnippetTemplatesResponse>> {
    return this.request('/api/snippets/builtin');
  }

  async getWorkspaceSnippets(): Promise<ApiResponse<SnippetTemplatesResponse>> {
    return this.request('/api/snippets/workspace');
  }

  async getSnippetCatalog(): Promise<ApiResponse<SnippetCatalogResponse>> {
    return this.request('/api/snippets/catalog');
  }

  async createWorkspaceSnippetGroup(
    req: CreateWorkspaceSnippetGroupRequest,
  ): Promise<ApiResponse<CreateWorkspaceSnippetGroupResponse>> {
    return this.request('/api/snippets/groups', { method: 'POST', body: req });
  }

  async saveWorkspaceSnippet(
    req: SaveWorkspaceSnippetTemplateRequest,
  ): Promise<ApiResponse<SaveWorkspaceSnippetTemplateResponse>> {
    return this.request('/api/snippets/workspace', { method: 'POST', body: req });
  }

  async teamMgmtManual(req: TeamMgmtManualRequest): Promise<ApiResponse<TeamMgmtManualResponse>> {
    return this.request('/api/team-mgmt/manual', { method: 'POST', body: req });
  }

  /**
   * Upload file for processing
   */
  async uploadFile(
    file: File,
    metadata?: Record<string, unknown>,
  ): Promise<ApiResponse<{ fileId: string; filename: string; size: number; url: string }>> {
    const formData = new FormData();
    formData.append('file', file);

    if (metadata) {
      formData.append('metadata', JSON.stringify(metadata));
    }

    return this.request('/api/files/upload', {
      method: 'POST',
      headers: {
        // Don't set Content-Type for FormData, let browser set it with boundary
      },
      body: formData,
      timeout: 60000, // Longer timeout for file uploads
    });
  }

  /**
   * Download file by ID
   */
  async downloadFile(fileId: string): Promise<ApiResponse<Blob>> {
    const response = await fetch(`${this.baseURL}/api/files/${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(this.timeout),
      headers: { ...this.defaultHeaders },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    return {
      success: true,
      status: response.status,
      data: blob,
      timestamp: formatUnifiedTimestamp(new Date()),
    };
  }

  /**
   * Search dialogs
   */
  async searchDialogs(
    query: string,
    filters?: { agentId?: string; status?: string; dateRange?: { start: string; end: string } },
  ): Promise<ApiResponse<ApiRootDialogResponse[]>> {
    const params = new URLSearchParams();
    params.append('q', query);

    if (filters?.agentId) params.append('agentId', filters.agentId);
    if (filters?.status) params.append('status', filters.status);
    if (filters?.dateRange) {
      params.append('from', filters.dateRange.start);
      params.append('to', filters.dateRange.end);
    }

    const response = await this.request('/api/dialogs/search?' + params.toString());
    if (response.success && response.data) {
      return {
        success: true,
        data: Array.isArray(response.data) ? (response.data as ApiRootDialogResponse[]) : [],
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<ApiRootDialogResponse[]>;
  }

  /**
   * Get application statistics
   */
  async getStats(): Promise<
    ApiResponse<{
      totalDialogs: number;
      activeDialogs: number;
      totalMessages: number;
      uptime: number;
      memoryUsage: unknown;
    }>
  > {
    return this.request('/api/stats');
  }

  /**
   * Export dialog data
   */
  async exportDialogs(
    format: 'json' | 'csv' | 'txt' = 'json',
    dialogIds?: string[],
  ): Promise<ApiResponse<Blob>> {
    const params = new URLSearchParams();
    params.append('format', format);
    if (dialogIds?.length) {
      params.append('dialogIds', dialogIds.join(','));
    }

    const response = await fetch(`${this.baseURL}/api/export?${params.toString()}`, {
      signal: AbortSignal.timeout(this.timeout),
      headers: { ...this.defaultHeaders },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    return {
      success: true,
      status: response.status,
      data: blob,
      timestamp: formatUnifiedTimestamp(new Date()),
    };
  }

  /**
   * Set authentication token for protected endpoints
   */
  setAuthToken(token: string): void {
    this.defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  /**
   * Remove authentication token
   */
  clearAuthToken(): void {
    delete this.defaultHeaders['Authorization'];
  }

  /**
   * Update base URL
   */
  setBaseURL(baseURL: string): void {
    this.baseURL = baseURL;
  }

  /**
   * Get current base URL
   */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Create a file download helper
   */
  createDownload(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// Singleton instance for global use
let globalApiClient: ApiClient | null = null;

export function getApiClient(config?: { baseURL?: string; timeout?: number }): ApiClient {
  if (!globalApiClient) {
    let baseURL = config?.baseURL;
    if (!baseURL) {
      const { protocol, hostname, port } = window.location;
      // In dev, the WebUI is served by Vite (5555) while the backend API is on 5556.
      // Prefer talking to the backend directly to avoid relying on proxy edge-cases.
      if (port === '5555') {
        baseURL = `${protocol}//${hostname}:5556`;
      } else {
        baseURL = `${protocol}//${hostname}${port ? `:${port}` : ''}`;
      }
    }
    const timeout = config?.timeout || 30000;
    globalApiClient = new ApiClient(baseURL, timeout);
  }
  return globalApiClient;
}

// Utility functions
export const apiUtils = {
  /**
   * Check if the error is a network error
   */
  isNetworkError(error: unknown): boolean {
    return error instanceof TypeError && error.message.includes('fetch');
  },

  /**
   * Check if the error is a timeout error
   */
  isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.name === 'TimeoutError';
  },

  /**
   * Get a user-friendly error message
   */
  getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      if (apiUtils.isTimeoutError(error)) {
        return 'Request timed out. Please check your connection and try again.';
      }
      if (apiUtils.isNetworkError(error)) {
        return 'Network error. Please check your internet connection.';
      }
      return error.message;
    }
    return 'An unknown error occurred';
  },

  /**
   * Retry a function with exponential backoff
   */
  async retry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    delayMs: number = 1000,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) {
          break;
        }

        const backoffDelay = delayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }

    throw lastError;
  },
};
