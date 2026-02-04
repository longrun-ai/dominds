/**
 * Running dialog list (minimal UI)
 */

import { getUiStrings } from '../i18n/ui';
import type { ApiMoveDialogsRequest, ApiRootDialogResponse, DialogInfo } from '../shared/types';
import type { LanguageCode } from '../shared/types/language';
import {
  runControlVisualStateFromRunState,
  runStateClassSuffixFromRunState,
} from '../utils/run-control-visual';

export interface RunningDialogListProps {
  dialogs: ApiRootDialogResponse[];
  maxHeight?: string;
  onSelect?: (dialog: DialogInfo) => void;
  uiLanguage: LanguageCode;
  generatingDialogKeys: ReadonlySet<string>;
}

export type DialogCreateAction =
  | { kind: 'task'; taskDocPath: string }
  | { kind: 'root'; rootId: string; taskDocPath: string; agentId: string };

type RootGroup = {
  rootId: string;
  sortKey: number;
  root: ApiRootDialogResponse | null;
  subdialogs: ApiRootDialogResponse[];
};

type TaskGroup = {
  taskDocPath: string;
  sortKey: number;
  roots: RootGroup[];
};

type ListState = { kind: 'empty' } | { kind: 'ready'; groups: TaskGroup[] };

type SelectionState =
  | { kind: 'none' }
  | { kind: 'selected'; rootId: string; selfId: string; isRoot: boolean };

