/**
 * Archived dialog list (minimal UI)
 */

import { getUiStrings } from '../i18n/ui';
import type {
  ApiMoveDialogsRequest,
  ApiRootDialogResponse,
  DialogInfo,
  DialogStatusKind,
} from '../shared/types';
import type { LanguageCode } from '../shared/types/language';

export interface ArchivedDialogListProps {
  dialogs: ApiRootDialogResponse[];
  maxHeight?: string;
  onSelect?: (dialog: DialogInfo) => void;
  uiLanguage: LanguageCode;
  loading: boolean;
}

type DialogCreateAction =
  | { kind: 'task'; taskDocPath: string }
  | { kind: 'root'; rootId: string; taskDocPath: string; agentId: string };

type DialogDeleteAction = {
  kind: 'root';
  rootId: string;
  fromStatus: DialogStatusKind;
};

type DialogLinkAction = {
  rootId: string;
  selfId: string;
};

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

export class ArchivedDialogList extends HTMLElement {
  private props: ArchivedDialogListProps = {
    dialogs: [],
    maxHeight: 'none',
    uiLanguage: 'en',
    loading: false,
  };
  private listState: ListState = { kind: 'empty' };
  private selectionState: SelectionState = { kind: 'none' };
  private listEl: HTMLElement | null = null;
  private rootIndex: Map<string, ApiRootDialogResponse> = new Map();
  private subIndex: Map<string, Map<string, ApiRootDialogResponse>> = new Map();
  private collapsedTasks: Set<string> = new Set();
  private collapsedRoots: Set<string> = new Set();
  private knownRootIds: Set<string> = new Set();
  // Request markers only; this is not a data cache.
  private requestedSubdialogRoots: Set<string> = new Set();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.updateListState(this.props.dialogs);
    this.render();
  }

  public setProps(props: Partial<ArchivedDialogListProps>): void {
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

  private getDialogDisplayCallsign(dialog: ApiRootDialogResponse): string {
    const assignment = dialog.assignmentFromSup;
    if (assignment?.callName === 'freshBootsReasoning') {
      return 'FBR';
    }
    return `@${dialog.agentId}`;
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
    // We clear markers so a later expand can refetch after collapse-prune.
    // Frontend never keeps a global/all-dialog cache.
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
      if (dialog.status !== 'archived') {
        throw new Error(
          `Dialog ${dialog.rootId}${dialog.selfId ? `:${dialog.selfId}` : ''} is not archived.`,
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
      <div class="archived-dialog-list" id="archived-dialog-list"></div>
    `;

    this.listEl = this.shadowRoot.querySelector('#archived-dialog-list');
    if (this.listEl) {
      this.listEl.addEventListener('click', this.handleClick);
    }
    this.renderList();
  }

  private renderList(): void {
    if (!this.listEl) return;

    const t = getUiStrings(this.props.uiLanguage);

    if (this.props.loading) {
      this.listEl.innerHTML = `
        <div class="empty">${t.loading}</div>
      `;
      return;
    }

    this.rootIndex.clear();
    this.subIndex.clear();

    switch (this.listState.kind) {
      case 'empty': {
        this.listEl.innerHTML = `
          <div class="empty">${t.noArchivedDialogs}</div>
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
                  .map((subdialog) => this.renderDialogRow(subdialog))
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
                    <button class="action icon-button" data-action="task-revive" data-task-path="${group.taskDocPath}" type="button" title="${t.dialogActionReviveAll}" aria-label="${t.dialogActionReviveAll}">
                      ${this.renderReviveIcon()}
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

  private renderReviveIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <polyline points="1 4 1 10 7 10"></polyline>
        <polyline points="23 20 23 14 17 14"></polyline>
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"></path>
        <path d="M3.51 15A9 9 0 0 0 18.36 18.36L23 14"></path>
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

  private renderDeleteIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
      </svg>
    `;
  }

  private renderOpenExternalIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
    `;
  }

  private renderCopyLinkIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
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
    const dialogId = dialog.rootId;
    const updatedAt = dialog.lastModified || '';

    return `
      <div
        class="dialog-item root-dialog${isSelected ? ' selected' : ''}"
        data-root-id="${dialog.rootId}"
        data-self-id=""
      >
        <div class="dialog-row">
          <button class="toggle root-toggle" data-action="toggle-root" data-root-id="${dialog.rootId}" type="button">${toggleIcon}</button>
          <span class="dialog-title">@${dialog.agentId}</span>
          <span class="dialog-meta-right">
            <button class="action icon-button" data-action="root-create-dialog" data-root-id="${dialog.rootId}" type="button" title="${t.createNewDialogTitle}" aria-label="${t.createNewDialogTitle}">
              ${this.renderCreateIcon()}
            </button>
            <button class="action icon-button" data-action="root-revive" data-root-id="${dialog.rootId}" type="button" title="${t.dialogActionRevive}" aria-label="${t.dialogActionRevive}">
              ${this.renderReviveIcon()}
            </button>
            <button class="action icon-button" data-action="root-delete" data-root-id="${dialog.rootId}" type="button" title="${t.dialogActionDelete}" aria-label="${t.dialogActionDelete}">
              ${this.renderDeleteIcon()}
            </button>
            <button class="action icon-button" data-action="dialog-share-link" data-root-id="${dialog.rootId}" data-self-id="${dialog.rootId}" type="button" title="${t.q4hCopyLinkTitle}" aria-label="${t.q4hCopyLinkTitle}">
              ${this.renderCopyLinkIcon()}
            </button>
            <button class="action icon-button" data-action="dialog-open-external" data-root-id="${dialog.rootId}" data-self-id="${dialog.rootId}" type="button" title="${t.q4hOpenInNewTabTitle}" aria-label="${t.q4hOpenInNewTabTitle}">
              ${this.renderOpenExternalIcon()}
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

  private renderDialogRow(dialog: ApiRootDialogResponse): string {
    this.indexDialog(dialog);
    const t = getUiStrings(this.props.uiLanguage);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const updatedAt = dialog.lastModified || '';
    const sessionSlugMark = dialog.sessionSlug ?? '';
    const callsign = this.getDialogDisplayCallsign(dialog);

    return `
      <div
        class="dialog-item sub-dialog sdlg-node${isSelected ? ' selected' : ''}"
        data-root-id="${dialog.rootId}"
        data-self-id="${dialog.selfId ?? ''}"
      >
        <div class="dialog-row dialog-subrow">
          <span class="dialog-title">${callsign}</span>
          <span class="dialog-meta-right">
            <span class="dialog-time">${updatedAt}</span>
            <button class="action icon-button" data-action="dialog-share-link" data-root-id="${dialog.rootId}" data-self-id="${dialog.selfId ?? ''}" type="button" title="${t.q4hCopyLinkTitle}" aria-label="${t.q4hCopyLinkTitle}">
              ${this.renderCopyLinkIcon()}
            </button>
            <button class="action icon-button" data-action="dialog-open-external" data-root-id="${dialog.rootId}" data-self-id="${dialog.selfId ?? ''}" type="button" title="${t.q4hOpenInNewTabTitle}" aria-label="${t.q4hOpenInNewTabTitle}">
              ${this.renderOpenExternalIcon()}
            </button>
          </span>
        </div>
        <div class="dialog-row dialog-submeta">
          <span class="dialog-meta-right">
            <span class="dialog-topic">${sessionSlugMark}</span>
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
      if (action === 'task-revive') {
        const taskDocPath = actionEl.getAttribute('data-task-path');
        if (taskDocPath) {
          this.emitStatusAction({
            kind: 'task',
            taskDocPath,
            fromStatus: 'archived',
            toStatus: 'running',
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
      if (action === 'root-revive') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.emitStatusAction({
            kind: 'root',
            rootId,
            fromStatus: 'archived',
            toStatus: 'running',
          });
        }
        return;
      }
      if (action === 'root-delete') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.emitDeleteAction({ kind: 'root', rootId, fromStatus: 'archived' });
        }
        return;
      }
      if (action === 'dialog-open-external') {
        const dialogIds = this.resolveDialogLinkAction(actionEl);
        if (dialogIds) {
          this.emitDialogOpenExternal(dialogIds);
        }
        return;
      }
      if (action === 'dialog-share-link') {
        const dialogIds = this.resolveDialogLinkAction(actionEl);
        if (dialogIds) {
          this.emitDialogShareLink(dialogIds);
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
            detail: { rootId, status: 'archived' },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else {
      this.collapsedRoots.add(rootId);
      this.requestedSubdialogRoots.delete(rootId);
      this.dispatchEvent(
        new CustomEvent('dialog-collapse', {
          detail: { rootId, status: 'archived' },
          bubbles: true,
          composed: true,
        }),
      );
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

  private emitDeleteAction(detail: DialogDeleteAction): void {
    this.dispatchEvent(
      new CustomEvent('dialog-delete-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitDialogOpenExternal(detail: DialogLinkAction): void {
    this.dispatchEvent(
      new CustomEvent('dialog-open-external', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitDialogShareLink(detail: DialogLinkAction): void {
    this.dispatchEvent(
      new CustomEvent('dialog-share-link', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private resolveDialogLinkAction(actionEl: HTMLElement): DialogLinkAction | null {
    const rootId = (actionEl.getAttribute('data-root-id') ?? '').trim();
    if (rootId === '') return null;
    const selfRaw = (actionEl.getAttribute('data-self-id') ?? '').trim();
    const selfId = selfRaw === '' ? rootId : selfRaw;
    return { rootId, selfId };
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
      status: 'archived',
      supdialogId: dialog.supdialogId,
      sessionSlug: dialog.sessionSlug,
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

      .archived-dialog-list {
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

      .dialog-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dialog-meta-right {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex: none;
        white-space: nowrap;
      }

      .dialog-count {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--dominds-border, #e0e0e0);
        color: var(--dominds-muted, #666666);
        flex: none;
      }

      .dialog-submeta {
        justify-content: flex-end;
      }

      .dialog-subrow {
        font-size: 13px;
      }

      .dialog-status {
        font-size: 11px;
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
      }

      .dialog-time {
        font-size: 11px;
        color: var(--dominds-muted, #888888);
      }

      .dialog-topic {
        font-size: 11px;
        color: var(--dominds-muted, #888888);
      }

      .empty {
        padding: 16px;
        font-size: 13px;
        color: var(--dominds-muted, #666666);
      }
    `;
  }
}

if (!customElements.get('archived-dialog-list')) {
  customElements.define('archived-dialog-list', ArchivedDialogList);
}
