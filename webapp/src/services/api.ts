/**
 * HTTP API Client for Dominds WebUI
 * Handles REST API communication with the backend server
 */

import {
  ApiDialogHierarchyResponse,
  ApiDialogListSideDialogNode,
  ApiDialogListSideDialogNodeResponse,
  ApiForkDialogRequest,
  ApiForkDialogResponse,
  ApiMainDialogResponse,
  ApiMoveDialogsRequest,
  ApiMoveDialogsResponse,
  DomindsRuntimeStatus,
  DomindsSelfUpdateStatus as KernelDomindsSelfUpdateStatus,
  ListPrimingScriptsResponse,
  SaveCurrentCoursePrimingRequest,
  SaveCurrentCoursePrimingResponse,
  SearchPrimingScriptsResponse,
  SearchTaskDocumentSuggestionsResponse,
  SetupFileResponse,
  SetupStatusResponse,
  SetupWriteRtwsLlmYamlRequest,
  SetupWriteRtwsLlmYamlResponse,
  SetupWriteShellEnvRequest,
  SetupWriteShellEnvResponse,
  SetupWriteTeamYamlRequest,
  SetupWriteTeamYamlResponse,
  ToolAvailabilitySnapshot,
  type CreateDialogInput,
  type CreateDialogResult,
  type DialogStatusKind,
} from '@longrun-ai/kernel/types';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  CreateRtwsSnippetGroupRequest,
  CreateRtwsSnippetGroupResponse,
  SaveRtwsSnippetTemplateRequest,
  SaveRtwsSnippetTemplateResponse,
  SnippetCatalogResponse,
  SnippetTemplatesResponse,
  ToolsetManualRequest,
  ToolsetManualResponse,
} from '@longrun-ai/kernel/types/snippets';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

type PersistableDialogStatus = Exclude<DialogStatusKind, 'quarantining'>;
type ResolvedDialogStatus = {
  rootId: string;
  selfId: string;
  status: PersistableDialogStatus;
};

export interface FrontendTeamMember {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  gofor?: string | string[] | Record<string, string>;
  nogo?: string | string[] | Record<string, string>;
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

export type DomindsSelfUpdateStatus = KernelDomindsSelfUpdateStatus;

export type DiligenceFileResponse = {
  success: boolean;
  path: string;
  raw: string;
  source?: 'builtin' | 'rtws';
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
  requestBody?: unknown;
}

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
};

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  if (signals.some((signal) => signal.aborted)) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  if (signals.length === 1) return signals[0];
  const controller = new AbortController();
  for (const signal of signals) {
    signal.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) controller.abort();
      },
      { once: true },
    );
  }
  return controller.signal;
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const error = record['error'];
  const message = record['message'];
  if (error !== undefined && typeof error !== 'string') return false;
  if (message !== undefined && typeof message !== 'string') return false;
  return true;
}

function isApiDialogListSideDialogNodeResponse(
  value: unknown,
): value is ApiDialogListSideDialogNodeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['success'] !== true) return false;
  const sideDialogNode = record['sideDialogNode'];
  return typeof sideDialogNode === 'object' && sideDialogNode !== null;
}

function getApiErrorMessage(status: number, statusText: string, data: unknown): string {
  if (isApiErrorPayload(data)) {
    if (typeof data.error === 'string' && data.error.trim() !== '') return data.error;
    if (typeof data.message === 'string' && data.message.trim() !== '') return data.message;
  }
  return `HTTP ${status}: ${statusText}`;
}

function summarizeRequestBodyForLog(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const entries: Array<{ key: string; value: string }> = [];
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        entries.push({ key, value: value.length > 200 ? `${value.slice(0, 200)}...` : value });
      } else {
        entries.push({
          key,
          value: `[Blob ${(value as Blob).type || 'application/octet-stream'}]`,
        });
      }
    }
    return { kind: 'FormData', entries };
  }
  if (typeof body === 'string') {
    if (body.length <= 2000) {
      return body;
    }
    return `${body.slice(0, 2000)}...`;
  }
  return body;
}

