/**
 * Main application container component for Dominds WebUI
 */

import type { ConnectionState } from '@/services/store';
import faviconUrl from '../assets/favicon.svg';
import type { FrontendTeamMember } from '../services/api';
import { getApiClient } from '../services/api';
import { getWebSocketManager } from '../services/websocket.js';
import type { ApiRootDialogResponse, DialogInfo } from '../shared/types';
import type {
  FullRemindersEvent,
  NewQ4HAskedEvent,
  Q4HAnsweredEvent,
  ReminderContent,
  SubdialogEvent,
  TypedDialogEvent,
} from '../shared/types/dialog';
import type { HumanQuestion, Q4HDialogContext } from '../shared/types/q4h';
import type {
  DialogReadyMessage,
  ErrorMessage,
  Q4HStateResponse,
  WebSocketMessage,
  WelcomeMessage,
} from '../shared/types/wire';
import './dominds-dialog-container.js';
import { DomindsDialogContainer } from './dominds-dialog-container.js';
import './dominds-dialog-list.js';
import { DomindsDialogList } from './dominds-dialog-list.js';
import './dominds-q4h-input';
import './dominds-team-members.js';
import { DomindsTeamMembers } from './dominds-team-members.js';

export class DomindsApp extends HTMLElement {
  private wsManager = getWebSocketManager();
  private apiClient = getApiClient();
  private connectionState: ConnectionState = this.wsManager.getConnectionState();
  private dialogs: ApiRootDialogResponse[] = [];
  private currentDialog: DialogInfo | null = null; // Track currently selected dialog
  private teamMembers: FrontendTeamMember[] = [];
  private defaultResponder: string | null = null;
  private taskDocuments: Array<{ path: string; relativePath: string; name: string }> = [];
  private currentTheme: 'light' | 'dark' = this.getCurrentTheme();
  private backendWorkspace: string = '';
  private toolbarCurrentRound: number = 1;
  private toolbarTotalRounds: number = 1;
  private toolbarReminders: ReminderContent[] = [];
  private toolbarRemindersCollapsed: boolean = true;
  private remindersWidgetVisible: boolean = false;
  private remindersWidgetX: number = 12;
  private remindersWidgetY: number = 120;
  private _bodyObserver: MutationObserver | null = null;
  private _wsEventCancel?: () => void;
  private _connStateCancel?: () => void;
  private subdialogContainers = new Map<string, HTMLElement>(); // Map dialogId -> container element
  private subdialogHierarchyRefreshTokens = new Map<string, number>();

  // Q4H (Questions for Human) state
  private q4hQuestionCount: number = 0;
  private q4hQuestions: HumanQuestion[] = [];
  private q4hDialogContexts: Q4HDialogContext[] = [];

  // Resize handle state
  private isResizing = false;
  private resizeStartY = 0;
  private resizeStartConversationHeight = 0;
  private resizeStartQ4HHeight = 0;
  private lastQ4HExpandedHeight = 400; // Default expanded height when none saved

  private get hasQuestions(): boolean {
    return this.q4hQuestionCount > 0;
  }

