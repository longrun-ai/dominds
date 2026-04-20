/**
 * Main application container component for Dominds WebUI
 */

import type { ConnectionState } from '@/services/store';
import { DILIGENCE_FALLBACK_TEXT } from '@longrun-ai/kernel/diligence';
import type {
  ApiDialogListSubdialogNode,
  ApiForkDialogResponse,
  ApiMoveDialogsRequest,
  ApiRootDialogResponse,
  DialogInfo,
  DialogStatusKind,
  PrimingScriptSummary,
  PrimingScriptWarningSummary,
  ToolAvailabilitySnapshot,
  ToolInfo,
  ToolsetInfo,
  WorkspaceProblemRecord,
} from '@longrun-ai/kernel/types';
import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type {
  ContextHealthEvent,
  FullRemindersEvent,
  NewQ4HAskedEvent,
  Q4HAnsweredEvent,
  ReminderContent,
  SubdialogEvent,
  TypedDialogEvent,
} from '@longrun-ai/kernel/types/dialog';
import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import {
  formatLanguageName,
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '@longrun-ai/kernel/types/language';
import type { HumanQuestion, Q4HDialogContext } from '@longrun-ai/kernel/types/q4h';
import type {
  ClearResolvedProblemsResultMessage,
  DialogReadyMessage,
  DiligencePushUpdatedMessage,
  DomindsRuntimeStatus,
  ErrorMessage,
  ProblemsSnapshotMessage,
  Q4HStateResponse,
  RunControlRefreshReason,
  WebSocketMessage,
  WelcomeMessage,
} from '@longrun-ai/kernel/types/wire';
import { escapeHtml } from '@longrun-ai/kernel/utils/html';
import { formatUnifiedTimestamp, parseUnifiedTimestampMs } from '@longrun-ai/kernel/utils/time';
import faviconUrl from '../assets/favicon.svg';
import {
  formatContextUsageTitle,
  formatRemindersTitle,
  formatUiLanguageOptionLabel,
  formatUiLanguageTooltip,
  getUiLanguageMatchState,
  getUiStrings,
} from '../i18n/ui';
import type { DomindsSelfUpdateStatus, FrontendTeamMember } from '../services/api';
import { getApiClient } from '../services/api';
import {
  makeWebSocketAuthProtocols,
  readAuthKeyFromLocalStorage,
  readAuthKeyFromUrl,
  removeAuthKeyFromUrl,
  writeAuthKeyToLocalStorage,
} from '../services/auth';
import {
  loadViewportScopedNumber,
  loadViewportScopedRectSize,
  saveViewportScopedNumber,
  saveViewportScopedRectSize,
} from '../services/viewport-size-storage';
import { getWebSocketManager } from '../services/websocket.js';
import {
  formatRetryStoppedReason,
  formatSystemStopReason,
  resolveRetryDisplaySummary,
  resolveRetryDisplayTitle,
} from '../utils/localized-text';
import './archived-dialog-list.js';
import { ArchivedDialogList } from './archived-dialog-list.js';
import {
  CreateDialogFlowController,
  type CreateDialogError,
  type CreateDialogIntent,
  type CreateDialogRequest,
  type CreateDialogResult,
  type CreateDialogSuccess,
  type DialogCreateAction,
} from './create-dialog-flow';
import {
  dispatchDomindsEvent,
  type ForkDialogRequestDetail,
  type PersistableDialogStatus,
  type Q4HCallSiteNavigationDetail,
  type ToastHistoryPolicy,
} from './dom-events';
import './dominds-dialog-container.js';
import {
  DomindsDialogContainer,
  type DialogViewportPanelState,
} from './dominds-dialog-container.js';
import './dominds-docs-panel';
import {
  postprocessRenderedDomindsMarkdown,
  renderDomindsMarkdown,
} from './dominds-markdown-render';
import './dominds-q4h-input';
import type { DomindsQ4HInput, Q4HQuestion } from './dominds-q4h-input';
import './dominds-q4h-panel';
import type { DomindsQ4HPanel } from './dominds-q4h-panel';
import './dominds-snippets-panel';
import './dominds-team-manual-panel';
import './dominds-team-members.js';
import { DomindsTeamMembers } from './dominds-team-members.js';
import './done-dialog-list.js';
import { DoneDialogList } from './done-dialog-list.js';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';
import { getProgressiveExpandLabel, setupProgressiveExpandBehavior } from './progressive-expand';
import './running-dialog-list.js';
import { RunningDialogList } from './running-dialog-list.js';

type ActivityView =
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'archived' }
  | { kind: 'search' }
  | { kind: 'team-members' };

type ToolsWidgetRequestOptions = {
  agentId?: string;
  taskDocPath?: string;
  rootId?: string;
  selfId?: string;
  sessionSlug?: string;
  status?: PersistableDialogStatus;
};

type ToolsWidgetSnapshot = Pick<ToolAvailabilitySnapshot, 'timestamp'> & {
  directTools: ToolInfo[];
  toolsets: ToolsetInfo[];
  warnings: string[];
};

type ReminderSectionKind = 'virtual' | 'numbered';

type ReminderRenderEntry = Readonly<{
  key: string;
  fingerprint: string;
  html: string;
}>;

type AuthState =
  | { kind: 'uninitialized' }
  | { kind: 'none' }
  | { kind: 'active'; source: 'url' | 'localStorage' | 'manual'; key: string }
  | { kind: 'prompt'; reason: 'missing' | 'rejected' | 'ws_rejected'; hadUrlAuth: boolean };

type DeepLinkIntent =
  | {
      kind: 'q4h';
      questionId: string;
      rootId?: string;
      selfId?: string;
      course?: number;
      messageIndex?: number;
      callId?: string;
    }
  | { kind: 'dialog'; rootId: string; selfId: string; course?: number }
  | { kind: 'callsite'; rootId: string; selfId: string; course: number; callId: string }
  | { kind: 'genseq'; rootId: string; selfId: string; course: number; genseq: number };

type DialogDeepLinkParams = {
  rootId: string;
  selfId: string;
  course?: number;
};

type CallsiteDeepLinkParams = {
  rootId: string;
  selfId: string;
  course: number;
  callId: string;
};

type GenseqDeepLinkParams = {
  rootId: string;
  selfId: string;
  course: number;
  genseq: number;
};

type Q4HDeepLinkParams = {
  questionId: string;
  rootId: string;
  selfId: string;
  course?: number;
  messageIndex?: number;
  callId?: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type ToastKind = 'error' | 'warning' | 'info';
type ToastOptions = {
  history?: ToastHistoryPolicy;
};

type ToastHistoryEntry = {
  id: string;
  timestamp: string;
  kind: ToastKind;
  message: string;
};

type DiligenceStateSnapshot = {
  disableDiligencePush: boolean;
  configuredMax: number | null;
  remaining: number | null;
};

type RootDialogsByStatus = {
  running: ApiRootDialogResponse[];
  completed: ApiRootDialogResponse[];
  archived: ApiRootDialogResponse[];
};

type DialogListBootstrapState = { kind: 'loading' } | { kind: 'ready' };

type DomindsVersionActionState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'install'; latestVersion: string | null }>
  | Readonly<{ kind: 'restart'; latestVersion: string | null }>
  | Readonly<{ kind: 'installing'; latestVersion: string | null }>
  | Readonly<{ kind: 'restarting'; latestVersion: string | null }>;

export class DomindsApp extends HTMLElement {
  private static readonly DEFAULT_BROWSER_TITLE = 'Dominds - DevOps Mindsets';
  private static readonly TOAST_HISTORY_STORAGE_KEY = 'dominds-toast-history-v2';
  private static readonly TOAST_HISTORY_MAX = 200;
  private static readonly UNIFIED_TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  private static readonly SIDEBAR_WIDTH_STORAGE_KEY = 'dominds-sidebar-width-px-v1';
  private static readonly BOTTOM_PANEL_HEIGHT_STORAGE_KEY = 'dominds-bottom-panel-height-px-v2';
  private static readonly REMINDERS_WIDGET_SIZE_STORAGE_KEY = 'dominds-reminders-widget-size-v1';
  private static readonly TOOLS_WIDGET_SIZE_STORAGE_KEY = 'dominds-tools-widget-size-v1';

  private wsManager = getWebSocketManager();
  private apiClient = getApiClient();
  private connectionState: ConnectionState = this.wsManager.getConnectionState();
  private wsConnectionOutageEligibleForHistory = this.connectionState.status === 'connected';
  private wsConnectionErrorHistoryRecorded = false;
  private authState: AuthState = { kind: 'uninitialized' };
  private urlAuthPresent: boolean = false;
  // Backend is the single source of truth.
  // Frontend keeps only render-scope snapshots: roots by status + visible subdialogs for expanded roots.
  private rootDialogsByStatus: RootDialogsByStatus = {
    running: [],
    completed: [],
    archived: [],
  };
  private visibleSubdialogsByRoot = new Map<string, ApiRootDialogResponse[]>();
  private dialogListSubdialogNodeBackfillInFlight = new Set<string>();
  private rootStatusById = new Map<string, PersistableDialogStatus>();
  private dialogListBootstrapState: DialogListBootstrapState = { kind: 'loading' };
  private dialogDisplayStatesByKey = new Map<string, DialogDisplayState>();
  private proceedingDialogsCount: number = 0;
  private resumableDialogsCount: number = 0;
  private currentDialog: DialogInfo | null = null; // Track currently selected dialog
  private currentDialogStatus: PersistableDialogStatus | null = null;
  private viewportPanelState: DialogViewportPanelState = { kind: 'hidden' };
  private retryCountdownTimer: number | null = null;
  private teamMembers: FrontendTeamMember[] = [];
  private defaultResponder: string | null = null;
  private taskDocuments: Array<{ path: string; relativePath: string; name: string }> = [];
  private currentTheme: 'light' | 'dark' = this.getCurrentTheme();
  private backendRtws: string = '';
  private backendVersion: string = '';
  private backendMode: 'development' | 'production' | null = null;
  private domindsSelfUpdate: DomindsSelfUpdateStatus | null = null;
  private toolbarCurrentCourse: number = 1;
  private toolbarTotalCourses: number = 1;
  private toolbarReminders: ReminderContent[] = [];
  private toolbarRemindersCollapsed: boolean = true;
  private contextHealthByDialogKey = new Map<string, ContextHealthSnapshot>();
  private toolbarContextHealth: ContextHealthSnapshot | null = null;
  private remindersWidgetVisible: boolean = false;
  private remindersWidgetX: number = 12;
  private remindersWidgetY: number = 120;
  private remindersWidgetWidthPx: number = 0;
  private remindersWidgetHeightPx: number = 320;
  private activityView: ActivityView = { kind: 'running' };
  private _wsEventCancel?: () => void;
  private _connStateCancel?: () => void;
  private runControlRefreshLastScheduledAtMsByReason = new Map<RunControlRefreshReason, number>();
  private lastRunControlRefresh: { timestamp: string; reason: RunControlRefreshReason } | null =
    null;
  private lastRunControlRefreshScheduledAtMs: number | null = null;
  private subdialogContainers = new Map<string, HTMLElement>(); // Map dialogId -> container element
  private authModal: HTMLElement | null = null;
  private createDialogFlow = new CreateDialogFlowController({
    getLanguage: () => this.uiLanguage,
    getTeamMembers: () => this.teamMembers,
    getDefaultResponder: () => this.defaultResponder,
    getTaskDocuments: () => this.taskDocuments,
    listPrimingScripts: async (
      agentId: string,
    ): Promise<{
      recent: PrimingScriptSummary[];
      warningSummary?: PrimingScriptWarningSummary;
    }> => {
      const api = getApiClient();
      const resp = await api.listPrimingScripts(agentId);
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          throw new Error('Authentication required');
        }
        throw new Error(resp.error || 'Failed to load priming scripts');
      }
      const payload = resp.data;
      if (!payload || !payload.success) {
        throw new Error(payload && !payload.success ? payload.error : 'Invalid priming payload');
      }
      return { recent: payload.recent, warningSummary: payload.warningSummary };
    },
    searchPrimingScripts: async (
      agentId: string,
      query: string,
    ): Promise<{
      scripts: PrimingScriptSummary[];
      warningSummary?: PrimingScriptWarningSummary;
    }> => {
      const api = getApiClient();
      const resp = await api.searchPrimingScripts(agentId, query);
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          throw new Error('Authentication required');
        }
        throw new Error(resp.error || 'Failed to search priming scripts');
      }
      const payload = resp.data;
      if (!payload || !payload.success) {
        throw new Error(payload && !payload.success ? payload.error : 'Invalid priming payload');
      }
      return { scripts: payload.scripts, warningSummary: payload.warningSummary };
    },
    ensureTeamMembersReady: () => this.ensureCreateDialogPrerequisites(),
    submitCreateDialog: async (request: CreateDialogRequest): Promise<CreateDialogResult> => {
      const api = getApiClient();
      const resp = await api.createDialog(request);
      if (!resp.success || !resp.data) {
        if (resp.status === 401) {
          return {
            kind: 'failure',
            requestId: request.requestId,
            error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
          };
        }
        const fallback: CreateDialogError = {
          code: 'CREATE_FAILED',
          message: resp.error || 'Dialog creation failed',
        };
        return { kind: 'failure', requestId: request.requestId, error: fallback };
      }

      const data = resp.data as unknown;
      if (typeof data !== 'object' || data === null) {
        return {
          kind: 'failure',
          requestId: request.requestId,
          error: { code: 'CREATE_FAILED', message: 'Dialog creation failed: invalid payload' },
        };
      }
      const rec = data as Record<string, unknown>;

      const normalizeFailureCode = (raw: unknown): CreateDialogError['code'] => {
        switch (raw) {
          case 'TEAM_NOT_READY':
          case 'TEAM_MEMBER_INVALID':
          case 'TASKDOC_INVALID':
          case 'AUTH_REQUIRED':
          case 'CREATE_FAILED':
            return raw;
          default:
            return 'CREATE_FAILED';
        }
      };

      if (rec.kind === 'failure') {
        const message =
          typeof rec.error === 'string' && rec.error.trim() !== ''
            ? rec.error
            : 'Dialog creation failed';
        return {
          kind: 'failure',
          requestId:
            typeof rec.requestId === 'string' && rec.requestId.trim() !== ''
              ? rec.requestId
              : request.requestId,
          error: {
            code: normalizeFailureCode(rec.errorCode),
            message,
          },
        };
      }

      if (typeof rec.selfId === 'string' && typeof rec.rootId === 'string') {
        const resolvedTaskDocPath =
          typeof rec.taskDocPath === 'string' && rec.taskDocPath.trim() !== ''
            ? rec.taskDocPath
            : request.taskDocPath;
        const resolvedAgentId =
          typeof rec.agentId === 'string' && rec.agentId.trim() !== ''
            ? rec.agentId
            : request.agentId;
        return {
          kind: 'success',
          requestId:
            typeof rec.requestId === 'string' && rec.requestId.trim() !== ''
              ? rec.requestId
              : request.requestId,
          selfId: rec.selfId,
          rootId: rec.rootId,
          agentId: resolvedAgentId,
          taskDocPath: resolvedTaskDocPath,
        };
      }

      return {
        kind: 'failure',
        requestId: request.requestId,
        error: { code: 'CREATE_FAILED', message: 'Dialog creation failed: invalid payload' },
      };
    },
    onCreated: async (result: CreateDialogSuccess): Promise<void> => {
      await this.handleCreateDialogSuccess(result);
    },
    onAuthRequired: () => {
      this.onAuthRejected('api');
    },
    onToast: (message, kind) => {
      this.showToast(message, kind);
    },
  });

  private async ensureCreateDialogPrerequisites(): Promise<
    { ok: true } | { ok: false; error: CreateDialogError }
  > {
    const t = getUiStrings(this.uiLanguage);
    if (this.teamMembersLoadState.kind === 'loading') {
      return {
        ok: false,
        error: { code: 'TEAM_NOT_READY', message: t.newDialogLoadingTeam },
      };
    }

    if (this.teamMembers.length === 0) {
      await this.loadTeamMembers({ silent: false });
    }

    if (this.teamMembers.length === 0) {
      const message =
        this.teamMembersLoadState.kind === 'failed'
          ? this.teamMembersLoadState.message || t.newDialogTeamLoadFailed
          : t.newDialogNoTeamMembers;
      return {
        ok: false,
        error: { code: 'TEAM_NOT_READY', message },
      };
    }

    return { ok: true };
  }

  private async handleCreateDialogSuccess(result: CreateDialogSuccess): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    this.showSuccess(`${t.dialogCreatedToastPrefix} @${result.agentId} • ${result.taskDocPath}`);
    await this.loadDialogs();
    await this.openDialogWithKnownStatus(
      {
        selfId: result.selfId,
        rootId: result.rootId,
        agentId: result.agentId,
        agentName: this.getAgentDisplayName(result.agentId),
        taskDocPath: result.taskDocPath,
        status: 'running',
      },
      'running',
      {
        syncAddressBar: true,
        showLoadedToast: true,
      },
    );
  }

  private async openCreateDialogFlow(intent: CreateDialogIntent): Promise<void> {
    if (!this.shadowRoot) return;
    const opened = await this.createDialogFlow.open(this.shadowRoot, intent);
    if (opened.ok) return;

    const kind = opened.error.code === 'TEAM_NOT_READY' ? 'warning' : 'error';
    if (opened.error.code === 'TEAM_NOT_READY') {
      this.activityView = { kind: 'team-members' };
      this.updateActivityView();
    }
    this.showToast(opened.error.message, kind);
  }

  private async saveCurrentCourseAsPrimingScript(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    if (!this.currentDialog) {
      this.showToast(t.primingSaveNoDialogToast, 'warning');
      return;
    }
    const dialogStatus = this.requireCurrentDialogActionStatus();
    if (dialogStatus === null) {
      return;
    }
    const currentAgentId =
      typeof this.currentDialog.agentId === 'string' && this.currentDialog.agentId.trim() !== ''
        ? this.currentDialog.agentId.trim()
        : 'agent-id';
    const defaultSlug = `course-${String(this.toolbarCurrentCourse)}`;
    const promptText = t.primingSavePrompt.includes('<agent-id>')
      ? t.primingSavePrompt.replace('<agent-id>', currentAgentId)
      : t.primingSavePrompt;
    const enteredSlug = window.prompt(promptText, defaultSlug);
    if (enteredSlug === null) return;
    const slug = enteredSlug.trim();
    if (slug === '') {
      this.showToast(t.primingSaveSlugRequiredToast, 'warning');
      return;
    }

    const asFailurePayload = (
      value: unknown,
    ): {
      error: string;
      errorCode?: 'ALREADY_EXISTS' | 'INVALID_REQUEST' | 'INTERNAL_ERROR';
    } | null => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const rec = value as Record<string, unknown>;
      if (rec['success'] !== false) return null;
      const error = typeof rec['error'] === 'string' ? rec['error'] : '';
      if (error.trim() === '') return null;
      const rawCode = rec['errorCode'];
      const errorCode =
        rawCode === 'ALREADY_EXISTS' ||
        rawCode === 'INVALID_REQUEST' ||
        rawCode === 'INTERNAL_ERROR'
          ? rawCode
          : undefined;
      return { error, errorCode };
    };

    const confirmOverwrite = (): boolean => {
      const text = t.primingSaveOverwriteConfirm.includes('<slug>')
        ? t.primingSaveOverwriteConfirm.replace('<slug>', slug)
        : t.primingSaveOverwriteConfirm;
      return window.confirm(text);
    };

    let overwrite = false;
    while (true) {
      const resp = await this.apiClient.saveCurrentCourseAsPrimingScript({
        dialog: {
          rootId: this.currentDialog.rootId,
          selfId: this.currentDialog.selfId,
          status: dialogStatus,
        },
        course: this.toolbarCurrentCourse,
        slug,
        overwrite,
      });

      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        const failure = asFailurePayload(resp.data);
        const shouldConfirmOverwrite =
          !overwrite &&
          (resp.status === 409 || (failure !== null && failure.errorCode === 'ALREADY_EXISTS'));
        if (shouldConfirmOverwrite) {
          if (!confirmOverwrite()) return;
          overwrite = true;
          continue;
        }
        const reason =
          failure !== null
            ? failure.error
            : resp.error && resp.error.trim() !== ''
              ? resp.error
              : t.unknownError;
        this.showToast(`${t.primingSaveFailedToastPrefix}${reason}`, 'error');
        return;
      }

      const payload = resp.data;
      if (!payload || !payload.success) {
        const failure = asFailurePayload(payload);
        const shouldConfirmOverwrite =
          !overwrite && failure !== null && failure.errorCode === 'ALREADY_EXISTS';
        if (shouldConfirmOverwrite) {
          if (!confirmOverwrite()) return;
          overwrite = true;
          continue;
        }
        const reason = failure !== null ? failure.error : t.unknownError;
        this.showToast(`${t.primingSaveFailedToastPrefix}${reason}`, 'error');
        return;
      }

      this.showSuccess(
        `${t.primingSaveSuccessToastPrefix}${payload.script.ref} (${String(payload.messageCount)})`,
      );
      return;
    }
  }

  private teamMembersLoadState:
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'failed'; message: string } = { kind: 'idle' };
  private uiLanguage: LanguageCode = this.getInitialUiLanguage();
  private serverWorkLanguage: LanguageCode | null = null;
  private uiLanguageMenuOpen: boolean = false;
  private _uiLanguageMenuGlobalCancel?: () => void;
  private bootInFlight: boolean = false;
  private deepLinkInFlight: boolean = false;
  private pendingDeepLink: DeepLinkIntent | null = null;
  private pendingDeepLinkQ4HSelectionQuestionId: string | null = null;

  // rtws Problems
  private problemsVersion: number = 0;
  private problems: WorkspaceProblemRecord[] = [];
  private problemsPanelOpen: boolean = false;

  // Toast history (persisted in localStorage)
  private toastHistory: ToastHistoryEntry[] = [];
  private toastHistoryOpen: boolean = false;
  private toastHistorySeq: number = 0;

  private runControlRefreshTimers: Array<ReturnType<typeof setTimeout>> = [];

  private toolsWidgetVisible: boolean = false;
  private toolsWidgetLoading: boolean = false;
  private toolsWidgetTimestamp: string = '';
  private toolsWidgetDirectTools: ToolInfo[] = [];
  private toolsWidgetToolsets: ToolsetInfo[] = [];
  private toolsWidgetWarnings: string[] = [];
  private toolsWidgetError: string | null = null;
  private toolsWidgetRequestSeq: number = 0;
  private toolsWidgetContextKey: string | null = null;
  private toolsWidgetGeometryInitialized: boolean = false;
  private toolsWidgetX: number = 12;
  private toolsWidgetY: number = 120;
  private toolsWidgetWidthPx: number = 380;
  private toolsWidgetHeightPx: number = 320;
  private sidebarResizeCleanup: (() => void) | null = null;
  private reminderProgressiveExpandCleanupByKey = new Map<string, () => void>();
  private readonly boundOnWindowResize = (): void => {
    this.restoreViewportScopedResizableSizes();
    this.setupSidebarResizePersistence();
  };

  // Q4H (Questions for Human) state
  private q4hQuestionCount: number = 0;
  private q4hQuestions: HumanQuestion[] = [];
  private q4hDialogContexts: Q4HDialogContext[] = [];

  // Bottom panel: tabs + content
  private bottomPanelTab: 'q4h' | 'diligence' | 'docs' | 'team-manual' | 'snippets' = 'q4h';
  private bottomPanelExpanded: boolean = false;
  private bottomPanelHeightPx: number = 280;
  private bottomPanelUserResized: boolean = false;
  private bottomPanelIsResizing: boolean = false;
  private bottomPanelResizeStartY: number = 0;
  private bottomPanelResizeStartHeight: number = 0;
  private bottomPanelResizeLastHeight: number = 0;

  private getDefaultBottomPanelHeightPx(): number {
    const min = 120;
    const max = Math.max(min, Math.floor(window.innerHeight * 0.6));
    return Math.max(min, Math.min(max, 280));
  }

  private getStoredBottomPanelHeightPx(): number | null {
    return loadViewportScopedNumber(DomindsApp.BOTTOM_PANEL_HEIGHT_STORAGE_KEY);
  }

  private persistBottomPanelHeightPx(heightPx: number): void {
    saveViewportScopedNumber(DomindsApp.BOTTOM_PANEL_HEIGHT_STORAGE_KEY, heightPx);
  }

  private autoFitBottomPanelForExpandedQ4HCard(questionId: string): void {
    if (this.bottomPanelUserResized) return;
    const sr = this.shadowRoot;
    if (!sr) return;

    const bottomPanel = sr.querySelector('#bottom-panel');
    if (!(bottomPanel instanceof HTMLElement)) return;

    const q4hPanel = sr.querySelector('#q4h-panel');
    if (!(q4hPanel instanceof HTMLElement)) return;

    const q4hRoot = q4hPanel.shadowRoot;
    if (!q4hRoot) return;

    const card = q4hRoot.querySelector(
      `.q4h-question-card[data-question-id="${CSS.escape(questionId)}"]`,
    );
    if (!(card instanceof HTMLElement)) return;

    const max = Math.floor(window.innerHeight * 0.6);
    const desired = Math.min(
      max,
      Math.max(420, Math.ceil(card.getBoundingClientRect().height + 24)),
    );
    if (desired <= this.bottomPanelHeightPx + 4) return;

    this.bottomPanelHeightPx = desired;
    bottomPanel.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeightPx}px`);
  }

  private disableDiligencePush: boolean = false;
  private diligencePushConfiguredMax: number | null = null;
  private diligencePushRemaining: number | null = null;
  private diligencePushLastShown: string | null = null;
  private diligenceRtwsText: string = '';
  private diligenceRtwsDirty: boolean = false;
  private diligenceRtwsSource: 'builtin' | 'rtws' = 'builtin';

  private applyDiligenceState(state: DiligenceStateSnapshot): void {
    this.disableDiligencePush = state.disableDiligencePush;
    this.diligencePushConfiguredMax = state.configuredMax;
    this.diligencePushRemaining = state.remaining;
  }

  private isDiligenceApplicableToCurrentDialog(): boolean {
    const current = this.currentDialog;
    if (!current) return true;
    return current.selfId === current.rootId;
  }

  private normalizeDiligenceMax(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.floor(value));
  }

  private normalizeDiligenceRemaining(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.floor(value));
  }

  private resolveDiligenceStateFromReady(readyMsg: DialogReadyMessage): DiligenceStateSnapshot {
    const configuredMax = this.normalizeDiligenceMax(readyMsg.diligencePushMax);
    const defaultDisableDiligencePush = configuredMax !== null ? configuredMax <= 0 : false;
    const normalizedRemaining = this.normalizeDiligenceRemaining(
      readyMsg.diligencePushRemainingBudget,
    );
    let remaining: number | null = normalizedRemaining;
    if (remaining === null) {
      remaining = configuredMax !== null && configuredMax > 0 ? configuredMax : 0;
    } else if (configuredMax !== null && configuredMax > 0) {
      remaining = Math.min(remaining, configuredMax);
    }
    return {
      disableDiligencePush: readyMsg.disableDiligencePush ?? defaultDisableDiligencePush,
      configuredMax,
      remaining,
    };
  }

  private isDiligenceCheckboxChecked(): boolean {
    if (!this.isDiligenceApplicableToCurrentDialog()) {
      return false;
    }
    return !this.disableDiligencePush;
  }

  private getDiligenceBudgetBadgeText(): { text: string; hasRemaining: boolean } {
    if (!this.isDiligenceApplicableToCurrentDialog()) {
      return { text: '—', hasRemaining: false };
    }

    const configuredMax =
      typeof this.diligencePushConfiguredMax === 'number' &&
      Number.isFinite(this.diligencePushConfiguredMax)
        ? Math.floor(this.diligencePushConfiguredMax)
        : null;
    const total = configuredMax !== null && configuredMax > 0 ? configuredMax : 0;

    const remaining =
      typeof this.diligencePushRemaining === 'number' &&
      Number.isFinite(this.diligencePushRemaining)
        ? Math.max(0, Math.floor(this.diligencePushRemaining))
        : null;

    if (remaining === null) return { text: `— / ${String(total)}`, hasRemaining: false };
    return { text: `${String(remaining)} / ${String(total)}`, hasRemaining: remaining > 0 };
  }

  private playDiligenceNotApplicableShake(): void {
    const sr = this.shadowRoot;
    if (!sr) return;
    const badge = sr.querySelector(
      'button.bp-tab[data-bp-tab="diligence"] .bp-badge',
    ) as HTMLElement | null;
    if (!badge) return;
    const hadPulse = badge.classList.contains('pulse');
    if (hadPulse) badge.classList.remove('pulse');
    badge.classList.remove('shake');
    void badge.offsetWidth;
    badge.classList.add('shake');
    window.setTimeout(() => {
      badge.classList.remove('shake');
      if (hadPulse) badge.classList.add('pulse');
    }, 380);
  }

  private updateBottomPanelFooterUi(): void {
    const sr = this.shadowRoot;
    if (!sr) return;

    const q4hTab = sr.querySelector('button.bp-tab[data-bp-tab="q4h"]') as HTMLButtonElement | null;
    if (q4hTab) {
      const badge = q4hTab.querySelector('.bp-badge') as HTMLElement | null;
      if (badge) {
        badge.textContent = String(this.q4hQuestionCount);
        badge.setAttribute('data-has-questions', this.q4hQuestionCount > 0 ? 'true' : 'false');
      }
    }

    const q4hEmpty = sr.querySelector('.bp-q4h-empty') as HTMLElement | null;
    if (q4hEmpty) {
      q4hEmpty.classList.toggle('hidden', this.q4hQuestionCount !== 0);
    }
    const diligenceTab = sr.querySelector(
      'button.bp-tab[data-bp-tab="diligence"]',
    ) as HTMLButtonElement | null;
    if (!diligenceTab) return;

    const checkbox = diligenceTab.querySelector('#diligence-toggle') as HTMLInputElement | null;
    if (checkbox) {
      const applicable = this.isDiligenceApplicableToCurrentDialog();
      checkbox.checked = applicable ? this.isDiligenceCheckboxChecked() : false;
      checkbox.disabled = !applicable;
    }

    const badges = diligenceTab.querySelectorAll('.bp-badge');
    const badge = badges.length > 0 ? (badges[badges.length - 1] as HTMLElement) : null;
    if (badge) {
      const next = this.getDiligenceBudgetBadgeText();
      badge.textContent = next.text;
      badge.setAttribute('data-has-remaining', next.hasRemaining ? 'true' : 'false');
      if (this.diligencePushLastShown !== next.text) {
        this.diligencePushLastShown = next.text;
        badge.classList.remove('pulse');
        void badge.offsetWidth;
        badge.classList.add('pulse');
      }
    }

    const q4hPanel = sr.querySelector('#q4h-panel') as HTMLElement | null;
    if (q4hPanel) {
      q4hPanel.classList.toggle('hidden', this.q4hQuestionCount === 0);
    }
  }

  private get hasQuestions(): boolean {
    return this.q4hQuestionCount > 0;
  }

  private get q4hInput(): DomindsQ4HInput | null {
    return (
      (this.shadowRoot?.querySelector('#q4h-input') as DomindsQ4HInput | null | undefined) ?? null
    );
  }

  private get q4hPanel(): DomindsQ4HPanel | null {
    return (
      (this.shadowRoot?.querySelector('#q4h-panel') as DomindsQ4HPanel | null | undefined) ?? null
    );
  }

  private ensureBottomPanelQ4HOpen(): void {
    if (this.bottomPanelExpanded && this.bottomPanelTab === 'q4h') return;
    const btn = this.shadowRoot?.querySelector(
      'button.bp-tab[data-bp-tab="q4h"]',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    btn.click();
  }

  private collapseBottomPanelQ4HTabIfExpanded(): void {
    if (!this.bottomPanelExpanded || this.bottomPanelTab !== 'q4h') return;
    const btn = this.shadowRoot?.querySelector(
      'button.bp-tab[data-bp-tab="q4h"]',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    btn.click();
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.remindersWidgetWidthPx = this.getDefaultRemindersWidgetWidthPx();

    const storedHeight = this.getStoredBottomPanelHeightPx();
    if (storedHeight !== null) {
      const min = 120;
      const max = Math.max(min, Math.floor(window.innerHeight * 0.6));
      this.bottomPanelHeightPx = Math.max(min, Math.min(max, storedHeight));
      this.bottomPanelUserResized = true;
    }
  }

  private getDefaultRemindersWidgetWidthPx(): number {
    const minWidth = 260;
    const margin = 12;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
    const targetWidth = Math.floor(window.innerWidth / 2);
    return Math.max(minWidth, Math.min(maxWidth, targetWidth));
  }

  private getDefaultToolsWidgetWidthPx(): number {
    const minWidth = 260;
    const margin = 12;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
    return Math.max(minWidth, Math.min(maxWidth, 380));
  }

  private clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getSidebarWidthBoundsPx(): { minWidth: number; maxWidth: number } {
    if (window.innerWidth <= 768) {
      return { minWidth: 240, maxWidth: 400 };
    }
    return { minWidth: 200, maxWidth: 600 };
  }

  private restoreSidebarWidthForCurrentViewport(): void {
    const sidebar = this.shadowRoot?.querySelector('.sidebar') as HTMLElement | null;
    if (!sidebar) return;
    const storedWidthPx = loadViewportScopedNumber(DomindsApp.SIDEBAR_WIDTH_STORAGE_KEY);
    if (storedWidthPx === null) {
      sidebar.style.removeProperty('width');
      return;
    }
    const { minWidth, maxWidth } = this.getSidebarWidthBoundsPx();
    const widthPx = this.clampNumber(storedWidthPx, minWidth, maxWidth);
    sidebar.style.width = `${widthPx}px`;
  }

  private restoreBottomPanelHeightForCurrentViewport(): void {
    const storedHeight = this.getStoredBottomPanelHeightPx();
    const min = 120;
    const max = Math.max(min, Math.floor(window.innerHeight * 0.6));
    const nextHeight =
      storedHeight === null
        ? this.getDefaultBottomPanelHeightPx()
        : this.clampNumber(storedHeight, min, max);
    this.bottomPanelHeightPx = nextHeight;
    this.bottomPanelUserResized = storedHeight !== null;

    const bottomPanel = this.shadowRoot?.querySelector('#bottom-panel') as HTMLElement | null;
    if (bottomPanel) {
      bottomPanel.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeightPx}px`);
    }
  }

  private clampRemindersWidgetGeometryToViewport(): void {
    const margin = 12;
    const minWidth = 260;
    const minHeight = 160;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
    const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight - margin * 2));
    this.remindersWidgetWidthPx = this.clampNumber(this.remindersWidgetWidthPx, minWidth, maxWidth);
    this.remindersWidgetHeightPx = this.clampNumber(
      this.remindersWidgetHeightPx,
      minHeight,
      maxHeight,
    );
    const maxX = Math.max(margin, window.innerWidth - this.remindersWidgetWidthPx - margin);
    const maxY = Math.max(margin, window.innerHeight - this.remindersWidgetHeightPx - margin);
    this.remindersWidgetX = this.clampNumber(this.remindersWidgetX, margin, maxX);
    this.remindersWidgetY = this.clampNumber(this.remindersWidgetY, margin, maxY);

    const widget = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    if (widget) {
      this.applyRemindersWidgetGeometryStyle(widget);
    }
  }

  private restoreRemindersWidgetSizeForCurrentViewport(): void {
    const storedSize = loadViewportScopedRectSize(DomindsApp.REMINDERS_WIDGET_SIZE_STORAGE_KEY);
    if (storedSize === null) {
      this.remindersWidgetWidthPx = this.getDefaultRemindersWidgetWidthPx();
      this.remindersWidgetHeightPx = 320;
    } else {
      this.remindersWidgetWidthPx = storedSize.widthPx;
      this.remindersWidgetHeightPx = storedSize.heightPx;
    }
    this.clampRemindersWidgetGeometryToViewport();
  }

  private persistRemindersWidgetSizeForCurrentViewport(): void {
    saveViewportScopedRectSize(DomindsApp.REMINDERS_WIDGET_SIZE_STORAGE_KEY, {
      widthPx: this.remindersWidgetWidthPx,
      heightPx: this.remindersWidgetHeightPx,
    });
  }

  private clampToolsWidgetGeometryToViewport(): void {
    const margin = 12;
    const minWidth = 260;
    const minHeight = 180;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
    const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight - margin * 2));
    this.toolsWidgetWidthPx = this.clampNumber(this.toolsWidgetWidthPx, minWidth, maxWidth);
    this.toolsWidgetHeightPx = this.clampNumber(this.toolsWidgetHeightPx, minHeight, maxHeight);
    const maxX = Math.max(margin, window.innerWidth - this.toolsWidgetWidthPx - margin);
    const maxY = Math.max(margin, window.innerHeight - this.toolsWidgetHeightPx - margin);
    this.toolsWidgetX = this.clampNumber(this.toolsWidgetX, margin, maxX);
    this.toolsWidgetY = this.clampNumber(this.toolsWidgetY, margin, maxY);

    const widget = this.shadowRoot?.querySelector('#tools-widget') as HTMLElement | null;
    if (widget) {
      this.applyToolsWidgetGeometryStyle(widget);
    }
  }

  private restoreToolsWidgetSizeForCurrentViewport(): void {
    const storedSize = loadViewportScopedRectSize(DomindsApp.TOOLS_WIDGET_SIZE_STORAGE_KEY);
    if (storedSize === null) {
      this.toolsWidgetWidthPx = this.getDefaultToolsWidgetWidthPx();
      this.toolsWidgetHeightPx = 320;
    } else {
      this.toolsWidgetWidthPx = storedSize.widthPx;
      this.toolsWidgetHeightPx = storedSize.heightPx;
    }
    this.toolsWidgetGeometryInitialized = false;
    this.clampToolsWidgetGeometryToViewport();
    if (this.toolsWidgetVisible) {
      this.initializeToolsWidgetGeometry();
      this.updateToolsWidgetUi();
    }
  }

  private persistToolsWidgetSizeForCurrentViewport(): void {
    saveViewportScopedRectSize(DomindsApp.TOOLS_WIDGET_SIZE_STORAGE_KEY, {
      widthPx: this.toolsWidgetWidthPx,
      heightPx: this.toolsWidgetHeightPx,
    });
  }

  private restoreViewportScopedResizableSizes(): void {
    this.restoreSidebarWidthForCurrentViewport();
    this.restoreBottomPanelHeightForCurrentViewport();
    this.restoreRemindersWidgetSizeForCurrentViewport();
    this.restoreToolsWidgetSizeForCurrentViewport();
  }

  private setupSidebarResizePersistence(): void {
    if (this.sidebarResizeCleanup) {
      this.sidebarResizeCleanup();
      this.sidebarResizeCleanup = null;
    }

    const sidebar = this.shadowRoot?.querySelector('.sidebar') as HTMLElement | null;
    if (!sidebar || window.innerWidth <= 480) return;

    let pointerActive = false;
    let resizeCandidate = false;
    const release = (): void => {
      if (!pointerActive || !resizeCandidate) {
        pointerActive = false;
        resizeCandidate = false;
        return;
      }
      pointerActive = false;
      resizeCandidate = false;
      const { minWidth, maxWidth } = this.getSidebarWidthBoundsPx();
      const measuredWidth = Math.floor(sidebar.getBoundingClientRect().width);
      const widthPx = this.clampNumber(measuredWidth, minWidth, maxWidth);
      sidebar.style.width = `${widthPx}px`;
      saveViewportScopedNumber(DomindsApp.SIDEBAR_WIDTH_STORAGE_KEY, widthPx);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (window.innerWidth <= 480) return;
      const rect = sidebar.getBoundingClientRect();
      pointerActive = true;
      resizeCandidate = rect.right - event.clientX <= 18;
    };

    const onPointerUp = (): void => {
      release();
    };

    sidebar.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    this.sidebarResizeCleanup = () => {
      sidebar.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }

  private applyUiLanguageToDom(): void {
    if (!this.shadowRoot) return;

    const t = getUiStrings(this.uiLanguage);

    // Header + toolbar
    const logo = this.shadowRoot.querySelector('.logo-link') as HTMLAnchorElement | null;
    if (logo) {
      logo.title = t.logoGitHubTitle;
      logo.setAttribute('aria-label', t.logoGitHubTitle);
    }
    this.updateDomindsVersionUi();

    const rtwsIndicator = this.shadowRoot.querySelector('.rtws-indicator') as HTMLElement | null;
    if (rtwsIndicator) rtwsIndicator.title = t.backendWorkspaceTitle;

    this.applyUiLanguageSelectDecorations(t);

    const themeBtn = this.shadowRoot.querySelector('#theme-toggle-btn') as HTMLButtonElement | null;
    if (themeBtn) themeBtn.title = t.themeToggleTitle;

    const toastHistoryBtn = this.shadowRoot.querySelector(
      '#toast-history-btn',
    ) as HTMLButtonElement | null;
    if (toastHistoryBtn) {
      toastHistoryBtn.title = t.toastHistoryButtonTitle;
      toastHistoryBtn.setAttribute('aria-label', t.toastHistoryButtonTitle);
    }

    const toastHistoryTitle = this.shadowRoot.querySelector(
      '#toast-history-title',
    ) as HTMLElement | null;
    if (toastHistoryTitle) toastHistoryTitle.textContent = t.toastHistoryTitle;

    const toastHistoryModal = this.shadowRoot.querySelector(
      '#toast-history-modal',
    ) as HTMLElement | null;
    if (toastHistoryModal) toastHistoryModal.setAttribute('aria-label', t.toastHistoryTitle);

    const toastHistoryClear = this.shadowRoot.querySelector(
      '#toast-history-clear',
    ) as HTMLButtonElement | null;
    if (toastHistoryClear) {
      toastHistoryClear.title = t.toastHistoryClearTitle;
      toastHistoryClear.setAttribute('aria-label', t.toastHistoryClearTitle);
    }

    const activityBar = this.shadowRoot.querySelector('.activity-bar') as HTMLElement | null;
    if (activityBar) activityBar.setAttribute('aria-label', t.activityBarAriaLabel);

    const activityButtons = this.shadowRoot.querySelectorAll<HTMLButtonElement>('[data-activity]');
    activityButtons.forEach((btn) => {
      const kind = btn.getAttribute('data-activity');
      if (kind === 'running') {
        btn.setAttribute('aria-label', t.activityRunning);
        btn.title = t.activityRunning;
      } else if (kind === 'done') {
        btn.setAttribute('aria-label', t.activityDone);
        btn.title = t.activityDone;
      } else if (kind === 'archived') {
        btn.setAttribute('aria-label', t.activityArchived);
        btn.title = t.activityArchived;
      } else if (kind === 'search') {
        btn.setAttribute('aria-label', t.activitySearch);
        btn.title = t.activitySearch;
      } else if (kind === 'team-members') {
        btn.setAttribute('aria-label', t.activityTeamMembers);
        btn.title = t.activityTeamMembers;
      }
    });

    // Placeholder titles/texts
    const doneTitle = this.shadowRoot.querySelector(
      '[data-activity-view="done"] .activity-placeholder-title',
    ) as HTMLElement | null;
    if (doneTitle) doneTitle.textContent = t.placeholderDoneTitle;
    const doneText = this.shadowRoot.querySelector(
      '[data-activity-view="done"] .activity-placeholder-text',
    ) as HTMLElement | null;
    if (doneText) doneText.textContent = t.placeholderDoneText;

    const archTitle = this.shadowRoot.querySelector(
      '[data-activity-view="archived"] .activity-placeholder-title',
    ) as HTMLElement | null;
    if (archTitle) archTitle.textContent = t.placeholderArchivedTitle;
    const archText = this.shadowRoot.querySelector(
      '[data-activity-view="archived"] .activity-placeholder-text',
    ) as HTMLElement | null;
    if (archText) archText.textContent = t.placeholderArchivedText;

    const searchTitle = this.shadowRoot.querySelector(
      '[data-activity-view="search"] .activity-placeholder-title',
    ) as HTMLElement | null;
    if (searchTitle) searchTitle.textContent = t.placeholderSearchTitle;
    const searchText = this.shadowRoot.querySelector(
      '[data-activity-view="search"] .activity-placeholder-text',
    ) as HTMLElement | null;
    if (searchText) searchText.textContent = t.placeholderSearchText;

    this.updateNewDialogButtonState();

    const dialogTitle = this.shadowRoot.querySelector(
      '#current-dialog-title',
    ) as HTMLElement | null;
    if (dialogTitle && this.currentDialog === null) {
      dialogTitle.textContent = t.currentDialogPlaceholder;
    }

    const prev = this.shadowRoot.querySelector('#course-navi-prev') as HTMLButtonElement | null;
    if (prev) prev.setAttribute('aria-label', t.previousCourse);
    const next = this.shadowRoot.querySelector('#course-navi-next') as HTMLButtonElement | null;
    if (next) next.setAttribute('aria-label', t.nextCourse);
    const savePriming = this.shadowRoot.querySelector(
      '#navibar-save-priming',
    ) as HTMLButtonElement | null;
    if (savePriming) {
      savePriming.title = t.primingSaveButtonTitle;
      savePriming.setAttribute('aria-label', t.primingSaveButtonTitle);
    }

    const toolsToggle = this.shadowRoot.querySelector(
      '#navibar-tools-toggle',
    ) as HTMLButtonElement | null;
    if (toolsToggle) {
      toolsToggle.title = t.toolsTitle;
      toolsToggle.setAttribute('aria-label', t.toolsTitle);
      toolsToggle.setAttribute('aria-pressed', this.toolsWidgetVisible ? 'true' : 'false');
    }

    const remToggle = this.shadowRoot.querySelector(
      '#navibar-reminders-toggle',
    ) as HTMLButtonElement | null;
    if (remToggle) {
      remToggle.setAttribute('aria-label', t.reminders);
      remToggle.setAttribute('aria-pressed', this.remindersWidgetVisible ? 'true' : 'false');
    }
    const remRefresh = this.shadowRoot.querySelector(
      '#navibar-reminders-refresh',
    ) as HTMLButtonElement | null;
    if (remRefresh) {
      remRefresh.setAttribute('aria-label', t.refreshReminders);
      remRefresh.title = t.refreshReminders;
    }

    const toolsRefresh = this.shadowRoot.querySelector(
      '#tools-widget-refresh',
    ) as HTMLButtonElement | null;
    if (toolsRefresh) {
      toolsRefresh.setAttribute('aria-label', t.toolsRefresh);
      toolsRefresh.title = t.toolsRefresh;
    }

    const toolsClose = this.shadowRoot.querySelector(
      '#tools-widget-close',
    ) as HTMLButtonElement | null;
    if (toolsClose) {
      toolsClose.setAttribute('aria-label', t.close);
      toolsClose.title = t.close;
    }

    // Propagate to child components
    const conn = this.shadowRoot.querySelector('dominds-connection-status') as HTMLElement | null;
    if (conn) conn.setAttribute('ui-language', this.uiLanguage);

    const dialogContainer = this.shadowRoot.querySelector(
      '#dialog-container',
    ) as HTMLElement | null;
    if (dialogContainer) dialogContainer.setAttribute('ui-language', this.uiLanguage);

    const q4hPanel = this.shadowRoot.querySelector('#q4h-panel') as HTMLElement | null;
    if (q4hPanel) q4hPanel.setAttribute('ui-language', this.uiLanguage);

    const runningList = this.shadowRoot.querySelector('#running-dialog-list');
    if (runningList instanceof RunningDialogList) {
      runningList.setProps({ uiLanguage: this.uiLanguage });
    }

    const doneList = this.shadowRoot.querySelector('#done-dialog-list');
    if (doneList instanceof DoneDialogList) {
      doneList.setProps({ uiLanguage: this.uiLanguage });
    }

    const archivedList = this.shadowRoot.querySelector('#archived-dialog-list');
    if (archivedList instanceof ArchivedDialogList) {
      archivedList.setProps({ uiLanguage: this.uiLanguage });
    }

    const teamMembers = this.shadowRoot.querySelector('#team-members');
    if (teamMembers instanceof DomindsTeamMembers) {
      teamMembers.setProps({ uiLanguage: this.uiLanguage });
    }

    if (this.q4hInput) this.q4hInput.setUiLanguage(this.uiLanguage);

    const docsPanel = this.shadowRoot.querySelector('#docs-panel');
    if (docsPanel instanceof HTMLElement) {
      docsPanel.setAttribute('ui-language', this.uiLanguage);
    }

    // Bottom-panel tab labels
    const q4hLabel = this.shadowRoot.querySelector(
      'button.bp-tab[data-bp-tab="q4h"] .bp-label[data-bp-label="q4h"]',
    );
    if (q4hLabel instanceof HTMLElement) q4hLabel.textContent = t.q4hPendingQuestions;

    const diligenceLabel = this.shadowRoot.querySelector(
      'button.bp-tab[data-bp-tab="diligence"] .bp-label[data-bp-label="diligence"]',
    );
    if (diligenceLabel instanceof HTMLElement) diligenceLabel.textContent = t.keepGoingTabTitle;

    const snippetsTab = this.shadowRoot.querySelector(
      'button.bp-tab[data-bp-tab="snippets"]',
    ) as HTMLElement | null;
    if (snippetsTab) snippetsTab.textContent = t.snippetsTabTitle;

    const teamManualTab = this.shadowRoot.querySelector(
      'button.bp-tab[data-bp-tab="team-manual"]',
    ) as HTMLElement | null;
    if (teamManualTab) teamManualTab.textContent = t.teamMgmtManualTabTitle;

    const docsTab = this.shadowRoot.querySelector(
      'button.bp-tab[data-bp-tab="docs"]',
    ) as HTMLElement | null;
    if (docsTab) docsTab.textContent = t.domindsDocsTabTitle;

    // Bottom-panel content: refresh the active tab content on UI-language change.
    // - docs: attribute-driven (handled above)
    // - team-manual/snippets: panels implement setUiLanguage(lang) and reload content
    // - diligence: reload unless there are unsaved edits
    if (this.bottomPanelTab === 'team-manual') {
      const panel = this.shadowRoot.querySelector('#team-manual-panel');
      if (panel && 'setUiLanguage' in panel) {
        const maybe = panel as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
        if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
      }
    } else if (this.bottomPanelTab === 'snippets') {
      const panel = this.shadowRoot.querySelector('#snippets-panel');
      if (panel && 'setUiLanguage' in panel) {
        const maybe = panel as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
        if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
      }
    } else if (this.bottomPanelTab === 'diligence') {
      if (this.diligenceRtwsDirty) {
        this.showToast(t.keepGoingLanguageChangedDirtyToast, 'warning');
      } else {
        void this.loadRtwsDiligenceText(true);
      }
    }

    // Any open overlays should re-render to refresh static text.
    if (this.remindersWidgetVisible) {
      this.renderRemindersWidget();
      this.setupRemindersWidgetDrag();
    }
    this.updateCreateDialogModalText();
    this.updateAuthModalText();
    this.updateToolsWidgetUi();
    this.updateContextHealthUi();
    this.updateToastHistoryUi();
    this.updateDialogViewportPanels();
  }

  private applyUiLanguageSelectDecorations(t: ReturnType<typeof getUiStrings>): void {
    if (!this.shadowRoot) return;

    const button = this.shadowRoot.querySelector('#ui-language-menu-button');
    if (!(button instanceof HTMLButtonElement)) return;
    const menu = this.shadowRoot.querySelector('#ui-language-menu');
    if (!(menu instanceof HTMLElement)) return;

    const matchState = getUiLanguageMatchState({
      uiLanguage: this.uiLanguage,
      serverWorkLanguage: this.serverWorkLanguage,
    });
    button.dataset.langMatch = matchState.kind;
    button.dataset.uiLanguage = this.uiLanguage;

    const buttonLabel = this.shadowRoot.querySelector(
      '#ui-language-menu-button-label',
    ) as HTMLElement | null;
    if (buttonLabel) {
      buttonLabel.textContent = formatLanguageName(this.uiLanguage, this.uiLanguage);
    }
    button.title = `${t.uiLanguageSelectTitle}\n${formatUiLanguageOptionLabel({
      optionLanguage: this.uiLanguage,
      serverWorkLanguage: this.serverWorkLanguage,
    })}`;

    for (const optionLanguage of supportedLanguageCodes) {
      const item = menu.querySelector(`button[data-language="${optionLanguage}"]`);
      if (!(item instanceof HTMLButtonElement)) continue;

      const itemMatch = getUiLanguageMatchState({
        uiLanguage: optionLanguage,
        serverWorkLanguage: this.serverWorkLanguage,
      });
      item.dataset.langMatch = itemMatch.kind;

      const label = item.querySelector('.ui-language-menu-item-label');
      if (label instanceof HTMLElement) {
        label.textContent = formatUiLanguageOptionLabel({
          optionLanguage,
          serverWorkLanguage: this.serverWorkLanguage,
        });
      }

      const tip = item.querySelector('.ui-language-menu-item-tip');
      if (tip instanceof HTMLElement) {
        const tipMarkdown = formatUiLanguageTooltip({
          inLanguage: optionLanguage,
          describedUiLanguage: optionLanguage,
          serverWorkLanguage: this.serverWorkLanguage,
        });
        tip.innerHTML = renderDomindsMarkdown(tipMarkdown, { kind: 'tooltip' });
      }

      if (optionLanguage === this.uiLanguage) {
        item.dataset.selected = 'true';
        item.setAttribute('aria-current', 'true');
      } else {
        item.dataset.selected = 'false';
        item.removeAttribute('aria-current');
      }
    }
  }

  private setUiLanguageMenuOpen(open: boolean): void {
    if (!this.shadowRoot) return;
    this.uiLanguageMenuOpen = open;

    const button = this.shadowRoot.querySelector('#ui-language-menu-button');
    const menu = this.shadowRoot.querySelector('#ui-language-menu');
    if (!(button instanceof HTMLButtonElement)) return;
    if (!(menu instanceof HTMLElement)) return;

    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;

    if (open) {
      const selected = menu.querySelector(`button[data-language="${this.uiLanguage}"]`);
      if (selected instanceof HTMLButtonElement) {
        selected.focus();
      }
    } else {
      button.focus();
    }
  }

  private ensureUiLanguageMenuGlobalListeners(): void {
    if (this._uiLanguageMenuGlobalCancel) return;

    const onPointerDown = (e: MouseEvent): void => {
      if (!this.uiLanguageMenuOpen) return;

      const path = e.composedPath();
      for (const p of path) {
        if (p instanceof Element) {
          if (p.id === 'ui-language-menu-button') return;
          if (p.id === 'ui-language-menu') return;
        }
      }
      this.setUiLanguageMenuOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!this.uiLanguageMenuOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setUiLanguageMenuOpen(false);
      }
    };

    this.ownerDocument.addEventListener('mousedown', onPointerDown, true);
    this.ownerDocument.addEventListener('keydown', onKeyDown, true);
    this._uiLanguageMenuGlobalCancel = () => {
      this.ownerDocument.removeEventListener('mousedown', onPointerDown, true);
      this.ownerDocument.removeEventListener('keydown', onKeyDown, true);
    };
  }

  private updateCreateDialogModalText(): void {
    this.createDialogFlow.updateLanguage();
  }

  private updateNewDialogButtonState(): void {
    if (!this.shadowRoot) return;
    const t = getUiStrings(this.uiLanguage);
    const btn = this.shadowRoot.querySelector('#new-dialog-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const hasMembers = this.teamMembers.length > 0;
    const kind = this.teamMembersLoadState.kind;

    if (hasMembers) {
      btn.disabled = false;
      btn.title = t.newDialogTitle;
      return;
    }

    if (kind === 'loading') {
      btn.disabled = true;
      btn.title = t.newDialogLoadingTeam;
      return;
    }

    if (kind === 'failed') {
      btn.disabled = false;
      btn.title = t.newDialogTeamLoadFailed;
      return;
    }

    btn.disabled = false;
    btn.title = t.newDialogNoTeamMembers;
  }

  private updateAuthModalText(): void {
    const modal = this.authModal;
    if (!modal) return;
    const t = getUiStrings(this.uiLanguage);

    const title = modal.querySelector('#auth-modal-title') as HTMLElement | null;
    if (title) title.textContent = t.authRequiredTitle;

    const desc = modal.querySelector('.modal-description') as HTMLElement | null;
    if (desc) {
      desc.textContent = t.authDescription;
    }

    const label = modal.querySelector('label[for="auth-key-input"]') as HTMLElement | null;
    if (label) label.textContent = t.authKeyLabel;

    const input = modal.querySelector('#auth-key-input') as HTMLInputElement | null;
    if (input) input.placeholder = t.authKeyPlaceholder;

    const submitBtn = modal.querySelector('#auth-submit-btn') as HTMLButtonElement | null;
    if (submitBtn) submitBtn.textContent = t.connect;
  }

  private getStoredUiLanguage(): LanguageCode | null {
    try {
      const stored = localStorage.getItem('dominds-ui-language');
      if (!stored) return null;
      return normalizeLanguageCode(stored);
    } catch (error) {
      console.warn('Failed to read ui language from localStorage', error);
      return null;
    }
  }

  private getBrowserPreferredUiLanguage(): LanguageCode {
    const raw = typeof navigator.language === 'string' ? navigator.language : '';
    const parsed = normalizeLanguageCode(raw);
    return parsed ?? 'en';
  }

  private getInitialUiLanguage(): LanguageCode {
    const stored = this.getStoredUiLanguage();
    if (stored) return stored;
    return this.getBrowserPreferredUiLanguage();
  }

  private persistUiLanguage(uiLanguage: LanguageCode): void {
    try {
      localStorage.setItem('dominds-ui-language', uiLanguage);
    } catch (error) {
      console.warn('Failed to persist ui language preference', error);
    }
  }

  // Type guard to check if WebSocketMessage has dialog context
  // Also accepts subdialog events which have parentDialog/subDialog instead of dialog
  private hasDialogContext(
    message: WebSocketMessage,
  ): message is WebSocketMessage & { dialog: { selfId: string; rootId: string } } {
    const msg = message as unknown as { dialog?: unknown; parentDialog?: unknown };
    const dialog = msg.dialog;
    if (typeof dialog === 'object' && dialog !== null) {
      const d = dialog as Record<string, unknown>;
      if (typeof d.selfId === 'string' && typeof d.rootId === 'string') return true;
    }

    const parentDialog = msg.parentDialog;
    if (typeof parentDialog === 'object' && parentDialog !== null) {
      const pd = parentDialog as Record<string, unknown>;
      if (typeof pd.selfId === 'string' && typeof pd.rootId === 'string') return true;
    }

    return false;
  }

  /**
   * Get the target dialog ID from a message (handles both dialog and subdialog event structures)
   */
  private getTargetDialogId(message: WebSocketMessage): string | null {
    // Standard dialog events
    if ('dialog' in message && message.dialog) {
      return message.dialog.selfId;
    }
    // Subdialog events (have parentDialog/subDialog)
    if ('subDialog' in message && message.subDialog) {
      return message.subDialog.selfId;
    }
    return null;
  }

  /**
   * Get the dialog container for routing events
   * Always returns the main container - the actual routing decision based on target
   * dialog ID happens inside DomindsDialogContainer based on dialog ID check
   */
  private getDialogContainerForEvent(message: WebSocketMessage): DomindsDialogContainer | null {
    const targetDialogId = this.getTargetDialogId(message);

    if (!targetDialogId) {
      // No dialog context, use main container
      return this.shadowRoot?.querySelector('#dialog-container') as DomindsDialogContainer | null;
    }

    // Check if we're currently viewing a subdialog
    const currentDialog = this.currentDialog;
    const isViewingSubdialog = currentDialog && currentDialog.selfId !== currentDialog.rootId;

    if (isViewingSubdialog) {
      // When viewing a subdialog, only route events for THIS subdialog to the container
      // Parent dialog events should stay in the main container
      if (targetDialogId === currentDialog.selfId) {
        const mainContainer = this.shadowRoot?.querySelector(
          '#dialog-container',
        ) as DomindsDialogContainer | null;
        if (mainContainer) {
          return mainContainer;
        }
      }
      // For events not targeting the current subdialog, fall through to main container
      return this.shadowRoot?.querySelector('#dialog-container') as DomindsDialogContainer | null;
    }

    // Not viewing a subdialog - check if this is a known subdialog
    const subdialogContainer = this.subdialogContainers.get(targetDialogId);
    if (subdialogContainer) {
      return subdialogContainer as DomindsDialogContainer;
    }

    // Not a known subdialog, use main container
    return this.shadowRoot?.querySelector('#dialog-container') as DomindsDialogContainer | null;
  }

  private applyRemindersWidgetGeometryStyle(widget: HTMLElement): void {
    widget.style.setProperty('--reminders-widget-left', `${this.remindersWidgetX}px`);
    widget.style.setProperty('--reminders-widget-top', `${this.remindersWidgetY}px`);
    widget.style.setProperty('--reminders-widget-width', `${this.remindersWidgetWidthPx}px`);
    widget.style.setProperty('--reminders-widget-height', `${this.remindersWidgetHeightPx}px`);
  }

  private applyToolsWidgetGeometryStyle(widget: HTMLElement): void {
    widget.style.setProperty('--tools-widget-left', `${this.toolsWidgetX}px`);
    widget.style.setProperty('--tools-widget-top', `${this.toolsWidgetY}px`);
    widget.style.setProperty('--tools-widget-width', `${this.toolsWidgetWidthPx}px`);
    widget.style.setProperty('--tools-widget-height', `${this.toolsWidgetHeightPx}px`);
  }

  private setupRemindersWidgetDrag(): void {
    const widget = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    const header = this.shadowRoot?.querySelector('#reminders-widget-header') as HTMLElement | null;
    const closeBtn = this.shadowRoot?.querySelector(
      '#reminders-widget-close',
    ) as HTMLElement | null;
    const resizeHandle = this.shadowRoot?.querySelector(
      '#reminders-widget-resize-handle',
    ) as HTMLElement | null;
    if (!widget || !header) return;
    const syncWidgetRect = (): void => {
      this.clampRemindersWidgetGeometryToViewport();
    };
    const initialRect = widget.getBoundingClientRect();
    if (Number.isFinite(initialRect.width) && initialRect.width > 0) {
      this.remindersWidgetWidthPx = Math.floor(initialRect.width);
    }
    if (Number.isFinite(initialRect.height) && initialRect.height > 0) {
      this.remindersWidgetHeightPx = Math.floor(initialRect.height);
    }
    syncWidgetRect();
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      this.remindersWidgetX = e.clientX - offsetX;
      this.remindersWidgetY = e.clientY - offsetY;
      syncWidgetRect();
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    header.onmousedown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('#reminders-widget-close')) {
        return;
      }
      e.preventDefault();
      dragging = true;
      const rect = widget.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    if (resizeHandle) {
      let resizing = false;
      let startTop = 0;
      let startRight = 0;
      const onResizeMove = (e: MouseEvent) => {
        if (!resizing) return;
        const margin = 12;
        const minWidth = 260;
        const minHeight = 160;
        const maxWidthByViewport = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
        const maxHeightByViewport = Math.max(
          minHeight,
          Math.floor(window.innerHeight - margin * 2),
        );
        const maxLeft = Math.max(margin, startRight - minWidth);
        const nextLeft = this.clampNumber(e.clientX, margin, maxLeft);
        const nextWidth = this.clampNumber(startRight - nextLeft, minWidth, maxWidthByViewport);
        const nextHeight = this.clampNumber(e.clientY - startTop, minHeight, maxHeightByViewport);
        this.remindersWidgetX = Math.floor(startRight - nextWidth);
        this.remindersWidgetY = Math.floor(startTop);
        this.remindersWidgetWidthPx = Math.floor(nextWidth);
        this.remindersWidgetHeightPx = Math.floor(nextHeight);
        syncWidgetRect();
      };
      const onResizeUp = () => {
        resizing = false;
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
        this.persistRemindersWidgetSizeForCurrentViewport();
      };
      resizeHandle.onmousedown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        const rect = widget.getBoundingClientRect();
        startTop = rect.top;
        startRight = rect.right;
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', onResizeUp);
      };
    }
    if (closeBtn) {
      closeBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        this.closeRemindersWidget();
      };
    }
  }

  private setupToolsWidgetDrag(): void {
    const widget = this.shadowRoot?.querySelector('#tools-widget') as HTMLElement | null;
    const header = this.shadowRoot?.querySelector('#tools-widget-header') as HTMLElement | null;
    const resizeHandle = this.shadowRoot?.querySelector(
      '#tools-widget-resize-handle',
    ) as HTMLElement | null;
    if (!widget || !header) return;

    const syncWidgetRect = (): void => {
      this.clampToolsWidgetGeometryToViewport();
    };
    const initialRect = widget.getBoundingClientRect();
    if (Number.isFinite(initialRect.width) && initialRect.width > 0) {
      this.toolsWidgetWidthPx = Math.floor(initialRect.width);
    }
    if (Number.isFinite(initialRect.height) && initialRect.height > 0) {
      this.toolsWidgetHeightPx = Math.floor(initialRect.height);
    }
    syncWidgetRect();

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      this.toolsWidgetX = e.clientX - offsetX;
      this.toolsWidgetY = e.clientY - offsetY;
      syncWidgetRect();
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    header.onmousedown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.tools-widget-actions')) {
        return;
      }
      e.preventDefault();
      dragging = true;
      const rect = widget.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    if (resizeHandle) {
      let resizing = false;
      let startTop = 0;
      let startRight = 0;
      const onResizeMove = (e: MouseEvent) => {
        if (!resizing) return;
        const margin = 12;
        const minWidth = 260;
        const minHeight = 180;
        const maxWidthByViewport = Math.max(minWidth, Math.floor(window.innerWidth - margin * 2));
        const maxHeightByViewport = Math.max(
          minHeight,
          Math.floor(window.innerHeight - margin * 2),
        );
        const maxLeft = Math.max(margin, startRight - minWidth);
        const nextLeft = this.clampNumber(e.clientX, margin, maxLeft);
        const nextWidth = this.clampNumber(startRight - nextLeft, minWidth, maxWidthByViewport);
        const nextHeight = this.clampNumber(e.clientY - startTop, minHeight, maxHeightByViewport);
        this.toolsWidgetX = Math.floor(startRight - nextWidth);
        this.toolsWidgetY = Math.floor(startTop);
        this.toolsWidgetWidthPx = Math.floor(nextWidth);
        this.toolsWidgetHeightPx = Math.floor(nextHeight);
        syncWidgetRect();
      };
      const onResizeUp = () => {
        resizing = false;
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
        this.persistToolsWidgetSizeForCurrentViewport();
      };
      resizeHandle.onmousedown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        const rect = widget.getBoundingClientRect();
        startTop = rect.top;
        startRight = rect.right;
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', onResizeUp);
      };
    }
  }
  connectedCallback(): void {
    this.initializeTheme();
    this.initializeAuth();
    this.loadToastHistoryFromStorage();
    this.pendingDeepLink = this.parseDeepLinkFromUrl();

    // Keep "New Dialog" in a loading state until we have loaded the team config at least once.
    if (this.teamMembersLoadState.kind === 'idle') {
      this.teamMembersLoadState = { kind: 'loading' };
    }

    this.initialRender();
    this.restoreViewportScopedResizableSizes();
    this.setupSidebarResizePersistence();
    window.addEventListener('resize', this.boundOnWindowResize);
    this.setupEventListeners();
    void this.bootstrap();

    // Subscribe to connection state changes for Q4H loading
    const connStateSub = this.wsManager.subscribeToConnectionState();
    this._connStateCancel = connStateSub.cancel;
    (async () => {
      for await (const state of connStateSub.stream()) {
        this.handleConnectionStateChange(state);
      }
    })();
  }

  disconnectedCallback(): void {
    this.wsManager.disconnect();
    window.removeEventListener('resize', this.boundOnWindowResize);
    this.clearRetryCountdownTimer();

    for (const t of this.runControlRefreshTimers) {
      clearTimeout(t);
    }
    this.runControlRefreshTimers = [];

    // Cancel WebSocket event subscription to prevent duplicate processing
    if (this._wsEventCancel) {
      this._wsEventCancel();
      this._wsEventCancel = undefined;
    }

    // Cancel connection state subscription to prevent duplicate processing
    if (this._connStateCancel) {
      this._connStateCancel();
      this._connStateCancel = undefined;
    }

    if (this._uiLanguageMenuGlobalCancel) {
      this._uiLanguageMenuGlobalCancel();
      this._uiLanguageMenuGlobalCancel = undefined;
    }

    if (this.sidebarResizeCleanup) {
      this.sidebarResizeCleanup();
      this.sidebarResizeCleanup = null;
    }
    this.cleanupAllReminderProgressiveExpands();
  }

  /**
   * Initial render - creates the DOM structure once after component construction.
   * This MUST only be called once from connectedCallback.
   */
  private initialRender(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    // Set up element-specific event listeners (only needed once at initial render)
    this.setupElementEventListeners();

    // Initialize child components with current state
    const onSelect = (dialog: DialogInfo) => this.selectDialog(dialog);

    const runningList = this.shadowRoot.querySelector('#running-dialog-list');
    if (runningList instanceof RunningDialogList) {
      runningList.setProps({
        onSelect,
        uiLanguage: this.uiLanguage,
        loading: this.isDialogListBootstrapping(),
      });
    }

    const doneList = this.shadowRoot.querySelector('#done-dialog-list');
    if (doneList instanceof DoneDialogList) {
      doneList.setProps({
        onSelect,
        uiLanguage: this.uiLanguage,
        loading: this.isDialogListBootstrapping(),
      });
    }

    const archivedList = this.shadowRoot.querySelector('#archived-dialog-list');
    if (archivedList instanceof ArchivedDialogList) {
      archivedList.setProps({
        onSelect,
        uiLanguage: this.uiLanguage,
        loading: this.isDialogListBootstrapping(),
      });
    }

    const teamMembers = this.shadowRoot.querySelector('#team-members');
    if (teamMembers instanceof DomindsTeamMembers) {
      teamMembers.setMembers(this.teamMembers);
      teamMembers.setDefaultResponder(this.defaultResponder);
      teamMembers.setLoading(false);
      teamMembers.setProps({ uiLanguage: this.uiLanguage });
    }

    this.updateThemeToggle();
    this.updateActivityView();
    this.syncAllDialogLists();
    this.applyUiLanguageToDom();
    this.updateProblemsUi();
    this.updateToolsWidgetUi();
    this.updateDialogViewportPanels();
  }

  /**
   * Surgical update: Update only the dialog list without destroying the container.
   * Use this after dialog list changes (e.g., subdialog creation, dialog loading).
   */
  private updateDialogList(): void {
    this.syncAllDialogLists();
  }

  /**
   * Read root expanded/collapsed state directly from running-list DOM.
   * No app-level expanded-root cache is maintained.
   */
  private isRootExpandedInRunningListDom(rootId: string): boolean {
    const host = this.shadowRoot?.querySelector('#running-dialog-list') as HTMLElement | null;
    if (!host) return false;
    const listShadow = host.shadowRoot;
    if (!listShadow) return false;

    const escapedRootId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(rootId) : rootId;
    const childrenNode = listShadow.querySelector(
      `.rdlg-node[data-rdlg-root-id="${escapedRootId}"] > .sdlg-children`,
    );
    if (!(childrenNode instanceof HTMLElement)) return false;
    return !childrenNode.classList.contains('collapsed');
  }

  private updateActivityView(): void {
    if (!this.shadowRoot) return;

    const activeKind = this.activityView.kind;
    const activityButtons = this.shadowRoot.querySelectorAll<HTMLElement>('[data-activity]');
    activityButtons.forEach((button) => {
      const kind = button.getAttribute('data-activity');
      const isActive = kind === activeKind;
      if (isActive) {
        button.setAttribute('aria-pressed', 'true');
      } else {
        button.setAttribute('aria-pressed', 'false');
      }
    });

    const activityViews = this.shadowRoot.querySelectorAll<HTMLElement>('[data-activity-view]');
    activityViews.forEach((view) => {
      const kind = view.getAttribute('data-activity-view');
      if (kind === activeKind) {
        view.classList.remove('hidden');
      } else {
        view.classList.add('hidden');
      }
    });
  }

  private getDomindsVersionActionState(): DomindsVersionActionState {
    const status = this.domindsSelfUpdate;
    if (status === null || status.enabled !== true) return { kind: 'idle' };
    if (status.busy === 'installing') {
      return { kind: 'installing', latestVersion: status.targetVersion };
    }
    if (status.busy === 'restarting') {
      return { kind: 'restarting', latestVersion: status.targetVersion };
    }
    if (status.action === 'install') {
      return { kind: 'install', latestVersion: status.targetVersion };
    }
    if (status.action === 'restart') {
      return { kind: 'restart', latestVersion: status.targetVersion };
    }
    return { kind: 'idle' };
  }

  private renderDomindsVersionBadge(): string {
    const t = getUiStrings(this.uiLanguage);
    const versionText = this.backendVersion ? `v${this.backendVersion}` : '';
    const state = this.getDomindsVersionActionState();
    let actionLabel = '';
    let showIcon = false;
    switch (state.kind) {
      case 'idle':
        actionLabel = '';
        showIcon = false;
        break;
      case 'install':
        actionLabel = t.domindsVersionUpdateLabel;
        showIcon = true;
        break;
      case 'restart':
        actionLabel = t.domindsVersionRestartLabel;
        showIcon = true;
        break;
      case 'installing':
        actionLabel = t.domindsVersionInstallingLabel;
        showIcon = true;
        break;
      case 'restarting':
        actionLabel = t.domindsVersionRestartingLabel;
        showIcon = true;
        break;
    }

    return [
      `<span class="dominds-version-text">${escapeHtml(versionText)}</span>`,
      actionLabel !== ''
        ? `<span class="dominds-version-divider" aria-hidden="true">·</span><span class="dominds-version-action">${escapeHtml(actionLabel)}</span>`
        : '',
      showIcon
        ? '<span class="icon-mask app-icon-refresh dominds-version-icon" aria-hidden="true"></span>'
        : '',
    ].join('');
  }

  private getDomindsVersionTitle(): string {
    const t = getUiStrings(this.uiLanguage);
    const currentVersion = this.backendVersion ? `v${this.backendVersion}` : 'unknown';
    const latestVersion =
      this.domindsSelfUpdate?.targetVersion ?? this.domindsSelfUpdate?.latestVersion ?? null;
    const latestLabel = latestVersion ? `v${latestVersion}` : currentVersion;
    const state = this.getDomindsVersionActionState();
    switch (state.kind) {
      case 'install':
      case 'installing':
        return `${t.domindsVersionUpdateAvailableTitle}\n${currentVersion} -> ${latestLabel}`;
      case 'restart':
      case 'restarting':
        return `${t.domindsVersionRestartAvailableTitle}\n${currentVersion} -> ${latestLabel}`;
      case 'idle':
        if (
          this.domindsSelfUpdate?.reason === 'latest_check_failed' &&
          this.domindsSelfUpdate.message
        ) {
          return `${t.domindsVersionTitle}\n${this.domindsSelfUpdate.message}`;
        }
        return `${t.domindsVersionTitle}\n${currentVersion}`;
    }
  }

  private updateDomindsVersionUi(): void {
    const versionIndicator = this.shadowRoot?.querySelector('#dominds-version');
    if (!(versionIndicator instanceof HTMLButtonElement)) return;
    versionIndicator.innerHTML = this.renderDomindsVersionBadge();
    versionIndicator.title = this.getDomindsVersionTitle();
    versionIndicator.setAttribute('aria-label', this.getDomindsVersionTitle());
    const isVisible = this.backendVersion !== '';
    versionIndicator.classList.toggle('hidden', !isVisible);
    const actionState = this.getDomindsVersionActionState();
    const isActionable = actionState.kind === 'install' || actionState.kind === 'restart';
    const needsAttention = isActionable;
    versionIndicator.disabled = !isActionable;
    versionIndicator.dataset.actionable = isActionable ? 'true' : 'false';
    versionIndicator.dataset.attention = needsAttention ? 'true' : 'false';
    versionIndicator.dataset.state = actionState.kind;
  }

  /**
   * Surgical update: Update only the rtws indicator text.
   * Use this when rtws info is loaded or changes.
   */
  private updateRtwsInfo(): void {
    const rtwsIndicator = this.shadowRoot?.querySelector('.rtws-indicator');
    if (rtwsIndicator) {
      rtwsIndicator.innerHTML = `<span class="icon-mask app-icon-folder" aria-hidden="true"></span> ${escapeHtml(
        this.backendRtws || 'Unknown rtws',
      )}`;
    }

    this.updateDomindsVersionUi();
  }

  private applyDomindsRuntimeStatus(status: DomindsRuntimeStatus): void {
    const workspace = status.workspace.trim();
    this.backendRtws = workspace;
    this.backendVersion = status.version.trim();
    this.backendMode = status.mode;
    this.domindsSelfUpdate = status.selfUpdate;

    if (workspace !== '') {
      document.documentElement.setAttribute('data-dominds-rtws', workspace);
      try {
        window.localStorage.setItem('dominds.rtws', workspace);
      } catch {
        // ignore storage errors
      }
    } else {
      document.documentElement.removeAttribute('data-dominds-rtws');
      try {
        window.localStorage.removeItem('dominds.rtws');
      } catch {
        // ignore storage errors
      }
    }

    this.updateRtwsInfo();
  }

  private formatVersionActionPrompt(template: string, latestVersion: string | null): string {
    const currentVersion = this.backendVersion !== '' ? this.backendVersion : 'unknown';
    const targetVersion = latestVersion ?? currentVersion;
    return template.split('<current>').join(currentVersion).split('<latest>').join(targetVersion);
  }

  private async handleDomindsVersionAction(): Promise<void> {
    const status = this.domindsSelfUpdate;
    const t = getUiStrings(this.uiLanguage);
    if (status === null || status.enabled !== true) return;
    if (status.busy !== 'idle') return;
    if (status.action !== 'install' && status.action !== 'restart') return;

    const confirmText =
      status.action === 'install'
        ? this.formatVersionActionPrompt(t.domindsVersionInstallConfirm, status.targetVersion)
        : this.formatVersionActionPrompt(t.domindsVersionRestartConfirm, status.targetVersion);
    if (!window.confirm(confirmText)) return;

    try {
      const resp = await this.apiClient.actDomindsSelfUpdate(status.action);
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        throw new Error(resp.error || t.unknownError);
      }
      const nextStatus = resp.data?.update;
      if (!nextStatus) {
        throw new Error('Missing Dominds self-update action payload');
      }
      this.domindsSelfUpdate = nextStatus;
      this.updateDomindsVersionUi();
      if (nextStatus.busy === 'installing') {
        this.showInfo(t.domindsVersionInstallInProgress);
        return;
      }
      if (nextStatus.busy === 'restarting') {
        this.showInfo(t.domindsVersionRestartInProgress);
        return;
      }
      if (status.action === 'install' && nextStatus.action === 'restart') {
        this.showSuccess(t.domindsVersionInstallSuccess);
        return;
      }
      this.showInfo(t.domindsVersionRestartScheduled);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.unknownError;
      this.showToast(`${t.domindsVersionActionFailedPrefix}${message}`, 'error');
    }
  }

  /**
   * Surgical update: Update only the toolbar display elements.
   * Use this when dialog is loaded or course changes.
   */
  private updateToolbarDisplay(): void {
    const prevBtn = this.shadowRoot?.querySelector('#course-navi-prev') as HTMLButtonElement | null;
    const nextBtn = this.shadowRoot?.querySelector('#course-navi-next') as HTMLButtonElement | null;
    const savePrimingBtn = this.shadowRoot?.querySelector(
      '#navibar-save-priming',
    ) as HTMLButtonElement | null;
    const remToggle = this.shadowRoot?.querySelector(
      '#navibar-reminders-toggle',
    ) as HTMLButtonElement | null;
    const toolsToggle = this.shadowRoot?.querySelector(
      '#navibar-tools-toggle',
    ) as HTMLButtonElement | null;
    const remBtnCount = this.shadowRoot?.querySelector(
      '#navibar-reminders-toggle .reminders-count',
    ) as HTMLElement | null;
    const courseLabel = this.shadowRoot?.querySelector('#course-navi-label') as HTMLElement | null;
    const stopCount = this.shadowRoot?.querySelector(
      '#header-emergency-stop-count',
    ) as HTMLElement | null;
    const resumeCount = this.shadowRoot?.querySelector(
      '#header-resume-all-count',
    ) as HTMLElement | null;
    const stopPill = this.shadowRoot?.querySelector(
      '#header-emergency-stop-pill',
    ) as HTMLElement | null;
    const resumePill = this.shadowRoot?.querySelector(
      '#header-resume-all-pill',
    ) as HTMLElement | null;
    const stopBtn = this.shadowRoot?.querySelector(
      '#header-emergency-stop',
    ) as HTMLButtonElement | null;
    const resumeBtn = this.shadowRoot?.querySelector(
      '#header-resume-all',
    ) as HTMLButtonElement | null;

    const applyRunControlRefreshAttrs = (pill: HTMLElement) => {
      if (this.lastRunControlRefresh) {
        pill.setAttribute('data-last-run-control-refresh-ts', this.lastRunControlRefresh.timestamp);
        pill.setAttribute(
          'data-last-run-control-refresh-reason',
          this.lastRunControlRefresh.reason,
        );
      } else {
        pill.removeAttribute('data-last-run-control-refresh-ts');
        pill.removeAttribute('data-last-run-control-refresh-reason');
      }
      if (this.lastRunControlRefreshScheduledAtMs !== null) {
        pill.setAttribute(
          'data-last-run-control-refresh-scheduled-at-ms',
          String(this.lastRunControlRefreshScheduledAtMs),
        );
      } else {
        pill.removeAttribute('data-last-run-control-refresh-scheduled-at-ms');
      }
    };

    if (prevBtn) prevBtn.disabled = this.toolbarCurrentCourse <= 1;
    if (nextBtn) nextBtn.disabled = this.toolbarCurrentCourse >= this.toolbarTotalCourses;
    if (savePrimingBtn) savePrimingBtn.disabled = this.currentDialog === null;
    if (remToggle) {
      remToggle.disabled = this.currentDialog === null;
      remToggle.setAttribute('aria-pressed', this.remindersWidgetVisible ? 'true' : 'false');
    }
    if (toolsToggle) {
      const toolsDisabled = this.currentDialog === null;
      toolsToggle.disabled = toolsDisabled;
      toolsToggle.setAttribute('aria-pressed', this.toolsWidgetVisible ? 'true' : 'false');
      toolsToggle.title = getUiStrings(this.uiLanguage).toolsTitle;
      if (toolsDisabled && this.toolsWidgetVisible) {
        this.closeToolsWidget();
      }
    }
    if (remBtnCount) remBtnCount.textContent = String(this.toolbarReminders.length);
    if (courseLabel) courseLabel.textContent = `C ${this.toolbarCurrentCourse}`;
    if (stopCount) stopCount.textContent = String(this.proceedingDialogsCount);
    if (resumeCount) resumeCount.textContent = String(this.resumableDialogsCount);

    if (stopCount) stopCount.setAttribute('data-testid', 'toolbar.proceeding_count');
    if (resumeCount) resumeCount.setAttribute('data-testid', 'toolbar.resumable_count');

    const stopDisabled = this.proceedingDialogsCount === 0;
    const resumeDisabled = this.resumableDialogsCount === 0;
    const t = getUiStrings(this.uiLanguage);
    if (stopBtn) {
      stopBtn.setAttribute('aria-disabled', stopDisabled ? 'true' : 'false');
      stopBtn.setAttribute('aria-label', `${t.emergencyStop} (${this.proceedingDialogsCount})`);
    }
    if (resumeBtn) {
      resumeBtn.setAttribute('aria-disabled', resumeDisabled ? 'true' : 'false');
      resumeBtn.setAttribute('aria-label', `${t.resumeAll} (${this.resumableDialogsCount})`);
    }
    if (stopPill) {
      stopPill.setAttribute('data-disabled', stopDisabled ? 'true' : 'false');
      stopPill.setAttribute('title', `${t.emergencyStop} (${this.proceedingDialogsCount})`);
      applyRunControlRefreshAttrs(stopPill);
    }
    if (resumePill) {
      resumePill.setAttribute('data-disabled', resumeDisabled ? 'true' : 'false');
      resumePill.setAttribute('title', `${t.resumeAll} (${this.resumableDialogsCount})`);
      applyRunControlRefreshAttrs(resumePill);
    }
    this.updateContextHealthUi();
  }

  private formatTokenCountShort(count: number): string {
    if (!Number.isFinite(count)) return String(count);
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 10_000) return `${Math.round(count / 1000)}k`;
    if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
    return String(count);
  }

  private formatPercent(ratio: number): string {
    const pct = ratio * 100;
    if (!Number.isFinite(pct)) return '∞';
    const fixed = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
    return `${fixed}%`;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  private renderContextUsageIcon(snapshot: ContextHealthSnapshot | null): string {
    const size = 18;
    const cx = 9;
    const cy = 9;
    const r = 7;
    const startAngleRad = -Math.PI / 2;

    if (!snapshot || snapshot.kind !== 'available') {
      return `
        <svg class="ctx-usage-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
          <circle class="ctx-usage-ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" />
        </svg>
      `;
    }

    const hardRatio = this.clamp01(snapshot.hardUtil);
    const optimalRatio = this.clamp01(
      snapshot.effectiveOptimalMaxTokens / snapshot.modelContextLimitTokens,
    );
    const criticalRatio = this.clamp01(
      snapshot.effectiveCriticalMaxTokens / snapshot.modelContextLimitTokens,
    );

    const endAngleRad = startAngleRad + hardRatio * 2 * Math.PI;
    const endX = cx + r * Math.cos(endAngleRad);
    const endY = cy + r * Math.sin(endAngleRad);
    const largeArc = hardRatio > 0.5 ? 1 : 0;

    const hasWedge = hardRatio > 0;
    const wedgePath = hasWedge
      ? `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z`
      : '';

    const optimalMarkAngleRad = startAngleRad + optimalRatio * 2 * Math.PI;
    const optimalMarkX = cx + r * Math.cos(optimalMarkAngleRad);
    const optimalMarkY = cy + r * Math.sin(optimalMarkAngleRad);

    const criticalMarkAngleRad = startAngleRad + criticalRatio * 2 * Math.PI;
    const criticalMarkX = cx + r * Math.cos(criticalMarkAngleRad);
    const criticalMarkY = cy + r * Math.sin(criticalMarkAngleRad);

    return `
      <svg class="ctx-usage-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
        ${hasWedge ? `<path class="ctx-usage-wedge" d="${wedgePath}" />` : ''}
        <circle class="ctx-usage-ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" />
        <line class="ctx-usage-mark-optimal" x1="${cx}" y1="${cy}" x2="${optimalMarkX}" y2="${optimalMarkY}" />
        <line class="ctx-usage-mark-critical" x1="${cx}" y1="${cy}" x2="${criticalMarkX}" y2="${criticalMarkY}" />
      </svg>
    `;
  }

  private updateContextHealthUi(): void {
    const el = this.shadowRoot?.querySelector('#navibar-context-health');
    if (!(el instanceof HTMLElement)) return;

    const tooltip = this.shadowRoot?.querySelector('#navibar-context-health-tooltip');

    const snapshot = this.toolbarContextHealth;
    if (!snapshot) {
      el.setAttribute('data-level', 'unknown');
      const label = formatContextUsageTitle(this.uiLanguage, { kind: 'unknown' });
      el.setAttribute('aria-label', label);
      el.innerHTML = this.renderContextUsageIcon(null);
      if (tooltip instanceof HTMLElement) {
        tooltip.textContent = label;
      }
      return;
    }

    if (snapshot.kind !== 'available') {
      el.setAttribute('data-level', 'unknown');
      const label = formatContextUsageTitle(this.uiLanguage, { kind: 'unknown' });
      el.setAttribute('aria-label', label);
      el.innerHTML = this.renderContextUsageIcon(snapshot);
      if (tooltip instanceof HTMLElement) {
        tooltip.textContent = label;
      }
      return;
    }

    const level = snapshot.level;

    el.setAttribute('data-level', level);
    el.innerHTML = this.renderContextUsageIcon(snapshot);
    const label = formatContextUsageTitle(this.uiLanguage, {
      kind: 'known',
      promptTokens: snapshot.promptTokens,
      hardPercentText: this.formatPercent(snapshot.hardUtil),
      modelContextLimitTokens: snapshot.modelContextLimitTokens,
      modelContextWindowText: snapshot.modelContextWindowText,
      level,
      optimalTokens: snapshot.effectiveOptimalMaxTokens,
      optimalPercentText: this.formatPercent(
        snapshot.effectiveOptimalMaxTokens / snapshot.modelContextLimitTokens,
      ),
      optimalConfigured: snapshot.optimalMaxTokensConfigured !== undefined,
      criticalTokens: snapshot.effectiveCriticalMaxTokens,
      criticalPercentText: this.formatPercent(
        snapshot.effectiveCriticalMaxTokens / snapshot.modelContextLimitTokens,
      ),
      criticalConfigured: snapshot.criticalMaxTokensConfigured !== undefined,
    });
    el.setAttribute('aria-label', label);
    if (tooltip instanceof HTMLElement) {
      tooltip.textContent = label;
    }
  }

  private dialogKey(rootId: string, selfId: string): string {
    return selfId === rootId ? rootId : `${rootId}#${selfId}`;
  }

  private toPersistableStatus(
    status: DialogStatusKind | null | undefined,
  ): PersistableDialogStatus | null {
    if (status === 'running' || status === 'completed' || status === 'archived') {
      return status;
    }
    return null;
  }

  private requirePersistableStatus(
    status: DialogStatusKind,
    context: string,
  ): PersistableDialogStatus {
    const normalized = this.toPersistableStatus(status);
    if (normalized !== null) return normalized;
    throw new Error(`${context} does not support status '${status}'`);
  }

  private getCurrentDialogActionStatus(): PersistableDialogStatus | null {
    const currentDialog = this.currentDialog;
    if (!currentDialog) {
      return null;
    }
    // Business rule: actions on the current dialog may reuse already-known persisted status,
    // but must never reuse a stale status cached on the dialog object itself.
    // Callers that need a status to proceed must handle `null` loudly.
    return this.currentDialogStatus ?? this.lookupVisibleDialogStatus(currentDialog);
  }

  private requireCurrentDialogActionStatus(): PersistableDialogStatus | null {
    const status = this.getCurrentDialogActionStatus();
    if (status !== null) {
      return status;
    }
    const t = getUiStrings(this.uiLanguage);
    this.showToast(t.dialogStatusUnavailableToast, 'warning');
    return null;
  }

  private getRootDialogsForStatus(status: PersistableDialogStatus): ApiRootDialogResponse[] {
    switch (status) {
      case 'running':
        return this.rootDialogsByStatus.running;
      case 'completed':
        return this.rootDialogsByStatus.completed;
      case 'archived':
        return this.rootDialogsByStatus.archived;
      default: {
        const _exhaustive: never = status;
        throw new Error(`Unhandled dialog status: ${String(_exhaustive)}`);
      }
    }
  }

  private setRootDialogsForStatus(
    status: PersistableDialogStatus,
    roots: ApiRootDialogResponse[],
  ): void {
    const normalized = roots
      .filter((d) => !d.selfId)
      .map((d) => ({
        ...d,
        status,
      }));
    switch (status) {
      case 'running':
        this.rootDialogsByStatus.running = normalized;
        break;
      case 'completed':
        this.rootDialogsByStatus.completed = normalized;
        break;
      case 'archived':
        this.rootDialogsByStatus.archived = normalized;
        break;
      default: {
        const _exhaustive: never = status;
        throw new Error(`Unhandled dialog status: ${String(_exhaustive)}`);
      }
    }
  }

  private rebuildRootStatusIndex(): void {
    this.rootStatusById.clear();
    for (const status of ['running', 'completed', 'archived'] as const) {
      for (const root of this.getRootDialogsForStatus(status)) {
        this.rootStatusById.set(root.rootId, status);
      }
    }
  }

  private pruneVisibleSubdialogRoots(): void {
    for (const rootId of Array.from(this.visibleSubdialogsByRoot.keys())) {
      if (!this.rootStatusById.has(rootId)) {
        this.visibleSubdialogsByRoot.delete(rootId);
      }
    }
  }

  private getRootStatus(rootId: string): PersistableDialogStatus | null {
    const status = this.rootStatusById.get(rootId);
    return status ?? null;
  }

  private getRootDialog(rootId: string): ApiRootDialogResponse | null {
    const status = this.getRootStatus(rootId);
    if (!status) return null;
    const match = this.getRootDialogsForStatus(status).find((d) => d.rootId === rootId);
    return match ?? null;
  }

  private getVisibleSubdialogsForRoot(rootId: string): ApiRootDialogResponse[] {
    return this.visibleSubdialogsByRoot.get(rootId) ?? [];
  }

  private isDialogWaitingForFreshBootsReasoning(rootId: string, selfId: string): boolean {
    const target =
      selfId === rootId
        ? this.getRootDialog(rootId)
        : this.findDisplayedDialogByIds(rootId, selfId);
    return target?.waitingForFreshBootsReasoning === true;
  }

  private setDialogWaitingForFreshBootsReasoning(
    rootId: string,
    selfId: string,
    waitingForFreshBootsReasoning: boolean,
  ): void {
    const status = this.lookupVisibleDialogStatusByIds(rootId, selfId);
    if (!status) return;

    if (selfId === rootId) {
      const rootDialog = this.getRootDialog(rootId);
      if (
        rootDialog &&
        rootDialog.waitingForFreshBootsReasoning !== waitingForFreshBootsReasoning
      ) {
        this.upsertRootDialogSnapshot({ ...rootDialog, waitingForFreshBootsReasoning });
      }
    } else if (this.visibleSubdialogsByRoot.has(rootId)) {
      const subdialogs = this.getVisibleSubdialogsForRoot(rootId);
      let changed = false;
      const updated = subdialogs.map((subdialog) => {
        if (subdialog.selfId !== selfId) return subdialog;
        if (subdialog.waitingForFreshBootsReasoning === waitingForFreshBootsReasoning) {
          return subdialog;
        }
        changed = true;
        return { ...subdialog, waitingForFreshBootsReasoning };
      });
      if (changed) {
        this.setVisibleSubdialogsForRoot(rootId, updated);
      }
    }

    this.patchDialogListEntry(status, { rootId, selfId }, { waitingForFreshBootsReasoning });
  }

  private setVisibleSubdialogsForRoot(rootId: string, subdialogs: ApiRootDialogResponse[]): void {
    const rootStatus = this.getRootStatus(rootId);
    const normalized: ApiRootDialogResponse[] = [];
    const seenSelfIds = new Set<string>();
    for (const subdialog of subdialogs) {
      if (subdialog.rootId !== rootId) {
        throw new Error(
          `CRITICAL: visible subdialog rootId mismatch. expected=${rootId} actual=${subdialog.rootId}`,
        );
      }
      if (!subdialog.selfId) {
        throw new Error(`CRITICAL: visible subdialog missing selfId for rootId=${rootId}`);
      }
      if (subdialog.selfId === rootId) {
        throw new Error(`CRITICAL: visible subdialog selfId equals rootId=${rootId}`);
      }
      if (seenSelfIds.has(subdialog.selfId)) {
        throw new Error(
          `CRITICAL: duplicate visible subdialog selfId=${subdialog.selfId} under rootId=${rootId}`,
        );
      }
      seenSelfIds.add(subdialog.selfId);
      normalized.push(
        rootStatus && subdialog.status !== rootStatus
          ? { ...subdialog, status: rootStatus }
          : subdialog,
      );
    }
    this.visibleSubdialogsByRoot.set(rootId, normalized);
  }

  private mergeVisibleSubdialogsForRootFromHierarchy(
    rootId: string,
    hierarchySubdialogs: ApiRootDialogResponse[],
  ): ApiRootDialogResponse[] {
    const existing = this.getVisibleSubdialogsForRoot(rootId);
    if (existing.length === 0) {
      return hierarchySubdialogs;
    }

    const merged = new Map<string, ApiRootDialogResponse>();
    for (const subdialog of existing) {
      if (!subdialog.selfId) continue;
      merged.set(subdialog.selfId, subdialog);
    }
    for (const subdialog of hierarchySubdialogs) {
      if (!subdialog.selfId) continue;
      merged.set(subdialog.selfId, subdialog);
    }
    return [...merged.values()];
  }

  private shouldBackfillDialogListSubdialogNode(
    rootId: string,
    status: PersistableDialogStatus,
  ): boolean {
    if (this.visibleSubdialogsByRoot.has(rootId)) {
      return true;
    }
    return status === 'running' && this.isRootExpandedInRunningListDom(rootId);
  }

  private buildDialogListSubdialogNodeBackfillKey(
    rootId: string,
    selfId: string,
    status: PersistableDialogStatus,
  ): string {
    return `${status}:${rootId}:${selfId}`;
  }

  private requestDialogListSubdialogNodeBackfill(
    rootId: string,
    selfId: string,
    status: PersistableDialogStatus,
  ): void {
    void this.backfillDialogListSubdialogNode(rootId, selfId, status).catch((error: unknown) => {
      console.warn(
        `Failed to backfill dialog-list subdialog node for rootId=${rootId} selfId=${selfId} status=${status}:`,
        error,
      );
    });
  }

  private async backfillDialogListSubdialogNode(
    rootId: string,
    selfId: string,
    status: PersistableDialogStatus,
  ): Promise<void> {
    if (selfId === rootId) return;
    if (this.findDisplayedDialogByIds(rootId, selfId)) return;
    if (!this.shouldBackfillDialogListSubdialogNode(rootId, status)) return;

    const requestKey = this.buildDialogListSubdialogNodeBackfillKey(rootId, selfId, status);
    if (this.dialogListSubdialogNodeBackfillInFlight.has(requestKey)) return;
    this.dialogListSubdialogNodeBackfillInFlight.add(requestKey);

    try {
      const response = await this.apiClient.getDialogListSubdialogNode(rootId, selfId, status);
      if (!response.success) {
        if (response.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        // A missing node after touched can be a transient race. Keep it loud in console only.
        if (response.status !== 404) {
          throw new Error(
            response.error ||
              `Failed to load dialog-list subdialog node for ${rootId}/${selfId} in ${status}`,
          );
        }
        console.warn(
          `Dialog-list subdialog node not found during backfill. rootId=${rootId} selfId=${selfId} status=${status}`,
        );
        return;
      }

      const node: ApiDialogListSubdialogNode | undefined = response.data;
      if (!node) {
        throw new Error(
          `Dialog-list subdialog node response missing data for rootId=${rootId} selfId=${selfId}`,
        );
      }
      if (node.rootId !== rootId) {
        throw new Error(
          `CRITICAL: dialog-list subdialog node rootId mismatch. expected=${rootId} actual=${node.rootId}`,
        );
      }
      if (node.selfId !== selfId) {
        throw new Error(
          `CRITICAL: dialog-list subdialog node selfId mismatch. expected=${selfId} actual=${node.selfId}`,
        );
      }
      if (node.selfId === node.rootId) {
        throw new Error(
          `CRITICAL: dialog-list subdialog node returned root dialog for rootId=${rootId} selfId=${selfId}`,
        );
      }
      if (node.status !== status) {
        throw new Error(
          `CRITICAL: dialog-list subdialog node status mismatch. expected=${status} actual=${node.status} rootId=${rootId} selfId=${selfId}`,
        );
      }

      const currentRootStatus = this.getRootStatus(rootId);
      if (currentRootStatus !== status) return;
      if (this.findDisplayedDialogByIds(rootId, selfId)) return;
      if (!this.shouldBackfillDialogListSubdialogNode(rootId, status)) return;

      const nodeKey = this.dialogKey(node.rootId, node.selfId);
      const effectiveDisplayState =
        status === 'running'
          ? (node.displayState ?? this.dialogDisplayStatesByKey.get(nodeKey))
          : undefined;
      if (effectiveDisplayState) {
        this.dialogDisplayStatesByKey.set(nodeKey, effectiveDisplayState);
      }

      const incomingSubdialog: ApiRootDialogResponse = {
        rootId: node.rootId,
        selfId: node.selfId,
        agentId: node.agentId,
        taskDocPath: node.taskDocPath,
        status: node.status,
        currentCourse: node.currentCourse,
        createdAt: node.createdAt,
        lastModified: node.lastModified,
        displayState: effectiveDisplayState,
        supdialogId: this.resolveSupdialogIdForSubdialog(node),
        sessionSlug: node.sessionSlug,
        assignmentFromSup: node.assignmentFromSup,
        waitingForFreshBootsReasoning: node.waitingForFreshBootsReasoning === true,
      };

      const existing = this.getVisibleSubdialogsForRoot(rootId);
      this.setVisibleSubdialogsForRoot(rootId, [...existing, incomingSubdialog]);

      const rootDialog = this.getRootDialog(rootId);
      if (rootDialog) {
        const nodeUpdatedAtMs = parseUnifiedTimestampMs(node.lastModified);
        const rootUpdatedAtMs = parseUnifiedTimestampMs(rootDialog.lastModified);
        const nextSubdialogCount = Math.max(rootDialog.subdialogCount ?? 0, existing.length + 1);
        const nextLastModified =
          nodeUpdatedAtMs !== null &&
          (rootUpdatedAtMs === null || nodeUpdatedAtMs > rootUpdatedAtMs)
            ? node.lastModified
            : rootDialog.lastModified;
        if (
          nextSubdialogCount !== (rootDialog.subdialogCount ?? 0) ||
          nextLastModified !== rootDialog.lastModified
        ) {
          this.upsertRootDialogSnapshot({
            ...rootDialog,
            subdialogCount: nextSubdialogCount,
            lastModified: nextLastModified,
          });
        }
      }

      this.syncDialogListByStatus(status);
    } finally {
      this.dialogListSubdialogNodeBackfillInFlight.delete(requestKey);
    }
  }

  private updateVisibleSubdialogStatusesForRoot(
    rootId: string,
    status: PersistableDialogStatus,
  ): void {
    const current = this.visibleSubdialogsByRoot.get(rootId);
    if (!current) return;
    const normalized = current.map((d) => (d.status === status ? d : { ...d, status }));
    this.visibleSubdialogsByRoot.set(rootId, normalized);
  }

  private getDisplayedDialogsForStatus(status: PersistableDialogStatus): ApiRootDialogResponse[] {
    const roots = this.getRootDialogsForStatus(status);
    const out: ApiRootDialogResponse[] = [...roots];
    for (const root of roots) {
      const subs = this.visibleSubdialogsByRoot.get(root.rootId);
      if (!subs) continue;
      for (const sub of subs) {
        out.push(sub.status === status ? sub : { ...sub, status });
      }
    }
    return out;
  }

  private getAllDisplayedDialogs(): ApiRootDialogResponse[] {
    return [
      ...this.getDisplayedDialogsForStatus('running'),
      ...this.getDisplayedDialogsForStatus('completed'),
      ...this.getDisplayedDialogsForStatus('archived'),
    ];
  }

  private findDisplayedDialogByIds(rootId: string, selfId: string): ApiRootDialogResponse | null {
    if (selfId === rootId) {
      return this.getRootDialog(rootId);
    }
    const sub = this.getVisibleSubdialogsForRoot(rootId).find((d) => d.selfId === selfId);
    return sub ?? null;
  }

  private findDisplayedDialogByAnyId(dialogId: string): ApiRootDialogResponse | null {
    const root = this.getRootDialog(dialogId);
    if (root) return root;
    for (const [rootId, subs] of this.visibleSubdialogsByRoot.entries()) {
      const found = subs.find((d) => d.selfId === dialogId);
      if (found) return found;
      if (rootId === dialogId) {
        const rootDialog = this.getRootDialog(rootId);
        if (rootDialog) return rootDialog;
      }
    }
    return null;
  }

  private resolveSupdialogIdForSubdialog(subdialog: {
    rootId: string;
    selfId: string;
    supdialogId?: string;
    assignmentFromSup?: { callerDialogId: string } | undefined;
  }): string {
    const assignmentCallerId = subdialog.assignmentFromSup?.callerDialogId?.trim();
    if (assignmentCallerId) {
      return assignmentCallerId;
    }
    const explicitSupdialogId = subdialog.supdialogId?.trim();
    if (explicitSupdialogId) {
      return explicitSupdialogId;
    }
    throw new Error(
      `Subdialog hierarchy invariant violation: missing supdialogId/callerDialogId (rootId=${subdialog.rootId}, selfId=${subdialog.selfId})`,
    );
  }

  private upsertRootDialogSnapshot(nextRoot: ApiRootDialogResponse): void {
    if (nextRoot.selfId) {
      throw new Error(
        `upsertRootDialogSnapshot expected root dialog, got subdialog selfId=${nextRoot.selfId}`,
      );
    }
    const incomingStatus = this.requirePersistableStatus(nextRoot.status, 'upsertRootDialog');
    const previousStatus = this.getRootStatus(nextRoot.rootId);

    if (previousStatus && previousStatus !== incomingStatus) {
      const previousList = this.getRootDialogsForStatus(previousStatus).filter(
        (d) => d.rootId !== nextRoot.rootId,
      );
      this.setRootDialogsForStatus(previousStatus, previousList);
    }

    const targetList = this.getRootDialogsForStatus(incomingStatus);
    const idx = targetList.findIndex((d) => d.rootId === nextRoot.rootId);
    if (idx >= 0) {
      const updated = [...targetList];
      updated[idx] = nextRoot;
      this.setRootDialogsForStatus(incomingStatus, updated);
    } else {
      this.setRootDialogsForStatus(incomingStatus, [...targetList, nextRoot]);
    }
    this.rootStatusById.set(nextRoot.rootId, incomingStatus);
    this.updateVisibleSubdialogStatusesForRoot(nextRoot.rootId, incomingStatus);
  }

  public getStyles(): string {
    return `
      ${ICON_MASK_BASE_CSS}
      :host {
        display: block;
        width: 100%;
        height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: var(--dominds-font-size-base, 14px);
        line-height: var(--dominds-line-height-base, 1.5);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        overflow: hidden;
        color-scheme: inherit;
        --dominds-font-size-micro: 8px;
        --dominds-font-size-xs: 9px;
        --dominds-font-size-sm: 10px;
        --dominds-font-size-md: 11px;
        --dominds-font-size-base: 12px;
        --dominds-line-height-tight: 1.18;
        --dominds-line-height-dense: 1.24;
        --dominds-line-height-base: 1.38;
        --dominds-sidebar-default-width: clamp(200px, 33.333vw, 600px);
        --dominds-sidebar-mobile-width: clamp(240px, 33.333vw, 400px);
        --dominds-reminders-widget-default-width: min(calc(100vw - 24px), max(260px, 50vw));
      }

      .app-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        width: 100%;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
      }

		      .header {
		        display: flex;
		        align-items: center;
		        justify-content: flex-start;
		        gap: 8px;
		        padding: 4px 8px;
		        background: var(--dominds-header-bg);
		        border-bottom: 1px solid var(--dominds-border);
		        flex-shrink: 0;
		      }

	      .logo {
	        display: flex;
	        align-items: center;
	        gap: 6px;
	        flex: none;
	        min-width: auto;
	        width: auto;
	        margin-right: 0;
	      }

	      .logo-link {
		        display: flex;
		        align-items: center;
		        gap: 6px;
		        font-weight: 600;
		        font-size: 13px;
		        line-height: 1;
		        color: var(--dominds-primary, #007acc);
		        flex: none;
	        text-decoration: none;
	      }

	      .logo-link img {
	        align-self: center;
	        display: block;
	      }

	      .logo-text {
	        display: flex;
	        align-items: center;
	        gap: 6px;
	        line-height: 1;
	      }

	      .logo-text > span {
	        display: block;
	        line-height: 1;
	      }

	      .dominds-version {
	        display: inline-flex;
	        align-items: center;
	        gap: 4px;
	        padding: 2px 6px;
	        border-radius: 999px;
	        border: 1px solid transparent;
	        background: transparent;
	        color: var(--dominds-muted, #666666);
	        font-size: 9px;
	        font-weight: 550;
	        line-height: 1;
	        cursor: default;
	      }

      .dominds-version:disabled {
        opacity: 1;
      }

      .dominds-version[data-actionable='true'] {
        cursor: pointer;
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 18%, transparent);
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 10%, transparent);
        color: var(--dominds-primary, #007acc);
      }

      .dominds-version[data-actionable='true']:hover {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 16%, transparent);
      }

      .dominds-version-text,
      .dominds-version-action,
      .dominds-version-divider {
        display: inline-block;
        line-height: 1;
      }

      .dominds-version-icon {
        width: 10px;
        height: 10px;
      }

      @keyframes domindsVersionDoubleBounce {
        0%, 72%, 100% {
          transform: translateY(0) scale(1);
        }
        76% {
          transform: translateY(-3px) scale(1.06);
        }
        80% {
          transform: translateY(0) scale(1);
        }
        84% {
          transform: translateY(-3px) scale(1.06);
        }
        88% {
          transform: translateY(0) scale(1);
        }
      }

      .dominds-version[data-attention='true'] .dominds-version-icon {
        animation: domindsVersionDoubleBounce 8s ease-in-out infinite;
      }

	      .rtws-indicator {
	        font-size: var(--dominds-font-size-xs, 11px);
	        color: var(--dominds-muted, #666666);
	        font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
	        background: var(--dominds-hover, #f8f9fa);
	        padding: 3px 6px;
	        border-radius: 4px;
	        border: 1px solid var(--dominds-border, #e0e0e0);
	        flex: 1 1 auto;
	        max-width: none;
	        min-width: 0;
	        display: flex;
	        align-items: center;
	        justify-content: flex-start;
	        margin-left: 0;
	        margin-right: 0;
	        overflow-x: auto;
	        overflow-y: hidden;
	        white-space: nowrap;
	        scrollbar-width: thin;
	        scrollbar-color: var(--dominds-muted, #666666) var(--dominds-hover, #f8f9fa);
      }

      

      .rtws-indicator::-webkit-scrollbar {
        height: 4px;
      }

      .rtws-indicator::-webkit-scrollbar-track {
        background: var(--dominds-hover, #f8f9fa);
      }

      .rtws-indicator::-webkit-scrollbar-thumb {
        background: var(--dominds-muted, #666666);
        border-radius: 2px;
      }

      .rtws-indicator::-webkit-scrollbar-thumb:hover {
        background: var(--dominds-fg, #333333);
      }

	      .header-actions {
		        display: flex;
		        align-items: center;
		        gap: 6px;
		        margin-left: 0;
		        flex-shrink: 0;
		      }

      .header-run-controls {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .header-pill-button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 20px;
        box-sizing: border-box;
        padding: 0 9px;
        border-radius: 10px;
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1;
        font-weight: 500;
        user-select: none;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        transition: all 0.2s ease;
      }

      #toast-history-btn {
        width: 28px;
        justify-content: center;
        padding: 0;
        color: color-mix(in srgb, var(--dominds-fg, #333333) 86%, var(--dominds-muted, #666666));
      }

      .header-pill-button:hover:not(:disabled) {
        border-color: var(--dominds-primary, #007acc);
        background: var(--dominds-hover, #f0f0f0);
      }

      .header-pill-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .header-run-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 20px;
        box-sizing: border-box;
        padding: 0 9px;
        border-radius: 10px;
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1;
        font-weight: 500;
        user-select: none;
        border: 1px solid var(--dominds-border, #e0e0e0);
        cursor: default;
        transition: all 0.2s ease;
      }

      .header-run-pill.danger {
        color: var(--dominds-danger, #721c24);
      }

      .header-run-pill.success {
        color: var(--dominds-success, #155724);
      }

      .header-run-pill-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px;
        margin: -1px;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }

	      .header-run-pill-icon:focus-visible {
	        outline: 2px solid var(--dominds-primary, #007acc);
	        outline-offset: 2px;
	        border-radius: 6px;
	      }

	      .header-run-pill-icon[aria-disabled='true'] {
	        cursor: not-allowed;
	        opacity: 0.8;
	      }

      .header-run-pill-count {
        color: var(--dominds-fg, #333333);
        cursor: default;
      }

      .header-pill-button.danger {
        background: var(--dominds-danger-bg, #f8d7da);
        color: var(--dominds-danger, #721c24);
        border-color: var(--dominds-danger-border, #f5c6cb);
      }

      .header-pill-button.danger:hover:not(:disabled) {
        border-color: var(--dominds-danger, #dc3545);
      }

      .header-pill-button.success {
        background: var(--dominds-success-bg, #d4edda);
        color: var(--dominds-success, #155724);
        border-color: var(--dominds-success-border, #c3e6cb);
      }

      .header-pill-button.success:hover:not(:disabled) {
        border-color: var(--dominds-success, #28a745);
      }

      #header-emergency-stop-pill[data-disabled='true'] {
        background: color-mix(in srgb, #22c55e 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #22c55e 22%, var(--dominds-border, #e0e0e0));
        opacity: 0.6;
        cursor: not-allowed;
      }

      #header-emergency-stop-pill:not([data-disabled='true']) {
        background: color-mix(in srgb, #22c55e 55%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #22c55e 65%, var(--dominds-border, #e0e0e0));
        cursor: pointer;
      }

      #header-emergency-stop-pill:hover:not([data-disabled='true']) {
        border-color: color-mix(in srgb, #22c55e 80%, var(--dominds-border, #e0e0e0));
      }

      #header-resume-all-pill[data-disabled='true'] {
        background: color-mix(in srgb, #ef4444 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #ef4444 22%, var(--dominds-border, #e0e0e0));
        opacity: 0.6;
        cursor: not-allowed;
      }

      #header-resume-all-pill:not([data-disabled='true']) {
        background: color-mix(in srgb, #ef4444 55%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #ef4444 65%, var(--dominds-border, #e0e0e0));
        cursor: pointer;
      }

      #header-resume-all-pill:hover:not([data-disabled='true']) {
        border-color: color-mix(in srgb, #ef4444 80%, var(--dominds-border, #e0e0e0));
      }

	      .header-pill-button.problems[data-has-problems='false'] {
	        background: color-mix(in srgb, var(--dominds-fg, #333333) 3%, var(--dominds-bg, #ffffff));
	        border-color: color-mix(in srgb, var(--dominds-border, #e0e0e0) 78%, transparent);
	        color: color-mix(in srgb, var(--dominds-muted, #666666) 88%, var(--dominds-fg, #333333));
          opacity: 0.62;
	      }

	      .header-pill-button.problems[data-has-problems='false']:hover:not(:disabled) {
	        background: color-mix(in srgb, var(--dominds-fg, #333333) 4%, var(--dominds-bg, #ffffff));
	        border-color: color-mix(in srgb, var(--dominds-border, #e0e0e0) 82%, transparent);
	        color: color-mix(in srgb, var(--dominds-muted, #666666) 90%, var(--dominds-fg, #333333));
	      }

      .header-pill-button.problems[data-has-problems='true'][data-severity='info'] {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 18%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 45%, var(--dominds-border, #e0e0e0));
        color: color-mix(in srgb, var(--dominds-primary, #007acc) 85%, var(--dominds-fg, #333333));
      }

      .header-pill-button.problems[data-has-problems='true'][data-severity='warning'] {
        background: color-mix(in srgb, #f59e0b 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #f59e0b 35%, var(--dominds-border, #e0e0e0));
        color: color-mix(in srgb, #b45309 85%, var(--dominds-fg, #333333));
      }

      .header-pill-button.problems[data-has-problems='true'][data-severity='error'] {
        background: var(--dominds-danger-bg, #f8d7da);
        border-color: var(--dominds-danger-border, #f5c6cb);
        color: var(--dominds-danger, #721c24);
      }

      #navibar-context-health {
        cursor: default;
        font-variant-numeric: tabular-nums;
        width: 20px;
        height: 20px;
        padding: 0;
        border-radius: 999px;
        border: none;
        background: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      #navibar-context-health[data-level='healthy'] {
        color: var(--dominds-success, #155724);
      }

      #navibar-context-health[data-level='caution'] {
        color: color-mix(in srgb, #b45309 85%, var(--dominds-fg, #333333));
      }

      #navibar-context-health[data-level='critical'] {
        color: var(--dominds-danger, #721c24);
      }

      #navibar-context-health[data-level='unknown'] {
        color: var(--dominds-muted, #666666);
      }

          .ctx-usage-svg {
            display: block;
          }

          .ctx-usage-ring {
            stroke: var(--dominds-border, #e0e0e0);
            stroke-width: 1.5;
          }

          #navibar-context-health[data-level='unknown'] .ctx-usage-ring {
            stroke: color-mix(in srgb, var(--dominds-muted, #666666) 70%, var(--dominds-bg, #ffffff));
          }

      .ctx-usage-wedge {
        fill: color-mix(in srgb, currentColor 60%, var(--dominds-bg, #ffffff));
      }

          .ctx-usage-mark-optimal {
            stroke: color-mix(in srgb, #f59e0b 68%, var(--dominds-fg, #333333));
            stroke-width: 1.2;
          }

          .ctx-usage-mark-critical {
            stroke: color-mix(in srgb, var(--dominds-danger, #721c24) 80%, var(--dominds-bg, #ffffff));
            stroke-width: 1.2;
          }
      #navibar-context-health-wrap {
        display: inline-flex;
        align-items: center;
        position: relative;
      }

      #navibar-context-health-wrap .navibar-tooltip {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        left: auto;
        transform: none;
        background: var(--dominds-fg, #333333);
        background: color-mix(
          in srgb,
          var(--dominds-fg, #333333) var(--dominds-alpha-surface-tooltip, 94%),
          transparent
        );
        color: var(--dominds-bg, #ffffff);
        padding: 6px 8px;
        border-radius: 6px;
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1.25;
        text-align: left;
        width: max-content;
        white-space: pre-line;
        overflow-wrap: normal;
        max-width: min(420px, calc(100vw - 24px));
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        z-index: var(--dominds-z-overlay-tooltip, 1100);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.2);
      }

      #navibar-context-health-wrap .navibar-tooltip::after {
        content: '';
        position: absolute;
        bottom: 100%;
        right: 6px;
        left: auto;
        transform: none;
        border: 6px solid transparent;
        border-bottom-color: var(--dominds-fg, #333333);
        border-bottom-color: color-mix(
          in srgb,
          var(--dominds-fg, #333333) var(--dominds-alpha-surface-tooltip, 94%),
          transparent
        );
      }

      #navibar-context-health-wrap:hover .navibar-tooltip {
        opacity: 1;
      }

      .problems-panel {
        position: fixed;
        top: 52px;
        right: 8px;
        width: min(500px, calc(100vw - 16px));
        max-height: calc(100vh - 64px);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 8px;
        background: var(--dominds-bg, #ffffff);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-panel, 96%),
          transparent
        );
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
        overflow: hidden;
        z-index: var(--dominds-z-overlay-problems, 1200);
        display: flex;
        flex-direction: column;
      }

      .problems-panel.hidden {
        display: none;
      }

      .problems-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-sidebar-bg, #f8f9fa);
      }

      .problems-panel-title {
        font-size: var(--dominds-font-size-md, 13px);
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .problems-panel-actions {
        display: inline-flex;
        gap: 4px;
        align-items: center;
      }

      .problems-panel-actions button {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 6px;
        padding: 3px 6px;
        font-size: var(--dominds-font-size-sm, 12px);
        cursor: pointer;
      }

      .problems-panel-actions button:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .problems-list {
        padding: 8px 10px;
        overflow: auto;
      }

      .problems-list.empty {
	        display: flex;
	        flex-direction: column;
	        justify-content: center;
        min-height: 72px;
      }

      .problem-item {
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        padding: 6px 8px;
        margin-bottom: 6px;
        background: var(--dominds-bg, #ffffff);
      }

      .problem-item[data-severity='warning'] {
        border-color: color-mix(in srgb, #f59e0b 40%, var(--dominds-border, #e0e0e0));
      }

      .problem-item[data-severity='error'] {
        border-color: var(--dominds-danger-border, #f5c6cb);
        background: color-mix(in srgb, var(--dominds-danger-bg, #f8d7da) 35%, var(--dominds-bg, #ffffff));
      }

      .problem-item[data-resolved='true'] {
        opacity: 0.86;
        background: color-mix(in srgb, var(--dominds-sidebar-bg, #f8f9fa) 88%, var(--dominds-bg, #ffffff));
      }

      .problem-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
      }

      .problem-message {
        font-size: var(--dominds-font-size-md, 13px);
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .problem-meta {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        white-space: nowrap;
      }

      .problem-timestamp {
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
      }

      .problem-detail {
        margin-top: 4px;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .problem-detail-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .problem-detail-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: baseline;
      }

      .problem-detail-label {
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .problem-detail-value {
        white-space: pre-wrap;
      }

      .problem-detail-value.code {
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
      }

      .problem-detail-block {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .problem-lifecycle {
        margin-top: 4px;
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: color-mix(in srgb, var(--dominds-sidebar-bg, #f8f9fa) 65%, var(--dominds-bg, #ffffff));
      }

      .lang-select {
        height: 24px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 7px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        color: var(--dominds-fg, #333333);
        padding: 0 9px;
        font-size: var(--dominds-font-size-sm, 12px);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        white-space: nowrap;
      }

      .lang-select[data-lang-match='match'] {
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 70%, white 30%);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 18%, transparent);
      }

      .lang-select[data-lang-match='mismatch'] {
        border-color: color-mix(in srgb, #d97706 70%, white 30%);
        box-shadow: 0 0 0 2px color-mix(in srgb, #d97706 18%, transparent);
      }

      .lang-select[data-lang-match='unknown'] {
        border-style: dashed;
      }

      .ui-language-menu {
        position: relative;
      }

      .ui-language-menu-popover {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        min-width: 300px;
        max-width: 380px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        background: color-mix(
          in srgb,
          var(--dominds-sidebar-bg, #f8f9fa) var(--dominds-alpha-surface-popover, 92%),
          transparent
        );
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
        padding: 4px;
        z-index: var(--dominds-z-overlay-popover, 1000);
      }

      .ui-language-menu-item {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        text-align: left;
        padding: 8px 8px;
        border-radius: 6px;
      }

      .ui-language-menu-item:hover {
        background: color-mix(in srgb, var(--dominds-hover) 80%, var(--dominds-fg) 20%);
      }

      .ui-language-menu-item[data-lang-match='match'] {
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 70%, white 30%);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 18%, transparent);
      }

      .ui-language-menu-item[data-lang-match='mismatch'] {
        border-color: color-mix(in srgb, #d97706 70%, white 30%);
        box-shadow: 0 0 0 2px color-mix(in srgb, #d97706 18%, transparent);
      }

      .ui-language-menu-item[data-lang-match='unknown'] {
        border-style: dashed;
        border-color: var(--dominds-border, #e0e0e0);
      }

      .ui-language-menu-item[data-selected='true'] .ui-language-menu-item-label {
        font-weight: 600;
        color: var(--dominds-primary, #007acc);
      }

      .ui-language-menu-item-label {
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.3;
      }

      .ui-language-menu-item-tip {
        margin-top: 4px;
        margin-left: 8px;
        padding-left: 8px;
        border-left: 2px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 80%, transparent);
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1.4;
        white-space: normal;
      }

      .ui-language-menu-item-tip p {
        margin: 0;
      }

      .ui-language-menu-item-tip ul,
      .ui-language-menu-item-tip ol {
        margin: 4px 0 0 0;
        padding-left: 14px;
      }

      .ui-language-menu-item-tip li {
        margin: 1px 0 0 0;
      }

      .ui-language-menu-button-caret {
        width: 12px;
        height: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .theme-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 5px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .theme-toggle .icon-mask {
        width: 16px;
        height: 16px;
      }

      .theme-toggle:hover {
        background: var(--dominds-hover, #f0f0f0);
        transform: scale(1.05);
      }

	      .theme-toggle:active {
	        transform: scale(0.95);
	      }
	
      .toast-history-modal {
		        position: fixed;
		        inset: 0;
		        z-index: var(--dominds-z-overlay-toast-history, 2100);
        display: flex;
		        align-items: flex-start;
		        justify-content: center;
        padding: 48px 10px 10px;
        background: rgba(0, 0, 0, 0.35);
        background: color-mix(in srgb, #000000 var(--dominds-alpha-overlay-backdrop, 35%), transparent);
      }
	
	      .toast-history-modal.hidden {
	        display: none;
	      }
	
      .toast-history-panel {
        width: min(860px, calc(100vw - 32px));
        max-height: calc(100vh - 72px);
        background: var(--dominds-bg, #ffffff);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-panel, 96%),
          transparent
        );
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
	        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
	        overflow: hidden;
	        display: flex;
	        flex-direction: column;
	      }
	
      .toast-history-header {
	        display: flex;
	        align-items: center;
	        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
      }
	
	      .toast-history-title {
	        font-size: var(--dominds-font-size-md, 13px);
	        font-weight: 600;
	        color: var(--dominds-fg, #333333);
	      }
	
      .toast-history-actions {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
	
      .toast-history-actions button {
        width: 28px;
        height: 28px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        cursor: pointer;
      }
	
	      .toast-history-actions button:hover {
	        background: var(--dominds-hover, #f0f0f0);
	      }
	
      .toast-history-list {
        padding: 8px 10px;
        overflow: auto;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-fg, #333333);
      }
	
      .toast-history-empty {
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-sm, 12px);
        padding: 8px 2px;
      }
	
      .toast-history-item {
        display: flex;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px dashed color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
      }
	
	      .toast-history-item:last-child {
	        border-bottom: none;
	      }
	
      .toast-history-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 2px;
      }

      .toast-history-icon .icon-mask {
        width: 14px;
        height: 14px;
      }
	
	      .toast-history-body {
	        min-width: 0;
	        flex: 1;
	      }
	
	      .toast-history-message {
	        white-space: pre-wrap;
	        word-break: break-word;
	      }
	
	      .toast-history-meta {
	        margin-top: 2px;
	        color: var(--dominds-muted, #666666);
	        font-size: var(--dominds-font-size-xs, 11px);
          font-family: var(
            --font-mono,
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace
          );
	      }

	      .main-content {
	        display: flex;
	        flex: 1;
	        min-height: 0;
        overflow: hidden;
      }

      .sidebar {
        width: var(--dominds-sidebar-default-width);
        min-width: 200px;
        max-width: 600px;
        background: var(--dominds-sidebar-bg);
        border-right: 1px solid var(--dominds-border);
	        display: flex;
	        flex-direction: column;
	        min-height: 0;
	        overflow: hidden;
	        resize: horizontal;
	        position: relative;
      }

      .activity-bar {
        padding: 1px 6px;
        min-height: 30px;
        border-bottom: 1px solid var(--dominds-border);
        flex-shrink: 0;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 4px;
      }

      .activity-button {
        position: relative;
      }

      .activity-button[aria-pressed="true"] {
        background: var(--dominds-hover, #f0f0f0);
        color: var(--dominds-primary, #007acc);
        box-shadow: inset 0 0 0 1px var(--dominds-border, #e0e0e0);
      }

      .activity-spacer {
        flex: 1;
      }

	      .sidebar-content {
	        flex: 1;
	        min-height: 0;
	        overflow: hidden;
	        padding: 0;
	        display: flex;
	        flex-direction: column;
      }

      .activity-view {
        flex: 1;
        overflow: hidden;
        padding: 4px 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .activity-placeholder {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        font-size: var(--dominds-font-size-md, 13px);
        color: var(--dominds-muted, #666666);
      }

      .activity-placeholder-title {
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .activity-placeholder-text {
        line-height: 1.4;
      }

      .activity-placeholder dominds-team-members {
        margin-top: 4px;
      }

      #tools-widget {
        position: fixed;
        left: var(--tools-widget-left, 12px);
        top: var(--tools-widget-top, 56px);
        width: var(--tools-widget-width, 380px);
        height: var(--tools-widget-height, 320px);
        min-width: 260px;
        min-height: 180px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 12px;
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-tools, 94%),
          transparent
        );
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(14px);
        z-index: var(--dominds-z-overlay-tools, 920);
      }

      .tools-widget-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 80%, transparent);
        background: color-mix(in srgb, var(--dominds-bg, #ffffff) 78%, transparent);
        cursor: grab;
      }

      .tools-widget-header-main {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1 1 auto;
        font-size: var(--dominds-font-size-md, 13px);
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .tools-widget-timestamp {
        flex: 1;
        min-width: 0;
        text-align: right;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tools-widget-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .tools-widget-actions .icon-button {
        width: 26px;
        height: 26px;
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 82%, transparent);
        background: color-mix(in srgb, var(--dominds-bg, #ffffff) 84%, transparent);
      }

      .tools-widget-actions .icon-button:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .tools-widget-content {
        overflow-x: hidden;
        overflow-y: auto;
        display: block;
        flex: 1 1 0;
        height: 0;
        padding: 8px 10px 30px;
        min-height: 0;
      }

      .tools-widget-content > * + * {
        margin-top: 8px;
      }

      #tools-widget-resize-handle {
        position: absolute;
        left: 8px;
        bottom: 8px;
        width: 14px;
        height: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: nesw-resize;
        opacity: 0.65;
      }

      #tools-widget-resize-handle:hover {
        opacity: 1;
      }

      #tools-widget-resize-handle .icon-mask {
        width: 12px;
        height: 12px;
      }

      .tools-widget-status {
        padding: 6px 8px;
        border-radius: 8px;
        color: var(--dominds-muted, #666666);
        background: color-mix(in srgb, var(--dominds-fg, #333333) 4%, transparent);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .tools-widget-status-error {
        color: var(--dominds-error, #b3261e);
        background: color-mix(in srgb, var(--dominds-error, #b3261e) 10%, transparent);
      }

      .tools-widget-status-warning {
        color: var(--dominds-warning, #856404);
        background: color-mix(in srgb, var(--dominds-warning, #856404) 12%, transparent);
      }

      .tools-section {
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
        background: var(--dominds-bg-secondary, #ffffff);
        overflow: hidden;
        margin-bottom: 8px;
      }

      .tools-section:last-child {
        margin-bottom: 0;
      }

      .tools-section-title {
        cursor: pointer;
        display: flex;
        align-items: center;
        padding: 5px 8px;
        background: color-mix(in srgb, var(--dominds-fg, #333333) 4%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
        font-weight: 600;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-xs, 11px);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        list-style: none;
        user-select: none;
      }

      .tools-section-title::-webkit-details-marker {
        display: none;
      }

      details.tools-section:not([open]) > summary.tools-section-title {
        border-bottom: none;
      }

      .tools-section-title:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      details.tools-section > summary.tools-section-title::before {
        content: "";
        display: inline-block;
        width: 14px;
        height: 14px;
        margin-right: 6px;
        background-color: var(--dominds-muted, #666666);
        -webkit-mask: ${ICON_MASK_URLS.scrollDown} no-repeat center / contain;
        mask: ${ICON_MASK_URLS.scrollDown} no-repeat center / contain;
      }

      details.tools-section:not([open]) > summary.tools-section-title::before {
        -webkit-mask: ${ICON_MASK_URLS.chevronRight} no-repeat center / contain;
        mask: ${ICON_MASK_URLS.chevronRight} no-repeat center / contain;
      }

      .tools-section-toolsets {
        padding: 8px;
      }

      .toolset {
        border-bottom: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 60%, transparent);
        padding-bottom: 8px;
        margin-bottom: 8px;
      }

      .toolset:last-child {
        border-bottom: none;
        padding-bottom: 0;
        margin-bottom: 0;
      }

      .toolset-title {
        cursor: pointer;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
        font-size: 13px;
        list-style: none;
      }

      .toolset-title::-webkit-details-marker {
        display: none;
      }

      details.toolset > summary.toolset-title::before {
        content: "";
        display: inline-block;
        width: 14px;
        height: 14px;
        margin-right: 6px;
        background-color: var(--dominds-muted, #666666);
        -webkit-mask: ${ICON_MASK_URLS.chevronRight} no-repeat center / contain;
        mask: ${ICON_MASK_URLS.chevronRight} no-repeat center / contain;
      }

      details.toolset[open] > summary.toolset-title::before {
        -webkit-mask: ${ICON_MASK_URLS.scrollDown} no-repeat center / contain;
        mask: ${ICON_MASK_URLS.scrollDown} no-repeat center / contain;
      }

      summary.toolset-title[data-desc]::after {
        content: attr(data-desc);
        display: block;
        margin-left: 20px;
        margin-top: 2px;
        font-weight: 400;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.3;
        text-transform: none;
        letter-spacing: normal;
        white-space: normal;
      }

      .toolset-tools {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .tool-item {
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
        border-radius: 8px;
        padding: 6px 8px;
        background: var(--dominds-bg, #ffffff);
      }

      .tool-main {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tool-kind {
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 5px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-xs, 11px);
        flex-shrink: 0;
      }

      .tool-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-fg, #333333);
      }

      .tool-desc {
        margin-top: 4px;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tools-empty {
        padding: 6px 8px;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .activity-view running-dialog-list,
      .activity-view done-dialog-list,
      .activity-view archived-dialog-list {
        flex: 1;
        min-height: 0;
      }

      .hidden { display: none; }

      .content-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .navibar {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 1px 6px;
        min-height: 30px;
        background: var(--dominds-toolbar-bg, #f8f9fa);
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        flex-shrink: 0;
        position: relative;
      }

      .navibar-left {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .navibar-spacer {
        flex: 1;
      }

      .navibar-gap-left {
        margin-left: 12px;
      }

      #course-navi {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        gap: 3px;
      }

      .course-navi-label {
        margin: 0 8px;
        min-width: 28px;
        display: inline-block;
        text-align: center;
      }

      #reminders-callout {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        position: relative;
      }

      .reminders-refresh-button {
        margin-left: 6px;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        border-radius: 5px;
        cursor: pointer;
        color: var(--dominds-fg, #333333);
      }

      .icon-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .icon-button:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      .icon-button[aria-pressed="true"] {
        background: var(--dominds-hover, #f0f0f0);
        box-shadow: inset 0 0 0 1px var(--dominds-border, #e0e0e0);
        color: var(--dominds-primary, #007acc);
      }

      .header-run-pill-icon .icon-mask,
      .header-pill-button .icon-mask,
      #toast-history-btn .icon-mask {
        width: 20px;
        height: 20px;
      }

      .header-run-pill-icon .icon-mask.app-icon-stop {
        width: 16px;
        height: 16px;
      }

      .header-run-pill-icon .icon-mask.app-icon-play {
        width: 18px;
        height: 18px;
      }

      .header-pill-button .icon-mask.app-icon-warning {
        width: 16px;
        height: 16px;
      }

      #toast-history-btn .icon-mask.app-icon-history {
        width: 16px;
        height: 16px;
      }

      .badge-button .icon-mask,
      .tools-widget-actions .icon-mask,
      .problems-panel-actions .icon-mask,
      .toast-history-actions .icon-mask,
      .icon-button .icon-mask {
        width: 14px;
        height: 14px;
      }

      .navibar .icon-button .icon-mask {
        width: 18px;
        height: 18px;
      }

      #navibar-tools-toggle .icon-mask {
        width: 16px;
        height: 16px;
      }

      .activity-button .icon-mask {
        width: 18px;
        height: 18px;
      }

      .app-icon-16 {
        width: 16px !important;
        height: 16px !important;
      }

      .bp-collapse-btn .icon-mask {
        width: 56px;
        height: 8px;
      }

      .app-icon-stop {
        --icon-mask: ${ICON_MASK_URLS.stop};
      }

      .app-icon-play {
        --icon-mask: ${ICON_MASK_URLS.play};
      }

      .app-icon-warning {
        --icon-mask: ${ICON_MASK_URLS.warning};
      }

      .app-icon-history {
        --icon-mask: ${ICON_MASK_URLS.history};
      }

      .app-icon-refresh {
        --icon-mask: ${ICON_MASK_URLS.refresh};
      }

      .app-icon-close {
        --icon-mask: ${ICON_MASK_URLS.close};
      }

      .app-icon-error {
        --icon-mask: ${ICON_MASK_URLS.error};
      }

      .app-icon-info {
        --icon-mask: ${ICON_MASK_URLS.info};
      }

      .app-icon-folder {
        --icon-mask: ${ICON_MASK_URLS.folder};
      }

      .app-icon-trash {
        --icon-mask: ${ICON_MASK_URLS.trash};
      }

      .app-icon-running {
        --icon-mask: ${ICON_MASK_URLS.activityRunning};
      }

      .app-icon-done {
        --icon-mask: ${ICON_MASK_URLS.done};
      }

      .app-icon-archive {
        --icon-mask: ${ICON_MASK_URLS.archive};
      }

      .app-icon-search {
        --icon-mask: ${ICON_MASK_URLS.search};
      }

      .app-icon-users {
        --icon-mask: ${ICON_MASK_URLS.users};
      }

      .app-icon-tools {
        --icon-mask: ${ICON_MASK_URLS.tools};
      }

      .app-icon-plus {
        --icon-mask: ${ICON_MASK_URLS.plus};
      }

      .app-icon-save {
        --icon-mask: ${ICON_MASK_URLS.save};
      }

      .app-icon-prev {
        --icon-mask: ${ICON_MASK_URLS.chevronLeft};
      }

      .app-icon-next {
        --icon-mask: ${ICON_MASK_URLS.chevronRight};
      }

      .app-icon-bookmark {
        --icon-mask: ${ICON_MASK_URLS.bookmark};
      }

      .app-icon-upload {
        --icon-mask: ${ICON_MASK_URLS.uploadCloud};
      }

      .app-icon-collapse-strip {
        --icon-mask: ${ICON_MASK_URLS.collapseStrip};
      }

      .app-icon-theme-dark {
        --icon-mask: ${ICON_MASK_URLS.themeDark};
      }

      .app-icon-theme-light {
        --icon-mask: ${ICON_MASK_URLS.themeLight};
      }

      .app-icon-caret-down {
        --icon-mask: ${ICON_MASK_URLS.scrollDown};
      }

      .app-icon-resize-corner-bottom-left {
        --icon-mask: ${ICON_MASK_URLS.resizeCornerBottomLeft};
      }

      .app-icon-check {
        --icon-mask: ${ICON_MASK_URLS.check};
      }

      .app-icon-circle {
        --icon-mask: ${ICON_MASK_URLS.circle};
      }

      .badge-button {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        padding: 1px 6px;
        border-radius: 5px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .badge-button .reminders-count {
        display: inline-block;
        min-width: 0;
        height: auto;
        padding: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        font-size: 11px;
        line-height: 1;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        transition: all 0.2s ease;
      }

      .badge-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .badge-button.danger {
        border-color: color-mix(in srgb, var(--dominds-danger, #dc3545) 35%, var(--dominds-border, #e0e0e0));
      }

      .badge-button:hover:not(:disabled) {
        background: var(--dominds-hover, #f0f0f0);
        border-color: var(--dominds-primary, #007acc);
      }

      #navibar-reminders-toggle[aria-pressed="true"] {
        background: var(--dominds-bg, #ffffff);
        border-color: var(--dominds-border, #e0e0e0);
        box-shadow: none;
        color: #005c9a;
      }

      #navibar-reminders-toggle[aria-pressed="true"]:hover:not(:disabled) {
        background: var(--dominds-hover, #f0f0f0);
        border-color: var(--dominds-border, #e0e0e0);
      }

      #navibar-reminders-toggle[aria-pressed="true"] .icon-mask {
        background-color: #005c9a;
        color: #005c9a;
      }

      #navibar-reminders-toggle[aria-pressed="true"] .reminders-count {
        background: transparent;
        color: #005c9a;
        box-shadow: none;
      }

      .badge-button.danger:hover:not(:disabled) {
        border-color: var(--dominds-danger, #dc3545);
      }

	      .dialog-section {
	        display: flex;
	        flex-direction: column;
	        flex: 1;
	        min-height: 0;
	        overflow: hidden;
	        position: relative;
          background: var(--dominds-sidebar-bg, #f8f9fa);
	      }

      .conversation-viewport {
        position: relative;
        flex: 1;
        min-height: 0;
      }

      /* Conversation area scrolls independently */
      .conversation-scroll-area {
        flex: 1;
        height: 100%;
        min-height: 0;
        overflow-y: auto;
        contain: content;
        background: var(--dominds-sidebar-bg, #f8f9fa);
      }

      .dialog-viewport-panels {
        display: flex;
        flex-direction: column;
        gap: 10px;
        flex-shrink: 0;
        padding: 0 12px 12px 12px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
      }

      .dialog-viewport-panels.hidden,
      .dialog-viewport-panel.hidden {
        display: none;
      }

      .dialog-viewport-panel {
        padding: 9px 10px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        border-radius: 8px;
        background: var(
          --dominds-sidebar-bg,
          var(--dominds-bg, var(--color-bg-secondary, #ffffff))
        );
        max-height: 20vh;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
      }

      .dialog-viewport-panel-header {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }

      .dialog-viewport-panel-header .icon-mask {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        margin-top: 1px;
      }

      .dialog-viewport-panel-text {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .dialog-viewport-panel-title {
        font-weight: 600;
        font-size: var(--dominds-font-size-md, 13px);
        color: var(--dominds-fg, var(--color-fg-primary, #0f172a));
      }

      .dialog-viewport-panel-summary {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        margin-top: 1px;
        overflow-wrap: anywhere;
      }

      .dialog-viewport-panel-error {
        margin-top: 4px;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .dialog-viewport-panel-actions {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .dialog-resume-btn {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        background: var(--dominds-primary, var(--color-accent-primary, #007acc));
        color: white;
        padding: 6px 8px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
      }

      .dialog-resume-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

	      .q4h-input-wrap {
	        flex-shrink: 0;
	        display: flex;
	        flex-direction: column;
	      }

	      .bottom-panel {
	        display: flex;
	        flex-direction: column;
	        flex-shrink: 0;
	        border-left: 1px solid var(--color-border-primary, #e2e8f0);
	        border-right: 1px solid var(--color-border-primary, #e2e8f0);
	        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
	        background: var(--dominds-sidebar-bg, #f8f9fa);
	      }

	      .bottom-panel-resize-handle {
	        position: relative;
	        height: 12px;
	        display: flex;
	        align-items: center;
	        justify-content: center;
	        flex: none;
	        background: transparent;
	        touch-action: none;
	        user-select: none;
	      }

	      .bottom-panel-resize-handle.hidden {
	        display: none;
	      }

	      .bp-resize-grip {
	        position: absolute;
	        top: 50%;
	        transform: translate(-50%, -50%);
	        width: 44px;
	        height: 12px;
	        padding: 0;
	        border: none;
	        background: transparent;
	        border-radius: 999px;
	        cursor: ns-resize;
	        display: flex;
	        align-items: center;
	        justify-content: center;
	        touch-action: none;
	      }

	      .bp-resize-grip.left {
	        left: 33.333%;
	      }

	      .bp-resize-grip.right {
	        left: 66.667%;
	      }

	      .bp-resize-grip::before {
	        content: '';
	        width: 44px;
	        height: 3px;
	        border-radius: 999px;
	        background: var(--dominds-border, #e0e0e0);
	      }

	      .bottom-panel-resize-handle:hover:not(.bp-collapse-hover) .bp-resize-grip::before,
	      .bottom-panel-resize-handle.resizing .bp-resize-grip::before {
	        background: var(--dominds-primary, #007acc);
	      }

	      .bp-collapse-btn {
	        position: absolute;
	        left: 50%;
	        top: 50%;
	        transform: translate(-50%, -50%);
	        width: 78px;
	        height: 16px;
	        border: 1px solid transparent;
	        background: transparent;
	        color: var(--dominds-muted, #64748b);
	        border-radius: 999px;
	        cursor: pointer;
	        display: inline-flex;
	        align-items: center;
	        justify-content: center;
	        padding: 0;
	      }

	      .bp-collapse-btn:hover {
	        color: var(--dominds-primary, #007acc);
	        background: var(--dominds-hover, #f0f0f0);
	        border-color: var(--dominds-border, #e0e0e0);
	      }

	      .bp-collapse-btn:focus-visible {
	        outline: 2px solid var(--dominds-primary, #007acc);
	        outline-offset: 1px;
	      }

	      .bottom-panel-footer {
	        display: flex;
	        gap: 4px;
	        align-items: center;
	        padding: 2px 8px;
	        border-top: 1px solid var(--color-border-primary, #e2e8f0);
	        background: var(--dominds-sidebar-bg, #f8f9fa);
	      }

	      .bp-tabs-right {
	        display: inline-flex;
	        gap: 4px;
	        align-items: center;
	        margin-left: auto;
	      }

      .bp-tab {
        appearance: none;
        border: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--dominds-sidebar-bg, #f8f9fa);
        color: var(--color-fg-secondary, #475569);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: var(--dominds-font-size-sm, 12px);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

	      .bp-tab.active {
	        border-color: var(--dominds-primary, #007acc);
	        color: var(--dominds-primary, #007acc);
	        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 15%, transparent);
	      }


	      .bp-checkbox {
	        width: 14px;
	        height: 14px;
	        margin: 0;
	        cursor: pointer;
	        accent-color: var(--dominds-primary, #007acc);
	      }

	      .bp-badge {
	        display: inline-flex;
	        min-width: 22px;
	        padding: 1px 6px;
	        border-radius: 999px;
	        background: var(--color-bg-tertiary, #f1f5f9);
	        color: var(--color-fg-tertiary, #64748b);
	        font-size: var(--dominds-font-size-xs, 11px);
	        border: 1px solid var(--color-border-primary, #e2e8f0);
	        justify-content: center;
	        text-align: center;
	        font-variant-numeric: tabular-nums;
	      }

	      .bp-badge.pulse {
	        animation: bpBadgePulse 220ms ease-out;
	      }

	      .bp-badge.shake {
	        animation: bpBadgeShake 340ms ease-in-out;
	      }

	      @keyframes bpBadgePulse {
	        0% { transform: scale(1); }
	        40% { transform: scale(1.12); }
	        100% { transform: scale(1); }
	      }

	      button.bp-tab[data-bp-tab='diligence'] .bp-badge {
	        min-width: 56px;
	        padding: 1px 8px;
	        box-sizing: border-box;
	      }

	      button.bp-tab[data-bp-tab='diligence'] .bp-badge[data-has-remaining='true'] {
	        background: color-mix(in srgb, var(--dominds-primary, #007acc) 80%, var(--dominds-bg, #ffffff));
	        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 85%, var(--dominds-border, #e0e0e0));
	        color: white;
	      }

	      button.bp-tab[data-bp-tab='diligence'] .bp-badge.pulse {
	        animation: bpBadgePulseStrong 420ms ease-out;
	      }

	      button.bp-tab[data-bp-tab='diligence'] .bp-badge.shake,
	      button.bp-tab[data-bp-tab='diligence'] .bp-badge.pulse.shake {
	        animation: bpBadgeShake 340ms ease-in-out;
	      }

	      @keyframes bpBadgePulseStrong {
	        0% {
	          transform: scale(1);
	          box-shadow: 0 0 0 0 rgba(0, 122, 204, 0);
	          filter: none;
	        }
	        35% {
	          transform: scale(1.2);
	          box-shadow: 0 0 0 6px rgba(0, 122, 204, 0.18);
	          filter: brightness(1.08);
	        }
	        100% {
	          transform: scale(1);
	          box-shadow: 0 0 0 0 rgba(0, 122, 204, 0);
	          filter: none;
	        }
	      }

	      @keyframes bpBadgeShake {
	        0% { transform: translateX(0); }
	        15% { transform: translateX(-3px) rotate(-1deg); }
	        30% { transform: translateX(3px) rotate(1deg); }
	        45% { transform: translateX(-2px) rotate(-0.8deg); }
	        60% { transform: translateX(2px) rotate(0.8deg); }
	        75% { transform: translateX(-1px) rotate(-0.5deg); }
	        100% { transform: translateX(0) rotate(0); }
	      }

	      button.bp-tab[data-bp-tab='q4h'] .bp-badge[data-has-questions='true'] {
	        background: color-mix(in srgb, var(--dominds-primary, #007acc) 80%, var(--dominds-bg, #ffffff));
	        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 85%, var(--dominds-border, #e0e0e0));
	        color: white;
	      }

	      .bottom-panel-content {
	        display: none;
	        height: var(--bottom-panel-height, 280px);
	        min-height: 0;
	        overflow: hidden;
	        flex-direction: column;
	      }

      .bottom-panel.expanded .bottom-panel-content {
        display: flex;
      }

	      .bp-content.hidden {
	        display: none;
	      }

	      #q4h-panel.hidden {
	        display: none;
	      }

	      .bp-content {
	        display: flex;
	        flex-direction: column;
	        flex: 1;
	        min-height: 0;
	        overflow: hidden;
	        border-top: 1px solid var(--color-border-primary, #e2e8f0);
	        background: var(--dominds-bg, #ffffff);
	      }

	      .bp-q4h dominds-q4h-panel {
	        flex: 1;
	        min-height: 0;
	      }

	      .bp-docs dominds-docs-panel,
	      .bp-team-manual dominds-team-manual-panel,
		      .bp-snippets dominds-snippets-panel {
	        flex: 1;
	        min-height: 0;
	        min-width: 0;
	        max-width: 100%;
	      }

	      .bp-q4h-empty {
	        padding: 3px 8px;
	        color: var(--color-fg-tertiary, #64748b);
	        font-size: var(--dominds-font-size-sm, 12px);
	        flex: 1;
	        min-height: 0;
	        display: flex;
	        align-items: center;
	        justify-content: center;
	      }

	      .bp-q4h-empty.hidden {
	        display: none;
	      }

      .bp-diligence-row {
        display: flex;
        gap: 6px;
        align-items: center;
        padding: 2px 8px;
        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--color-bg-secondary, #f8fafc);
      }

      .bp-diligence-help {
        flex: 1;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--color-fg-tertiary, #64748b);
      }

	      .bp-textarea {
	        width: 100%;
	        box-sizing: border-box;
	        flex: 1;
	        min-height: 0;
	        padding: 3px 8px;
	        border: none;
	        outline: none;
	        resize: none;
	        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
	          'Courier New', monospace;
	        font-size: 12px;
	        line-height: 1.35;
	        color: var(--color-fg-primary, #0f172a);
	        background: var(--dominds-bg, #ffffff);
	      }

	      .q4h-readonly-banner {
	        padding: 2px 8px;
	        border-top: 1px solid var(--dominds-border, #e0e0e0);
	        background: var(--dominds-toolbar-bg, #f8f9fa);
	        color: var(--dominds-muted, #666666);
	        font-size: var(--dominds-font-size-md, 13px);
	      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 150px;
        color: var(--dominds-muted, #666666);
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--dominds-border, #e0e0e0);
        border-top: 2px solid var(--dominds-primary, #007acc);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-right: 6px;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .button {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        background: var(--dominds-primary, #007acc);
        color: white;
        cursor: pointer;
        font-size: var(--dominds-font-size-base, 14px);
        transition: background-color 0.2s;
      }

      .button:hover {
        background: var(--dominds-primary-hover, #005ea6);
      }

      .button:disabled {
        background: var(--dominds-disabled, #cccccc);
        cursor: not-allowed;
      }

      .button-secondary {
        background: var(--dominds-secondary, #6c757d);
      }

      .button-secondary:hover {
        background: var(--dominds-secondary-hover, #545b62);
      }

      /* Connection status indicator */
      .connection-status {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 12px;
        font-size: var(--dominds-font-size-sm, 12px);
        font-weight: 500;
      }

      .status-connected {
        background: var(--dominds-success-bg, #d4edda);
        color: var(--dominds-success, #155724);
      }

      .status-connecting {
        background: var(--dominds-warning-bg, #fff3cd);
        color: var(--dominds-warning, #856404);
      }

      .status-disconnected,
      .status-error,
      .status-reconnecting {
        background: var(--dominds-danger-bg, #f8d7da);
        color: var(--dominds-danger, #721c24);
      }

      .status-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .indicator-connected { background: var(--dominds-success, #28a745); }
      .indicator-connecting { background: var(--dominds-warning, #ffc107); }
      .indicator-disconnected { background: var(--dominds-danger, #dc3545); }
      .indicator-error { background: var(--dominds-danger, #dc3545); }
      .indicator-reconnecting { background: var(--dominds-warning, #ffc107); }

      /* Responsive design */
      @media (max-width: 768px) {
        .sidebar {
          width: var(--dominds-sidebar-mobile-width);
          min-width: 240px;
          max-width: 400px;
        }

        .header {
          padding: 4px 6px;
        }

        .navibar {
          padding: 1px 6px;
        }
      }

      @media (max-width: 480px) {
        .sidebar {
          position: absolute;
          left: calc(-1 * var(--dominds-sidebar-mobile-width));
          transition: left 0.3s ease;
          z-index: var(--dominds-z-sidebar-mobile, 120);
          resize: none;
        }

        .sidebar.mobile-open {
          left: 0;
        }

        .rtws-indicator {
          font-size: var(--dominds-font-size-micro, 10px);
        }
      }

      /* Create Dialog Modal */
      .dominds-modal,
      .create-dialog-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--dominds-z-overlay-modal, 2000);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
      }

      .modal-error {
        display: none;
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--dominds-danger-border, #f5c6cb);
        background: var(--dominds-danger-bg, #f8d7da);
        color: var(--dominds-danger, #721c24);
        font-size: var(--dominds-font-size-md, 13px);
        line-height: 1.4;
      }

      #auth-modal-error {
        display: none;
        color: var(--dominds-danger, #dc3545);
        font-size: var(--dominds-font-size-md, 13px);
      }

      .modal-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        background: color-mix(
          in srgb,
          #000000 var(--dominds-alpha-overlay-backdrop-strong, 50%),
          transparent
        );
        backdrop-filter: blur(2px);
      }

      .modal-content {
        position: relative;
        background: var(--dominds-bg, #ffffff);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-panel, 96%),
          transparent
        );
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
        min-width: 360px;
        max-width: 500px;
        width: 90vw;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        animation: modalFadeIn 0.2s ease-out;
      }

      @keyframes modalFadeIn {
        from {
          opacity: 0;
          transform: translateY(-20px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px 10px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
      }

	      .modal-header h3 {
	        margin: 0;
	        font-size: 14px;
	        font-weight: 600;
	        color: var(--dominds-fg, #333333);
	      }

	      .modal-close {
	        background: none;
	        border: none;
	        cursor: pointer;
	        color: var(--dominds-muted, #666666);
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
	      }

      .modal-close .icon-mask {
        width: 14px;
        height: 14px;
      }

      .modal-close:hover {
        background: var(--dominds-hover, #f5f5f5);
        color: var(--dominds-fg, #333333);
      }

      .modal-body {
        padding: 12px 16px;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .modal-description {
        margin: 0 0 12px 0;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-base, 14px);
        line-height: 1.5;
      }

      .form-group {
        margin-bottom: 12px;
      }

      .form-group-vertical > label {
        display: block;
        margin-bottom: 4px;
        font-weight: 500;
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
      }

      .form-group-horizontal > label {
        display: inline-flex;
        align-items: center;
        margin-bottom: 0;
        font-weight: 500;
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
      }

      .form-group-horizontal {
        margin: 12px;
      }

      .form-inline-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .form-inline-row > label {
        display: inline-flex;
        align-items: center;
        margin-bottom: 0;
        font-weight: 500;
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
        white-space: nowrap;
      }

      .teammate-dropdown {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
        transition: border-color 0.2s ease;
      }

      .teammate-dropdown:focus {
        outline: none;
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-focus, #007acc) 20%, transparent);
      }

      .teammate-info {
        margin-top: 12px;
        padding: 12px;
        background: var(--dominds-hover, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        display: none;
        max-height: min(30vh, 260px);
        overflow-y: auto;
      }

      .task-doc-container {
        position: relative;
        width: 100%;
        box-sizing: border-box;
      }

      .form-inline-row .task-doc-container {
        flex: 1 1 280px;
        width: auto;
        min-width: 180px;
      }

      .form-inline-row .teammate-dropdown {
        flex: 1 1 220px;
        width: auto;
        min-width: 180px;
      }

      .task-doc-input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
        transition: border-color 0.2s ease;
      }

      .task-doc-input:focus {
        outline: none;
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-focus, #007acc) 20%, transparent);
      }

      .task-doc-suggestions {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: var(--dominds-bg, #ffffff);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-popover, 92%),
          transparent
        );
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-top: none;
        border-radius: 0 0 6px 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        max-height: 400px;
        overflow-y: auto;
        z-index: var(--dominds-z-overlay-popover, 1000);
        display: none;
      }

      .priming-header-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .priming-group {
        margin-top: 12px;
      }

      .priming-inline-select {
        flex: 1 1 220px;
        min-width: 160px;
      }

      .priming-ui-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-sm, 12px);
        margin-left: auto;
        white-space: nowrap;
      }

      .priming-ui-toggle.disabled {
        opacity: 0.5;
      }

      .priming-more-section {
        margin-top: 8px;
      }

      .priming-search-results {
        margin-top: 6px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        max-height: 180px;
        overflow-y: auto;
        background: var(--dominds-bg, #ffffff);
      }

      .priming-search-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
      }

      .priming-search-item:last-child {
        border-bottom: none;
      }

      .priming-search-meta {
        min-width: 0;
      }

      .priming-search-name {
        font-size: var(--dominds-font-size-base, 14px);
        color: var(--dominds-fg, #333333);
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .priming-search-ref {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
        overflow-wrap: anywhere;
      }

      .priming-script-add {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: var(--dominds-font-size-sm, 12px);
        cursor: pointer;
      }

      .priming-script-add:hover:not(:disabled) {
        border-color: var(--dominds-primary, #007acc);
      }

      .priming-search-empty {
        padding: 10px 12px;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .priming-selected-list {
        margin-top: 8px;
      }

      .priming-selected-title {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        margin-bottom: 6px;
      }

      .priming-selected-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .priming-script-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-hover, #f8f9fa);
        border-radius: 999px;
        padding: 3px 8px;
        max-width: 100%;
      }

      .priming-script-chip span {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-fg, #333333);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 190px;
      }

      .priming-script-chip small {
        font-size: var(--dominds-font-size-micro, 10px);
        color: var(--dominds-muted, #666666);
      }

      .priming-script-remove {
        border: none;
        background: transparent;
        color: var(--dominds-muted, #666666);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
      }

      .suggestion {
        padding: 10px 12px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        cursor: pointer;
        transition: background-color 0.1s ease;
      }

      .suggestion:last-child {
        border-bottom: none;
      }

      .suggestion:hover,
      .suggestion.selected {
        background: var(--dominds-hover, #f5f5f5);
      }

      .suggestion-path {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
        margin-bottom: 2px;
        word-break: break-all;
      }

      .suggestion-name {
        font-size: var(--dominds-font-size-base, 14px);
        color: var(--dominds-fg, #333333);
        font-weight: 500;
      }

      .no-suggestions {
        padding: 10px 12px;
        color: var(--dominds-muted, #666666);
        font-style: italic;
        text-align: center;
      }

      .form-help {
        display: block;
        margin-top: 4px;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
      }

      .dominds-feel-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px 14px;
        margin: 0;
      }

      .dominds-feel-label {
        display: inline-flex;
        align-items: center;
        align-self: center;
        font-weight: 500;
        color: var(--dominds-fg, #333333);
        font-size: var(--dominds-font-size-base, 14px);
        line-height: 1.2;
        white-space: nowrap;
      }

      .dominds-feel-loading {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
      }

      .dominds-feel-options {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 14px;
        align-items: center;
      }

      .dominds-feel-option {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }

      .form-group-horizontal .dominds-feel-option {
        display: inline-flex;
        margin-bottom: 0;
      }

      .dominds-feel-option > input {
        margin: 0;
        align-self: center;
      }

      .dominds-feel-option > span {
        display: inline-flex;
        align-items: center;
        line-height: 1.2;
      }

	      .teammate-details h4 {
	        margin: 0 0 8px 0;
	        font-size: 13px;
	        font-weight: 600;
	        color: var(--dominds-fg, #333333);
	      }

      .teammate-details p {
        margin: 4px 0;
        font-size: var(--dominds-font-size-base, 14px);
        color: var(--dominds-muted, #666666);
      }

      .teammate-details strong {
        color: var(--dominds-fg, #333333);
        font-weight: 500;
      }

      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 16px 12px;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
      }

      .btn {
        padding: 6px 12px;
        border: none;
        border-radius: 6px;
        font-size: var(--dominds-font-size-base, 14px);
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        min-width: 68px;
      }

      .btn-secondary {
        background: var(--dominds-hover, #f5f5f5);
        color: var(--dominds-fg, #333333);
        border: 1px solid var(--dominds-border, #e0e0e0);
      }

      .btn-secondary:hover {
        background: var(--dominds-border, #e0e0e0);
      }

      .btn-primary {
        background: var(--dominds-primary, #007acc);
        color: white;
      }

      .btn-primary:hover {
        background: #005a9e;
      }

      .btn-primary:disabled {
        background: var(--dominds-disabled, #666666);
        cursor: not-allowed;
      }

      /* Simple modal theming */
      .modal-content {
        background: var(--dominds-bg);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-panel, 96%),
          transparent
        );
        border-color: var(--dominds-border);
      }

      .modal-header {
        border-bottom-color: var(--dominds-border);
      }

      .modal-footer {
        border-top-color: var(--dominds-border);
      }

      .teammate-info {
        background: var(--dominds-hover);
        border-color: var(--dominds-border);
      }

      .btn-secondary {
        background: var(--dominds-hover);
        border-color: var(--dominds-border);
        color: var(--dominds-fg);
      }

      .btn-secondary:hover {
        background: color-mix(in srgb, var(--dominds-hover) 80%, var(--dominds-fg) 20%);
      }

      .task-doc-input {
        background: var(--dominds-bg);
        border-color: var(--dominds-border);
        color: var(--dominds-fg);
      }

      .task-doc-suggestions {
        background: var(--dominds-bg);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-popover, 92%),
          transparent
        );
        border-color: var(--dominds-border);
      }

      .suggestion {
        border-bottom-color: var(--dominds-border);
      }

      .suggestion:hover,
      .suggestion.selected {
        background: var(--dominds-hover);
      }

      .suggestion-path {
        color: var(--dominds-muted);
      }

      .suggestion-name {
        color: var(--dominds-fg);
      }

      #reminders-widget {
        position: fixed;
        left: var(--reminders-widget-left, 12px);
        top: var(--reminders-widget-top, 56px);
        width: var(--reminders-widget-width, var(--dominds-reminders-widget-default-width));
        height: var(--reminders-widget-height, 240px);
        min-width: 260px;
        min-height: 160px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        background: color-mix(
          in srgb,
          var(--dominds-bg, #ffffff) var(--dominds-alpha-surface-reminders, 92%),
          transparent
        );
        border-radius: 10px;
        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
        z-index: var(--dominds-z-overlay-reminders, 900);
      }

      .reminders-widget-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        cursor: grab;
      }

      .reminders-widget-header-main {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #reminders-widget-content {
        padding: 8px 10px;
        overflow: auto;
        flex: 1 1 auto;
        min-height: 0;
      }

      .reminders-widget-empty {
        color: var(--dominds-muted, #666666);
        font-style: italic;
        text-align: center;
        padding: 12px;
      }

      #reminders-widget-resize-handle {
        position: absolute;
        left: 8px;
        bottom: 8px;
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: nesw-resize;
        color: var(--dominds-muted, #64748b);
        opacity: 0.72;
      }

      /* Reminder widget items */
      .rem-item {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 5px;
        padding: 4px 6px;
        margin-bottom: 3px;
        background: var(--dominds-hover, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 5px;
        font-size: var(--dominds-font-size-md, 13px);
        line-height: 1.4;
        color: var(--dominds-fg, #333333);
        word-wrap: break-word;
        word-break: break-word;
      }

      .rem-item:hover {
        background: color-mix(in srgb, var(--dominds-hover) 80%, var(--dominds-fg) 20%);
      }

      .rem-item-number {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 88%, transparent);
        background: color-mix(in srgb, var(--dominds-bg, #ffffff) 78%, var(--dominds-hover, #f8f9fa) 22%);
        color: color-mix(in srgb, var(--dominds-primary, #007acc) 82%, var(--dominds-fg, #333333) 18%);
        font-family:
          var(--dominds-font-family-mono, 'SFMono-Regular', 'SF Mono', ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        line-height: 1.35;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'zero' 1, 'tnum' 1, 'liga' 0, 'calt' 0;
        text-rendering: geometricPrecision;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .rem-item-head {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex-wrap: wrap;
      }

      .rem-item-scope {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 84%, transparent);
        background: color-mix(in srgb, var(--dominds-bg, #ffffff) 74%, var(--dominds-hover, #f8f9fa) 26%);
        color: color-mix(in srgb, var(--dominds-primary, #007acc) 68%, var(--dominds-fg, #333333) 32%);
        flex: 0 0 auto;
      }

      .rem-item-scope .icon-mask {
        width: 11px;
        height: 11px;
      }

      .rem-item-scope-dialog {
        --icon-mask: ${ICON_MASK_URLS.bookmark};
      }

      .rem-item-scope-personal {
        --icon-mask: ${ICON_MASK_URLS.pin};
      }

      .rem-item-scope-agent-shared {
        --icon-mask: ${ICON_MASK_URLS.link};
      }

      .rem-item-content {
        flex: 1;
        white-space: pre-wrap;
        word-break: break-word;
        min-width: 0;
      }

      .rem-item-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .rem-item-content.rem-item-content-markdown {
        white-space: normal;
        padding-right: 2px;
      }

      .rem-item-content.rem-item-content-expandable {
        overflow-y: hidden;
      }

      .rem-item-expand-footer {
        margin-top: 2px;
        padding-top: 2px;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
        display: flex;
        justify-content: center;
      }

      .rem-item-expand-footer.is-hidden {
        display: none;
      }

      .rem-item-expand-btn {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: color-mix(in srgb, var(--dominds-bg, #ffffff) 86%, var(--dominds-hover, #f8f9fa) 14%);
        color: var(--dominds-fg, #475569);
        border-radius: 999px;
        width: 26px;
        height: 22px;
        padding: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .rem-item-expand-btn:hover {
        background: var(--dominds-hover, #f1f5f9);
      }

      .rem-item-expand-btn:focus-visible {
        outline: 2px solid var(--dominds-primary, #007acc);
        outline-offset: 1px;
      }

      .rem-item-expand-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        animation: progressive-expand-flash 2.2s ease-in-out infinite;
        width: 14px;
        height: 14px;
        --icon-mask: ${ICON_MASK_URLS.chevronsDown};
      }

      .rem-item-expand-btn:hover .rem-item-expand-icon,
      .rem-item-expand-btn:focus-visible .rem-item-expand-icon {
        animation-play-state: paused;
      }


      .rem-item-content.rem-item-content-markdown > :first-child {
        margin-top: 0;
      }

      .rem-item-content.rem-item-content-markdown > :last-child {
        margin-bottom: 0;
      }

      .rem-item-content.rem-item-content-markdown p {
        margin: 0 0 0.55em;
      }

      .rem-item-content.rem-item-content-markdown ul,
      .rem-item-content.rem-item-content-markdown ol {
        margin: 0 0 0.65em 1.25em;
        padding: 0;
      }

      .rem-item-content.rem-item-content-markdown li {
        margin: 0.18em 0;
      }

      .rem-item-content.rem-item-content-markdown h1,
      .rem-item-content.rem-item-content-markdown h2,
      .rem-item-content.rem-item-content-markdown h3,
      .rem-item-content.rem-item-content-markdown h4,
      .rem-item-content.rem-item-content-markdown h5,
      .rem-item-content.rem-item-content-markdown h6 {
        margin: 0.75em 0 0.4em;
        line-height: 1.3;
      }

      .rem-item-content.rem-item-content-markdown blockquote {
        margin: 0.6em 0;
        padding-left: 0.75em;
        border-left: 3px solid color-mix(in srgb, var(--dominds-primary, #007acc) 45%, transparent);
        color: color-mix(in srgb, var(--dominds-fg, #333333) 78%, var(--dominds-muted, #666666) 22%);
      }

      .rem-item-content.rem-item-content-markdown code:not([class]) {
        background: color-mix(in srgb, var(--dominds-hover, #f8f9fa) 86%, var(--dominds-bg, #ffffff) 14%);
        border-radius: 4px;
        padding: 0.08em 0.32em;
        font-size: 0.95em;
      }

      .rem-item-content.rem-item-content-markdown table {
        width: 100%;
        border-collapse: collapse;
        margin: 0.6em 0;
      }

      .rem-item-content.rem-item-content-markdown th,
      .rem-item-content.rem-item-content-markdown td {
        border: 1px solid var(--dominds-border, #e0e0e0);
        padding: 0.32em 0.45em;
        text-align: left;
        vertical-align: top;
      }

      .rem-item-content-loading {
        color: var(--dominds-muted, #666666);
        font-style: italic;
      }

      .rem-section {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .rem-section + .rem-section {
        margin-top: 10px;
      }

      .rem-divider {
        border: 0;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
        margin: 8px 0;
      }

      .rem-divider-section {
        margin: 10px 0;
      }

      .rem-item-virtual {
        border-style: dashed;
        background: color-mix(in srgb, var(--dominds-hover) 65%, var(--dominds-bg) 35%);
      }

      @keyframes progressive-expand-flash {
        0%, 100% { opacity: 0.46; transform: translateY(0); }
        50% { opacity: 1; transform: translateY(1px); }
      }

    `;
  }

  public getHTML(): string {
    const t = getUiStrings(this.uiLanguage);
    const contextUsageTitle =
      this.toolbarContextHealth && this.toolbarContextHealth.kind === 'available'
        ? formatContextUsageTitle(this.uiLanguage, {
            kind: 'known',
            promptTokens: this.toolbarContextHealth.promptTokens,
            hardPercentText: this.formatPercent(this.toolbarContextHealth.hardUtil),
            modelContextLimitTokens: this.toolbarContextHealth.modelContextLimitTokens,
            modelContextWindowText: this.toolbarContextHealth.modelContextWindowText,
            level: this.toolbarContextHealth.level,
            optimalTokens: this.toolbarContextHealth.effectiveOptimalMaxTokens,
            optimalPercentText: this.formatPercent(
              this.toolbarContextHealth.effectiveOptimalMaxTokens /
                this.toolbarContextHealth.modelContextLimitTokens,
            ),
            optimalConfigured: this.toolbarContextHealth.optimalMaxTokensConfigured !== undefined,
            criticalTokens: this.toolbarContextHealth.effectiveCriticalMaxTokens,
            criticalPercentText: this.formatPercent(
              this.toolbarContextHealth.effectiveCriticalMaxTokens /
                this.toolbarContextHealth.modelContextLimitTokens,
            ),
            criticalConfigured: this.toolbarContextHealth.criticalMaxTokensConfigured !== undefined,
          })
        : formatContextUsageTitle(this.uiLanguage, { kind: 'unknown' });
    const contextUsageTooltipText = escapeHtml(contextUsageTitle);
    const uiLanguageMatch = getUiLanguageMatchState({
      uiLanguage: this.uiLanguage,
      serverWorkLanguage: this.serverWorkLanguage,
    });
    const uiLanguageButtonLabel = formatLanguageName(this.uiLanguage, this.uiLanguage);
    const uiLanguageButtonTooltip = formatUiLanguageOptionLabel({
      optionLanguage: this.uiLanguage,
      serverWorkLanguage: this.serverWorkLanguage,
    });
    const uiLanguageMenuItems = supportedLanguageCodes
      .map((optionLanguage) => {
        const optionMatch = getUiLanguageMatchState({
          uiLanguage: optionLanguage,
          serverWorkLanguage: this.serverWorkLanguage,
        });
        const label = formatUiLanguageOptionLabel({
          optionLanguage,
          serverWorkLanguage: this.serverWorkLanguage,
        });
        const tipMarkdown = formatUiLanguageTooltip({
          inLanguage: optionLanguage,
          describedUiLanguage: optionLanguage,
          serverWorkLanguage: this.serverWorkLanguage,
        });
        const tipHtml = renderDomindsMarkdown(tipMarkdown, { kind: 'tooltip' });
        const selected = optionLanguage === this.uiLanguage;
        return `
          <button type="button" class="ui-language-menu-item" data-language="${optionLanguage}" data-lang-match="${optionMatch.kind}" data-selected="${
            selected ? 'true' : 'false'
          }" ${selected ? 'aria-current="true"' : ''}>
            <div class="ui-language-menu-item-label">${label}</div>
            <div class="ui-language-menu-item-tip">${tipHtml}</div>
          </button>
        `;
      })
      .join('');
    return `
      <div class="app-container">
	        <header class="header">
	          <div class="logo">
	            <a class="logo-link" href="https://github.com/longrun-ai/dominds" target="_blank" rel="noopener noreferrer" title="${t.logoGitHubTitle}" aria-label="${t.logoGitHubTitle}">
	              <img src="${faviconUrl}" width="20" height="20" alt="Dominds Logo" />
	              <span class="logo-text">
	                <span>Dominds</span>
	              </span>
	            </a>
              <button type="button" id="dominds-version" class="dominds-version ${this.backendVersion ? '' : 'hidden'}" title="${escapeHtml(
                this.getDomindsVersionTitle(),
              )}" aria-label="${escapeHtml(this.getDomindsVersionTitle())}" data-actionable="false" data-attention="false" data-state="idle" ${
                this.getDomindsVersionActionState().kind === 'install' ||
                this.getDomindsVersionActionState().kind === 'restart'
                  ? ''
                  : 'disabled'
              }>
                ${this.renderDomindsVersionBadge()}
              </button>
	          </div>
		          <div class="rtws-indicator" title="${t.backendWorkspaceTitle}">
		            <span class="icon-mask app-icon-folder" aria-hidden="true"></span>
		            ${this.backendRtws || t.backendWorkspaceLoading}
		          </div>
	          <div class="header-actions">
              <div class="header-run-controls">
                <div class="header-run-pill danger" id="header-emergency-stop-pill" data-disabled="${this.proceedingDialogsCount > 0 ? 'false' : 'true'}" title="${t.emergencyStop}">
	                  <button type="button" class="header-run-pill-icon" id="header-emergency-stop" aria-label="${t.emergencyStop} (${String(this.proceedingDialogsCount)})" aria-disabled="${this.proceedingDialogsCount > 0 ? 'false' : 'true'}">
	                    <span class="icon-mask app-icon-stop" aria-hidden="true"></span>
	                  </button>
                  <span class="header-run-pill-count" id="header-emergency-stop-count" data-testid="toolbar.proceeding_count" aria-hidden="true">${String(this.proceedingDialogsCount)}</span>
                </div>
                <div class="header-run-pill success" id="header-resume-all-pill" data-disabled="${this.resumableDialogsCount > 0 ? 'false' : 'true'}" title="${t.resumeAll}">
	                  <button type="button" class="header-run-pill-icon" id="header-resume-all" aria-label="${t.resumeAll} (${String(this.resumableDialogsCount)})" aria-disabled="${this.resumableDialogsCount > 0 ? 'false' : 'true'}">
	                    <span class="icon-mask app-icon-play" aria-hidden="true"></span>
	                  </button>
                  <span class="header-run-pill-count" id="header-resume-all-count" data-testid="toolbar.resumable_count" aria-hidden="true">${String(this.resumableDialogsCount)}</span>
                </div>
              </div>
		            <button class="header-pill-button problems" id="header-problems-toggle" title="${t.problemsButtonTitle}" aria-label="${t.problemsButtonTitle}" data-severity="${this.getProblemsTopSeverity()}" data-has-problems="${this.problems.length > 0 ? 'true' : 'false'}">
		              <span class="icon-mask app-icon-warning" aria-hidden="true"></span>
		              <span class="problems-count">${String(this.problems.length)}</span>
		            </button>
		            <button class="header-pill-button" id="toast-history-btn" title="${t.toastHistoryButtonTitle}" aria-label="${t.toastHistoryButtonTitle}">
		              <span class="icon-mask app-icon-history" aria-hidden="true"></span>
		            </button>
		            <dominds-connection-status ui-language="${this.uiLanguage}" status="${this.connectionState.status}" ${this.connectionState.error ? `error="${this.connectionState.error}"` : ''}></dominds-connection-status>
	            <div class="ui-language-menu">
	              <button id="ui-language-menu-button" class="lang-select" type="button" aria-haspopup="menu" aria-expanded="false" data-lang-match="${uiLanguageMatch.kind}" data-ui-language="${this.uiLanguage}" title="${t.uiLanguageSelectTitle}\n${uiLanguageButtonTooltip}">
	                <span id="ui-language-menu-button-label">${uiLanguageButtonLabel}</span>
		                <span class="ui-language-menu-button-caret icon-mask app-icon-caret-down" aria-hidden="true"></span>
	              </button>
	              <div id="ui-language-menu" class="ui-language-menu-popover" role="menu" hidden>
	                ${uiLanguageMenuItems}
	              </div>
	            </div>
		            <button id="theme-toggle-btn" class="theme-toggle" title="${t.themeToggleTitle}" aria-label="${t.themeToggleTitle}">
		              ${this.renderThemeToggleIcon()}
		            </button>
	          </div>
	        </header>

	        <div id="problems-panel" class="problems-panel ${this.problemsPanelOpen ? '' : 'hidden'}" role="dialog" aria-label="${t.problemsTitle}">
	          <div class="problems-panel-header">
	            <div class="problems-panel-title">${t.problemsTitle}</div>
	            <div class="problems-panel-actions">
	              <button type="button" id="problems-clear-resolved" title="${t.problemsClearResolvedTitle}" aria-label="${t.problemsClearResolvedTitle}"><span class="icon-mask app-icon-trash" aria-hidden="true"></span></button>
	              <button type="button" id="problems-refresh" title="Refresh" aria-label="Refresh"><span class="icon-mask app-icon-refresh" aria-hidden="true"></span></button>
	              <button type="button" id="problems-close" title="${t.close}" aria-label="${t.close}"><span class="icon-mask app-icon-close" aria-hidden="true"></span></button>
	            </div>
	          </div>
	          <div id="problems-list" class="problems-list">
	            ${this.renderProblemsListHtml()}
	          </div>
	        </div>

	        <div id="toast-history-modal" class="toast-history-modal ${this.toastHistoryOpen ? '' : 'hidden'}" role="dialog" aria-label="${t.toastHistoryTitle}">
	          <div class="toast-history-panel">
	            <div class="toast-history-header">
	              <div id="toast-history-title" class="toast-history-title">${t.toastHistoryTitle}</div>
	              <div class="toast-history-actions">
	                <button type="button" id="toast-history-clear" title="${t.toastHistoryClearTitle}" aria-label="${t.toastHistoryClearTitle}"><span class="icon-mask app-icon-trash" aria-hidden="true"></span></button>
	                <button type="button" id="toast-history-close" title="${t.close}" aria-label="${t.close}"><span class="icon-mask app-icon-close" aria-hidden="true"></span></button>
	              </div>
	            </div>
	            <div id="toast-history-list" class="toast-history-list">
	              ${this.renderToastHistoryListHtml()}
	            </div>
	          </div>
	        </div>

	        <div class="main-content">
	          <aside class="sidebar">
	            <div class="activity-bar" role="toolbar" aria-label="${t.activityBarAriaLabel}">
              <button class="activity-button icon-button" data-activity="running" aria-label="${t.activityRunning}" aria-pressed="true" title="${t.activityRunning}">
                <span class="icon-mask app-icon-running" aria-hidden="true"></span>
              </button>
              <button class="activity-button icon-button" data-activity="done" aria-label="${t.activityDone}" aria-pressed="false" title="${t.activityDone}">
                <span class="icon-mask app-icon-done" aria-hidden="true"></span>
              </button>
              <button class="activity-button icon-button" data-activity="archived" aria-label="${t.activityArchived}" aria-pressed="false" title="${t.activityArchived}">
                <span class="icon-mask app-icon-archive" aria-hidden="true"></span>
              </button>
              <div class="activity-spacer" aria-hidden="true"></div>
              <button class="activity-button icon-button" data-activity="search" aria-label="${t.activitySearch}" aria-pressed="false" title="${t.activitySearch}">
                <span class="icon-mask app-icon-search" aria-hidden="true"></span>
              </button>
              <button class="activity-button icon-button" data-activity="team-members" aria-label="${t.activityTeamMembers}" aria-pressed="false" title="${t.activityTeamMembers}">
                <span class="icon-mask app-icon-users" aria-hidden="true"></span>
              </button>
            </div>
            <div class="sidebar-content">
              <div class="activity-view" data-activity-view="running">
                <running-dialog-list id="running-dialog-list"></running-dialog-list>
              </div>
              <div class="activity-view hidden" data-activity-view="done">
                <done-dialog-list id="done-dialog-list"></done-dialog-list>
              </div>
              <div class="activity-view hidden" data-activity-view="archived">
                <archived-dialog-list id="archived-dialog-list"></archived-dialog-list>
              </div>
              <div class="activity-view hidden" data-activity-view="search">
                <div class="activity-placeholder">
                  <div class="activity-placeholder-title">${t.placeholderSearchTitle}</div>
                  <div class="activity-placeholder-text">${t.placeholderSearchText}</div>
                </div>
              </div>
              <div class="activity-view hidden" data-activity-view="team-members">
                <dominds-team-members id="team-members"></dominds-team-members>
              </div>
            </div>
          </aside>

          <main class="content-area">
            <div class="navibar">
              <div class="navibar-left">
                <button class="icon-button" id="new-dialog-btn" title="${t.newDialogTitle}" aria-label="${t.newDialogTitle}">
                  <span class="icon-mask app-icon-plus" aria-hidden="true"></span>
                </button>
                <div id="current-dialog-title">${t.currentDialogPlaceholder}</div>
              </div>
              <div class="navibar-spacer"></div>
              <div id="tools-callout" class="navibar-gap-left">
                <button class="icon-button" id="navibar-tools-toggle" aria-label="${t.toolsTitle}" aria-pressed="${this.toolsWidgetVisible ? 'true' : 'false'}" ${this.currentDialog ? '' : 'disabled'}>
                  <span class="icon-mask app-icon-tools" aria-hidden="true"></span>
                </button>
              </div>
              <button class="icon-button" id="navibar-save-priming" title="${t.primingSaveButtonTitle}" aria-label="${t.primingSaveButtonTitle}" ${this.currentDialog ? '' : 'disabled'}>
                <span class="icon-mask app-icon-save" aria-hidden="true"></span>
              </button>
	              <div id="course-navi">
	                <button class="icon-button" id="course-navi-prev" ${this.toolbarCurrentCourse > 1 ? '' : 'disabled'} aria-label="${t.previousCourse}">
	                  <span class="icon-mask app-icon-prev" aria-hidden="true"></span>
	                </button>
                  <span id="course-navi-label" class="course-navi-label">C ${this.toolbarCurrentCourse}</span>
                  <button class="icon-button" id="course-navi-next" ${this.toolbarCurrentCourse < this.toolbarTotalCourses ? '' : 'disabled'} aria-label="${t.nextCourse}">
                    <span class="icon-mask app-icon-next" aria-hidden="true"></span>
                  </button>
		            </div>
                <div id="navibar-context-health-wrap" class="navibar-gap-left">
	              <div class="badge-button" id="navibar-context-health" data-level="unknown" aria-label="${contextUsageTitle}">${this.renderContextUsageIcon(this.toolbarContextHealth)}</div>
                  <div class="navibar-tooltip" id="navibar-context-health-tooltip">${contextUsageTooltipText}</div>
                </div>
		          <div id="reminders-callout" class="navibar-gap-left">
              <button class="badge-button" id="navibar-reminders-toggle" aria-label="${t.reminders}" aria-pressed="${this.remindersWidgetVisible ? 'true' : 'false'}">
		              <span class="icon-mask app-icon-bookmark" aria-hidden="true"></span>
		              <span class="reminders-count">${String(this.toolbarReminders.length)}</span>
		            </button>
	            <button class="icon-button reminders-refresh-button" id="navibar-reminders-refresh" title="${t.refreshReminders}" aria-label="${t.refreshReminders}">
              <span class="icon-mask app-icon-refresh" aria-hidden="true"></span>
            </button>
          </div>
            </div>
            ${
              this.remindersWidgetVisible
                ? `
            <div id="reminders-widget" style="--reminders-widget-left: ${this.remindersWidgetX}px; --reminders-widget-top: ${this.remindersWidgetY}px; --reminders-widget-width: ${this.remindersWidgetWidthPx}px; --reminders-widget-height: ${this.remindersWidgetHeightPx}px;">
              <div id="reminders-widget-header" class="reminders-widget-header">
                <div class="reminders-widget-header-main">
                  <span class="icon-mask app-icon-bookmark app-icon-16" aria-hidden="true"></span>
                  <span id="reminders-widget-title">${formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length)}</span>
                </div>
                <button id="reminders-widget-close" class="icon-button" aria-label="${t.close}">
                  <span class="icon-mask app-icon-close" aria-hidden="true"></span>
                </button>
              </div>
              <div id="reminders-widget-content" lang="${this.uiLanguage}" data-progressive-expand-step-parent="true">
                ${
                  this.toolbarReminders.length === 0
                    ? `<div class="reminders-widget-empty">${t.noReminders}</div>`
                    : ''
                }
              </div>
	              <div id="reminders-widget-resize-handle" aria-hidden="true">
		                <span class="icon-mask app-icon-resize-corner-bottom-left" aria-hidden="true"></span>
		              </div>
            </div>
            `
                : ''
            }

	            <div class="dialog-section">
                <div class="conversation-viewport">
	                <div class="conversation-scroll-area" lang="${this.uiLanguage}" data-progressive-expand-step-parent="true">
	                  <dominds-dialog-container id="dialog-container" ui-language="${this.uiLanguage}"></dominds-dialog-container>
	                </div>
                </div>
                <div id="dialog-viewport-panels" class="dialog-viewport-panels hidden">
                  <div id="dialog-status-panel" class="dialog-viewport-panel hidden" data-state="hidden">
                    <div class="dialog-viewport-panel-header">
                      <span class="icon-mask app-icon-refresh" aria-hidden="true"></span>
                      <div class="dialog-viewport-panel-text">
                        <div id="dialog-status-title" class="dialog-viewport-panel-title"></div>
                        <div id="dialog-status-summary" class="dialog-viewport-panel-summary"></div>
                      </div>
                    </div>
                    <div id="dialog-status-error" class="dialog-viewport-panel-error"></div>
                    <div class="dialog-viewport-panel-actions">
                      <button id="dialog-status-btn" class="dialog-resume-btn hidden" type="button">${t.continueLabel}</button>
                    </div>
                  </div>
                </div>
		              <div class="bottom-panel ${this.bottomPanelExpanded ? 'expanded' : 'collapsed'}" id="bottom-panel">
		                <div class="bottom-panel-resize-handle ${this.bottomPanelExpanded ? '' : 'hidden'}" id="bottom-panel-resize-handle" role="separator" aria-orientation="horizontal">
		                  <div class="bp-resize-grip left" data-role="resize" aria-hidden="true"></div>
		                  <button
		                    id="bottom-panel-collapse-btn"
		                    class="bp-collapse-btn"
		                    type="button"
		                    aria-label="${t.close}"
		                    title="${t.close}"
		                  >
		                    <span class="icon-mask app-icon-collapse-strip" aria-hidden="true"></span>
		                  </button>
		                  <div class="bp-resize-grip right" data-role="resize" aria-hidden="true"></div>
		                </div>
		                <div class="bottom-panel-content" id="bottom-panel-content">
	                  <div class="bp-content bp-q4h ${this.bottomPanelTab === 'q4h' ? '' : 'hidden'}">
	                    <div class="bp-q4h-empty ${this.q4hQuestionCount === 0 ? '' : 'hidden'}">${t.q4hNoPending}</div>
	                    <dominds-q4h-panel id="q4h-panel" ui-language="${this.uiLanguage}" class="${this.q4hQuestionCount === 0 ? 'hidden' : ''}"></dominds-q4h-panel>
	                  </div>
	                  <div class="bp-content bp-diligence ${this.bottomPanelTab === 'diligence' ? '' : 'hidden'}">
	                    <div class="bp-diligence-row">
	                      <div class="bp-diligence-help">${t.keepGoingWorkspaceNote}</div>
	                      <button class="icon-button" id="diligence-reload" type="button" title="${t.keepGoingReloadTitle}" aria-label="${t.keepGoingReloadTitle}">
	                        <span class="icon-mask app-icon-upload" aria-hidden="true"></span>
	                      </button>
	                      <button class="icon-button" id="diligence-save" type="button" ${this.diligenceRtwsDirty ? '' : 'disabled'} title="${t.keepGoingSaveTitle}" aria-label="${t.keepGoingSaveTitle}">
	                        <span class="icon-mask app-icon-save" aria-hidden="true"></span>
	                      </button>
	                      <button class="icon-button" id="diligence-reset" type="button" title="${t.keepGoingResetTitle}" aria-label="${t.keepGoingResetTitle}">
	                        <span class="icon-mask app-icon-refresh" aria-hidden="true"></span>
	                      </button>
	                    </div>
	                    <textarea id="diligence-textarea" class="bp-textarea" spellcheck="false"></textarea>
	                  </div>
	                  <div class="bp-content bp-docs ${this.bottomPanelTab === 'docs' ? '' : 'hidden'}">
	                    <dominds-docs-panel id="docs-panel" ui-language="${this.uiLanguage}"></dominds-docs-panel>
	                  </div>
	                  <div class="bp-content bp-team-manual ${this.bottomPanelTab === 'team-manual' ? '' : 'hidden'}">
	                    <dominds-team-manual-panel id="team-manual-panel"></dominds-team-manual-panel>
	                  </div>
	                  <div class="bp-content bp-snippets ${this.bottomPanelTab === 'snippets' ? '' : 'hidden'}">
	                    <dominds-snippets-panel id="snippets-panel"></dominds-snippets-panel>
	                  </div>
	                </div>
	                <div class="bottom-panel-footer" id="bottom-panel-footer">
	                  <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'q4h' ? 'active' : ''}" type="button" data-bp-tab="q4h">
	                    <span class="bp-badge" data-has-questions="${this.q4hQuestionCount > 0 ? 'true' : 'false'}">${String(this.q4hQuestionCount)}</span>
	                    <span class="bp-label" data-bp-label="q4h">${t.q4hPendingQuestions}</span>
	                  </button>
	                  <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'diligence' ? 'active' : ''}" type="button" data-bp-tab="diligence">
	                    <input
	                      id="diligence-toggle"
	                      class="bp-checkbox"
	                      type="checkbox"
	                      aria-label="${t.keepGoingToggleAriaLabel}"
	                      ${this.isDiligenceApplicableToCurrentDialog() && this.isDiligenceCheckboxChecked() ? 'checked' : ''}
	                      ${this.isDiligenceApplicableToCurrentDialog() ? '' : 'disabled'}
	                    />
	                    <span class="bp-label" data-bp-label="diligence">${t.keepGoingTabTitle}</span>
		                    <span class="bp-badge" data-has-remaining="${this.getDiligenceBudgetBadgeText().hasRemaining ? 'true' : 'false'}">${this.getDiligenceBudgetBadgeText().text}</span>
		                  </button>
	                  <div class="bp-tabs-right">
	                    <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'snippets' ? 'active' : ''}" type="button" data-bp-tab="snippets">${t.snippetsTabTitle}</button>
	                    <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'team-manual' ? 'active' : ''}" type="button" data-bp-tab="team-manual">${t.teamMgmtManualTabTitle}</button>
	                    <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'docs' ? 'active' : ''}" type="button" data-bp-tab="docs">${t.domindsDocsTabTitle}</button>
	                  </div>
	                </div>
	              </div>
	              <div class="q4h-input-wrap">
	                <div id="q4h-readonly-banner" class="q4h-readonly-banner hidden">${t.readOnlyDialogInputDisabled}</div>
	                <dominds-q4h-input
	                  id="q4h-input"
	                ></dominds-q4h-input>
	              </div>
            </div>
          </main>
        </div>
      </div>
    `;
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) {
      console.warn('setupEventListeners: shadowRoot is null');
      return;
    }

    const captureKeyboardCountSnapshot = (button: HTMLButtonElement, count: number): void => {
      button.dataset.kbdActivatedAtMs = String(Date.now());
      button.dataset.kbdCountSnapshot = String(count);
    };

    const readKeyboardCountSnapshot = (button: HTMLButtonElement): number | null => {
      const atRaw = button.dataset.kbdActivatedAtMs;
      const countRaw = button.dataset.kbdCountSnapshot;
      delete button.dataset.kbdActivatedAtMs;
      delete button.dataset.kbdCountSnapshot;
      if (typeof atRaw !== 'string' || typeof countRaw !== 'string') return null;
      const atMs = Number(atRaw);
      const count = Number(countRaw);
      if (!Number.isFinite(atMs) || !Number.isFinite(count)) return null;
      // Only trust snapshots from the immediate keyboard activation to avoid stale reuse.
      if (Date.now() - atMs > 1500) return null;
      return count;
    };

    // Set up WebSocket event handlers using (Pub/Sub)Chan pattern
    this.setupWebSocketEventHandlers();

    // Toast relay from child components (e.g., dialog-container)
    this.shadowRoot.addEventListener('ui-toast', (event) => {
      const detail = event.detail;
      const t = getUiStrings(this.uiLanguage);
      const msg = detail.message || t.toastDefaultNotice;
      const kind = detail.kind || 'error';
      this.showToast(msg, kind, { history: detail.history ?? 'default' });
    });

    // Auth escalation from child panels (HTTP 401)
    this.shadowRoot.addEventListener('auth-required', () => {
      this.onAuthRejected('api');
    });

    // Template insertion from snippets panel
    this.shadowRoot.addEventListener('snippet-insert', (event) => {
      const content = event.detail.content;
      if (!content) return;
      const input = this.q4hInput;
      if (!input) return;

      if (typeof input.insertPromptTemplate === 'function') {
        input.insertPromptTemplate(content);
      } else {
        const current = input.getValue();
        const next = current.trim().length === 0 ? content : `${current}\n\n${content}`;
        input.setValue(next);
      }
      input.focusInput();
    });

    // Input area error events (e.g., no dialog selected)
    this.shadowRoot.addEventListener('input-error', (event) => {
      const detail = event.detail;
      const t = getUiStrings(this.uiLanguage);
      const msg = detail.message || t.toastDefaultNotice;
      const kind = detail.type || 'error';
      this.showToast(msg, kind);
    });

    // Reminder events from dialog-container
    this.shadowRoot.addEventListener('reminders-update', () => {
      this.updateRemindersWidget();
    });

    // Dialog list expand (lazy subdialog loading) across all list views
    // Policy: unresolved nodes always fetch from backend; no preloaded global cache.
    // The list event must carry an already-known persisted status. Expands are list-scoped
    // business actions, not id-only lookups that are allowed to guess a directory.
    this.shadowRoot.addEventListener('dialog-expand', (event) => {
      const { rootId, status } = event.detail;
      if (rootId && status) {
        this.requestRootHierarchyFromList(rootId, status);
      }
    });
    // Collapse explicitly drops subdialog nodes from frontend memory.
    this.shadowRoot.addEventListener('dialog-collapse', (event) => {
      const { rootId, status } = event.detail;
      if (rootId.trim() === '') return;
      this.pruneSubdialogsForRoot(rootId, status);
    });

    // Team members events from dominds-team-members (sidebar activity)
    this.shadowRoot.addEventListener('team-members-refresh', () => {
      void this.loadTeamMembers();
    });

    this.shadowRoot.addEventListener('team-member-mention', (event) => {
      const mention = event.detail.mention;
      if (!mention) return;

      const input = this.q4hInput;
      if (!input) {
        const t = getUiStrings(this.uiLanguage);
        this.showToast(t.inputNotAvailableToast, 'warning');
        return;
      }

      const current = input.getValue();
      const needsSpace = current.length > 0 && !/\s$/.test(current);
      const mentionWithSpace = mention.endsWith(' ') ? mention : `${mention} `;
      input.setValue(`${current}${needsSpace ? ' ' : ''}${mentionWithSpace}`);
      input.focusInput();
    });

    // Dialog status actions (mark done/archive/revive) across all list views
    this.shadowRoot.addEventListener('dialog-status-action', (event) => {
      void this.handleDialogStatusAction(event.detail);
    });

    // Dialog creation shortcuts (create new dialog from task/root nodes)
    this.shadowRoot.addEventListener('dialog-create-action', (event) => {
      void this.handleDialogCreateAction(event.detail);
    });

    // Dialog deletion actions (delete root dialogs) across done/archived list views
    this.shadowRoot.addEventListener('dialog-delete-action', (event) => {
      void this.handleDialogDeleteAction(event.detail);
    });

    this.shadowRoot.addEventListener('dialog-open-external', (event) => {
      const url = this.buildDialogDeepLinkUrl(event.detail);
      const urlStr = url.toString();
      const w = window.open(urlStr, '_blank', 'noopener,noreferrer');
      if (w) w.opener = null;
    });

    this.shadowRoot.addEventListener('dialog-share-link', (event) => {
      const url = this.buildDialogDeepLinkUrl(event.detail);
      void this.copyLinkToClipboardWithToast(url.toString());
    });

    // ========== Q4H Event Handlers ==========
    // Q4H navigate to call site event - delegated to q4h-input component
    this.shadowRoot.addEventListener('q4h-navigate-call-site', (event) => {
      this.navigateToQ4HCallSite(event.detail);
    });

    // Q4H external deep link (open in new tab/window + copy URL)
    this.shadowRoot.addEventListener('q4h-open-external', (event) => {
      const detail = event.detail;
      const url = this.buildQ4HDeepLinkUrl({
        questionId: detail.questionId,
        rootId: detail.rootId,
        selfId: detail.dialogId,
        course: detail.course,
        messageIndex: detail.messageIndex,
        callId: detail.callId,
      });

      const urlStr = url.toString();
      const w = window.open(urlStr, '_blank', 'noopener,noreferrer');
      if (w) w.opener = null;
    });

    // Q4H share link (copy URL only)
    this.shadowRoot.addEventListener('q4h-share-link', (event) => {
      const detail = event.detail;
      const url = this.buildQ4HDeepLinkUrl({
        questionId: detail.questionId,
        rootId: detail.rootId,
        selfId: detail.dialogId,
        course: detail.course,
        messageIndex: detail.messageIndex,
        callId: detail.callId,
      });

      void this.copyLinkToClipboardWithToast(url.toString());
    });

    // Q4H selection event from the inline panel - keeps q4h-input selection in sync so answers
    // are routed to the intended question/dialog context.
    this.shadowRoot.addEventListener('q4h-select-question', (event) => {
      const { questionId, dialogId, rootId } = event.detail;
      const input = this.q4hInput;
      if (!input) return;
      if (questionId && dialogId && rootId) {
        input.setDialog({ selfId: dialogId, rootId });
      } else if (!questionId && this.currentDialog) {
        input.setDialog({ selfId: this.currentDialog.selfId, rootId: this.currentDialog.rootId });
      }
      // Avoid infinite recursion: `DomindsQ4HInput.selectQuestion()` dispatches
      // `q4h-select-question`, which bubbles to this handler.
      if (!event.composedPath().includes(input)) {
        input.selectQuestion(questionId);
      }
      this.q4hPanel?.setSelectedQuestionIdFromApp(questionId);
      if (questionId) {
        setTimeout(() => {
          const current = this.q4hInput;
          if (current && current === input) current.focusInput();
        }, 100);
      }
    });

    // Call-site navigation requests from dialog bubbles (internal link icon).
    this.shadowRoot.addEventListener('navigate-genseq', (event) => {
      const detail = event.detail;
      this.pendingDeepLink = {
        kind: 'genseq',
        rootId: detail.rootId,
        selfId: detail.selfId,
        course: detail.course,
        genseq: detail.genseq,
      };
      this.continuePendingDeepLink();
    });

    // Call-site navigation requests from dialog bubbles (internal link icon).
    this.shadowRoot.addEventListener('navigate-callsite', (event) => {
      const detail = event.detail;
      this.pendingDeepLink = {
        kind: 'callsite',
        rootId: detail.rootId,
        selfId: detail.selfId,
        course: detail.course,
        callId: detail.callId,
      };
      this.continuePendingDeepLink();
    });

    this.shadowRoot.addEventListener('fork-dialog-request', (event) => {
      void this.handleForkDialogRequest(event.detail);
    });

    // ========== Delegated Keyboard Handlers ==========
    // Note: <button> Space activates on keyup, while our run-control counts can update rapidly.
    // Capturing the count at keydown makes the subsequent click deterministic.
    this.shadowRoot.addEventListener('keydown', (evt: Event) => {
      if (!(evt instanceof KeyboardEvent)) return;
      if (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar') return;
      const target = evt.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button');
      if (!(button instanceof HTMLButtonElement)) return;

      if (button.id === 'header-emergency-stop') {
        captureKeyboardCountSnapshot(button, this.proceedingDialogsCount);
      } else if (button.id === 'header-resume-all') {
        captureKeyboardCountSnapshot(button, this.resumableDialogsCount);
      }
    });

    // ========== Delegated Click Handlers ==========
    this.shadowRoot.addEventListener('click', async (evt: Event) => {
      const target = evt.target;
      if (!(target instanceof Element)) return;

      // New dialog button
      if (target.id === 'new-dialog-btn' || target.closest('#new-dialog-btn')) {
        void this.openCreateDialogFlow({ source: 'toolbar' });
        return;
      }

      const versionBtn = target.closest('#dominds-version') as HTMLButtonElement | null;
      if (versionBtn) {
        await this.handleDomindsVersionAction();
        return;
      }

      const statusBtn = target.closest('#dialog-status-btn') as HTMLButtonElement | null;
      if (statusBtn) {
        this.resumeCurrentDialog();
        return;
      }

      const resumeBtn = target.closest('#dialog-resume-btn') as HTMLButtonElement | null;
      if (resumeBtn) {
        this.resumeCurrentDialog();
        return;
      }

      const savePrimingBtn = target.closest('#navibar-save-priming') as HTMLButtonElement | null;
      if (savePrimingBtn) {
        await this.saveCurrentCourseAsPrimingScript();
        return;
      }

      const activityButton = target.closest('[data-activity]');
      if (activityButton instanceof HTMLElement) {
        const selected = activityButton.getAttribute('data-activity');
        switch (selected) {
          case 'running':
            this.activityView = { kind: 'running' };
            this.updateActivityView();
            return;
          case 'done':
            this.activityView = { kind: 'done' };
            this.updateActivityView();
            return;
          case 'archived':
            this.activityView = { kind: 'archived' };
            this.updateActivityView();
            return;
          case 'search':
            this.activityView = { kind: 'search' };
            this.updateActivityView();
            return;
          case 'team-members':
            this.activityView = { kind: 'team-members' };
            this.updateActivityView();
            return;
        }
      }

      const toolsToggle = target.closest('#navibar-tools-toggle') as HTMLButtonElement | null;
      if (toolsToggle) {
        this.toggleToolsWidget();
        return;
      }

      const toolsRefresh = target.closest('#tools-widget-refresh') as HTMLButtonElement | null;
      if (toolsRefresh) {
        this.refreshToolsWidget();
        return;
      }

      const toolsClose = target.closest('#tools-widget-close') as HTMLButtonElement | null;
      if (toolsClose) {
        this.closeToolsWidget();
        return;
      }

      // Toolbar navigation
      const prevBtn = target.closest('#course-navi-prev') as HTMLButtonElement | null;
      if (prevBtn) {
        if (this.toolbarCurrentCourse > 1) {
          const targetCourse = this.toolbarCurrentCourse - 1;
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.setCurrentCourse === 'function') {
            await dc.setCurrentCourse(targetCourse);
          }
          this.toolbarCurrentCourse = Math.max(1, targetCourse);
          this.updateToolbarCourseDisplay();
          if (this.currentDialog) {
            this.syncAddressBarToDeepLink({
              kind: 'dialog',
              rootId: this.currentDialog.rootId,
              selfId: this.currentDialog.selfId,
              course: this.toolbarCurrentCourse,
            });
          }
        }
        return;
      }

      const nextBtn = target.closest('#course-navi-next') as HTMLButtonElement | null;
      if (nextBtn) {
        if (this.toolbarCurrentCourse < this.toolbarTotalCourses) {
          const targetCourse = this.toolbarCurrentCourse + 1;
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.setCurrentCourse === 'function') {
            await dc.setCurrentCourse(targetCourse);
          }
          this.toolbarCurrentCourse = Math.min(this.toolbarTotalCourses, targetCourse);
          this.updateToolbarCourseDisplay();
          if (this.currentDialog) {
            this.syncAddressBarToDeepLink({
              kind: 'dialog',
              rootId: this.currentDialog.rootId,
              selfId: this.currentDialog.selfId,
              course: this.toolbarCurrentCourse,
            });
          }
        }
        return;
      }

      const problemsToggle = target.closest('#header-problems-toggle') as HTMLButtonElement | null;
      if (problemsToggle) {
        this.problemsPanelOpen = !this.problemsPanelOpen;
        if (this.problemsPanelOpen) {
          this.wsManager.sendRaw({ type: 'get_problems' });
        }
        this.updateProblemsUi();
        return;
      }

      const problemsClose = target.closest('#problems-close') as HTMLButtonElement | null;
      if (problemsClose) {
        this.problemsPanelOpen = false;
        this.updateProblemsUi();
        return;
      }

      const problemsRefresh = target.closest('#problems-refresh') as HTMLButtonElement | null;
      if (problemsRefresh) {
        this.wsManager.sendRaw({ type: 'get_problems' });
        return;
      }

      const problemsClearResolved = target.closest(
        '#problems-clear-resolved',
      ) as HTMLButtonElement | null;
      if (problemsClearResolved) {
        this.wsManager.sendRaw({ type: 'clear_resolved_problems' });
        return;
      }

      // Reminders toggle
      const remToggle = target.closest('#navibar-reminders-toggle') as HTMLButtonElement | null;
      if (remToggle) {
        this.toggleRemindersWidget();
        return;
      }

      // Reminders refresh
      const remRefresh = target.closest('#navibar-reminders-refresh') as HTMLButtonElement | null;
      if (remRefresh) {
        if (this.currentDialog && this.currentDialog.selfId && this.currentDialog.rootId) {
          this.wsManager.sendRaw({
            type: 'display_reminders',
            dialog: this.currentDialog,
          });
        }
        return;
      }

      // Global run controls
      const emergencyStopBtn = target.closest('#header-emergency-stop') as HTMLButtonElement | null;
      if (emergencyStopBtn) {
        const t = getUiStrings(this.uiLanguage);
        const proceedingCountSnapshot = readKeyboardCountSnapshot(emergencyStopBtn);
        const proceedingCount = proceedingCountSnapshot ?? this.proceedingDialogsCount;
        if (proceedingCount <= 0) {
          this.showToast(t.emergencyStopNoProceedingToast, 'warning');
          return;
        }

        const ok = window.confirm(`${t.emergencyStop} (${proceedingCount})?`);
        if (ok) {
          this.wsManager.sendRaw({ type: 'emergency_stop' });
        }
        return;
      }

      const resumeAllBtn = target.closest('#header-resume-all') as HTMLButtonElement | null;
      if (resumeAllBtn) {
        const t = getUiStrings(this.uiLanguage);
        const resumableCountSnapshot = readKeyboardCountSnapshot(resumeAllBtn);
        const resumableCount = resumableCountSnapshot ?? this.resumableDialogsCount;
        if (resumableCount <= 0) {
          this.showToast(t.resumeAllNoResumableToast, 'warning');
          return;
        }

        this.wsManager.sendRaw({ type: 'resume_all' });
        return;
      }
    });

    // Keyboard shortcut: Ctrl+Shift+R to toggle reminders widget
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        this.toggleRemindersWidget();
      }
    });
  }

  private scheduleRunControlRefresh(reason: RunControlRefreshReason): boolean {
    // This addresses a known flake where resumable count can remain stale even after dialogs resume.
    // Refreshing from the authoritative persisted index (GET /api/dialogs) makes multi-tab views converge.
    const now = Date.now();
    const last = this.runControlRefreshLastScheduledAtMsByReason.get(reason) ?? 0;
    if (now - last < 200) return false;
    this.runControlRefreshLastScheduledAtMsByReason.set(reason, now);
    this.lastRunControlRefreshScheduledAtMs = now;

    const delaysMs = (() => {
      switch (reason) {
        case 'resume_dialog':
          return [250, 900, 1800, 3200];
        case 'resume_all':
          // Keep a later refresh because resume work is fan-out async on backend.
          return [250, 900, 1800, 3200, 4800];
        case 'emergency_stop':
          return [250, 900, 1800, 3200];
        case 'run_state_marker_interrupted':
          return [350, 1200, 2600, 4200];
        case 'run_state_marker_resumed':
          return [650, 2400, 4200];
      }
    })();
    for (const delay of delaysMs) {
      const t = setTimeout(() => {
        void this.loadDialogs();
      }, delay);
      this.runControlRefreshTimers.push(t);
    }

    return true;
  }

  /**
   * Helper to update the toolbar course navigation display
   */
  private updateToolbarCourseDisplay(): void {
    if (!this.shadowRoot) return;
    const prev = this.shadowRoot.querySelector('#course-navi-prev') as HTMLButtonElement;
    const next = this.shadowRoot.querySelector('#course-navi-next') as HTMLButtonElement;
    if (prev) prev.disabled = !(this.toolbarCurrentCourse > 1);
    if (next) next.disabled = !(this.toolbarCurrentCourse < this.toolbarTotalCourses);
    const label = this.shadowRoot.querySelector('#course-navi-label') as HTMLElement;
    if (label) label.textContent = `C ${this.toolbarCurrentCourse}`;
  }

  /**
   * Sets up event listeners for specific elements that are recreated on every render.
   * This should be called from render() after updating innerHTML.
   */
  private setupElementEventListeners(): void {
    if (!this.shadowRoot) return;

    // Dialog container listeners
    const dialogContainerEl = this.shadowRoot.querySelector('#dialog-container') as HTMLElement;
    if (dialogContainerEl) {
      dialogContainerEl.addEventListener('dialog-viewport-panel-state', (event) => {
        this.viewportPanelState = event.detail.state;
        this.updateDialogViewportPanels();
      });
    }

    // UI language menu (custom dropdown)
    const uiLangButton = this.shadowRoot.querySelector('#ui-language-menu-button');
    const uiLangMenu = this.shadowRoot.querySelector('#ui-language-menu');

    if (uiLangButton instanceof HTMLButtonElement && uiLangMenu instanceof HTMLElement) {
      this.ensureUiLanguageMenuGlobalListeners();

      uiLangButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.setUiLanguageMenuOpen(!this.uiLanguageMenuOpen);
      });

      uiLangButton.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.setUiLanguageMenuOpen(true);
        }
      });

      uiLangMenu.addEventListener('click', (e: Event) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const item = target.closest('button.ui-language-menu-item');
        if (!(item instanceof HTMLButtonElement)) return;

        const raw = item.dataset.language;
        if (typeof raw !== 'string') return;
        const parsed = normalizeLanguageCode(raw);
        if (!parsed) {
          console.warn(`Ignoring unsupported ui language selection: '${raw}'`);
          return;
        }
        this.uiLanguage = parsed;
        this.persistUiLanguage(parsed);
        this.wsManager.setUiLanguage(parsed);
        this.applyUiLanguageToDom();
        this.setUiLanguageMenuOpen(false);
      });

      uiLangMenu.addEventListener('keydown', (e: KeyboardEvent) => {
        const items = Array.from(
          uiLangMenu.querySelectorAll<HTMLButtonElement>('button.ui-language-menu-item'),
        );
        if (items.length === 0) return;

        const currentIndex = items.findIndex((b) => b === this.ownerDocument.activeElement);
        const activeIndex = currentIndex >= 0 ? currentIndex : 0;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = items[(activeIndex + 1) % items.length];
          next?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = items[(activeIndex - 1 + items.length) % items.length];
          prev?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const btn = items[activeIndex];
          btn?.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.setUiLanguageMenuOpen(false);
        }
      });
    }

    // Theme toggle button
    const themeToggleBtn = this.shadowRoot.querySelector('#theme-toggle-btn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.toggleTheme();
      });
    }

    // Toast history modal
    const toastHistoryBtn = this.shadowRoot.querySelector('#toast-history-btn');
    if (toastHistoryBtn) {
      toastHistoryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.setToastHistoryOpen(!this.toastHistoryOpen);
      });
    }

    const toastHistoryClose = this.shadowRoot.querySelector('#toast-history-close');
    if (toastHistoryClose) {
      toastHistoryClose.addEventListener('click', (e) => {
        e.preventDefault();
        this.setToastHistoryOpen(false);
      });
    }

    const toastHistoryClear = this.shadowRoot.querySelector('#toast-history-clear');
    if (toastHistoryClear) {
      toastHistoryClear.addEventListener('click', (e) => {
        e.preventDefault();
        this.clearToastHistory();
      });
    }

    const toastHistoryModal = this.shadowRoot.querySelector('#toast-history-modal');
    if (toastHistoryModal) {
      toastHistoryModal.addEventListener('click', (e) => {
        if (e.target === toastHistoryModal) this.setToastHistoryOpen(false);
      });
    }

    // Q4H expanded/collapsed is now driven by the bottom panel, not the input component.

    // Bottom panel (tabs + expand)
    const bottomPanel = this.shadowRoot.querySelector('#bottom-panel') as HTMLElement | null;
    if (bottomPanel) {
      bottomPanel.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeightPx}px`);
    }

    const setBottomPanelExpanded = (expanded: boolean): void => {
      if (!bottomPanel) return;
      if (this.bottomPanelExpanded === expanded) return;
      this.bottomPanelExpanded = expanded;
      bottomPanel.classList.toggle('expanded', expanded);
      bottomPanel.classList.toggle('collapsed', !expanded);
      const handle = this.shadowRoot?.querySelector('#bottom-panel-resize-handle');
      if (handle instanceof HTMLElement) handle.classList.toggle('hidden', !expanded);
      if (expanded) {
        this.setQ4HPanelExpanded(true);
        void this.ensureBottomPanelLoaded();
      } else {
        this.setQ4HPanelExpanded(false);
      }

      // Keep footer tab highlight consistent with expanded/collapsed state.
      this.shadowRoot?.querySelectorAll<HTMLElement>('button.bp-tab').forEach((b) => {
        const k = b.getAttribute('data-bp-tab');
        const active =
          expanded &&
          (k === 'q4h' ||
            k === 'diligence' ||
            k === 'docs' ||
            k === 'team-manual' ||
            k === 'snippets') &&
          k === this.bottomPanelTab;
        b.classList.toggle('active', active);
      });
    };

    const bottomPanelResizeHandle = this.shadowRoot.querySelector(
      '#bottom-panel-resize-handle',
    ) as HTMLElement | null;
    if (bottomPanelResizeHandle && bottomPanel) {
      const startBottomPanelResize = (e: PointerEvent): void => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#bottom-panel-collapse-btn')) return;

        const resizeTarget = bottomPanelResizeHandle;
        e.preventDefault();
        e.stopPropagation();
        if (!this.bottomPanelExpanded) {
          setBottomPanelExpanded(true);
        }
        this.bottomPanelIsResizing = true;
        bottomPanelResizeHandle.classList.add('resizing');
        this.bottomPanelResizeStartY = e.clientY;
        this.bottomPanelResizeStartHeight = this.bottomPanelHeightPx;
        this.bottomPanelResizeLastHeight = this.bottomPanelHeightPx;

        let hasPointerCapture = false;
        try {
          resizeTarget.setPointerCapture(e.pointerId);
          hasPointerCapture = true;
        } catch {
          // ignore
        }

        const onMove = (evt: PointerEvent) => {
          if (!this.bottomPanelIsResizing) return;
          const delta = evt.clientY - this.bottomPanelResizeStartY;
          const next = this.bottomPanelResizeStartHeight - delta;

          const min = 120;
          const max = Math.floor(window.innerHeight * 0.6);
          this.bottomPanelHeightPx = Math.max(min, Math.min(max, next));
          if (Math.abs(this.bottomPanelHeightPx - this.bottomPanelResizeLastHeight) >= 2) {
            this.bottomPanelUserResized = true;
            this.bottomPanelResizeLastHeight = this.bottomPanelHeightPx;
          }
          bottomPanel.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeightPx}px`);
        };

        const onUp = () => {
          if (!this.bottomPanelIsResizing) return;
          this.bottomPanelIsResizing = false;
          bottomPanelResizeHandle.classList.remove('resizing');

          resizeTarget.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointermove', onMove);
          try {
            resizeTarget.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }

          resizeTarget.removeEventListener('pointerup', onUp);
          resizeTarget.removeEventListener('pointercancel', onUp);
          resizeTarget.removeEventListener('lostpointercapture', onUp);
          window.removeEventListener('pointerup', onUp);

          if (this.bottomPanelUserResized) {
            this.persistBottomPanelHeightPx(this.bottomPanelHeightPx);
          }
        };

        resizeTarget.addEventListener('pointermove', onMove);
        if (!hasPointerCapture) {
          window.addEventListener('pointermove', onMove);
        }
        resizeTarget.addEventListener('pointerup', onUp);
        resizeTarget.addEventListener('pointercancel', onUp);
        resizeTarget.addEventListener('lostpointercapture', onUp);

        // Fallback: in some browsers, pointerup may not be delivered to the capture element
        // if the pointer is released outside the window.
        window.addEventListener('pointerup', onUp);
      };
      bottomPanelResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
        startBottomPanelResize(e);
      });

      const collapseBtn = bottomPanelResizeHandle.querySelector<HTMLButtonElement>(
        '#bottom-panel-collapse-btn',
      );
      if (collapseBtn) {
        const setCollapseHover = (active: boolean): void => {
          bottomPanelResizeHandle.classList.toggle('bp-collapse-hover', active);
        };
        collapseBtn.addEventListener('pointerenter', () => {
          setCollapseHover(true);
        });
        collapseBtn.addEventListener('pointerleave', () => {
          setCollapseHover(false);
        });
        collapseBtn.addEventListener('focus', () => {
          setCollapseHover(true);
        });
        collapseBtn.addEventListener('blur', () => {
          setCollapseHover(false);
        });
        collapseBtn.addEventListener('pointerdown', (e: PointerEvent) => {
          e.stopPropagation();
        });
        collapseBtn.addEventListener('click', (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setBottomPanelExpanded(false);
        });
      }
    }

    this.shadowRoot.addEventListener('q4h-question-expanded', (event) => {
      if (!bottomPanel) return;
      setBottomPanelExpanded(true);
      if (this.bottomPanelUserResized) return;
      const questionId = event.detail.questionId;
      if (!questionId) return;
      requestAnimationFrame(() => {
        this.autoFitBottomPanelForExpandedQ4HCard(questionId);
      });
    });

    this.shadowRoot.querySelectorAll<HTMLButtonElement>('button.bp-tab').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = btn.dataset.bpTab;
        if (
          tab !== 'q4h' &&
          tab !== 'diligence' &&
          tab !== 'docs' &&
          tab !== 'team-manual' &&
          tab !== 'snippets'
        )
          return;
        if (this.bottomPanelExpanded && this.bottomPanelTab === tab) {
          setBottomPanelExpanded(false);
          return;
        }
        this.bottomPanelTab = tab;

        // Update tab UI
        this.shadowRoot?.querySelectorAll<HTMLElement>('.bp-tab').forEach((b) => {
          const k = b.getAttribute('data-bp-tab');
          b.classList.toggle('active', this.bottomPanelExpanded && k === tab);
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('.bp-content').forEach((c) => {
          c.classList.add('hidden');
        });
        const content = this.shadowRoot?.querySelector(`.bp-${tab}`);
        if (content instanceof HTMLElement) content.classList.remove('hidden');

        // Auto-expand when switching tabs.
        if (!this.bottomPanelExpanded) {
          setBottomPanelExpanded(true);
        }
        void this.ensureBottomPanelLoaded();
      });
    });

    const diligenceCheckbox = this.shadowRoot.querySelector('#diligence-toggle');
    if (diligenceCheckbox instanceof HTMLInputElement) {
      diligenceCheckbox.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.toggleDiligenceDisable();
      });
    }

    const diligenceTab = this.shadowRoot.querySelector('button.bp-tab[data-bp-tab="diligence"]');
    if (diligenceTab instanceof HTMLButtonElement) {
      const badge = diligenceTab.querySelector('.bp-badge');
      if (badge instanceof HTMLElement) {
        badge.addEventListener('click', (e) => {
          // Never toggle the Diligence tab when clicking the budget badge.
          // This keeps double-click behavior (refill) from also expanding/collapsing the tab.
          e.preventDefault();
          e.stopPropagation();
        });

        badge.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!this.currentDialog) return;
          if (!this.isDiligenceApplicableToCurrentDialog()) {
            this.playDiligenceNotApplicableShake();
            return;
          }
          const status = this.requireCurrentDialogActionStatus();
          if (status === null) {
            return;
          }
          this.wsManager.sendRaw({
            type: 'refill_diligence_push_budget',
            dialog: {
              selfId: this.currentDialog.rootId,
              rootId: this.currentDialog.rootId,
              status,
            },
          });
        });
      }
    }

    const diligenceTextarea = this.shadowRoot.querySelector('#diligence-textarea');
    if (diligenceTextarea instanceof HTMLTextAreaElement) {
      diligenceTextarea.value = this.diligenceRtwsText;
      diligenceTextarea.addEventListener('input', () => {
        this.diligenceRtwsText = diligenceTextarea.value;
        this.diligenceRtwsDirty = true;
        const saveBtn = this.shadowRoot?.querySelector('#diligence-save');
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
      });
    }

    const diligenceReload = this.shadowRoot.querySelector('#diligence-reload');
    if (diligenceReload instanceof HTMLButtonElement) {
      diligenceReload.addEventListener('click', (e) => {
        e.preventDefault();
        void this.loadRtwsDiligenceText(true);
      });
    }

    const diligenceSave = this.shadowRoot.querySelector('#diligence-save');
    if (diligenceSave instanceof HTMLButtonElement) {
      diligenceSave.addEventListener('click', (e) => {
        e.preventDefault();
        void this.saveRtwsDiligenceText();
      });
    }

    const diligenceReset = this.shadowRoot.querySelector('#diligence-reset');
    if (diligenceReset instanceof HTMLButtonElement) {
      diligenceReset.addEventListener('click', (e) => {
        e.preventDefault();
        void this.resetRtwsDiligenceText();
      });
    }
  }

  private async ensureBottomPanelLoaded(): Promise<void> {
    if (this.bottomPanelTab === 'q4h') {
      const panel = this.shadowRoot?.querySelector('#q4h-panel');
      if (
        panel instanceof HTMLElement &&
        typeof (panel as DomindsQ4HPanel).setQuestions === 'function'
      ) {
        (panel as DomindsQ4HPanel).setQuestions(this.q4hQuestionCount, this.q4hDialogContexts);
      }
      return;
    }

    if (this.bottomPanelTab === 'diligence') {
      await this.loadRtwsDiligenceText(false);
      return;
    }

    if (this.bottomPanelTab === 'docs') {
      const docs = this.shadowRoot?.querySelector('#docs-panel');
      if (docs instanceof HTMLElement) {
        docs.setAttribute('ui-language', this.uiLanguage);
      }
      return;
    }

    if (this.bottomPanelTab === 'team-manual') {
      const panel = this.shadowRoot?.querySelector('#team-manual-panel');
      if (panel && 'setUiLanguage' in panel) {
        const maybe = panel as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
        if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
      }
      return;
    }

    if (this.bottomPanelTab === 'snippets') {
      const panel = this.shadowRoot?.querySelector('#snippets-panel');
      if (panel && 'setUiLanguage' in panel) {
        const maybe = panel as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
        if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
      }
      return;
    }
  }

  private async toggleDiligenceDisable(): Promise<void> {
    if (!this.currentDialog) {
      const t = getUiStrings(this.uiLanguage);
      this.showToast(t.noActiveDialogToast, 'warning');
      return;
    }
    if (!this.isDiligenceApplicableToCurrentDialog()) {
      return;
    }
    const status = this.requireCurrentDialogActionStatus();
    if (status === null) {
      return;
    }
    const next = !this.disableDiligencePush;
    this.wsManager.sendRaw({
      type: 'set_diligence_push',
      dialog: {
        selfId: this.currentDialog.rootId,
        rootId: this.currentDialog.rootId,
        status,
      },
      disableDiligencePush: next,
    });
    this.disableDiligencePush = next;
    this.updateBottomPanelFooterUi();
  }

  private async loadRtwsDiligenceText(force: boolean): Promise<void> {
    if (!force && this.diligenceRtwsText.trim() !== '' && !this.diligenceRtwsDirty) {
      return;
    }

    const resp = await this.apiClient.getRtwsDiligence(this.uiLanguage);
    if (!resp.success) {
      if (resp.status === 401) {
        this.onAuthRejected('api');
        return;
      }
      return;
    }
    const payload = resp.data;
    if (!payload || !payload.success) return;
    const raw = typeof payload.raw === 'string' ? payload.raw : '';
    const fallback = DILIGENCE_FALLBACK_TEXT[this.uiLanguage];
    this.diligenceRtwsSource = payload.source === 'rtws' ? 'rtws' : 'builtin';
    this.diligenceRtwsText = raw.trim() === '' ? fallback : raw;
    this.diligenceRtwsDirty = false;
    const textarea = this.shadowRoot?.querySelector('#diligence-textarea');
    if (textarea instanceof HTMLTextAreaElement) textarea.value = this.diligenceRtwsText;
    const saveBtn = this.shadowRoot?.querySelector('#diligence-save');
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
  }

  private async resetRtwsDiligenceText(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    const confirmText = this.diligenceRtwsDirty
      ? t.keepGoingResetConfirmDirty
      : t.keepGoingResetConfirm;
    const ok = window.confirm(confirmText);
    if (!ok) return;

    const resp = await this.apiClient.deleteRtwsDiligence(this.uiLanguage);
    if (!resp.success) {
      if (resp.status === 401) {
        this.onAuthRejected('api');
        return;
      }
      this.showToast(resp.error ?? t.keepGoingResetFailedToast, 'error');
      return;
    }
    const payload = resp.data;
    if (!payload || !payload.success) {
      this.showToast(t.keepGoingResetFailedToast, 'error');
      return;
    }

    // After deleting rtws overrides, reload to display builtin fallback.
    this.diligenceRtwsDirty = false;
    await this.loadRtwsDiligenceText(true);
    this.showToast(t.keepGoingResetToast, 'info');
  }

  private setQ4HPanelExpanded(expanded: boolean): void {
    // Legacy behavior: this used to resize the input/conversation split.
    // After consolidating the bottom panel into a footer-tab layout, the input size is controlled
    // exclusively by `dominds-q4h-input` (auto-resize + manual handle).
    // Keep this method as a no-op to avoid refactoring call sites mid-flight.
    void expanded;
  }

  private async saveRtwsDiligenceText(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);

    const first = await this.apiClient.writeRtwsDiligence(this.uiLanguage, {
      raw: this.diligenceRtwsText,
      overwrite: false,
    });
    if (!first.success) {
      if (first.status === 401) {
        this.onAuthRejected('api');
        return;
      }
      if (first.status === 409) {
        const confirmOverwrite = window.confirm(t.keepGoingOverwriteConfirm);
        if (!confirmOverwrite) return;

        const second = await this.apiClient.writeRtwsDiligence(this.uiLanguage, {
          raw: this.diligenceRtwsText,
          overwrite: true,
        });
        if (!second.success) {
          if (second.status === 401) {
            this.onAuthRejected('api');
            return;
          }
          const statusText =
            typeof second.status === 'number' ? `HTTP ${second.status}` : 'HTTP error';
          this.showToast(`${t.keepGoingSaveFailedToast}: ${second.error ?? statusText}`, 'error');
          return;
        }
      } else {
        this.showToast(first.error ?? t.keepGoingSaveFailedToast, 'error');
        return;
      }
    }
    this.diligenceRtwsDirty = false;
    const saveBtn = this.shadowRoot?.querySelector('#diligence-save');
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;
    this.showToast(t.keepGoingSaveToast, 'info');
  }

  private async loadInitialData(): Promise<void> {
    // Connect to WebSocket first, then load other data
    try {
      await this.wsManager.connect();
    } catch (error) {
      console.warn('Initial WebSocket connection failed:', error);
      // Don't fail the entire initialization, try to reconnect in background
    }

    // Keep "New Dialog" in a loading state while team config is still loading.
    if (this.teamMembersLoadState.kind === 'idle') {
      this.teamMembersLoadState = { kind: 'loading' };
      this.updateNewDialogButtonState();
    }

    // Q4H state will be loaded when WebSocket connection is established
    // See handleConnectionStateChange() for Q4H request on connect

    // Welcome/runtime status arrives via WebSocket.
    await Promise.all([this.loadDialogs(), this.loadTeamMembers(), this.loadTaskDocuments()]);

    // If a deep link was provided, attempt to apply it once the essential lists are loaded.
    this.continuePendingDeepLink();
  }

  private parseDeepLinkFromUrl(): DeepLinkIntent | null {
    const parseOptionalInt = DomindsApp.parseOptionalInt;

    const segs = window.location.pathname
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const dlIndex = segs.indexOf('dl');
    if (dlIndex < 0) return null;

    const kind = segs[dlIndex + 1];
    if (!kind) return null;

    if (kind === 'dialog') {
      // /dl/dialog?rootId=...&selfId=...&course=...
      const params = new URLSearchParams(window.location.search);
      const rootId = (params.get('rootId') ?? '').trim();
      const selfRaw = (params.get('selfId') ?? '').trim();
      const course = parseOptionalInt(params.get('course'));
      if (rootId === '') return null;
      const selfId = selfRaw === '' ? rootId : selfRaw;
      return { kind: 'dialog', rootId, selfId, course };
    }

    if (kind === 'callsite') {
      // /dl/callsite?rootId=...&selfId=...&course=...&callId=...
      const params = new URLSearchParams(window.location.search);
      const rootId = (params.get('rootId') ?? '').trim();
      const selfId = (params.get('selfId') ?? '').trim();
      const course = parseOptionalInt(params.get('course'));
      const callId = (params.get('callId') ?? '').trim();
      if (rootId === '' || selfId === '' || callId === '') return null;
      if (typeof course !== 'number') return null;
      return { kind: 'callsite', rootId, selfId, course, callId };
    }

    if (kind === 'genseq') {
      // /dl/genseq?rootId=...&selfId=...&course=...&genseq=...
      const params = new URLSearchParams(window.location.search);
      const rootId = (params.get('rootId') ?? '').trim();
      const selfId = (params.get('selfId') ?? '').trim();
      const course = parseOptionalInt(params.get('course'));
      const genseq = parseOptionalInt(params.get('genseq'));
      if (rootId === '' || selfId === '') return null;
      if (typeof course !== 'number' || typeof genseq !== 'number') return null;
      return { kind: 'genseq', rootId, selfId, course, genseq };
    }

    if (kind === 'q4h') {
      // /dl/q4h?qid=...&rootId=...&selfId=...&course=...&msg=...&callId=...
      const params = new URLSearchParams(window.location.search);
      const questionId = (params.get('qid') ?? '').trim();
      if (questionId === '') return null;

      const rootIdRaw = params.get('rootId');
      const selfIdRaw = params.get('selfId');
      const rootId = rootIdRaw && rootIdRaw.trim() !== '' ? rootIdRaw.trim() : undefined;
      const selfId = selfIdRaw && selfIdRaw.trim() !== '' ? selfIdRaw.trim() : undefined;

      const course = parseOptionalInt(params.get('course'));
      const messageIndex = parseOptionalInt(params.get('msg'));
      const callIdRaw = params.get('callId');
      const callId = callIdRaw && callIdRaw.trim() !== '' ? callIdRaw.trim() : undefined;

      return { kind: 'q4h', questionId, rootId, selfId, course, messageIndex, callId };
    }

    return null;
  }

  private static parseOptionalInt(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return undefined;
    return parsed;
  }

  private resolvePendingQ4HContext(questionId: string): {
    rootId: string;
    selfId: string;
    course: number;
    messageIndex: number;
    callId: string;
  } | null {
    for (const ctx of this.q4hDialogContexts) {
      for (const q of ctx.questions) {
        if (q.id !== questionId) continue;
        return {
          rootId: ctx.rootId,
          selfId: ctx.selfId,
          course: q.callSiteRef.course,
          messageIndex: q.callSiteRef.messageIndex,
          callId: q.callId,
        };
      }
    }
    return null;
  }

  private buildDialogInfoForIds(rootId: string, selfId: string): DialogInfo | null {
    const match = this.findDisplayedDialogByIds(rootId, selfId);
    if (match) {
      return {
        selfId,
        rootId,
        agentId: match.agentId,
        agentName: match.agentId,
        taskDocPath: match.taskDocPath,
        status: match.status,
      };
    }
    if (selfId !== rootId) {
      // For subdialogs, do not fallback to root metadata.
      // Caller should load the root hierarchy first, then resolve the real subdialog node.
      return null;
    }
    const rootMatch = this.getRootDialog(rootId);
    if (!rootMatch) return null;
    return {
      selfId,
      rootId,
      agentId: rootMatch.agentId,
      agentName: rootMatch.agentId,
      taskDocPath: rootMatch.taskDocPath,
      status: rootMatch.status,
    };
  }

  private buildDialogDeepLinkUrl(params: DialogDeepLinkParams): URL {
    const url = new URL(window.location.href);
    url.searchParams.delete('rootId');
    url.searchParams.delete('selfId');
    url.searchParams.delete('course');
    url.searchParams.delete('msg');
    url.searchParams.delete('callId');
    url.searchParams.delete('genseq');
    url.searchParams.delete('qid');
    url.hash = '';
    url.pathname = '/dl/dialog';
    url.searchParams.set('rootId', params.rootId);
    url.searchParams.set('selfId', params.selfId);
    if (typeof params.course === 'number') {
      url.searchParams.set('course', String(Math.floor(params.course)));
    }
    return url;
  }

  private buildCallsiteDeepLinkUrl(params: CallsiteDeepLinkParams): URL {
    const url = this.buildDialogDeepLinkUrl({
      rootId: params.rootId,
      selfId: params.selfId,
    });
    url.pathname = '/dl/callsite';
    url.searchParams.set('course', String(Math.floor(params.course)));
    url.searchParams.set('callId', params.callId);
    return url;
  }

  private buildGenseqDeepLinkUrl(params: GenseqDeepLinkParams): URL {
    const url = this.buildDialogDeepLinkUrl({
      rootId: params.rootId,
      selfId: params.selfId,
    });
    url.pathname = '/dl/genseq';
    url.searchParams.set('course', String(Math.floor(params.course)));
    url.searchParams.set('genseq', String(Math.floor(params.genseq)));
    return url;
  }

  private buildQ4HDeepLinkUrl(params: Q4HDeepLinkParams): URL {
    const url = this.buildDialogDeepLinkUrl({
      rootId: params.rootId,
      selfId: params.selfId,
    });
    url.pathname = '/dl/q4h';
    url.searchParams.set('qid', params.questionId);
    if (typeof params.course === 'number') {
      url.searchParams.set('course', String(Math.floor(params.course)));
    }
    if (typeof params.messageIndex === 'number') {
      url.searchParams.set('msg', String(Math.floor(params.messageIndex)));
    }
    if (typeof params.callId === 'string' && params.callId.trim() !== '') {
      url.searchParams.set('callId', params.callId.trim());
    }
    return url;
  }

  private stripUrlAuthParamAfterSuccessfulOpen(): void {
    if (!(this.authState.kind === 'active' && this.authState.source === 'url')) return;
    removeAuthKeyFromUrl();
    this.urlAuthPresent = false;
  }

  private syncAddressBarToDialogDeepLink(dialog: DialogInfo): void {
    const rootId = dialog.rootId.trim();
    const selfId = dialog.selfId.trim();
    if (!rootId || !selfId) return;

    const target = this.buildDialogDeepLinkUrl({ rootId, selfId });
    const current = new URL(window.location.href);
    if (
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash === target.hash
    ) {
      return;
    }
    window.history.replaceState({}, '', target.toString());
  }

  private clearDeepLinkAddressBarIfPresent(): void {
    const current = new URL(window.location.href);
    const segs = current.pathname
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (!segs.includes('dl')) {
      return;
    }
    current.pathname = '/';
    current.search = '';
    current.hash = '';
    window.history.replaceState({}, '', current.toString());
  }

  private syncAddressBarToDeepLink(intent: DeepLinkIntent): void {
    let target: URL | null = null;
    if (intent.kind === 'dialog') {
      target = this.buildDialogDeepLinkUrl({
        rootId: intent.rootId,
        selfId: intent.selfId,
        course: intent.course,
      });
    } else if (intent.kind === 'callsite') {
      target = this.buildCallsiteDeepLinkUrl({
        rootId: intent.rootId,
        selfId: intent.selfId,
        course: intent.course,
        callId: intent.callId,
      });
    } else if (intent.kind === 'genseq') {
      target = this.buildGenseqDeepLinkUrl({
        rootId: intent.rootId,
        selfId: intent.selfId,
        course: intent.course,
        genseq: intent.genseq,
      });
    } else if (intent.kind === 'q4h') {
      const rootId = intent.rootId?.trim() ?? '';
      const selfId = intent.selfId?.trim() ?? '';
      if (rootId !== '' && selfId !== '') {
        target = this.buildQ4HDeepLinkUrl({
          questionId: intent.questionId,
          rootId,
          selfId,
          course: intent.course,
          messageIndex: intent.messageIndex,
          callId: intent.callId,
        });
      }
    } else {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
    if (!target) return;
    const current = new URL(window.location.href);
    if (
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash === target.hash
    ) {
      return;
    }
    window.history.replaceState({}, '', target.toString());
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok === true;
    } catch {
      return false;
    }
  }

  private async copyLinkToClipboardWithToast(urlStr: string): Promise<void> {
    const ok = await this.copyTextToClipboard(urlStr);
    const t = getUiStrings(this.uiLanguage);
    if (ok) {
      this.showToast(t.linkCopiedToast, 'info');
      return;
    }
    this.showToast(t.linkCopyFailedToast, 'warning');
  }

  private applyPendingQ4HSelectionFromDeepLink(): void {
    const questionId = this.pendingDeepLinkQ4HSelectionQuestionId;
    if (!questionId) return;
    const ctx = this.resolvePendingQ4HContext(questionId);
    if (!ctx) return;

    const input = this.q4hInput;
    if (!input) return;

    this.ensureBottomPanelQ4HOpen();
    this.q4hPanel?.setSelectedQuestionIdFromApp(questionId);

    input.setDialog({ selfId: ctx.selfId, rootId: ctx.rootId });
    input.selectQuestion(questionId);
    setTimeout(() => input.focusInput(), 100);
    this.pendingDeepLinkQ4HSelectionQuestionId = null;
  }

  private applyPendingDeepLinkIfQ4H(): void {
    const pending = this.pendingDeepLink;
    if (!pending || pending.kind !== 'q4h') return;
    this.continuePendingDeepLink();
  }

  private continuePendingDeepLink(): void {
    // Deep-link application is launched from lifecycle/event edges that cannot await here.
    // Keep those call sites business-specific, but terminate failures in one place.
    void this.applyPendingDeepLink().catch((error: unknown) => {
      const t = getUiStrings(this.uiLanguage);
      const message = error instanceof Error ? error.message : t.unknownError;
      console.error('Failed to apply pending deep link:', error);
      this.pendingDeepLink = null;
      this.showToast(`${t.deepLinkDialogLoadFailedPrefix} ${message}`, 'error');
    });
  }

  private async applyPendingDeepLink(): Promise<void> {
    if (this.deepLinkInFlight) return;
    const intent = this.pendingDeepLink;
    if (!intent) return;

    this.deepLinkInFlight = true;
    try {
      const t = getUiStrings(this.uiLanguage);
      type DeepLinkDialogLookupResult =
        | { kind: 'ok'; dialogInfo: DialogInfo }
        | { kind: 'not_found' }
        | { kind: 'auth' }
        | { kind: 'error'; message: string };
      const resolveDialogInfoForDeepLink = async (
        rootId: string,
        selfId: string,
      ): Promise<DeepLinkDialogLookupResult> => {
        const resolvedStatusResp = await this.apiClient.resolveDialogStatus(rootId, selfId);
        if (!resolvedStatusResp.success || !resolvedStatusResp.data) {
          if (resolvedStatusResp.status === 401 || resolvedStatusResp.status === 403) {
            return { kind: 'auth' };
          }
          if (resolvedStatusResp.status === 404) {
            return { kind: 'not_found' };
          }
          return {
            kind: 'error',
            message: resolvedStatusResp.error || t.unknownError,
          };
        }
        const resolvedStatus = resolvedStatusResp.data.status;
        let dialogInfo = this.buildDialogInfoForIds(rootId, selfId);
        if (!dialogInfo) {
          await this.loadRootHierarchyForKnownStatus(rootId, resolvedStatus);
          dialogInfo = this.buildDialogInfoForIds(rootId, selfId);
        }
        if (!dialogInfo) {
          return {
            kind: 'error',
            message: `Dialog ${selfId} was resolved in ${resolvedStatus}, but its hierarchy details could not be loaded`,
          };
        }
        return {
          kind: 'ok',
          dialogInfo: {
            ...dialogInfo,
            status: resolvedStatus,
          },
        };
      };
      const handleDeepLinkDialogLookupFailure = (
        targetDialogId: { rootId: string; selfId: string },
        result: Exclude<DeepLinkDialogLookupResult, { kind: 'ok'; dialogInfo: DialogInfo }>,
      ): void => {
        if (result.kind === 'auth') {
          this.pendingDeepLink = null;
          this.onAuthRejected('api');
          return;
        }
        if (result.kind === 'not_found') {
          this.removeUnavailableDialogLocally(targetDialogId.rootId, targetDialogId.selfId);
          this.showToast(`${t.deepLinkDialogNotFoundPrefix} ${targetDialogId.selfId}`, 'warning');
          this.pendingDeepLink = null;
          return;
        }
        this.showToast(
          `${t.deepLinkDialogLoadFailedPrefix} ${targetDialogId.selfId}: ${result.message}`,
          'error',
        );
        this.pendingDeepLink = null;
      };
      const ensureDialogSelectedWithoutAddressSync = async (
        dialogInfo: DialogInfo,
      ): Promise<void> => {
        const status = this.toPersistableStatus(dialogInfo.status);
        if (status === null) {
          throw new Error('Deep-link dialog is missing a persisted status');
        }
        await this.openDeepLinkedDialog(dialogInfo, status);
      };

      if (intent.kind === 'dialog') {
        const dialogLookup = await resolveDialogInfoForDeepLink(intent.rootId, intent.selfId);
        if (dialogLookup.kind !== 'ok') {
          handleDeepLinkDialogLookupFailure(
            { rootId: intent.rootId, selfId: intent.selfId },
            dialogLookup,
          );
          return;
        }
        const dialogInfo = dialogLookup.dialogInfo;

        await ensureDialogSelectedWithoutAddressSync(dialogInfo);
        if (typeof intent.course === 'number') {
          const dialogContainer = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dialogContainer) {
            await dialogContainer.setCurrentCourse(intent.course);
          }
        }
        this.q4hInput?.focusInput();
        this.syncAddressBarToDeepLink(intent);
        this.pendingDeepLink = null;
        return;
      }

      if (intent.kind === 'callsite') {
        const dialogLookup = await resolveDialogInfoForDeepLink(intent.rootId, intent.selfId);
        if (dialogLookup.kind !== 'ok') {
          handleDeepLinkDialogLookupFailure(
            { rootId: intent.rootId, selfId: intent.selfId },
            dialogLookup,
          );
          return;
        }
        const dialogInfo = dialogLookup.dialogInfo;

        await ensureDialogSelectedWithoutAddressSync(dialogInfo);
        const dialogContainer = this.shadowRoot?.querySelector(
          '#dialog-container',
        ) as DomindsDialogContainer | null;
        if (dialogContainer) {
          await dialogContainer.setCurrentCourse(intent.course);
          dispatchDomindsEvent(
            dialogContainer,
            'scroll-to-call-id',
            { course: intent.course, callId: intent.callId },
            { bubbles: true, composed: true },
          );
        }

        this.syncAddressBarToDeepLink(intent);
        this.q4hInput?.focusInput();
        this.pendingDeepLink = null;
        return;
      }

      if (intent.kind === 'genseq') {
        const dialogLookup = await resolveDialogInfoForDeepLink(intent.rootId, intent.selfId);
        if (dialogLookup.kind !== 'ok') {
          handleDeepLinkDialogLookupFailure(
            { rootId: intent.rootId, selfId: intent.selfId },
            dialogLookup,
          );
          return;
        }
        const dialogInfo = dialogLookup.dialogInfo;

        await ensureDialogSelectedWithoutAddressSync(dialogInfo);
        const dialogContainer = this.shadowRoot?.querySelector(
          '#dialog-container',
        ) as DomindsDialogContainer | null;
        if (dialogContainer) {
          await dialogContainer.setCurrentCourse(intent.course);
          dispatchDomindsEvent(
            dialogContainer,
            'scroll-to-genseq',
            { course: intent.course, genseq: intent.genseq },
            { bubbles: true, composed: true },
          );
        }

        this.syncAddressBarToDeepLink(intent);
        this.q4hInput?.focusInput();
        this.pendingDeepLink = null;
        return;
      }

      // intent.kind === 'q4h'
      const resolvedFromState = this.resolvePendingQ4HContext(intent.questionId);
      const rootId = intent.rootId ?? resolvedFromState?.rootId;
      const selfId = intent.selfId ?? resolvedFromState?.selfId;
      const course = intent.course ?? resolvedFromState?.course;
      const messageIndex = intent.messageIndex ?? resolvedFromState?.messageIndex;
      const callId = intent.callId ?? resolvedFromState?.callId;

      if (!rootId || !selfId || typeof course !== 'number') {
        // Not enough information yet. Wait for dialogs/Q4H state to populate.
        return;
      }

      const dialogLookup = await resolveDialogInfoForDeepLink(rootId, selfId);
      if (dialogLookup.kind !== 'ok') {
        handleDeepLinkDialogLookupFailure({ rootId, selfId }, dialogLookup);
        return;
      }
      const dialogInfo = dialogLookup.dialogInfo;

      await ensureDialogSelectedWithoutAddressSync(dialogInfo);
      const dialogContainer = this.shadowRoot?.querySelector(
        '#dialog-container',
      ) as DomindsDialogContainer | null;
      if (dialogContainer) {
        await dialogContainer.setCurrentCourse(course);
        if (typeof callId === 'string' && callId.trim() !== '') {
          dispatchDomindsEvent(
            dialogContainer,
            'scroll-to-call-id',
            { course, callId },
            { bubbles: true, composed: true },
          );
        } else if (typeof messageIndex === 'number') {
          dispatchDomindsEvent(
            dialogContainer,
            'scroll-to-call-site',
            { course, messageIndex },
            { bubbles: true, composed: true },
          );
        }
      }

      const pending = this.resolvePendingQ4HContext(intent.questionId);
      if (pending) {
        this.ensureBottomPanelQ4HOpen();
        this.q4hPanel?.setSelectedQuestionIdFromApp(intent.questionId);
        const input = this.q4hInput;
        if (input) {
          input.setDialog({ selfId: pending.selfId, rootId: pending.rootId });
          input.selectQuestion(intent.questionId);
          setTimeout(() => input.focusInput(), 100);
        }
      } else if (this.q4hDialogContexts.length === 0) {
        // If Q4H state isn't loaded yet, try selecting once it arrives.
        this.ensureBottomPanelQ4HOpen();
        this.pendingDeepLinkQ4HSelectionQuestionId = intent.questionId;
        this.wsManager.sendRaw({ type: 'get_q4h_state' });
        this.q4hInput?.focusInput();
      } else {
        // Question is not pending; navigate to call site but keep input in normal mode.
        this.q4hInput?.focusInput();
      }

      this.syncAddressBarToDeepLink({
        kind: 'q4h',
        questionId: intent.questionId,
        rootId,
        selfId,
        course,
        messageIndex,
        callId,
      });
      this.pendingDeepLink = null;
    } finally {
      this.deepLinkInFlight = false;
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.bootInFlight) return;
    this.bootInFlight = true;
    try {
      const gate = await this.gateBySetup();
      if (gate.kind !== 'proceed') return;
      await this.loadInitialData();
      this.stripUrlAuthParamAfterSuccessfulOpen();
    } finally {
      this.bootInFlight = false;
    }
  }

  private async gateBySetup(): Promise<
    { kind: 'proceed' } | { kind: 'redirected' } | { kind: 'auth_required' } | { kind: 'failed' }
  > {
    // If we're already on /setup, do not attempt to run the main app.
    const path = window.location.pathname;
    if (path === '/setup' || path === '/setup/') return { kind: 'redirected' };

    const resp = await this.apiClient.getSetupStatus();
    if (!resp.success) {
      if (resp.status === 401) {
        this.onAuthRejected('api');
        return { kind: 'auth_required' };
      }
      // Setup check failed; fall back to the legacy behavior (try to load anyway).
      return { kind: 'proceed' };
    }

    const payload = resp.data;
    if (!payload) return { kind: 'proceed' };
    const requirement = payload.requirement;
    if (requirement.kind !== 'ok') {
      const dest =
        this.authState.kind === 'active' && this.authState.source === 'url'
          ? `/setup?auth=${encodeURIComponent(this.authState.key)}`
          : '/setup';
      window.location.href = dest;
      return { kind: 'redirected' };
    }

    return { kind: 'proceed' };
  }

  private initializeAuth(): void {
    const urlKey = readAuthKeyFromUrl();
    if (urlKey) {
      this.urlAuthPresent = true;
      this.setAuthActive('url', urlKey);
      return;
    }

    this.urlAuthPresent = false;
    const localKey = readAuthKeyFromLocalStorage();
    if (localKey) {
      this.setAuthActive('localStorage', localKey);
      return;
    }

    this.setAuthNone();
  }

  private setAuthActive(source: 'url' | 'localStorage' | 'manual', key: string): void {
    this.authState = { kind: 'active', source, key };
    this.apiClient.setAuthToken(key);
    this.wsManager.setProtocols(makeWebSocketAuthProtocols(key));
  }

  private setAuthNone(): void {
    this.authState = { kind: 'none' };
    this.apiClient.clearAuthToken();
    this.wsManager.setProtocols(undefined);
  }

  private onAuthRejected(origin: 'api' | 'ws'): void {
    if (this.authState.kind === 'prompt') {
      this.showAuthModal();
      return;
    }
    const hadUrlAuth = this.urlAuthPresent;

    if (this.authState.kind === 'active' && this.authState.source === 'url') {
      // URL-auth must not persist; on failure, remove from address bar then go interactive.
      removeAuthKeyFromUrl();
      this.urlAuthPresent = false;
    }

    // Stop using the rejected key.
    this.setAuthNone();
    this.wsManager.disconnect();

    this.authState =
      origin === 'ws'
        ? { kind: 'prompt', reason: 'ws_rejected', hadUrlAuth }
        : { kind: 'prompt', reason: 'rejected', hadUrlAuth };

    this.showAuthModal();
  }

  private showAuthModal(): void {
    if (this.authModal) return;

    const t = getUiStrings(this.uiLanguage);

    const modal = document.createElement('div');
    modal.className = 'dominds-modal dominds-auth-modal';
    modal.dataset.modalKind = 'auth';
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content" role="dialog" aria-labelledby="auth-modal-title" aria-modal="true">
        <div class="modal-header">
          <h3 id="auth-modal-title">${t.authRequiredTitle}</h3>
        </div>
        <div class="modal-body">
          <p class="modal-description">
            ${t.authDescription}
          </p>
          <div class="form-group form-group-vertical">
            <label for="auth-key-input">${t.authKeyLabel}</label>
            <input type="password" id="auth-key-input" class="task-doc-input" placeholder="${t.authKeyPlaceholder}" autocomplete="off">
          </div>
          <div class="form-group" id="auth-modal-error"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="auth-submit-btn">${t.connect}</button>
        </div>
      </div>
    `;

    const submitBtn = modal.querySelector('#auth-submit-btn') as HTMLButtonElement | null;
    const input = modal.querySelector('#auth-key-input') as HTMLInputElement | null;
    const errorEl = modal.querySelector('#auth-modal-error') as HTMLElement | null;

    const setError = (msg: string) => {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    };

    const doSubmit = async () => {
      const key = input?.value ?? '';
      if (!key) {
        setError(t.authKeyRequired);
        return;
      }

      // Try the provided key immediately.
      this.setAuthActive('manual', key);

      const probe = await this.apiClient.healthCheck();
      if (!probe.success) {
        this.setAuthNone();
        if (probe.status === 401) {
          setError(t.authFailed);
          return;
        }
        setError(probe.error || t.failedToConnect);
        return;
      }

      // Persist only when not in URL-auth mode.
      writeAuthKeyToLocalStorage(key);

      // Close modal and resume normal loading.
      modal.remove();
      this.authModal = null;
      this.authState = { kind: 'active', source: 'manual', key };

      // Reconnect websocket and refresh data.
      void this.bootstrap();
    };

    submitBtn?.addEventListener('click', () => void doSubmit());
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void doSubmit();
      }
    });

    // Focus input after append.
    const root = this.shadowRoot;
    if (root) {
      root.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
    this.authModal = modal;
    setTimeout(() => input?.focus(), 0);
  }

  private async loadDialogs(): Promise<void> {
    try {
      const api = getApiClient();
      const [runningResp, doneResp, archivedResp, runControlCountsResp] = await Promise.all([
        api.getRootDialogsByStatus('running'),
        api.getRootDialogsByStatus('completed'),
        api.getRootDialogsByStatus('archived'),
        api.getRunControlCounts(),
      ]);

      const responses = [runningResp, doneResp, archivedResp];
      for (const response of responses) {
        if (response.success) continue;
        if (response.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        console.warn('Failed to load dialogs via API', response.error);
        this.markDialogListBootstrapReady();
        this.syncAllDialogLists();
        return;
      }

      const runningRoots = (runningResp.data ?? []).filter((d) => !d.selfId);
      const completedRoots = (doneResp.data ?? []).filter((d) => !d.selfId);
      const archivedRoots = (archivedResp.data ?? []).filter((d) => !d.selfId);

      this.setRootDialogsForStatus('running', runningRoots);
      this.setRootDialogsForStatus('completed', completedRoots);
      this.setRootDialogsForStatus('archived', archivedRoots);
      this.rebuildRootStatusIndex();
      this.pruneVisibleSubdialogRoots();

      this.dialogDisplayStatesByKey.clear();
      for (const root of this.getAllDisplayedDialogs()) {
        const selfId = root.selfId ? root.selfId : root.rootId;
        if (root.status !== 'running' || !root.displayState) continue;
        this.dialogDisplayStatesByKey.set(this.dialogKey(root.rootId, selfId), root.displayState);
      }
      if (runControlCountsResp.success && runControlCountsResp.data) {
        this.proceedingDialogsCount = runControlCountsResp.data.proceeding;
        this.resumableDialogsCount = runControlCountsResp.data.resumable;
        this.updateToolbarDisplay();
      } else {
        console.warn('Failed to refresh run-control counts via API', runControlCountsResp.error);
      }
      this.markDialogListBootstrapReady();
      if (this.currentDialog) {
        const effectiveStatus = this.lookupVisibleDialogStatus(this.currentDialog);
        this.currentDialogStatus = effectiveStatus;

        // Keep selection + routing context stable even if list refresh is briefly stale.
        // Without this, textarea can remain editable while the primary send action has no
        // routable target (`currentDialog === null` inside q4h-input), causing a stuck disabled button.
        // Preserve ids for routing, but clear any stale persisted status when the refreshed lists
        // no longer prove where this dialog currently lives.
        if (effectiveStatus !== null) {
          this.currentDialog = { ...this.currentDialog, status: effectiveStatus };
        } else {
          this.currentDialog = { ...this.currentDialog, status: undefined };
        }
        if (this.q4hInput) {
          this.q4hInput.setDialog(this.currentDialog);
        }
      } else {
        this.currentDialogStatus = null;
      }
      this.syncAllDialogLists();
      this.updateQ4HComponent();
      this.updateInputPanelVisibility();
    } catch (error) {
      this.markDialogListBootstrapReady();
      this.syncAllDialogLists();
      console.error('Error in loadDialogs:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load dialogs: ${message}`, 'error');
    }
  }

  private clearCurrentDialogSelection(): void {
    this.currentDialog = null;
    this.currentDialogStatus = null;
    this.viewportPanelState = { kind: 'hidden' };
    this.toolbarContextHealth = null;
    this.clearDeepLinkAddressBarIfPresent();
    this.updateBrowserTitle(null);

    const root = this.shadowRoot;
    if (!root) return;

    const t = getUiStrings(this.uiLanguage);
    const dialogTitle = root.querySelector('#current-dialog-title');
    if (dialogTitle instanceof HTMLElement) {
      dialogTitle.textContent = t.currentDialogPlaceholder;
    }

    const dialogContainer = root.querySelector('#dialog-container');
    if (dialogContainer instanceof DomindsDialogContainer) {
      dialogContainer.clearDialog();
    }

    if (this.q4hInput) {
      this.q4hInput.clearDialog();
      this.q4hInput.setDisplayState(null);
    }

    this.updateContextHealthUi();
    this.updateDialogViewportPanels();
  }

  private updateBrowserTitle(dialog: Pick<DialogInfo, 'agentId' | 'taskDocPath'> | null): void {
    if (dialog === null) {
      document.title = DomindsApp.DEFAULT_BROWSER_TITLE;
      return;
    }
    document.title = `Dominds • @${dialog.agentId} • ${dialog.taskDocPath}`;
  }

  private async handleDialogDeleteAction(detail: unknown): Promise<void> {
    if (typeof detail !== 'object' || detail === null) return;

    const kind = (detail as { kind?: unknown }).kind;
    if (kind !== 'root') return;

    const rootId = (detail as { rootId?: unknown }).rootId;
    if (typeof rootId !== 'string' || rootId.trim() === '') return;

    const fromStatus = (detail as { fromStatus?: unknown }).fromStatus;
    if (fromStatus !== 'completed' && fromStatus !== 'archived') return;

    const t = getUiStrings(this.uiLanguage);
    const confirmed = window.confirm(t.confirmDeleteDialog);
    if (!confirmed) return;

    const resp = await this.apiClient.deleteDialog(rootId, fromStatus);
    if (!resp.success) {
      if (resp.status === 401) {
        this.onAuthRejected('api');
        return;
      }
      this.showToast(resp.error || t.dialogDeleteFailedToast, 'error');
      return;
    }

    this.showToast(t.dialogDeletedToast, 'info');
    void this.loadDialogs();
  }

  private async handleDialogStatusAction(detail: unknown): Promise<void> {
    if (typeof detail !== 'object' || detail === null) return;

    const kind = (detail as { kind?: unknown }).kind;
    if (kind !== 'root' && kind !== 'task') return;

    const fromStatus = (detail as { fromStatus?: unknown }).fromStatus;
    const toStatus = (detail as { toStatus?: unknown }).toStatus;
    const fromOk =
      fromStatus === 'running' || fromStatus === 'completed' || fromStatus === 'archived';
    const toOk = toStatus === 'running' || toStatus === 'completed' || toStatus === 'archived';
    if (!fromOk || !toOk) return;
    if (fromStatus === toStatus) return;
    const t = getUiStrings(this.uiLanguage);

    let request: ApiMoveDialogsRequest;
    if (kind === 'root') {
      const rootId = (detail as { rootId?: unknown }).rootId;
      if (typeof rootId !== 'string' || rootId.trim() === '') return;
      request = {
        kind: 'root',
        rootId,
        fromStatus,
        toStatus,
      };
    } else {
      const taskDocPath = (detail as { taskDocPath?: unknown }).taskDocPath;
      if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') return;
      request = {
        kind: 'task',
        taskDocPath,
        fromStatus,
        toStatus,
      };
    }

    try {
      const resp = await this.apiClient.moveDialogs(request);
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        this.showToast(resp.error || t.moveDialogsFailedToast, 'error');
        return;
      }
      const payload = resp.data;
      if (!payload || !payload.success) {
        const msg = payload && payload.error ? payload.error : t.moveDialogsFailedToast;
        this.showToast(msg, 'error');
        return;
      }

      const movedCount = Array.isArray(payload.movedRootIds) ? payload.movedRootIds.length : 0;
      this.showToast(`${t.movedDialogsToastPrefix}${String(movedCount)}`, 'info');

      // Optimistic root-snapshot update so UI reacts immediately (no waiting on loadDialogs()).
      const movedRootIds = Array.isArray(payload.movedRootIds) ? payload.movedRootIds : [];
      if (movedRootIds.length > 0) {
        let didUpdate = false;
        for (const rootId of movedRootIds) {
          const existing = this.getRootDialog(rootId);
          if (!existing) continue;
          if (existing.status === toStatus) continue;
          this.upsertRootDialogSnapshot({ ...existing, status: toStatus });
          didUpdate = true;
        }
        if (didUpdate) {
          this.updateDialogList();
          if (this.currentDialog) {
            this.currentDialogStatus = this.lookupVisibleDialogStatus(this.currentDialog);
          } else {
            this.currentDialogStatus = null;
          }
          this.updateInputPanelVisibility();
          this.updateQ4HComponent();
        }
      }

      // If a dialog is revived to running, refresh Q4H state so any pending questions reappear.
      if (toStatus === 'running') {
        this.wsManager.sendRaw({ type: 'get_q4h_state' });
      }

      await this.loadDialogs();
      if (this.currentDialog) {
        this.currentDialogStatus = this.lookupVisibleDialogStatus(this.currentDialog);
      } else {
        this.currentDialogStatus = null;
      }
      this.updateInputPanelVisibility();
      this.updateQ4HComponent();
    } catch (error) {
      const message = error instanceof Error ? error.message : t.unknownError;
      this.showToast(`${t.moveDialogsFailedToast}: ${message}`, 'error');
    }
  }

  private async handleDialogCreateAction(detail: unknown): Promise<void> {
    if (typeof detail !== 'object' || detail === null) return;

    const kind = (detail as { kind?: unknown }).kind;
    if (kind !== 'task' && kind !== 'root') return;

    const typed = detail as DialogCreateAction;
    if (typed.kind === 'task') {
      const taskDocPath = (detail as { taskDocPath?: unknown }).taskDocPath;
      if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') return;

      await this.openCreateDialogFlow({
        source: 'task_action',
        presetTaskDocPath: taskDocPath,
      });
      return;
    }

    const agentId = (detail as { agentId?: unknown }).agentId;
    const taskDocPath = (detail as { taskDocPath?: unknown }).taskDocPath;
    if (typeof agentId !== 'string' || agentId.trim() === '') return;
    if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') return;
    await this.openCreateDialogFlow({
      source: 'root_action',
      presetAgentId: agentId,
      presetTaskDocPath: taskDocPath,
    });
  }

  /**
   * Load the root hierarchy for a known persisted status.
   * This is used by explicit business flows that already know which list/status they are acting on.
   * Do not widen this back into a "best effort by ids" helper; callers should resolve business
   * status first so we don't regress to guessing `running` from partial UI state.
   */
  private async loadRootHierarchyForKnownStatus(
    rootId: string,
    status: PersistableDialogStatus,
  ): Promise<void> {
    try {
      const rootEntry = this.getRootDialog(rootId);
      const api = getApiClient();
      const hierarchyResp = await api.getDialogHierarchy(rootId, status);

      if (!hierarchyResp.success) {
        if (hierarchyResp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        throw new Error(hierarchyResp.error || `Failed to load hierarchy for ${rootId}`);
      }

      if (!hierarchyResp.data) {
        throw new Error(`Hierarchy response for ${rootId} is missing data`);
      }

      const h = hierarchyResp.data;
      if (!Array.isArray(h.subdialogs)) {
        throw new Error(`Hierarchy response for ${rootId} has invalid subdialogs payload`);
      }

      const cachedRootDisplayState = this.dialogDisplayStatesByKey.get(
        this.dialogKey(rootId, rootId),
      );
      const rootDisplayState =
        status === 'running' ? (h.root.displayState ?? cachedRootDisplayState) : undefined;
      if (rootDisplayState) {
        this.dialogDisplayStatesByKey.set(this.dialogKey(rootId, rootId), rootDisplayState);
      }

      const newSubdialogs: ApiRootDialogResponse[] = [];
      for (const subdialog of h.subdialogs) {
        if (!subdialog) {
          throw new Error(`Hierarchy response for ${rootId} contains empty subdialog entry`);
        }
        if (!subdialog.rootId) {
          throw new Error(`Hierarchy response for ${rootId} contains subdialog without rootId`);
        }
        if (subdialog.rootId !== rootId) {
          throw new Error(
            `Hierarchy response for ${rootId} contains subdialog with mismatched rootId=${subdialog.rootId}`,
          );
        }
        if (!subdialog.selfId) {
          throw new Error(`Hierarchy response for ${rootId} contains subdialog without selfId`);
        }
        if (subdialog.selfId === rootId) {
          throw new Error(
            `Hierarchy response for ${rootId} contains root dialog inside subdialog list`,
          );
        }
        const cachedDisplayState = this.dialogDisplayStatesByKey.get(
          this.dialogKey(subdialog.rootId, subdialog.selfId),
        );
        const effectiveDisplayState =
          status === 'running' ? (subdialog.displayState ?? cachedDisplayState) : undefined;
        if (effectiveDisplayState) {
          this.dialogDisplayStatesByKey.set(
            this.dialogKey(subdialog.rootId, subdialog.selfId),
            effectiveDisplayState,
          );
        }
        newSubdialogs.push({
          rootId: subdialog.rootId,
          selfId: subdialog.selfId,
          agentId: subdialog.agentId,
          taskDocPath: subdialog.taskDocPath,
          status: subdialog.status,
          currentCourse: subdialog.currentCourse,
          createdAt: subdialog.createdAt,
          lastModified: subdialog.lastModified,
          displayState: effectiveDisplayState,
          supdialogId: this.resolveSupdialogIdForSubdialog(subdialog),
          sessionSlug: subdialog.sessionSlug,
          assignmentFromSup: subdialog.assignmentFromSup,
          waitingForFreshBootsReasoning: subdialog.waitingForFreshBootsReasoning === true,
        });
      }
      const mergedSubdialogs = this.mergeVisibleSubdialogsForRootFromHierarchy(
        rootId,
        newSubdialogs,
      );

      const nextRoot: ApiRootDialogResponse = {
        rootId,
        agentId: h.root.agentId,
        taskDocPath: h.root.taskDocPath,
        status: h.root.status,
        currentCourse: h.root.currentCourse,
        createdAt: h.root.createdAt,
        lastModified: h.root.lastModified,
        displayState: rootDisplayState ?? rootEntry?.displayState,
        waitingForFreshBootsReasoning: h.root.waitingForFreshBootsReasoning === true,
        subdialogCount:
          typeof rootEntry?.subdialogCount === 'number'
            ? Math.max(rootEntry.subdialogCount, mergedSubdialogs.length)
            : mergedSubdialogs.length,
      };

      this.upsertRootDialogSnapshot(nextRoot);
      this.setVisibleSubdialogsForRoot(rootId, mergedSubdialogs);
      this.syncDialogListByStatus(status);
    } catch (hierarchyError) {
      console.warn(`Failed to load hierarchy for root dialog ${rootId}:`, hierarchyError);
      throw hierarchyError;
    }
  }

  private requestRootHierarchyFromList(rootId: string, status: PersistableDialogStatus): void {
    // Explicit list expansion is user-visible. The event edge cannot await, so it must terminate
    // failures here instead of leaking an unhandled rejection.
    void this.loadRootHierarchyForKnownStatus(rootId, status).catch((error: unknown) => {
      const t = getUiStrings(this.uiLanguage);
      const message = error instanceof Error ? error.message : t.unknownError;
      console.error(`Failed to load hierarchy from list expand for root dialog ${rootId}:`, error);
      this.showError(message, 'error');
    });
  }

  private refreshRootHierarchyAfterTellask(rootId: string): void {
    // Tell/ask carryover may create new sideline dialogs. This refresh is background-only, but
    // still must terminate its Promise locally so we do not accumulate unhandled rejections.
    void this.loadRootHierarchyForKnownStatus(rootId, 'running').catch((error: unknown) => {
      console.error(
        `Failed to refresh hierarchy after tellask event for root dialog ${rootId}:`,
        error,
      );
    });
  }

  /**
   * Drop all subdialogs under a collapsed root to keep frontend memory bounded.
   * Re-expanding must refetch from backend instead of reusing stale in-memory copies.
   */
  private pruneSubdialogsForRoot(rootId: string, status?: PersistableDialogStatus): void {
    if (!this.visibleSubdialogsByRoot.has(rootId)) return;
    this.visibleSubdialogsByRoot.delete(rootId);

    for (const key of Array.from(this.dialogDisplayStatesByKey.keys())) {
      if (key.startsWith(`${rootId}#`)) {
        this.dialogDisplayStatesByKey.delete(key);
      }
    }
    for (const key of Array.from(this.contextHealthByDialogKey.keys())) {
      if (key.startsWith(`${rootId}#`)) {
        this.contextHealthByDialogKey.delete(key);
      }
    }

    const rootStatus = status ?? this.toPersistableStatus(this.getRootDialog(rootId)?.status);
    if (rootStatus !== null) {
      this.syncDialogListByStatus(rootStatus);
    }
  }

  private removeQuarantinedRootDialog(rootId: string, fromStatus: DialogStatusKind): void {
    const persistedFromStatus = this.requirePersistableStatus(
      fromStatus,
      'removeQuarantinedRootDialog',
    );
    let removed = false;
    for (const candidateStatus of ['running', 'completed', 'archived'] as const) {
      const current = this.getRootDialogsForStatus(candidateStatus);
      const next = current.filter((dialog) => dialog.rootId !== rootId);
      if (next.length !== current.length) {
        this.setRootDialogsForStatus(candidateStatus, next);
        removed = true;
      }
    }

    const hadVisibleSubdialogs = this.visibleSubdialogsByRoot.has(rootId);
    this.rootStatusById.delete(rootId);
    this.visibleSubdialogsByRoot.delete(rootId);
    const nextBacklog = this.q4hQuestions.filter((question) => {
      const global = question as { rootId?: unknown; selfId?: unknown };
      const selfId = typeof global.selfId === 'string' ? global.selfId : null;
      if (!selfId) {
        return true;
      }
      const questionRootId =
        typeof global.rootId === 'string' && global.rootId ? global.rootId : selfId;
      return questionRootId !== rootId;
    });
    if (nextBacklog.length !== this.q4hQuestions.length) {
      this.q4hQuestions = nextBacklog;
    }

    for (const key of Array.from(this.dialogDisplayStatesByKey.keys())) {
      if (key === rootId || key.startsWith(`${rootId}#`)) {
        this.dialogDisplayStatesByKey.delete(key);
      }
    }
    for (const key of Array.from(this.contextHealthByDialogKey.keys())) {
      if (key === rootId || key.startsWith(`${rootId}#`)) {
        this.contextHealthByDialogKey.delete(key);
      }
    }

    const current = this.currentDialog;
    const removedCurrentDialog = current?.rootId === rootId;
    if (removedCurrentDialog) {
      this.clearCurrentDialogSelection();
      this.showToast(getUiStrings(this.uiLanguage).dialogQuarantinedToast, 'warning');
    }

    if (!removed && !removedCurrentDialog && !hadVisibleSubdialogs) {
      return;
    }

    this.syncDialogListByStatus(persistedFromStatus);
    this.updateQ4HComponent();
    this.updateInputPanelVisibility();
    this.updateToolbarDisplay();
  }

  private removeUnavailableDialogLocally(rootId: string, selfId: string): void {
    if (selfId === rootId) {
      let removed = false;
      for (const candidateStatus of ['running', 'completed', 'archived'] as const) {
        const current = this.getRootDialogsForStatus(candidateStatus);
        const next = current.filter((dialog) => dialog.rootId !== rootId);
        if (next.length !== current.length) {
          this.setRootDialogsForStatus(candidateStatus, next);
          removed = true;
        }
      }

      const hadVisibleSubdialogs = this.visibleSubdialogsByRoot.has(rootId);
      this.rootStatusById.delete(rootId);
      this.visibleSubdialogsByRoot.delete(rootId);
      const nextBacklog = this.q4hQuestions.filter((question) => {
        const global = question as { rootId?: unknown; selfId?: unknown };
        const questionSelfId = typeof global.selfId === 'string' ? global.selfId : null;
        if (!questionSelfId) {
          return true;
        }
        const questionRootId =
          typeof global.rootId === 'string' && global.rootId ? global.rootId : questionSelfId;
        return questionRootId !== rootId;
      });
      const removedQuestions = nextBacklog.length !== this.q4hQuestions.length;
      if (removedQuestions) {
        this.q4hQuestions = nextBacklog;
      }

      for (const key of Array.from(this.dialogDisplayStatesByKey.keys())) {
        if (key === rootId || key.startsWith(`${rootId}#`)) {
          this.dialogDisplayStatesByKey.delete(key);
        }
      }
      for (const key of Array.from(this.contextHealthByDialogKey.keys())) {
        if (key === rootId || key.startsWith(`${rootId}#`)) {
          this.contextHealthByDialogKey.delete(key);
        }
      }

      const removedCurrentDialog = this.currentDialog?.rootId === rootId;
      if (removedCurrentDialog) {
        this.clearCurrentDialogSelection();
      }

      if (!removed && !removedCurrentDialog && !hadVisibleSubdialogs && !removedQuestions) {
        return;
      }

      this.syncAllDialogLists();
      this.updateQ4HComponent();
      this.updateInputPanelVisibility();
      this.updateToolbarDisplay();
      return;
    }

    const currentSubdialogs = this.getVisibleSubdialogsForRoot(rootId);
    const nextSubdialogs = currentSubdialogs.filter((dialog) => dialog.selfId !== selfId);
    const removedSubdialog = nextSubdialogs.length !== currentSubdialogs.length;
    if (removedSubdialog) {
      this.setVisibleSubdialogsForRoot(rootId, nextSubdialogs);
    }

    const dialogKey = this.dialogKey(rootId, selfId);
    const hadDisplayState = this.dialogDisplayStatesByKey.delete(dialogKey);
    const hadContextHealth = this.contextHealthByDialogKey.delete(dialogKey);
    const nextBacklog = this.q4hQuestions.filter((question) => {
      const global = question as { rootId?: unknown; selfId?: unknown };
      const questionSelfId = typeof global.selfId === 'string' ? global.selfId : null;
      if (questionSelfId !== selfId) {
        return true;
      }
      const questionRootId =
        typeof global.rootId === 'string' && global.rootId ? global.rootId : questionSelfId;
      return questionRootId !== rootId;
    });
    const removedQuestions = nextBacklog.length !== this.q4hQuestions.length;
    if (removedQuestions) {
      this.q4hQuestions = nextBacklog;
    }

    const removedCurrentDialog =
      this.currentDialog?.rootId === rootId && this.currentDialog?.selfId === selfId;
    if (removedCurrentDialog) {
      this.clearCurrentDialogSelection();
    }

    if (
      !removedSubdialog &&
      !hadDisplayState &&
      !hadContextHealth &&
      !removedQuestions &&
      !removedCurrentDialog
    ) {
      return;
    }

    const rootStatus = this.getRootStatus(rootId);
    if (rootStatus !== null) {
      this.syncDialogListByStatus(rootStatus);
    }
    this.updateQ4HComponent();
    this.updateInputPanelVisibility();
    this.updateToolbarDisplay();
  }

  private async loadTeamMembers(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent === true;
    const teamMembersEl = this.shadowRoot ? this.shadowRoot.querySelector('#team-members') : null;
    const teamMembersComponent = teamMembersEl instanceof DomindsTeamMembers ? teamMembersEl : null;
    if (!silent) {
      this.teamMembersLoadState = { kind: 'loading' };
      this.updateNewDialogButtonState();
    }
    if (!silent && teamMembersComponent) teamMembersComponent.setLoading(true);
    try {
      const api = getApiClient();
      const resp = await api.getTeamConfig();
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        console.warn('Failed to load team config via API', resp.error);
        this.teamMembersLoadState = { kind: 'failed', message: resp.error || 'Unknown error' };
        return;
      }
      const cfg = resp.data?.configuration;
      if (!cfg) {
        this.teamMembersLoadState = { kind: 'failed', message: 'Missing team config payload' };
        return;
      }

      const md = cfg.memberDefaults;
      const membersRec = cfg.members || {};
      for (const m of Object.values(membersRec)) {
        Object.setPrototypeOf(m, md);
      }
      this.teamMembers = Object.values(membersRec);
      const def = cfg.defaultResponder;
      this.defaultResponder = typeof def === 'string' ? def : null;

      if (teamMembersComponent) {
        teamMembersComponent.setMembers(this.teamMembers);
        teamMembersComponent.setDefaultResponder(this.defaultResponder);
      }

      this.teamMembersLoadState = { kind: 'ready' };

      if (!silent && this.teamMembers.length === 0) {
        this.showWarning('No team members configured');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.teamMembersLoadState = { kind: 'failed', message };
      if (!silent) {
        this.showError(`Failed to load team members: ${message}`, 'warning');
      }
    } finally {
      if (!silent && teamMembersComponent) teamMembersComponent.setLoading(false);
      this.updateNewDialogButtonState();
    }
  }

  private async loadTaskDocuments(): Promise<void> {
    try {
      const api = getApiClient();
      const resp = await api.getTaskDocuments();
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        return;
      }
      const data = resp.data;
      if (data && data.success && data.taskDocuments) {
        this.taskDocuments = data.taskDocuments.map((doc) => ({
          path: doc.path,
          relativePath: doc.relativePath,
          name: doc.name,
        }));
      }
    } catch (error) {
      console.error('Failed to load Taskdocs:', error);
    }
  }

  private validateDialogTaskDocPaths(dialogs: ApiRootDialogResponse[]): void {
    dialogs.forEach((dialog, index) => {
      if (!dialog.taskDocPath || dialog.taskDocPath.trim() === '') {
        throw new Error(
          `CRITICAL ERROR: Dialog at index ${index} (ID: ${dialog.rootId}) has invalid Taskdoc path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Taskdoc is mandatory for all dialogs.`,
        );
      }
    });
  }

  private syncDialogListByStatus(status: PersistableDialogStatus): void {
    if (!this.shadowRoot) return;
    const loading = this.isDialogListBootstrapping();
    const dialogs = this.getDisplayedDialogsForStatus(status);
    this.validateDialogTaskDocPaths(dialogs);

    switch (status) {
      case 'running': {
        const runningList = this.shadowRoot.querySelector('#running-dialog-list');
        if (runningList instanceof RunningDialogList) {
          runningList.setProps({ loading });
          runningList.applySnapshot(dialogs);
          if (this.currentDialog) runningList.setCurrentDialog(this.currentDialog);
        }
        break;
      }
      case 'completed': {
        const doneList = this.shadowRoot.querySelector('#done-dialog-list');
        if (doneList instanceof DoneDialogList) {
          doneList.setProps({ loading });
          doneList.applySnapshot(dialogs);
          if (this.currentDialog) doneList.setCurrentDialog(this.currentDialog);
        }
        break;
      }
      case 'archived': {
        const archivedList = this.shadowRoot.querySelector('#archived-dialog-list');
        if (archivedList instanceof ArchivedDialogList) {
          archivedList.setProps({ loading });
          archivedList.applySnapshot(dialogs);
          if (this.currentDialog) archivedList.setCurrentDialog(this.currentDialog);
        }
        break;
      }
      default: {
        const _exhaustive: never = status;
        throw new Error(`Unhandled dialog status sync: ${String(_exhaustive)}`);
      }
    }
  }

  private syncAllDialogLists(): void {
    this.syncDialogListByStatus('running');
    this.syncDialogListByStatus('completed');
    this.syncDialogListByStatus('archived');
  }

  private patchDialogListEntry(
    status: PersistableDialogStatus,
    dialogId: { rootId: string; selfId: string },
    patch: Partial<ApiRootDialogResponse>,
  ): boolean {
    if (!this.shadowRoot) return false;
    switch (status) {
      case 'running': {
        const list = this.shadowRoot.querySelector('#running-dialog-list');
        if (!(list instanceof RunningDialogList)) return false;
        return list.updateDialogEntry(dialogId.rootId, dialogId.selfId, patch);
      }
      case 'completed': {
        const list = this.shadowRoot.querySelector('#done-dialog-list');
        if (!(list instanceof DoneDialogList)) return false;
        return list.updateDialogEntry(dialogId.rootId, dialogId.selfId, patch);
      }
      case 'archived': {
        const list = this.shadowRoot.querySelector('#archived-dialog-list');
        if (!(list instanceof ArchivedDialogList)) return false;
        return list.updateDialogEntry(dialogId.rootId, dialogId.selfId, patch);
      }
      default: {
        const _exhaustive: never = status;
        throw new Error(`Unhandled dialog status patch: ${String(_exhaustive)}`);
      }
    }
  }

  private isDialogListBootstrapping(): boolean {
    return this.dialogListBootstrapState.kind === 'loading';
  }

  private markDialogListBootstrapReady(): void {
    if (this.dialogListBootstrapState.kind === 'ready') return;
    this.dialogListBootstrapState = { kind: 'ready' };
  }

  private lookupVisibleDialogStatus(dialog: DialogInfo): PersistableDialogStatus | null {
    const directStatus = this.toPersistableStatus(dialog.status);
    if (directStatus) return directStatus;
    const isRoot = dialog.selfId === dialog.rootId;
    if (isRoot) {
      const match = this.getRootDialog(dialog.rootId);
      return match ? this.toPersistableStatus(match.status) : null;
    }
    const match = this.findDisplayedDialogByIds(dialog.rootId, dialog.selfId);
    if (match) return this.toPersistableStatus(match.status);
    // Subdialogs always share the same persistence status directory as their root dialog.
    const rootMatch = this.getRootDialog(dialog.rootId);
    return rootMatch ? this.toPersistableStatus(rootMatch.status) : null;
  }

  private lookupVisibleDialogStatusByIds(
    rootId: string,
    selfId: string,
  ): PersistableDialogStatus | null {
    if (!rootId || !selfId) return null;
    const isRoot = selfId === rootId;
    if (isRoot) {
      const match = this.getRootDialog(rootId);
      return match ? this.toPersistableStatus(match.status) : null;
    }
    const match = this.findDisplayedDialogByIds(rootId, selfId);
    if (match) return this.toPersistableStatus(match.status);
    // Subdialogs always share the same persistence status directory as their root dialog.
    const rootMatch = this.getRootDialog(rootId);
    return rootMatch ? this.toPersistableStatus(rootMatch.status) : null;
  }

  private getCurrentDialogDisplayState(): DialogDisplayState | null {
    const current = this.currentDialog;
    if (!current) return null;
    if (this.currentDialogStatus !== 'running') return null;
    return (
      this.dialogDisplayStatesByKey.get(this.dialogKey(current.rootId, current.selfId)) ?? null
    );
  }

  private formatResumeRejectedStoppedPanelSummary(
    reason: ErrorMessage['resumeNotEligibleReason'],
  ): string {
    const t = getUiStrings(this.uiLanguage);
    switch (reason) {
      case 'waiting_for_subdialogs':
        return t.resumeRejectedResumptionPanelWaitingSubdialogs;
      case 'needs_human_input':
        return t.resumeRejectedResumptionPanelNeedsHumanInput;
      case 'needs_human_input_and_subdialogs':
        return t.resumeRejectedResumptionPanelNeedsHumanInputAndSubdialogs;
      case 'idle_waiting_user':
        return t.resumeRejectedResumptionPanelIdleWaitingUser;
      case 'already_running':
        return t.resumeRejectedResumptionPanelAlreadyRunning;
      case 'stopped_not_resumable':
        return t.resumeRejectedResumptionPanelStoppedNotResumable;
      case 'dead':
        return t.resumeRejectedResumptionPanelDead;
      case 'missing':
      case undefined:
        return t.resumeRejectedResumptionPanelSummary;
      default: {
        const _exhaustive: never = reason;
        return String(_exhaustive);
      }
    }
  }

  private annotateStoppedPanelAfterResumeRejected(args: {
    detailMessage: string;
    reason: ErrorMessage['resumeNotEligibleReason'];
  }): void {
    const summary = this.formatResumeRejectedStoppedPanelSummary(args.reason);
    const i18nStopReason: Extract<
      DialogInterruptionReason,
      { kind: 'system_stop' }
    >['i18nStopReason'] = {
      [this.uiLanguage]: summary,
    };
    const reason: Extract<DialogInterruptionReason, { kind: 'system_stop' }> = {
      kind: 'system_stop',
      detail: args.detailMessage,
      i18nStopReason,
    };
    const currentDisplayState = this.getCurrentDialogDisplayState();
    if (this.currentDialog && currentDisplayState?.kind === 'stopped') {
      const nextDisplayState: DialogDisplayState = {
        kind: 'stopped',
        reason,
        continueEnabled: false,
      };
      this.dialogDisplayStatesByKey.set(
        this.dialogKey(this.currentDialog.rootId, this.currentDialog.selfId),
        nextDisplayState,
      );
      if (this.currentDialogStatus === 'running') {
        const input = this.q4hInput as HTMLElement & {
          setDisplayState?: (state: DialogDisplayState | null) => void;
        };
        if (input && typeof input.setDisplayState === 'function') {
          input.setDisplayState(nextDisplayState);
        }
        this.updateInputPanelVisibility();
      }
      this.updateDialogViewportPanels();
      return;
    }
    if (this.viewportPanelState.kind === 'stopped') {
      this.viewportPanelState = {
        kind: 'stopped',
        genseq: this.viewportPanelState.genseq,
        reason,
        continueEnabled: false,
      };
      this.updateDialogViewportPanels();
    }
  }

  private isViewingLatestCourse(): boolean {
    return this.currentDialog !== null && this.toolbarCurrentCourse === this.toolbarTotalCourses;
  }

  private formatInterruptionReason(reason: DialogInterruptionReason): string {
    const t = getUiStrings(this.uiLanguage);
    switch (reason.kind) {
      case 'user_stop':
        return t.stoppedByYou;
      case 'emergency_stop':
        return t.stoppedByEmergencyStop;
      case 'server_restart':
        return t.interruptedByServerRestart;
      case 'pending_course_start':
        return t.pendingCourseStartReady;
      case 'fork_continue_ready':
        return t.forkContinueReady;
      case 'llm_retry_stopped':
        return formatRetryStoppedReason(reason, this.uiLanguage);
      case 'system_stop':
        return formatSystemStopReason(reason, this.uiLanguage);
      default: {
        const _exhaustive: never = reason;
        return String(_exhaustive);
      }
    }
  }

  private clearRetryCountdownTimer(): void {
    if (this.retryCountdownTimer !== null) {
      window.clearTimeout(this.retryCountdownTimer);
      this.retryCountdownTimer = null;
    }
  }

  private formatRetryCountdownDuration(msRemaining: number): string {
    const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
    if (totalSeconds < 60) {
      return this.uiLanguage === 'zh' ? `${String(totalSeconds)} 秒` : `${String(totalSeconds)}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (this.uiLanguage === 'zh') {
      return seconds === 0
        ? `${String(minutes)} 分钟`
        : `${String(minutes)} 分 ${String(seconds)} 秒`;
    }
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
  }

  private formatRetrySummaryWithCountdown(
    summary: string,
    nextRetryAtMs: number | undefined,
  ): string {
    if (nextRetryAtMs === undefined) {
      return summary;
    }
    const t = getUiStrings(this.uiLanguage);
    const countdown = this.formatRetryCountdownDuration(nextRetryAtMs - Date.now());
    const countdownText = `${t.retryCountdownPrefix}${countdown}${t.retryCountdownSuffix}`;
    if (summary.trim() === '') {
      return countdownText;
    }
    return `${summary} ${countdownText}`;
  }

  private syncRetryCountdownTimer(nextRetryAtMs: number | undefined): void {
    this.clearRetryCountdownTimer();
    if (nextRetryAtMs === undefined) {
      return;
    }
    const remainingMs = nextRetryAtMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    const delayMs = Math.min(1000, Math.max(100, remainingMs % 1000 || 1000));
    this.retryCountdownTimer = window.setTimeout(() => {
      this.retryCountdownTimer = null;
      this.updateDialogViewportPanels();
    }, delayMs);
  }

  private updateDialogViewportPanels(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const dialogContainer = root.querySelector(
      '#dialog-container',
    ) as DomindsDialogContainer | null;
    const wrap = root.querySelector('#dialog-viewport-panels') as HTMLElement | null;
    const statusPanel = root.querySelector('#dialog-status-panel') as HTMLElement | null;
    const statusTitle = root.querySelector('#dialog-status-title') as HTMLElement | null;
    const statusSummary = root.querySelector('#dialog-status-summary') as HTMLElement | null;
    const statusError = root.querySelector('#dialog-status-error') as HTMLElement | null;
    const statusBtn = root.querySelector('#dialog-status-btn') as HTMLButtonElement | null;
    if (!wrap || !statusPanel || !statusTitle || !statusSummary || !statusError || !statusBtn) {
      return;
    }

    const wrapWasHidden = wrap.classList.contains('hidden');
    const panelWasHidden = statusPanel.classList.contains('hidden');
    const t = getUiStrings(this.uiLanguage);
    const viewingLatestCourse = this.isViewingLatestCourse();
    const displayState = viewingLatestCourse ? this.getCurrentDialogDisplayState() : null;
    const viewportPanelState: DialogViewportPanelState = viewingLatestCourse
      ? this.viewportPanelState
      : { kind: 'hidden' };
    const stoppedReason =
      this.currentDialog !== null && displayState !== null && displayState.kind === 'stopped'
        ? displayState.reason
        : viewportPanelState.kind === 'stopped'
          ? viewportPanelState.reason
          : null;
    const continueEnabled =
      this.currentDialog !== null && displayState !== null && displayState.kind === 'stopped'
        ? displayState.continueEnabled
        : viewportPanelState.kind === 'stopped'
          ? viewportPanelState.continueEnabled
          : false;
    const retryingState =
      this.currentDialog !== null &&
      viewportPanelState.kind === 'retrying' &&
      (displayState === null || (displayState.kind !== 'stopped' && displayState.kind !== 'dead'))
        ? viewportPanelState
        : null;

    const panelVisible = retryingState !== null || stoppedReason !== null;
    this.syncRetryCountdownTimer(retryingState?.nextRetryAtMs);
    statusPanel.classList.toggle('hidden', !panelVisible);
    statusBtn.classList.toggle('hidden', stoppedReason === null);
    statusBtn.textContent = t.continueLabel;
    statusBtn.disabled = stoppedReason === null || !continueEnabled;
    statusPanel.setAttribute(
      'data-state',
      retryingState !== null ? 'retrying' : stoppedReason !== null ? 'stopped' : 'hidden',
    );
    if (!panelVisible) {
      statusTitle.textContent = '';
      statusSummary.textContent = '';
      statusError.textContent = '';
    } else if (retryingState !== null) {
      statusTitle.textContent = resolveRetryDisplayTitle(retryingState.display, this.uiLanguage);
      statusSummary.textContent = this.formatRetrySummaryWithCountdown(
        resolveRetryDisplaySummary(retryingState.display, this.uiLanguage),
        retryingState.nextRetryAtMs,
      );
      statusError.textContent = retryingState.errorText;
    } else if (stoppedReason?.kind === 'llm_retry_stopped') {
      statusTitle.textContent = resolveRetryDisplayTitle(stoppedReason.display, this.uiLanguage);
      statusSummary.textContent = resolveRetryDisplaySummary(
        stoppedReason.display,
        this.uiLanguage,
      );
      statusError.textContent = stoppedReason.error.trim();
    } else if (stoppedReason !== null) {
      statusTitle.textContent = t.resumptionPanelTitle;
      statusSummary.textContent = this.formatInterruptionReason(stoppedReason);
      statusError.textContent = '';
    }

    wrap.classList.toggle('hidden', !panelVisible);
    if (dialogContainer && (wrapWasHidden !== !panelVisible || panelWasHidden !== !panelVisible)) {
      dialogContainer.stabilizeAutoFollowAfterViewportChange();
    }
  }

  private resumeCurrentDialog(): void {
    if (!this.currentDialog) return;
    this.wsManager.sendRaw({
      type: 'resume_dialog',
      dialog: {
        selfId: this.currentDialog.selfId,
        rootId: this.currentDialog.rootId,
      },
    });
  }

  private updateInputPanelVisibility(): void {
    const t = getUiStrings(this.uiLanguage);
    const readOnly =
      this.currentDialogStatus === 'completed' || this.currentDialogStatus === 'archived';
    let isDead = false;
    const current = this.currentDialog;
    if (!readOnly && current) {
      const key = this.dialogKey(current.rootId, current.selfId);
      const displayState = this.dialogDisplayStatesByKey.get(key) ?? null;
      isDead = displayState !== null && displayState.kind === 'dead';
    }
    const disabled = readOnly || isDead;

    const root = this.shadowRoot;
    if (!root) return;

    const banner = root.querySelector('#q4h-readonly-banner');
    if (banner instanceof HTMLElement) {
      banner.classList.toggle('hidden', !disabled);
      banner.textContent = isDead ? t.deadDialogInputDisabled : t.readOnlyDialogInputDisabled;
    }

    const inputEl = root.querySelector('#q4h-input');
    if (inputEl instanceof HTMLElement) {
      inputEl.classList.toggle('hidden', disabled);
    }

    if (this.q4hInput) {
      this.q4hInput.setDisabled(disabled);
    }

    this.updateDialogViewportPanels();
  }

  private normalizeDialogSelectionTarget(dialog: DialogInfo): DialogInfo | null {
    const selfId = dialog.selfId || dialog.rootId;
    const rootId = dialog.rootId || dialog.selfId;
    if (!selfId || !rootId) {
      return null;
    }
    return {
      ...dialog,
      selfId,
      rootId,
    };
  }

  private async openDialogWithKnownStatus(
    dialog: DialogInfo,
    status: PersistableDialogStatus,
    options: { syncAddressBar: boolean; showLoadedToast: boolean },
  ): Promise<void> {
    // This is the single "open dialog" primitive for user-visible flows.
    // The status is part of the business input; if a caller does not know it yet,
    // that caller must resolve it explicitly before coming here.
    const normalizedDialog = this.normalizeDialogSelectionTarget(dialog);
    if (!normalizedDialog) {
      this.showError('Invalid dialog identifiers: selfId and rootId are required', 'error');
      return;
    }

    if (normalizedDialog.selfId !== normalizedDialog.rootId) {
      const subdialogLoaded = this.getVisibleSubdialogsForRoot(normalizedDialog.rootId).some(
        (d) => d.selfId === normalizedDialog.selfId,
      );
      if (!subdialogLoaded) {
        await this.loadRootHierarchyForKnownStatus(normalizedDialog.rootId, status);
      }
    }

    this.currentDialog = normalizedDialog;
    this.currentDialogStatus = status;
    this.viewportPanelState = { kind: 'hidden' };
    this.updateInputPanelVisibility();
    this.applyDiligenceState({
      disableDiligencePush: false,
      configuredMax: null,
      remaining: null,
    });
    this.updateBottomPanelFooterUi();
    if (this.toolsWidgetVisible) {
      this.refreshToolsWidget();
    }

    try {
      const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
      if (dialogContainer instanceof DomindsDialogContainer) {
        const entry = this.getRootDialog(normalizedDialog.rootId) ?? undefined;
        const agentId = normalizedDialog.agentId || entry?.agentId;
        await dialogContainer.setDialog({
          ...normalizedDialog,
          agentId,
          status,
        });
      }

      this.wsManager.sendRaw({
        type: 'display_dialog',
        dialog: {
          ...normalizedDialog,
          status,
        },
      });

      const dialogTitle = this.shadowRoot?.querySelector('#current-dialog-title') as HTMLElement;
      if (dialogTitle) {
        let titleText = '';
        const isFbrSideline =
          normalizedDialog.assignmentFromSup?.callName === 'freshBootsReasoning';
        const callsign = isFbrSideline ? 'FBR' : `@${normalizedDialog.agentId}`;
        titleText = `${callsign} (${normalizedDialog.selfId})`;
        titleText += ` • ${normalizedDialog.taskDocPath}`;
        dialogTitle.textContent = titleText;
      }
      this.updateBrowserTitle(normalizedDialog);

      if (this.q4hInput) {
        this.q4hInput.setDialog({
          ...normalizedDialog,
          status,
        });
        const key = this.dialogKey(normalizedDialog.rootId, normalizedDialog.selfId);
        const displayState =
          status === 'running' ? (this.dialogDisplayStatesByKey.get(key) ?? null) : null;
        const isDead = displayState !== null && displayState.kind === 'dead';
        const input = this.q4hInput as HTMLElement & {
          setDisplayState?: (state: DialogDisplayState | null) => void;
        };
        if (input && typeof input.setDisplayState === 'function') {
          input.setDisplayState(displayState);
        }

        const isReadOnly = status === 'completed' || status === 'archived';
        if (!isReadOnly && !isDead) {
          setTimeout(() => {
            const input = this.q4hInput;
            const current = this.currentDialog;
            const currentStatus = this.currentDialogStatus;
            const readOnly = currentStatus === 'completed' || currentStatus === 'archived';
            if (!input) return;
            if (!current) return;
            if (readOnly) return;
            const key = this.dialogKey(current.rootId, current.selfId);
            const displayState = this.dialogDisplayStatesByKey.get(key) ?? null;
            const isDead = displayState !== null && displayState.kind === 'dead';
            if (isDead) return;
            input.setDisabled(false);
          }, 500);

          setTimeout(() => {
            const input = this.q4hInput;
            if (input) input.focusInput();
          }, 100);
        } else {
          this.q4hInput.setDisabled(true);
        }
      } else {
        console.warn('Auto-focus: No q4h-input component found after dialog selection');
      }

      const sr = this.shadowRoot;
      if (sr) {
        const runningList = sr.querySelector('#running-dialog-list');
        if (runningList instanceof RunningDialogList) {
          runningList.setCurrentDialog(normalizedDialog);
        }
        const doneList = sr.querySelector('#done-dialog-list');
        if (doneList instanceof DoneDialogList) {
          doneList.setCurrentDialog(normalizedDialog);
        }
        const archivedList = sr.querySelector('#archived-dialog-list');
        if (archivedList instanceof ArchivedDialogList) {
          archivedList.setCurrentDialog(normalizedDialog);
        }
      }

      this.resetReminderOperationCount();

      setTimeout(() => {
        if (
          this.currentDialog &&
          this.currentDialog.selfId === normalizedDialog.selfId &&
          this.currentDialog.rootId === normalizedDialog.rootId
        ) {
        }
      }, 100);

      this.updateToolbarDisplay();

      if (this.remindersWidgetVisible) {
        this.renderRemindersWidget();
        this.setupRemindersWidgetDrag();
      }

      if (options.syncAddressBar) {
        this.syncAddressBarToDialogDeepLink(normalizedDialog);
      }

      if (options.showLoadedToast) {
        const t = getUiStrings(this.uiLanguage);
        this.showSuccess(t.dialogLoadedToast);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load dialog: ${message}`, 'error');
    }
  }

  private async openVisibleDialog(dialog: DialogInfo): Promise<void> {
    const normalizedDialog = this.normalizeDialogSelectionTarget(dialog);
    if (!normalizedDialog) {
      this.showError('Invalid dialog identifiers: selfId and rootId are required', 'error');
      return;
    }
    // List selection is a business path over already-visible dialogs. If we cannot derive a
    // persisted status from visible state here, treat it as a UI/data-contract problem instead
    // of silently falling back to `running`.
    const status = this.lookupVisibleDialogStatus(normalizedDialog);
    if (status === null) {
      const t = getUiStrings(this.uiLanguage);
      this.showToast(t.dialogStatusUnavailableToast, 'warning');
      return;
    }
    await this.openDialogWithKnownStatus(normalizedDialog, status, {
      syncAddressBar: true,
      showLoadedToast: true,
    });
  }

  private async openDeepLinkedDialog(
    dialog: DialogInfo,
    status: PersistableDialogStatus,
  ): Promise<void> {
    const normalizedDialog = this.normalizeDialogSelectionTarget(dialog);
    if (!normalizedDialog) {
      this.showError('Invalid dialog identifiers: selfId and rootId are required', 'error');
      return;
    }
    const current = this.currentDialog;
    if (
      current &&
      current.rootId === normalizedDialog.rootId &&
      current.selfId === normalizedDialog.selfId
    ) {
      return;
    }
    await this.openDialogWithKnownStatus(normalizedDialog, status, {
      syncAddressBar: false,
      showLoadedToast: false,
    });
  }

  async selectDialog(dialog: DialogInfo): Promise<void> {
    await this.openVisibleDialog(dialog);
  }

  private async handleForkDialogRequest(detail: ForkDialogRequestDetail): Promise<void> {
    const rootId = detail.rootId.trim();
    const selfId = detail.selfId.trim();
    const course = Math.floor(detail.course);
    const genseq = Math.floor(detail.genseq);
    const status = detail.status;
    const t = getUiStrings(this.uiLanguage);

    if (rootId === '' || selfId === '' || rootId !== selfId || course <= 0 || genseq <= 0) {
      this.showToast(t.forkDialogFailedToast, 'warning');
      return;
    }

    const api = getApiClient();
    const response = await api.forkDialog(rootId, { course, genseq, status });
    const payload = response.data as ApiForkDialogResponse | undefined;
    if (!response.success || !payload?.success || !payload.dialog || !payload.action) {
      this.showToast(payload?.error || response.error || t.forkDialogFailedToast, 'warning');
      return;
    }

    const forkedDialog = payload.dialog;
    const forkedStatus = this.toPersistableStatus(forkedDialog.status) ?? status;
    await this.openDialogWithKnownStatus(forkedDialog, forkedStatus, {
      syncAddressBar: true,
      showLoadedToast: true,
    });

    const currentInput = this.q4hInput;
    if (!currentInput) {
      return;
    }

    if (payload.action.kind === 'draft_user_text') {
      currentInput.setValue(payload.action.userText);
      currentInput.focusInput();
      return;
    }

    if (payload.action.kind === 'restore_pending') {
      if (payload.action.pendingQ4H) {
        currentInput.focusInput();
      }
      return;
    }

    this.wsManager.sendRaw({
      type: 'resume_dialog',
      dialog: {
        selfId: forkedDialog.selfId,
        rootId: forkedDialog.rootId,
      },
    });
  }

  /**
   * Get the current dialog info (for E2E testing)
   * @returns Current dialog info or null if no dialog selected
   */
  public getCurrentDialogInfo(): DialogInfo | null {
    return this.currentDialog;
  }

  /**
   * Get the subdialog hierarchy from parent to current (for E2E testing)
   * @returns Array of dialog IDs in the hierarchy
   */
  public getSubdialogHierarchy(): Array<{ selfId: string; rootId: string; agentId: string }> {
    const hierarchy: Array<{ selfId: string; rootId: string; agentId: string }> = [];

    // Start from current dialog and build hierarchy
    let current = this.currentDialog;
    while (current) {
      const currentDialog = current;
      hierarchy.unshift({
        selfId: currentDialog.selfId || currentDialog.rootId,
        rootId: currentDialog.rootId,
        agentId: currentDialog.agentId,
      });

      // For subdialogs, we need to find parent from currently visible hierarchy.
      const currentDialogData = this.findDisplayedDialogByIds(
        currentDialog.rootId,
        currentDialog.selfId,
      );
      if (currentDialogData?.supdialogId) {
        // This is a subdialog, find the parent
        const parentDialog = this.findDisplayedDialogByIds(
          currentDialog.rootId,
          currentDialogData.supdialogId,
        );
        if (parentDialog) {
          current = {
            rootId: parentDialog.rootId,
            selfId: parentDialog.selfId || parentDialog.rootId,
            agentId: parentDialog.agentId,
            agentName: '',
            taskDocPath: parentDialog.taskDocPath || '',
          };
          continue;
        }
      }
      break;
    }

    return hierarchy;
  }

  /**
   * Navigate from a subdialog back to its parent (for E2E testing)
   * @returns Promise that resolves when navigation is complete
   */
  public async navigateToParent(): Promise<boolean> {
    const hierarchy = this.getSubdialogHierarchy();
    if (hierarchy.length <= 1) {
      // Already at root or no dialog selected
      return false;
    }

    // Navigate to the parent (second-to-last in hierarchy)
    const parentInfoRaw = hierarchy[hierarchy.length - 2];
    const parentInfo: DialogInfo = {
      selfId: parentInfoRaw.selfId,
      rootId: parentInfoRaw.rootId,
      agentId: parentInfoRaw.agentId,
      agentName: '',
      taskDocPath: '',
    };
    const parentStatus = this.requireCurrentDialogActionStatus();
    if (parentStatus === null) {
      return false;
    }
    await this.openDialogWithKnownStatus(parentInfo, parentStatus, {
      syncAddressBar: true,
      showLoadedToast: true,
    });
    return true;
  }

  /**
   * Open a subdialog by its root and self ID (for E2E testing)
   * @param rootId - The root (parent) dialog ID
   * @param subdialogId - The subdialog's self ID
   * @returns Promise that resolves when navigation is complete
   */
  public async openSubdialog(rootId: string, subdialogId: string): Promise<boolean> {
    let subdialog = this.findDisplayedDialogByIds(rootId, subdialogId);

    if (!subdialog) {
      await this.ensureSubdialogsLoaded(rootId);
      subdialog = this.findDisplayedDialogByIds(rootId, subdialogId);
    }

    if (!subdialog) {
      console.warn(`Subdialog not found: ${rootId}:${subdialogId}`);
      return false;
    }

    const subdialogStatus =
      this.toPersistableStatus(subdialog.status) ??
      this.toPersistableStatus(this.getRootDialog(rootId)?.status);
    if (subdialogStatus === null) {
      console.warn(`Subdialog status unavailable for selection: ${rootId}:${subdialogId}`);
      return false;
    }
    await this.openDialogWithKnownStatus(
      {
        rootId: subdialog.rootId,
        selfId: subdialog.selfId || subdialog.rootId,
        agentId: subdialog.agentId,
        agentName: '',
        taskDocPath: subdialog.taskDocPath || '',
        status: subdialogStatus,
      },
      subdialogStatus,
      {
        syncAddressBar: true,
        showLoadedToast: true,
      },
    );

    return true;
  }

  /**
   * Ensure subdialogs for a root dialog are loaded (for E2E testing + lazy loading).
   */
  public async ensureSubdialogsLoaded(rootId: string): Promise<boolean> {
    if (!rootId) return false;
    const rootDialog = this.getRootDialog(rootId);
    const expectedCount =
      typeof rootDialog?.subdialogCount === 'number' ? rootDialog.subdialogCount : 0;
    if (expectedCount === 0) return true;
    const alreadyLoaded = this.getVisibleSubdialogsForRoot(rootId).length > 0;
    if (alreadyLoaded) return true;
    const status = this.toPersistableStatus(rootDialog?.status);
    if (status === null) return false;
    await this.loadRootHierarchyForKnownStatus(rootId, status);
    return this.getVisibleSubdialogsForRoot(rootId).length > 0;
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    const previousStatus = this.connectionState.status;
    this.connectionState = state;
    this.updateConnectionStatus();

    // Update UI based on connection state
    if (state.status === 'connected') {
      this.wsConnectionOutageEligibleForHistory = false;
      this.wsConnectionErrorHistoryRecorded = false;
      this.wsManager.setUiLanguage(this.uiLanguage);

      // Fetch Q4H state from ALL running dialogs for global display
      // This ensures all pending Q4H questions are shown regardless of which dialog is selected
      this.wsManager.sendRaw({
        type: 'get_q4h_state',
      });

      if (previousStatus !== 'connected') {
        this.restoreCurrentDialogAfterReconnectInBackground();
      }
    } else {
      if (previousStatus === 'connected') {
        this.wsConnectionOutageEligibleForHistory = true;
        this.wsConnectionErrorHistoryRecorded = false;
      }

      if (state.status !== 'error') {
        return;
      }
      if (state.error === 'Unauthorized') {
        this.onAuthRejected('ws');
        return;
      }
      const persistHistory =
        this.wsConnectionOutageEligibleForHistory && !this.wsConnectionErrorHistoryRecorded;
      if (persistHistory) {
        this.wsConnectionErrorHistoryRecorded = true;
      }
      this.showError(state.error || 'Connection error', 'error', {
        history: persistHistory ? 'persist' : 'skip',
      });
    }
  }

  private async reopenCurrentDialogAfterReconnect(): Promise<void> {
    if (!this.currentDialog) {
      return;
    }
    const normalizedDialog = this.normalizeDialogSelectionTarget(this.currentDialog);
    if (!normalizedDialog) {
      return;
    }
    let status = this.getCurrentDialogActionStatus();
    if (status === null) {
      const resolved = await this.apiClient.resolveDialogStatus(
        normalizedDialog.rootId,
        normalizedDialog.selfId,
      );
      if (!resolved.success || !resolved.data) {
        if (resolved.status === 401 || resolved.status === 403) {
          this.onAuthRejected('api');
          return;
        }
        const t = getUiStrings(this.uiLanguage);
        if (resolved.status === 404) {
          this.removeUnavailableDialogLocally(normalizedDialog.rootId, normalizedDialog.selfId);
          this.showToast(
            `${t.dialogUnavailableRemovedPrefix} ${normalizedDialog.selfId}`,
            'warning',
          );
          return;
        }
        this.showToast(
          `${t.deepLinkDialogLoadFailedPrefix} ${normalizedDialog.selfId}: ${resolved.error || t.unknownError}`,
          'error',
        );
        return;
      }
      status = resolved.data.status;
    }
    this.currentDialogStatus = status;
    this.wsManager.sendRaw({
      type: 'display_dialog',
      dialog: {
        ...normalizedDialog,
        status,
      },
    });
  }

  private restoreCurrentDialogAfterReconnectInBackground(): void {
    // Connection lifecycle callbacks cannot await here, but reconnect restore still needs an
    // explicit terminal handler so failures stay loud and debuggable.
    void this.reopenCurrentDialogAfterReconnect().catch((error: unknown) => {
      const t = getUiStrings(this.uiLanguage);
      const message = error instanceof Error ? error.message : t.unknownError;
      console.error('Failed to restore current dialog after reconnect:', error);
      this.showError(message, 'warning');
    });
  }

  private updateConnectionStatus(): void {
    if (!this.shadowRoot) return;

    const statusEl = this.shadowRoot.querySelector('dominds-connection-status') as HTMLElement;
    if (statusEl) {
      statusEl.setAttribute('status', this.connectionState.status);
      if (this.connectionState.error) {
        statusEl.setAttribute('error', this.connectionState.error);
      } else {
        statusEl.removeAttribute('error');
      }
    }
  }

  private handleTeamMembers(): void {
    const teamMembersComponent = this.shadowRoot?.querySelector('#team-members') as HTMLElement & {
      show?: () => void;
    };

    if (teamMembersComponent && teamMembersComponent.show) {
      teamMembersComponent.show();
    } else {
      this.showWarning('No team members component available');
    }
  }

  private showError(
    message: string,
    type: 'error' | 'warning' | 'info' = 'error',
    options?: ToastOptions,
  ): void {
    console.error(`[${type.toUpperCase()}] ${message}`);
    this.showToast(message, type, options);
  }

  private showSuccess(message: string): void {
    // Success toasts are transient by default to keep notification history focused.
    this.showToast(message, 'info', { history: 'skip' });
  }

  private shouldPersistToastHistory(kind: ToastKind, options?: ToastOptions): boolean {
    const policy = options?.history ?? 'default';
    if (policy === 'persist') return true;
    if (policy === 'skip') return false;
    // Keep history focused on actionable items; informational toasts are transient by default.
    return kind === 'error' || kind === 'warning';
  }

  private showToast(message: string, kind: ToastKind = 'error', options?: ToastOptions): void {
    if (this.shouldPersistToastHistory(kind, options)) {
      this.pushToastHistoryEntry({ message, kind });
    }
    if (!this.shadowRoot) return;
    const toast = document.createElement('div');
    const bg =
      kind === 'error'
        ? 'var(--dominds-danger-bg, #f8d7da)'
        : kind === 'warning'
          ? 'var(--dominds-warning-bg, #fff3cd)'
          : 'var(--dominds-info-bg, #cce7ff)';
    const color =
      kind === 'error'
        ? 'var(--dominds-danger, #721c24)'
        : kind === 'warning'
          ? 'var(--dominds-warning, #856404)'
          : 'var(--dominds-fg, #333333)';
    const border =
      kind === 'error'
        ? 'var(--dominds-danger-border, #f5c6cb)'
        : kind === 'warning'
          ? 'var(--dominds-warning-border, #ffeaa7)'
          : 'var(--dominds-border, #e0e0e0)';
    const box = document.createElement('div');
    box.style.cssText = `position: fixed; top: 18px; right: 18px; padding: 8px 12px; border-radius: 8px; background: ${bg}; background: color-mix(in srgb, ${bg} var(--dominds-alpha-toast-bg, 80%), transparent); color: ${color}; box-shadow: 0 4px 12px rgba(0,0,0,0.2); border: 1px solid ${border}; z-index: var(--dominds-z-overlay-toast, 1300); font-size: var(--dominds-font-size-sm, 12px); display:flex; align-items:center; gap:8px; animation: slideDown 0.2s ease-out;`;
    const iconSpan = document.createElement('span');
    iconSpan.className = `icon-mask ${this.getToastIconClass(kind)}`;
    iconSpan.setAttribute('aria-hidden', 'true');
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    box.appendChild(iconSpan);
    box.appendChild(msgSpan);
    const style = document.createElement('style');
    style.textContent =
      '@keyframes slideDown { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
    toast.appendChild(box);
    toast.appendChild(style);
    this.shadowRoot.appendChild(toast);
    toast.addEventListener('click', (e) => {
      e.preventDefault();
      this.setToastHistoryOpen(true);
    });
    setTimeout(() => toast.remove(), 2500);
  }

  private loadToastHistoryFromStorage(): void {
    try {
      const raw = localStorage.getItem(DomindsApp.TOAST_HISTORY_STORAGE_KEY);
      if (!raw) {
        this.toastHistory = [];
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const fromStorage = this.parseToastHistoryArray(parsed);
      this.toastHistory = fromStorage.slice(-DomindsApp.TOAST_HISTORY_MAX);
    } catch (error: unknown) {
      console.warn('Failed to load toast history from localStorage', error);
      this.toastHistory = [];
    }
  }

  private parseToastHistoryArray(value: unknown): ToastHistoryEntry[] {
    if (!Array.isArray(value)) return [];
    const next: ToastHistoryEntry[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' ? rec['id'] : '';
      const timestamp = typeof rec['timestamp'] === 'string' ? rec['timestamp'].trim() : '';
      const kind = rec['kind'];
      const message = typeof rec['message'] === 'string' ? rec['message'] : '';
      if (!id || !DomindsApp.UNIFIED_TIMESTAMP_PATTERN.test(timestamp) || !message) continue;
      if (kind !== 'error' && kind !== 'warning' && kind !== 'info') continue;
      next.push({ id, timestamp, kind, message });
    }
    return next;
  }

  private persistToastHistoryToStorage(): void {
    try {
      localStorage.setItem(
        DomindsApp.TOAST_HISTORY_STORAGE_KEY,
        JSON.stringify(this.toastHistory.slice(-DomindsApp.TOAST_HISTORY_MAX)),
      );
    } catch (error: unknown) {
      console.warn('Failed to persist toast history to localStorage', error);
    }
  }

  private pushToastHistoryEntry(entry: { message: string; kind: ToastKind }): void {
    // Always treat localStorage as the source of truth.
    // This prevents stale in-mem state from overwriting entries written by another tab/instance.
    this.loadToastHistoryFromStorage();

    const now = new Date();
    const id = `${String(now.getTime())}-${String((this.toastHistorySeq += 1))}`;
    const trimmed = entry.message.trim();
    if (trimmed === '') return;

    const next: ToastHistoryEntry = {
      id,
      timestamp: formatUnifiedTimestamp(now),
      kind: entry.kind,
      message: trimmed,
    };
    this.toastHistory = [...this.toastHistory.slice(-DomindsApp.TOAST_HISTORY_MAX + 1), next];
    this.persistToastHistoryToStorage();
    this.updateToastHistoryUi();
  }

  private clearToastHistory(): void {
    this.toastHistory = [];
    this.persistToastHistoryToStorage();
    this.updateToastHistoryUi();
  }

  private setToastHistoryOpen(open: boolean): void {
    if (open) {
      // Re-sync on open: the list is always rendered from localStorage.
      this.loadToastHistoryFromStorage();
    }

    if (this.toastHistoryOpen === open) {
      // Even if state is unchanged, refresh list content (e.g. storage events / late toasts).
      this.updateToastHistoryUi();
      return;
    }

    this.toastHistoryOpen = open;
    this.updateToastHistoryUi();
  }

  private updateToastHistoryUi(): void {
    // Always render list from the latest persisted snapshot.
    this.loadToastHistoryFromStorage();
    const sr = this.shadowRoot;
    if (!sr) return;
    const modal = sr.querySelector('#toast-history-modal') as HTMLElement | null;
    if (modal) modal.classList.toggle('hidden', !this.toastHistoryOpen);
    const list = sr.querySelector('#toast-history-list') as HTMLElement | null;
    if (list) list.innerHTML = this.renderToastHistoryListHtml();
  }

  private renderToastHistoryListHtml(): string {
    const t = getUiStrings(this.uiLanguage);
    if (this.toastHistory.length === 0) {
      return `<div class="toast-history-empty">${this.escapeHtml(t.toastHistoryEmpty)}</div>`;
    }
    const items = this.toastHistory
      .slice()
      .reverse()
      .map((entry) => {
        const iconClass = this.getToastIconClass(entry.kind);
        return `
          <div class="toast-history-item" data-kind="${entry.kind}">
            <div class="toast-history-icon"><span class="icon-mask ${iconClass}" aria-hidden="true"></span></div>
            <div class="toast-history-body">
              <div class="toast-history-message">${this.escapeHtml(entry.message)}</div>
              <div class="toast-history-meta">${this.escapeHtml(entry.timestamp)}</div>
            </div>
          </div>
        `;
      })
      .join('');
    return items;
  }

  private showWarning(message: string): void {
    this.showError(message, 'warning');
  }

  private showInfo(message: string): void {
    this.showError(message, 'info');
  }

  private getExplicitThemeFromDom(): 'light' | 'dark' | null {
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'light' || theme === 'dark') {
      return theme;
    }
    return null;
  }

  private getStoredTheme(): 'light' | 'dark' | null {
    try {
      const stored = localStorage.getItem('dominds-theme');
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch (error: unknown) {
      console.warn('Failed to read theme preference from localStorage', error);
      return null;
    }
    return null;
  }

  private getSystemTheme(): 'light' | 'dark' {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private getCurrentTheme(): 'light' | 'dark' {
    const explicitTheme = this.getExplicitThemeFromDom();
    if (explicitTheme) {
      return explicitTheme;
    }

    const storedTheme = this.getStoredTheme();
    if (storedTheme) {
      return storedTheme;
    }

    return this.getSystemTheme();
  }

  private initializeTheme(): void {
    const explicitTheme = this.getExplicitThemeFromDom();
    if (explicitTheme) {
      this.currentTheme = explicitTheme;
      return;
    }

    const storedTheme = this.getStoredTheme();
    if (storedTheme) {
      document.documentElement.setAttribute('data-theme', storedTheme);
      this.currentTheme = storedTheme;
      return;
    }

    document.documentElement.removeAttribute('data-theme');
    this.currentTheme = this.getSystemTheme();
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    this.currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);

    try {
      localStorage.setItem('dominds-theme', theme);
    } catch (error: unknown) {
      console.warn('Failed to persist theme preference to localStorage', error);
    }

    this.updateThemeToggle();
  }

  private toggleTheme(): void {
    const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    this.applyTheme(newTheme);
  }

  private renderThemeToggleIcon(): string {
    const iconClass =
      this.currentTheme === 'light' ? 'app-icon-theme-dark' : 'app-icon-theme-light';
    return `<span class="icon-mask ${iconClass}" aria-hidden="true"></span>`;
  }

  private getToastIconClass(
    kind: ToastKind,
  ): 'app-icon-error' | 'app-icon-warning' | 'app-icon-info' {
    if (kind === 'error') return 'app-icon-error';
    if (kind === 'warning') return 'app-icon-warning';
    return 'app-icon-info';
  }

  private updateThemeToggle(): void {
    if (!this.shadowRoot) return;

    const themeToggle = this.shadowRoot.querySelector('#theme-toggle-btn') as HTMLElement;
    if (themeToggle) {
      const t = getUiStrings(this.uiLanguage);
      themeToggle.innerHTML = this.renderThemeToggleIcon();
      themeToggle.setAttribute('title', t.themeToggleTitle);
      themeToggle.setAttribute('aria-label', t.themeToggleTitle);
    }
  }

  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  private getProblemsTopSeverity(): 'info' | 'warning' | 'error' {
    let sawWarning = false;
    for (const p of this.problems) {
      if (p.severity === 'error') {
        return 'error';
      }
      if (p.severity === 'warning') {
        sawWarning = true;
      }
    }
    return sawWarning ? 'warning' : 'info';
  }

  private getProblemDetailLabel(key: string): string {
    const zh = this.uiLanguage === 'zh';
    switch (key) {
      case 'filePath':
        return zh ? '文件' : 'File';
      case 'errorText':
        return zh ? '详情' : 'Details';
      case 'text':
        return zh ? '详情' : 'Details';
      case 'serverId':
        return zh ? '服务' : 'Server';
      case 'toolName':
        return zh ? '工具' : 'Tool';
      case 'domindsToolName':
        return zh ? '冲突工具' : 'Conflicts With';
      case 'pattern':
        return zh ? '模式' : 'Pattern';
      case 'rule':
        return zh ? '规则' : 'Rule';
      case 'dialogId':
        return zh ? '对话' : 'Dialog';
      case 'provider':
        return zh ? 'Provider' : 'Provider';
      default:
        return key;
    }
  }

  private selectProblemMessage(problem: WorkspaceProblemRecord): string {
    return problem.messageI18n?.[this.uiLanguage] ?? problem.message;
  }

  private selectProblemDetailText(problem: WorkspaceProblemRecord, fallback: string): string {
    return problem.detailTextI18n?.[this.uiLanguage] ?? fallback;
  }

  private renderProblemDetailValue(value: unknown): string {
    if (typeof value === 'string') return this.escapeHtml(value);
    if (typeof value === 'number' || typeof value === 'boolean') {
      return this.escapeHtml(String(value));
    }
    if (value === null) return this.escapeHtml('null');
    return this.escapeHtml(JSON.stringify(value, null, 2));
  }

  private renderProblemDetailHtml(problem: WorkspaceProblemRecord): string {
    const detail = problem.detail;
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
      return `<div class="problem-detail">${this.escapeHtml(JSON.stringify(detail, null, 2))}</div>`;
    }

    const record = detail as Record<string, unknown>;
    const blocks: string[] = [];
    const preferredOrder = [
      'filePath',
      'serverId',
      'toolName',
      'domindsToolName',
      'pattern',
      'rule',
      'dialogId',
      'provider',
      'errorText',
      'text',
    ];
    const emitted = new Set<string>();

    const renderField = (key: string, value: unknown): void => {
      emitted.add(key);
      if (value === undefined) return;
      const label = this.escapeHtml(this.getProblemDetailLabel(key));
      const isBlock = key === 'errorText' || key === 'text';
      const isCode =
        key === 'filePath' ||
        key === 'serverId' ||
        key === 'toolName' ||
        key === 'domindsToolName' ||
        key === 'pattern' ||
        key === 'rule' ||
        key === 'dialogId' ||
        key === 'provider';
      const displayValue =
        typeof value === 'string' && (key === 'errorText' || key === 'text')
          ? this.selectProblemDetailText(problem, value)
          : value;
      const valueHtml = this.renderProblemDetailValue(displayValue);
      if (isBlock) {
        blocks.push(
          `<div class="problem-detail-block"><div class="problem-detail-label">${label}</div><div class="problem-detail-value">${valueHtml}</div></div>`,
        );
        return;
      }
      blocks.push(
        `<div class="problem-detail-row"><span class="problem-detail-label">${label}</span><span class="problem-detail-value${isCode ? ' code' : ''}">${valueHtml}</span></div>`,
      );
    };

    for (const key of preferredOrder) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        renderField(key, record[key]);
      }
    }

    const remainingKeys = Object.keys(record)
      .filter((key) => !emitted.has(key))
      .sort();
    for (const key of remainingKeys) {
      renderField(key, record[key]);
    }

    if (blocks.length === 0) {
      return `<div class="problem-detail">${this.escapeHtml(JSON.stringify(detail, null, 2))}</div>`;
    }

    return `<div class="problem-detail"><div class="problem-detail-list">${blocks.join('')}</div></div>`;
  }

  private renderProblemsListHtml(): string {
    const t = getUiStrings(this.uiLanguage);
    if (this.problems.length === 0) {
      return `<div class="problem-meta">${this.escapeHtml(t.problemsEmpty)}</div>`;
    }
    const items = this.problems
      .slice()
      .sort((a, b) => {
        const activeA = a.resolved === true ? 0 : 1;
        const activeB = b.resolved === true ? 0 : 1;
        if (activeA !== activeB) return activeB - activeA;
        const sa = a.severity === 'error' ? 3 : a.severity === 'warning' ? 2 : 1;
        const sb = b.severity === 'error' ? 3 : b.severity === 'warning' ? 2 : 1;
        if (sa !== sb) return sb - sa;
        return b.timestamp.localeCompare(a.timestamp);
      })
      .map((p) => {
        const lifecycleLabel =
          p.resolved === true ? t.problemsResolvedBadge : t.problemsActiveBadge;
        const occurredAt =
          typeof p.occurredAt === 'string' && p.occurredAt.trim() !== ''
            ? p.occurredAt
            : p.timestamp;
        const resolvedAt =
          p.resolved === true && typeof p.resolvedAt === 'string' && p.resolvedAt.trim() !== ''
            ? p.resolvedAt
            : null;
        const lifecycleMeta =
          p.resolved === true && resolvedAt ? `${occurredAt} → ${resolvedAt}` : occurredAt;
        const message = this.selectProblemMessage(p);
        return `
          <div class="problem-item" data-severity="${p.severity}" data-resolved="${p.resolved === true ? 'true' : 'false'}">
            <div class="problem-head">
              <div class="problem-message">${this.escapeHtml(message)}</div>
              <div class="problem-meta problem-timestamp">${this.escapeHtml(lifecycleMeta)}</div>
            </div>
            <div class="problem-meta problem-lifecycle">${this.escapeHtml(lifecycleLabel)}</div>
            ${this.renderProblemDetailHtml(p)}
          </div>
        `;
      })
      .join('');
    return items;
  }

  private updateProblemsUi(): void {
    const sr = this.shadowRoot;
    if (!sr) return;
    const btn = sr.querySelector('#header-problems-toggle') as HTMLButtonElement | null;
    if (btn) {
      btn.setAttribute('data-severity', this.getProblemsTopSeverity());
      btn.setAttribute('data-has-problems', this.problems.length > 0 ? 'true' : 'false');
      const count = btn.querySelector('.problems-count');
      if (count) {
        count.textContent = String(this.problems.length);
      }
    }

    const panel = sr.querySelector('#problems-panel') as HTMLElement | null;
    if (panel) {
      panel.classList.toggle('hidden', !this.problemsPanelOpen);
    }
    const list = sr.querySelector('#problems-list') as HTMLElement | null;
    if (list) {
      list.innerHTML = this.renderProblemsListHtml();
      list.classList.toggle('empty', this.problems.length === 0);
    }
  }

  private renderToolsWidgetListHtml(): string {
    const t = getUiStrings(this.uiLanguage);
    const loadingHtml = this.toolsWidgetLoading
      ? `<div class="tools-widget-status">${this.escapeHtml(t.loading)}</div>`
      : '';
    const errorHtml = this.toolsWidgetError
      ? `<div class="tools-widget-status tools-widget-status-error">${this.escapeHtml(this.toolsWidgetError)}</div>`
      : '';
    const warningHtml = this.toolsWidgetWarnings
      .map(
        (warning) =>
          `<div class="tools-widget-status tools-widget-status-warning">${this.escapeHtml(t.toolsStatusWarningPrefix)} ${this.escapeHtml(warning)}</div>`,
      )
      .join('');
    if (
      this.toolsWidgetError &&
      this.toolsWidgetToolsets.length === 0 &&
      this.toolsWidgetDirectTools.length === 0
    ) {
      return `${errorHtml}${warningHtml}`;
    }
    if (
      this.toolsWidgetLoading &&
      this.toolsWidgetToolsets.length === 0 &&
      this.toolsWidgetDirectTools.length === 0
    ) {
      return `${loadingHtml}${warningHtml}`;
    }
    if (this.toolsWidgetToolsets.length === 0 && this.toolsWidgetDirectTools.length === 0) {
      return `${warningHtml}<div class="tools-empty">${this.escapeHtml(t.toolsEmpty)}</div>`;
    }

    const directTools = this.toolsWidgetDirectTools;
    const toolsets = this.toolsWidgetToolsets;

    const renderDirectToolSectionHtml = (
      sectionTitle: string,
      tools: readonly ToolInfo[],
      kindLabel: string,
    ): string => {
      const toolsHtml =
        tools.length === 0
          ? `<div class="tools-empty">${this.escapeHtml(t.toolsEmpty)}</div>`
          : tools
              .map((tool) => {
                const toolDesc = tool.descriptionI18n
                  ? tool.descriptionI18n[this.uiLanguage]
                  : (tool.description ?? '');
                const desc = toolDesc ? this.escapeHtml(toolDesc) : '';
                return `<div class="tool-item" data-kind="${this.escapeHtml(tool.kind)}">
                  <div class="tool-main">
                    <span class="tool-kind">${this.escapeHtml(kindLabel)}</span>
                    <span class="tool-name">${this.escapeHtml(tool.name)}</span>
                  </div>
                  ${desc ? `<div class="tool-desc">${desc}</div>` : ''}
                </div>`;
              })
              .join('');
      return `<details class="tools-section" open>
        <summary class="tools-section-title">${this.escapeHtml(sectionTitle)}</summary>
        <div class="tools-section-toolsets">${toolsHtml}</div>
      </details>`;
    };

    const renderToolsetHtml = (
      ts: ToolsetInfo,
      tools: ToolsetInfo['tools'],
      kindLabel: string,
    ): string => {
      const title = `${ts.name} (${tools.length})`;
      const toolsetDesc = ts.descriptionI18n ? ts.descriptionI18n[this.uiLanguage] : '';
      const toolsHtml =
        tools.length === 0
          ? `<div class="tools-empty">${this.escapeHtml(t.toolsEmpty)}</div>`
          : tools
              .map((tool) => {
                const toolDesc = tool.descriptionI18n
                  ? tool.descriptionI18n[this.uiLanguage]
                  : (tool.description ?? '');
                const desc = toolDesc ? this.escapeHtml(toolDesc) : '';
                return `<div class="tool-item" data-kind="${this.escapeHtml(tool.kind)}">
                  <div class="tool-main">
                    <span class="tool-kind">${this.escapeHtml(kindLabel)}</span>
                    <span class="tool-name">${this.escapeHtml(tool.name)}</span>
                  </div>
                  ${desc ? `<div class="tool-desc">${desc}</div>` : ''}
                </div>`;
              })
              .join('');

      const toolsetDescAttr = toolsetDesc ? ` data-desc="${this.escapeHtml(toolsetDesc)}"` : '';
      return `<details class="toolset">
        <summary class="toolset-title"${toolsetDescAttr}>${this.escapeHtml(title)}</summary>
        <div class="toolset-tools">${toolsHtml}</div>
      </details>`;
    };

    const renderSectionHtml = (
      sectionTitle: string,
      kindLabel: string,
      filteredToolsets: ToolsetInfo[],
    ): string => {
      const sectionToolsetsHtml = filteredToolsets
        .map((ts) => {
          if (ts.tools.length === 0) return '';
          return renderToolsetHtml(ts, ts.tools, kindLabel);
        })
        .join('');

      const body =
        sectionToolsetsHtml.trim().length === 0
          ? `<div class="tools-empty">${this.escapeHtml(t.toolsEmpty)}</div>`
          : sectionToolsetsHtml;

      return `<details class="tools-section" open>
        <summary class="tools-section-title">${this.escapeHtml(sectionTitle)}</summary>
        <div class="tools-section-toolsets">${body}</div>
      </details>`;
    };

    const domindsToolsets = toolsets.filter((ts) => ts.source === 'dominds');
    const appToolsets = toolsets.filter((ts) => ts.source === 'app');
    const mcpToolsets = toolsets.filter((ts) => ts.source === 'mcp');

    const directSection = renderDirectToolSectionHtml(t.toolsGroupDirect, directTools, 'ƒ');
    const domindsSection = renderSectionHtml(t.toolsGroupDominds, 'ƒ', domindsToolsets);
    const appsSection = renderSectionHtml(t.toolsGroupApps, 'ƒ', appToolsets);
    const mcpSection = renderSectionHtml(t.toolsGroupMcp, 'ƒ', mcpToolsets);

    return `${loadingHtml}${errorHtml}${warningHtml}${directSection}${domindsSection}${appsSection}${mcpSection}`;
  }

  private initializeToolsWidgetGeometry(): void {
    const toggle = this.shadowRoot?.querySelector('#navibar-tools-toggle') as HTMLElement | null;
    const marginPx = 12;
    const defaultLeft = Math.max(marginPx, window.innerWidth - this.toolsWidgetWidthPx - marginPx);
    const defaultTop = 56;
    const toggleRect = toggle?.getBoundingClientRect();
    const rawLeft = toggleRect
      ? Math.floor(toggleRect.right - this.toolsWidgetWidthPx)
      : defaultLeft;
    const maxLeft = Math.max(marginPx, window.innerWidth - this.toolsWidgetWidthPx - marginPx);
    const maxTop = Math.max(marginPx, window.innerHeight - this.toolsWidgetHeightPx - marginPx);
    const top = toggleRect ? Math.floor(toggleRect.bottom + 8) : defaultTop;

    this.toolsWidgetX = Math.max(marginPx, Math.min(maxLeft, rawLeft));
    this.toolsWidgetY = Math.max(marginPx, Math.min(maxTop, top));
    this.toolsWidgetGeometryInitialized = true;
  }

  private ensureToolsWidget(): HTMLElement | null {
    const sr = this.shadowRoot;
    if (!sr) return null;
    let widget = sr.querySelector('#tools-widget') as HTMLElement | null;
    if (!this.toolsWidgetVisible) {
      if (widget) widget.remove();
      return null;
    }
    if (!widget) {
      const t = getUiStrings(this.uiLanguage);
      widget = document.createElement('div');
      widget.id = 'tools-widget';
      widget.setAttribute('role', 'dialog');
      widget.innerHTML = `
        <div id="tools-widget-header" class="tools-widget-header">
          <div class="tools-widget-header-main">
            <span class="icon-mask app-icon-tools app-icon-16" aria-hidden="true"></span>
            <span id="tools-widget-title"></span>
          </div>
          <span id="tools-widget-timestamp" class="tools-widget-timestamp"></span>
          <div class="tools-widget-actions">
            <button type="button" id="tools-widget-refresh" class="icon-button" aria-label="${this.escapeHtml(t.toolsRefresh)}">
              <span class="icon-mask app-icon-refresh" aria-hidden="true"></span>
            </button>
            <button type="button" id="tools-widget-close" class="icon-button" aria-label="${this.escapeHtml(t.close)}">
              <span class="icon-mask app-icon-close" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <div id="tools-widget-content" class="tools-widget-content"></div>
        <div id="tools-widget-resize-handle" aria-hidden="true">
          <span class="icon-mask app-icon-resize-corner-bottom-left" aria-hidden="true"></span>
        </div>
      `;
      sr.appendChild(widget);
    }
    this.applyToolsWidgetGeometryStyle(widget);
    return widget;
  }

  private updateToolsWidgetUi(): void {
    const sr = this.shadowRoot;
    if (!sr) return;

    const toggle = sr.querySelector('#navibar-tools-toggle') as HTMLButtonElement | null;
    if (toggle) {
      toggle.setAttribute('aria-pressed', this.toolsWidgetVisible ? 'true' : 'false');
    }

    const widget = this.ensureToolsWidget();
    if (!widget) return;

    const t = getUiStrings(this.uiLanguage);
    widget.setAttribute('aria-label', t.toolsTitle);

    const title = widget.querySelector('#tools-widget-title') as HTMLElement | null;
    if (title) title.textContent = t.toolsTitle;

    const timestamp = widget.querySelector('#tools-widget-timestamp') as HTMLElement | null;
    if (timestamp) {
      timestamp.textContent = this.toolsWidgetTimestamp;
    }

    const refresh = widget.querySelector('#tools-widget-refresh') as HTMLButtonElement | null;
    if (refresh) {
      refresh.disabled = this.toolsWidgetLoading;
      refresh.title = t.toolsRefresh;
      refresh.setAttribute('aria-label', t.toolsRefresh);
    }

    const close = widget.querySelector('#tools-widget-close') as HTMLButtonElement | null;
    if (close) {
      close.title = t.close;
      close.setAttribute('aria-label', t.close);
    }

    const content = widget.querySelector('#tools-widget-content') as HTMLElement | null;
    if (content) {
      content.innerHTML = this.renderToolsWidgetListHtml();
    }

    this.applyToolsWidgetGeometryStyle(widget);
    this.setupToolsWidgetDrag();
  }

  private closeToolsWidget(): void {
    this.toolsWidgetVisible = false;
    const widget = this.shadowRoot?.querySelector('#tools-widget') as HTMLElement | null;
    if (widget) widget.remove();
    this.updateToolsWidgetUi();
  }

  private toggleToolsWidget(): void {
    if (!this.currentDialog) {
      return;
    }
    this.toolsWidgetVisible = !this.toolsWidgetVisible;
    if (!this.toolsWidgetVisible) {
      this.closeToolsWidget();
      return;
    }
    if (!this.toolsWidgetGeometryInitialized) {
      this.initializeToolsWidgetGeometry();
    }
    this.updateToolsWidgetUi();
    void this.loadToolsWidget();
  }

  private refreshToolsWidget(): void {
    if (!this.currentDialog) {
      return;
    }
    void this.loadToolsWidget();
  }

  private closeRemindersWidget(): void {
    this.remindersWidgetVisible = false;
    this.cleanupAllReminderProgressiveExpands();
    const widget = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    if (widget) widget.remove();
    this.updateToolbarDisplay();
  }

  private getToolsWidgetRequestOptions(): ToolsWidgetRequestOptions {
    const currentDialog = this.currentDialog;
    if (!currentDialog) {
      return {};
    }

    const rootDialog = this.getRootDialog(currentDialog.rootId) ?? undefined;
    const agentId =
      typeof currentDialog.agentId === 'string' && currentDialog.agentId.trim() !== ''
        ? currentDialog.agentId.trim()
        : typeof rootDialog?.agentId === 'string' && rootDialog.agentId.trim() !== ''
          ? rootDialog.agentId.trim()
          : undefined;
    const taskDocPath =
      typeof currentDialog.taskDocPath === 'string' && currentDialog.taskDocPath.trim() !== ''
        ? currentDialog.taskDocPath.trim()
        : typeof rootDialog?.taskDocPath === 'string' && rootDialog.taskDocPath.trim() !== ''
          ? rootDialog.taskDocPath.trim()
          : undefined;
    const status =
      this.currentDialogStatus ??
      this.lookupVisibleDialogStatus(currentDialog) ??
      this.toPersistableStatus(rootDialog?.status) ??
      undefined;

    return {
      agentId,
      taskDocPath,
      rootId: currentDialog.rootId,
      selfId: currentDialog.selfId,
      sessionSlug:
        typeof currentDialog.sessionSlug === 'string' && currentDialog.sessionSlug.trim() !== ''
          ? currentDialog.sessionSlug.trim()
          : undefined,
      status,
    };
  }

  private getToolsWidgetContextKey(options: ToolsWidgetRequestOptions): string | null {
    if (
      typeof options.rootId !== 'string' ||
      options.rootId.trim() === '' ||
      typeof options.selfId !== 'string' ||
      options.selfId.trim() === ''
    ) {
      return null;
    }
    const status =
      options.status === 'running' ||
      options.status === 'completed' ||
      options.status === 'archived'
        ? options.status
        : 'unknown';
    return `${options.rootId.trim()}::${options.selfId.trim()}::${status}`;
  }

  private applyToolsWidgetSnapshot(snapshot: ToolsWidgetSnapshot | null): void {
    if (!snapshot) {
      this.toolsWidgetDirectTools = [];
      this.toolsWidgetToolsets = [];
      this.toolsWidgetWarnings = [];
      this.toolsWidgetTimestamp = '';
      return;
    }
    this.toolsWidgetDirectTools = snapshot.directTools;
    this.toolsWidgetToolsets = snapshot.toolsets;
    this.toolsWidgetWarnings = snapshot.warnings;
    this.toolsWidgetTimestamp = snapshot.timestamp;
  }

  private async loadToolsWidget(): Promise<void> {
    const requestSeq = ++this.toolsWidgetRequestSeq;
    const requestOptions = this.getToolsWidgetRequestOptions();
    const previousContextKey = this.toolsWidgetContextKey;
    const contextKey = this.getToolsWidgetContextKey(requestOptions);
    this.toolsWidgetContextKey = contextKey;
    if (contextKey !== previousContextKey) {
      this.applyToolsWidgetSnapshot(null);
    }

    this.toolsWidgetLoading = true;
    this.toolsWidgetError = null;
    this.updateToolsWidgetUi();

    const res = await this.apiClient.getToolAvailability(requestOptions);
    if (requestSeq !== this.toolsWidgetRequestSeq) {
      return;
    }

    this.toolsWidgetLoading = false;
    if (!res.success || !res.data) {
      const t = getUiStrings(this.uiLanguage);
      const message = res.error || t.unknownError;
      this.toolsWidgetError = message;
      this.updateToolsWidgetUi();
      this.showToast(message, 'warning');
      return;
    }

    const nextSnapshot: ToolsWidgetSnapshot = {
      directTools: [...res.data.composition.visibleDirectTools],
      toolsets: [...res.data.composition.visibleToolsets],
      warnings: [
        ...(res.data.layers.memberBinding.status === 'error' &&
        typeof res.data.layers.memberBinding.errorText === 'string' &&
        res.data.layers.memberBinding.errorText.trim() !== ''
          ? [res.data.layers.memberBinding.errorText.trim()]
          : []),
        ...(res.data.layers.appDynamicAvailability.status === 'error' &&
        typeof res.data.layers.appDynamicAvailability.errorText === 'string' &&
        res.data.layers.appDynamicAvailability.errorText.trim() !== ''
          ? [res.data.layers.appDynamicAvailability.errorText.trim()]
          : []),
        ...(res.data.layers.runtimeLease.status === 'error' &&
        typeof res.data.layers.runtimeLease.errorText === 'string' &&
        res.data.layers.runtimeLease.errorText.trim() !== ''
          ? [res.data.layers.runtimeLease.errorText.trim()]
          : []),
      ],
      timestamp: res.data.timestamp,
    };
    this.applyToolsWidgetSnapshot(nextSnapshot);
    this.toolsWidgetError = null;
    this.updateToolsWidgetUi();
  }

  private setupWebSocketEventHandlers(): void {
    // Cancel any previous subscription to prevent duplicate event processing
    if (this._wsEventCancel) {
      this._wsEventCancel();
      this._wsEventCancel = undefined;
    }

    const backendEvts = this.wsManager.subscribeToBackendEvents();
    this._wsEventCancel = backendEvts.cancel;

    (async () => {
      let messageCount = 0;
      for await (const message of backendEvts.stream()) {
        messageCount++;
        if (!this.handleGlobalWebSocketEvent(message)) {
          await this.handleDialogWebSocketEvent(message);
        }
      }
    })();
  }

  private handleGlobalWebSocketEvent(
    message: WelcomeMessage | ErrorMessage | WebSocketMessage,
  ): boolean {
    // Handle global events that don't need dialog filtering using discriminated unions
    switch (message.type) {
      case 'welcome': {
        this.serverWorkLanguage = message.serverWorkLanguage;
        const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
        if (dialogContainer instanceof DomindsDialogContainer) {
          dialogContainer.setServerWorkLanguage(message.serverWorkLanguage);
        }
        this.applyDomindsRuntimeStatus(message.runtimeStatus);
        this.applyUiLanguageToDom();
        return true;
      }
      case 'dominds_runtime_status': {
        this.applyDomindsRuntimeStatus(message.runtimeStatus);
        return true;
      }
      case 'ui_language_set': {
        return true;
      }
      case 'problems_snapshot': {
        const snap = message as ProblemsSnapshotMessage;
        this.problemsVersion = snap.version;
        this.problems = snap.problems;
        this.updateProblemsUi();
        return true;
      }
      case 'clear_resolved_problems_result': {
        const result = message as ClearResolvedProblemsResultMessage;
        const t = getUiStrings(this.uiLanguage);
        this.showToast(
          `${t.problemsClearResolvedDonePrefix}${String(result.removedCount)}`,
          'info',
        );
        this.wsManager.sendRaw({ type: 'get_problems' });
        return true;
      }
      case 'team_config_updated': {
        void this.loadTeamMembers({ silent: true });
        const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
        if (
          dialogContainer instanceof DomindsDialogContainer &&
          typeof dialogContainer.refreshTeamConfiguration === 'function'
        ) {
          void dialogContainer.refreshTeamConfiguration();
        }
        return true;
      }
      case 'tool_availability_updated': {
        if (this.toolsWidgetVisible) {
          this.refreshToolsWidget();
        }
        return true;
      }
      case 'error': {
        console.error('Server error:', message.message);
        if (message.code === 'resume_dialog_not_eligible') {
          this.annotateStoppedPanelAfterResumeRejected({
            detailMessage: message.message,
            reason: message.resumeNotEligibleReason,
          });
          this.showToast(getUiStrings(this.uiLanguage).resumeDialogNotResumableToast, 'warning');
          return true;
        }
        if (message.code === 'resume_all_not_eligible') {
          this.showToast(getUiStrings(this.uiLanguage).resumeAllNoResumableToast, 'warning');
          return true;
        }
        this.showToast(message.message, 'error');
        return true;
      }
      case 'dialog_ready': {
        const readyMsg: DialogReadyMessage = message;
        const nextDiligenceState = this.resolveDiligenceStateFromReady(readyMsg);
        const current = this.currentDialog;
        const isForCurrentDialog =
          current !== null &&
          current.selfId === readyMsg.dialog.selfId &&
          current.rootId === readyMsg.dialog.rootId;
        if (!isForCurrentDialog) {
          // Ignore stale/out-of-band ready events from older display requests.
          return true;
        }

        // Update currentDialog with the ready dialog's ID (from both create and display)
        const nextDialog: DialogInfo = {
          selfId: readyMsg.dialog.selfId,
          rootId: readyMsg.dialog.rootId,
          agentId: readyMsg.agentId,
          agentName: readyMsg.agentId, // agentId serves as the name for display
          taskDocPath: readyMsg.taskDocPath,
          supdialogId: readyMsg.supdialogId,
          sessionSlug: readyMsg.sessionSlug,
          assignmentFromSup: readyMsg.assignmentFromSup,
        };
        this.currentDialog = nextDialog;

        this.applyDiligenceState(nextDiligenceState);
        this.diligenceRtwsDirty = false;
        this.updateBottomPanelFooterUi();

        const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
        if (dialogContainer instanceof DomindsDialogContainer) {
          dialogContainer.updateDialogContext(this.currentDialog);
        }
        // Update q4h-input with the active dialog ID
        if (this.q4hInput && typeof this.q4hInput.setDialog === 'function') {
          this.q4hInput.setDialog(nextDialog);
        }

        // Update docs panel language
        const docsPanel = this.shadowRoot?.querySelector('#docs-panel');
        if (docsPanel instanceof HTMLElement) {
          docsPanel.setAttribute('ui-language', this.uiLanguage);
        }

        const teamManualPanel = this.shadowRoot?.querySelector('#team-manual-panel') as unknown as {
          setUiLanguage?: (lang: LanguageCode) => void;
        };
        if (teamManualPanel && typeof teamManualPanel.setUiLanguage === 'function') {
          teamManualPanel.setUiLanguage(this.uiLanguage);
        }

        const snippetsPanel = this.shadowRoot?.querySelector('#snippets-panel') as unknown as {
          setUiLanguage?: (lang: LanguageCode) => void;
        };
        if (snippetsPanel && typeof snippetsPanel.setUiLanguage === 'function') {
          snippetsPanel.setUiLanguage(this.uiLanguage);
        }

        const key = this.dialogKey(readyMsg.dialog.rootId, readyMsg.dialog.selfId);
        this.toolbarContextHealth = this.contextHealthByDialogKey.get(key) ?? null;
        this.updateContextHealthUi();
        return true;
      }

      case 'diligence_push_updated': {
        const evt = message as DiligencePushUpdatedMessage;
        if (this.currentDialog && evt.dialog.rootId === this.currentDialog.rootId) {
          this.disableDiligencePush = evt.disableDiligencePush;
          this.updateBottomPanelFooterUi();
        }
        return true;
      }
      case 'diligence_budget_evt': {
        if (this.currentDialog && message.dialog.rootId === this.currentDialog.rootId) {
          this.diligencePushConfiguredMax = this.normalizeDiligenceMax(message.maxInjectCount);
          this.diligencePushRemaining = this.normalizeDiligenceRemaining(message.remainingCount);
          this.disableDiligencePush = message.disableDiligencePush;
          this.updateBottomPanelFooterUi();
        }
        return true;
      }
      case 'new_q4h_asked': {
        // Handle new question event
        const event: NewQ4HAskedEvent = message;
        this.handleNewQ4HAsked(event);
        return true;
      }
      case 'q4h_answered': {
        // Handle question answered event
        const event: Q4HAnsweredEvent = message;
        this.handleQ4HAnswered(event);
        return true;
      }
      case 'q4h_state_response': {
        // Handle initial Q4H state response (all questions at once)
        const event: Q4HStateResponse = message;
        this.handleQ4HStateResponse(event);
        return true;
      }
      case 'dialogs_moved': {
        // Another client moved dialogs between running/done/archived - refresh lists.
        // This ensures multi-tab/multi-browser updates stay consistent without polling.
        void this.loadDialogs();
        return true;
      }
      case 'dialogs_created': {
        // Another client created dialogs - refresh lists.
        // This ensures multi-tab/multi-browser updates stay consistent without polling.
        void this.loadDialogs();
        return true;
      }
      case 'dialogs_deleted': {
        // Another client deleted dialogs - refresh lists and clear selection if needed.
        const current = this.currentDialog;
        if (current && message.deletedRootIds.includes(current.rootId)) {
          this.clearCurrentDialogSelection();
        }
        void this.loadDialogs();
        return true;
      }
      case 'dialogs_quarantined': {
        this.removeQuarantinedRootDialog(message.rootId, message.fromStatus);
        return true;
      }
      case 'run_control_counts_evt': {
        this.proceedingDialogsCount = message.proceeding;
        this.resumableDialogsCount = message.resumable;
        this.updateToolbarDisplay();
        return true;
      }
      case 'run_control_refresh': {
        this.lastRunControlRefresh = { timestamp: message.timestamp, reason: message.reason };
        this.lastRunControlRefreshScheduledAtMs = null;
        this.updateToolbarDisplay();
        this.scheduleRunControlRefresh(message.reason);
        this.updateToolbarDisplay();
        return true;
      }
      case 'dlg_touched_evt': {
        const status = this.lookupVisibleDialogStatusByIds(
          message.dialog.rootId,
          message.dialog.selfId,
        );
        this.bumpDialogLastModified(
          { rootId: message.dialog.rootId, selfId: message.dialog.selfId },
          message.timestamp,
          status === 'running' ? { suppressRender: true } : undefined,
        );
        if (
          status &&
          message.dialog.selfId !== message.dialog.rootId &&
          !this.findDisplayedDialogByIds(message.dialog.rootId, message.dialog.selfId)
        ) {
          this.requestDialogListSubdialogNodeBackfill(
            message.dialog.rootId,
            message.dialog.selfId,
            status,
          );
        }
        return true;
      }
      default: {
        // Check if message has dialog context (TypedDialogEvent)
        if ('dialog' in message && message.dialog && typeof message.dialog === 'object') {
          return false;
        }
        return true;
      }
    }
  }

  /**
   * Handles WebSocket dialog events with comprehensive error handling
   * @param message - The WebSocket message to process
   * @returns Promise<void>
   */
  private async handleDialogWebSocketEvent(message: WebSocketMessage): Promise<void> {
    try {
      // Validate message structure
      if (!message || typeof message !== 'object') {
        console.error('🔔 [ERROR] Invalid message format received:', message);
        const t = getUiStrings(this.uiLanguage);
        this.showToast(t.invalidMessageFormatToast, 'error');
        return;
      }

      // All dialog events should have dialog context
      // For TypedDialogEvent, dialog is in DialogEventBase
      if (!this.hasDialogContext(message)) {
        console.warn(`Message without dialog context: type = '${message.type}'`, message);
        return;
      }

      // Now TypeScript knows message has dialog property
      const dialog = message.dialog;

      // Handle dialog-specific events using discriminated unions
      switch (message.type) {
        case 'course_update': {
          // Update toolbar course information
          this.toolbarCurrentCourse = message.course;
          this.toolbarTotalCourses = message.totalCourses;
          const prevBtn = this.shadowRoot?.querySelector('#course-navi-prev') as HTMLButtonElement;
          const nextBtn = this.shadowRoot?.querySelector('#course-navi-next') as HTMLButtonElement;
          if (prevBtn) prevBtn.disabled = !(this.toolbarCurrentCourse > 1);
          if (nextBtn) nextBtn.disabled = !(this.toolbarCurrentCourse < this.toolbarTotalCourses);
          const courseLabel = this.shadowRoot?.querySelector('#course-navi-label') as HTMLElement;
          if (courseLabel) courseLabel.textContent = `C ${this.toolbarCurrentCourse}`;
          const latest = message.totalCourses;
          const input = this.q4hInput as HTMLElement & {
            setDisabled?: (disabled: boolean) => void;
          };
          if (input && typeof input.setDisabled === 'function') {
            input.setDisabled(this.toolbarCurrentCourse !== latest);
          }
          // UX principle: the user should only see one course at a time in the chat timeline.
          // When the course changes (either via new course start or explicit course navigation),
          // clear the dialog container so it can be refilled with bubbles for that course only.
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.resetForCourse === 'function') {
            dc.resetForCourse(message.course);
          }
          const status = this.lookupVisibleDialogStatusByIds(dialog.rootId, dialog.selfId);
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            (message as TypedDialogEvent).timestamp,
            status === 'running' ? { suppressRender: true } : undefined,
          );
          break;
        }

        case 'subdialog_created_evt': {
          const subdialogEvent = message as SubdialogEvent;
          const node = subdialogEvent.subDialogNode;
          if (!node) {
            throw new Error(
              `CRITICAL: subdialog_created event missing subDialogNode. rootId=${subdialogEvent.subDialog.rootId} selfId=${subdialogEvent.subDialog.selfId}`,
            );
          }

          if (node.selfId !== subdialogEvent.subDialog.selfId) {
            throw new Error(
              `CRITICAL: subdialog_created event selfId mismatch. node=${node.selfId} evt=${subdialogEvent.subDialog.selfId}`,
            );
          }
          if (node.rootId !== subdialogEvent.subDialog.rootId) {
            throw new Error(
              `CRITICAL: subdialog_created event rootId mismatch. node=${node.rootId} evt=${subdialogEvent.subDialog.rootId}`,
            );
          }

          const subdialogKey = this.dialogKey(node.rootId, node.selfId);
          const effectiveDisplayState =
            node.displayState ?? this.dialogDisplayStatesByKey.get(subdialogKey);
          if (effectiveDisplayState) {
            this.dialogDisplayStatesByKey.set(subdialogKey, effectiveDisplayState);
          }

          const incomingSubdialog: ApiRootDialogResponse = {
            rootId: node.rootId,
            selfId: node.selfId,
            agentId: node.agentId,
            taskDocPath: node.taskDocPath,
            status: node.status,
            currentCourse: node.currentCourse,
            createdAt: node.createdAt,
            lastModified: node.lastModified,
            displayState: effectiveDisplayState,
            supdialogId: node.supdialogId,
            sessionSlug: node.sessionSlug,
            assignmentFromSup: node.assignmentFromSup,
            waitingForFreshBootsReasoning: false,
          };

          if (subdialogEvent.callName === 'freshBootsReasoning') {
            this.setDialogWaitingForFreshBootsReasoning(
              subdialogEvent.parentDialog.rootId,
              subdialogEvent.parentDialog.selfId,
              true,
            );
          }

          const hadLoadedSubdialogs = this.visibleSubdialogsByRoot.has(node.rootId);
          const rootExpandedInDom =
            node.status === 'running' && this.isRootExpandedInRunningListDom(node.rootId);
          const rootDialog = this.getRootDialog(node.rootId);
          if (!rootDialog) {
            throw new Error(
              `CRITICAL: subdialog_created event for unknown rootId=${node.rootId} selfId=${node.selfId}`,
            );
          }
          const prevCount =
            typeof rootDialog.subdialogCount === 'number' ? rootDialog.subdialogCount : 0;
          const visibleCountFloor =
            hadLoadedSubdialogs || rootExpandedInDom
              ? this.getVisibleSubdialogsForRoot(node.rootId).length + 1
              : 1;
          const nextCount = Math.max(prevCount + 1, visibleCountFloor, 1);
          this.upsertRootDialogSnapshot({
            ...rootDialog,
            subdialogCount: nextCount,
            lastModified: node.lastModified || rootDialog.lastModified,
          });

          if (hadLoadedSubdialogs || rootExpandedInDom) {
            const existing = this.getVisibleSubdialogsForRoot(node.rootId);
            const idx = existing.findIndex((d) => d.selfId === incomingSubdialog.selfId);
            if (idx >= 0) {
              const updated = [...existing];
              updated[idx] = incomingSubdialog;
              this.setVisibleSubdialogsForRoot(node.rootId, updated);
            } else {
              this.setVisibleSubdialogsForRoot(node.rootId, [...existing, incomingSubdialog]);
            }
          }

          if (hadLoadedSubdialogs || rootExpandedInDom || node.status !== 'running') {
            this.syncDialogListByStatus(node.status);
          } else {
            this.patchDialogListEntry(
              'running',
              { rootId: node.rootId, selfId: node.rootId },
              {
                subdialogCount: nextCount,
                lastModified: node.lastModified || rootDialog.lastModified,
              },
            );
          }
          this.bumpDialogLastModified(
            { rootId: node.rootId, selfId: node.selfId },
            node.lastModified || (message as TypedDialogEvent).timestamp,
            node.status === 'running' ? { suppressRender: true } : undefined,
          );
          break;
        }

        case 'new_q4h_asked': {
          break;
        }
        case 'q4h_answered': {
          break;
        }

        case 'full_reminders_update': {
          const event = message as FullRemindersEvent;

          // Update reminders with complete array from backend (now includes metadata)
          if (event && Array.isArray(event.reminders)) {
            this.toolbarReminders = event.reminders;
            this.updateReminderCountBadge();

            // If widget is visible, re-render it to show current state
            if (this.remindersWidgetVisible) {
              this.renderRemindersWidget();
            }
          }

          break;
        }

        case 'context_health_evt': {
          const event = message as ContextHealthEvent;
          const key = this.dialogKey(dialog.rootId, dialog.selfId);
          this.contextHealthByDialogKey.set(key, event.contextHealth);

          if (
            this.currentDialog &&
            this.currentDialog.rootId === dialog.rootId &&
            this.currentDialog.selfId === dialog.selfId
          ) {
            this.toolbarContextHealth = event.contextHealth;
            this.updateContextHealthUi();
          }

          const ts = (message as TypedDialogEvent).timestamp;
          const status = this.lookupVisibleDialogStatusByIds(dialog.rootId, dialog.selfId);
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
            status === 'running' ? { suppressRender: true } : undefined,
          );
          break;
        }

        case 'tellask_result_evt':
        case 'tellask_carryover_evt': {
          const dialogContainer = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (!dialogContainer) {
            console.warn(`Dialog container not found; dropping ${message.type}`);
            break;
          }

          await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          const tellaskOwnerIsWaitingForFreshBootsReasoning =
            this.isDialogWaitingForFreshBootsReasoning(dialog.rootId, dialog.selfId);
          if (
            tellaskOwnerIsWaitingForFreshBootsReasoning &&
            this.lookupVisibleDialogStatusByIds(dialog.rootId, dialog.selfId) === 'running'
          ) {
            this.refreshRootHierarchyAfterTellask(dialog.rootId);
          }
          const ts = (message as TypedDialogEvent).timestamp;
          const status = this.lookupVisibleDialogStatusByIds(dialog.rootId, dialog.selfId);
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
            status === 'running' ? { suppressRender: true } : undefined,
          );
          break;
        }

        case 'dlg_display_state_evt': {
          const displayState = (message as { displayState?: unknown }).displayState;
          if (
            typeof displayState !== 'object' ||
            displayState === null ||
            !('kind' in displayState)
          ) {
            console.warn('Invalid dlg_display_state_evt payload', message);
            break;
          }

          const selfId = dialog.selfId;
          const rootId = dialog.rootId;
          const key = this.dialogKey(rootId, selfId);
          const typedDisplayState = displayState as DialogDisplayState;
          const shouldClearWaitingForFreshBootsReasoning =
            this.isDialogWaitingForFreshBootsReasoning(rootId, selfId) &&
            (typedDisplayState.kind !== 'blocked' ||
              (typedDisplayState.reason.kind !== 'waiting_for_subdialogs' &&
                typedDisplayState.reason.kind !== 'needs_human_input_and_subdialogs'));
          this.dialogDisplayStatesByKey.set(key, typedDisplayState);

          // Update currently rendered snapshot entry if present.
          if (selfId === rootId) {
            const rootDialog = this.getRootDialog(rootId);
            if (rootDialog) {
              this.upsertRootDialogSnapshot({ ...rootDialog, displayState: typedDisplayState });
            }
          } else if (this.visibleSubdialogsByRoot.has(rootId)) {
            const subs = this.getVisibleSubdialogsForRoot(rootId);
            const updated = subs.map((d) =>
              d.selfId === selfId ? { ...d, displayState: typedDisplayState } : d,
            );
            this.setVisibleSubdialogsForRoot(rootId, updated);
          }

          // Update input primary action for the active dialog
          if (
            this.currentDialog &&
            this.currentDialog.rootId === rootId &&
            this.currentDialog.selfId === selfId
          ) {
            const currentDisplayState =
              this.currentDialogStatus === 'running' ? typedDisplayState : null;
            const input = this.q4hInput as HTMLElement & {
              setDisplayState?: (state: DialogDisplayState | null) => void;
            };
            if (input && typeof input.setDisplayState === 'function') {
              input.setDisplayState(currentDisplayState);
            }
            this.updateInputPanelVisibility();
          }

          // Q4H is delivered via global broadcast. Keep this snapshot refresh as a
          // recovery path for reconnect/race windows so the badge/panel can converge
          // to persisted state even if a transient event was missed.
          if (
            typedDisplayState.kind === 'blocked' &&
            (typedDisplayState.reason.kind === 'needs_human_input' ||
              typedDisplayState.reason.kind === 'needs_human_input_and_subdialogs')
          ) {
            this.wsManager.sendRaw({ type: 'get_q4h_state' });
          }

          const status = this.lookupVisibleDialogStatusByIds(rootId, selfId);
          if (status === 'running') {
            const runningList = this.shadowRoot?.querySelector('#running-dialog-list');
            if (runningList instanceof RunningDialogList) {
              runningList.updateDialogEntry(rootId, selfId, { displayState: typedDisplayState });
            }
          }
          if (shouldClearWaitingForFreshBootsReasoning) {
            this.setDialogWaitingForFreshBootsReasoning(rootId, selfId, false);
          }
          const ts = (message as TypedDialogEvent).timestamp;
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
            { suppressRender: true },
          );

          // Forward to dialog container if this event targets it
          const dialogContainer = this.getDialogContainerForEvent(message);
          if (dialogContainer) {
            await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          }
          break;
        }

        case 'dlg_display_state_marker_evt': {
          const selfId = dialog.selfId;
          const rootId = dialog.rootId;
          if (message.kind === 'resumed') {
            const key = this.dialogKey(rootId, selfId);
            const markerDisplayState: DialogDisplayState = { kind: 'proceeding' };
            this.dialogDisplayStatesByKey.set(key, markerDisplayState);

            if (selfId === rootId) {
              const rootDialog = this.getRootDialog(rootId);
              if (rootDialog) {
                this.upsertRootDialogSnapshot({ ...rootDialog, displayState: markerDisplayState });
              }
            } else if (this.visibleSubdialogsByRoot.has(rootId)) {
              const subs = this.getVisibleSubdialogsForRoot(rootId);
              const updated = subs.map((d) =>
                d.selfId === selfId ? { ...d, displayState: markerDisplayState } : d,
              );
              this.setVisibleSubdialogsForRoot(rootId, updated);
            }

            if (
              this.currentDialog &&
              this.currentDialog.rootId === rootId &&
              this.currentDialog.selfId === selfId
            ) {
              const input = this.q4hInput as HTMLElement & {
                setDisplayState?: (state: DialogDisplayState | null) => void;
              };
              if (input && typeof input.setDisplayState === 'function') {
                input.setDisplayState(
                  this.currentDialogStatus === 'running' ? markerDisplayState : null,
                );
              }
              this.updateInputPanelVisibility();
            }
          }

          const status = this.lookupVisibleDialogStatusByIds(rootId, selfId);
          if (status === 'running' && message.kind === 'resumed') {
            const runningList = this.shadowRoot?.querySelector('#running-dialog-list');
            if (runningList instanceof RunningDialogList) {
              runningList.updateDialogEntry(rootId, selfId, {
                displayState: { kind: 'proceeding' },
              });
            }
          }

          const dialogContainer = this.getDialogContainerForEvent(message);
          if (dialogContainer) {
            await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          }
          const ts = (message as TypedDialogEvent).timestamp;
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
            { suppressRender: true },
          );

          // Marker events are broadcast to all connected clients by backend display-state broadcaster.
          // Keep a delayed refresh so counters converge from persisted index even after transient hiccups.
          if (message.kind === 'resumed') {
            this.scheduleRunControlRefresh('run_state_marker_resumed');
          } else {
            this.scheduleRunControlRefresh('run_state_marker_interrupted');
          }
          break;
        }

        case 'dialog_ready': {
          // Enable/disable q4h-input for the active dialog (respect read-only + dead)
          const inputArea = this.q4hInput as HTMLElement & {
            setDisabled?: (disabled: boolean) => void;
          };
          if (inputArea && typeof inputArea.setDisabled === 'function') {
            const status = this.currentDialogStatus;
            const readOnly = status === 'completed' || status === 'archived';
            const current = this.currentDialog;
            let isDead = false;
            if (!readOnly && current) {
              const key = this.dialogKey(current.rootId, current.selfId);
              const displayState = this.dialogDisplayStatesByKey.get(key) ?? null;
              isDead = displayState !== null && displayState.kind === 'dead';
            }
            inputArea.setDisabled(readOnly || isDead);
          }
          break;
        }

        default:
          // Forward all dialog-scoped events to the correct dialog container
          try {
            const dialogContainer = this.getDialogContainerForEvent(message);
            if (dialogContainer) {
              await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
            } else {
              console.warn('No dialog container found for event:', message.type);
            }
          } catch (err) {
            console.warn('Failed to forward dialog event to container:', err);
          }
          const ts = (message as TypedDialogEvent).timestamp;
          const status = this.lookupVisibleDialogStatusByIds(dialog.rootId, dialog.selfId);
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
            status === 'running' ? { suppressRender: true } : undefined,
          );
          break;
      }
    } catch (error) {
      const t = getUiStrings(this.uiLanguage);
      // Enhanced error handling for WebSocket event processing
      console.error('🔔 [ERROR] WebSocket event processing failed:', {
        messageType: message?.type || 'unknown',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });

      // Show toast for critical failures
      if (
        error instanceof Error &&
        (error.message.includes('Failed to fetch') ||
          error.message.includes('Network error') ||
          error.message.includes('connection'))
      ) {
        this.showToast(t.reminderConnectionIssueToast, 'error');
      } else {
        this.showToast(t.reminderSyncIssueToast, 'error');
      }
    }
  }

  private bumpDialogLastModified(
    dialogId: { rootId: string; selfId: string },
    isoTs?: string,
    options?: { suppressRender?: boolean },
  ): void {
    if (!isoTs) return;
    let changed = false;

    const root = this.getRootDialog(dialogId.rootId);
    if (root && root.lastModified !== isoTs) {
      this.upsertRootDialogSnapshot({ ...root, lastModified: isoTs });
      changed = true;
    }

    if (dialogId.selfId !== dialogId.rootId && this.visibleSubdialogsByRoot.has(dialogId.rootId)) {
      const subs = this.getVisibleSubdialogsForRoot(dialogId.rootId);
      const updated = subs.map((sub) => {
        if (sub.selfId !== dialogId.selfId) return sub;
        if (sub.lastModified === isoTs) return sub;
        changed = true;
        return { ...sub, lastModified: isoTs };
      });
      this.setVisibleSubdialogsForRoot(dialogId.rootId, updated);
    }

    if (!changed) return;
    const status = this.lookupVisibleDialogStatusByIds(dialogId.rootId, dialogId.selfId);
    if (!status) return;
    let patched = this.patchDialogListEntry(status, dialogId, { lastModified: isoTs });
    if (dialogId.selfId !== dialogId.rootId) {
      const patchedRoot = this.patchDialogListEntry(
        status,
        { rootId: dialogId.rootId, selfId: dialogId.rootId },
        { lastModified: isoTs },
      );
      patched = patched || patchedRoot;
    }
    if (patched && options?.suppressRender) return;
    this.syncDialogListByStatus(status);
  }

  /**
   * Update reminder count badge based on actual operations
   */
  private updateReminderCountBadge(): void {
    // Update the toolbar badge only. Widget DOM patching is handled by renderRemindersWidget().
    const remBtnCount = this.shadowRoot?.querySelector(
      '#navibar-reminders-toggle .reminders-count',
    ) as HTMLElement;
    if (remBtnCount) {
      remBtnCount.textContent = String(this.toolbarReminders.length);
    }
  }

  /**
   * Reset reminder operation count (call when starting new dialog)
   */
  private resetReminderOperationCount(): void {
    this.toolbarReminders = [];
    this.updateReminderCountBadge();

    // If widget is visible, re-render it to show empty state
    if (this.remindersWidgetVisible) {
      this.renderRemindersWidget();
    }
  }

  /**
   * Update reminders widget display
   */
  private updateRemindersWidget(): void {
    // Update toolbar reminder count
    this.updateReminderCountBadge();

    // Update widget if visible
    if (this.remindersWidgetVisible) {
      this.renderRemindersWidget();
    }
  }

  private toggleRemindersWidget(): void {
    const t = getUiStrings(this.uiLanguage);

    // Guard against accessing reminders before dialog is fully activated
    if (!this.currentDialog || !this.currentDialog.selfId || !this.currentDialog.rootId) {
      console.warn('Cannot access reminders: no active dialog');
      return;
    }

    this.remindersWidgetVisible = !this.remindersWidgetVisible;
    if (!this.remindersWidgetVisible) {
      this.closeRemindersWidget();
      return;
    }
    this.updateToolbarDisplay();
    const existing = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    if (this.remindersWidgetVisible) {
      const tb = this.shadowRoot?.querySelector('.navibar') as HTMLElement;
      const rect = tb ? tb.getBoundingClientRect() : ({ right: 340, bottom: 80 } as DOMRect);
      const margin = 12;
      const maxX = Math.max(margin, window.innerWidth - this.remindersWidgetWidthPx - margin);
      const maxY = Math.max(margin, window.innerHeight - this.remindersWidgetHeightPx - margin);
      this.remindersWidgetX = Math.max(
        margin,
        Math.min(maxX, Math.floor(rect.right - this.remindersWidgetWidthPx - 8)),
      );
      this.remindersWidgetY = Math.max(margin, Math.min(maxY, Math.floor(rect.bottom + 8)));
      let widget = existing;
      if (!widget) {
        const created = document.createElement('div');
        created.id = 'reminders-widget';
        created.innerHTML = `
          <div id="reminders-widget-header" class="reminders-widget-header">
            <div class="reminders-widget-header-main">
              <span class="icon-mask app-icon-bookmark app-icon-16" aria-hidden="true"></span>
              <span id="reminders-widget-title">${formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length)}</span>
            </div>
            <button id="reminders-widget-close" class="icon-button" aria-label="${t.close}">
              <span class="icon-mask app-icon-close" aria-hidden="true"></span>
            </button>
          </div>
          <div id="reminders-widget-content" lang="${this.uiLanguage}" data-progressive-expand-step-parent="true"></div>
	          <div id="reminders-widget-resize-handle" aria-hidden="true">
		            <span class="icon-mask app-icon-resize-corner-bottom-left" aria-hidden="true"></span>
			          </div>
        `;
        this.shadowRoot?.appendChild(created);
        widget = created;
      }
      if (widget) {
        this.applyRemindersWidgetGeometryStyle(widget);
      }
      // Render reminder content after widget is visible
      this.renderRemindersWidget();
      this.setupRemindersWidgetDrag();
    }
  }

  /**
   * Render reminders widget content with proper formatting
   * Preserve backend-authored reminder semantics in the widget.
   */
  private renderRemindersWidget(): void {
    if (!this.remindersWidgetVisible) return;

    const widgetContent = this.shadowRoot?.querySelector(
      '#reminders-widget-content',
    ) as HTMLElement | null;
    const widgetTitle = this.shadowRoot?.querySelector(
      '#reminders-widget-title',
    ) as HTMLElement | null;

    if (!widgetContent) {
      console.warn('No reminders widget content container found');
      return;
    }
    widgetContent.setAttribute('lang', this.uiLanguage);
    widgetContent.setAttribute('data-progressive-expand-step-parent', 'true');

    if (widgetTitle) {
      widgetTitle.textContent = formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length);
    }
    const shell = this.ensureRemindersWidgetShell(widgetContent);
    const numberedReminders = this.toolbarReminders.filter((r) => r && r.echoback !== false);
    const virtualReminders = this.toolbarReminders.filter((r) => r && r.echoback === false);
    const t = getUiStrings(this.uiLanguage);
    const virtualEntries = virtualReminders.map((r, i) =>
      this.buildReminderRenderEntry('virtual', r, i, t),
    );
    const numberedEntries = numberedReminders.map((r, i) =>
      this.buildReminderRenderEntry('numbered', r, i, t),
    );
    this.assertUniqueReminderRenderKeys('virtual', virtualEntries);
    this.assertUniqueReminderRenderKeys('numbered', numberedEntries);

    shell.empty.textContent = t.noReminders;
    shell.empty.hidden = virtualEntries.length > 0 || numberedEntries.length > 0;
    shell.virtualSection.hidden = virtualEntries.length < 1;
    shell.numberedSection.hidden = numberedEntries.length < 1;
    shell.sectionDivider.hidden = virtualEntries.length < 1 || numberedEntries.length < 1;

    this.patchReminderSection(shell.virtualSection, virtualEntries, widgetContent);
    this.patchReminderSection(shell.numberedSection, numberedEntries, widgetContent);
  }

  private renderReminderScopeBadgeHtml(scope: ReminderContent['scope'] | undefined): string {
    const t = getUiStrings(this.uiLanguage);
    if (scope === 'personal') {
      return `<span class="rem-item-scope rem-item-scope-personal" title="${this.escapeHtml(t.personalReminderScope)}" aria-label="${this.escapeHtml(t.personalReminderScope)}"><span class="icon-mask" aria-hidden="true"></span></span>`;
    }
    if (scope === 'agent_shared') {
      return `<span class="rem-item-scope rem-item-scope-agent-shared" title="${this.escapeHtml(t.sharedReminderScope)}" aria-label="${this.escapeHtml(t.sharedReminderScope)}"><span class="icon-mask" aria-hidden="true"></span></span>`;
    }
    return `<span class="rem-item-scope rem-item-scope-dialog" title="${this.escapeHtml(t.dialogReminderScope)}" aria-label="${this.escapeHtml(t.dialogReminderScope)}"><span class="icon-mask" aria-hidden="true"></span></span>`;
  }

  private formatReminderDisplayContent(
    content: string,
    _meta: Record<string, unknown> | undefined,
  ): string {
    return content;
  }

  private renderReminderContentHtml(
    content: string,
    renderMode: ReminderContent['renderMode'] | undefined,
  ): string {
    if (renderMode === 'plain') {
      return [
        '<div class="rem-item-body">',
        `<div class="rem-item-content rem-item-content-expandable">${this.renderReminderPlainHtml(content)}</div>`,
        '<div class="rem-item-expand-footer is-hidden"><button type="button" class="rem-item-expand-btn"><span class="rem-item-expand-icon icon-mask" aria-hidden="true"></span></button></div>',
        '</div>',
      ].join('');
    }
    return [
      '<div class="rem-item-body">',
      `<div class="rem-item-content rem-item-content-markdown rem-item-content-expandable markdown-content">${renderDomindsMarkdown(content, { kind: 'chat' })}</div>`,
      '<div class="rem-item-expand-footer is-hidden"><button type="button" class="rem-item-expand-btn"><span class="rem-item-expand-icon icon-mask" aria-hidden="true"></span></button></div>',
      '</div>',
    ].join('');
  }

  private renderReminderPlainHtml(content: string): string {
    return escapeHtml(content).replace(/\n/g, '<br>');
  }

  private ensureRemindersWidgetShell(widgetContent: HTMLElement): Readonly<{
    empty: HTMLElement;
    virtualSection: HTMLElement;
    sectionDivider: HTMLHRElement;
    numberedSection: HTMLElement;
  }> {
    let empty = widgetContent.querySelector('[data-reminders-role="empty"]') as HTMLElement | null;
    if (!(empty instanceof HTMLElement)) {
      empty = document.createElement('div');
      empty.className = 'reminders-widget-empty';
      empty.setAttribute('data-reminders-role', 'empty');
      widgetContent.appendChild(empty);
    }

    let virtualSection = widgetContent.querySelector(
      '[data-reminders-role="virtual-section"]',
    ) as HTMLElement | null;
    if (!(virtualSection instanceof HTMLElement)) {
      virtualSection = document.createElement('div');
      virtualSection.className = 'rem-section rem-section-virtual';
      virtualSection.setAttribute('data-reminders-role', 'virtual-section');
      widgetContent.appendChild(virtualSection);
    }

    let sectionDivider = widgetContent.querySelector(
      '[data-reminders-role="section-divider"]',
    ) as HTMLHRElement | null;
    if (!(sectionDivider instanceof HTMLHRElement)) {
      sectionDivider = document.createElement('hr');
      sectionDivider.className = 'rem-divider rem-divider-section';
      sectionDivider.setAttribute('data-reminders-role', 'section-divider');
      widgetContent.appendChild(sectionDivider);
    }

    let numberedSection = widgetContent.querySelector(
      '[data-reminders-role="numbered-section"]',
    ) as HTMLElement | null;
    if (!(numberedSection instanceof HTMLElement)) {
      numberedSection = document.createElement('div');
      numberedSection.className = 'rem-section rem-section-numbered';
      numberedSection.setAttribute('data-reminders-role', 'numbered-section');
      widgetContent.appendChild(numberedSection);
    }

    // Keep a stable shell order so keyed reminder nodes can be moved inside sections without
    // root-level leftovers from older renders or partial migrations polluting the widget.
    const orderedShellNodes: HTMLElement[] = [
      empty,
      virtualSection,
      sectionDivider,
      numberedSection,
    ];
    let rootReferenceNode: ChildNode | null = widgetContent.firstChild;
    for (const shellNode of orderedShellNodes) {
      if (shellNode !== rootReferenceNode) {
        widgetContent.insertBefore(shellNode, rootReferenceNode);
      }
      rootReferenceNode = shellNode.nextSibling;
    }
    for (const child of Array.from(widgetContent.childNodes)) {
      if (orderedShellNodes.includes(child as HTMLElement)) continue;
      child.remove();
    }

    return {
      empty,
      virtualSection,
      sectionDivider,
      numberedSection,
    };
  }

  private buildReminderRenderEntry(
    section: ReminderSectionKind,
    reminder: ReminderContent | undefined,
    index: number,
    t: ReturnType<typeof getUiStrings>,
  ): ReminderRenderEntry {
    const fallbackId = `pending-${String(index + 1)}`;
    const reminderId =
      typeof reminder?.reminder_id === 'string' && reminder.reminder_id.trim() !== ''
        ? reminder.reminder_id
        : fallbackId;

    let html: string;
    if (!reminder || !reminder.content) {
      const scopeBadgeHtml =
        section === 'numbered' ? '' : this.renderReminderScopeBadgeHtml(reminder?.scope);
      const itemClass = section === 'virtual' ? 'rem-item rem-item-virtual' : 'rem-item';
      html = `<div class="${itemClass}"><div class="rem-item-head"><div class="rem-item-number" title="${this.escapeHtml(reminderId)}">${this.escapeHtml(reminderId)}</div>${scopeBadgeHtml}</div><div class="rem-item-content rem-item-content-loading">${t.loading}</div></div>`;
    } else {
      const displayContent = this.formatReminderDisplayContent(reminder.content, reminder.meta);
      const scopeBadgeHtml =
        section === 'numbered' ? this.renderReminderScopeBadgeHtml(reminder.scope) : '';
      const itemClass = section === 'virtual' ? 'rem-item rem-item-virtual' : 'rem-item';
      html = `<div class="${itemClass}"><div class="rem-item-head"><div class="rem-item-number" title="${this.escapeHtml(reminderId)}">${this.escapeHtml(reminderId)}</div>${scopeBadgeHtml}</div>${this.renderReminderContentHtml(displayContent, reminder.renderMode)}</div>`;
    }

    return {
      key: `${section}:${reminderId}`,
      fingerprint: `${this.uiLanguage}\u0000${reminder?.renderRevision ?? `loading:${section}:${reminderId}`}`,
      html,
    };
  }

  private createReminderItemElement(
    entry: ReminderRenderEntry,
    widgetContent: HTMLElement,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = entry.html;
    const item = wrapper.firstElementChild;
    if (!(item instanceof HTMLElement)) {
      throw new Error(`Reminder render produced no root node for key=${entry.key}`);
    }
    item.dataset.reminderKey = entry.key;
    item.dataset.reminderFingerprint = entry.fingerprint;
    postprocessRenderedDomindsMarkdown(item);
    this.setupReminderProgressiveExpandForItem(entry.key, item, widgetContent);
    return item;
  }

  private setupReminderProgressiveExpandForItem(
    key: string,
    item: HTMLElement,
    widgetContent: HTMLElement,
  ): void {
    this.cleanupReminderProgressiveExpand(key);
    const target = item.querySelector('.rem-item-content') as HTMLElement | null;
    const footer = item.querySelector('.rem-item-expand-footer') as HTMLElement | null;
    const button = item.querySelector('.rem-item-expand-btn') as HTMLButtonElement | null;
    if (!target || !footer || !button) return;
    const cleanup = setupProgressiveExpandBehavior({
      target,
      footer,
      button,
      stepParent: widgetContent,
      label: getProgressiveExpandLabel(this.uiLanguage),
      // Reminder bodies can become long after first paint when a nested code block is expanded.
      // Track only target self-growth until the first outer overflow appears; never track widget
      // parent resize for this.
      observeTargetUntilOverflow: true,
    });
    this.reminderProgressiveExpandCleanupByKey.set(key, cleanup);
  }

  private cleanupReminderProgressiveExpand(key: string): void {
    const cleanup = this.reminderProgressiveExpandCleanupByKey.get(key);
    if (!cleanup) return;
    cleanup();
    this.reminderProgressiveExpandCleanupByKey.delete(key);
  }

  private cleanupAllReminderProgressiveExpands(): void {
    for (const cleanup of this.reminderProgressiveExpandCleanupByKey.values()) {
      cleanup();
    }
    this.reminderProgressiveExpandCleanupByKey.clear();
  }

  private assertUniqueReminderRenderKeys(
    section: ReminderSectionKind,
    entries: readonly ReminderRenderEntry[],
  ): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        throw new Error(`Duplicate reminder render key in ${section} section: ${entry.key}`);
      }
      seen.add(entry.key);
    }
  }

  private patchReminderSection(
    section: HTMLElement,
    entries: readonly ReminderRenderEntry[],
    widgetContent: HTMLElement,
  ): void {
    const existingByKey = new Map<string, HTMLElement>();
    for (const child of Array.from(section.children)) {
      if (!(child instanceof HTMLElement)) {
        child.remove();
        continue;
      }
      if (!child.classList.contains('rem-item')) {
        child.remove();
        continue;
      }
      const key = child.dataset.reminderKey;
      if (typeof key === 'string' && key.length > 0) {
        if (existingByKey.has(key)) {
          throw new Error(`Duplicate reminder DOM key in widget section: ${key}`);
        }
        existingByKey.set(key, child);
      } else {
        child.remove();
      }
    }

    let referenceNode: ChildNode | null = section.firstChild;
    for (const entry of entries) {
      const existing = existingByKey.get(entry.key) ?? null;
      let item = existing;
      if (existing !== null && existing.dataset.reminderFingerprint !== entry.fingerprint) {
        const nextSibling = existing.nextSibling;
        const wasReferenceNode = existing === referenceNode;
        this.cleanupReminderProgressiveExpand(entry.key);
        existing.remove();
        if (wasReferenceNode) {
          referenceNode = nextSibling;
        }
        item = null;
      }
      if (item === null) {
        item = this.createReminderItemElement(entry, widgetContent);
        section.insertBefore(item, referenceNode);
      } else if (item !== referenceNode) {
        section.insertBefore(item, referenceNode);
      }
      referenceNode = item.nextSibling;
      existingByKey.delete(entry.key);
    }

    for (const [obsoleteKey, obsoleteNode] of existingByKey.entries()) {
      this.cleanupReminderProgressiveExpand(obsoleteKey);
      obsoleteNode.remove();
    }
  }

  /**
   * Get agent display name from team configuration or fallback to default format
   */
  private getAgentDisplayName(agentId: string): string {
    // Try to find agent in team members
    const member = this.teamMembers.find((m) => m.id === agentId);
    if (member) {
      const icon = member.icon || '🤖';
      const name = member.name || agentId;
      return `${icon} ${name}`;
    }

    // Fallback to default format
    return `🤖 ${agentId.charAt(0).toUpperCase() + agentId.slice(1)}`;
  }

  // ========== Q4H (Questions for Human) Methods ==========

  /**
   * Handle new_q4h_asked WebSocket event
   * Adds a new question to the global Q4H state
   */
  private handleNewQ4HAsked(event: NewQ4HAskedEvent): void {
    const q = event.question;

    // Q4H IDs are unique registration identities from backend.
    // Receiving the same ID again indicates an upstream invariant violation.
    const existingIndex = this.q4hQuestions.findIndex((eq) => eq.id === q.id);
    if (existingIndex >= 0) {
      const existing = this.q4hQuestions[existingIndex]!;
      const existingMeta = existing as HumanQuestion & { selfId?: string; callId?: string };
      const incomingMeta = q as HumanQuestion & { selfId?: string; callId?: string };
      throw new Error(
        `Q4H duplicate delivery violation: questionId=${q.id} existingDialog=${existingMeta.selfId ?? ''} incomingDialog=${incomingMeta.selfId ?? ''} existingCallId=${existingMeta.callId ?? ''} incomingCallId=${incomingMeta.callId ?? ''}`,
      );
    }
    this.q4hQuestions.push(q);

    // Build dialog contexts and update component
    this.updateQ4HComponent();
    this.applyPendingQ4HSelectionFromDeepLink();
    this.applyPendingDeepLinkIfQ4H();
  }

  /**
   * Handle q4h_answered WebSocket event
   * Removes a question from the global Q4H state
   */
  private handleQ4HAnswered(event: Q4HAnsweredEvent): void {
    const wasVisibleQ4HCount = this.q4hQuestionCount;
    const removeIndex = this.q4hQuestions.findIndex((q) => q.id === event.questionId);
    if (removeIndex >= 0) {
      this.q4hQuestions.splice(removeIndex, 1);
    } else {
      // Recovery path: if we received `q4h_answered` but our cache doesn't contain the id,
      // request an authoritative snapshot so pending count converges without manual reload.
      this.wsManager.sendRaw({ type: 'get_q4h_state' });
    }

    // Build dialog contexts and update component
    this.updateQ4HComponent();
    if (removeIndex >= 0 && wasVisibleQ4HCount > 0 && this.q4hQuestionCount === 0) {
      this.collapseBottomPanelQ4HTabIfExpanded();
    }
  }

  /**
   * Handle q4h_state_response - initial load of all Q4H questions
   */
  private handleQ4HStateResponse(event: Q4HStateResponse): void {
    // Snapshot contains Q4H for running dialogs. Merge it with existing cached Q4Hs so that
    // dialogs moved out of running (completed/archived) can be revived without losing their
    // pending questions client-side, while still pruning stale questions for dialogs that
    // are currently running.
    const incomingById = new Map<string, HumanQuestion>();
    for (const q of event.questions) {
      if (!q || typeof q.id !== 'string' || q.id.trim() === '') {
        throw new Error('Q4H state snapshot violation: invalid question id');
      }
      if (incomingById.has(q.id)) {
        throw new Error(
          `Q4H state snapshot violation: duplicate question id in snapshot (${q.id})`,
        );
      }
      incomingById.set(q.id, q);
    }

    const next: HumanQuestion[] = [];
    const seenIds = new Set<string>();

    for (const existing of this.q4hQuestions) {
      const id = typeof existing.id === 'string' ? existing.id : '';
      if (!id) {
        throw new Error('Q4H client cache violation: existing question has invalid id');
      }
      if (seenIds.has(id)) {
        throw new Error(`Q4H client cache violation: duplicate cached question id (${id})`);
      }
      seenIds.add(id);

      const existingWithDialog = existing as { selfId?: unknown; rootId?: unknown };
      const selfId =
        typeof existingWithDialog.selfId === 'string' ? existingWithDialog.selfId : null;
      if (!selfId) {
        const incoming = incomingById.get(id);
        next.push(incoming ?? existing);
        if (incoming) incomingById.delete(id);
        continue;
      }

      const rootId =
        typeof existingWithDialog.rootId === 'string' && existingWithDialog.rootId
          ? existingWithDialog.rootId
          : selfId;
      const status = this.lookupVisibleDialogStatusByIds(rootId, selfId);

      const incoming = incomingById.get(id);
      if (incoming) {
        next.push(incoming);
        incomingById.delete(id);
        continue;
      }

      // Prune only when we can confidently say the dialog is running (snapshot is authoritative).
      if (status === 'running') {
        continue;
      }
      next.push(existing);
    }

    for (const [id, q] of incomingById.entries()) {
      if (seenIds.has(id)) {
        throw new Error(`Q4H state merge violation: duplicate id during merge (${id})`);
      }
      seenIds.add(id);
      next.push(q);
    }

    this.q4hQuestions = next;
    this.updateQ4HComponent();
    this.applyPendingQ4HSelectionFromDeepLink();
    this.applyPendingDeepLinkIfQ4H();
  }

  private resolveHydratedQ4HDialogContext(question: HumanQuestion): Q4HDialogContext | null {
    const globalQuestion = question as {
      selfId?: string;
      rootId?: string;
      agentId?: string;
      taskDocPath?: string;
    };

    if (globalQuestion.selfId) {
      const selfId = globalQuestion.selfId;
      const rootId = globalQuestion.rootId ?? selfId;
      const rootStatus = this.getRootStatus(rootId);
      if (rootStatus !== 'running') {
        return null;
      }
      return {
        selfId,
        rootId,
        agentId: globalQuestion.agentId ?? 'unknown',
        taskDocPath: globalQuestion.taskDocPath ?? '',
        questions: [question],
      };
    }

    const dialogInfo = this.findDialogForQuestion(question);
    if (!dialogInfo) {
      return null;
    }
    const status = this.lookupVisibleDialogStatus(dialogInfo);
    if (status !== 'running') {
      return null;
    }
    return {
      selfId: dialogInfo.selfId,
      rootId: dialogInfo.rootId,
      agentId: dialogInfo.agentId,
      taskDocPath: dialogInfo.taskDocPath,
      questions: [question],
    };
  }

  /**
   * Rebuild Q4H dialog contexts and update component
   */
  private updateQ4HComponent(): void {
    const visibleContexts = this.q4hQuestions
      .map((question) => this.resolveHydratedQ4HDialogContext(question))
      .filter((context): context is Q4HDialogContext => context !== null);

    this.q4hDialogContexts = this.buildQ4HDialogContexts(
      visibleContexts.flatMap((context) => context.questions),
    );
    this.q4hQuestionCount = this.q4hDialogContexts.reduce(
      (count, context) => count + context.questions.length,
      0,
    );

    // Transform to Q4HQuestion format expected by the component
    const q4hQuestions: Q4HQuestion[] = [];
    for (const context of this.q4hDialogContexts) {
      for (const question of context.questions) {
        q4hQuestions.push({
          id: question.id,
          tellaskContent: question.tellaskContent,
          askedAt: question.askedAt,
          dialogContext: context,
        });
      }
    }

    // Update q4h-input component
    if (this.q4hInput) {
      this.q4hInput.setQuestions(q4hQuestions);
    }

    // Keep bottom-panel Q4H panel in sync when visible.
    const panel = this.shadowRoot?.querySelector('#q4h-panel');
    if (
      panel instanceof HTMLElement &&
      typeof (panel as DomindsQ4HPanel).setQuestions === 'function'
    ) {
      (panel as DomindsQ4HPanel).setQuestions(this.q4hQuestionCount, this.q4hDialogContexts);
    }

    this.updateBottomPanelFooterUi();
  }

  /**
   * Build Q4H dialog contexts from questions array
   * Groups questions by dialog and includes agent information
   * Supports both regular HumanQuestion and GlobalQ4HQuestion (with embedded dialog context)
   */
  private buildQ4HDialogContexts(questions: HumanQuestion[]): Q4HDialogContext[] {
    // Group questions by their source dialog
    // Note: For global Q4H, questions may have embedded dialog context (selfId, rootId, agentId, taskDocPath)
    // For single-dialog Q4H, we need to look up dialog info from the frontend's dialogs list

    const contextMap = new Map<string, Q4HDialogContext>();

    for (const question of questions) {
      // Check if this is a GlobalQ4HQuestion with embedded dialog context
      const globalQuestion = question as {
        selfId?: string;
        rootId?: string;
        agentId?: string;
        taskDocPath?: string;
      };
      let dialogId: string | undefined;
      let rootId: string | undefined;
      let agentId: string | undefined;
      let taskDocPath: string | undefined;

      if (globalQuestion.selfId) {
        // Global Q4H: use embedded dialog context
        dialogId = globalQuestion.selfId;
        rootId = globalQuestion.rootId ?? dialogId;
        agentId = globalQuestion.agentId ?? 'unknown';
        taskDocPath = globalQuestion.taskDocPath ?? '';
      } else {
        // Single dialog Q4H: look up from frontend's dialogs list
        const dialogInfo = this.findDialogForQuestion(question);
        if (dialogInfo) {
          dialogId = dialogInfo.selfId;
          rootId = dialogInfo.rootId;
          agentId = dialogInfo.agentId;
          taskDocPath = dialogInfo.taskDocPath;
        }
      }

      if (dialogId) {
        const key = dialogId;
        let context = contextMap.get(key);

        if (!context) {
          context = {
            selfId: dialogId,
            rootId: rootId ?? dialogId,
            agentId: agentId ?? 'unknown',
            taskDocPath: taskDocPath ?? '',
            questions: [],
          };
          contextMap.set(key, context);
        }

        context.questions.push(question);
      }
    }

    // Sort contexts: root dialog first, then subdialogs
    const sortedContexts = Array.from(contextMap.values()).sort((a, b) => {
      const aIsRoot = a.selfId === a.rootId ? 1 : 0;
      const bIsRoot = b.selfId === b.rootId ? 1 : 0;
      return bIsRoot - aIsRoot;
    });

    return sortedContexts;
  }

  /**
   * Find dialog info for a question
   * This is a placeholder - in real implementation, the backend would provide dialog context
   */
  private findDialogForQuestion(_question: HumanQuestion): DialogInfo | null {
    // For now, use the current dialog if it matches
    // In a real implementation, the backend would include dialog context in the event
    if (this.currentDialog) {
      return this.currentDialog;
    }

    // Fallback: try to find in loaded root snapshots.
    // This is limited since we don't have direct question-to-dialog mapping
    const roots = [
      ...this.rootDialogsByStatus.running,
      ...this.rootDialogsByStatus.completed,
      ...this.rootDialogsByStatus.archived,
    ];
    if (roots.length > 0) {
      const rootDialog = roots[0];
      if (rootDialog) {
        return {
          selfId: rootDialog.rootId,
          rootId: rootDialog.rootId,
          agentId: rootDialog.agentId,
          agentName: rootDialog.agentId,
          taskDocPath: rootDialog.taskDocPath,
        };
      }
    }

    return null;
  }

  /**
   * Navigate to a Q4H call site in the conversation
   */
  private navigateToQ4HCallSite(args: Q4HCallSiteNavigationDetail): void {
    const { questionId, dialogId, rootId, course, messageIndex, callId } = args;
    // Navigate to the dialog if needed
    if (this.currentDialog?.selfId !== dialogId) {
      const dialogInfo = this.findDisplayedDialogByAnyId(dialogId);
      if (dialogInfo) {
        void this.selectDialog({
          selfId: dialogInfo.selfId || dialogInfo.rootId,
          rootId: dialogInfo.rootId,
          agentId: dialogInfo.agentId,
          agentName: dialogInfo.agentId,
          taskDocPath: dialogInfo.taskDocPath,
        });
      }
    }

    // Navigate to the specific course and scroll to call site
    // The actual scrolling will be handled by the dialog container
    const dialogContainer = this.shadowRoot?.querySelector(
      '#dialog-container',
    ) as DomindsDialogContainer | null;
    if (dialogContainer) {
      const current = this.currentDialog;
      const isCurrentDialogTarget =
        current !== null && current.selfId === dialogId && current.rootId === rootId;
      const isCurrentCourseTarget = this.toolbarCurrentCourse === course;
      if (!(isCurrentDialogTarget && isCurrentCourseTarget)) {
        // Only replay history when course actually needs to change.
        void dialogContainer.setCurrentCourse(course);
      }
      // Scroll to call site - dispatch event for dialog container to handle
      const trimmedCallId = typeof callId === 'string' ? callId.trim() : '';
      if (trimmedCallId !== '') {
        dispatchDomindsEvent(
          dialogContainer,
          'scroll-to-call-site',
          { course, callId: trimmedCallId },
          { bubbles: true, composed: true },
        );
      } else {
        dispatchDomindsEvent(
          dialogContainer,
          'scroll-to-call-site',
          { course, messageIndex },
          { bubbles: true, composed: true },
        );
      }
    }

    // Focus the q4h-input for answering
    if (this.q4hInput) {
      this.q4hInput.selectQuestion(questionId);
      setTimeout(() => {
        this.q4hInput?.focusInput();
      }, 100);
    }
  }

  // Resize handle removed: input is resized via a dedicated handle inside `dominds-q4h-input`.
}

// Register the custom element
if (!customElements.get('dominds-app')) {
  customElements.define('dominds-app', DomindsApp);
}