export class ApiClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;
  private timeout: number;

  constructor(baseURL: string, timeout: number = 30000) {
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
    const { method = 'GET', headers = {}, body, timeout = this.timeout, signal } = options;

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
      // The WebUI relies on backend-pushed events and fresh API reads for multi-tab convergence.
      // Avoid browser caching (can break run-control count freshness and other UX gates).
      cache: 'no-store',
      signal: mergeAbortSignals(
        signal ? [signal, AbortSignal.timeout(timeout)] : [AbortSignal.timeout(timeout)],
      ),
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
        const error = new Error(
          getApiErrorMessage(response.status, response.statusText, data),
        ) as ApiError;
        error.status = response.status;
        error.response = data;
        error.requestBody = summarizeRequestBodyForLog(body);
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
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request aborted',
          timestamp: formatUnifiedTimestamp(new Date()),
        };
      }

      const apiError: ApiError =
        error instanceof Error ? (error as ApiError) : (new Error('Unknown error') as ApiError);

      console.error('API request failed', {
        method,
        url,
        status: apiError.status ?? null,
        error: apiError.message,
        requestBody: apiError.requestBody ?? summarizeRequestBodyForLog(body),
        response: apiError.response,
      });

      return {
        success: false,
        status: apiError.status,
        error: apiError.message,
        data: apiError.response as T,
        timestamp: formatUnifiedTimestamp(new Date()),
      };
    }
  }

  async fetchBlob(
    endpoint: string,
    options: { headers?: Record<string, string>; timeout?: number } = {},
  ): Promise<ApiResponse<Blob>> {
    const url = `${this.baseURL}${endpoint}`;
    const timeout = typeof options.timeout === 'number' ? options.timeout : this.timeout;
    const extraHeaders = options.headers ? options.headers : {};

    const mergedHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...extraHeaders,
      Accept: '*/*',
    };
    delete mergedHeaders['Content-Type'];

    const config: RequestInit = {
      method: 'GET',
      headers: mergedHeaders,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    };

    try {
      const response = await fetch(url, config);
      if (!response.ok) {
        const text = await response.text();
        const suffix = text.trim().length > 0 ? `: ${text.trim()}` : '';
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: ${response.statusText}${suffix}`,
          timestamp: formatUnifiedTimestamp(new Date()),
        };
      }
      const blob = await response.blob();
      return {
        success: true,
        status: response.status,
        data: blob,
        timestamp: formatUnifiedTimestamp(new Date()),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return {
          success: false,
          error: 'Request timeout',
          timestamp: formatUnifiedTimestamp(new Date()),
        };
      }
      const apiError: ApiError =
        error instanceof Error ? (error as ApiError) : (new Error('Unknown error') as ApiError);
      return {
        success: false,
        status: apiError.status,
        error: apiError.message,
        timestamp: formatUnifiedTimestamp(new Date()),
      };
    }
  }

  /**
   * Lightweight authenticated probe endpoint
   */
  async healthCheck(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      timestamp: string;
      mode: 'development' | 'production';
    }>
  > {
    return this.request('/api/live-reload');
  }

  async actDomindsSelfUpdate(
    action: 'install' | 'restart',
  ): Promise<ApiResponse<{ update: DomindsSelfUpdateStatus }>> {
    return this.request('/api/dominds/self-update', {
      method: 'POST',
      body: { action },
    });
  }

  /**
   * Get server information
   */
  async getServerInfo(): Promise<ApiResponse<DomindsRuntimeStatus>> {
    return this.request('/api/info');
  }

  /**
   * Get main dialogs in a specific status directory.
   */
  async getMainDialogsByStatus(
    status: PersistableDialogStatus,
  ): Promise<ApiResponse<ApiMainDialogResponse[]>> {
    const query = new URLSearchParams({ status }).toString();
    const response = await this.request(`/api/dialogs?${query}`);
    if (response.success && response.data) {
      const payload = response.data as
        | { dialogs: ApiMainDialogResponse[] }
        | ApiMainDialogResponse[];
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
    return response as ApiResponse<ApiMainDialogResponse[]>;
  }

  /**
   * Get running main dialogs.
   */
  async getMainDialogs(): Promise<ApiResponse<ApiMainDialogResponse[]>> {
    return await this.getMainDialogsByStatus('running');
  }

  async getRunControlCounts(): Promise<
    ApiResponse<{
      proceeding: number;
      resumable: number;
    }>
  > {
    const response = await this.request('/api/dialogs/run-control-counts');
    if (response.success && response.data) {
      const payload = response.data as Record<string, unknown>;
      const countsRec =
        typeof payload['counts'] === 'object' && payload['counts'] !== null
          ? (payload['counts'] as Record<string, unknown>)
          : payload;
      const proceedingRaw = countsRec['proceeding'];
      const resumableRaw = countsRec['resumable'];
      return {
        success: true,
        status: response.status,
        data: {
          proceeding: typeof proceedingRaw === 'number' ? proceedingRaw : 0,
          resumable: typeof resumableRaw === 'number' ? resumableRaw : 0,
        },
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<{ proceeding: number; resumable: number }>;
  }

  /**
   * Get full hierarchy for a single main dialog
   */
  async getDialogHierarchy(
    mainDialogId: string,
    status: PersistableDialogStatus = 'running',
  ): Promise<ApiResponse<ApiDialogHierarchyResponse['hierarchy']>> {
    const query = new URLSearchParams({ status }).toString();
    const response = await this.request(
      `/api/dialogs/${encodeURIComponent(mainDialogId)}/hierarchy?${query}`,
    );
    if (response.success && response.data) {
      // Backend returns {success: true, hierarchy: {root, sideDialogs}}
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
   * Get one sideDialog node specifically for dialog-list backfill.
   */
  async getDialogListSideDialogNode(
    mainDialogId: string,
    selfDialogId: string,
    status: PersistableDialogStatus = 'running',
  ): Promise<ApiResponse<ApiDialogListSideDialogNode>> {
    const query = new URLSearchParams({ status }).toString();
    const response = await this.request(
      `/api/dialogs/${encodeURIComponent(mainDialogId)}/sideDialogs/${encodeURIComponent(selfDialogId)}/list-node?${query}`,
    );
    if (response.success && isApiDialogListSideDialogNodeResponse(response.data)) {
      return {
        success: true,
        status: response.status,
        data: response.data.sideDialogNode,
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<ApiDialogListSideDialogNode>;
  }

  async resolveDialogStatus(
    mainDialogId: string,
    selfDialogId?: string,
  ): Promise<ApiResponse<ResolvedDialogStatus>> {
    const params = new URLSearchParams({ rootId: mainDialogId });
    if (typeof selfDialogId === 'string' && selfDialogId.trim() !== '') {
      params.set('selfId', selfDialogId.trim());
    }
    const response = await this.request(`/api/dialogs/resolve-status?${params.toString()}`);
    if (response.success && response.data) {
      const payload = response.data as { dialog?: unknown };
      const dialog = typeof payload === 'object' && payload !== null ? payload.dialog : undefined;
      if (
        typeof dialog === 'object' &&
        dialog !== null &&
        typeof (dialog as { rootId?: unknown }).rootId === 'string' &&
        typeof (dialog as { selfId?: unknown }).selfId === 'string'
      ) {
        const status = (dialog as { status?: unknown }).status;
        if (status === 'running' || status === 'completed' || status === 'archived') {
          return {
            success: true,
            status: response.status,
            data: {
              rootId: (dialog as { rootId: string }).rootId,
              selfId: (dialog as { selfId: string }).selfId,
              status,
            },
            timestamp: response.timestamp,
          };
        }
      }
      return {
        success: false,
        status: response.status,
        error: 'Invalid resolve-status response payload',
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<ResolvedDialogStatus>;
  }

  /**
   * Create a new dialog
   */
  async createDialog(request: CreateDialogInput): Promise<ApiResponse<CreateDialogResult>> {
    return this.request('/api/dialogs', {
      method: 'POST',
      body: request,
    });
  }

  async forkDialog(
    mainDialogId: string,
    request: ApiForkDialogRequest,
  ): Promise<ApiResponse<ApiForkDialogResponse>> {
    return this.request(`/api/dialogs/${encodeURIComponent(mainDialogId)}/fork`, {
      method: 'POST',
      body: request,
    });
  }

  async listPrimingScripts(agentId: string): Promise<ApiResponse<ListPrimingScriptsResponse>> {
    const query = new URLSearchParams({
      agentId,
      ts: String(Date.now()),
    }).toString();
    return this.request(`/api/priming/scripts?${query}`);
  }

  async searchPrimingScripts(
    agentId: string,
    queryText: string,
  ): Promise<ApiResponse<SearchPrimingScriptsResponse>> {
    const query = new URLSearchParams({
      agentId,
      q: queryText,
      ts: String(Date.now()),
    }).toString();
    return this.request(`/api/priming/scripts?${query}`);
  }

  async saveCurrentCourseAsPrimingScript(
    request: SaveCurrentCoursePrimingRequest,
  ): Promise<ApiResponse<SaveCurrentCoursePrimingResponse>> {
    return this.request('/api/priming/save-current-course', {
      method: 'POST',
      body: request,
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
    mainDialogId: string,
    selfDialogId: string | undefined,
    updates: Record<string, unknown>,
  ): Promise<ApiResponse<void>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(mainDialogId)}${seg}`, {
      method: 'PATCH',
      body: updates,
    });
  }

  /**
   * Delete a dialog
   */
  async deleteDialog(
    mainDialogId: string,
    fromStatus: PersistableDialogStatus,
    selfDialogId?: string,
  ): Promise<ApiResponse<{ deleted: boolean; fromStatus: PersistableDialogStatus }>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    const query = new URLSearchParams({ fromStatus }).toString();
    return this.request(`/api/dialogs/${encodeURIComponent(mainDialogId)}${seg}?${query}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get messages for a dialog
   */
  async getMessages(
    mainDialogId: string,
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
      `/api/dialogs/${encodeURIComponent(mainDialogId)}${seg}/messages${query}`,
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
    mainDialogId: string,
    selfDialogId: string | undefined,
    content: string,
  ): Promise<ApiResponse<unknown>> {
    const seg = selfDialogId ? `/${encodeURIComponent(selfDialogId)}` : '';
    return this.request(`/api/dialogs/${encodeURIComponent(mainDialogId)}${seg}/messages`, {
      method: 'POST',
      body: {
        content,
        role: 'user',
      },
    });
  }

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

  async getSetupRtwsLlmYaml(): Promise<ApiResponse<SetupFileResponse>> {
    return this.request('/api/setup/rtws-llm-yaml');
  }

  async writeTeamYaml(
    req: SetupWriteTeamYamlRequest,
  ): Promise<ApiResponse<SetupWriteTeamYamlResponse>> {
    return this.request('/api/setup/write-team-yaml', { method: 'POST', body: req });
  }

  async writeRtwsLlmYaml(
    req: SetupWriteRtwsLlmYamlRequest,
  ): Promise<ApiResponse<SetupWriteRtwsLlmYamlResponse>> {
    return this.request('/api/setup/write-rtws-llm-yaml', { method: 'POST', body: req });
  }

  /**
   * Write env var to one target: .env.local, ~/.bashrc, or ~/.zshrc
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

  async searchTaskDocumentSuggestions(
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResponse<SearchTaskDocumentSuggestionsResponse>> {
    const params = new URLSearchParams({ q: query });
    return this.request(`/api/task-documents/suggestions?${params.toString()}`, {
      signal: options?.signal,
    });
  }

  async getToolAvailability(options?: {
    agentId?: string;
    taskDocPath?: string;
    rootId?: string;
    selfId?: string;
    sessionSlug?: string;
    status?: PersistableDialogStatus;
  }): Promise<ApiResponse<ToolAvailabilitySnapshot>> {
    // Cache-bust to avoid stale registry results across rapid UI toggles.
    const params = new URLSearchParams({ ts: String(Date.now()) });
    if (typeof options?.agentId === 'string' && options.agentId.trim() !== '') {
      params.set('agentId', options.agentId.trim());
    }
    if (typeof options?.taskDocPath === 'string' && options.taskDocPath.trim() !== '') {
      params.set('taskDocPath', options.taskDocPath.trim());
    }
    if (typeof options?.rootId === 'string' && options.rootId.trim() !== '') {
      params.set('rootId', options.rootId.trim());
    }
    if (typeof options?.selfId === 'string' && options.selfId.trim() !== '') {
      params.set('selfId', options.selfId.trim());
    }
    if (typeof options?.sessionSlug === 'string' && options.sessionSlug.trim() !== '') {
      params.set('sessionSlug', options.sessionSlug.trim());
    }
    if (
      options?.status === 'running' ||
      options?.status === 'completed' ||
      options?.status === 'archived'
    ) {
      params.set('status', options.status);
    }
    return this.request(`/api/tool-availability?${params.toString()}`);
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

  async getRtwsSnippets(): Promise<ApiResponse<SnippetTemplatesResponse>> {
    return this.request('/api/snippets/rtws');
  }

  async getSnippetCatalog(uiLanguage: LanguageCode): Promise<ApiResponse<SnippetCatalogResponse>> {
    return this.request(`/api/snippets/catalog?lang=${encodeURIComponent(uiLanguage)}`);
  }

  async createRtwsSnippetGroup(
    req: CreateRtwsSnippetGroupRequest,
  ): Promise<ApiResponse<CreateRtwsSnippetGroupResponse>> {
    return this.request('/api/snippets/groups', { method: 'POST', body: req });
  }

  async saveRtwsSnippet(
    req: SaveRtwsSnippetTemplateRequest,
  ): Promise<ApiResponse<SaveRtwsSnippetTemplateResponse>> {
    return this.request('/api/snippets/rtws', { method: 'POST', body: req });
  }

  async toolsetManual(req: ToolsetManualRequest): Promise<ApiResponse<ToolsetManualResponse>> {
    return this.request('/api/manual', { method: 'POST', body: req });
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
      cache: 'no-store',
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
  ): Promise<ApiResponse<ApiMainDialogResponse[]>> {
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
        data: Array.isArray(response.data) ? (response.data as ApiMainDialogResponse[]) : [],
        timestamp: response.timestamp,
      };
    }
    return response as ApiResponse<ApiMainDialogResponse[]>;
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
      cache: 'no-store',
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
      // Always use same-origin API base URL in both dev and prod.
      // In dev, Vite proxy forwards /api and /ws to backend.
      baseURL = `${protocol}//${hostname}${port ? `:${port}` : ''}`;
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
