/**
 * Main application container component for Dominds WebUI
 */

import type { ConnectionState } from '@/services/store';
import faviconUrl from '../assets/favicon.svg';
import {
  formatContextUsageTitle,
  formatRemindersTitle,
  formatUiLanguageOptionLabel,
  formatUiLanguageTooltip,
  getUiLanguageMatchState,
  getUiStrings,
} from '../i18n/ui';
import type { FrontendTeamMember } from '../services/api';
import { getApiClient } from '../services/api';
import {
  makeWebSocketAuthProtocols,
  readAuthKeyFromLocalStorage,
  readAuthKeyFromUrl,
  removeAuthKeyFromUrl,
  writeAuthKeyToLocalStorage,
} from '../services/auth';
import { getWebSocketManager } from '../services/websocket.js';
import { DILIGENCE_FALLBACK_TEXT } from '../shared/diligence';
import type {
  ApiMoveDialogsRequest,
  ApiRootDialogResponse,
  DialogInfo,
  DialogStatusKind,
  ToolsetInfo,
  WorkspaceProblem,
} from '../shared/types';
import type { ContextHealthSnapshot } from '../shared/types/context-health';
import type {
  ContextHealthEvent,
  FullRemindersEvent,
  NewQ4HAskedEvent,
  Q4HAnsweredEvent,
  ReminderContent,
  SubdialogEvent,
  TypedDialogEvent,
} from '../shared/types/dialog';
import {
  formatLanguageName,
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '../shared/types/language';
import type { HumanQuestion, Q4HDialogContext } from '../shared/types/q4h';
import type { DialogRunState } from '../shared/types/run-state';
import type {
  DialogReadyMessage,
  DiligencePushUpdatedMessage,
  ErrorMessage,
  ProblemsSnapshotMessage,
  Q4HStateResponse,
  WebSocketMessage,
  WelcomeMessage,
} from '../shared/types/wire';
import { escapeHtml } from '../shared/utils/html.js';
import { bumpDialogsLastModified } from '../utils/dialog-last-modified';
import './archived-dialog-list.js';
import { ArchivedDialogList } from './archived-dialog-list.js';
import './dominds-dialog-container.js';
import { DomindsDialogContainer } from './dominds-dialog-container.js';
import './dominds-docs-panel';
import { renderDomindsMarkdown } from './dominds-markdown-render';
import './dominds-q4h-input';
import type { DomindsQ4HInput, Q4HQuestion } from './dominds-q4h-input';
import './dominds-q4h-panel';
import type { DomindsQ4HPanel } from './dominds-q4h-panel';
import './dominds-snippets-panel';
import './dominds-team-manual-panel';
import './dominds-team-members.js';
import { DomindsTeamMembers, type TeamMembersMentionEventDetail } from './dominds-team-members.js';
import './done-dialog-list.js';
import { DoneDialogList } from './done-dialog-list.js';
import './running-dialog-list.js';
import { RunningDialogList, type DialogCreateAction } from './running-dialog-list.js';

type ActivityView =
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'archived' }
  | { kind: 'search' }
  | { kind: 'team-members' }
  | { kind: 'tools' };

type AuthState =
  | { kind: 'uninitialized' }
  | { kind: 'none' }
  | { kind: 'active'; source: 'url' | 'localStorage' | 'manual'; key: string }
  | { kind: 'prompt'; reason: 'missing' | 'rejected' | 'ws_rejected'; hadUrlAuth: boolean };

export class DomindsApp extends HTMLElement {
  private wsManager = getWebSocketManager();
  private apiClient = getApiClient();
  private connectionState: ConnectionState = this.wsManager.getConnectionState();
  private authState: AuthState = { kind: 'uninitialized' };
  private urlAuthPresent: boolean = false;
  private dialogs: ApiRootDialogResponse[] = [];
  private dialogRunStatesByKey = new Map<string, DialogRunState>();
  private proceedingDialogsCount: number = 0;
  private resumableDialogsCount: number = 0;
  private generatingDialogKeys = new Set<string>();
  private currentDialog: DialogInfo | null = null; // Track currently selected dialog
  private currentDialogStatus: DialogStatusKind | null = null;
  private teamMembers: FrontendTeamMember[] = [];
  private defaultResponder: string | null = null;
  private taskDocuments: Array<{ path: string; relativePath: string; name: string }> = [];
  private currentTheme: 'light' | 'dark' = this.getCurrentTheme();
  private backendWorkspace: string = '';
  private toolbarCurrentCourse: number = 1;
  private toolbarTotalCourses: number = 1;
  private toolbarReminders: ReminderContent[] = [];
  private toolbarRemindersCollapsed: boolean = true;
  private contextHealthByDialogKey = new Map<string, ContextHealthSnapshot>();
  private toolbarContextHealth: ContextHealthSnapshot | null = null;
  private remindersWidgetVisible: boolean = false;
  private remindersWidgetX: number = 12;
  private remindersWidgetY: number = 120;
  private activityView: ActivityView = { kind: 'running' };
  private _wsEventCancel?: () => void;
  private _connStateCancel?: () => void;
  private subdialogContainers = new Map<string, HTMLElement>(); // Map dialogId -> container element
  private subdialogHierarchyRefreshTokens = new Map<string, number>();
  private authModal: HTMLElement | null = null;
  private uiLanguage: LanguageCode = this.getInitialUiLanguage();
  private serverWorkLanguage: LanguageCode | null = null;
  private uiLanguageMenuOpen: boolean = false;
  private _uiLanguageMenuGlobalCancel?: () => void;
  private bootInFlight: boolean = false;

  // Workspace Problems
  private problemsVersion: number = 0;
  private problems: WorkspaceProblem[] = [];
  private problemsPanelOpen: boolean = false;

  // Tools Registry (snapshot)
  private toolsRegistryTimestamp: string = '';
  private toolsRegistryToolsets: ToolsetInfo[] = [];

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

  private getStoredBottomPanelHeightPx(): number | null {
    try {
      const stored = localStorage.getItem('dominds-bottom-panel-height-px');
      if (!stored) return null;
      const parsed = Number(stored);
      if (!Number.isFinite(parsed)) return null;
      const asInt = Math.floor(parsed);
      if (asInt < 50 || asInt > 5000) return null;
      return asInt;
    } catch (error: unknown) {
      console.warn('Failed to read bottom panel height from localStorage', error);
      return null;
    }
  }

