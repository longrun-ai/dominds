/**
 * Enhanced Dialog List Component for Dominds WebUI
 * Advanced dialog list with search, filtering, and improved UX
 */

import type { ApiRootDialogResponse, DialogInfo } from '../shared/types';

export interface DialogFilters {
  status?: 'active' | 'completed' | 'archived' | 'all';
  agentId?: string;
  dateRange?: { start: Date; end: Date };
  hasUnread?: boolean;
}

export interface DialogListProps {
  dialogs: ApiRootDialogResponse[];
  showSearch?: boolean;
  showFilters?: boolean;
  compact?: boolean;
  maxHeight?: string;
  onSelect?: (dialog: DialogInfo) => void;
  onSearch?: (query: string) => void;
  onFilterChange?: (filters: DialogFilters) => void;
}

// Discriminated union for tree nodes - ensures type safety via `type` discriminant
type DialogTreeNode =
  | {
      type: 'task';
      level: 1;
      taskDocPath: string;
      displayText: string;
      children?: DialogTreeNode[];
    }
  | {
      type: 'main-dialog';
      level: 2;
      dialog: ApiRootDialogResponse;
      displayText: string;
      children?: DialogTreeNode[];
    }
  | {
      type: 'subdialog';
      level: 3;
      dialog: ApiRootDialogResponse;
      displayText: string;
      children?: DialogTreeNode[];
    };

export class DomindsDialogList extends HTMLElement {
  private props: DialogListProps = {
    dialogs: [],
    showSearch: true,
    showFilters: false,
    compact: false,
    maxHeight: 'none', // Remove fixed height limit to allow full page adaptation
  };
  private filteredDialogs: ApiRootDialogResponse[] = [];
  private dialogTree: DialogTreeNode[] = [];
  private searchQuery = '';
  private filters: DialogFilters = {};
  private searchInput!: HTMLInputElement;
  private dialogListContainer!: HTMLElement;
  private filterContainer!: HTMLElement;
  private collapsedTasks: Set<string> = new Set(); // Track collapsed task groups
  private collapsedMainDialogs: Set<string> = new Set(); // Track collapsed main dialogs
  private collapsedSubdialogs: Set<string> = new Set(); // Track collapsed subdialogs (for future level-4)
  private knownMainDialogIds: Set<string> = new Set(); // Track seen root dialogs for default collapse
  private dialogNodeIndex: Map<string, HTMLElement> = new Map();
  private taskNodeIndex: Map<string, HTMLElement> = new Map();
  private teamConfiguration: any = null; // Team configuration from API
  private selectedRootId: string | null = null;
  private subdialogCountByRoot: Map<string, number> = new Map(); // Track subdialog counts per root dialog

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback(): Promise<void> {
    this.render();
    await this.loadTeamConfiguration();
    this.updateFilteredDialogs();
    this.setupSubdialogEventListener();
  }

  /**
   * Listen for subdialog-created events from dialog container
   */
  private setupSubdialogEventListener(): void {
    // Listen for subdialog-created events that bubble up from dialog container
    document.addEventListener('subdialog-created', ((e: CustomEvent) => {
      const { rootId } = e.detail;
      if (rootId) {
        const currentCount = this.subdialogCountByRoot.get(rootId) || 0;
        this.subdialogCountByRoot.set(rootId, currentCount + 1);
        this.updateSubdialogDisplay(rootId);
      }
    }) as EventListener);
  }

  /**
   * Update the subdialog count display for a specific dialog
   */
  private updateSubdialogDisplay(rootId: string): void {
    const count = this.subdialogCountByRoot.get(rootId) || 0;
    const el = this.dialogNodeIndex.get(`main:${rootId}`);
    if (el) {
      const countEl = el.querySelector('.dialog-count');
      if (countEl) {
        countEl.textContent = `${count} subdialog${count !== 1 ? 's' : ''}`;
      }
      // Update toggle icon if there are subdialogs
      const toggleEl = el.querySelector('.dialog-toggle');
      if (toggleEl) {
        if (count > 0) {
          const isCollapsed = this.collapsedMainDialogs.has(rootId);
          toggleEl.textContent = isCollapsed ? '▶' : '▼';
        } else {
          toggleEl.textContent = '•';
        }
      }
    }
  }

  disconnectedCallback(): void {
    // Clean up event listeners
  }

  /**
   * Update the dialogs list
   * Supports both root dialogs list and hierarchy API response format
   */
  public setDialogs(dialogs: ApiRootDialogResponse[]): void {
    // Handle hierarchy API response format: { rootDialog, subdialogs: [...] }
    // or flat array of dialogs with selfId/supdialogId fields
    const flatDialogs: ApiRootDialogResponse[] = [];

    for (const d of dialogs) {
      if (!d || !d.rootId) continue;

      // Check if this is a hierarchy response object (has rootDialog and subdialogs)
      // Use type assertion since ApiRootDialogResponse doesn't include these properties
      const hierarchyItem = d as {
        rootDialog?: ApiRootDialogResponse;
        subdialogs?: ApiRootDialogResponse[];
      };
      if (hierarchyItem.rootDialog && Array.isArray(hierarchyItem.subdialogs)) {
        // This is a hierarchy API response - add root dialog and all subdialogs
        flatDialogs.push(hierarchyItem.rootDialog);
        for (const sub of hierarchyItem.subdialogs) {
          if (sub && sub.rootId) {
            // Validate supdialogId for subdialogs
            if (!sub.supdialogId) {
              console.warn(
                `Subdialog ${sub.rootId}:${sub.selfId ?? 'unknown'} has no supdialogId - may not group correctly`,
              );
            }
            flatDialogs.push(sub);
          }
        }
      } else {
        // Regular dialog object - add directly
        flatDialogs.push(d);
      }
    }

    // Deduplicate by unique key: rootId + selfId (for subdialogs)
    // Subdialogs share rootId with parent but have unique selfId
    const byKey = new Map<string, ApiRootDialogResponse>();
    for (const d of flatDialogs) {
      if (!d || !d.rootId) continue;
      const uniqueKey = d.selfId ? `${d.rootId}:${d.selfId}` : d.rootId;
      if (!byKey.has(uniqueKey)) {
        byKey.set(uniqueKey, d);
      }
    }
    this.props.dialogs = Array.from(byKey.values());
    this.updateFilteredDialogs();
  }