export class RunningDialogList extends HTMLElement {
  private props: RunningDialogListProps = {
    dialogs: [],
    maxHeight: 'none',
    uiLanguage: 'en',
    generatingDialogKeys: new Set(),
  };
  private listState: ListState = { kind: 'empty' };
  private selectionState: SelectionState = { kind: 'none' };
  private listEl: HTMLElement | null = null;
  private rootIndex: Map<string, ApiRootDialogResponse> = new Map();
  private subIndex: Map<string, Map<string, ApiRootDialogResponse>> = new Map();
  private collapsedTasks: Set<string> = new Set();
  private collapsedRoots: Set<string> = new Set();
  private knownRootIds: Set<string> = new Set();
  private requestedSubdialogRoots: Set<string> = new Set();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.updateListState(this.props.dialogs);
    this.render();
  }

  public setProps(props: Partial<RunningDialogListProps>): void {
    this.props = { ...this.props, ...props };
    this.updateListState(this.props.dialogs);
    this.render();
  }

  public setDialogs(dialogs: ApiRootDialogResponse[]): void {
    this.props = { ...this.props, dialogs };
    this.updateListState(dialogs);
    this.renderList();
  }

  public setCurrentDialog(dialog: DialogInfo): void {
    const isRoot = dialog.selfId === dialog.rootId;
    const match = this.findDialogByIds(dialog.rootId, dialog.selfId, isRoot);
    if (!match) {
      this.selectionState = { kind: 'none' };
      this.renderList();
      return;
    }
    this.applySelection(match);
  }

  public getSelectedDialogId(): string | null {
    if (this.selectionState.kind === 'selected') {
      return this.selectionState.rootId;
    }
    return null;
  }

  public getAllDialogs(): ApiRootDialogResponse[] {
    return [...this.props.dialogs];
  }

  public findDialogByRootId(rootId: string): ApiRootDialogResponse | undefined {
    return this.props.dialogs.find((d) => d.rootId === rootId && !d.selfId);
  }

  public findSubdialog(rootId: string, selfId: string): ApiRootDialogResponse | undefined {
    return this.props.dialogs.find((d) => d.rootId === rootId && d.selfId === selfId);
  }

  public selectDialogById(rootId: string): boolean {
    const dialog = this.findDialogByRootId(rootId);
    if (!dialog) return false;
    this.applySelection(dialog);
    this.notifySelection(dialog);
    return true;
  }

  private getDialogDisplayCallsign(dialog: ApiRootDialogResponse): string {
    const assignment = dialog.assignmentFromSup;
    if (assignment && typeof assignment.tellaskHead === 'string') {
      if (/^\s*@self\b/.test(assignment.tellaskHead)) return '@self';
    }
    return `@${dialog.agentId}`;
  }

  private dialogKey(rootId: string, selfId: string): string {
    return selfId === rootId ? rootId : `${rootId}#${selfId}`;
  }

  private getDialogKey(dialog: ApiRootDialogResponse): string {
    const rootId = dialog.rootId;
    const selfId = dialog.selfId ? dialog.selfId : dialog.rootId;
    return this.dialogKey(rootId, selfId);
  }

  private isGenerating(dialog: ApiRootDialogResponse): boolean {
    const key = this.getDialogKey(dialog);
    return this.props.generatingDialogKeys.has(key);
  }

  private renderRunBadges(dialog: ApiRootDialogResponse): string {
    const t = getUiStrings(this.props.uiLanguage);
    const visualState = runControlVisualStateFromRunState(dialog.runState);
    const badges: string[] = [];

    switch (visualState.kind) {
      case 'none':
      case 'proceeding':
      case 'proceeding_stop_requested':
        break;
      case 'interrupted':
        badges.push(
          `<span class="run-badge interrupted" title="${t.runBadgeInterruptedTitle}">INT</span>`,
        );
        break;
      case 'blocked_q4h':
        badges.push(
          `<span class="run-badge blocked blocked-q4h" title="${t.runBadgeWaitingHumanTitle}">Q4H</span>`,
        );
        break;
      case 'blocked_subdialogs':
        badges.push(
          `<span class="run-badge blocked blocked-subdialogs" title="${t.runBadgeWaitingSubdialogsTitle}">SUB</span>`,
        );
        break;
      case 'blocked_both':
        badges.push(
          `<span class="run-badge blocked blocked-both" title="${t.runBadgeWaitingBothTitle}">Q4H+SUB</span>`,
        );
        break;
      default: {
        const _exhaustive: never = visualState;
        throw new Error(`Unhandled RunControlVisualState: ${String(_exhaustive)}`);
      }
    }

    if (this.isGenerating(dialog)) {
      badges.push(
        `<span class="run-badge generating" title="${t.runBadgeGeneratingTitle}">GEN</span>`,
      );
    }

    if (badges.length === 0) return '';
    return `<span class="run-badges">${badges.join('')}</span>`;
  }

  private getRunStateClass(dialog: ApiRootDialogResponse): string {
    const suffix = runStateClassSuffixFromRunState(dialog.runState);
    return suffix ? ` ${suffix}` : '';
  }

  private updateListState(dialogs: ApiRootDialogResponse[]): void {
    const validated = this.validateDialogs(dialogs);
    const groups = this.buildGroups(validated);
    const rootIds = new Set<string>(validated.map((dialog) => dialog.rootId));
    const loadedSubdialogRoots = new Set<string>();
    for (const dialog of validated) {
      if (dialog.selfId) loadedSubdialogRoots.add(dialog.rootId);
    }
    for (const rootId of rootIds) {
      if (!this.knownRootIds.has(rootId)) {
        this.knownRootIds.add(rootId);
        this.collapsedRoots.add(rootId);
      }
    }
    for (const existing of Array.from(this.knownRootIds)) {
      if (!rootIds.has(existing)) {
        this.knownRootIds.delete(existing);
        this.collapsedRoots.delete(existing);
        this.requestedSubdialogRoots.delete(existing);
      }
    }
    // Once a root's subdialogs are present, the request has been satisfied.
    // Clearing this allows re-request if subdialogs later get pruned from props.
    for (const existing of Array.from(this.requestedSubdialogRoots)) {
      if (loadedSubdialogRoots.has(existing)) {
        this.requestedSubdialogRoots.delete(existing);
      }
    }
    const taskPaths = new Set<string>(groups.map((group) => group.taskDocPath));
    for (const existing of Array.from(this.collapsedTasks)) {
      if (!taskPaths.has(existing)) {
        this.collapsedTasks.delete(existing);
      }
    }
    if (groups.length === 0) {
      this.listState = { kind: 'empty' };
    } else {
      this.listState = { kind: 'ready', groups };
    }
    const selection = this.selectionState;
    if (selection.kind === 'selected') {
      const hasSelection = validated.some((dialog) => this.isSelectedDialog(dialog, selection));
      if (!hasSelection) {
        this.selectionState = { kind: 'none' };
      }
    }
  }

  private validateDialogs(dialogs: ApiRootDialogResponse[]): ApiRootDialogResponse[] {
    const seenRoots = new Set<string>();
    const seenSubs = new Map<string, Set<string>>();
    const validated: ApiRootDialogResponse[] = [];
    for (const dialog of dialogs) {
      if (!dialog.rootId) {
        throw new Error('Dialog missing rootId.');
      }
      if (!dialog.agentId) {
        throw new Error(`Dialog ${dialog.rootId} missing agentId.`);
      }
      if (dialog.status !== 'running') {
        throw new Error(
          `Dialog ${dialog.rootId}${dialog.selfId ? `:${dialog.selfId}` : ''} is not running.`,
        );
      }
      if (dialog.selfId) {
        let subs = seenSubs.get(dialog.rootId);
        if (!subs) {
          subs = new Set<string>();
          seenSubs.set(dialog.rootId, subs);
        }
        if (subs.has(dialog.selfId)) {
          throw new Error(
            `Duplicate subdialog detected for root ${dialog.rootId} and self ${dialog.selfId}.`,
          );
        }
        subs.add(dialog.selfId);
      } else {
        if (seenRoots.has(dialog.rootId)) {
          throw new Error(`Duplicate root dialog detected: ${dialog.rootId}`);
        }
        seenRoots.add(dialog.rootId);
      }
      validated.push(dialog);
    }
    return validated;
  }

  private buildGroups(dialogs: ApiRootDialogResponse[]): TaskGroup[] {
    const taskMap = new Map<string, { taskDocPath: string; roots: Map<string, RootGroup> }>();

    for (const dialog of dialogs) {
      const taskDocPath = dialog.taskDocPath;
      if (!taskDocPath) continue;
      const taskKey = taskDocPath.trim();
      if (!taskKey) continue;

      let taskGroup = taskMap.get(taskKey);
      if (!taskGroup) {
        taskGroup = { taskDocPath: taskKey, roots: new Map() };
        taskMap.set(taskKey, taskGroup);
      }

      const rootId = dialog.rootId;
      if (!rootId) continue;
      let rootGroup = taskGroup.roots.get(rootId);
      if (!rootGroup) {
        rootGroup = { rootId, sortKey: 0, root: null, subdialogs: [] };
        taskGroup.roots.set(rootId, rootGroup);
      }

      const updatedAt = this.parseTimestamp(dialog.lastModified);
      if (updatedAt > rootGroup.sortKey) {
        rootGroup.sortKey = updatedAt;
      }

      if (dialog.selfId) {
        rootGroup.subdialogs.push(dialog);
      } else {
        rootGroup.root = dialog;
      }
    }

    const groups: TaskGroup[] = [];
    for (const taskGroup of taskMap.values()) {
      const roots: RootGroup[] = [];
      for (const rootGroup of taskGroup.roots.values()) {
        const rootUpdated = rootGroup.root ? this.parseTimestamp(rootGroup.root.lastModified) : 0;
        const subUpdated = this.maxUpdatedAt(rootGroup.subdialogs);
        const sortKey = Math.max(rootUpdated, subUpdated, rootGroup.sortKey);
        const subdialogs = [...rootGroup.subdialogs].sort((a, b) => {
          const delta = this.parseTimestamp(b.lastModified) - this.parseTimestamp(a.lastModified);
          if (delta !== 0) return delta;
          const aId = a.selfId ?? '';
          const bId = b.selfId ?? '';
          return aId.localeCompare(bId);
        });
        roots.push({
          rootId: rootGroup.rootId,
          sortKey,
          root: rootGroup.root,
          subdialogs,
        });
      }

      roots.sort((a, b) => {
        const delta = b.sortKey - a.sortKey;
        if (delta !== 0) return delta;
        return a.rootId.localeCompare(b.rootId);
      });

      const groupSortKey = roots.reduce((max, root) => Math.max(max, root.sortKey), 0);
      groups.push({ taskDocPath: taskGroup.taskDocPath, sortKey: groupSortKey, roots });
    }

    groups.sort((a, b) => {
      const delta = b.sortKey - a.sortKey;
      if (delta !== 0) return delta;
      return a.taskDocPath.localeCompare(b.taskDocPath);
    });

    return groups;
  }

  private parseTimestamp(value: string): number {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return 0;
    return ms;
  }

  private maxUpdatedAt(dialogs: ApiRootDialogResponse[]): number {
    let max = 0;
    for (const dialog of dialogs) {
      const ts = this.parseTimestamp(dialog.lastModified);
      if (ts > max) max = ts;
    }
    return max;
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="running-dialog-list" id="running-dialog-list"></div>
    `;

    this.listEl = this.shadowRoot.querySelector('#running-dialog-list');
    if (this.listEl) {
      this.listEl.addEventListener('click', this.handleClick);
    }
    this.renderList();
  }

  private renderList(): void {
    if (!this.listEl) return;

    const t = getUiStrings(this.props.uiLanguage);

    this.rootIndex.clear();
    this.subIndex.clear();

    switch (this.listState.kind) {
      case 'empty': {
        this.listEl.innerHTML = `
          <div class="empty">${t.noDialogsYet}</div>
        `;
        return;
      }
      case 'ready': {
        const html = this.listState.groups
          .map((group) => {
            const taskCollapsed = this.collapsedTasks.has(group.taskDocPath);
            const taskToggle = this.renderToggleIcon(taskCollapsed);
            const rootNodes = group.roots
              .map((rootGroup) => {
                const rootDialog = rootGroup.root;
                const rootCollapsed = this.collapsedRoots.has(rootGroup.rootId);
                const rootToggle = this.renderToggleIcon(rootCollapsed);
                const rootRow = rootDialog
                  ? this.renderRootRow(rootDialog, rootToggle, rootGroup.subdialogs.length)
                  : `
                    <div class="dialog-item root-dialog missing" data-root-id="${rootGroup.rootId}" data-self-id="">
                      <div class="dialog-row">
                        <button class="toggle root-toggle" data-action="toggle-root" data-root-id="${rootGroup.rootId}" type="button">${rootToggle}</button>
                        <span class="dialog-title">${t.missingRoot}</span>
                        <span class="dialog-meta-right">
                          <span class="dialog-count">${rootGroup.subdialogs.length}</span>
                          <span class="dialog-status">${rootGroup.rootId}</span>
                        </span>
                      </div>
                    </div>
                  `;
                const subNodes = rootGroup.subdialogs
                  .map((subdialog) => this.renderDialogRow(subdialog, 'sub'))
                  .join('');
                const subCollapsed = taskCollapsed || rootCollapsed;
                return `
                  <div class="rdlg-node" data-rdlg-root-id="${rootGroup.rootId}">
                    ${rootRow}
                    <div class="sdlg-children ${subCollapsed ? 'collapsed' : ''}">${subNodes}</div>
                  </div>
                `;
              })
              .join('');
            return `
              <div class="task-group task-node">
                <div class="task-title" data-task-path="${group.taskDocPath}">
                  <div class="task-title-left">
                    <button class="toggle task-toggle" data-action="toggle-task" data-task-path="${group.taskDocPath}" type="button">${taskToggle}</button>
                    <span>${group.taskDocPath}</span>
                  </div>
                  <div class="task-title-right">
                    <button class="action icon-button" data-action="task-create-dialog" data-task-path="${group.taskDocPath}" type="button" title="${t.createNewDialogTitle}" aria-label="${t.createNewDialogTitle}">
                      ${this.renderCreateIcon()}
                    </button>
                    <button class="action icon-button" data-action="task-mark-done" data-task-path="${group.taskDocPath}" type="button" title="${t.dialogActionMarkAllDone}" aria-label="${t.dialogActionMarkAllDone}">
                      ${this.renderDoneIcon()}
                    </button>
                    <button class="action icon-button" data-action="task-archive" data-task-path="${group.taskDocPath}" type="button" title="${t.dialogActionArchiveAll}" aria-label="${t.dialogActionArchiveAll}">
                      ${this.renderArchiveIcon()}
                    </button>
                    <span class="dialog-count">${group.roots.length}</span>
                  </div>
                </div>
                <div class="task-rows ${taskCollapsed ? 'collapsed' : ''}">${rootNodes}</div>
              </div>
            `;
          })
          .join('');
        this.listEl.innerHTML = html;
        return;
      }
    }
  }

  private renderToggleIcon(collapsed: boolean): string {
    const rotation = collapsed ? '0deg' : '90deg';
    return `
      <svg class="q4h-toggle-arrow" style="transform: rotate(${rotation})" viewBox="0 0 8 10" aria-hidden="true" focusable="false">
        <path d="M1 1 L7 5 L1 9 Z" fill="currentColor"></path>
      </svg>
    `;
  }

  private renderDoneIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14 9 11"></polyline>
      </svg>
    `;
  }

  private renderCreateIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    `;
  }

  private renderArchiveIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <polyline points="21 8 21 21 3 21 3 8"></polyline>
        <rect x="1" y="3" width="22" height="5"></rect>
        <line x1="10" y1="12" x2="14" y2="12"></line>
      </svg>
    `;
  }

  private renderRootRow(
    dialog: ApiRootDialogResponse,
    toggleIcon: string,
    subdialogCount: number,
  ): string {
    this.indexDialog(dialog);
    const t = getUiStrings(this.props.uiLanguage);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const isGenerating = this.isGenerating(dialog);
    const runStateClass = this.getRunStateClass(dialog);
    const badges = this.renderRunBadges(dialog);
    const dialogId = dialog.rootId;
    const updatedAt = dialog.lastModified || '';

    return `
      <div
        class="dialog-item root-dialog${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
        data-root-id="${dialog.rootId}"
        data-self-id=""
      >
        <div class="dialog-row">
          <button class="toggle root-toggle" data-action="toggle-root" data-root-id="${dialog.rootId}" type="button">${toggleIcon}</button>
          <span class="dialog-title">@${dialog.agentId}</span>
          <span class="dialog-meta-right">
            ${badges}
            <button class="action icon-button" data-action="root-create-dialog" data-root-id="${dialog.rootId}" type="button" title="${t.createNewDialogTitle}" aria-label="${t.createNewDialogTitle}">
              ${this.renderCreateIcon()}
            </button>
            <button class="action icon-button" data-action="root-mark-done" data-root-id="${dialog.rootId}" type="button" title="${t.dialogActionMarkDone}" aria-label="${t.dialogActionMarkDone}">
              ${this.renderDoneIcon()}
            </button>
            <button class="action icon-button" data-action="root-archive" data-root-id="${dialog.rootId}" type="button" title="${t.dialogActionArchive}" aria-label="${t.dialogActionArchive}">
              ${this.renderArchiveIcon()}
            </button>
            <span class="dialog-count">${subdialogCount}</span>
          </span>
        </div>
        <div class="dialog-row dialog-submeta">
          <span class="dialog-meta-right">
            <span class="dialog-status">${dialogId}</span>
            <span class="dialog-time">${updatedAt}</span>
          </span>
        </div>
      </div>
    `;
  }

  private renderDialogRow(dialog: ApiRootDialogResponse, kind: 'root' | 'sub'): string {
    this.indexDialog(dialog);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const isGenerating = this.isGenerating(dialog);
    const runStateClass = this.getRunStateClass(dialog);
    const badges = this.renderRunBadges(dialog);
    const dialogId =
      kind === 'sub' ? (dialog.selfId ?? '') : dialog.selfId ? dialog.selfId : dialog.rootId;
    const rowClass = kind === 'sub' ? 'dialog-item sub-dialog' : 'dialog-item root-dialog';
    const updatedAt = dialog.lastModified || '';
    const tellaskSessionMark = dialog.tellaskSession ?? '';

    if (kind === 'sub') {
      const callsign = this.getDialogDisplayCallsign(dialog);
      return `
        <div
          class="${rowClass} sdlg-node${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
          data-root-id="${dialog.rootId}"
          data-self-id="${dialog.selfId ?? ''}"
        >
          <div class="dialog-row dialog-subrow">
              <span class="dialog-title">${callsign}</span>
              <span class="dialog-meta-right">
                ${badges}
                <span class="dialog-topic">${tellaskSessionMark}</span>
              </span>
            </div>
          <div class="dialog-row dialog-submeta">
            <span class="dialog-meta-right">
              <span class="dialog-status">${dialogId}</span>
              <span class="dialog-time">${updatedAt}</span>
            </span>
          </div>
        </div>
      `;
    }

    return `
      <div
        class="${rowClass}${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
        data-root-id="${dialog.rootId}"
        data-self-id="${dialog.selfId ?? ''}"
      >
        <div class="dialog-row">
          <span class="dialog-title">@${dialog.agentId}</span>
          <span class="dialog-meta-right">
            ${badges}
            <span class="dialog-status">${dialogId}</span>
            <span class="dialog-time">${updatedAt}</span>
          </span>
        </div>
      </div>
    `;
  }

  private handleClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (actionEl) {
      const action = actionEl.getAttribute('data-action');
      if (action === 'toggle-task') {
        const taskPath = actionEl.getAttribute('data-task-path');
        if (taskPath) {
          this.toggleTask(taskPath);
        }
        return;
      }
      if (action === 'task-create-dialog') {
        const taskDocPath = actionEl.getAttribute('data-task-path');
        if (taskDocPath) {
          this.emitCreateDialogAction({ kind: 'task', taskDocPath });
        }
        return;
      }
      if (action === 'task-mark-done') {
        const taskDocPath = actionEl.getAttribute('data-task-path');
        if (taskDocPath) {
          this.emitStatusAction({
            kind: 'task',
            taskDocPath,
            fromStatus: 'running',
            toStatus: 'completed',
          });
        }
        return;
      }
      if (action === 'task-archive') {
        const taskDocPath = actionEl.getAttribute('data-task-path');
        if (taskDocPath) {
          this.emitStatusAction({
            kind: 'task',
            taskDocPath,
            fromStatus: 'running',
            toStatus: 'archived',
          });
        }
        return;
      }
      if (action === 'toggle-root') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.toggleRoot(rootId);
        }
        return;
      }
      if (action === 'root-create-dialog') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          const rootDialog = this.rootIndex.get(rootId);
          if (rootDialog) {
            this.emitCreateDialogAction({
              kind: 'root',
              rootId: rootDialog.rootId,
              taskDocPath: rootDialog.taskDocPath,
              agentId: rootDialog.agentId,
            });
          }
        }
        return;
      }
      if (action === 'root-mark-done') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.emitStatusAction({
            kind: 'root',
            rootId,
            fromStatus: 'running',
            toStatus: 'completed',
          });
        }
        return;
      }
      if (action === 'root-archive') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.emitStatusAction({
            kind: 'root',
            rootId,
            fromStatus: 'running',
            toStatus: 'archived',
          });
        }
        return;
      }
    }
    const item = target.closest('[data-root-id]') as HTMLElement | null;
    if (!item) return;
    const rootId = item.getAttribute('data-root-id');
    if (!rootId) return;
    const selfId = item.getAttribute('data-self-id') || '';
    const isRoot = selfId === '';
    const dialog = this.findDialogByIds(rootId, selfId, isRoot);
    if (!dialog) return;
    this.applySelection(dialog);
    this.notifySelection(dialog);
  };

  private applySelection(dialog: ApiRootDialogResponse): void {
    const isRoot = !dialog.selfId;
    this.selectionState = {
      kind: 'selected',
      rootId: dialog.rootId,
      selfId: dialog.selfId ?? dialog.rootId,
      isRoot,
    };
    this.collapsedTasks.delete(dialog.taskDocPath);
    this.collapsedRoots.delete(dialog.rootId);

    // Ensure the selected dialog's hierarchy is available in the list.
    // We only lazy-load subdialogs when the root is expanded via the toggle button,
    // but selection can happen through other UX paths (clicking a row, deep-link,
    // programmatic selection, etc.). Without this, run-state styling only appears
    // for the currently selected node because siblings/children are not loaded.
    if (
      !this.requestedSubdialogRoots.has(dialog.rootId) &&
      !this.hasSubdialogsLoaded(dialog.rootId)
    ) {
      this.requestedSubdialogRoots.add(dialog.rootId);
      this.dispatchEvent(
        new CustomEvent('dialog-expand', {
          detail: { rootId: dialog.rootId },
          bubbles: true,
          composed: true,
        }),
      );
    }

    this.renderList();
  }

  private indexDialog(dialog: ApiRootDialogResponse): void {
    if (dialog.selfId) {
      let subs = this.subIndex.get(dialog.rootId);
      if (!subs) {
        subs = new Map<string, ApiRootDialogResponse>();
        this.subIndex.set(dialog.rootId, subs);
      }
      subs.set(dialog.selfId, dialog);
      return;
    }
    this.rootIndex.set(dialog.rootId, dialog);
  }

  private findDialogByIds(
    rootId: string,
    selfId: string,
    isRoot: boolean,
  ): ApiRootDialogResponse | undefined {
    if (isRoot) {
      const rootDialog = this.rootIndex.get(rootId);
      if (rootDialog) return rootDialog;
      return this.props.dialogs.find((dialog) => dialog.rootId === rootId && !dialog.selfId);
    }
    const subs = this.subIndex.get(rootId);
    if (subs) {
      const subDialog = subs.get(selfId);
      if (subDialog) return subDialog;
    }
    return this.props.dialogs.find(
      (dialog) => dialog.rootId === rootId && dialog.selfId === selfId,
    );
  }

  private isSelectedDialog(dialog: ApiRootDialogResponse, selection: SelectionState): boolean {
    if (selection.kind !== 'selected') return false;
    if (selection.rootId !== dialog.rootId) return false;
    if (selection.isRoot) {
      return !dialog.selfId;
    }
    return dialog.selfId === selection.selfId;
  }

  private toggleTask(taskPath: string): void {
    if (this.collapsedTasks.has(taskPath)) {
      this.collapsedTasks.delete(taskPath);
    } else {
      this.collapsedTasks.add(taskPath);
    }
    this.renderList();
  }

  private toggleRoot(rootId: string): void {
    if (this.collapsedRoots.has(rootId)) {
      this.collapsedRoots.delete(rootId);
      if (!this.requestedSubdialogRoots.has(rootId) && !this.hasSubdialogsLoaded(rootId)) {
        this.requestedSubdialogRoots.add(rootId);
        this.dispatchEvent(
          new CustomEvent('dialog-expand', {
            detail: { rootId },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else {
      this.collapsedRoots.add(rootId);
    }
    this.renderList();
  }

  private emitStatusAction(detail: ApiMoveDialogsRequest): void {
    this.dispatchEvent(
      new CustomEvent('dialog-status-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitCreateDialogAction(detail: DialogCreateAction): void {
    this.dispatchEvent(
      new CustomEvent('dialog-create-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private hasSubdialogsLoaded(rootId: string): boolean {
    return this.props.dialogs.some((dialog) => dialog.rootId === rootId && !!dialog.selfId);
  }

  private notifySelection(dialog: ApiRootDialogResponse): void {
    if (!this.props.onSelect) return;

    const dialogInfo: DialogInfo = {
      rootId: dialog.rootId,
      selfId: dialog.selfId ?? dialog.rootId,
      agentId: dialog.agentId,
      agentName: '',
      taskDocPath: dialog.taskDocPath,
      supdialogId: dialog.supdialogId,
      tellaskSession: dialog.tellaskSession,
      assignmentFromSup: dialog.assignmentFromSup,
    };

    this.props.onSelect(dialogInfo);
  }

  private getStyles(): string {
    const maxHeight = this.props.maxHeight ?? 'none';
    return `
      :host {
        display: block;
        height: 100%;
        width: 100%;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: var(--dominds-fg, #333333);
        background: var(--dominds-sidebar-bg, #ffffff);
      }

      .running-dialog-list {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        max-height: ${maxHeight};
        min-height: 0;
      }

      .task-group {
        display: flex;
        flex-direction: column;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
      }

      .task-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        font-size: 12px;
        font-weight: 600;
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
        background: var(--dominds-hover, #f7f7f7);
      }

      .task-title-left {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .task-title-right {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .task-rows {
        display: flex;
        flex-direction: column;
      }

      .task-rows.collapsed {
        display: none;
      }

      .rdlg-node {
        display: flex;
        flex-direction: column;
      }

      .sdlg-children {
        display: flex;
        flex-direction: column;
      }

      .sdlg-children.collapsed {
        display: none;
      }

      .dialog-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        cursor: pointer;
        border-left: 3px solid transparent;
      }

      .root-dialog {
        padding-left: 12px;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
      }

      .sub-dialog {
        padding-left: 28px;
      }

      .dialog-item.missing {
        cursor: default;
        color: var(--dominds-muted, #999999);
      }

      .dialog-item.missing:hover {
        background: transparent;
      }

      .dialog-item:hover {
        background: var(--dominds-hover, #f5f5f5);
      }

      .dialog-item.selected {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 12%, transparent);
      }

      .dialog-item.state-interrupted {
        border-left-color: color-mix(in srgb, var(--dominds-danger, #dc3545) 55%, transparent);
        background: color-mix(in srgb, var(--dominds-danger, #dc3545) 10%, transparent);
      }

      .dialog-item.state-blocked-q4h {
        border-left-color: color-mix(in srgb, #7c3aed 60%, transparent);
        background: color-mix(in srgb, #7c3aed 9%, transparent);
      }

      .dialog-item.state-blocked-subdialogs {
        border-left-color: color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 7%, transparent);
      }

      .dialog-item.state-blocked-both {
        border-left-color: color-mix(in srgb, #7c3aed 40%, var(--dominds-primary, #007acc) 40%);
        background: color-mix(in srgb, #7c3aed 6%, var(--dominds-primary, #007acc) 5%);
      }

      .dialog-item.state-proceeding {
        --dialog-glow-color: var(--dominds-primary, #007acc);
        border-left-color: color-mix(in srgb, var(--dialog-glow-color) 55%, transparent);
        background: color-mix(in srgb, var(--dialog-glow-color) 5%, transparent);
        position: relative;
        overflow: hidden;
      }

      .dialog-item.state-proceeding-stop {
        border-left-color: color-mix(in srgb, #f59e0b 60%, transparent);
        background: color-mix(in srgb, #f59e0b 8%, transparent);
      }

      .dialog-item.state-proceeding::before,
      .dialog-item.gen-active::before {
        content: '';
        position: absolute;
        inset: -28px;
        z-index: 0;
        pointer-events: none;
        background:
          radial-gradient(
            ellipse at 50% 50%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 40%, transparent)
              0%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 20%, transparent)
              35%,
            transparent 70%
          );
        opacity: 0.12;
        transform: scale(0.98);
        filter: blur(12px);
      }

      .dialog-item.state-proceeding::after,
      .dialog-item.gen-active::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -120%;
        width: 240%;
        z-index: 0;
        transform: translateX(0);
        pointer-events: none;
        opacity: 0.5;
        background:
          linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 20%, transparent)
              25%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 55%, transparent)
              50%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 20%, transparent)
              75%,
            transparent 100%
          );
        filter: blur(0.5px);
        animation: dialogScanlineSweep 1.05s ease-in-out infinite;
      }

      .dialog-item.state-proceeding > .dialog-row,
      .dialog-item.gen-active > .dialog-row {
        position: relative;
        z-index: 1;
      }

      @keyframes dialogScanlineSweep {
        0% {
          transform: translateX(-10%);
          opacity: 0.15;
        }
        35% {
          opacity: 0.85;
        }
        100% {
          transform: translateX(110%);
          opacity: 0.15;
        }
      }

      .dialog-item.gen-active {
        --dialog-glow-color: var(--dominds-primary, #007acc);
        position: relative;
        overflow: hidden;
      }

      @media (prefers-reduced-motion: reduce) {
        .dialog-item.state-proceeding::before,
        .dialog-item.gen-active::before,
        .dialog-item.state-proceeding::after,
        .dialog-item.gen-active::after {
          animation: none;
        }

        .dialog-item.state-proceeding::after,
        .dialog-item.gen-active::after {
          opacity: 0.2;
        }
      }

      .run-badges {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .run-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 18px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.02em;
        border: 1px solid color-mix(in srgb, var(--dominds-border, #e0e0e0) 80%, transparent);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-muted, #666666);
        user-select: none;
      }

      .run-badge.interrupted {
        background: color-mix(in srgb, var(--dominds-danger-bg, #f8d7da) 70%, white 30%);
        border-color: color-mix(in srgb, var(--dominds-danger, #dc3545) 30%, transparent);
        color: var(--dominds-danger, #721c24);
      }

      .run-badge.blocked-q4h {
        background: color-mix(in srgb, #ede9fe 70%, white 30%);
        border-color: color-mix(in srgb, #7c3aed 35%, transparent);
        color: #5b21b6;
      }

      .run-badge.blocked-subdialogs {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 10%, white 90%);
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 35%, transparent);
        color: var(--dominds-primary, #007acc);
      }

      .run-badge.blocked-both {
        background: color-mix(in srgb, #ede9fe 45%, var(--dominds-primary, #007acc) 9%, white 46%);
        border-color: color-mix(in srgb, #7c3aed 25%, var(--dominds-primary, #007acc) 25%);
        color: #5b21b6;
      }

      .run-badge.generating {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 14%, white 86%);
        border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 35%, transparent);
        color: var(--dominds-primary, #007acc);
      }

      .toggle {
        border: none;
        background: transparent;
        padding: 0;
        margin-right: 6px;
        color: var(--dominds-muted, #666666);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
      }

      .toggle:focus-visible {
        outline: 1px solid var(--dominds-primary, #007acc);
        outline-offset: 2px;
      }

      .toggle .q4h-toggle-arrow {
        width: 8px;
        height: 10px;
        color: currentColor;
        transition: transform 0.2s ease;
        transform-origin: center;
        display: block;
      }

      .icon-button {
        border: none;
        background: transparent;
        padding: 2px;
        margin: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--dominds-muted, #666666);
      }

      .icon-button:hover {
        color: var(--dominds-fg, #333333);
      }

      .icon-button:focus-visible {
        outline: 1px solid var(--dominds-primary, #007acc);
        outline-offset: 2px;
      }

      .dialog-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
      }

      .dialog-meta-right {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
      }

      .dialog-status {
        font-size: 11px;
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
      }

      .dialog-count {
        font-size: 11px;
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
      }

      .dialog-topic {
        font-size: 11px;
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
      }

      .dialog-time {
        font-size: 11px;
        color: var(--dominds-muted, #888888);
      }

      .dialog-subrow {
        font-size: 13px;
      }

      .dialog-submeta {
        justify-content: flex-end;
      }

      .empty {
        padding: 16px;
        font-size: 13px;
        color: var(--dominds-muted, #666666);
      }
    `;
  }
}

if (!customElements.get('running-dialog-list')) {
  customElements.define('running-dialog-list', RunningDialogList);
}