  private persistBottomPanelHeightPx(heightPx: number): void {
    try {
      localStorage.setItem('dominds-bottom-panel-height-px', String(Math.floor(heightPx)));
    } catch (error: unknown) {
      console.warn('Failed to persist bottom panel height to localStorage', error);
    }
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
  private diligencePushMax: number | null = null;
  private diligencePushLastShown: number | null = null;
  private diligenceRtwsText: string = '';
  private diligenceRtwsDirty: boolean = false;
  private diligenceRtwsSource: 'builtin' | 'workspace' = 'builtin';

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
    if (checkbox) checkbox.checked = !this.disableDiligencePush;

    const badges = diligenceTab.querySelectorAll('.bp-badge');
    const badge = badges.length > 0 ? (badges[badges.length - 1] as HTMLElement) : null;
    if (badge) {
      const max = this.diligencePushMax;
      if (typeof max === 'number' && Number.isFinite(max)) {
        const next = Math.min(99, Math.floor(max));
        badge.textContent = String(next);
        badge.setAttribute('data-has-remaining', next > 0 ? 'true' : 'false');
        if (this.diligencePushLastShown !== next) {
          this.diligencePushLastShown = next;
          badge.classList.remove('pulse');
          void badge.offsetWidth;
          badge.classList.add('pulse');
        }
      } else {
        badge.textContent = '—';
        badge.setAttribute('data-has-remaining', 'false');
        this.diligencePushLastShown = null;
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

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const storedHeight = this.getStoredBottomPanelHeightPx();
    if (storedHeight !== null) {
      const min = 120;
      const max = Math.max(min, Math.floor(window.innerHeight * 0.6));
      this.bottomPanelHeightPx = Math.max(min, Math.min(max, storedHeight));
      this.bottomPanelUserResized = true;
    }
  }

  private applyUiLanguageToDom(): void {
    if (!this.shadowRoot) return;

    const t = getUiStrings(this.uiLanguage);

    // Header + toolbar
    const logo = this.shadowRoot.querySelector('.logo') as HTMLAnchorElement | null;
    if (logo) {
      logo.title = t.logoGitHubTitle;
      logo.setAttribute('aria-label', t.logoGitHubTitle);
    }

    const workspace = this.shadowRoot.querySelector('.workspace-indicator') as HTMLElement | null;
    if (workspace) workspace.title = t.backendWorkspaceTitle;

    this.applyUiLanguageSelectDecorations(t);

    const themeBtn = this.shadowRoot.querySelector('#theme-toggle-btn') as HTMLButtonElement | null;
    if (themeBtn) themeBtn.title = t.themeToggleTitle;

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
      } else if (kind === 'tools') {
        btn.setAttribute('aria-label', t.activityTools);
        btn.title = t.activityTools;
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

    const newDialogBtn = this.shadowRoot.querySelector('#new-dialog-btn') as HTMLButtonElement;
    if (newDialogBtn) newDialogBtn.title = t.newDialogTitle;

    const dialogTitle = this.shadowRoot.querySelector(
      '#current-dialog-title',
    ) as HTMLElement | null;
    if (dialogTitle && this.currentDialog === null) {
      dialogTitle.textContent = t.currentDialogPlaceholder;
    }

    const prev = this.shadowRoot.querySelector('#toolbar-prev') as HTMLButtonElement | null;
    if (prev) prev.setAttribute('aria-label', t.previousCourse);
    const next = this.shadowRoot.querySelector('#toolbar-next') as HTMLButtonElement | null;
    if (next) next.setAttribute('aria-label', t.nextCourse);

    const remToggle = this.shadowRoot.querySelector(
      '#toolbar-reminders-toggle',
    ) as HTMLButtonElement | null;
    if (remToggle) remToggle.setAttribute('aria-label', t.reminders);
    const remRefresh = this.shadowRoot.querySelector(
      '#toolbar-reminders-refresh',
    ) as HTMLButtonElement | null;
    if (remRefresh) {
      remRefresh.setAttribute('aria-label', t.refreshReminders);
      remRefresh.title = t.refreshReminders;
    }

    const toolsRefresh = this.shadowRoot.querySelector(
      '#tools-registry-refresh',
    ) as HTMLButtonElement | null;
    if (toolsRefresh) {
      toolsRefresh.setAttribute('aria-label', t.toolsRefresh);
      toolsRefresh.title = t.toolsRefresh;
    }

    // Propagate to child components
    const conn = this.shadowRoot.querySelector('dominds-connection-status') as HTMLElement | null;
    if (conn) conn.setAttribute('ui-language', this.uiLanguage);

    const dialogContainer = this.shadowRoot.querySelector(
      '#dialog-container',
    ) as HTMLElement | null;
    if (dialogContainer) dialogContainer.setAttribute('ui-language', this.uiLanguage);

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
    if (docsPanel && 'setUiLanguage' in docsPanel) {
      const maybe = docsPanel as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
      if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
    }

    // Any open overlays should re-render to refresh static text.
    if (this.remindersWidgetVisible) {
      this.renderRemindersWidget();
      this.setupRemindersWidgetDrag();
    }
    this.updateCreateDialogModalText();
    this.updateAuthModalText();
    this.updateToolsRegistryUi();
    this.updateContextHealthUi();
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
    if (!this.shadowRoot) return;
    const modal = this.shadowRoot.querySelector('.create-dialog-modal') as HTMLElement | null;
    if (!modal) return;
    const t = getUiStrings(this.uiLanguage);

    const title = modal.querySelector('#modal-title') as HTMLElement | null;
    if (title) title.textContent = t.createNewDialogTitle;

    const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement | null;
    if (closeBtn) closeBtn.setAttribute('aria-label', t.close);

    const taskLabel = modal.querySelector('label[for="task-doc-input"]') as HTMLElement | null;
    if (taskLabel) taskLabel.textContent = t.taskDocumentLabel;

    const taskInput = modal.querySelector('#task-doc-input') as HTMLInputElement | null;
    if (taskInput) taskInput.placeholder = t.taskDocumentPlaceholder;

    const help = modal.querySelector('.form-help') as HTMLElement | null;
    if (help) help.textContent = t.taskDocumentHelp;

    const teammateLabel = modal.querySelector('label[for="teammate-select"]') as HTMLElement | null;
    if (teammateLabel) teammateLabel.textContent = t.teammateLabel;

    const shadowLabel = modal.querySelector(
      'label[for="shadow-teammate-select"]',
    ) as HTMLElement | null;
    if (shadowLabel) shadowLabel.textContent = t.shadowMembersLabel;

    const cancel = modal.querySelector('#modal-cancel-btn') as HTMLButtonElement | null;
    if (cancel) cancel.textContent = t.cancel;
    const create = modal.querySelector('#create-dialog-btn') as HTMLButtonElement | null;
    if (create) create.textContent = t.createDialog;
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

  private setupRemindersWidgetDrag(): void {
    const widget = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    const header = this.shadowRoot?.querySelector('#reminders-widget-header') as HTMLElement | null;
    const closeBtn = this.shadowRoot?.querySelector(
      '#reminders-widget-close',
    ) as HTMLElement | null;
    if (!widget || !header) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      this.remindersWidgetX = e.clientX - offsetX;
      this.remindersWidgetY = e.clientY - offsetY;
      widget.style.left = `${this.remindersWidgetX}px`;
      widget.style.top = `${this.remindersWidgetY}px`;
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    header.onmousedown = (e: MouseEvent) => {
      dragging = true;
      const rect = widget.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.remindersWidgetVisible = false;
        const existing = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
        if (existing) existing.remove();
      });
    }
  }
  connectedCallback(): void {
    this.initializeTheme();
    this.initializeAuth();
    this.initialRender();
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
        generatingDialogKeys: this.generatingDialogKeys,
      });
    }

    const doneList = this.shadowRoot.querySelector('#done-dialog-list');
    if (doneList instanceof DoneDialogList) {
      doneList.setProps({ onSelect, uiLanguage: this.uiLanguage });
    }

    const archivedList = this.shadowRoot.querySelector('#archived-dialog-list');
    if (archivedList instanceof ArchivedDialogList) {
      archivedList.setProps({ onSelect, uiLanguage: this.uiLanguage });
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
    this.renderDialogList();
    this.applyUiLanguageToDom();
    this.updateProblemsUi();
    this.updateToolsRegistryUi();
  }

  /**
   * Surgical update: Update only the dialog list without destroying the container.
   * Use this after dialog list changes (e.g., subdialog creation, dialog loading).
   */
  private updateDialogList(): void {
    this.renderDialogList();
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

  /**
   * Surgical update: Update only the workspace indicator text.
   * Use this when workspace info is loaded or changes.
   */
  private updateWorkspaceInfo(): void {
    const workspaceIndicator = this.shadowRoot?.querySelector('.workspace-indicator');
    if (workspaceIndicator) {
      workspaceIndicator.textContent = `📁 ${this.backendWorkspace || 'Unknown workspace'}`;
    }
  }

  /**
   * Surgical update: Update only the toolbar display elements.
   * Use this when dialog is loaded or course changes.
   */
  private updateToolbarDisplay(): void {
    const prevBtn = this.shadowRoot?.querySelector('#toolbar-prev') as HTMLButtonElement | null;
    const nextBtn = this.shadowRoot?.querySelector('#toolbar-next') as HTMLButtonElement | null;
    const remBtnCount = this.shadowRoot?.querySelector(
      '#toolbar-reminders-toggle span',
    ) as HTMLElement | null;
    const courseLabel = this.shadowRoot?.querySelector('#course-nav span') as HTMLElement | null;
    const stopCount = this.shadowRoot?.querySelector(
      '#toolbar-emergency-stop span',
    ) as HTMLElement | null;
    const resumeCount = this.shadowRoot?.querySelector(
      '#toolbar-resume-all span',
    ) as HTMLElement | null;
    const stopBtn = this.shadowRoot?.querySelector(
      '#toolbar-emergency-stop',
    ) as HTMLButtonElement | null;
    const resumeBtn = this.shadowRoot?.querySelector(
      '#toolbar-resume-all',
    ) as HTMLButtonElement | null;

    if (prevBtn) prevBtn.disabled = this.toolbarCurrentCourse <= 1;
    if (nextBtn) nextBtn.disabled = this.toolbarCurrentCourse >= this.toolbarTotalCourses;
    if (remBtnCount) remBtnCount.textContent = String(this.toolbarReminders.length);
    if (courseLabel) courseLabel.textContent = `C ${this.toolbarCurrentCourse}`;
    if (stopCount) stopCount.textContent = String(this.proceedingDialogsCount);
    if (resumeCount) resumeCount.textContent = String(this.resumableDialogsCount);
    if (stopBtn) stopBtn.disabled = this.proceedingDialogsCount === 0;
    if (resumeBtn) resumeBtn.disabled = this.resumableDialogsCount === 0;
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
    const el = this.shadowRoot?.querySelector('#toolbar-context-health');
    if (!(el instanceof HTMLElement)) return;

    const tooltip = this.shadowRoot?.querySelector('#toolbar-context-health-tooltip');

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

  private recomputeRunControlCounts(): void {
    let proceeding = 0;
    let resumable = 0;

    for (const d of this.dialogs) {
      if (d.status !== 'running') continue;
      const selfId = d.selfId ? d.selfId : d.rootId;
      const key = this.dialogKey(d.rootId, selfId);
      const state = this.dialogRunStatesByKey.get(key) ?? d.runState;
      if (!state) continue;

      if (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested') {
        proceeding++;
      } else if (state.kind === 'interrupted') {
        resumable++;
      }
    }

    this.proceedingDialogsCount = proceeding;
    this.resumableDialogsCount = resumable;
    this.updateToolbarDisplay();
  }

  public getStyles(): string {
    return `
      :host {
        display: block;
        width: 100%;
        height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        overflow: hidden;
        color-scheme: inherit;
      }

      .app-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
      }

	      .header {
	        display: flex;
	        align-items: flex-end;
	        justify-content: flex-start;
	        gap: 16px;
	        padding: 12px 16px;
	        background: var(--dominds-header-bg);
	        border-bottom: 1px solid var(--dominds-border);
	        flex-shrink: 0;
	      }

	      .logo {
	        display: flex;
	        align-items: center;
	        gap: 12px;
	        font-weight: 600;
	        font-size: 18px;
	        color: var(--dominds-primary, #007acc);
	        flex: none;
	        min-width: auto;
	        width: auto;
	        margin-right: 0;
	        text-decoration: none;
	      }

	      .workspace-indicator {
	        font-size: 11px;
	        color: var(--dominds-muted, #666666);
	        font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
	        background: var(--dominds-hover, #f8f9fa);
	        padding: 5px 8px;
	        border-radius: 4px;
	        border: 1px solid var(--dominds-border, #e0e0e0);
	        flex: 1;
	        max-width: 50%;
	        min-width: 0;
	        height: calc(1em * 1.4 * 0.85);
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

      

      .workspace-indicator::-webkit-scrollbar {
        height: 4px;
      }

      .workspace-indicator::-webkit-scrollbar-track {
        background: var(--dominds-hover, #f8f9fa);
      }

      .workspace-indicator::-webkit-scrollbar-thumb {
        background: var(--dominds-muted, #666666);
        border-radius: 2px;
      }

      .workspace-indicator::-webkit-scrollbar-thumb:hover {
        background: var(--dominds-fg, #333333);
      }

	      .header-actions {
	        display: flex;
	        align-items: center;
	        gap: 12px;
	        margin-left: auto;
	      }

      .header-run-controls {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .header-pill-button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px;
        border-radius: 16px;
        font-size: 12px;
        font-weight: 500;
        user-select: none;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .header-pill-button:hover:not(:disabled) {
        border-color: var(--dominds-primary, #007acc);
        background: var(--dominds-hover, #f0f0f0);
      }

      .header-pill-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
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

      #toolbar-emergency-stop:disabled {
        background: color-mix(in srgb, #22c55e 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #22c55e 22%, var(--dominds-border, #e0e0e0));
      }

      #toolbar-emergency-stop:not(:disabled) {
        background: color-mix(in srgb, #22c55e 55%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #22c55e 65%, var(--dominds-border, #e0e0e0));
        cursor: default;
      }

      #toolbar-emergency-stop span {
        color: var(--dominds-fg, #333333);
      }

      #toolbar-emergency-stop:not(:disabled) svg {
        cursor: pointer;
      }

      #toolbar-emergency-stop:hover:not(:disabled) {
        border-color: color-mix(in srgb, #22c55e 80%, var(--dominds-border, #e0e0e0));
      }

      #toolbar-resume-all:disabled {
        background: color-mix(in srgb, #ef4444 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #ef4444 22%, var(--dominds-border, #e0e0e0));
      }

      #toolbar-resume-all:not(:disabled) {
        background: color-mix(in srgb, #ef4444 55%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #ef4444 65%, var(--dominds-border, #e0e0e0));
        cursor: default;
      }

      #toolbar-resume-all span {
        color: var(--dominds-fg, #333333);
      }

      #toolbar-resume-all:not(:disabled) svg {
        cursor: pointer;
      }

      #toolbar-resume-all:hover:not(:disabled) {
        border-color: color-mix(in srgb, #ef4444 80%, var(--dominds-border, #e0e0e0));
      }

	      .header-pill-button.problems[data-severity='info'] {
	        background: var(--dominds-bg, #ffffff);
	        color: var(--dominds-fg, #333333);
	      }

	      .header-pill-button.problems[data-has-problems='true'][data-severity='info'] {
	        background: color-mix(in srgb, var(--dominds-primary, #007acc) 18%, var(--dominds-bg, #ffffff));
	        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 45%, var(--dominds-border, #e0e0e0));
	        color: color-mix(in srgb, var(--dominds-primary, #007acc) 85%, var(--dominds-fg, #333333));
	      }

      .header-pill-button.problems[data-severity='warning'] {
        background: color-mix(in srgb, #f59e0b 14%, var(--dominds-bg, #ffffff));
        border-color: color-mix(in srgb, #f59e0b 35%, var(--dominds-border, #e0e0e0));
        color: color-mix(in srgb, #b45309 85%, var(--dominds-fg, #333333));
      }

      .header-pill-button.problems[data-severity='error'] {
        background: var(--dominds-danger-bg, #f8d7da);
        border-color: var(--dominds-danger-border, #f5c6cb);
        color: var(--dominds-danger, #721c24);
      }

      #toolbar-context-health {
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

      #toolbar-context-health[data-level='healthy'] {
        color: var(--dominds-success, #155724);
      }

      #toolbar-context-health[data-level='caution'] {
        color: color-mix(in srgb, #b45309 85%, var(--dominds-fg, #333333));
      }

      #toolbar-context-health[data-level='critical'] {
        color: var(--dominds-danger, #721c24);
      }

      #toolbar-context-health[data-level='unknown'] {
        color: var(--dominds-muted, #666666);
      }

          .ctx-usage-svg {
            display: block;
          }

          .ctx-usage-ring {
            stroke: var(--dominds-border, #e0e0e0);
            stroke-width: 1.5;
          }

          #toolbar-context-health[data-level='unknown'] .ctx-usage-ring {
            stroke: var(--dominds-muted, #666666);
            opacity: 0.6;
          }

      .ctx-usage-wedge {
        fill: currentColor;
        opacity: 0.6;
      }

          .ctx-usage-mark-optimal {
            stroke: color-mix(in srgb, #f59e0b 85%, var(--dominds-fg, #333333));
            stroke-width: 1.2;
            opacity: 0.8;
          }

          .ctx-usage-mark-critical {
            stroke: var(--dominds-danger, #721c24);
            stroke-width: 1.2;
            opacity: 0.8;
          }
      #toolbar-context-health-wrap {
        display: inline-flex;
        align-items: center;
      }

      #toolbar-context-health-wrap .toolbar-tooltip {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        left: auto;
        transform: none;
        background: var(--dominds-fg, #333333);
        color: var(--dominds-bg, #ffffff);
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 11px;
        line-height: 1.25;
        text-align: left;
        width: max-content;
        white-space: pre-line;
        overflow-wrap: normal;
        max-width: min(420px, calc(100vw - 24px));
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
        z-index: 1000;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.2);
      }

      #toolbar-context-health-wrap .toolbar-tooltip::after {
        content: '';
        position: absolute;
        bottom: 100%;
        right: 6px;
        left: auto;
        transform: none;
        border: 6px solid transparent;
        border-bottom-color: var(--dominds-fg, #333333);
      }

      #toolbar-context-health-wrap:hover .toolbar-tooltip {
        opacity: 1;
      }

      .problems-panel {
        position: fixed;
        top: 68px;
        right: 12px;
        width: min(520px, calc(100vw - 24px));
        max-height: calc(100vh - 92px);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
        background: var(--dominds-bg, #ffffff);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
        overflow: hidden;
        z-index: 9999;
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
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-sidebar-bg, #f8f9fa);
      }

      .problems-panel-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .problems-panel-actions {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }

      .problems-panel-actions button {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }

      .problems-panel-actions button:hover {
        border-color: var(--dominds-primary, #007acc);
      }

	      .problems-list {
	        padding: 10px 12px;
	        overflow: auto;
	      }

	      .problems-list.empty {
	        display: flex;
	        flex-direction: column;
	        justify-content: center;
	        min-height: 96px;
	      }

      .problem-item {
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 8px;
        background: var(--dominds-bg, #ffffff);
      }

      .problem-item[data-severity='warning'] {
        border-color: color-mix(in srgb, #f59e0b 40%, var(--dominds-border, #e0e0e0));
      }

      .problem-item[data-severity='error'] {
        border-color: var(--dominds-danger-border, #f5c6cb);
        background: color-mix(in srgb, var(--dominds-danger-bg, #f8d7da) 35%, var(--dominds-bg, #ffffff));
      }

      .problem-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }

      .problem-message {
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .problem-meta {
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        white-space: nowrap;
      }

      .problem-detail {
        margin-top: 6px;
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .lang-select {
        height: 36px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 8px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        color: var(--dominds-fg, #333333);
        padding: 0 10px;
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
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
        top: calc(100% + 6px);
        right: 0;
        min-width: 320px;
        max-width: 420px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
        padding: 6px;
        z-index: 1000;
      }

      .ui-language-menu-item {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        text-align: left;
        padding: 10px 10px;
        border-radius: 8px;
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
        font-size: 12px;
        line-height: 1.3;
      }

      .ui-language-menu-item-tip {
        margin-top: 6px;
        margin-left: 12px;
        padding-left: 10px;
        border-left: 2px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 80%, transparent);
        color: var(--dominds-muted, #666666);
        font-size: 11px;
        line-height: 1.4;
        white-space: normal;
      }

      .ui-language-menu-item-tip p {
        margin: 0;
      }

      .ui-language-menu-item-tip ul,
      .ui-language-menu-item-tip ol {
        margin: 6px 0 0 0;
        padding-left: 18px;
      }

      .ui-language-menu-item-tip li {
        margin: 2px 0 0 0;
      }

      .ui-language-menu-button-caret {
        font-size: 10px;
        opacity: 0.7;
      }

      .theme-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 8px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        color: var(--dominds-fg, #333333);
        cursor: pointer;
        font-size: 16px;
        transition: all 0.2s ease;
      }

      .theme-toggle:hover {
        background: var(--dominds-hover, #f0f0f0);
        transform: scale(1.05);
      }

      .theme-toggle:active {
        transform: scale(0.95);
      }

      .main-content {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .sidebar {
        width: 300px;
        min-width: 200px;
        max-width: 600px;
        background: var(--dominds-sidebar-bg);
        border-right: 1px solid var(--dominds-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        resize: horizontal;
        position: relative;
      }

      .activity-bar {
        padding: 8px 10px;
        border-bottom: 1px solid var(--dominds-border);
        flex-shrink: 0;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 6px;
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
        overflow: hidden;
        padding: 0;
        display: flex;
        flex-direction: column;
      }

      .activity-view {
        flex: 1;
        overflow: hidden;
        padding: 8px 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .activity-placeholder {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
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
        margin-top: 6px;
      }

      .tools-registry {
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0;
        min-height: 0;
      }

      .tools-registry-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
      }

      .tools-registry-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .tools-registry-timestamp {
        flex: 1;
        text-align: center;
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tools-registry-actions button {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }

      .tools-registry-actions button:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .tools-registry-list {
        overflow: auto;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        padding: 8px;
      }

      .tools-section {
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
        background: var(--dominds-bg-secondary, #ffffff);
        overflow: hidden;
        margin-bottom: 10px;
      }

      .tools-section:last-child {
        margin-bottom: 0;
      }

      .tools-section-title {
        cursor: pointer;
        display: flex;
        align-items: center;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--dominds-fg, #333333) 4%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 70%, transparent);
        font-weight: 600;
        color: var(--dominds-muted, #666666);
        font-size: 11px;
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
        content: "▾";
        display: inline-block;
        width: 14px;
        margin-right: 6px;
        color: var(--dominds-muted, #666666);
      }

      details.tools-section:not([open]) > summary.tools-section-title::before {
        content: "▸";
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
        font-size: 12.5px;
        list-style: none;
      }

      .toolset-title::-webkit-details-marker {
        display: none;
      }

      details.toolset > summary.toolset-title::before {
        content: "▸";
        display: inline-block;
        width: 14px;
        margin-right: 6px;
        color: var(--dominds-muted, #666666);
      }

      details.toolset[open] > summary.toolset-title::before {
        content: "▾";
      }

      summary.toolset-title[data-desc]::after {
        content: attr(data-desc);
        display: block;
        margin-left: 20px;
        margin-top: 2px;
        font-weight: 400;
        color: var(--dominds-muted, #666666);
        font-size: 12px;
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
        border-radius: 10px;
        padding: 8px 10px;
        background: var(--dominds-bg, #ffffff);
      }

      .tool-main {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .tool-kind {
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        color: var(--dominds-muted, #666666);
        font-size: 11px;
        flex-shrink: 0;
      }

      .tool-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        color: var(--dominds-fg, #333333);
      }

      .tool-desc {
        margin-top: 4px;
        color: var(--dominds-muted, #666666);
        font-size: 12px;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tools-empty {
        padding: 8px 10px;
        color: var(--dominds-muted, #666666);
        font-size: 12px;
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

      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: var(--dominds-toolbar-bg, #f8f9fa);
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        flex-shrink: 0;
        position: relative;
      }

      .toolbar-left {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      #course-nav {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        gap: 4px;
      }

      #reminders-callout {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        border-radius: 6px;
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

      .badge-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        padding: 4px 8px;
        border-radius: 6px;
        cursor: pointer;
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
	      }

      /* Conversation area scrolls independently */
	      .conversation-scroll-area {
	        flex: 1;
	        min-height: 0;
	        overflow-y: auto;
	        contain: content;
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
	        background: var(--dominds-bg, #ffffff);
	      }

	      .bottom-panel-resize-handle {
	        height: 16px;
	        cursor: ns-resize;
	        display: flex;
	        align-items: center;
	        justify-content: center;
	        flex: none;
	        background: var(--dominds-bg, #ffffff);
	        border-top: 1px solid var(--color-border-primary, #e2e8f0);
	        touch-action: none;
	        user-select: none;
	      }

	      .bottom-panel-resize-handle.hidden {
	        display: none;
	      }

	      .bottom-panel-resize-handle::before {
	        content: '';
	        width: 44px;
	        height: 3px;
	        border-radius: 999px;
	        background: var(--dominds-border, #e0e0e0);
	      }

	      .bottom-panel-resize-handle:hover::before {
	        background: var(--dominds-primary, #007acc);
	      }

	      .bottom-panel-footer {
	        display: flex;
	        gap: 8px;
	        align-items: center;
	        padding: 8px 12px;
	        border-top: 1px solid var(--color-border-primary, #e2e8f0);
	        background: var(--color-bg-secondary, #f8fafc);
	      }

	      .bp-tabs-right {
	        display: inline-flex;
	        gap: 8px;
	        align-items: center;
	        margin-left: auto;
	      }

      .bp-tab {
        appearance: none;
        border: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--dominds-bg, #ffffff);
        color: var(--color-fg-secondary, #475569);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

	      .bp-tab.active {
	        border-color: var(--dominds-primary, #007acc);
	        color: var(--dominds-primary, #007acc);
	        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 15%, transparent);
	      }


	      .bp-checkbox {
	        width: 16px;
	        height: 16px;
	        margin: 0;
	        cursor: pointer;
	        accent-color: var(--dominds-primary, #007acc);
	      }

	      .bp-badge {
	        display: inline-flex;
	        min-width: 26px;
	        padding: 2px 8px;
	        border-radius: 999px;
	        background: var(--color-bg-tertiary, #f1f5f9);
	        color: var(--color-fg-tertiary, #64748b);
	        font-size: 11px;
	        border: 1px solid var(--color-border-primary, #e2e8f0);
	        justify-content: center;
	        text-align: center;
	        font-variant-numeric: tabular-nums;
	      }

	      .bp-badge.pulse {
	        animation: bpBadgePulse 220ms ease-out;
	      }

	      @keyframes bpBadgePulse {
	        0% { transform: scale(1); }
	        40% { transform: scale(1.12); }
	        100% { transform: scale(1); }
	      }

	      button.bp-tab[data-bp-tab='diligence'] .bp-badge {
	        width: 24px;
	        min-width: 24px;
	        padding: 2px 0;
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
	        padding: 18px 12px;
	        color: var(--color-fg-tertiary, #64748b);
	        font-size: 12px;
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
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--color-bg-secondary, #f8fafc);
      }

      .bp-diligence-help {
        flex: 1;
        font-size: 12px;
        color: var(--color-fg-tertiary, #64748b);
      }

	      .bp-textarea {
	        width: 100%;
	        box-sizing: border-box;
	        flex: 1;
	        min-height: 0;
	        padding: 10px 12px;
	        border: none;
	        outline: none;
	        resize: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
          'Courier New', monospace;
        font-size: 12px;
        line-height: 1.45;
        color: var(--color-fg-primary, #0f172a);
        background: var(--dominds-bg, #ffffff);
      }

	      .q4h-readonly-banner {
	        padding: 10px 12px;
	        border-top: 1px solid var(--dominds-border, #e0e0e0);
	        background: var(--dominds-toolbar-bg, #f8f9fa);
	        color: var(--dominds-muted, #666666);
	        font-size: 13px;
	      }

      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 200px;
        color: var(--dominds-muted, #666666);
      }

      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--dominds-border, #e0e0e0);
        border-top: 2px solid var(--dominds-primary, #007acc);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-right: 8px;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .button {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        background: var(--dominds-primary, #007acc);
        color: white;
        cursor: pointer;
        font-size: 14px;
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
        font-size: 12px;
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
          width: 280px;
          min-width: 240px;
          max-width: 400px;
        }

        .header {
          padding: 10px 12px;
        }

        .toolbar {
          padding: 8px 12px;
        }
      }

      @media (max-width: 480px) {
        .sidebar {
          position: absolute;
          left: -280px;
          transition: left 0.3s ease;
          z-index: 10;
          resize: none;
        }

        .sidebar.mobile-open {
          left: 0;
        }

        .workspace-indicator {
          font-size: 10px;
        }
      }

      /* Create Dialog Modal */
      .create-dialog-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
      }

      .modal-backdrop {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
      }

      .modal-content {
        position: relative;
        background: var(--dominds-bg, #ffffff);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
        min-width: 400px;
        max-width: 500px;
        width: 90vw;
        max-height: 85vh;
        overflow: visible;
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
        padding: 20px 24px 16px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
      }

      .modal-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .modal-close {
        background: none;
        border: none;
        font-size: 18px;
        cursor: pointer;
        color: var(--dominds-muted, #666666);
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s ease;
      }

      .modal-close:hover {
        background: var(--dominds-hover, #f5f5f5);
        color: var(--dominds-fg, #333333);
      }

      .modal-body {
        padding: 20px 24px;
      }

      .modal-description {
        margin: 0 0 20px 0;
        color: var(--dominds-muted, #666666);
        font-size: 14px;
        line-height: 1.5;
      }

      .form-group {
        margin-bottom: 16px;
      }

      .form-group label {
        display: block;
        margin-bottom: 6px;
        font-weight: 500;
        color: var(--dominds-fg, #333333);
        font-size: 14px;
      }

      .teammate-dropdown {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        font-size: 14px;
        transition: border-color 0.2s ease;
      }

      .teammate-dropdown:focus {
        outline: none;
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-focus, #007acc) 20%, transparent);
      }

      .teammate-info {
        margin-top: 16px;
        padding: 16px;
        background: var(--dominds-hover, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        display: none;
      }

      .task-doc-container {
        position: relative;
        width: 100%;
        box-sizing: border-box;
      }

      .task-doc-input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        font-size: 14px;
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
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-top: none;
        border-radius: 0 0 6px 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        max-height: 400px;
        overflow-y: auto;
        z-index: 1002;
        display: none;
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
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        margin-bottom: 2px;
        word-break: break-all;
      }

      .suggestion-name {
        font-size: 14px;
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
        font-size: 12px;
        color: var(--dominds-muted, #666666);
      }

      .teammate-details h4 {
        margin: 0 0 8px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
      }

      .teammate-details p {
        margin: 4px 0;
        font-size: 14px;
        color: var(--dominds-muted, #666666);
      }

      .teammate-details strong {
        color: var(--dominds-fg, #333333);
        font-weight: 500;
      }

      .modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        padding: 16px 24px 20px;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
      }

      .btn {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        min-width: 80px;
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

      /* Reminder widget items */
      .rem-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 8px;
        margin-bottom: 4px;
        background: var(--dominds-hover, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        font-size: 13px;
        line-height: 1.4;
        color: var(--dominds-fg, #333333);
        word-wrap: break-word;
        word-break: break-word;
      }

      .rem-item:hover {
        background: color-mix(in srgb, var(--dominds-hover) 80%, var(--dominds-fg) 20%);
      }

      .rem-item-number {
        font-weight: 600;
        color: var(--dominds-primary, #007acc);
        min-width: 16px;
        flex-shrink: 0;
        margin-top: 1px;
      }

      .rem-item-content {
        flex: 1;
        white-space: pre-wrap;
        word-break: break-word;
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
	          <a class="logo" href="https://github.com/longrun-ai/dominds" target="_blank" rel="noopener noreferrer" title="${t.logoGitHubTitle}" aria-label="${t.logoGitHubTitle}">
	            <img src="${faviconUrl}" width="20" height="20" alt="Dominds Logo" />
	            <span>Dominds</span>
	          </a>
	          <div class="workspace-indicator" title="${t.backendWorkspaceTitle}">
	            📁 ${this.backendWorkspace || t.backendWorkspaceLoading}
	          </div>
	          <div class="header-actions">
            <div class="header-run-controls">
              <button class="header-pill-button danger" id="toolbar-emergency-stop" title="${t.emergencyStop}" aria-label="${t.emergencyStop}" ${this.proceedingDialogsCount > 0 ? '' : 'disabled'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
                <span>${String(this.proceedingDialogsCount)}</span>
              </button>
              <button class="header-pill-button success" id="toolbar-resume-all" title="${t.resumeAll}" aria-label="${t.resumeAll}" ${this.resumableDialogsCount > 0 ? '' : 'disabled'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 3v18l17-9z"></path></svg>
                <span>${String(this.resumableDialogsCount)}</span>
              </button>
            </div>
	            <button class="header-pill-button problems" id="toolbar-problems-toggle" title="${t.problemsButtonTitle}" aria-label="${t.problemsButtonTitle}" data-severity="${this.getProblemsTopSeverity()}" data-has-problems="${this.problems.length > 0 ? 'true' : 'false'}">
	              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm0 6a1 1 0 0 1 1 1v6a1 1 0 0 1-2 0V9a1 1 0 0 1 1-1zm0 12a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 12 20z"></path></svg>
	              <span>${String(this.problems.length)}</span>
	            </button>
	            <dominds-connection-status ui-language="${this.uiLanguage}" status="${this.connectionState.status}" ${this.connectionState.error ? `error="${this.connectionState.error}"` : ''}></dominds-connection-status>
            <div class="ui-language-menu">
              <button id="ui-language-menu-button" class="lang-select" type="button" aria-haspopup="menu" aria-expanded="false" data-lang-match="${uiLanguageMatch.kind}" data-ui-language="${this.uiLanguage}" title="${t.uiLanguageSelectTitle}\n${uiLanguageButtonTooltip}">
                <span id="ui-language-menu-button-label">${uiLanguageButtonLabel}</span>
                <span class="ui-language-menu-button-caret">▾</span>
              </button>
              <div id="ui-language-menu" class="ui-language-menu-popover" role="menu" hidden>
                ${uiLanguageMenuItems}
              </div>
            </div>
            <button id="theme-toggle-btn" class="theme-toggle" title="${t.themeToggleTitle}">
              ${this.currentTheme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </header>

        <div id="problems-panel" class="problems-panel ${this.problemsPanelOpen ? '' : 'hidden'}" role="dialog" aria-label="${t.problemsTitle}">
          <div class="problems-panel-header">
            <div class="problems-panel-title">${t.problemsTitle}</div>
            <div class="problems-panel-actions">
              <button type="button" id="problems-refresh" title="Refresh">↻</button>
              <button type="button" id="problems-close" title="${t.close}">✕</button>
            </div>
          </div>
          <div id="problems-list" class="problems-list">
            ${this.renderProblemsListHtml()}
          </div>
        </div>

        <div class="main-content">
          <aside class="sidebar">
            <div class="activity-bar" role="toolbar" aria-label="${t.activityBarAriaLabel}">
              <button class="activity-button icon-button" data-activity="running" aria-label="${t.activityRunning}" aria-pressed="true" title="${t.activityRunning}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
              </button>
              <button class="activity-button icon-button" data-activity="done" aria-label="${t.activityDone}" aria-pressed="false" title="${t.activityDone}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14 9 11"></polyline></svg>
              </button>
              <button class="activity-button icon-button" data-activity="archived" aria-label="${t.activityArchived}" aria-pressed="false" title="${t.activityArchived}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
              </button>
              <div class="activity-spacer" aria-hidden="true"></div>
              <button class="activity-button icon-button" data-activity="search" aria-label="${t.activitySearch}" aria-pressed="false" title="${t.activitySearch}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              </button>
              <button class="activity-button icon-button" data-activity="team-members" aria-label="${t.activityTeamMembers}" aria-pressed="false" title="${t.activityTeamMembers}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-3-3.87"></path><path d="M7 21v-2a4 4 0 0 1 3-3.87"></path><circle cx="12" cy="7" r="4"></circle><path d="M18 8a3 3 0 1 0 0-6"></path><path d="M6 8a3 3 0 1 1 0-6"></path></svg>
              </button>
              <button class="activity-button icon-button" data-activity="tools" aria-label="${t.activityTools}" aria-pressed="false" title="${t.activityTools}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4.5 4.5 0 0 0 5.4-5.4l-2.2 2.2-2.2-2.2 2.4-2.4z"></path></svg>
              </button>
            </div>
            <div class="sidebar-content">
              <div class="activity-view" data-activity-view="running">
                <running-dialog-list 
                  id="running-dialog-list"
                  max-height="calc(100vh - 200px)"
                ></running-dialog-list>
              </div>
              <div class="activity-view hidden" data-activity-view="done">
                <done-dialog-list
                  id="done-dialog-list"
                  max-height="calc(100vh - 200px)"
                ></done-dialog-list>
              </div>
              <div class="activity-view hidden" data-activity-view="archived">
                <archived-dialog-list
                  id="archived-dialog-list"
                  max-height="calc(100vh - 200px)"
                ></archived-dialog-list>
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
              <div class="activity-view hidden" data-activity-view="tools">
                <div class="tools-registry">
                  <div class="tools-registry-header">
                    <div class="tools-registry-title">${t.toolsTitle}</div>
                    <span id="tools-registry-timestamp" class="tools-registry-timestamp"></span>
                    <div class="tools-registry-actions">
                      <button type="button" id="tools-registry-refresh" title="${t.toolsRefresh}">↻</button>
                    </div>
                  </div>
                  <div id="tools-registry-list" class="tools-registry-list"></div>
                </div>
              </div>
            </div>
          </aside>

          <main class="content-area">
            <div class="toolbar">
              <div class="toolbar-left">
                <button class="icon-button" id="new-dialog-btn" title="${t.newDialogTitle}">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
                <div id="current-dialog-title">${t.currentDialogPlaceholder}</div>
              </div>
              <div style="flex: 1;"></div>
	              <div id="course-nav">
	                <button class="icon-button" id="toolbar-prev" ${this.toolbarCurrentCourse > 1 ? '' : 'disabled'} aria-label="${t.previousCourse}">
	                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
	                </button>
	              <span style="margin: 0 8px; min-width: 28px; display:inline-block; text-align:center;">C ${this.toolbarCurrentCourse}</span>
	              <button class="icon-button" id="toolbar-next" ${this.toolbarCurrentCourse < this.toolbarTotalCourses ? '' : 'disabled'} aria-label="${t.nextCourse}">
	                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
	              </button>
		            </div>
                <div id="toolbar-context-health-wrap" style="position: relative; margin-left: 12px;">
	              <div class="badge-button" id="toolbar-context-health" data-level="unknown" aria-label="${contextUsageTitle}" style="">${this.renderContextUsageIcon(this.toolbarContextHealth)}</div>
                  <div class="toolbar-tooltip" id="toolbar-context-health-tooltip">${contextUsageTooltipText}</div>
                </div>
		          <div id="reminders-callout" style="position: relative; margin-left: 12px;">
		            <button class="badge-button" id="toolbar-reminders-toggle" aria-label="${t.reminders}">
		              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
		              <span>${String(this.toolbarReminders.length)}</span>
		            </button>
	            <button class="icon-button" id="toolbar-reminders-refresh" title="${t.refreshReminders}" aria-label="${t.refreshReminders}" style="margin-left:6px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path></svg>
            </button>
          </div>
            </div>
            ${
              this.remindersWidgetVisible
                ? `
            <div id="reminders-widget" style="position: fixed; left: ${this.remindersWidgetX}px; top: ${this.remindersWidgetY}px; width: 320px; max-height: 50vh; overflow: auto; border: 1px solid var(--dominds-border); background: var(--dominds-bg); border-radius: 10px; box-shadow: 0 8px 16px rgba(0,0,0,0.2); z-index: 2000;">
              <div id="reminders-widget-header" style="display:flex; align-items:center; justify-content: space-between; gap:8px; padding:8px 10px; border-bottom: 1px solid var(--dominds-border); cursor: grab;">
                <div style="display:flex; align-items:center; gap:8px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                  <span>${formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length)}</span>
                </div>
                <button id="reminders-widget-close" class="icon-button" aria-label="${t.close}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>
              <div id="reminders-widget-content" style="padding:8px 10px;">
                ${
                  this.toolbarReminders.length === 0
                    ? `<div style="color: var(--dominds-muted); font-style: italic; text-align: center; padding: 12px;">${t.noReminders}</div>`
                    : '<div class="reminders-widget-content"></div>'
                }
              </div>
            </div>
            `
                : ''
            }

            <div class="dialog-section">
              <div class="conversation-scroll-area">
                <dominds-dialog-container id="dialog-container" ui-language="${this.uiLanguage}"></dominds-dialog-container>
              </div>
	              <div class="bottom-panel ${this.bottomPanelExpanded ? 'expanded' : 'collapsed'}" id="bottom-panel">
	                <div class="bottom-panel-resize-handle ${this.bottomPanelExpanded ? '' : 'hidden'}" id="bottom-panel-resize-handle" role="separator" aria-orientation="horizontal"></div>
	                <div class="bottom-panel-content" id="bottom-panel-content">
	                  <div class="bp-content bp-q4h ${this.bottomPanelTab === 'q4h' ? '' : 'hidden'}">
	                    <div class="bp-q4h-empty ${this.q4hQuestionCount === 0 ? '' : 'hidden'}">${t.q4hNoPending}</div>
	                    <dominds-q4h-panel id="q4h-panel" class="${this.q4hQuestionCount === 0 ? 'hidden' : ''}"></dominds-q4h-panel>
	                  </div>
	                  <div class="bp-content bp-diligence ${this.bottomPanelTab === 'diligence' ? '' : 'hidden'}">
	                    <div class="bp-diligence-row">
	                      <div class="bp-diligence-help">${t.keepGoingWorkspaceNote}</div>
	                      <button class="icon-button" id="diligence-reload" type="button" title="${t.keepGoingReloadTitle}" aria-label="${t.keepGoingReloadTitle}">
	                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 16.5a4.5 4.5 0 0 0-1.9-8.7 6 6 0 0 0-11.7 1.7A4 4 0 0 0 4 16.5"></path><path d="M12 12v9"></path><path d="m8 17 4 4 4-4"></path></svg>
	                      </button>
	                      <button class="icon-button" id="diligence-save" type="button" ${this.diligenceRtwsDirty ? '' : 'disabled'} title="${t.keepGoingSaveTitle}" aria-label="${t.keepGoingSaveTitle}">
	                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
	                      </button>
	                      <button class="icon-button" id="diligence-reset" type="button" title="${t.keepGoingResetTitle}" aria-label="${t.keepGoingResetTitle}">
	                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path></svg>
	                      </button>
	                    </div>
	                    <textarea id="diligence-textarea" class="bp-textarea" spellcheck="false"></textarea>
	                  </div>
	                  <div class="bp-content bp-docs ${this.bottomPanelTab === 'docs' ? '' : 'hidden'}">
	                    <dominds-docs-panel id="docs-panel"></dominds-docs-panel>
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
	                    ${t.q4hPendingQuestions}
	                  </button>
	                  <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'diligence' ? 'active' : ''}" type="button" data-bp-tab="diligence">
	                    <input
	                      id="diligence-toggle"
	                      class="bp-checkbox"
	                      type="checkbox"
	                      aria-label="${t.keepGoingToggleAriaLabel}"
	                      ${this.disableDiligencePush ? '' : 'checked'}
	                    />
	                    <span>${t.keepGoingTabTitle}</span>
	                    <span class="bp-badge" data-has-remaining="${
                        typeof this.diligencePushMax === 'number' &&
                        Number.isFinite(this.diligencePushMax) &&
                        Math.floor(this.diligencePushMax) > 0
                          ? 'true'
                          : 'false'
                      }">${
                        typeof this.diligencePushMax === 'number' &&
                        Number.isFinite(this.diligencePushMax)
                          ? String(Math.min(99, Math.floor(this.diligencePushMax)))
                          : '—'
                      }</span>
	                  </button>
	                  <div class="bp-tabs-right">
	                    <button class="bp-tab ${this.bottomPanelExpanded && this.bottomPanelTab === 'snippets' ? 'active' : ''}" type="button" data-bp-tab="snippets">${t.promptTemplatesTabTitle}</button>
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

    // Set up WebSocket event handlers using (Pub/Sub)Chan pattern
    this.setupWebSocketEventHandlers();

    // Toast relay from child components (e.g., dialog-container)
    this.shadowRoot.addEventListener('ui-toast', (e: Event) => {
      const ce = e as CustomEvent<{ message: string; kind?: 'error' | 'warning' | 'info' }>;
      const msg = ce.detail?.message || 'Notice';
      const kind = ce.detail?.kind || 'error';
      this.showToast(msg, kind);
    });

    // Auth escalation from child panels (HTTP 401)
    this.shadowRoot.addEventListener('auth-required', () => {
      this.onAuthRejected('api');
    });

    // Template insertion from snippets panel
    this.shadowRoot.addEventListener('snippet-insert', (e: Event) => {
      const ce = e as CustomEvent<unknown>;
      const detail =
        ce.detail && typeof ce.detail === 'object' ? (ce.detail as Record<string, unknown>) : null;
      const content = detail && typeof detail['content'] === 'string' ? detail['content'] : '';
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
    this.shadowRoot.addEventListener('input-error', (e: Event) => {
      const ce = e as CustomEvent<{ message: string; type?: 'error' | 'warning' | 'info' }>;
      const msg = ce.detail?.message || 'Input error';
      const kind = ce.detail?.type || 'error';
      this.showToast(msg, kind);
    });

    // Reminder events from dialog-container
    this.shadowRoot.addEventListener('reminders-update', (e: Event) => {
      this.updateRemindersWidget();
    });

    this.shadowRoot.addEventListener('reminder-text', (e: Event) => {
      const ce = e as CustomEvent<{ index: number; content: string }>;
      this.toolbarReminders[ce.detail.index] = { content: ce.detail.content };
      this.updateRemindersWidget();
    });

    // Dialog list expand (lazy subdialog loading) across all list views
    this.shadowRoot.addEventListener('dialog-expand', ((event: Event) => {
      const ce = event as CustomEvent<{ rootId?: string }>;
      const rootId = ce.detail ? ce.detail.rootId : undefined;
      if (typeof rootId === 'string' && rootId) {
        void this.loadSubdialogsForRoot(rootId);
      }
    }) as EventListener);

    // Team members events from dominds-team-members (sidebar activity)
    this.shadowRoot.addEventListener('team-members-refresh', () => {
      void this.loadTeamMembers();
    });

    this.shadowRoot.addEventListener('team-member-mention', (event: Event) => {
      const ce = event as CustomEvent<TeamMembersMentionEventDetail>;
      const detail = ce.detail;
      const mention = detail && typeof detail.mention === 'string' ? detail.mention : '';
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

    // Highlight dialogs under active LLM generation (streaming) in the running list.
    this.shadowRoot.addEventListener('dlg-generation-state', (event: Event) => {
      const ce = event as CustomEvent<unknown>;
      const detail = ce.detail as { rootId?: unknown; selfId?: unknown; active?: unknown } | null;

      const rootId = detail && typeof detail.rootId === 'string' ? detail.rootId : '';
      const selfId = detail && typeof detail.selfId === 'string' ? detail.selfId : '';
      const active = detail && typeof detail.active === 'boolean' ? detail.active : false;
      if (!rootId || !selfId) return;

      const key = this.dialogKey(rootId, selfId);
      if (active) {
        this.generatingDialogKeys.add(key);
      } else {
        this.generatingDialogKeys.delete(key);
      }

      const sr = this.shadowRoot;
      if (!sr) return;
      const runningList = sr.querySelector('#running-dialog-list');
      if (runningList instanceof RunningDialogList) {
        runningList.setProps({ generatingDialogKeys: this.generatingDialogKeys });
      }
    });

    // Dialog status actions (mark done/archive/revive) across all list views
    this.shadowRoot.addEventListener('dialog-status-action', ((event: Event) => {
      const ce = event as CustomEvent<unknown>;
      void this.handleDialogStatusAction(ce.detail);
    }) as EventListener);

    // Dialog creation shortcuts (create new dialog from task/root nodes)
    this.shadowRoot.addEventListener('dialog-create-action', ((event: Event) => {
      const ce = event as CustomEvent<unknown>;
      void this.handleDialogCreateAction(ce.detail);
    }) as EventListener);

    // Dialog deletion actions (delete root dialogs) across done/archived list views
    this.shadowRoot.addEventListener('dialog-delete-action', ((event: Event) => {
      const ce = event as CustomEvent<unknown>;
      void this.handleDialogDeleteAction(ce.detail);
    }) as EventListener);

    // ========== Q4H Event Handlers ==========
    // Q4H navigate to call site event - delegated to q4h-input component
    this.shadowRoot.addEventListener('q4h-navigate-call-site', (event: Event) => {
      const ce = event as CustomEvent<{
        questionId: string;
        dialogId: string;
        rootId: string;
        course: number;
        messageIndex: number;
      }>;
      const { questionId, dialogId, rootId, course, messageIndex } = ce.detail || {};
      if (questionId && dialogId && rootId) {
        this.navigateToQ4HCallSite(questionId, dialogId, rootId, course, messageIndex);
      }
    });

    // Q4H selection event from the inline panel - keeps q4h-input selection in sync so answers
    // are routed to the intended question/dialog context.
    this.shadowRoot.addEventListener('q4h-select-question', (event: Event) => {
      const ce = event as CustomEvent<{
        questionId: string | null;
        dialogId: string;
        rootId: string;
        headLine: string;
        bodyContent: string;
      }>;
      const questionId = ce.detail?.questionId ?? null;
      const dialogId = ce.detail?.dialogId;
      const rootId = ce.detail?.rootId;
      const input = this.q4hInput;
      if (!input) return;
      if (
        questionId &&
        typeof dialogId === 'string' &&
        typeof rootId === 'string' &&
        dialogId &&
        rootId
      ) {
        input.setDialog({ selfId: dialogId, rootId });
      } else if (!questionId && this.currentDialog) {
        input.setDialog({ selfId: this.currentDialog.selfId, rootId: this.currentDialog.rootId });
      }
      // Avoid infinite recursion: `DomindsQ4HInput.selectQuestion()` dispatches
      // `q4h-select-question`, which bubbles to this handler.
      if (!event.composedPath().includes(input)) {
        input.selectQuestion(questionId);
      }
      if (questionId) {
        setTimeout(() => {
          const current = this.q4hInput;
          if (current && current === input) current.focusInput();
        }, 100);
      }
    });

    // ========== Delegated Click Handlers ==========
    this.shadowRoot.addEventListener('click', async (evt: Event) => {
      const target = evt.target as HTMLElement | null;
      if (!target) return;

      // New dialog button
      if (target.id === 'new-dialog-btn' || target.closest('#new-dialog-btn')) {
        this.handleNewDialog();
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
          case 'tools':
            this.activityView = { kind: 'tools' };
            this.updateActivityView();
            // Clear cached view so we don't show stale tools while fetching.
            this.toolsRegistryToolsets = [];
            this.toolsRegistryTimestamp = '';
            this.updateToolsRegistryUi();
            void this.loadToolsRegistry();
            return;
        }
      }

      const toolsRefresh = target.closest('#tools-registry-refresh') as HTMLButtonElement | null;
      if (toolsRefresh) {
        this.toolsRegistryToolsets = [];
        this.toolsRegistryTimestamp = '';
        this.updateToolsRegistryUi();
        void this.loadToolsRegistry();
        return;
      }

      // Toolbar navigation
      const prevBtn = target.closest('#toolbar-prev') as HTMLButtonElement | null;
      if (prevBtn) {
        if (this.toolbarCurrentCourse > 1) {
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.setCurrentCourse === 'function') {
            await dc.setCurrentCourse(this.toolbarCurrentCourse - 1);
          }
          this.toolbarCurrentCourse = Math.max(1, this.toolbarCurrentCourse - 1);
          this.updateToolbarCourseDisplay();
        }
        return;
      }

      const nextBtn = target.closest('#toolbar-next') as HTMLButtonElement | null;
      if (nextBtn) {
        if (this.toolbarCurrentCourse < this.toolbarTotalCourses) {
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.setCurrentCourse === 'function') {
            await dc.setCurrentCourse(this.toolbarCurrentCourse + 1);
          }
          this.toolbarCurrentCourse = Math.min(
            this.toolbarTotalCourses,
            this.toolbarCurrentCourse + 1,
          );
          this.updateToolbarCourseDisplay();
        }
        return;
      }

      const problemsToggle = target.closest('#toolbar-problems-toggle') as HTMLButtonElement | null;
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

      // Reminders toggle
      const remToggle = target.closest('#toolbar-reminders-toggle') as HTMLButtonElement | null;
      if (remToggle) {
        this.toggleRemindersWidget();
        return;
      }

      // Reminders refresh
      const remRefresh = target.closest('#toolbar-reminders-refresh') as HTMLButtonElement | null;
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
      const emergencyStop = target.closest('#toolbar-emergency-stop') as HTMLButtonElement | null;
      if (emergencyStop) {
        const emergencyStopIcon = target.closest('#toolbar-emergency-stop svg');
        if (!emergencyStopIcon) return;

        if (this.proceedingDialogsCount > 0) {
          const ok = window.confirm(
            `${getUiStrings(this.uiLanguage).emergencyStop} (${this.proceedingDialogsCount})?`,
          );
          if (ok) {
            this.wsManager.sendRaw({ type: 'emergency_stop' });
          }
        }
        return;
      }

      const resumeAll = target.closest('#toolbar-resume-all') as HTMLButtonElement | null;
      if (resumeAll) {
        const resumeAllIcon = target.closest('#toolbar-resume-all svg');
        if (!resumeAllIcon) return;

        if (this.resumableDialogsCount > 0) {
          this.wsManager.sendRaw({ type: 'resume_all' });
        }
        return;
      }
    });

    // Listen for dialog-selected events from dialog list (delegated)
    this.shadowRoot.addEventListener('dialog-selected', async (event: Event) => {
      const customEvent = event as CustomEvent<{ dialog: DialogInfo }>;
      const dialog = customEvent.detail?.dialog;
      if (dialog && dialog.selfId) {
        await this.selectDialog(dialog);
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

  /**
   * Helper to update the toolbar course navigation display
   */
  private updateToolbarCourseDisplay(): void {
    if (!this.shadowRoot) return;
    const prev = this.shadowRoot.querySelector('#toolbar-prev') as HTMLButtonElement;
    const next = this.shadowRoot.querySelector('#toolbar-next') as HTMLButtonElement;
    if (prev) prev.disabled = !(this.toolbarCurrentCourse > 1);
    if (next) next.disabled = !(this.toolbarCurrentCourse < this.toolbarTotalCourses);
    const label = this.shadowRoot.querySelector('#course-nav span') as HTMLElement;
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
      dialogContainerEl.addEventListener('course-selected', (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        const course = detail.course;
        const totalCourses = detail.totalCourses;
        const latest = typeof totalCourses === 'number' ? totalCourses : course;
        this.toolbarCurrentCourse = course || this.toolbarCurrentCourse;
        this.toolbarTotalCourses = latest || this.toolbarTotalCourses;
        this.updateToolbarCourseDisplay();

        const input = this.q4hInput as HTMLElement & {
          setDisabled?: (disabled: boolean) => void;
        };
        if (input && typeof input.setDisabled === 'function') {
          input.setDisabled(course !== latest);
        }
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
      bottomPanelResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.bottomPanelExpanded) {
          setBottomPanelExpanded(true);
        }
        this.bottomPanelIsResizing = true;
        this.bottomPanelResizeStartY = e.clientY;
        this.bottomPanelResizeStartHeight = this.bottomPanelHeightPx;
        this.bottomPanelResizeLastHeight = this.bottomPanelHeightPx;

        let hasPointerCapture = false;
        try {
          bottomPanelResizeHandle.setPointerCapture(e.pointerId);
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

          bottomPanelResizeHandle.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointermove', onMove);
          try {
            bottomPanelResizeHandle.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }

          bottomPanelResizeHandle.removeEventListener('pointerup', onUp);
          bottomPanelResizeHandle.removeEventListener('pointercancel', onUp);
          bottomPanelResizeHandle.removeEventListener('lostpointercapture', onUp);
          window.removeEventListener('pointerup', onUp);

          if (this.bottomPanelUserResized) {
            this.persistBottomPanelHeightPx(this.bottomPanelHeightPx);
          }
        };

        bottomPanelResizeHandle.addEventListener('pointermove', onMove);
        if (!hasPointerCapture) {
          window.addEventListener('pointermove', onMove);
        }
        bottomPanelResizeHandle.addEventListener('pointerup', onUp);
        bottomPanelResizeHandle.addEventListener('pointercancel', onUp);
        bottomPanelResizeHandle.addEventListener('lostpointercapture', onUp);

        // Fallback: in some browsers, pointerup may not be delivered to the capture element
        // if the pointer is released outside the window.
        window.addEventListener('pointerup', onUp);
      });
    }

    this.shadowRoot.addEventListener('q4h-question-expanded', (event: Event) => {
      if (!bottomPanel) return;
      setBottomPanelExpanded(true);
      if (this.bottomPanelUserResized) return;
      const ce = event as CustomEvent<unknown>;
      const detail =
        ce.detail && typeof ce.detail === 'object' ? (ce.detail as { questionId?: unknown }) : null;
      const questionId = detail && typeof detail.questionId === 'string' ? detail.questionId : '';
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
      if (docs && 'setUiLanguage' in docs) {
        const maybe = docs as unknown as { setUiLanguage?: (lang: LanguageCode) => void };
        if (typeof maybe.setUiLanguage === 'function') maybe.setUiLanguage(this.uiLanguage);
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
    const next = !this.disableDiligencePush;
    this.disableDiligencePush = next;
    this.updateBottomPanelFooterUi();
    this.wsManager.sendRaw({
      type: 'set_diligence_push',
      dialog: { selfId: this.currentDialog.selfId, rootId: this.currentDialog.rootId },
      disableDiligencePush: next,
    });
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
    this.diligenceRtwsSource = payload.source === 'workspace' ? 'workspace' : 'builtin';
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

    // After deleting workspace overrides, reload to display builtin fallback.
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

    // Q4H state will be loaded when WebSocket connection is established
    // See handleConnectionStateChange() for Q4H request on connect

    // Load workspace info, dialogs, team members, and task documents
    await Promise.all([
      this.loadWorkspaceInfo(),
      this.loadDialogs(),
      this.loadTeamMembers(),
      this.loadTaskDocuments(),
    ]);
  }

  private async bootstrap(): Promise<void> {
    if (this.bootInFlight) return;
    this.bootInFlight = true;
    try {
      const gate = await this.gateBySetup();
      if (gate.kind !== 'proceed') return;
      await this.loadInitialData();
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
    modal.className = 'create-dialog-modal';
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
          <div class="form-group">
            <label for="auth-key-input">${t.authKeyLabel}</label>
            <input type="password" id="auth-key-input" class="task-doc-input" placeholder="${t.authKeyPlaceholder}" autocomplete="off">
          </div>
          <div class="form-group" id="auth-modal-error" style="display:none;color:var(--dominds-danger,#dc3545);font-size:13px;"></div>
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

      const probe = await this.apiClient.getHealth();
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
      const resp = await api.getRootDialogs();

      if (resp.success && Array.isArray(resp.data)) {
        // Store root dialogs with their subdialog counts
        // Subdialogs will be loaded lazily when user expands a root dialog
        this.dialogs = resp.data;
        this.dialogRunStatesByKey.clear();
        for (const d of this.dialogs) {
          const selfId = d.selfId ? d.selfId : d.rootId;
          if (d.runState) {
            this.dialogRunStatesByKey.set(this.dialogKey(d.rootId, selfId), d.runState);
          }
        }
        this.recomputeRunControlCounts();
        if (this.currentDialog) {
          const status = this.resolveDialogStatus(this.currentDialog);
          if (status === null) {
            this.clearCurrentDialogSelection();
          } else {
            this.currentDialogStatus = status;
          }
        } else {
          this.currentDialogStatus = null;
        }
        this.renderDialogList();
        this.updateQ4HComponent();
        this.updateInputPanelVisibility();
      } else {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        console.warn('Failed to load dialogs via API', resp.error);
      }
    } catch (error) {
      console.error('Error in loadDialogs:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load dialogs: ${message}`, 'error');
    }
  }

  private clearCurrentDialogSelection(): void {
    this.currentDialog = null;
    this.currentDialogStatus = null;

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
      this.q4hInput.setRunState(null);
    }
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

    const resp = await this.apiClient.deleteDialog(rootId);
    if (!resp.success) {
      if (resp.status === 401) {
        this.onAuthRejected('api');
        return;
      }
      this.showToast(resp.error || 'Failed to delete dialog', 'error');
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

    let request: ApiMoveDialogsRequest;
    if (kind === 'root') {
      const rootId = (detail as { rootId?: unknown }).rootId;
      if (typeof rootId !== 'string' || rootId.trim() === '') return;
      request = {
        kind: 'root',
        rootId,
        fromStatus: fromStatus as DialogStatusKind,
        toStatus: toStatus as DialogStatusKind,
      };
    } else {
      const taskDocPath = (detail as { taskDocPath?: unknown }).taskDocPath;
      if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') return;
      request = {
        kind: 'task',
        taskDocPath,
        fromStatus: fromStatus as DialogStatusKind,
        toStatus: toStatus as DialogStatusKind,
      };
    }

    try {
      const resp = await this.apiClient.moveDialogs(request);
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        this.showToast(resp.error || 'Failed to move dialogs', 'error');
        return;
      }
      const payload = resp.data;
      if (!payload || !payload.success) {
        const msg = payload && payload.error ? payload.error : 'Failed to move dialogs';
        this.showToast(msg, 'error');
        return;
      }

      const movedCount = Array.isArray(payload.movedRootIds) ? payload.movedRootIds.length : 0;
      this.showToast(`Moved ${movedCount} dialog(s).`, 'info');

      // Optimistic in-memory update so UI reacts immediately (no waiting on loadDialogs()).
      const movedRootIds = Array.isArray(payload.movedRootIds) ? payload.movedRootIds : [];
      if (movedRootIds.length > 0) {
        const moved = new Set(movedRootIds);
        let didUpdate = false;
        this.dialogs = (this.dialogs || []).map((d) => {
          if (!moved.has(d.rootId)) return d;
          if (d.status === toStatus) return d;
          didUpdate = true;
          return { ...d, status: toStatus };
        });
        if (didUpdate) {
          this.updateDialogList();
          if (this.currentDialog) {
            this.currentDialogStatus = this.resolveDialogStatus(this.currentDialog);
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
        this.currentDialogStatus = this.resolveDialogStatus(this.currentDialog);
      } else {
        this.currentDialogStatus = null;
      }
      this.updateInputPanelVisibility();
      this.updateQ4HComponent();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showToast(`Failed to move dialogs: ${message}`, 'error');
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

      if (this.teamMembers.length === 0) {
        console.error('❌ No team members available');
        this.showError('No team members available. Please check your team configuration.');
        return;
      }

      this.showCreateDialogModal({ taskDocPath });
      return;
    }

    const agentId = (detail as { agentId?: unknown }).agentId;
    const taskDocPath = (detail as { taskDocPath?: unknown }).taskDocPath;
    if (typeof agentId !== 'string' || agentId.trim() === '') return;
    if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') return;
    await this.createDialog(agentId, taskDocPath);
  }

  /**
   * Lazy load subdialogs for a root dialog when user expands it
   */
  private async loadSubdialogsForRoot(rootId: string): Promise<void> {
    try {
      const api = getApiClient();
      const hierarchyResp = await api.getDialogHierarchy(rootId);

      if (!hierarchyResp.success) {
        if (hierarchyResp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
      }

      if (hierarchyResp.success && hierarchyResp.data) {
        const h = hierarchyResp.data;
        // h is {root: {...}, subdialogs: [...]}

        if (Array.isArray(h.subdialogs)) {
          const cachedRootRunState = this.dialogRunStatesByKey.get(this.dialogKey(rootId, rootId));
          const rootRunState = h.root.runState ?? cachedRootRunState;
          if (rootRunState) {
            this.dialogRunStatesByKey.set(this.dialogKey(rootId, rootId), rootRunState);
          }

          let didUpdateRoot = false;
          this.dialogs = (this.dialogs || []).map((d) => {
            if (d.rootId !== rootId) return d;
            if (d.selfId) return d;
            didUpdateRoot = true;
            return {
              ...d,
              agentId: h.root.agentId,
              taskDocPath: h.root.taskDocPath,
              status: h.root.status,
              currentCourse: h.root.currentCourse,
              createdAt: h.root.createdAt,
              lastModified: h.root.lastModified,
              runState: rootRunState ?? d.runState,
            };
          });

          const newSubdialogs: ApiRootDialogResponse[] = [];

          for (const subdialog of h.subdialogs) {
            if (subdialog && subdialog.rootId) {
              const cachedRunState = this.dialogRunStatesByKey.get(
                this.dialogKey(subdialog.rootId, subdialog.selfId),
              );
              const effectiveRunState = subdialog.runState ?? cachedRunState;
              if (effectiveRunState) {
                this.dialogRunStatesByKey.set(
                  this.dialogKey(subdialog.rootId, subdialog.selfId),
                  effectiveRunState,
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
                runState: effectiveRunState,
                supdialogId: rootId, // Link to parent
                tellaskSession: subdialog.tellaskSession,
              });
            }
          }

          const incomingByKey = new Map<string, ApiRootDialogResponse>();
          for (const incoming of newSubdialogs) {
            incomingByKey.set(`${incoming.rootId}:${incoming.selfId ?? ''}`, incoming);
          }

          let didMerge = false;
          const mergedDialogs = (this.dialogs || []).map((d) => {
            if (!d.selfId) return d;
            if (d.supdialogId !== rootId) return d;
            const incoming = incomingByKey.get(`${d.rootId}:${d.selfId}`);
            if (!incoming) return d;
            incomingByKey.delete(`${d.rootId}:${d.selfId}`);
            didMerge = true;
            return {
              ...d,
              ...incoming,
              runState: incoming.runState ?? d.runState,
            };
          });

          const toAppend = Array.from(incomingByKey.values());
          if (toAppend.length > 0) {
            didMerge = true;
          }

          if (didUpdateRoot || didMerge) {
            this.dialogs = [...mergedDialogs, ...toAppend];
            this.renderDialogList();
          }
        }
      }
    } catch (hierarchyError) {
      console.warn(`Failed to load hierarchy for root dialog ${rootId}:`, hierarchyError);
    }
  }

  private async loadTeamMembers(): Promise<void> {
    const teamMembersEl = this.shadowRoot ? this.shadowRoot.querySelector('#team-members') : null;
    const teamMembersComponent = teamMembersEl instanceof DomindsTeamMembers ? teamMembersEl : null;
    if (teamMembersComponent) teamMembersComponent.setLoading(true);
    try {
      const api = getApiClient();
      const resp = await api.getTeamConfig();
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        console.warn('Failed to load team config via API', resp.error);
        return;
      }
      const cfg = resp.data?.configuration;
      if (!cfg) return;

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

      if (this.teamMembers.length === 0) {
        this.showWarning('No team members configured');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load team members: ${message}`, 'warning');
    } finally {
      if (teamMembersComponent) teamMembersComponent.setLoading(false);
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
      console.error('Failed to load task documents:', error);
    }
  }

  private async loadWorkspaceInfo(): Promise<void> {
    try {
      const api = getApiClient();
      const resp = await api.getHealth();
      if (!resp.success) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
          return;
        }
        throw new Error(resp.error || 'Failed to load workspace info');
      }
      const data = resp.data;
      if (data && data.workspace) {
        this.backendWorkspace = data.workspace;
      }
      this.updateWorkspaceInfo();
    } catch (error) {
      console.error('Failed to load workspace info:', error);
      this.backendWorkspace = 'Unknown workspace';
      this.updateWorkspaceInfo();
    }
  }

  private renderDialogList(): void {
    if (!this.shadowRoot) return;

    // Validate all dialogs have valid taskDocPath - fail loudly on invalid data
    this.dialogs.forEach((dialog, index) => {
      if (!dialog.taskDocPath || dialog.taskDocPath.trim() === '') {
        throw new Error(
          `❌ CRITICAL ERROR: Dialog at index ${index} (ID: ${dialog.rootId}) has invalid Task Doc path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Task Doc is mandatory for all dialogs.`,
        );
      }
    });

    const runningDialogs = this.dialogs.filter((d) => d.status === 'running');
    const doneDialogs = this.dialogs.filter((d) => d.status === 'completed');
    const archivedDialogs = this.dialogs.filter((d) => d.status === 'archived');

    const runningList = this.shadowRoot.querySelector('#running-dialog-list');
    if (runningList instanceof RunningDialogList) {
      runningList.setDialogs(runningDialogs);
      if (this.currentDialog) runningList.setCurrentDialog(this.currentDialog);
    }

    const doneList = this.shadowRoot.querySelector('#done-dialog-list');
    if (doneList instanceof DoneDialogList) {
      doneList.setDialogs(doneDialogs);
      if (this.currentDialog) doneList.setCurrentDialog(this.currentDialog);
    }

    const archivedList = this.shadowRoot.querySelector('#archived-dialog-list');
    if (archivedList instanceof ArchivedDialogList) {
      archivedList.setDialogs(archivedDialogs);
      if (this.currentDialog) archivedList.setCurrentDialog(this.currentDialog);
    }
  }

  private resolveDialogStatus(dialog: DialogInfo): DialogStatusKind | null {
    const isRoot = dialog.selfId === dialog.rootId;
    if (isRoot) {
      const match = this.dialogs.find((d) => d.rootId === dialog.rootId && !d.selfId);
      return match ? match.status : null;
    }
    const match = this.dialogs.find(
      (d) => d.rootId === dialog.rootId && d.selfId === dialog.selfId,
    );
    if (match) return match.status;
    // Subdialogs always share the same persistence status directory as their root dialog.
    const rootMatch = this.dialogs.find((d) => d.rootId === dialog.rootId && !d.selfId);
    return rootMatch ? rootMatch.status : null;
  }

  private resolveDialogStatusByIds(rootId: string, selfId: string): DialogStatusKind | null {
    if (!rootId || !selfId) return null;
    const isRoot = selfId === rootId;
    if (isRoot) {
      const match = this.dialogs.find((d) => d.rootId === rootId && !d.selfId);
      return match ? match.status : null;
    }
    const match = this.dialogs.find((d) => d.rootId === rootId && d.selfId === selfId);
    if (match) return match.status;
    // Subdialogs always share the same persistence status directory as their root dialog.
    const rootMatch = this.dialogs.find((d) => d.rootId === rootId && !d.selfId);
    return rootMatch ? rootMatch.status : null;
  }

  private updateInputPanelVisibility(): void {
    const readOnly =
      this.currentDialogStatus === 'completed' || this.currentDialogStatus === 'archived';

    const root = this.shadowRoot;
    if (!root) return;

    const banner = root.querySelector('#q4h-readonly-banner');
    if (banner instanceof HTMLElement) {
      banner.classList.toggle('hidden', !readOnly);
    }

    const inputEl = root.querySelector('#q4h-input');
    if (inputEl instanceof HTMLElement) {
      inputEl.classList.toggle('hidden', readOnly);
    }

    if (this.q4hInput) {
      this.q4hInput.setDisabled(readOnly);
    }
  }

  async selectDialog(dialog: DialogInfo): Promise<void> {
    // Ensure selfId and rootId are valid strings
    const selfId = dialog.selfId || dialog.rootId;
    const rootId = dialog.rootId || dialog.selfId;

    if (!selfId || !rootId) {
      this.showError('Invalid dialog identifiers: selfId and rootId are required', 'error');
      return;
    }

    // Normalized dialog info
    const normalizedDialog: DialogInfo = {
      ...dialog,
      selfId,
      rootId,
    };

    // Store current dialog for refresh functionality
    this.currentDialog = normalizedDialog;
    this.currentDialogStatus = this.resolveDialogStatus(normalizedDialog);
    this.updateInputPanelVisibility();

    try {
      // Send the display_dialog message with error handling
      this.wsManager.sendRaw({
        type: 'display_dialog',
        dialog: normalizedDialog,
      });

      // Backend will now stream both historic content and live updates
      // Dialog information is available in the dialog parameter for proper event filtering

      // Update the dialog title with enhanced information
      const dialogTitle = this.shadowRoot?.querySelector('#current-dialog-title') as HTMLElement;
      if (dialogTitle) {
        let titleText = '';

        // Build display title - all fields are guaranteed to be present
        titleText = `@${normalizedDialog.agentId} (${normalizedDialog.selfId})`;

        // Add task document info
        titleText += ` • ${normalizedDialog.taskDocPath}`;

        dialogTitle.textContent = titleText;
      }

      // Dialog events are forwarded by backend after display_dialog; global handler will process

      // Setup the dialog container for streaming
      const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
      if (dialogContainer instanceof DomindsDialogContainer) {
        const entry = Array.isArray(this.dialogs)
          ? this.dialogs.find((d: ApiRootDialogResponse) => d.rootId === normalizedDialog.selfId)
          : undefined;
        const agentId = normalizedDialog.agentId || entry?.agentId;
        await dialogContainer.setDialog({ ...normalizedDialog, agentId });
      }

      // Set the dialog ID for the q4h-input and focus it
      if (this.q4hInput) {
        this.q4hInput.setDialog(normalizedDialog);
        const key = this.dialogKey(normalizedDialog.rootId, normalizedDialog.selfId);
        const runState = this.dialogRunStatesByKey.get(key) ?? null;
        const input = this.q4hInput as HTMLElement & {
          setRunState?: (state: DialogRunState | null) => void;
        };
        if (input && typeof input.setRunState === 'function') {
          input.setRunState(runState);
        }

        const status = this.currentDialogStatus;
        const isReadOnly = status === 'completed' || status === 'archived';

        if (!isReadOnly) {
          // Enable input immediately after successful dialog selection
          // (dialog_ready event will handle re-enabling if needed)
          setTimeout(() => {
            const input = this.q4hInput;
            if (input) input.setDisabled(false);
          }, 500); // Small delay to ensure setDialog completes

          // Auto-focus the input after dialog selection
          setTimeout(() => {
            const input = this.q4hInput;
            if (input) input.focusInput();
          }, 100);
        } else {
          this.q4hInput.setDisabled(true);
        }
      } else {
        console.warn('❌ Auto-focus: No q4h-input component found after dialog selection');
      }

      // Update the dialog list to show current selection
      const sr = this.shadowRoot;
      if (sr) {
        const runningList = sr.querySelector('#running-dialog-list');
        if (runningList instanceof RunningDialogList)
          runningList.setCurrentDialog(normalizedDialog);
        const doneList = sr.querySelector('#done-dialog-list');
        if (doneList instanceof DoneDialogList) doneList.setCurrentDialog(normalizedDialog);
        const archivedList = sr.querySelector('#archived-dialog-list');
        if (archivedList instanceof ArchivedDialogList)
          archivedList.setCurrentDialog(normalizedDialog);
      }

      // Reset reminder operation count for new dialog
      this.resetReminderOperationCount();

      // Load reminders for toolbar (with delay to avoid race condition)
      // Wait for backend to establish WebSocket subscription before requesting reminders
      setTimeout(() => {
        if (
          this.currentDialog &&
          this.currentDialog.selfId === normalizedDialog.selfId &&
          this.currentDialog.rootId === normalizedDialog.rootId
        ) {
        }
      }, 100); // 100ms delay to ensure backend has processed display_dialog

      // Toolbar state will be managed by streaming events
      this.updateToolbarDisplay();

      // Re-render reminders widget if visible (this needs full render due to its fixed positioning)
      if (this.remindersWidgetVisible) {
        this.renderRemindersWidget();
        this.setupRemindersWidgetDrag();
      }

      this.showSuccess('Dialog loaded successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load dialog: ${message}`, 'error');
    }
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
      hierarchy.unshift({
        selfId: current.selfId || current.rootId,
        rootId: current.rootId,
        agentId: current.agentId,
      });

      // For subdialogs, we need to find parent - check dialogs list
      const currentDialogData = this.dialogs.find((d) => d.selfId === current?.selfId);
      if (currentDialogData?.supdialogId) {
        // This is a subdialog, find the parent
        const parentDialog = this.dialogs.find((d) => d.rootId === currentDialogData.supdialogId);
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
    await this.selectDialog(parentInfo);
    return true;
  }

  /**
   * Open a subdialog by its root and self ID (for E2E testing)
   * @param rootId - The root (parent) dialog ID
   * @param subdialogId - The subdialog's self ID
   * @returns Promise that resolves when navigation is complete
   */
  public async openSubdialog(rootId: string, subdialogId: string): Promise<boolean> {
    let subdialog = this.dialogs.find((d) => d.rootId === rootId && d.selfId === subdialogId);

    if (!subdialog) {
      await this.ensureSubdialogsLoaded(rootId);
      subdialog = this.dialogs.find((d) => d.rootId === rootId && d.selfId === subdialogId);
    }

    if (!subdialog) {
      console.warn(`Subdialog not found: ${rootId}:${subdialogId}`);
      return false;
    }

    await this.selectDialog({
      rootId: subdialog.rootId,
      selfId: subdialog.selfId || subdialog.rootId,
      agentId: subdialog.agentId,
      agentName: '',
      taskDocPath: subdialog.taskDocPath || '',
    });

    return true;
  }

  /**
   * Ensure subdialogs for a root dialog are loaded (for E2E testing + lazy loading).
   */
  public async ensureSubdialogsLoaded(rootId: string): Promise<boolean> {
    if (!rootId) return false;
    const rootDialog = this.dialogs.find((d) => d.rootId === rootId && !d.selfId);
    const expectedCount =
      typeof rootDialog?.subdialogCount === 'number' ? rootDialog.subdialogCount : 0;
    if (expectedCount === 0) return true;
    const alreadyLoaded = this.dialogs.some(
      (d) => d.supdialogId === rootId && typeof d.selfId === 'string' && d.selfId !== '',
    );
    if (alreadyLoaded) return true;
    await this.loadSubdialogsForRoot(rootId);
    return this.dialogs.some(
      (d) => d.supdialogId === rootId && typeof d.selfId === 'string' && d.selfId !== '',
    );
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    this.connectionState = state;
    this.updateConnectionStatus();

    // Update UI based on connection state
    if (state.status === 'connected') {
      this.wsManager.setUiLanguage(this.uiLanguage);

      // Fetch Q4H state from ALL running dialogs for global display
      // This ensures all pending Q4H questions are shown regardless of which dialog is selected
      this.wsManager.sendRaw({
        type: 'get_q4h_state',
      });
    } else if (state.status === 'error') {
      if (state.error === 'Unauthorized') {
        this.onAuthRejected('ws');
        return;
      }
      this.showError(state.error || 'Connection error');
    }
  }

  private updateConnectionStatus(): void {
    if (!this.shadowRoot) return;

    const statusEl = this.shadowRoot.querySelector('dominds-connection-status') as HTMLElement;
    if (statusEl) {
      statusEl.setAttribute('status', this.connectionState.status);
      if (this.connectionState.error) {
        statusEl.setAttribute('error', this.connectionState.error);
      }
    }
  }

  private async handleNewDialog(): Promise<void> {
    if (this.teamMembers.length === 0) {
      console.error('❌ No team members available');
      this.showError('No team members available. Please check your team configuration.');
      return;
    }

    this.showCreateDialogModal();
  }

  private getAgentEmoji(agentId: string, icon?: string): string {
    // Use the icon from the backend if available
    if (icon) {
      return icon;
    }

    // Fallback to a generic agent icon if no backend icon is provided
    return '🛠';
  }

  private calculateSortScore(
    nameMatch: boolean,
    pathMatch: boolean,
    nameStartsWith: boolean,
    pathStartsWith: boolean,
    nameExactMatch: boolean,
  ): number {
    // Scoring system: higher scores appear first
    // Exact filename match: 100
    // Filename starts with query: 90
    // Path starts with query: 80
    // Filename contains query: 70
    // Path contains query: 60

    if (nameExactMatch) return 100;
    if (nameStartsWith) return 90;
    if (pathStartsWith) return 80;
    if (nameMatch) return 70;
    if (pathMatch) return 60;

    return 0;
  }

  private calculateCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    // Find the shortest string to avoid index out of bounds
    const shortest = strings.reduce(
      (min, str) => (str.length < min.length ? str : min),
      strings[0],
    );

    let commonPrefix = '';

    for (let i = 0; i < shortest.length; i++) {
      const char = shortest[i];
      const allHaveChar = strings.every((str) => str[i] === char);

      if (allHaveChar) {
        commonPrefix += char;
      } else {
        break;
      }
    }

    return commonPrefix;
  }

  private showCreateDialogModal(preset?: { taskDocPath?: string }): void {
    const t = getUiStrings(this.uiLanguage);
    const visibleMembers = this.teamMembers.filter((m) => m.hidden !== true);
    const shadowMembers = this.teamMembers.filter((m) => m.hidden === true);

    const defaultIsVisible =
      typeof this.defaultResponder === 'string' &&
      visibleMembers.some((m) => m.id === this.defaultResponder);
    const defaultIsShadow =
      typeof this.defaultResponder === 'string' &&
      shadowMembers.some((m) => m.id === this.defaultResponder);
    const initialPickShadow =
      shadowMembers.length > 0 &&
      (defaultIsShadow || (!defaultIsVisible && visibleMembers.length === 0));
    const firstShadowId = shadowMembers.length > 0 ? shadowMembers[0].id : '';

    const modal = document.createElement('div');
    modal.className = 'create-dialog-modal';
    modal.innerHTML = `
	      <div class="modal-backdrop"></div>
	      <div class="modal-content" role="dialog" aria-labelledby="modal-title" aria-modal="true">
        <div class="modal-header">
          <h3 id="modal-title">${t.createNewDialogTitle}</h3>
          <button class="modal-close" aria-label="${t.close}">
            ✕
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="task-doc-input">${t.taskDocumentLabel}</label>
            <div class="task-doc-container">
              <input type="text" id="task-doc-input" class="task-doc-input" placeholder="${t.taskDocumentPlaceholder}" autocomplete="off">
              <div id="task-doc-suggestions" class="task-doc-suggestions"></div>
            </div>
            <small class="form-help">${t.taskDocumentHelp}</small>
          </div>
	
	          <div class="form-group">
	            <label for="teammate-select">${t.teammateLabel}</label>
	            <select id="teammate-select" class="teammate-dropdown">
	              ${visibleMembers
                  .map((member) => {
                    const isDefault = member.id === this.defaultResponder;
                    const emoji = this.getAgentEmoji(member.id, member.icon);
                    return `<option value="${member.id}" ${isDefault ? 'selected' : ''}>
	                  ${emoji} ${member.name} (@${member.id})${isDefault ? t.defaultMarker : ''}
	                </option>`;
                  })
                  .join('')}
	              ${
                  shadowMembers.length > 0
                    ? `<option value="__shadow__" ${initialPickShadow ? 'selected' : ''}>${t.shadowMembersOption}</option>`
                    : ''
                }
	            </select>
	          </div>
	
	          <div class="form-group shadow-members-group" id="shadow-members-group" style="${initialPickShadow ? '' : 'display:none;'}">
	            <label for="shadow-teammate-select">${t.shadowMembersLabel}</label>
	            <select id="shadow-teammate-select" class="teammate-dropdown">
	              ${shadowMembers
                  .map((member) => {
                    const isDefault = member.id === this.defaultResponder;
                    const emoji = this.getAgentEmoji(member.id, member.icon);
                    const selected = isDefault || (!defaultIsShadow && firstShadowId === member.id);
                    return `<option value="${member.id}" ${selected ? 'selected' : ''}>
	                  ${emoji} ${member.name} (@${member.id})${isDefault ? t.defaultMarker : ''}
	                </option>`;
                  })
                  .join('')}
	            </select>
	          </div>
	
	          <div class="teammate-info" id="teammate-info">
	            <!-- Agent details will be shown here when selection changes -->
	          </div>
	        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel-btn">
            ${t.cancel}
          </button>
          <button class="btn btn-primary" id="create-dialog-btn">
            ${t.createDialog}
          </button>
        </div>
      </div>
    `;

    if (preset && typeof preset.taskDocPath === 'string' && preset.taskDocPath.trim() !== '') {
      const taskInput = modal.querySelector('#task-doc-input') as HTMLInputElement | null;
      if (taskInput) {
        taskInput.value = preset.taskDocPath;
      }
    }

    // Add event listeners and functionality
    this.setupDialogModalEvents(modal);

    // Append to shadow root for proper positioning within the component
    if (this.shadowRoot) {
      this.shadowRoot.appendChild(modal);
    } else {
      document.body.appendChild(modal);
    }
  }

  private setupDialogModalEvents(modal: HTMLElement): void {
    const select = modal.querySelector('#teammate-select') as HTMLSelectElement;
    const shadowGroup = modal.querySelector('#shadow-members-group') as HTMLElement | null;
    const shadowSelect = modal.querySelector('#shadow-teammate-select') as HTMLSelectElement | null;
    const taskInput = modal.querySelector('#task-doc-input') as HTMLInputElement;
    const suggestions = modal.querySelector('#task-doc-suggestions') as HTMLElement;
    const createBtn = modal.querySelector('#create-dialog-btn') as HTMLButtonElement;
    const teammateInfo = modal.querySelector('#teammate-info') as HTMLElement;

    // Modal close event listeners
    const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement;
    const cancelBtn = modal.querySelector('#modal-cancel-btn') as HTMLButtonElement;

    const closeModal = () => {
      modal.remove();

      // Enhanced auto-focus implementation with retry logic
      const attemptFocus = (attempt = 1) => {
        if (this.q4hInput) {
          this.q4hInput.focusInput();
        } else {
          console.warn('❌ Auto-focus: q4h-input component not found');
        }

        // Retry with longer delay if first attempt failed
        if (attempt === 1) {
          setTimeout(() => attemptFocus(2), 100);
        }
      };

      // First attempt after modal removal
      setTimeout(() => attemptFocus(), 150);

      // Secondary attempt with longer delay for stubborn cases
      setTimeout(() => attemptFocus(3), 400);
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // Function to show teammate info
    const showTeammateInfo = (agentId: string) => {
      let resolvedAgentId = agentId;
      if (agentId === '__shadow__') {
        resolvedAgentId = shadowSelect ? shadowSelect.value : '';
      }

      if (resolvedAgentId) {
        const member = this.teamMembers.find((m) => m.id === resolvedAgentId);
        if (member) {
          const emoji = this.getAgentEmoji(member.id, member.icon);
          const isDefault = member.id === this.defaultResponder;
          teammateInfo.innerHTML = `
	            <div class="teammate-details">
	              <h4>${emoji} ${member.name}${isDefault ? ' • Default' : ''}</h4>
	              <p><strong>Call Sign:</strong> @${member.id}</p>
	              <p><strong>Provider:</strong> ${member.provider || 'Not specified'}</p>
	              <p><strong>Model:</strong> ${member.model || 'Not specified'}</p>
	              ${
                  member.gofor && member.gofor.length > 0
                    ? `<p><strong>Specializes in:</strong> ${member.gofor.join(', ')}</p>`
                    : ''
                }
	            </div>
	          `;
          teammateInfo.style.display = 'block';
        } else {
          teammateInfo.style.display = 'none';
        }
      } else {
        teammateInfo.style.display = 'none';
      }
    };

    // Show teammate info when selection changes
    select.addEventListener('change', () => {
      const isShadow = select.value === '__shadow__';
      if (shadowGroup) {
        shadowGroup.style.display = isShadow ? 'block' : 'none';
      }
      showTeammateInfo(select.value);
    });

    if (shadowSelect) {
      shadowSelect.addEventListener('change', () => {
        showTeammateInfo('__shadow__');
      });
    }

    // Show teammate info for initially selected agent
    showTeammateInfo(select.value);

    // Task document autocomplete functionality
    let selectedSuggestionIndex = -1;
    let currentSuggestions: Array<{ path: string; relativePath: string; name: string }> = [];

    const updateSuggestions = (query: string): void => {
      if (!query.trim()) {
        suggestions.innerHTML = '';
        suggestions.style.display = 'none';
        selectedSuggestionIndex = -1;
        return;
      }

      const queryLower = query.toLowerCase();

      currentSuggestions = this.taskDocuments
        .filter(
          (doc) =>
            doc.relativePath.toLowerCase().includes(queryLower) ||
            doc.name.toLowerCase().includes(queryLower),
        )
        .map((doc) => {
          const nameMatch = doc.name.toLowerCase().includes(queryLower);
          const pathMatch = doc.relativePath.toLowerCase().includes(queryLower);
          const nameStartsWith = doc.name.toLowerCase().startsWith(queryLower);
          const pathStartsWith = doc.relativePath.toLowerCase().startsWith(queryLower);
          const nameExactMatch = doc.name.toLowerCase() === queryLower;

          return {
            ...doc,
            _sortScore: this.calculateSortScore(
              nameMatch,
              pathMatch,
              nameStartsWith,
              pathStartsWith,
              nameExactMatch,
            ),
            _nameMatch: nameMatch,
            _pathMatch: pathMatch,
            _nameStartsWith: nameStartsWith,
            _pathStartsWith: pathStartsWith,
            _nameExactMatch: nameExactMatch,
          };
        })
        .sort((a, b) => {
          // Primary sort by score (higher is better)
          if (a._sortScore !== b._sortScore) {
            return b._sortScore - a._sortScore;
          }

          // Secondary sort: shorter names first
          if (a.name.length !== b.name.length) {
            return a.name.length - b.name.length;
          }

          // Tertiary sort: alphabetical
          return a.name.localeCompare(b.name);
        })
        .slice(0, 50) // Limit to 50 suggestions
        .map(
          ({
            _sortScore,
            _nameMatch,
            _pathMatch,
            _nameStartsWith,
            _pathStartsWith,
            _nameExactMatch,
            ...doc
          }) => doc,
        );

      if (currentSuggestions.length === 0) {
        suggestions.innerHTML = '<div class="no-suggestions">No matching documents found</div>';
        suggestions.style.display = 'block';
        return;
      }

      suggestions.innerHTML = currentSuggestions
        .map(
          (doc, index) => `
        <div class="suggestion ${index === selectedSuggestionIndex ? 'selected' : ''}" 
             data-index="${index}" data-path="${doc.relativePath}">
          <div class="suggestion-path">${doc.relativePath}</div>
          <div class="suggestion-name">${doc.name}</div>
        </div>
      `,
        )
        .join('');

      suggestions.style.display = 'block';
      selectedSuggestionIndex = -1;
    };

    const selectSuggestion = (index: number): void => {
      if (index >= 0 && index < currentSuggestions.length) {
        taskInput.value = currentSuggestions[index].relativePath;
        // Clear suggestions and selection, then return focus to input
        suggestions.innerHTML = '';
        suggestions.style.display = 'none';
        selectedSuggestionIndex = -1;
        // Return focus to the input field
        taskInput.focus();
      }
    };

    // Input event for autocomplete
    taskInput.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      updateSuggestions(value);
    });

    // Keyboard navigation for suggestions
    taskInput.addEventListener('keydown', (e) => {
      if (suggestions.style.display === 'none') {
        if (e.key === 'Enter') {
          createBtn.click();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedSuggestionIndex = Math.min(
            selectedSuggestionIndex + 1,
            currentSuggestions.length - 1,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
          break;
        case 'Tab':
          e.preventDefault();
          // Smart Tab completion: complete to common prefix
          if (currentSuggestions.length > 0) {
            const currentValue = taskInput.value;
            const allPaths = currentSuggestions.map((doc) => doc.relativePath);
            const commonPrefix = this.calculateCommonPrefix(allPaths);

            // Only complete if there's a common prefix that's longer than current input
            if (commonPrefix.length > currentValue.length) {
              taskInput.value = commonPrefix;
              // Trigger input event to update suggestions for the completed text
              const inputEvent = new Event('input', { bubbles: true });
              taskInput.dispatchEvent(inputEvent);
              return;
            }
          }

          // Fallback: select first suggestion if no common prefix
          if (currentSuggestions.length > 0 && selectedSuggestionIndex < 0) {
            selectedSuggestionIndex = 0;
            selectSuggestion(selectedSuggestionIndex);
          }
          break;
        case 'Enter':
          e.preventDefault();
          // If a suggestion is selected, confirm it
          if (selectedSuggestionIndex >= 0) {
            selectSuggestion(selectedSuggestionIndex);
          } else if (currentSuggestions.length === 0) {
            // If no suggestions are shown (either because user has selected one or there are no matches), trigger dialog creation
            createBtn.click();
          }
          break;
        case 'Escape':
          suggestions.innerHTML = '';
          suggestions.style.display = 'none';
          selectedSuggestionIndex = -1;
          break;
      }

      // Update suggestion highlighting
      const suggestionElements = suggestions.querySelectorAll('.suggestion');
      suggestionElements.forEach((el, index) => {
        el.classList.toggle('selected', index === selectedSuggestionIndex);
      });
    });

    // Click on suggestions
    suggestions.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const suggestionEl = target.closest('.suggestion');
      if (suggestionEl) {
        const index = parseInt(suggestionEl.getAttribute('data-index') || '0');
        selectSuggestion(index);
      }
    });

    // Handle dialog creation
    createBtn.addEventListener('click', async () => {
      let taskDocPath = taskInput.value.trim();

      // Validate that task document is provided
      taskDocPath = taskDocPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      if (!taskDocPath) {
        taskDocPath = 'socializing.tsk';
      } else if (!taskDocPath.endsWith('.tsk')) {
        taskDocPath = `${taskDocPath}.tsk`;
      }
      taskInput.value = taskDocPath;

      let selectedAgentId: string | undefined;
      if (!select.value) {
        selectedAgentId = undefined; // undefined means use default
      } else if (select.value === '__shadow__') {
        const shadowId = shadowSelect ? shadowSelect.value : '';
        if (!shadowId) {
          const t = getUiStrings(this.uiLanguage);
          this.showError(t.shadowMembersSelectRequired, 'error');
          return;
        }
        selectedAgentId = shadowId;
      } else {
        selectedAgentId = select.value;
      }

      await this.createDialog(selectedAgentId, taskDocPath);
      modal.remove();
    });

    // Handle Enter key in modal
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        createBtn.click();
      }
    });
  }

  public async createDialog(
    agentId: string | undefined,
    taskDocPath: string,
  ): Promise<{ selfId: string; rootId: string; agentId: string; taskDocPath: string }> {
    try {
      const fallbackAgent = agentId || this.defaultResponder || '';
      if (!fallbackAgent) {
        throw new Error('No agent specified and no default responder configured');
      }
      const api = getApiClient();
      const resp = await api.createDialog(fallbackAgent, taskDocPath);
      if (!resp.success || !resp.data) {
        if (resp.status === 401) {
          this.onAuthRejected('api');
        }
        throw new Error(resp.error || 'Dialog creation failed');
      }
      const payload = resp.data as unknown;
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('Dialog creation failed: invalid response payload');
      }
      const rec = payload as Record<string, unknown>;
      const selfIdRaw = rec.selfId;
      const rootIdRaw = rec.rootId;
      if (typeof selfIdRaw !== 'string' || typeof rootIdRaw !== 'string') {
        this.showError('Invalid dialog identifiers in createDialog response', 'error');
        throw new Error('Invalid dialog identifiers');
      }
      const selfId = selfIdRaw;
      const rootId = rootIdRaw;
      if (!selfId || !rootId) {
        throw new Error('Dialog creation failed: invalid identifiers in response');
      }
      this.showSuccess(`Dialog created @${fallbackAgent} with task: ${taskDocPath}`);
      await this.loadDialogs();
      // Use complete DialogInfo with all required fields
      await this.selectDialog({
        selfId,
        rootId,
        agentId: fallbackAgent,
        agentName: this.getAgentDisplayName(fallbackAgent),
        taskDocPath,
      });
      return { selfId, rootId, agentId: fallbackAgent, taskDocPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to create dialog: ${message}`, 'error');
      throw error;
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

  private showError(message: string, type: 'error' | 'warning' | 'info' = 'error'): void {
    console.error(`[${type.toUpperCase()}] ${message}`);

    if (this.shadowRoot) {
      // Show error in dialog content area
      const contentEl = this.shadowRoot.querySelector('#dialog-content');
      if (contentEl) {
        const icon = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
        const color =
          type === 'error'
            ? 'var(--dominds-danger, #dc3545)'
            : type === 'warning'
              ? 'var(--dominds-warning, #ffc107)'
              : 'var(--dominds-info, #007bff)';

        contentEl.innerHTML = `
          <div style="
            padding: 20px; 
            margin: 20px; 
            border-radius: 8px; 
            background: ${
              type === 'error'
                ? 'var(--dominds-danger-bg, #f8d7da)'
                : type === 'warning'
                  ? 'var(--dominds-warning-bg, #fff3cd)'
                  : 'var(--dominds-info-bg, #cce7ff)'
            };
            border: 1px solid ${
              type === 'error'
                ? 'var(--dominds-danger-border, #f5c6cb)'
                : type === 'warning'
                  ? 'var(--dominds-warning-border, #ffeaa7)'
                  : 'var(--dominds-info-border, #99d1ff)'
            };
            color: ${color};
          ">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <span style="font-size: 18px;">${icon}</span>
              <strong>${type === 'error' ? 'Error' : type === 'warning' ? 'Warning' : 'Info'}</strong>
            </div>
            <div>${message}</div>
            ${
              type !== 'info'
                ? `<div style="margin-top: 12px;">
              <button onclick="this.parentElement.parentElement.remove()" style="
                padding: 6px 12px;
                border: none;
                border-radius: 4px;
                background: ${color};
                color: white;
                cursor: pointer;
                font-size: 12px;
              ">Dismiss</button>
            </div>`
                : ''
            }
          </div>
        `;
      }
    }
  }

  private showSuccess(message: string): void {
    if (this.shadowRoot) {
      // Show success notification (could be enhanced with toast)
      const contentEl = this.shadowRoot.querySelector('#dialog-content');
      if (contentEl) {
        const existingSuccess = contentEl.querySelector('.success-notification');
        if (existingSuccess) {
          existingSuccess.remove();
        }

        const successEl = document.createElement('div');
        successEl.className = 'success-notification';
        successEl.innerHTML = `
          <div style="
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: var(--dominds-success-bg, #d4edda);
            border: 1px solid var(--dominds-success-border, #c3e6cb);
            color: var(--dominds-success, #155724);
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            z-index: 1000;
            animation: slideIn 0.3s ease-out;
          ">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>✅</span>
              <span>${message}</span>
            </div>
          </div>
          <style>
            @keyframes slideIn {
              from { transform: translateX(100%); opacity: 0; }
              to { transform: translateX(0); opacity: 1; }
            }
          </style>
        `;

        contentEl.appendChild(successEl);

        // Auto-remove after 3 seconds
        setTimeout(() => {
          if (successEl.parentNode) {
            successEl.remove();
          }
        }, 3000);
      }
    }
  }

  private showToast(message: string, kind: 'error' | 'warning' | 'info' = 'error'): void {
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
    toast.innerHTML = `
      <div style="position: fixed; top: 18px; right: 18px; padding: 8px 12px; border-radius: 8px; background: ${bg}; color: ${color}; box-shadow: 0 4px 12px rgba(0,0,0,0.2); border: 1px solid ${border}; z-index: 3000; font-size: 12px; display:flex; align-items:center; gap:8px; animation: slideDown 0.2s ease-out;">
        <span>${kind === 'error' ? '❌' : kind === 'warning' ? '⚠️' : 'ℹ️'}</span>
        <span>${message}</span>
      </div>
      <style>@keyframes slideDown { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }</style>
    `;
    this.shadowRoot.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
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

  private updateThemeToggle(): void {
    if (!this.shadowRoot) return;

    const themeToggle = this.shadowRoot.querySelector('#theme-toggle-btn') as HTMLElement;
    if (themeToggle) {
      themeToggle.textContent = this.currentTheme === 'light' ? '🌙' : '☀️';
      themeToggle.setAttribute(
        'title',
        this.currentTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
      );
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

  private renderProblemsListHtml(): string {
    const t = getUiStrings(this.uiLanguage);
    if (this.problems.length === 0) {
      return `<div class="problem-meta">${this.escapeHtml(t.problemsEmpty)}</div>`;
    }
    const items = this.problems
      .slice()
      .sort((a, b) => {
        const sa = a.severity === 'error' ? 3 : a.severity === 'warning' ? 2 : 1;
        const sb = b.severity === 'error' ? 3 : b.severity === 'warning' ? 2 : 1;
        if (sa !== sb) return sb - sa;
        return b.timestamp.localeCompare(a.timestamp);
      })
      .map((p) => {
        const detailText = JSON.stringify(p.detail, null, 2);
        return `
          <div class="problem-item" data-severity="${p.severity}">
            <div class="problem-head">
              <div class="problem-message">${this.escapeHtml(p.message)}</div>
              <div class="problem-meta">${this.escapeHtml(p.timestamp)}</div>
            </div>
            <div class="problem-detail">${this.escapeHtml(detailText)}</div>
          </div>
        `;
      })
      .join('');
    return items;
  }

  private updateProblemsUi(): void {
    const sr = this.shadowRoot;
    if (!sr) return;
    const btn = sr.querySelector('#toolbar-problems-toggle') as HTMLButtonElement | null;
    if (btn) {
      btn.setAttribute('data-severity', this.getProblemsTopSeverity());
      btn.setAttribute('data-has-problems', this.problems.length > 0 ? 'true' : 'false');
      const count = btn.querySelector('span');
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

  private renderToolsRegistryListHtml(): string {
    const t = getUiStrings(this.uiLanguage);
    if (!this.toolsRegistryToolsets || this.toolsRegistryToolsets.length === 0) {
      return `<div class="tools-empty">${this.escapeHtml(t.toolsEmpty)}</div>`;
    }

    const toolsets = this.toolsRegistryToolsets;

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

    const mcpToolsets = toolsets.filter((ts) => ts.source === 'mcp');
    const domindsToolsets = toolsets.filter((ts) => ts.source !== 'mcp');

    const domindsSection = renderSectionHtml(t.toolsGroupDominds, 'ƒ', domindsToolsets);
    const mcpSection = renderSectionHtml(t.toolsGroupMcp, 'ƒ', mcpToolsets);

    return `${domindsSection}${mcpSection}`;
  }

  private updateToolsRegistryUi(): void {
    const sr = this.shadowRoot;
    if (!sr) return;
    const list = sr.querySelector('#tools-registry-list') as HTMLElement | null;
    if (list) {
      list.innerHTML = this.renderToolsRegistryListHtml();
    }
    const ts = sr.querySelector('#tools-registry-timestamp') as HTMLElement | null;
    if (ts) {
      ts.textContent = this.toolsRegistryTimestamp ? this.toolsRegistryTimestamp : '';
    }
  }

  private async loadToolsRegistry(): Promise<void> {
    const res = await this.apiClient.getToolsRegistry();
    if (!res.success || !res.data) {
      const message = res.error || 'Failed to load tools registry';
      this.showToast(message, 'warning');
      return;
    }
    this.toolsRegistryToolsets = res.data.toolsets;
    this.toolsRegistryTimestamp = res.data.timestamp;
    this.updateToolsRegistryUi();
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
        const welcome = message as WelcomeMessage;
        this.serverWorkLanguage = welcome.serverWorkLanguage;
        const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
        if (dialogContainer instanceof DomindsDialogContainer) {
          dialogContainer.setServerWorkLanguage(welcome.serverWorkLanguage);
        }
        this.applyUiLanguageToDom();
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
      case 'error': {
        console.error('Server error:', message.message);
        this.showToast(message.message, 'error');
        return true;
      }
      case 'dialog_ready': {
        // Update currentDialog with the ready dialog's ID (from both create and display)
        const readyMsg: DialogReadyMessage = message;
        this.currentDialog = {
          selfId: readyMsg.dialog.selfId,
          rootId: readyMsg.dialog.rootId,
          agentId: readyMsg.agentId,
          agentName: readyMsg.agentId, // agentId serves as the name for display
          taskDocPath: readyMsg.taskDocPath,
          supdialogId: readyMsg.supdialogId,
          tellaskSession: readyMsg.tellaskSession,
          assignmentFromSup: readyMsg.assignmentFromSup,
        };

        this.disableDiligencePush = readyMsg.disableDiligencePush ?? false;
        this.diligencePushMax =
          typeof readyMsg.diligencePushMax === 'number' &&
          Number.isFinite(readyMsg.diligencePushMax)
            ? readyMsg.diligencePushMax
            : null;
        this.diligenceRtwsDirty = false;
        this.updateBottomPanelFooterUi();

        const dialogContainer = this.shadowRoot?.querySelector('#dialog-container');
        if (dialogContainer instanceof DomindsDialogContainer) {
          dialogContainer.updateDialogContext(this.currentDialog);
        }
        // Update q4h-input with the active dialog ID
        if (this.q4hInput && typeof this.q4hInput.setDialog === 'function') {
          this.q4hInput.setDialog(this.currentDialog);
        }

        // Update docs panel language
        const docsPanel = this.shadowRoot?.querySelector('#docs-panel') as unknown as {
          setUiLanguage?: (lang: LanguageCode) => void;
        };
        if (docsPanel && typeof docsPanel.setUiLanguage === 'function') {
          docsPanel.setUiLanguage(this.uiLanguage);
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
        if (
          this.currentDialog &&
          evt.dialog.selfId === this.currentDialog.selfId &&
          evt.dialog.rootId === this.currentDialog.rootId
        ) {
          this.disableDiligencePush = evt.disableDiligencePush;
          this.updateBottomPanelFooterUi();
        }
        return true;
      }
      case 'diligence_budget_evt': {
        if (
          this.currentDialog &&
          message.dialog.selfId === this.currentDialog.selfId &&
          message.dialog.rootId === this.currentDialog.rootId
        ) {
          const remaining = message.remainingCount;
          this.diligencePushMax =
            typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null;
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
        void this.loadDialogs();
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
          const prevBtn = this.shadowRoot?.querySelector('#toolbar-prev') as HTMLButtonElement;
          const nextBtn = this.shadowRoot?.querySelector('#toolbar-next') as HTMLButtonElement;
          if (prevBtn) prevBtn.disabled = !(this.toolbarCurrentCourse > 1);
          if (nextBtn) nextBtn.disabled = !(this.toolbarCurrentCourse < this.toolbarTotalCourses);
          const courseLabel = this.shadowRoot?.querySelector('#course-nav span') as HTMLElement;
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
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            (message as TypedDialogEvent).timestamp,
          );
          break;
        }

        case 'subdialog_created_evt': {
          const subdialogEvent = message as SubdialogEvent;
          // Handle subdialog creation events
          const rootId = subdialogEvent.subDialog.rootId || subdialogEvent.parentDialog.rootId;
          const selfId = subdialogEvent.subDialog.selfId;

          if (!rootId) {
            // CRITICAL ERROR: Missing rootId in subdialog event - cannot identify dialog to update
            throw new Error(
              `CRITICAL: subdialog_created event missing rootId. SubDialog: ${JSON.stringify(subdialogEvent.subDialog)}, ParentDialog: ${JSON.stringify(subdialogEvent.parentDialog)}`,
            );
          }

          const refreshToken = (this.subdialogHierarchyRefreshTokens.get(rootId) || 0) + 1;
          this.subdialogHierarchyRefreshTokens.set(rootId, refreshToken);
          try {
            const resp = await this.apiClient.getDialogHierarchy(rootId);
            if (this.subdialogHierarchyRefreshTokens.get(rootId) !== refreshToken) {
              console.warn(
                `Skipping stale dialog hierarchy response for root ${rootId} (token ${refreshToken})`,
              );
              break;
            }
            if (resp.success && resp.data) {
              // resp.data is ApiDialogHierarchyResponse['hierarchy'] which is {root, subdialogs}
              const h = resp.data;
              const root = h.root;
              const subs = Array.isArray(h.subdialogs) ? h.subdialogs : [];
              // Rebuild entries for this root
              const entries: ApiRootDialogResponse[] = [];
              entries.push({
                rootId: root.id,
                agentId: root.agentId,
                taskDocPath: root.taskDocPath,
                status: root.status,
                currentCourse: root.currentCourse,
                createdAt: root.createdAt,
                lastModified: root.lastModified,
                runState:
                  root.runState ?? this.dialogRunStatesByKey.get(this.dialogKey(root.id, root.id)),
              });
              const rootRunState =
                root.runState ?? this.dialogRunStatesByKey.get(this.dialogKey(root.id, root.id));
              if (rootRunState) {
                this.dialogRunStatesByKey.set(this.dialogKey(root.id, root.id), rootRunState);
              }
              for (const sd of subs) {
                const sdCachedRunState = this.dialogRunStatesByKey.get(
                  this.dialogKey(root.id, sd.selfId),
                );
                const sdEffectiveRunState = sd.runState ?? sdCachedRunState;
                entries.push({
                  rootId: root.id, // Subdialogs belong to the supdialog's root for proper path resolution
                  selfId: sd.selfId, // Subdialog's own unique identifier
                  agentId: sd.agentId,
                  taskDocPath: sd.taskDocPath,
                  status: sd.status,
                  currentCourse: sd.currentCourse,
                  createdAt: sd.createdAt,
                  lastModified: sd.lastModified,
                  runState: sdEffectiveRunState,
                  supdialogId: root.id,
                  tellaskSession: sd.tellaskSession,
                });
                if (sdEffectiveRunState) {
                  this.dialogRunStatesByKey.set(
                    this.dialogKey(root.id, sd.selfId),
                    sdEffectiveRunState,
                  );
                }
              }
              // Merge into existing dialogs: replace any entries under this root
              this.dialogs = this.dialogs.filter(
                (d) => d.rootId !== root.id && d.supdialogId !== root.id,
              );
              this.dialogs.push(...entries);
              // FIXED: Use surgical update instead of full render to preserve dialog container state
              this.updateDialogList();
              this.bumpDialogLastModified(
                { rootId, selfId: rootId },
                root.lastModified || (message as TypedDialogEvent).timestamp,
              );
            } else {
              // CRITICAL ERROR: Missing hierarchy data in response - cannot proceed without dialog structure
              throw new Error(
                `CRITICAL: subdialog_created event missing hierarchy data. RootId: ${rootId}, Response success: ${resp.success}, Has data: ${!!resp.data}`,
              );
            }
          } catch (error) {
            // CRITICAL ERROR: API call failed - cannot refresh dialog hierarchy
            if (error instanceof Error) {
              throw new Error(
                `CRITICAL: Failed to get dialog hierarchy for rootId: ${rootId} - ${error.message}`,
              );
            } else {
              throw new Error(
                `CRITICAL: Failed to get dialog hierarchy for rootId: ${rootId} - Unknown error: ${error}`,
              );
            }
          }
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
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
          );
          break;
        }

        case 'tool_call_response_evt': {
          const dialogContainer = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (!dialogContainer) {
            console.warn('Dialog container not found; dropping tool_call_response_evt');
            break;
          }

          await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          const ts = (message as TypedDialogEvent).timestamp;
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
          );
          break;
        }

        case 'dlg_run_state_evt': {
          const runState = (message as { runState?: unknown }).runState;
          if (typeof runState !== 'object' || runState === null || !('kind' in runState)) {
            console.warn('Invalid dlg_run_state_evt payload', message);
            break;
          }

          const selfId = dialog.selfId;
          const rootId = dialog.rootId;
          const key = this.dialogKey(rootId, selfId);
          const typedRunState = runState as DialogRunState;
          this.dialogRunStatesByKey.set(key, typedRunState);

          // Update dialog list entry if present
          this.dialogs = (this.dialogs || []).map((d) => {
            const dSelf = d.selfId ? d.selfId : d.rootId;
            if (d.rootId === rootId && dSelf === selfId) {
              return { ...d, runState: typedRunState };
            }
            return d;
          });

          // Update input primary action for the active dialog
          if (
            this.currentDialog &&
            this.currentDialog.rootId === rootId &&
            this.currentDialog.selfId === selfId
          ) {
            const input = this.q4hInput as HTMLElement & {
              setRunState?: (state: DialogRunState | null) => void;
            };
            if (input && typeof input.setRunState === 'function') {
              input.setRunState(typedRunState);
            }
          }

          // Q4H is global, but new_q4h_asked is delivered only via the currently subscribed dialog stream.
          // When ANY dialog transitions into a blocked state requiring human input, refresh the global Q4H
          // snapshot so the bottom-panel Q4H badge/panel stays correct even if we missed the event stream.
          if (
            typedRunState.kind === 'blocked' &&
            (typedRunState.reason.kind === 'needs_human_input' ||
              typedRunState.reason.kind === 'needs_human_input_and_subdialogs')
          ) {
            this.wsManager.sendRaw({ type: 'get_q4h_state' });
          }

          this.recomputeRunControlCounts();

          // Ensure list views update immediately so the entire hierarchy reflects
          // run-state changes in real-time (not just the currently selected node).
          this.updateDialogList();

          // Forward to dialog container if this event targets it
          const dialogContainer = this.getDialogContainerForEvent(message);
          if (dialogContainer) {
            await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          }
          break;
        }

        case 'dlg_run_state_marker_evt': {
          const dialogContainer = this.getDialogContainerForEvent(message);
          if (dialogContainer) {
            await dialogContainer.handleDialogEvent(message as TypedDialogEvent);
          }
          break;
        }

        case 'dialog_ready': {
          // Enable q4h-input for this dialog
          const inputArea = this.q4hInput as HTMLElement & {
            setDisabled?: (disabled: boolean) => void;
          };
          if (inputArea && typeof inputArea.setDisabled === 'function') {
            inputArea.setDisabled(false);
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
          this.bumpDialogLastModified(
            { rootId: dialog.rootId, selfId: dialog.selfId },
            typeof ts === 'string' ? ts : undefined,
          );
          break;
      }
    } catch (error) {
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
        this.showToast(
          'Connection issue detected. Reminder data may be temporarily unavailable.',
          'error',
        );
      } else {
        this.showToast(
          'Reminder synchronization encountered an issue. Please refresh if problems persist.',
          'error',
        );
      }
    }
  }

  private bumpDialogLastModified(
    dialogId: { rootId: string; selfId: string },
    isoTs?: string,
  ): void {
    if (!isoTs) return;
    const res = bumpDialogsLastModified(this.dialogs || [], dialogId, isoTs);
    if (!res.changed) return;
    this.dialogs = res.dialogs;
    this.renderDialogList();
  }

  /**
   * Update reminder count badge based on actual operations
   */
  private updateReminderCountBadge(): void {
    // Update count badge in toolbar to show actual reminder count
    const remBtnCount = this.shadowRoot?.querySelector(
      '#toolbar-reminders-toggle span',
    ) as HTMLElement;
    if (remBtnCount) {
      remBtnCount.textContent = String(this.toolbarReminders.length);
    }

    // If widget is visible, update the header count and re-render content
    if (this.remindersWidgetVisible) {
      // Update ALL widget header counts (both inline and dynamically created)
      const widgetHeaders = this.shadowRoot?.querySelectorAll(
        '#reminders-widget-header span, .reminders-widget-header span',
      );
      if (widgetHeaders && widgetHeaders.length > 0) {
        widgetHeaders.forEach((header) => {
          header.textContent = formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length);
        });
      }

      // Re-render the widget content to ensure synchronization
      this.renderRemindersWidget();
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
    const existing = this.shadowRoot?.querySelector('#reminders-widget') as HTMLElement | null;
    if (this.remindersWidgetVisible) {
      const tb = this.shadowRoot?.querySelector('.toolbar') as HTMLElement;
      const rect = tb ? tb.getBoundingClientRect() : ({ right: 340, bottom: 80 } as DOMRect);
      this.remindersWidgetX = Math.max(12, rect.right - 340);
      this.remindersWidgetY = Math.max(12, rect.bottom + 8);
      if (!existing) {
        const widget = document.createElement('div');
        widget.id = 'reminders-widget';
        widget.style.position = 'fixed';
        widget.style.left = `${this.remindersWidgetX}px`;
        widget.style.top = `${this.remindersWidgetY}px`;
        widget.style.width = '320px';
        widget.style.maxHeight = '50vh';
        widget.style.overflow = 'auto';
        widget.style.border = '1px solid var(--dominds-border)';
        widget.style.background = 'var(--dominds-bg)';
        widget.style.borderRadius = '10px';
        widget.style.boxShadow = '0 8px 16px rgba(0,0,0,0.2)';
        widget.style.zIndex = '2000';
        widget.innerHTML = `
          <div id="reminders-widget-header" style="display:flex; align-items:center; justify-content: space-between; gap:8px; padding:8px 10px; border-bottom: 1px solid var(--dominds-border); cursor: grab;">
            <div style="display:flex; align-items:center; gap:8px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
              <span>${formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length)}</span>
            </div>
            <button id="reminders-widget-close" class="icon-button" aria-label="${t.close}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div id="reminders-widget-content" style="padding:8px 10px;"></div>
        `;
        this.shadowRoot?.appendChild(widget);
      }
      // Render reminder content after widget is visible
      this.renderRemindersWidget();
      this.setupRemindersWidgetDrag();
    } else if (existing) {
      existing.remove();
    }
  }

  /**
   * Render reminders widget content with proper formatting
   * Handles daemon reminders with PID and other metadata
   */
  private renderRemindersWidget(): void {
    if (!this.remindersWidgetVisible) return;

    // Find ALL widget content containers (both inline and dynamically created)
    const widgetContents = this.shadowRoot?.querySelectorAll(
      '#reminders-widget-content, .reminders-widget-content',
    );
    const widgetHeaders = this.shadowRoot?.querySelectorAll(
      '#reminders-widget-header span, .reminders-widget-header span',
    );

    if (!widgetContents || widgetContents.length === 0) {
      console.warn('No reminders widget content containers found');
      return;
    }

    // Always update ALL widget header counts first to ensure synchronization
    if (widgetHeaders && widgetHeaders.length > 0) {
      widgetHeaders.forEach((header) => {
        header.textContent = formatRemindersTitle(this.uiLanguage, this.toolbarReminders.length);
      });
    }

    // Generate content HTML once
    let contentHTML = '';
    if (this.toolbarReminders.length === 0) {
      const t = getUiStrings(this.uiLanguage);
      contentHTML = `<div style="color: var(--dominds-muted); font-style: italic; text-align: center; padding: 12px;">${t.noReminders}</div>`;
    } else {
      const t = getUiStrings(this.uiLanguage);
      const items = this.toolbarReminders
        .map((r, i) => {
          if (!r || !r.content) {
            return `<div class="rem-item"><div class="rem-item-number">${i + 1}.</div><div class="rem-item-content" style="color: var(--dominds-muted); font-style: italic;">${t.loading}</div></div>`;
          }

          // Format reminder content with metadata display if available
          let displayContent = r.content;

          // If this is a daemon reminder with metadata, display PID prominently
          if (r.meta && typeof r.meta === 'object') {
            const meta = r.meta as Record<string, unknown>;
            const metaPid = typeof meta.pid === 'number' ? meta.pid : undefined;
            const metaType = typeof meta.type === 'string' ? meta.type : undefined;
            const metaCommand = typeof meta.command === 'string' ? meta.command : undefined;

            // If this is a daemon type reminder with PID, show enhanced display
            if (metaType === 'daemon' && metaPid) {
              const pidStr = String(metaPid);
              const commandStr = metaCommand || t.unknownCommand;
              displayContent = `🔄 ${t.daemonLabel} (PID: ${pidStr})\n${t.commandLabel}: ${commandStr}`;
            }
          }

          // Format the content: escape HTML and preserve line breaks
          const formattedContent = displayContent
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          return `<div class="rem-item"><div class="rem-item-number">${i + 1}.</div><div class="rem-item-content">${formattedContent}</div></div>`;
        })
        .join('');
      contentHTML = items;
    }

    // Apply content to ALL widget containers
    widgetContents.forEach((widgetContent, index) => {
      widgetContent.innerHTML = contentHTML;
    });
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

    // Add to questions array (check for duplicates)
    const existingIndex = this.q4hQuestions.findIndex((eq) => eq.id === q.id);
    if (existingIndex >= 0) {
      // Update existing question
      this.q4hQuestions[existingIndex] = q;
    } else {
      // Add new question
      this.q4hQuestions.push(q);
    }

    // Build dialog contexts and update component
    this.updateQ4HComponent();
  }

  /**
   * Handle q4h_answered WebSocket event
   * Removes a question from the global Q4H state
   */
  private handleQ4HAnswered(event: Q4HAnsweredEvent): void {
    const removeIndex = this.q4hQuestions.findIndex((q) => q.id === event.questionId);
    if (removeIndex >= 0) {
      this.q4hQuestions.splice(removeIndex, 1);
    }

    // Build dialog contexts and update component
    this.updateQ4HComponent();
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
      if (!q || typeof q.id !== 'string' || q.id.trim() === '') continue;
      incomingById.set(q.id, q);
    }

    const next: HumanQuestion[] = [];
    const seenIds = new Set<string>();

    for (const existing of this.q4hQuestions) {
      const id = typeof existing.id === 'string' ? existing.id : '';
      if (!id || seenIds.has(id)) continue;
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
      const status = this.resolveDialogStatusByIds(rootId, selfId);

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
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      next.push(q);
    }

    this.q4hQuestions = next;
    this.updateQ4HComponent();
  }

  /**
   * Rebuild Q4H dialog contexts and update component
   */
  private updateQ4HComponent(): void {
    // Hide Q4H questions for dialogs that are no longer running.
    // Keep them in `this.q4hQuestions` so a revived dialog can restore immediately.
    const visibleQuestions = this.q4hQuestions.filter((question) => {
      const global = question as { selfId?: unknown; rootId?: unknown };
      const selfId = typeof global.selfId === 'string' ? global.selfId : null;
      if (!selfId) return true;
      const rootId = typeof global.rootId === 'string' && global.rootId ? global.rootId : selfId;
      const status = this.resolveDialogStatusByIds(rootId, selfId);
      return status !== 'completed' && status !== 'archived';
    });

    // Build dialog contexts from questions
    this.q4hDialogContexts = this.buildQ4HDialogContexts(visibleQuestions);
    this.q4hQuestionCount = visibleQuestions.length;

    // Transform to Q4HQuestion format expected by the component
    const q4hQuestions: Q4HQuestion[] = [];
    for (const context of this.q4hDialogContexts) {
      for (const question of context.questions) {
        q4hQuestions.push({
          id: question.id,
          headLine: question.headLine,
          bodyContent: question.bodyContent,
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

    // Fallback: try to find in dialogs list
    // This is limited since we don't have direct question-to-dialog mapping
    if (this.dialogs.length > 0) {
      const rootDialog = this.dialogs.find((d) => d.rootId === d.selfId || !d.supdialogId);
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
  private navigateToQ4HCallSite(
    questionId: string,
    dialogId: string,
    rootId: string,
    course: number,
    messageIndex: number,
  ): void {
    // Navigate to the dialog if needed
    if (this.currentDialog?.selfId !== dialogId) {
      const dialogInfo = this.dialogs.find((d) => d.selfId === dialogId || d.rootId === dialogId);
      if (dialogInfo) {
        this.selectDialog({
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
      // Navigate to the course if needed
      void dialogContainer.setCurrentCourse(course);
      // Scroll to call site - dispatch event for dialog container to handle
      dialogContainer.dispatchEvent(
        new CustomEvent('scroll-to-call-site', {
          detail: { course, messageIndex },
          bubbles: true,
          composed: true,
        }),
      );
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