  /**
   * Get the 3-level tree structure of dialogs with subdialogs grouped under parents
   */
  private getDialogTreeStructure(dialogs: ApiRootDialogResponse[]): DialogTreeNode[] {
    // Separate root dialogs from subdialogs
    const rootDialogs: ApiRootDialogResponse[] = [];
    const subdialogs: ApiRootDialogResponse[] = [];

    dialogs.forEach((dialog) => {
      // Validate taskDocPath is present and non-empty - fail loudly on invalid data
      if (!dialog.taskDocPath || dialog.taskDocPath.trim() === '') {
        throw new Error(
          `❌ CRITICAL ERROR: Dialog ${dialog.rootId} has invalid task document path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Task document is mandatory for all dialogs.`,
        );
      }

      // Identify subdialogs by selfId field (non-null means it's a subdialog)
      if (dialog.selfId && dialog.rootId) {
        // This is a subdialog - it has selfId different from rootId
        subdialogs.push(dialog);
      } else {
        // This is a root dialog
        rootDialogs.push(dialog);
      }
    });

    // Group dialogs by taskDocPath (taskDocPath is now mandatory)
    const taskGroups = new Map<
      string,
      { rootDialogs: ApiRootDialogResponse[]; subdialogs: ApiRootDialogResponse[] }
    >();

    // Process root dialogs
    rootDialogs.forEach((dialog) => {
      const taskKey = dialog.taskDocPath.trim();
      if (!taskGroups.has(taskKey)) {
        taskGroups.set(taskKey, { rootDialogs: [], subdialogs: [] });
      }
      taskGroups.get(taskKey)!.rootDialogs.push(dialog);
    });

    // Assign subdialogs to their parent root dialogs via supdialogId
    subdialogs.forEach((subdialog) => {
      const parentId = subdialog.supdialogId;
      if (!parentId) {
        // Warning for subdialogs without parent reference
        console.warn(
          `⚠️ Subdialog ${subdialog.rootId}:${subdialog.selfId ?? 'unknown'} has no supdialogId - will not be grouped under parent`,
        );
        return;
      }

      // Find which task group the parent belongs to
      let foundParent = false;
      for (const [taskKey, group] of taskGroups) {
        const parent = group.rootDialogs.find((rd) => rd.rootId === parentId);
        if (parent) {
          group.subdialogs.push(subdialog);
          foundParent = true;
          break;
        }
      }

      if (!foundParent) {
        console.warn(
          `⚠️ Subdialog ${subdialog.rootId}:${subdialog.selfId ?? 'unknown'} has supdialogId ${parentId} but parent not found - may not group correctly`,
        );
      }
    });

    // Build tree structure
    const tree: DialogTreeNode[] = [];

    taskGroups.forEach((group, taskPath) => {
      // Level 1: Task Document Group
      const taskNode: DialogTreeNode = {
        type: 'task',
        level: 1,
        taskDocPath: taskPath,
        displayText: taskPath,
        children: [],
      };

      // Level 2: Main dialogs
      const mainDialogs = [...group.rootDialogs].sort((a, b) => {
        const sa = String(a.lastModified || '');
        const sb = String(b.lastModified || '');
        const cmp = sb.localeCompare(sa);
        if (cmp !== 0) return cmp;
        return String(b.rootId).localeCompare(String(a.rootId));
      });

      mainDialogs.forEach((mainDialog) => {
        // Get subdialogs for this main dialog
        const dialogSubdialogs = group.subdialogs.filter(
          (sd) => sd.supdialogId === mainDialog.rootId,
        );

        // Level 3: Subdialogs for this main dialog
        const subdialogNodes: DialogTreeNode[] = dialogSubdialogs
          .sort((a, b) => {
            const sa = String(a.lastModified || '');
            const sb = String(b.lastModified || '');
            return sb.localeCompare(sa);
          })
          .map((subdialog) => ({
            type: 'subdialog',
            level: 3,
            dialog: subdialog,
            displayText: this.formatDisplayText(
              subdialog.agentId,
              subdialog.selfId || subdialog.rootId,
              subdialog.lastModified,
            ),
            children: undefined,
          }));

        const mainNode: DialogTreeNode = {
          type: 'main-dialog',
          level: 2,
          dialog: mainDialog,
          displayText: this.formatDisplayText(
            mainDialog.agentId,
            mainDialog.rootId,
            mainDialog.lastModified,
          ),
          children: subdialogNodes.length > 0 ? subdialogNodes : undefined,
        };

        taskNode.children!.push(mainNode);
      });

      tree.push(taskNode);
    });

    return tree;
  }

  /**
   * Set the current active dialog
   */
  public setCurrentDialog(dialog: DialogInfo): void {
    this.selectedRootId = dialog.rootId;
    this.updateActiveStates();
  }

  public expandMainDialog(rootId: string, emitEvent: boolean = true): void {
    if (!rootId) return;
    if (!this.collapsedMainDialogs.has(rootId)) return;

    this.collapsedMainDialogs.delete(rootId);
    if (emitEvent) {
      this.dispatchEvent(
        new CustomEvent('dialog-expand', {
          detail: { rootId },
          bubbles: true,
          composed: true,
        }),
      );
    }
    this.render();
  }

  /**
   * Set component properties
   */
  public setProps(props: Partial<DialogListProps>): void {
    this.props = { ...this.props, ...props };
    this.render();
    // Only update filtered dialogs if dialogs were provided in props
    if (props.dialogs) {
      this.updateFilteredDialogs();
    }
  }

  /**
   * Get current search query
   */
  public getSearchQuery(): string {
    return this.searchQuery;
  }

  /**
   * Get current filters
   */
  public getFilters(): DialogFilters {
    return { ...this.filters };
  }

  /**
   * Select a dialog by its root ID programmatically (for E2E testing)
   * @param rootId - The root ID of the dialog to select
   * @returns boolean - True if dialog was found and selected
   */
  public selectDialogById(rootId: string): boolean {
    const dialog = this.findDialogByRootId(rootId);
    if (!dialog) return false;

    const dialogInfo: DialogInfo = {
      rootId: dialog.rootId,
      selfId: dialog.selfId || dialog.rootId,
      agentId: dialog.agentId,
      agentName: '',
      taskDocPath: dialog.taskDocPath || '',
      supdialogId: dialog.supdialogId,
      topicId: dialog.topicId,
    };
    this.setCurrentDialog(dialogInfo);
    return true;
  }

  /**
   * Get all dialogs as a flat array (for E2E testing)
   * @returns Array of all dialogs
   */
  public getAllDialogs(): ApiRootDialogResponse[] {
    return this.props.dialogs;
  }

  /**
   * Find a dialog by its root ID (for E2E testing)
   * @param rootId - The root ID to search for
   * @returns The dialog or undefined if not found
   */
  public findDialogByRootId(rootId: string): ApiRootDialogResponse | undefined {
    return this.props.dialogs.find((d) => d.rootId === rootId);
  }

  /**
   * Find a subdialog by root and self ID (for E2E testing)
   * @param rootId - The root (parent) dialog ID
   * @param selfId - The subdialog's self ID
   * @returns The subdialog or undefined if not found
   */
  public findSubdialog(rootId: string, selfId: string): ApiRootDialogResponse | undefined {
    return this.props.dialogs.find((d) => d.rootId === rootId && d.selfId === selfId);
  }

  /**
   * Get the currently selected dialog's root ID (for E2E testing)
   * @returns The selected root ID or null if none selected
   */
  public getSelectedDialogId(): string | null {
    return this.selectedRootId;
  }

  public render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    // Get references
    this.searchInput = this.shadowRoot.querySelector('.search-input')!;
    this.dialogListContainer = this.shadowRoot.querySelector('.dialog-list')!;
    this.filterContainer = this.shadowRoot.querySelector('.filter-container')!;