  private get q4hInput(): import('./dominds-q4h-input').DomindsQ4HInput | null {
    return (
      (this.shadowRoot?.querySelector('#q4h-input') as
        | import('./dominds-q4h-input').DomindsQ4HInput
        | null
        | undefined) ?? null
    );
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  // Type guard to check if WebSocketMessage has dialog context
  // Also accepts subdialog events which have parentDialog/subDialog instead of dialog
  private hasDialogContext(
    message: WebSocketMessage,
  ): message is WebSocketMessage & { dialog: { selfId: string; rootId: string } } {
    // Check for standard dialog field
    if (
      'dialog' in message &&
      typeof (message as any).dialog === 'object' &&
      typeof (message as any).dialog.selfId === 'string' &&
      typeof (message as any).dialog.rootId === 'string'
    ) {
      return true;
    }
    // Check for subdialog events (have parentDialog/subDialog instead)
    if (
      'parentDialog' in message &&
      typeof (message as any).parentDialog === 'object' &&
      typeof (message as any).parentDialog.selfId === 'string' &&
      typeof (message as any).parentDialog.rootId === 'string'
    ) {
      return true;
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
    // Apply theme immediately before any rendering to prevent flash
    this.applyTheme(this.currentTheme);
    this.initialRender();
    this.setupEventListeners();
    this.loadInitialData();

    // Subscribe to connection state changes for Q4H loading
    const connStateSub = this.wsManager.subscribeToConnectionState();
    this._connStateCancel = connStateSub.cancel;
    (async () => {
      for await (const state of connStateSub.stream()) {
        this.handleConnectionStateChange(state);
      }
    })();

    // Ensure document body stays consistent
    this.ensureDocumentThemeConsistency();

    // Watch for document body style changes to maintain theme consistency
    this.observeDocumentBodyChanges();

    // Sync theme with child components immediately and with timeout for robustness
    this.syncThemeWithChildComponents(this.currentTheme);
    setTimeout(() => {
      this.syncThemeWithChildComponents(this.currentTheme);
    }, 100);
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

    // Clean up MutationObserver
    if (this._bodyObserver) {
      this._bodyObserver.disconnect();
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
    const dialogList = this.shadowRoot.querySelector('#dialog-list');
    if (dialogList instanceof DomindsDialogList) {
      dialogList.setDialogs(this.dialogs);
      const onSelect = (dialog: DialogInfo) => this.selectDialog(dialog);
      const onSearch = (query: string) => this.handleDialogSearch(query);
      dialogList.setProps({ onSelect, onSearch });
    }
    const teamMembers = this.shadowRoot.querySelector('#team-members');
    if (teamMembers instanceof DomindsTeamMembers) {
      teamMembers.setMembers(this.teamMembers);
    }

    // Sync theme with child components after render
    this.syncThemeWithChildComponents(this.currentTheme);
  }

  /**
   * Surgical update: Update only the dialog list without destroying the container.
   * Use this after dialog list changes (e.g., subdialog creation, dialog loading).
   */
  private updateDialogList(): void {
    const dialogList = this.shadowRoot?.querySelector('#dialog-list');
    if (dialogList instanceof DomindsDialogList) {
      dialogList.setDialogs(this.dialogs);
    }
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
   * Use this when dialog is loaded or round changes.
   */
  private updateToolbarDisplay(): void {
    const prevBtn = this.shadowRoot?.querySelector('#toolbar-prev') as HTMLButtonElement | null;
    const nextBtn = this.shadowRoot?.querySelector('#toolbar-next') as HTMLButtonElement | null;
    const remBtnCount = this.shadowRoot?.querySelector(
      '#toolbar-reminders-toggle span',
    ) as HTMLElement | null;
    const roundLabel = this.shadowRoot?.querySelector('#round-nav span') as HTMLElement | null;

    if (prevBtn) prevBtn.disabled = this.toolbarCurrentRound <= 1;
    if (nextBtn) nextBtn.disabled = this.toolbarCurrentRound >= this.toolbarTotalRounds;
    if (remBtnCount) remBtnCount.textContent = String(this.toolbarReminders.length);
    if (roundLabel) roundLabel.textContent = `R ${this.toolbarCurrentRound}`;
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
      }

      .app-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
      }

      /* Theme CSS custom properties */
      :host(.dark) {
        --dominds-bg: #2d2d2d;
        --dominds-fg: #ffffff;
        --dominds-border: #404040;
        --dominds-header-bg: #2d2d2d;
        --dominds-sidebar-bg: #2d2d2d;
        --dominds-toolbar-bg: #2d2d2d;
        --dominds-hover: #3a3a3a;
        --dominds-muted: #9ca3af;
        --dominds-disabled: #2d2d2d;
        --dominds-primary: #5b8def;
        --dominds-primary-hover: #4a7bdb;
        --dominds-secondary: #5a6268;
        --dominds-secondary-hover: #4a5156;
        --dominds-success: #28a745;
        --dominds-warning: #ffc107;
        --dominds-danger: #dc3545;
        --dominds-success-bg: #1e3a1e;
        --dominds-warning-bg: #3a2a1e;
        --dominds-danger-bg: #3a1e1e;
        
        /* Standard color variables for child components */
        --color-bg-primary: #0f172a;
        --color-bg-secondary: #1e293b;
        --color-bg-tertiary: #334155;
        --color-fg-primary: #f8fafc;
        --color-fg-secondary: #cbd5e1;
        --color-fg-tertiary: #94a3b8;
        --color-accent-primary: #60a5fa;
        --color-border-primary: #334155;
        --color-error: #ef4444;
        --error-bg: #7f1d1d;
        --success-bg: #14532d;
      }

      :host(.light) {
        --dominds-bg: rgb(248, 249, 250);
        --dominds-fg: #333333;
        --dominds-border: #e0e0e0;
        --dominds-header-bg: #f8f9fa;
        --dominds-sidebar-bg: #f8f9fa;
        --dominds-toolbar-bg: #f8f9fa;
        --dominds-hover: #f8f9fa;
        --dominds-muted: #666666;
        
        /* Standard color variables for child components */
        --color-bg-primary: #ffffff;
        --color-bg-secondary: #f8fafc;
        --color-bg-tertiary: #f1f5f9;
        --color-fg-primary: #0f172a;
        --color-fg-secondary: #475569;
        --color-fg-tertiary: #64748b;
        --color-accent-primary: #3b82f6;
        --color-border-primary: #e2e8f0;
        --color-error: #ef4444;
        --error-bg: #fee2e2;
        --success-bg: #dcfce7;
      }

      .header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
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
        margin-right: 16px;
      }

      .workspace-indicator {
        font-size: 11px;
        color: var(--dominds-muted, #666666);
        font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
        background: var(--dominds-hover, #f8f9fa);
        padding: 1px 8px;
        border-radius: 4px;
        border: 1px solid var(--dominds-border, #e0e0e0);
        flex: 1;
        min-width: 0;
        height: calc(1em * 1.4 * 0.85);
        display: flex;
        align-items: center;
        justify-content: flex-start;
        margin-left: 24px;
        margin-right: 24px;
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
        margin-left: 16px;
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

      .sidebar-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--dominds-border);
        flex-shrink: 0;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
      }

      .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
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

      #round-nav {
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

      .badge-button:hover {
        background: var(--dominds-hover, #f0f0f0);
        border-color: var(--dominds-primary, #007acc);
      }

      .dialog-section {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        position: relative;
      }

      /* Conversation area scrolls independently */
      .conversation-scroll-area {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        contain: content;
        transition: height 0.3s ease-out;
      }

      .q4h-input-section {
        transition: height 0.3s ease-out, max-height 0.3s ease-out;
      }

      .resizing .conversation-scroll-area,
      .resizing .q4h-input-section {
        transition: none !important;
      }

      .q4h-collapsed .resize-handle {
        display: none;
      }

      /* Resize handle between conversation and q4h-input */
      .resize-handle {
        height: 6px;
        background: transparent;
        cursor: row-resize;
        position: relative;
        flex-shrink: 0;
        z-index: 10;
      }

      .resize-handle::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 50%;
        transform: translateX(-50%);
        width: 40px;
        height: 2px;
        background: var(--dominds-border, #e0e0e0);
        border-radius: 1px;
        transition: background 0.2s;
      }

      .resize-handle:hover::after,
      .resize-handle.resizing::after {
        background: var(--dominds-primary, #6366f1);
      }

      .resize-handle.resizing {
        cursor: row-resize;
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
        box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.1);
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
        box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.1);
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
    return `
      <div class="app-container">
        <header class="header">
          <div class="logo">
            <img src="${faviconUrl}" width="20" height="20" alt="Dominds Logo" />
            <span>Dominds</span>
          </div>
          <div class="workspace-indicator" title="Backend Runtime Workspace">
            📁 ${this.backendWorkspace || 'Loading...'}
          </div>
          <div class="header-actions">
            <dominds-connection-status status="${this.connectionState.status}" ${this.connectionState.error ? `error="${this.connectionState.error}"` : ''}></dominds-connection-status>
            <button id="theme-toggle-btn" class="theme-toggle" title="Switch theme">
              ${this.currentTheme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </header>

        <div class="main-content">
          <aside class="sidebar">
            <div class="sidebar-header">
              <button class="icon-button" id="new-dialog-btn" title="New Dialog">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <dominds-team-members id="team-members" show-actions="true" style="margin-left: auto;"></dominds-team-members>
            </div>
            <div class="sidebar-content">
              <dominds-dialog-list 
                id="dialog-list"
                show-search="true"
                show-filters="true"
                max-height="calc(100vh - 200px)"
              ></dominds-dialog-list>
            </div>
          </aside>

          <main class="content-area">
            <div class="toolbar">
              <div id="current-dialog-title">Select or create a dialog to start</div>
              <div style="flex: 1;"></div>
              <div id="round-nav">
                <button class="icon-button" id="toolbar-prev" ${this.toolbarCurrentRound > 1 ? '' : 'disabled'} aria-label="Previous Round">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
              <span style="margin: 0 8px; min-width: 28px; display:inline-block; text-align:center;">R ${this.toolbarCurrentRound}</span>
              <button class="icon-button" id="toolbar-next" ${this.toolbarCurrentRound < this.toolbarTotalRounds ? '' : 'disabled'} aria-label="Next Round">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </button>
            </div>
          <div id="reminders-callout" style="position: relative; margin-left: 12px;">
            <button class="badge-button" id="toolbar-reminders-toggle" aria-label="Reminders">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
              <span>${String(this.toolbarReminders.length)}</span>
            </button>
            <button class="icon-button" id="toolbar-reminders-refresh" title="Refresh Reminders" aria-label="Refresh Reminders" style="margin-left:6px;">
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
                  <span>Reminders (${String(this.toolbarReminders.length)})</span>
                </div>
                <button id="reminders-widget-close" class="icon-button" aria-label="Close">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>
              <div id="reminders-widget-content" style="padding:8px 10px;">
                ${
                  this.toolbarReminders.length === 0
                    ? '<div style="color: var(--dominds-muted); font-style: italic; text-align: center; padding: 12px;">No reminders</div>'
                    : '<div class="reminders-widget-content"></div>'
                }
              </div>
            </div>
            `
                : ''
            }

            <div class="dialog-section q4h-collapsed">
              <div class="conversation-scroll-area">
                <dominds-dialog-container id="dialog-container"></dominds-dialog-container>
              </div>
              <div class="resize-handle" id="resize-handle"></div>
              <dominds-q4h-input
                id="q4h-input"
                class="q4h-input-section"
              ></dominds-q4h-input>
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

    // ========== Q4H Event Handlers ==========
    // Q4H navigate to call site event - delegated to q4h-input component
    this.shadowRoot.addEventListener('q4h-navigate-call-site', (event: Event) => {
      const ce = event as CustomEvent<{
        questionId: string;
        dialogId: string;
        rootId: string;
        round: number;
        messageIndex: number;
      }>;
      const { questionId, dialogId, rootId, round, messageIndex } = ce.detail || {};
      if (questionId && dialogId && rootId) {
        this.navigateToQ4HCallSite(questionId, dialogId, rootId, round, messageIndex);
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

      // Toolbar navigation
      const prevBtn = target.closest('#toolbar-prev') as HTMLButtonElement | null;
      if (prevBtn) {
        if (this.toolbarCurrentRound > 1) {
          const dc = this.shadowRoot?.querySelector(
            '#dialog-container',
          ) as DomindsDialogContainer | null;
          if (dc && typeof dc.setCurrentRound === 'function') {
            await dc.setCurrentRound(this.toolbarCurrentRound - 1);
          }
          this.toolbarCurrentRound = Math.max(1, this.toolbarCurrentRound - 1);
          this.updateToolbarRoundDisplay();
        }
        return;
      }

      const nextBtn = target.closest('#toolbar-next') as HTMLButtonElement | null;
      if (nextBtn) {
        if (this.toolbarCurrentRound < this.toolbarTotalRounds) {
          const dc = this.shadowRoot?.querySelector('#dialog-container') as any;
          if (dc && typeof dc.setCurrentRound === 'function') {
            await dc.setCurrentRound(this.toolbarCurrentRound + 1);
          }
          this.toolbarCurrentRound = Math.min(
            this.toolbarTotalRounds,
            this.toolbarCurrentRound + 1,
          );
          this.updateToolbarRoundDisplay();
        }
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
   * Helper to update the toolbar round navigation display
   */
  private updateToolbarRoundDisplay(): void {
    if (!this.shadowRoot) return;
    const prev = this.shadowRoot.querySelector('#toolbar-prev') as HTMLButtonElement;
    const next = this.shadowRoot.querySelector('#toolbar-next') as HTMLButtonElement;
    if (prev) prev.disabled = !(this.toolbarCurrentRound > 1);
    if (next) next.disabled = !(this.toolbarCurrentRound < this.toolbarTotalRounds);
    const label = this.shadowRoot.querySelector('#round-nav span') as HTMLElement;
    if (label) label.textContent = `R ${this.toolbarCurrentRound}`;
  }

  /**
   * Sets up event listeners for specific elements that are recreated on every render.
   * This should be called from render() after updating innerHTML.
   */
  private setupElementEventListeners(): void {
    if (!this.shadowRoot) return;

    // Resize handle listeners - crucial to re-attach after render
    const resizeHandle = this.shadowRoot.querySelector('#resize-handle');
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', (e) => this.startResize(e as MouseEvent));
      resizeHandle.addEventListener('touchstart', (e) => this.startResize(e as TouchEvent), {
        passive: false,
      });
    }

    // Dialog container listeners
    const dialogContainerEl = this.shadowRoot.querySelector('#dialog-container') as HTMLElement;
    if (dialogContainerEl) {
      dialogContainerEl.addEventListener('round-selected', (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        const round = detail.round;
        const totalRounds = detail.totalRounds;
        const latest = typeof totalRounds === 'number' ? totalRounds : round;
        this.toolbarCurrentRound = round || this.toolbarCurrentRound;
        this.toolbarTotalRounds = latest || this.toolbarTotalRounds;
        this.updateToolbarRoundDisplay();

        const input = this.q4hInput as HTMLElement & {
          setDisabled?: (disabled: boolean) => void;
        };
        if (input && typeof input.setDisabled === 'function') {
          input.setDisabled(round !== latest);
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

    // Q4H toggle listener
    const q4hInputEl = this.shadowRoot.querySelector('#q4h-input') as HTMLElement;
    if (q4hInputEl) {
      q4hInputEl.addEventListener('q4h-toggle', (e: Event) => {
        const expanded = (e as CustomEvent).detail.expanded;
        const conversationArea = this.shadowRoot?.querySelector(
          '.conversation-scroll-area',
        ) as HTMLElement;
        const dialogSection = this.shadowRoot?.querySelector('.dialog-section') as HTMLElement;

        if (expanded) {
          // Show resize handle
          if (dialogSection) dialogSection.classList.remove('q4h-collapsed');

          // Restore height only if we have a saved height
          if (q4hInputEl) {
            if (this.lastQ4HExpandedHeight > 130) {
              q4hInputEl.style.height = `${this.lastQ4HExpandedHeight}px`;
              q4hInputEl.style.maxHeight = `${this.lastQ4HExpandedHeight}px`;
              q4hInputEl.style.flex = 'none';
            } else {
              // Default expanded state if no height remembered
              q4hInputEl.style.height = '400px';
              q4hInputEl.style.maxHeight = '1000px';
              q4hInputEl.style.flex = 'none';
            }
          }

          if (conversationArea) {
            // Let conversation area be flexible
            conversationArea.style.height = '';
            conversationArea.style.flex = '1';
          }
        } else {
          // Save current height before collapsing
          const currentHeight = q4hInputEl.getBoundingClientRect().height;
          if (currentHeight > 130) {
            this.lastQ4HExpandedHeight = currentHeight;
          }

          // Hide resize handle
          if (dialogSection) dialogSection.classList.add('q4h-collapsed');

          // Clear programmatically set heights to allow natural flow
          if (q4hInputEl) {
            q4hInputEl.style.height = '';
            q4hInputEl.style.maxHeight = '';
            q4hInputEl.style.flex = '';
          }
          if (conversationArea) {
            conversationArea.style.height = '';
            conversationArea.style.flex = '';
          }
        }
      });
    }
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

  private async loadDialogs(): Promise<void> {
    try {
      const api = getApiClient();
      const resp = await api.getRootDialogs();

      if (resp.success && Array.isArray(resp.data)) {
        // Store root dialogs with their subdialog counts
        // Subdialogs will be loaded lazily when user expands a root dialog
        this.dialogs = resp.data;
        this.renderDialogList();
      } else {
        console.warn('Failed to load dialogs via API', resp.error);
      }
    } catch (error) {
      console.error('Error in loadDialogs:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load dialogs: ${message}`, 'error');
    }
  }

  /**
   * Lazy load subdialogs for a root dialog when user expands it
   */
  private async loadSubdialogsForRoot(rootId: string): Promise<void> {
    try {
      const api = getApiClient();
      const hierarchyResp = await api.getDialogHierarchy(rootId);

      if (hierarchyResp.success && hierarchyResp.data) {
        const h = hierarchyResp.data;
        // h is {root: {...}, subdialogs: [...]}

        if (Array.isArray(h.subdialogs)) {
          const newSubdialogs: ApiRootDialogResponse[] = [];

          for (const subdialog of h.subdialogs) {
            if (subdialog && subdialog.rootId) {
              newSubdialogs.push({
                rootId: subdialog.rootId,
                selfId: subdialog.selfId,
                agentId: subdialog.agentId,
                taskDocPath: subdialog.taskDocPath,
                status: subdialog.status,
                currentRound: subdialog.currentRound,
                createdAt: subdialog.createdAt,
                lastModified: subdialog.lastModified,
                supdialogId: rootId, // Link to parent
              });
            }
          }

          // Add new subdialogs to existing dialogs list
          const existingSubdialogs = this.dialogs.filter(
            (d) => d.supdialogId === rootId && d.selfId !== undefined,
          );

          // Deduplicate and merge
          const existingKeys = new Set(existingSubdialogs.map((d) => `${d.rootId}:${d.selfId}`));
          const trulyNew = newSubdialogs.filter(
            (d) => !existingKeys.has(`${d.rootId}:${d.selfId}`),
          );

          if (trulyNew.length > 0) {
            this.dialogs = [...this.dialogs, ...trulyNew];
            this.renderDialogList();
          }
        }
      }
    } catch (hierarchyError) {
      console.warn(`Failed to load hierarchy for root dialog ${rootId}:`, hierarchyError);
    }
  }

  private async loadTeamMembers(): Promise<void> {
    try {
      const api = getApiClient();
      const resp = await api.getTeamConfig();
      if (resp.success && resp.data && (resp.data as any).configuration) {
        const cfg = (resp.data as any).configuration;
        const md = cfg.memberDefaults;
        const membersRec = cfg.members || {};
        Object.keys(membersRec).forEach((id) => {
          const m = membersRec[id];
          Object.setPrototypeOf(m, md);
        });
        this.teamMembers = Object.values(membersRec) as FrontendTeamMember[];
        const def = cfg.defaultResponder;
        this.defaultResponder = typeof def === 'string' ? def : null;
      }

      const teamMembersComponent = this.shadowRoot?.querySelector(
        '#team-members',
      ) as HTMLElement & {
        setMembers?: (members: FrontendTeamMember[]) => void;
      };
      if (teamMembersComponent && teamMembersComponent.setMembers) {
        teamMembersComponent.setMembers(this.teamMembers);
      }

      if (this.teamMembers.length === 0) {
        this.showWarning('No team members configured');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.showError(`Failed to load team members: ${message}`, 'warning');
    }
  }

  private async loadTaskDocuments(): Promise<void> {
    try {
      const response = await fetch('/api/task-documents');
      const data = (await response.json()) as {
        success: boolean;
        taskDocuments?: Array<{ path: string; relativePath: string; name: string }>;
      };

      if (data.success && data.taskDocuments) {
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
      const response = await fetch('/api/health');
      const data = await response.json();

      if (data.workspace) {
        this.backendWorkspace = data.workspace;
        this.updateWorkspaceInfo();
      }
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
          `❌ CRITICAL ERROR: Dialog at index ${index} (ID: ${dialog.rootId}) has invalid task document path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Task document is mandatory for all dialogs.`,
        );
      }
    });

    // Use the enhanced dialog list component with proper deduplication
    const dialogList = this.shadowRoot.querySelector('#dialog-list');

    if (dialogList instanceof DomindsDialogList) {
      // Use setDialogs which properly deduplicates by rootId:selfId
      dialogList.setDialogs(this.dialogs);

      // Add event listener for dialog expand (lazy subdialog loading)
      dialogList.addEventListener('dialog-expand', ((event: CustomEvent) => {
        const { rootId } = event.detail;
        if (rootId) {
          this.loadSubdialogsForRoot(rootId);
        }
      }) as EventListener);
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

        // Enable input immediately after successful dialog selection
        // (dialog_ready event will handle re-enabling if needed)
        setTimeout(() => {
          this.q4hInput?.setDisabled(false);
        }, 500); // Small delay to ensure setDialog completes

        // Auto-focus the input after dialog selection
        setTimeout(() => {
          this.q4hInput?.focusInput();
        }, 100);
      } else {
        console.warn('❌ Auto-focus: No q4h-input component found after dialog selection');
      }

      // Update the dialog list to show current selection
      const dialogList = this.shadowRoot?.querySelector('#dialog-list');
      if (dialogList instanceof DomindsDialogList) {
        dialogList.setCurrentDialog(normalizedDialog);
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
    const subdialog = this.dialogs.find((d) => d.rootId === rootId && d.selfId === subdialogId);

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

  private handleConnectionStateChange(state: ConnectionState): void {
    this.connectionState = state;
    this.updateConnectionStatus();

    // Update UI based on connection state
    if (state.status === 'connected') {
      // Fetch Q4H state from ALL running dialogs for global display
      // This ensures all pending Q4H questions are shown regardless of which dialog is selected
      this.wsManager.sendRaw({
        type: 'get_q4h_state',
      });
    } else if (state.status === 'error') {
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

  private showCreateDialogModal(): void {
    const modal = document.createElement('div');
    modal.className = 'create-dialog-modal';
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content" role="dialog" aria-labelledby="modal-title" aria-modal="true">
        <div class="modal-header">
          <h3 id="modal-title">Create New Dialog</h3>
          <button class="modal-close" aria-label="Close">
            ✕
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="task-doc-input">Task Document:</label>
            <div class="task-doc-container">
              <input type="text" id="task-doc-input" class="task-doc-input" placeholder="Type to search task documents..." autocomplete="off">
              <div id="task-doc-suggestions" class="task-doc-suggestions"></div>
            </div>
            <small class="form-help">Select from existing documents or enter a custom path. Required field. Tab completes common prefix, Enter selects highlighted item.</small>
          </div>

          <div class="form-group">
            <label for="teammate-select">Teammate:</label>
            <select id="teammate-select" class="teammate-dropdown">
              ${this.teamMembers
                .map((member) => {
                  const isDefault = member.id === this.defaultResponder;
                  const emoji = this.getAgentEmoji(member.id, (member as any).icon);
                  return `<option value="${member.id}" ${isDefault ? 'selected' : ''}>
                  ${emoji} ${member.name} (@${member.id})${isDefault ? ' • Default' : ''}
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
            Cancel
          </button>
          <button class="btn btn-primary" id="create-dialog-btn">
            Create Dialog
          </button>
        </div>
      </div>
    `;

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
      if (agentId) {
        const member = this.teamMembers.find((m) => m.id === agentId);
        if (member) {
          const emoji = this.getAgentEmoji(member.id, (member as any).icon);
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
        }
      } else {
        teammateInfo.style.display = 'none';
      }
    };

    // Show teammate info when selection changes
    select.addEventListener('change', () => {
      showTeammateInfo(select.value);
    });

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
      if (!taskDocPath) {
        taskDocPath = 'socializing.md';
      }

      const selectedAgentId = select.value || undefined; // undefined means use default
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
      // Accept either {selfId, rootId} or legacy {dialogId}
      if (!resp.success || !resp.data) {
        throw new Error(resp.error || 'Dialog creation failed');
      }
      const payload = (resp.data as any) || {};
      const selfId = payload.selfId || payload.dialogId;
      const rootId = payload.rootId || payload.dialogId || selfId;
      if (!selfId || !rootId) {
        throw new Error('Dialog creation failed: invalid identifiers in response');
      }
      if (typeof selfId !== 'string' || typeof rootId !== 'string') {
        this.showError('Invalid dialog identifiers in createDialog response', 'error');
        throw new Error('Invalid dialog identifiers');
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

  private handleDialogSearch(query: string): void {
    // Handle dialog search if needed
    console.info('(To be implemented) Searching dialogs:', query);
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

  private getCurrentTheme(): 'light' | 'dark' {
    const stored = localStorage.getItem('dominds-theme');
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }

    // Check system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    this.currentTheme = theme;

    // Apply theme to main app host
    if (theme === 'dark') {
      this.classList.add('dark');
      this.classList.remove('light');
    } else {
      this.classList.add('light');
      this.classList.remove('dark');
    }

    // Apply consistent theme to document body to prevent flash
    if (theme === 'dark') {
      document.body.classList.add('dark');
      document.body.classList.remove('light');
      // Use consistent dark background
      document.body.style.background = '#2d2d2d';
      document.body.style.backgroundColor = '#2d2d2d';
      document.body.style.color = '#ffffff';
    } else {
      document.body.classList.add('light');
      document.body.classList.remove('dark');
      // Use consistent light background matching main app: rgb(248, 249, 250)
      document.body.style.background = 'rgb(248, 249, 250)';
      document.body.style.backgroundColor = 'rgb(248, 249, 250)';
      document.body.style.color = '#333333';
    }

    // Store in localStorage
    localStorage.setItem('dominds-theme', theme);

    // Ensure document body stays consistent with theme
    this.ensureDocumentThemeConsistency();

    // Sync theme properties with child components
    this.syncThemeWithChildComponents(theme);

    // Update theme toggle button if it exists
    this.updateThemeToggle();
  }

  /**
   * Sync theme CSS custom properties with child Shadow DOM components
   */
  private syncThemeWithChildComponents(theme: 'light' | 'dark'): void {
    const dialogContainer = this.shadowRoot?.querySelector(
      'dominds-dialog-container',
    ) as HTMLElement;
    const q4hInput = this.shadowRoot?.querySelector('#q4h-input') as HTMLElement;

    // Apply host theme class to child components
    const components = [dialogContainer, q4hInput].filter(Boolean) as HTMLElement[];
    components.forEach((el) => {
      if (theme === 'dark') {
        el.classList.add('dark');
        el.classList.remove('light');
      } else {
        el.classList.add('light');
        el.classList.remove('dark');
      }
    });

    if (components.length === 0) return;

    if (theme === 'dark') {
      // Use main app's actual background color (#2d2d2d = rgb(45, 45, 45))
      const props = {
        '--color-bg-primary': '#2d2d2d',
        '--color-bg-secondary': '#3a3a3a',
        '--color-bg-tertiary': '#4a4a4a',
        '--color-fg-primary': '#ffffff',
        '--color-fg-secondary': '#cbd5e1',
        '--color-fg-tertiary': '#94a3b8',
        '--color-accent-primary': '#60a5fa',
        '--color-border-primary': '#404040',
        '--color-error': '#ef4444',
        '--error-bg': '#7f1d1d',
        '--success-bg': '#14532d',
      };
      components.forEach((el) => {
        Object.entries(props).forEach(([prop, val]) => el.style.setProperty(prop, val));
      });
    } else {
      // Use main app's actual background color for exact match
      const mainAppBg = window.getComputedStyle(this).backgroundColor;
      const props = {
        '--color-bg-primary': mainAppBg,
        '--color-bg-secondary': '#f8fafc',
        '--color-bg-tertiary': '#f1f5f9',
        '--color-fg-primary': '#0f172a',
        '--color-fg-secondary': '#475569',
        '--color-fg-tertiary': '#64748b',
        '--color-accent-primary': '#3b82f6',
        '--color-border-primary': '#e2e8f0',
        '--color-error': '#ef4444',
        '--error-bg': '#fee2e2',
        '--success-bg': '#dcfce7',
      };
      components.forEach((el) => {
        Object.entries(props).forEach(([prop, val]) => el.style.setProperty(prop, val));
      });
    }
    // Q4H input component handles its own theme via Shadow DOM
  }

  private toggleTheme(): void {
    const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    this.applyTheme(newTheme);
  }

  /**
   * Ensure document body theme stays consistent with app theme
   */
  private ensureDocumentThemeConsistency(): void {
    if (this.currentTheme === 'dark') {
      if (document.body.style.backgroundColor !== '#2d2d2d') {
        document.body.style.background = '#2d2d2d';
        document.body.style.backgroundColor = '#2d2d2d';
        document.body.style.color = '#ffffff';
      }
    } else {
      if (document.body.style.backgroundColor !== 'rgb(248, 249, 250)') {
        document.body.style.background = 'rgb(248, 249, 250)';
        document.body.style.backgroundColor = 'rgb(248, 249, 250)';
        document.body.style.color = '#333333';
      }
    }
  }

  /**
   * Observe document body changes to maintain theme consistency
   */
  private observeDocumentBodyChanges(): void {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          // Document body style changed, ensure theme consistency
          this.ensureDocumentThemeConsistency();
        }
      });
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['style'],
      attributeOldValue: true,
    });

    // Store observer reference for cleanup
    this._bodyObserver = observer;
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
        };
        // Update q4h-input with the active dialog ID
        if (this.q4hInput && typeof this.q4hInput.setDialog === 'function') {
          this.q4hInput.setDialog(this.currentDialog);
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
        this.showToast('Received invalid message format. Please refresh the page.', 'error');
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
        case 'round_update': {
          // Update toolbar round information
          this.toolbarCurrentRound = message.round;
          this.toolbarTotalRounds = message.totalRounds;
          const prevBtn = this.shadowRoot?.querySelector('#toolbar-prev') as HTMLButtonElement;
          const nextBtn = this.shadowRoot?.querySelector('#toolbar-next') as HTMLButtonElement;
          if (prevBtn) prevBtn.disabled = !(this.toolbarCurrentRound > 1);
          if (nextBtn) nextBtn.disabled = !(this.toolbarCurrentRound < this.toolbarTotalRounds);
          const roundLabel = this.shadowRoot?.querySelector('#round-nav span') as HTMLElement;
          if (roundLabel) roundLabel.textContent = `R ${this.toolbarCurrentRound}`;
          const latest = message.totalRounds;
          const input = this.q4hInput as HTMLElement & {
            setDisabled?: (disabled: boolean) => void;
          };
          if (input && typeof input.setDisabled === 'function') {
            input.setDisabled(this.toolbarCurrentRound !== latest);
          }
          this.bumpDialogLastModified(dialog.rootId, (message as TypedDialogEvent).timestamp);
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
                currentRound: root.currentRound,
                createdAt: root.createdAt,
                lastModified: root.lastModified,
              });
              for (const sd of subs) {
                entries.push({
                  rootId: root.id, // Subdialogs belong to the supdialog's root for proper path resolution
                  selfId: sd.selfId, // Subdialog's own unique identifier
                  agentId: sd.agentId,
                  taskDocPath: sd.taskDocPath,
                  status: sd.status,
                  currentRound: sd.currentRound,
                  createdAt: sd.createdAt,
                  lastModified: sd.lastModified,
                  supdialogId: root.id,
                });
              }
              // Merge into existing dialogs: replace any entries under this root
              this.dialogs = this.dialogs.filter(
                (d) => d.rootId !== root.id && d.supdialogId !== root.id,
              );
              this.dialogs.push(...entries);
              // FIXED: Use surgical update instead of full render to preserve dialog container state
              this.updateDialogList();
              if (this.currentDialog && this.currentDialog.rootId === rootId && this.shadowRoot) {
                const dialogList = this.shadowRoot.querySelector('#dialog-list');
                if (dialogList instanceof DomindsDialogList) {
                  dialogList.expandMainDialog(rootId, false);
                }
              }
              this.bumpDialogLastModified(
                rootId,
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
          this.bumpDialogLastModified(dialog.rootId, typeof ts === 'string' ? ts : undefined);
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
          this.bumpDialogLastModified(dialog.rootId, typeof ts === 'string' ? ts : undefined);
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

  private bumpDialogLastModified(rootId: string, isoTs?: string): void {
    if (!isoTs) return;
    const ts = isoTs;
    let updated = false;
    this.dialogs = (this.dialogs || []).map((d: any) => {
      if ((d && d.rootId && d.rootId === rootId) || (d && d.id && d.id === rootId)) {
        updated = true;
        return { ...d, lastModified: ts };
      }
      return d;
    });
    if (updated) {
      this.renderDialogList();
    }
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
          header.textContent = `Reminders (${this.toolbarReminders.length})`;
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
              <span>Reminders (${String(this.toolbarReminders.length)})</span>
            </div>
            <button id="reminders-widget-close" class="icon-button" aria-label="Close">
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
        header.textContent = `Reminders (${this.toolbarReminders.length})`;
      });
    }

    // Generate content HTML once
    let contentHTML = '';
    if (this.toolbarReminders.length === 0) {
      contentHTML =
        '<div style="color: var(--dominds-muted); font-style: italic; text-align: center; padding: 12px;">No reminders</div>';
    } else {
      const items = this.toolbarReminders
        .map((r, i) => {
          if (!r || !r.content) {
            return `<div class="rem-item"><div class="rem-item-number">${i + 1}.</div><div class="rem-item-content" style="color: var(--dominds-muted); font-style: italic;">Loading...</div></div>`;
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
              const commandStr = metaCommand || 'unknown command';
              displayContent = `🔄 Daemon (PID: ${pidStr})\nCommand: ${commandStr}`;
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

    this.q4hQuestionCount = this.q4hQuestions.length;

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

    this.q4hQuestionCount = this.q4hQuestions.length;

    // Build dialog contexts and update component
    this.updateQ4HComponent();
  }

  /**
   * Handle q4h_state_response - initial load of all Q4H questions
   */
  private handleQ4HStateResponse(event: Q4HStateResponse): void {
    // Replace entire questions array with response
    this.q4hQuestions = event.questions;
    this.q4hQuestionCount = this.q4hQuestions.length;

    // Build dialog contexts and update component
    this.updateQ4HComponent();
  }

  /**
   * Rebuild Q4H dialog contexts and update component
   */
  private updateQ4HComponent(): void {
    // Build dialog contexts from questions
    this.q4hDialogContexts = this.buildQ4HDialogContexts(this.q4hQuestions);

    // Transform to Q4HQuestion format expected by the component
    const q4hQuestions: import('./dominds-q4h-input').Q4HQuestion[] = [];
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
  }

  /**
   * Build Q4H dialog contexts from questions array
   * Groups questions by dialog and includes agent information
   * Supports both regular HumanQuestion and GlobalQ4HQuestion (with embedded dialog context)
   */
  private buildQ4HDialogContexts(questions: HumanQuestion[]): Q4HDialogContext[] {
    // Group questions by their source dialog
    // Note: For global Q4H, questions may have embedded dialog context (dialogId, rootId, agentId, taskDocPath)
    // For single-dialog Q4H, we need to look up dialog info from the frontend's dialogs list

    const contextMap = new Map<string, Q4HDialogContext>();

    for (const question of questions) {
      // Check if this is a GlobalQ4HQuestion with embedded dialog context
      const globalQuestion = question as {
        dialogId?: string;
        rootId?: string;
        agentId?: string;
        taskDocPath?: string;
      };
      let dialogId: string | undefined;
      let rootId: string | undefined;
      let agentId: string | undefined;
      let taskDocPath: string | undefined;

      if (globalQuestion.dialogId) {
        // Global Q4H: use embedded dialog context
        dialogId = globalQuestion.dialogId;
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
    round: number,
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

    // Navigate to the specific round and scroll to call site
    // The actual scrolling will be handled by the dialog container
    const dialogContainer = this.shadowRoot?.querySelector(
      '#dialog-container',
    ) as DomindsDialogContainer | null;
    if (dialogContainer) {
      // Navigate to the round if needed
      if (typeof (dialogContainer as any).setCurrentRound === 'function') {
        (dialogContainer as any).setCurrentRound(round);
      }
      // Scroll to call site - dispatch event for dialog container to handle
      dialogContainer.dispatchEvent(
        new CustomEvent('scroll-to-call-site', {
          detail: { round, messageIndex },
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

  // ========== Resize Handle Methods ==========
  private boundDoResize = (e: MouseEvent | TouchEvent): void => {
    this.doResize(e);
  };

  private boundStopResize = (): void => {
    this.stopResize();
  };

  private startResize(e: MouseEvent | TouchEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.isResizing = true;

    const conversationArea = this.shadowRoot?.querySelector(
      '.conversation-scroll-area',
    ) as HTMLElement;
    const q4hInput = this.shadowRoot?.querySelector('#q4h-input') as HTMLElement;

    this.resizeStartY = e instanceof MouseEvent ? e.clientY : e.touches[0].clientY;
    this.resizeStartConversationHeight = conversationArea?.offsetHeight || 0;
    this.resizeStartQ4HHeight = q4hInput?.offsetHeight || 0;

    const resizeHandle = this.shadowRoot?.querySelector('#resize-handle');
    const appContainer = this.shadowRoot?.querySelector('.app-container');
    if (resizeHandle) {
      resizeHandle.classList.add('resizing');
    }
    if (appContainer) {
      appContainer.classList.add('resizing');
    }

    // Attach document-level listeners
    document.addEventListener('mousemove', this.boundDoResize);
    document.addEventListener('touchmove', this.boundDoResize, { passive: false });
    document.addEventListener('mouseup', this.boundStopResize);
    document.addEventListener('touchend', this.boundStopResize);
  }

  private doResize(e: MouseEvent | TouchEvent): void {
    if (!this.isResizing) return;
    e.preventDefault();
    e.stopPropagation();

    const currentY = e instanceof MouseEvent ? e.clientY : e.touches[0].clientY;
    const deltaY = currentY - this.resizeStartY;

    const conversationArea = this.shadowRoot?.querySelector(
      '.conversation-scroll-area',
    ) as HTMLElement;
    const q4hInput = this.shadowRoot?.querySelector('#q4h-input') as HTMLElement;

    // Calculate new heights
    let newConversationHeight = this.resizeStartConversationHeight + deltaY;
    let newQ4HHeight = this.resizeStartQ4HHeight - deltaY;

    // Constrain heights
    const minConversationHeight = 100;
    const minQ4HHeight = 130;
    const maxConversationHeight = 1200;
    const maxQ4HHeight = 1000;

    // Ensure we don't exceed limits while maintaining the relationship
    if (newQ4HHeight > maxQ4HHeight) {
      newQ4HHeight = maxQ4HHeight;
      newConversationHeight =
        this.resizeStartConversationHeight + (this.resizeStartQ4HHeight - maxQ4HHeight);
    } else if (newQ4HHeight < minQ4HHeight) {
      newQ4HHeight = minQ4HHeight;
      newConversationHeight =
        this.resizeStartConversationHeight + (this.resizeStartQ4HHeight - minQ4HHeight);
    }

    if (newConversationHeight < minConversationHeight) {
      newConversationHeight = minConversationHeight;
      newQ4HHeight =
        this.resizeStartQ4HHeight + (this.resizeStartConversationHeight - minConversationHeight);
    } else if (newConversationHeight > maxConversationHeight) {
      newConversationHeight = maxConversationHeight;
      newQ4HHeight =
        this.resizeStartQ4HHeight + (this.resizeStartConversationHeight - maxConversationHeight);
    }

    // Final clamping just in case
    newConversationHeight = Math.max(
      minConversationHeight,
      Math.min(maxConversationHeight, newConversationHeight),
    );
    newQ4HHeight = Math.max(minQ4HHeight, Math.min(maxQ4HHeight, newQ4HHeight));

    // Apply new heights using CSS variables or direct style
    if (conversationArea) {
      conversationArea.style.flex = 'none';
      conversationArea.style.height = `${newConversationHeight}px`;
    }
    if (q4hInput) {
      q4hInput.style.flex = 'none';
      q4hInput.style.height = `${newQ4HHeight}px`;
      q4hInput.style.maxHeight = `${newQ4HHeight}px`;
    }
  }

  private stopResize(): void {
    if (this.isResizing) {
      this.isResizing = false;

      // Remove document-level listeners
      document.removeEventListener('mousemove', this.boundDoResize);
      document.removeEventListener('touchmove', this.boundDoResize);
      document.removeEventListener('mouseup', this.boundStopResize);
      document.removeEventListener('touchend', this.boundStopResize);

      const resizeHandle = this.shadowRoot?.querySelector('#resize-handle');
      const appContainer = this.shadowRoot?.querySelector('.app-container');
      if (resizeHandle) {
        resizeHandle.classList.remove('resizing');
      }
      if (appContainer) {
        appContainer.classList.remove('resizing');
      }
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-app')) {
  customElements.define('dominds-app', DomindsApp);
}