    this.setupEventListeners();
    this.rebuildDialogNodeIndex();
  }

  private rebuildDialogNodeIndex(): void {
    this.dialogNodeIndex.clear();
    this.taskNodeIndex.clear();
    if (!this.dialogListContainer) return;

    const taskNodes = this.dialogListContainer.querySelectorAll('.task-group-item');
    taskNodes.forEach((node) => {
      const taskPath = node.getAttribute('data-task-path');
      if (taskPath) this.taskNodeIndex.set(taskPath, node as HTMLElement);
    });

    const dialogNodes = this.dialogListContainer.querySelectorAll('.dialog-item');
    dialogNodes.forEach((node) => {
      const rootId = node.getAttribute('data-root-id');
      if (!rootId) return;
      const level = node.getAttribute('data-level');
      if (level === '2') {
        this.dialogNodeIndex.set(`main:${rootId}`, node as HTMLElement);
        return;
      }
      if (level === '3') {
        const selfId = node.getAttribute('data-self-id');
        const subKey = selfId ? `sub:${rootId}:${selfId}` : `sub:${rootId}:${rootId}`;
        this.dialogNodeIndex.set(subKey, node as HTMLElement);
      }
    });
  }

  public getStyles(): string {
    return `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        background: var(--dominds-sidebar-bg, #1a1a1a);
        color: var(--color-fg-primary);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .dialog-list {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        /* Ensure the main content area takes remaining space */
        min-height: 0;
      }

      .search-section {
        padding: var(--space-md);
        border-bottom: 1px solid var(--color-border-primary);
        background: var(--color-bg-primary);
      }

      .search-container {
        position: relative;
        margin-bottom: var(--space-sm);
      }

      .search-input {
        width: 100%;
        padding: var(--space-sm) var(--space-md) var(--space-sm) var(--space-sm);
        border: 1px solid var(--color-border-primary);
        border-radius: var(--radius-md);
        font-size: var(--font-size-sm);
        background: var(--color-bg-primary);
        color: var(--color-fg-primary);
        outline: none;
        transition: all var(--transition-fast);
      }

      .search-input:focus {
        border-color: var(--color-accent-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 20%, transparent);
      }

      .search-input::placeholder {
        color: var(--color-fg-tertiary);
      }

      .search-icon {
        position: absolute;
        right: var(--space-sm);
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-fg-tertiary);
        font-size: var(--font-size-sm);
        pointer-events: none;
      }

      .search-clear {
        position: absolute;
        right: calc(var(--space-sm) + 16px);
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        color: var(--color-fg-tertiary);
        cursor: pointer;
        font-size: var(--font-size-xs);
        padding: 2px;
        border-radius: var(--radius-sm);
        display: none;
      }

      .search-clear:hover {
        background: var(--color-bg-tertiary);
        color: var(--color-fg-secondary);
      }

      .search-input:not(:placeholder-shown) ~ .search-clear {
        display: block;
      }

      .filter-container {
        display: flex;
        gap: var(--space-xs);
        flex-wrap: wrap;
      }

      .filter-button {
        padding: var(--space-xs) var(--space-sm);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: var(--radius-sm);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-muted, #666666);
        font-size: var(--font-size-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
        font-weight: 500;
        text-transform: none;
        letter-spacing: 0.05em;
      }

      .filter-button:hover {
        background: var(--dominds-hover, #f0f0f0);
        color: var(--dominds-fg, #333333);
      }

      .filter-button.active {
        background: var(--dominds-primary, #007acc);
        color: #fff;
        border-color: var(--dominds-primary, #007acc);
      }

      .dialog-list {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-xs) 0;
        max-height: ${this.props.maxHeight};
        /* Ensure full height adaptation to parent container */
        height: auto;
        min-height: 0;
      }

      /* Tree Structure Styles */
      .task-group-item {
        padding: var(--space-sm) var(--space-md);
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-header-bg, #f8f9fa);
        font-weight: 600;
        color: var(--dominds-fg, #333333);
        font-size: var(--font-size-sm);
      }

      .task-group-header {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
        cursor: pointer;
        transition: background-color var(--transition-fast);
        border-radius: var(--radius-sm);
        padding: var(--space-xs);
        margin: calc(var(--space-xs) * -1);
      }

      .task-group-header:hover {
        background: var(--dominds-hover, rgba(0, 122, 204, 0.05));
      }

      .task-group-toggle {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: var(--dominds-muted, #666666);
        user-select: none;
        flex-shrink: 0;
      }

      .task-group-icon {
        font-size: var(--font-size-sm);
        opacity: 0.8;
        flex-shrink: 0;
      }

      .task-group-text {
        flex: 1;
        font-size: var(--font-size-sm);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 600;
      }

      .task-group-count {
        font-size: var(--font-size-xs);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-muted, #666666);
        padding: var(--space-xs) var(--space-sm);
        border-radius: var(--radius-sm);
        font-weight: 500;
        border: 1px solid var(--dominds-border, #e0e0e0);
        flex-shrink: 0;
      }

      .dialog-item {
        padding: var(--space-md);
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        cursor: pointer;
        transition: all var(--transition-fast);
        position: relative;
        background: var(--dominds-bg, #ffffff);
      }

      .main-dialog-item {
        margin-left: 0;
        background: var(--dominds-bg, #ffffff);
      }

      .subdialog-item {
        margin-left: 24px;
        padding: 8px 10px;
        border-left: 2px solid var(--dominds-border, #e0e0e0);
      }

      .subdialog-item .dialog-title {
        font-size: 11px;
        font-weight: 500;
      }

      .subdialog-item .dialog-meta {
        font-size: var(--font-size-xs);
      }

      .subdialog-item .dialog-preview {
        font-size: var(--font-size-xs);
      }

      .dialog-item:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      .dialog-item.active {
        background: var(--dominds-primary-bg, rgba(0, 122, 204, 0.1));
        border-left: 3px solid var(--dominds-primary, #007acc);
      }

      .main-dialog-item.active {
        border-left: 3px solid var(--dominds-primary, #007acc);
      }

      .subdialog-item.active {
        border-left: 3px solid var(--dominds-success, #28a745);
        background: var(--dominds-success-bg, rgba(40, 167, 69, 0.1));
      }

      .dialog-item.compact {
        padding: var(--space-sm) var(--space-md);
      }

      .dialog-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: var(--space-sm);
        gap: var(--space-sm);
      }

      .main-dialog-item .dialog-header {
        cursor: pointer;
        transition: background-color var(--transition-fast);
        border-radius: var(--radius-sm);
        padding: var(--space-xs);
        margin: calc(var(--space-xs) * -1);
      }

      .main-dialog-item .dialog-header:hover {
        background: var(--dominds-hover, rgba(0, 122, 204, 0.05));
      }

      .dialog-toggle {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: var(--dominds-muted, #666666);
        user-select: none;
        flex-shrink: 0;
        margin-right: var(--space-xs);
      }

      .dialog-title {
        font-weight: 500;
        font-size: 13px; /* 明确设置，解决继承问题 */
        color: var(--dominds-fg, #333333);
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .dialog-status {
        padding: var(--space-xs) var(--space-sm);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        font-weight: 500;
        text-transform: capitalize;
        flex-shrink: 0;
        margin-left: var(--space-sm);
      }

      .status-active {
        background: var(--dominds-success-bg, #d4edda);
        color: var(--dominds-success, #155724);
      }

      .status-completed {
        background: var(--dominds-secondary-bg, #e2e3e5);
        color: var(--dominds-secondary, #383d41);
      }

      .status-archived {
        background: var(--dominds-warning-bg, #fff3cd);
        color: var(--dominds-warning, #856404);
      }

      .dialog-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--dominds-muted, #666666);
        gap: var(--space-sm);
      }

      .dialog-agent {
        font-weight: 500;
        color: var(--dominds-primary, #007acc);
      }

      .dialog-timestamp {
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: var(--font-size-xs);
        color: var(--dominds-muted, #666666);
      }

      .dialog-preview {
        margin-top: var(--space-sm);
        font-size: var(--font-size-sm);
        color: var(--dominds-muted, #666666);
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .subdialog-badge {
        background: var(--dominds-info-bg, #e3f2fd);
        color: var(--dominds-info, #1976d2);
        padding: 1px 4px;
        border-radius: 8px;
        font-size: 9px;
        font-weight: 500;
        text-transform: none;
        letter-spacing: 0.5px;
      }

      .dialog-count {
        font-size: 10px;
        color: var(--dominds-muted, #666666);
        font-style: italic;
      }

      .unread-indicator {
        position: absolute;
        top: var(--space-sm);
        right: var(--space-sm);
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-error);
        box-shadow: 0 0 0 2px var(--color-bg-secondary);
      }

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 120px;
        color: var(--dominds-muted, #666666);
        text-align: center;
        padding: var(--space-xl);
        background: var(--dominds-bg, #ffffff);
      }

      .empty-content {
        font-size: var(--font-size-sm);
        line-height: 1.4;
        color: var(--dominds-fg, #333333);
      }

      .empty-icon {
        font-size: var(--font-size-2xl);
        margin-bottom: var(--space-sm);
        opacity: 0.6;
        color: var(--dominds-muted, #666666);
      }

      .search-results {
        font-size: var(--font-size-xs);
        color: var(--color-fg-tertiary);
        padding: var(--space-xs) var(--space-md);
        border-bottom: 1px solid var(--color-border-primary);
        background: var(--color-bg-primary);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      /* Custom scrollbar */
      .dialog-list::-webkit-scrollbar {
        width: 4px;
      }

      .dialog-list::-webkit-scrollbar-track {
        background: transparent;
      }

      .dialog-list::-webkit-scrollbar-thumb {
        background: var(--dominds-scrollbar-thumb, #c1c1c1);
        border-radius: 2px;
      }

      .dialog-list::-webkit-scrollbar-thumb:hover {
        background: var(--dominds-scrollbar-thumb-hover, #a8a8a8);
      }

      /* Responsive design */
      @media (max-width: 768px) {
        .search-section {
          padding: 8px;
        }

        .task-group-item {
          padding: 6px 12px;
        }

        .task-group-toggle {
          width: 14px;
          height: 14px;
          font-size: 9px;
        }

        .task-group-text {
          font-size: 12px;
        }

        .task-group-count {
          font-size: 10px;
        }

        .dialog-item {
          padding: 10px 12px;
        }

        .main-dialog-item .dialog-header {
          padding: 4px;
          margin: 2px -4px;
        }

        .dialog-toggle {
          width: 14px;
          height: 14px;
          font-size: 9px;
        }

        .subdialog-item {
          margin-left: 12px;
          padding: 8px 10px;
        }

        .subdialog-item .dialog-title {
          font-size: 11px;
          font-weight: 500;
        }

        .dialog-meta {
          font-size: 11px;
        }

        .subdialog-item .dialog-meta {
          font-size: 9px;
        }

        .dialog-preview {
          font-size: 11px;
        }

        .subdialog-item .dialog-preview {
          font-size: 10px;
        }
      }

      /* Animation */
      .task-group-item {
        animation: slideInList var(--transition-normal);
      }

      .dialog-item {
        animation: slideInList var(--transition-normal);
      }

      @keyframes slideInList {
        from {
          opacity: 0;
          transform: translateX(-8px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      /* Additional status styles for badges */
      .subdialog-badge {
        background: var(--dominds-info-bg, #374151);
        color: var(--dominds-info, #9ca3af);
        padding: 2px var(--space-xs);
        border-radius: var(--radius-sm);
        font-size: var(--font-size-xs);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border: 1px solid var(--dominds-info, #9ca3af);
      }

      .dialog-count {
        font-size: var(--font-size-xs);
        color: var(--dominds-muted, #9ca3af);
        font-style: italic;
      }

      /* Custom scrollbar */
      .dialog-list::-webkit-scrollbar {
        width: 6px;
      }

      .dialog-list::-webkit-scrollbar-track {
        background: transparent;
      }

      .dialog-list::-webkit-scrollbar-thumb {
        background: var(--color-border-secondary);
        border-radius: var(--radius-sm);
      }

      .dialog-list::-webkit-scrollbar-thumb:hover {
        background: var(--color-fg-tertiary);
      }

      /* Empty state styling */
      .empty-subtext {
        font-size: var(--font-size-xs);
        color: var(--color-fg-tertiary);
        margin-top: var(--space-xs);
        opacity: 0.8;
      }

      .search-results {
        font-size: var(--font-size-xs);
        color: var(--dominds-muted, #9ca3af);
        padding: var(--space-xs) var(--space-md);
        border-bottom: 1px solid var(--dominds-border, #404040);
        background: var(--dominds-bg, #2d2d2d);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      /* Dark theme alignment with main app gray color scheme */
      [data-theme="dark"] {
        --dominds-bg: #2d2d2d;
        --dominds-sidebar-bg: #1a1a1a;
        --dominds-header-bg: #1a1a1a;
        --dominds-fg: #f8fafc;
        --dominds-border: #404040;
        --dominds-hover: #3a3a3a;
        --dominds-muted: #9ca3af;
        --dominds-primary: #60a5fa;
        --dominds-primary-hover: #3b82f6;
        --dominds-success: #34d399;
        --dominds-success-bg: #064e3b;
        --dominds-warning: #fbbf24;
        --dominds-warning-bg: #78350f;
        --dominds-danger: #f87171;
        --dominds-danger-bg: #7f1d1d;
        --dominds-info: #9ca3af;
        --dominds-info-bg: #374151;
      }

      [data-theme="dark"] .search-input {
        background: var(--dominds-bg, #2d2d2d);
        border-color: var(--dominds-border, #404040);
        color: var(--dominds-fg, #f8fafc);
      }

      [data-theme="dark"] .task-group-item {
        background: var(--dominds-header-bg, #1a1a1a);
        border-bottom-color: var(--dominds-border, #404040);
      }

      [data-theme="dark"] .task-group-header:hover {
        background: var(--dominds-hover, rgba(96, 165, 250, 0.1));
      }

      [data-theme="dark"] .task-group-toggle {
        color: var(--dominds-muted, #9ca3af);
      }

      [data-theme="dark"] .task-group-count {
        background: var(--dominds-bg, #2d2d2d);
        color: var(--dominds-muted, #9ca3af);
        border-color: var(--dominds-border, #404040);
      }

      [data-theme="dark"] .main-dialog-item .dialog-header:hover {
        background: var(--dominds-hover, rgba(96, 165, 250, 0.1));
      }

      [data-theme="dark"] .dialog-toggle {
        color: var(--dominds-muted, #9ca3af);
      }

      [data-theme="dark"] .subdialog-item {
        background: var(--dominds-bg, #2d2d2d);
        border-left-color: var(--dominds-border, #404040);
      }

      [data-theme="dark"] .dialog-item {
        border-bottom-color: var(--dominds-border, #404040);
        background: var(--dominds-bg, #2d2d2d);
      }

      [data-theme="dark"] .dialog-item:hover {
        background: var(--dominds-hover, #3a3a3a);
      }

      [data-theme="dark"] .dialog-item.active {
        background: rgba(96, 165, 250, 0.1);
        border-left: 3px solid var(--dominds-primary, #60a5fa);
      }

      [data-theme="dark"] .subdialog-item.active {
        background: rgba(52, 211, 153, 0.1);
        border-left: 3px solid var(--dominds-success, #34d399);
      }

      [data-theme="dark"] .empty-state {
        background: var(--dominds-bg, #2d2d2d);
      }

      [data-theme="dark"] .empty-content {
        color: var(--dominds-fg, #f8fafc);
      }

      [data-theme="dark"] .empty-icon {
        color: var(--dominds-muted, #9ca3af);
      }

      [data-theme="dark"] .search-clear:hover {
        background: var(--dominds-hover, #3a3a3a);
        color: var(--dominds-fg, #f8fafc);
      }
    `;
  }

  public getHTML(): string {
    return `
      <div class="dialog-list">
        ${this.renderSearchSection()}
        <div class="dialog-list" id="dialog-list">
          ${this.renderDialogs()}
        </div>
      </div>
    `;
  }

  private renderSearchSection(): string {
    if (!this.props.showSearch) return '';

    return `
      <div class="search-section">
        <div class="search-container">
          <input 
            type="text" 
            class="search-input" 
            placeholder="Search dialogs..."
            value="${this.searchQuery}"
          />
          <span class="search-icon">🔍</span>
          <button class="search-clear" type="button">✕</button>
        </div>
        ${this.renderFilters()}
      </div>
    `;
  }

  private renderFilters(): string {
    if (!this.props.showFilters) return '';

    const activeFilter = this.filters.status || 'all';

    return `
      <div class="filter-container">
        <button class="filter-button ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">
          All
        </button>
        <button class="filter-button ${activeFilter === 'active' ? 'active' : ''}" data-filter="active">
          Active
        </button>
        <button class="filter-button ${activeFilter === 'completed' ? 'active' : ''}" data-filter="completed">
          Done
        </button>
      </div>
    `;
  }

  private renderDialogs(): string {
    if (this.dialogTree.length === 0) {
      const icon = this.searchQuery ? '🔍' : '💬';
      const message = this.searchQuery ? 'No dialogs match your search' : 'No dialogs yet';
      const subtext = this.searchQuery
        ? 'Try adjusting your search terms'
        : 'Create a new dialog to get started';

      return `
        <div class="empty-state">
          <div class="empty-content">
            <div class="empty-icon">${icon}</div>
            <div>${message}</div>
            <div class="empty-subtext">${subtext}</div>
          </div>
        </div>
      `;
    }

    if (this.searchQuery) {
      const count = this.filteredDialogs.length;
      const message = count === 1 ? '1 result' : `${count} results`;
      return `
        <div class="search-results">${message}</div>
        ${this.renderDialogTree(this.dialogTree).join('')}
      `;
    }

    return this.renderDialogTree(this.dialogTree).join('');
  }

  private renderDialogTree(nodes: DialogTreeNode[]): string[] {
    const result: string[] = [];

    nodes.forEach((node) => {
      // For main-dialog nodes, check if collapsed before rendering children
      if (node.type === 'main-dialog' && node.dialog) {
        const isCollapsed = this.collapsedMainDialogs.has(node.dialog.rootId);
        result.push(this.renderTreeNode(node));
        // Only render children (subdialogs) if not collapsed
        if (!isCollapsed && node.children && node.children.length > 0) {
          result.push(...this.renderDialogTree(node.children));
        }
      } else {
        result.push(this.renderTreeNode(node));
        // Recursively render children for other node types (task groups)
        if (node.children && node.children.length > 0 && node.type !== 'main-dialog') {
          result.push(...this.renderDialogTree(node.children));
        }
      }
    });

    return result;
  }

  private renderTreeNode(node: DialogTreeNode): string {
    if (node.type === 'task') {
      // Level 1: Task Document (Collapsible) - taskDocPath is guaranteed by discriminated union
      const isCollapsed = this.collapsedTasks.has(node.taskDocPath);
      const toggleIcon = isCollapsed ? '▶' : '▼';
      const hasSubdialogs = this.hasSubdialogsInTask(node.taskDocPath);

      return `
        <div class="task-group-item" data-task-path="${node.taskDocPath}">
          <div class="task-group-header" data-type="task-toggle" data-task-path="${node.taskDocPath}">
            <div class="task-group-toggle">${toggleIcon}</div>
            <div class="task-group-icon">${isCollapsed ? '📁' : '📂'}</div>
            <div class="task-group-text">${node.displayText}</div>
            <div class="task-group-count">${this.getTaskDocumentCount(node.taskDocPath)}</div>
          </div>
        </div>
      `;
    }

    // For dialog types, dialog property is guaranteed by discriminated union
    const dialog = node.dialog;

    if (node.type === 'main-dialog') {
      // Level 2: Main Dialog (Collapsible)
      const isCollapsed = this.collapsedMainDialogs.has(dialog.rootId);
      const toggleIcon = isCollapsed ? '▶' : '▼';
      // Use subdialogCount from API response if available, otherwise check tree structure
      const apiSubdialogCount = dialog.subdialogCount ?? 0;
      const hasSubdialogChildren =
        node.children && node.children.some((c) => c.type === 'subdialog');
      const hasSubdialogs = apiSubdialogCount > 0 || hasSubdialogChildren;
      const subdialogCount =
        apiSubdialogCount > 0 ? apiSubdialogCount : this.getSubdialogCount(dialog.rootId);
      const isActive = false; // Active state handled by DOM selection
      const statusClass = `status-${dialog.status}`;
      const compactClass = this.props.compact ? 'compact' : '';

      // Only show main dialogs if parent task is not collapsed
      const isTaskCollapsed = this.collapsedTasks.has(dialog.taskDocPath);
      if (isTaskCollapsed) {
        return '';
      }

      return `
        <div class="dialog-item main-dialog-item ${compactClass} ${isActive ? 'active' : ''}"
             data-dialog-id="${dialog.rootId}"
             data-root-id="${dialog.rootId}"
             data-teammate-id="${dialog.agentId}"
             data-teammate-name="${this.getAgentDisplayName(dialog.agentId)}"
             data-task-doc-path="${dialog.taskDocPath}"
             data-level="2">
          <div class="dialog-header" data-type="main-dialog-toggle" data-dialog-id="${dialog.rootId}">
            <div class="dialog-toggle">${hasSubdialogs ? toggleIcon : '•'}</div>
            <div class="dialog-title">${this.formatTitleText(dialog.agentId, dialog.rootId)}</div>
            <div class="dialog-status ${statusClass}">${dialog.status}</div>
          </div>
          <div class="dialog-meta">
            <span class="dialog-timestamp">${dialog.lastModified || ''}</span>
            ${hasSubdialogs ? `<span class="dialog-count">${subdialogCount} subdialog${subdialogCount !== 1 ? 's' : ''}</span>` : ''}
          </div>

        </div>
      `;
    }

    // node.type === 'subdialog'
    // Level 3: Subdialog (Always visible, not collapsible)
    const isActive = false; // Active state handled by DOM selection
    const statusClass = `status-${dialog.status}`;
    const compactClass = this.props.compact ? 'compact' : '';
    const topicBadge =
      dialog.topicId && dialog.topicId.trim() !== '' ? dialog.topicId : 'Subdialog';

    // Only show subdialogs if parent task is not collapsed
    const isTaskCollapsed = this.collapsedTasks.has(dialog.taskDocPath);
    if (isTaskCollapsed) {
      return '';
    }

    return `
      <div class="dialog-item subdialog-item ${compactClass} ${isActive ? 'active' : ''}"
           data-dialog-id="${dialog.selfId || dialog.rootId}"
           data-root-id="${dialog.rootId}"
           data-self-id="${dialog.selfId || ''}"
           data-supdialog-id="${dialog.supdialogId || ''}"
           data-teammate-id="${dialog.agentId}"
           data-teammate-name="${this.getAgentDisplayName(dialog.agentId)}"
           data-task-doc-path="${dialog.taskDocPath}"
           data-topic-id="${dialog.topicId || ''}"
           data-level="3">
        <div class="dialog-header">
          <div class="dialog-title">${this.formatTitleText(dialog.agentId, dialog.selfId || dialog.rootId)}</div>
          <div class="dialog-status ${statusClass}">${dialog.status}</div>
        </div>
        <div class="dialog-meta">
          <span class="dialog-timestamp">${dialog.lastModified || ''}</span>
          <span class="subdialog-badge">${topicBadge}</span>
        </div>

      </div>
    `;
  }

  private getTaskDocumentCount(taskDocPath: string): number {
    return this.filteredDialogs.filter((dialog) => {
      // Validate taskDocPath is present and non-empty - fail loudly on invalid data
      if (!dialog.taskDocPath || dialog.taskDocPath.trim() === '') {
        throw new Error(
          `❌ CRITICAL ERROR: Dialog ${dialog.rootId} has invalid task document path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Task document is mandatory for all dialogs.`,
        );
      }

      const dialogTaskKey = dialog.taskDocPath.trim();
      // Count only root dialogs for this task
      return dialogTaskKey === taskDocPath;
    }).length;
  }

  private getSubdialogCount(rootId: string): number {
    // First check if we have subdialogs in the tree structure
    for (const taskNode of this.dialogTree) {
      if (taskNode.children) {
        for (const mainNode of taskNode.children) {
          if (mainNode.type === 'main-dialog' && mainNode.dialog?.rootId === rootId) {
            if (mainNode.children) {
              return mainNode.children.filter((c) => c.type === 'subdialog').length;
            }
          }
        }
      }
    }
    // Fallback to tracked count from subdialog-created events
    return this.subdialogCountByRoot.get(rootId) || 0;
  }

  private async loadTeamConfiguration(): Promise<void> {
    try {
      const response = await fetch('/api/team/config');
      if (!response.ok) {
        throw new Error(`Failed to load team config: ${response.statusText}`);
      }

      const data = await response.json();
      this.teamConfiguration = data.configuration;
    } catch (error) {
      console.warn('⚠️ Failed to load team configuration, using defaults:', error);
      // Fallback to basic configuration if API fails
      this.teamConfiguration = {
        memberDefaults: { icon: '🤖' },
        members: {},
      };
    }
  }

  private getAgentDisplayName(agentId: string): string {
    // Use team configuration if available
    if (this.teamConfiguration?.members?.[agentId]) {
      const member = this.teamConfiguration.members[agentId];
      const icon = member.icon || this.teamConfiguration.memberDefaults?.icon || '🤖';
      const name = member.name || agentId;
      return `${icon} ${name}`;
    }

    // Fallback to member defaults if specific member not found
    if (this.teamConfiguration?.memberDefaults) {
      const icon = this.teamConfiguration.memberDefaults.icon || '🤖';
      return `${icon} ${agentId.charAt(0).toUpperCase() + agentId.slice(1)}`;
    }

    // Ultimate fallback
    return `🤖 ${agentId.charAt(0).toUpperCase() + agentId.slice(1)}`;
  }

  private buildDialogDisplayTitle(dialog: DialogInfo, dialogId: string): string {
    // Build display title - all fields are guaranteed to be present
    return `${dialog.agentName} (${dialogId})`;
  }

  /**
   * Format title text for dialog item: @agentId • fullDialogId (time shown in meta row below)
   */
  private formatTitleText(agentId: string, dialogId: string): string {
    return `@${agentId} • ${dialogId}`;
  }

  /**
   * Format display text for dialog item: @agentId • truncatedRootId • relativeTime
   */
  private formatDisplayText(agentId: string, rootId: string, lastModified?: string): string {
    const truncatedRootId =
      rootId.length > 12 ? `${rootId.substring(0, 6)}...${rootId.slice(-4)}` : rootId;
    const relativeTime = this.formatRelativeTime(lastModified);
    return `@${agentId} • ${truncatedRootId} • ${relativeTime}`;
  }

  /**
   * Format timestamp as relative time (e.g., "2h ago", "Yesterday", "Dec 20")
   */
  private formatRelativeTime(timestamp?: string): string {
    if (!timestamp) return 'unknown';

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'unknown';

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    // For older dates, use format: "Dec 20"
    const month = date.toLocaleString('en-US', { month: 'short' });
    const day = date.getDate();
    return `${month} ${day}`;
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) {
      console.warn('❌ No shadow root found for event setup');
      return;
    }

    // Search input
    this.searchInput?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.updateFilteredDialogs();

      if (this.props.onSearch) {
        this.props.onSearch(this.searchQuery);
      }
    });

    // Clear search
    const clearButton = this.shadowRoot.querySelector('.search-clear');
    clearButton?.addEventListener('click', () => {
      this.searchQuery = '';
      this.searchInput.value = '';
      this.updateFilteredDialogs();
    });

    // Dialog list click handler (handles both selection and toggles)
    this.dialogListContainer?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Handle task group toggle - only if clicking specifically on the toggle area
      const taskToggle = target.closest('[data-type="task-toggle"]');
      if (taskToggle) {
        // Check if the click is specifically on the toggle icon
        const isToggleClick = target.closest('.task-group-toggle');
        if (isToggleClick) {
          const taskPath = taskToggle.getAttribute('data-task-path');
          if (taskPath) {
            this.toggleTaskGroup(taskPath);
          }
          return;
        }
        // If clicking elsewhere in the task group, treat it as dialog selection (don't return)
      }

      // Handle main dialog toggle - only if clicking specifically on the toggle area
      const mainDialogToggle = target.closest('[data-type="main-dialog-toggle"]');
      if (mainDialogToggle) {
        // Check if the click is specifically on the toggle icon or the dialog-count area
        const isToggleClick = target.closest('.dialog-toggle') || target.closest('.dialog-count');
        if (isToggleClick) {
          const dialogId = mainDialogToggle.getAttribute('data-dialog-id');
          if (dialogId) {
            this.toggleMainDialog(dialogId);
          }
          return;
        }
        // If clicking elsewhere in the header, treat it as dialog selection (don't return)
      }

      // Handle dialog selection - find dialog item and get dialog ID
      const dialogItem = target.closest('.dialog-item');
      if (dialogItem) {
        const dialogId = dialogItem.getAttribute('data-dialog-id');
        const rootId = dialogItem.getAttribute('data-root-id') || dialogId;
        const selfId = dialogItem.getAttribute('data-self-id') || undefined;
        const supdialogIdRaw = dialogItem.getAttribute('data-supdialog-id') || '';
        const teammateId = dialogItem.getAttribute('data-teammate-id');
        const teammateName = dialogItem.getAttribute('data-teammate-name');
        const taskDocPath = dialogItem.getAttribute('data-task-doc-path');
        const dialogTitle = dialogItem.getAttribute('data-dialog-title');
        const dataLevel = dialogItem.getAttribute('data-level');
        const dataType = dialogItem.getAttribute('data-type');
        const topicIdRaw = dialogItem.getAttribute('data-topic-id') || '';
        const supdialogId = supdialogIdRaw.trim() !== '' ? supdialogIdRaw : undefined;
        const topicId = topicIdRaw.trim() !== '' ? topicIdRaw : undefined;

        // Only trigger selection for actual dialog items, not toggles
        if (dialogId && dataType !== 'task-toggle' && dataType !== 'main-dialog-toggle') {
          // Create enhanced dialog info from data attributes
          // For subdialogs (level 3), use selfId as the primary dialog ID
          const effectiveSelfId = dataLevel === '3' ? selfId || dialogId : dialogId;
          const dialogInfo: DialogInfo = {
            selfId: effectiveSelfId,
            rootId: rootId || dialogId, // Ensure rootId is never null
            agentId: teammateId || 'unknown', // Ensure agentId is always set (type uses agentId)
            agentName: teammateName || this.getAgentDisplayName(teammateId || 'unknown'), // Generate default if missing
            taskDocPath: taskDocPath || 'no-task', // Ensure taskDocPath is always set
            supdialogId,
            topicId,
          };

          this.handleDialogSelection(dialogInfo);
        }
      }
    });

    // Filter buttons
    this.filterContainer?.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('.filter-button');
      if (button) {
        const filter = button.getAttribute('data-filter') as string;
        this.updateFilters({ status: filter === 'all' ? undefined : (filter as any) });
      }
    });
  }

  private updateFilteredDialogs(): void {
    this.syncMainDialogCollapseState();
    let filtered = [...this.props.dialogs];

    // Validate all dialogs have valid taskDocPath - fail loudly on invalid data
    filtered.forEach((dialog, index) => {
      if (!dialog.taskDocPath || dialog.taskDocPath.trim() === '') {
        throw new Error(
          `❌ CRITICAL ERROR: Dialog at index ${index} (rootId: ${dialog.rootId}) has invalid task document path: '${dialog.taskDocPath || 'undefined/null'}' - this indicates a serious data integrity issue. Task document is mandatory for all dialogs.`,
        );
      }
    });

    // Apply search filter
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase();
      filtered = filtered.filter(
        (dialog) =>
          dialog.rootId.toLowerCase().includes(query) ||
          dialog.agentId.toLowerCase().includes(query) ||
          (dialog.taskDocPath && dialog.taskDocPath.toLowerCase().includes(query)),
      );
    }

    // Apply status filter
    if (this.filters.status && this.filters.status !== 'all') {
      filtered = filtered.filter((dialog) => dialog.status === this.filters.status);
    }

    // Apply teammate filter
    if (this.filters.agentId) {
      filtered = filtered.filter((dialog) => dialog.agentId === this.filters.agentId);
    }

    // Deduplicate by unique key: rootId + selfId (for subdialogs)
    // Subdialogs share rootId with parent but have unique selfId
    const byKey = new Map<string, ApiRootDialogResponse>();
    for (const d of filtered) {
      if (!d || !d.rootId) continue;
      const uniqueKey = d.selfId ? `${d.rootId}:${d.selfId}` : d.rootId;
      if (!byKey.has(uniqueKey)) byKey.set(uniqueKey, d);
    }
    this.filteredDialogs = Array.from(byKey.values());
    this.dialogTree = this.getDialogTreeStructure(filtered);
    this.applyDialogListDiff();
    this.updateActiveStates();
  }

  private updateFilters(updates: Partial<DialogFilters>): void {
    this.filters = { ...this.filters, ...updates };
    this.updateFilteredDialogs();

    if (this.props.onFilterChange) {
      this.props.onFilterChange(this.filters);
    }
  }

  private updateActiveStates(): void {
    if (!this.dialogListContainer) return;

    const items = this.dialogListContainer.querySelectorAll('.dialog-item');
    items.forEach((item) => {
      item.classList.remove('active');
    });

    if (this.selectedRootId) {
      const selected = this.dialogListContainer.querySelector(
        `.dialog-item[data-root-id="${CSS.escape(this.selectedRootId)}"]`,
      ) as HTMLElement | null;
      if (selected) selected.classList.add('active');
    }
  }

  private syncMainDialogCollapseState(): void {
    const currentRootIds = new Set<string>();
    for (const dialog of this.props.dialogs) {
      if (!dialog || !dialog.rootId) continue;
      if (dialog.selfId) continue;
      currentRootIds.add(dialog.rootId);
      if (!this.knownMainDialogIds.has(dialog.rootId)) {
        this.knownMainDialogIds.add(dialog.rootId);
        this.collapsedMainDialogs.add(dialog.rootId);
      }
    }

    for (const rootId of Array.from(this.knownMainDialogIds)) {
      if (!currentRootIds.has(rootId)) {
        this.knownMainDialogIds.delete(rootId);
        this.collapsedMainDialogs.delete(rootId);
      }
    }
  }

  private toggleTaskGroup(taskPath: string): void {
    if (this.collapsedTasks.has(taskPath)) {
      this.collapsedTasks.delete(taskPath);
    } else {
      this.collapsedTasks.add(taskPath);
    }
    this.render();
  }

  private toggleMainDialog(rootDlgId: string): void {
    const wasCollapsed = this.collapsedMainDialogs.has(rootDlgId);
    if (wasCollapsed) {
      this.collapsedMainDialogs.delete(rootDlgId);
      // Dispatch event for lazy subdialog loading when expanding
      this.dispatchEvent(
        new CustomEvent('dialog-expand', {
          detail: { rootId: rootDlgId },
          bubbles: true,
          composed: true,
        }),
      );
    } else {
      this.collapsedMainDialogs.add(rootDlgId);
    }
    this.render();
  }

  private hasSubdialogsInTask(taskPath: string): boolean {
    // Check tree structure for subdialogs in this task
    for (const taskNode of this.dialogTree) {
      // Type guard: only task nodes have taskDocPath
      if (taskNode.type !== 'task') continue;
      if (taskNode.taskDocPath !== taskPath) continue;
      if (!taskNode.children) continue;

      for (const mainNode of taskNode.children) {
        if (mainNode.type === 'main-dialog' && mainNode.children) {
          const subdialogCount = mainNode.children.filter((c) => c.type === 'subdialog').length;
          if (subdialogCount > 0) return true;
        }
      }
    }
    return false;
  }

  private applyDialogListDiff(): void {
    if (!this.shadowRoot) return;
    if (!this.dialogListContainer) {
      this.dialogListContainer = this.shadowRoot.querySelector(
        '.dialog-list#dialog-list',
      ) as HTMLElement;
      if (!this.dialogListContainer) return;
    }

    const emptyState = this.dialogListContainer.querySelector('.empty-state');
    if (emptyState && this.dialogTree.length > 0) {
      emptyState.remove();
    }

    const newTaskPaths = new Set<string>();
    const newDialogKeys = new Set<string>();

    for (const node of this.dialogTree) {
      if (node.type !== 'task') continue;
      // taskDocPath is guaranteed by discriminated union
      const taskPath = node.taskDocPath;
      newTaskPaths.add(taskPath);
      const taskEl = this.ensureTaskNode(
        taskPath,
        node.displayText,
        this.getTaskDocumentCount(taskPath),
      );
      let insertAfterEl: HTMLElement | null = taskEl;
      for (const child of node.children || []) {
        if (child.type !== 'main-dialog' || !child.dialog) continue;
        const main = child.dialog;
        const mainKey = `main:${main.rootId}`;
        newDialogKeys.add(mainKey);
        const mainEl = this.ensureMainDialogNode(main);
        if (insertAfterEl && mainEl.previousElementSibling !== insertAfterEl) {
          insertAfterEl.insertAdjacentElement('afterend', mainEl);
        }
        insertAfterEl = mainEl;
        this.updateMainDialogCount(main.rootId);
        const isCollapsed = this.collapsedMainDialogs.has(main.rootId);
        if (!isCollapsed) {
          for (const sub of child.children || []) {
            // Type guard: only main-dialog and subdialog nodes have dialog property
            if (sub.type === 'subdialog' && sub.dialog) {
              const sd = sub.dialog;
              // Use rootId as fallback when selfId is missing to avoid collision risk
              const subKey = sd.selfId
                ? `sub:${sd.rootId}:${sd.selfId}`
                : `sub:${sd.rootId}:${sd.rootId}`;
              newDialogKeys.add(subKey);
              this.ensureSubdialogNode(main.rootId, sd);
            }
          }
        }
      }
    }

    const existingTaskEls = Array.from(this.taskNodeIndex.keys());
    for (const t of existingTaskEls) {
      if (!newTaskPaths.has(t)) {
        const el = this.taskNodeIndex.get(t);
        if (el) el.remove();
        this.taskNodeIndex.delete(t);
      }
    }

    // Use proper keys with prefix for dialog cleanup
    const existingDialogKeys = Array.from(this.dialogNodeIndex.keys());
    for (const key of existingDialogKeys) {
      if (!newDialogKeys.has(key)) {
        const el = this.dialogNodeIndex.get(key);
        if (el) el.remove();
        this.dialogNodeIndex.delete(key);
      }
    }
  }

  private ensureTaskNode(taskPath: string, displayText: string, count: number): HTMLElement {
    let el = this.taskNodeIndex.get(taskPath);
    if (!el) {
      const html = this.renderTreeNode({
        type: 'task',
        level: 1,
        taskDocPath: taskPath,
        displayText,
        children: [],
      });
      el = this.createElement(html);
      this.dialogListContainer.appendChild(el);
      this.taskNodeIndex.set(taskPath, el);
    }
    const countEl = el.querySelector('.task-group-count');
    if (countEl) countEl.textContent = String(count);
    return el;
  }

  private ensureMainDialogNode(dialog: ApiRootDialogResponse): HTMLElement {
    let el = this.dialogNodeIndex.get(`main:${dialog.rootId}`);
    if (!el) {
      const displayText = `@${dialog.agentId} (${dialog.rootId})`;
      const html = this.renderTreeNode({
        type: 'main-dialog',
        level: 2,
        dialog,
        displayText,
        children: [],
      });
      el = this.createElement(html);
      this.dialogListContainer.appendChild(el);
      this.dialogNodeIndex.set(`main:${dialog.rootId}`, el);
    }
    const titleEl = el.querySelector('.dialog-title');
    if (titleEl) titleEl.textContent = this.formatTitleText(dialog.agentId, dialog.rootId);
    const tsEl = el.querySelector('.dialog-timestamp');
    if (tsEl) {
      const ts = String(dialog.lastModified || '');
      if (tsEl.textContent !== ts) tsEl.textContent = ts;
    }
    if (this.selectedRootId && this.selectedRootId === dialog.rootId) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
    return el;
  }

  private ensureSubdialogNode(parentId: string, subdialog: ApiRootDialogResponse): HTMLElement {
    // Use composite key for subdialogs to avoid collision with main dialog entries
    // Use rootId as fallback when selfId is missing to avoid collision risk
    const subdialogKey = subdialog.selfId
      ? `sub:${subdialog.rootId}:${subdialog.selfId}`
      : `sub:${subdialog.rootId}:${subdialog.rootId}`;
    let el = this.dialogNodeIndex.get(subdialogKey);
    if (!el) {
      const displayText = this.formatDisplayText(
        subdialog.agentId,
        subdialog.selfId || subdialog.rootId,
        subdialog.lastModified,
      );
      const html = this.renderTreeNode({
        type: 'subdialog',
        level: 3,
        dialog: subdialog,
        displayText,
        children: [],
      });
      el = this.createElement(html);
      const parentEl = this.dialogNodeIndex.get(`main:${parentId}`);
      if (parentEl) parentEl.insertAdjacentElement('afterend', el);
      else this.dialogListContainer.appendChild(el);
      this.dialogNodeIndex.set(subdialogKey, el);
    }
    const titleEl = el.querySelector('.dialog-title');
    if (titleEl) {
      titleEl.textContent = this.formatTitleText(
        subdialog.agentId,
        subdialog.selfId || subdialog.rootId,
      );
    }
    return el;
  }

  private updateMainDialogCount(rootDlgId: string): void {
    const el = this.dialogNodeIndex.get(`main:${rootDlgId}`);
    if (!el) return;
    const count = this.getSubdialogCount(rootDlgId);
    const countEl = el.querySelector('.dialog-count');
    if (countEl) {
      if (count > 0) {
        countEl.textContent = `${count} subdialog${count !== 1 ? 's' : ''}`;
      } else {
        countEl.remove();
      }
    } else if (count > 0) {
      const metaEl = el.querySelector('.dialog-meta');
      if (metaEl) {
        const newCountEl = document.createElement('span');
        newCountEl.className = 'dialog-count';
        newCountEl.textContent = `${count} subdialogs`;
        metaEl.appendChild(newCountEl);
      }
    }
  }

  private createElement(html: string): HTMLElement {
    const temp = document.createElement('div');
    temp.innerHTML = html.trim();
    return temp.firstElementChild as HTMLElement;
  }

  /**
   * Handle dialog selection - simplified single interface
   */
  private handleDialogSelection(dialog: DialogInfo): void {
    // Update current dialog visual state
    this.setCurrentDialog(dialog);

    // Notify parent via callback
    if (this.props.onSelect) {
      this.props.onSelect(dialog);
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-dialog-list')) {
  customElements.define('dominds-dialog-list', DomindsDialogList);
}
