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

type SelectionState =
  | { kind: 'none' }
  | { kind: 'selected'; rootId: string; selfId: string; isRoot: boolean };

type DialogDomEntry = {
  key: string;
  rootId: string;
  selfId: string;
  el: HTMLElement;
};

export class ArchivedDialogList extends HTMLElement {
  private props: ArchivedDialogListProps = {
    uiLanguage: 'en',
    loading: false,
  };
  private selectionState: SelectionState = { kind: 'none' };
  private selectedKey: string | null = null;
  private listEl: HTMLElement | null = null;
  private dialogIndex: Map<string, DialogDomEntry> = new Map();
  private collapsedTasks: Set<string> = new Set();
  private collapsedRoots: Set<string> = new Set();
  private knownRootIds: Set<string> = new Set();
  // Request markers only; this is not a data cache.
  private requestedSubdialogRoots: Set<string> = new Set();
  private snapshotDialogs: ApiRootDialogResponse[] = [];
  private snapshotGroups: TaskGroup[] = [];
  private visibleRootCountByTask: Map<string, number> = new Map();
  private visibleSubdialogCountByRoot: Map<string, number> = new Map();
  private static readonly SHOW_MORE_STEP = 5;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  public setProps(props: Partial<ArchivedDialogListProps>): void {
    const prevLanguage = this.props.uiLanguage;
    this.props = { ...this.props, ...props };
    if (this.props.loading) {
      this.renderLoading();
      return;
    }
    if (prevLanguage !== this.props.uiLanguage) {
      this.refreshFromDom();
    }
  }

  public setDialogs(dialogs: ApiRootDialogResponse[]): void {
    this.applySnapshot(dialogs);
  }

  public setCurrentDialog(dialog: DialogInfo): void {
    const isRoot = dialog.selfId === dialog.rootId;
    let match = this.findDialogByIds(dialog.rootId, dialog.selfId, isRoot);
    if (!match) {
      const didExpand = this.ensureDialogVisible(dialog.rootId, dialog.selfId, isRoot);
      if (didExpand) {
        this.applySnapshot(this.snapshotDialogs);
        match = this.findDialogByIds(dialog.rootId, dialog.selfId, isRoot);
      }
    }
    if (!match) {
      this.clearSelection();
      return;
    }
    this.applySelection(match);
  }

  public updateDialogEntry(
    rootId: string,
    selfId: string,
    patch: Partial<ApiRootDialogResponse>,
  ): boolean {
    if (!rootId) return false;
    const targetSelf = selfId || rootId;
    const targetKey = this.dialogKey(rootId, targetSelf);
    const cacheIndex = this.snapshotDialogs.findIndex(
      (dialog) => this.getDialogKey(dialog) === targetKey,
    );
    if (cacheIndex >= 0) {
      const cached = this.snapshotDialogs[cacheIndex];
      const nextCached: ApiRootDialogResponse = { ...cached, ...patch };
      nextCached.rootId = cached.rootId;
      nextCached.selfId = cached.selfId;
      this.snapshotDialogs[cacheIndex] = nextCached;
      this.snapshotGroups = this.buildGroups(this.snapshotDialogs);
    }
    if (this.dialogIndex.size === 0) {
      this.refreshFromDom();
    }
    const entry = this.dialogIndex.get(targetKey);
    if (!entry) return false;
    const existing = this.decodeDialogDataset(entry.el);
    if (!existing) return false;
    const next: ApiRootDialogResponse = { ...existing, ...patch };
    next.rootId = existing.rootId;
    next.selfId = existing.selfId;

    entry.el.dataset.dialogJson = this.encodeDialogDataset(next);
    if (patch.lastModified !== undefined) {
      const timeEl = entry.el.querySelector('.dialog-time');
      if (timeEl instanceof HTMLElement) {
        timeEl.textContent = next.lastModified || '';
      }
    }
    if (patch.subdialogCount !== undefined && targetSelf === rootId) {
      const countEl = entry.el.querySelector('.dialog-count');
      if (countEl instanceof HTMLElement) {
        countEl.textContent = String(
          typeof next.subdialogCount === 'number' ? next.subdialogCount : 0,
        );
      }
    }
    return true;
  }

  private getDialogDisplayCallsign(dialog: ApiRootDialogResponse): string {
    const assignment = dialog.assignmentFromSup;
    if (assignment?.callName === 'freshBootsReasoning') {
      return 'FBR';
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
    if (this.props.loading) {
      this.renderLoading();
      return;
    }
    this.refreshFromDom();
  }

  public applySnapshot(dialogs: ApiRootDialogResponse[]): void {
    if (!this.listEl) return;
    if (this.props.loading) {
      this.renderLoading();
      return;
    }

    const validated = this.validateDialogs(dialogs);
    this.snapshotDialogs = [...validated];
    const groups = this.buildGroups(validated);
    this.snapshotGroups = groups;
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
        this.visibleSubdialogCountByRoot.delete(existing);
      }
    }
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
    for (const taskPath of taskPaths) {
      if (!this.visibleRootCountByTask.has(taskPath)) {
        this.visibleRootCountByTask.set(taskPath, ArchivedDialogList.SHOW_MORE_STEP);
      }
    }
    for (const existing of Array.from(this.visibleRootCountByTask.keys())) {
      if (!taskPaths.has(existing)) {
        this.visibleRootCountByTask.delete(existing);
      }
    }
    for (const rootId of rootIds) {
      if (!this.visibleSubdialogCountByRoot.has(rootId)) {
        this.visibleSubdialogCountByRoot.set(rootId, ArchivedDialogList.SHOW_MORE_STEP);
      }
    }
    for (const existing of Array.from(this.visibleSubdialogCountByRoot.keys())) {
      if (!rootIds.has(existing)) {
        this.visibleSubdialogCountByRoot.delete(existing);
      }
    }

    if (this.selectedKey) {
      const [rootId, selfId] = this.splitDialogKey(this.selectedKey);
      if (rootId && selfId) {
        this.selectionState = {
          kind: 'selected',
          rootId,
          selfId,
          isRoot: rootId === selfId,
        };
      }
    }

    if (this.selectionState.kind === 'selected') {
      const hasSelection = validated.some((dialog) =>
        this.isSelectedDialog(dialog, this.selectionState),
      );
      if (!hasSelection) {
        this.clearSelection();
      } else {
        this.ensureDialogVisible(
          this.selectionState.rootId,
          this.selectionState.selfId,
          this.selectionState.isRoot,
        );
      }
    }

    const t = getUiStrings(this.props.uiLanguage);
    if (groups.length === 0) {
      this.listEl.innerHTML = `
        <div class="empty">${t.noArchivedDialogs}</div>
      `;
      this.refreshFromDom();
      return;
    }

    const html = groups
      .map((group) => {
        const taskCollapsed = this.collapsedTasks.has(group.taskDocPath);
        const taskToggle = this.renderToggleIcon(taskCollapsed);
        const visibleRootCount =
          this.visibleRootCountByTask.get(group.taskDocPath) ?? ArchivedDialogList.SHOW_MORE_STEP;
        const visibleRoots = group.roots.slice(0, visibleRootCount);
        const hiddenRootCount = Math.max(group.roots.length - visibleRoots.length, 0);
        const rootNodes = visibleRoots
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
            const visibleSubdialogCount =
              this.visibleSubdialogCountByRoot.get(rootGroup.rootId) ??
              ArchivedDialogList.SHOW_MORE_STEP;
            const visibleSubdialogs = rootGroup.subdialogs.slice(0, visibleSubdialogCount);
            const hiddenSubdialogCount = Math.max(
              rootGroup.subdialogs.length - visibleSubdialogs.length,
              0,
            );
            const subNodes = visibleSubdialogs
              .map((subdialog) => this.renderDialogRow(subdialog))
              .join('');
            const subShowMore =
              hiddenSubdialogCount > 0
                ? this.renderShowMoreButton({
                    action: 'show-more-subdialogs',
                    rootId: rootGroup.rootId,
                    hiddenCount: hiddenSubdialogCount,
                  })
                : '';
            const subCollapsed = taskCollapsed || rootCollapsed;
            return `
              <div class="rdlg-node" data-rdlg-root-id="${rootGroup.rootId}">
                ${rootRow}
                <div class="sdlg-children ${subCollapsed ? 'collapsed' : ''}">
                  ${subNodes}
                  ${subShowMore}
                </div>
              </div>
            `;
          })
          .join('');
        const rootShowMore =
          hiddenRootCount > 0
            ? this.renderShowMoreButton({
                action: 'show-more-roots',
                taskDocPath: group.taskDocPath,
                hiddenCount: hiddenRootCount,
              })
            : '';
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
            <div class="task-rows ${taskCollapsed ? 'collapsed' : ''}">
              ${rootNodes}
              ${rootShowMore}
            </div>
          </div>
        `;
      })
      .join('');
    this.listEl.innerHTML = html;
    this.refreshFromDom();
  }

  private renderLoading(): void {
    if (!this.listEl) return;
    const t = getUiStrings(this.props.uiLanguage);
    this.listEl.innerHTML = `
      <div class="empty">${t.loading}</div>
    `;
    this.dialogIndex.clear();
  }

  private encodeDialogDataset(dialog: ApiRootDialogResponse): string {
    return encodeURIComponent(JSON.stringify(dialog));
  }

  private decodeDialogDataset(el: HTMLElement): ApiRootDialogResponse | null {
    const raw = el.dataset.dialogJson;
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw)) as ApiRootDialogResponse;
    } catch {
      return null;
    }
  }

  private refreshFromDom(): void {
    if (!this.listEl) return;
    this.dialogIndex.clear();
    const items = this.listEl.querySelectorAll<HTMLElement>('.dialog-item[data-root-id]');
    items.forEach((el) => {
      if (!el.dataset.dialogJson) return;
      const rootId = (el.getAttribute('data-root-id') ?? '').trim();
      if (!rootId) return;
      const selfRaw = (el.getAttribute('data-self-id') ?? '').trim();
      const selfId = selfRaw === '' ? rootId : selfRaw;
      const key = this.dialogKey(rootId, selfId);
      this.dialogIndex.set(key, { key, rootId, selfId, el });
    });

    if (this.listEl) {
      this.listEl
        .querySelectorAll<HTMLElement>('.dialog-item.selected')
        .forEach((node) => node.classList.remove('selected'));
    }

    if (this.selectedKey && this.dialogIndex.has(this.selectedKey)) {
      const entry = this.dialogIndex.get(this.selectedKey);
      if (entry) {
        entry.el.classList.add('selected');
        this.selectionState = {
          kind: 'selected',
          rootId: entry.rootId,
          selfId: entry.selfId,
          isRoot: entry.selfId === entry.rootId,
        };
      }
    } else if (this.selectedKey) {
      this.clearSelection();
    }
  }

  private clearSelection(): void {
    if (this.listEl) {
      const selected = this.listEl.querySelector('.dialog-item.selected');
      selected?.classList.remove('selected');
    }
    this.selectionState = { kind: 'none' };
    this.selectedKey = null;
  }

  private splitDialogKey(key: string): [string, string] {
    const idx = key.indexOf('#');
    if (idx < 0) return [key, key];
    return [key.slice(0, idx), key.slice(idx + 1) || key.slice(0, idx)];
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

  private renderShowMoreIcon(): string {
    return `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <polyline points="6 8 12 14 18 8"></polyline>
        <polyline points="6 13 12 19 18 13"></polyline>
      </svg>
    `;
  }

  private renderShowMoreButton(args: {
    action: 'show-more-roots' | 'show-more-subdialogs';
    hiddenCount: number;
    taskDocPath?: string;
    rootId?: string;
  }): string {
    const actionAttrs =
      args.action === 'show-more-roots'
        ? `data-task-path="${args.taskDocPath ?? ''}"`
        : `data-root-id="${args.rootId ?? ''}"`;
    return `
      <div class="show-more-row">
        <button
          class="action icon-button show-more-button"
          data-action="${args.action}"
          ${actionAttrs}
          type="button"
          aria-label="Show ${String(args.hiddenCount)} more"
          title="Show ${String(args.hiddenCount)} more"
        >
          ${this.renderShowMoreIcon()}
        </button>
      </div>
    `;
  }

  private renderRootRow(
    dialog: ApiRootDialogResponse,
    toggleIcon: string,
    subdialogCount: number,
  ): string {
    const t = getUiStrings(this.props.uiLanguage);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const dialogId = dialog.rootId;
    const updatedAt = dialog.lastModified || '';
    const dialogKey = this.getDialogKey(dialog);
    const dialogJson = this.encodeDialogDataset(dialog);

    return `
      <div
        class="dialog-item root-dialog${isSelected ? ' selected' : ''}"
        data-root-id="${dialog.rootId}"
        data-self-id=""
        data-dialog-key="${dialogKey}"
        data-dialog-json="${dialogJson}"
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
    const t = getUiStrings(this.props.uiLanguage);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const updatedAt = dialog.lastModified || '';
    const sessionSlugMark = dialog.sessionSlug ?? '';
    const callsign = this.getDialogDisplayCallsign(dialog);
    const dialogKey = this.getDialogKey(dialog);
    const dialogJson = this.encodeDialogDataset(dialog);

    return `
      <div
        class="dialog-item sub-dialog sdlg-node${isSelected ? ' selected' : ''}"
        data-root-id="${dialog.rootId}"
        data-self-id="${dialog.selfId ?? ''}"
        data-dialog-key="${dialogKey}"
        data-dialog-json="${dialogJson}"
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
      if (action === 'show-more-roots') {
        const taskPath = actionEl.getAttribute('data-task-path');
        if (taskPath) {
          this.showMoreRoots(taskPath);
        }
        return;
      }
      if (action === 'show-more-subdialogs') {
        const rootId = actionEl.getAttribute('data-root-id');
        if (rootId) {
          this.showMoreSubdialogs(rootId);
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
          const rootEl = this.findDialogElement(rootId, rootId);
          const rootDialog = rootEl ? this.decodeDialogDataset(rootEl) : null;
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
    const key = this.getDialogKey(dialog);
    this.selectionState = {
      kind: 'selected',
      rootId: dialog.rootId,
      selfId: dialog.selfId ?? dialog.rootId,
      isRoot,
    };
    this.selectedKey = key;
    this.collapsedTasks.delete(dialog.taskDocPath);
    this.collapsedRoots.delete(dialog.rootId);
    if (this.listEl) {
      const selected = this.listEl.querySelector('.dialog-item.selected');
      if (selected instanceof HTMLElement) {
        selected.classList.remove('selected');
      }
      if (this.dialogIndex.size === 0) {
        this.refreshFromDom();
      }
      const entry = this.dialogIndex.get(key);
      entry?.el.classList.add('selected');

      const taskTitle = this.listEl.querySelector(
        `.task-title[data-task-path="${this.escapeSelector(dialog.taskDocPath)}"]`,
      );
      const taskGroup = taskTitle?.closest('.task-group');
      const taskRows = taskGroup?.querySelector('.task-rows');
      if (taskRows instanceof HTMLElement) {
        taskRows.classList.remove('collapsed');
      }
      const rootChildren = this.listEl.querySelector(
        `.rdlg-node[data-rdlg-root-id="${this.escapeSelector(dialog.rootId)}"] > .sdlg-children`,
      );
      if (rootChildren instanceof HTMLElement) {
        rootChildren.classList.remove('collapsed');
      }
    }
  }

  private findDialogByIds(
    rootId: string,
    selfId: string,
    isRoot: boolean,
  ): ApiRootDialogResponse | undefined {
    const targetSelf = isRoot ? rootId : selfId;
    const el = this.findDialogElement(rootId, targetSelf);
    if (!el) return undefined;
    return this.decodeDialogDataset(el) ?? undefined;
  }

  private isSelectedDialog(dialog: ApiRootDialogResponse, selection: SelectionState): boolean {
    if (selection.kind !== 'selected') return false;
    if (selection.rootId !== dialog.rootId) return false;
    if (selection.isRoot) {
      return !dialog.selfId;
    }
    return dialog.selfId === selection.selfId;
  }

  private ensureDialogVisible(rootId: string, selfId: string, isRoot: boolean): boolean {
    if (this.snapshotGroups.length === 0) return false;
    let changed = false;
    for (const group of this.snapshotGroups) {
      const rootIndex = group.roots.findIndex((root) => root.rootId === rootId);
      if (rootIndex < 0) continue;
      const currentTaskLimit =
        this.visibleRootCountByTask.get(group.taskDocPath) ?? ArchivedDialogList.SHOW_MORE_STEP;
      if (currentTaskLimit < rootIndex + 1) {
        this.visibleRootCountByTask.set(group.taskDocPath, rootIndex + 1);
        changed = true;
      }
      if (!isRoot) {
        const rootGroup = group.roots[rootIndex];
        const subIndex = rootGroup.subdialogs.findIndex((sub) => sub.selfId === selfId);
        if (subIndex >= 0) {
          const currentSubLimit =
            this.visibleSubdialogCountByRoot.get(rootId) ?? ArchivedDialogList.SHOW_MORE_STEP;
          if (currentSubLimit < subIndex + 1) {
            this.visibleSubdialogCountByRoot.set(rootId, subIndex + 1);
            changed = true;
          }
        }
      }
      break;
    }
    return changed;
  }

  private showMoreRoots(taskDocPath: string): void {
    const current =
      this.visibleRootCountByTask.get(taskDocPath) ?? ArchivedDialogList.SHOW_MORE_STEP;
    this.visibleRootCountByTask.set(taskDocPath, current + ArchivedDialogList.SHOW_MORE_STEP);
    this.applySnapshot(this.snapshotDialogs);
  }

  private showMoreSubdialogs(rootId: string): void {
    const current =
      this.visibleSubdialogCountByRoot.get(rootId) ?? ArchivedDialogList.SHOW_MORE_STEP;
    this.visibleSubdialogCountByRoot.set(rootId, current + ArchivedDialogList.SHOW_MORE_STEP);
    this.applySnapshot(this.snapshotDialogs);
  }

  private toggleTask(taskPath: string): void {
    if (this.collapsedTasks.has(taskPath)) {
      this.collapsedTasks.delete(taskPath);
    } else {
      this.collapsedTasks.add(taskPath);
    }
    if (!this.listEl) return;
    const title = this.listEl.querySelector(
      `.task-title[data-task-path="${this.escapeSelector(taskPath)}"]`,
    );
    const taskGroup = title?.closest('.task-group');
    const taskRows = taskGroup?.querySelector('.task-rows');
    if (taskRows instanceof HTMLElement) {
      taskRows.classList.toggle('collapsed', this.collapsedTasks.has(taskPath));
    }
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
    if (this.listEl) {
      const rootChildren = this.listEl.querySelector(
        `.rdlg-node[data-rdlg-root-id="${this.escapeSelector(rootId)}"] > .sdlg-children`,
      );
      if (rootChildren instanceof HTMLElement) {
        rootChildren.classList.toggle('collapsed', this.collapsedRoots.has(rootId));
      }
    }
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
    if (this.dialogIndex.size === 0) {
      this.refreshFromDom();
    }
    for (const entry of this.dialogIndex.values()) {
      if (entry.rootId === rootId && entry.selfId !== rootId) return true;
    }
    return false;
  }

  private findDialogElement(rootId: string, selfId: string): HTMLElement | null {
    if (!this.listEl) return null;
    const rootEscaped = this.escapeSelector(rootId);
    const selfValue = selfId === rootId ? '' : selfId;
    const selfEscaped = this.escapeSelector(selfValue);
    return this.listEl.querySelector(
      `.dialog-item[data-root-id="${rootEscaped}"][data-self-id="${selfEscaped}"]`,
    );
  }

  private escapeSelector(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/"/g, '\\"');
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
    return `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        width: 100%;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: var(--dominds-fg, #333333);
        background: var(--dominds-sidebar-bg, #ffffff);
      }

      .archived-dialog-list {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow-y: auto;
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
        padding: 3px 5px;
        font-size: var(--dominds-font-size-sm, 12px);
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

      .show-more-row {
        display: flex;
        justify-content: center;
        padding: 4px 0 8px;
      }

      .show-more-button {
        color: var(--dominds-muted, #666666);
      }

      .dialog-item {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 2px 8px;
        cursor: pointer;
      }

      .root-dialog {
        padding-left: 8px;
        gap: 0;
        border-top: 1px solid var(--dominds-border, #e0e0e0);
      }

      .sdlg-node {
        gap: 0;
      }

      .sub-dialog {
        padding-left: 20px;
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
        margin-right: 4px;
        color: var(--dominds-muted, #666666);
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
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
        padding: 1px;
        margin: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--dominds-muted, #666666);
      }

      .icon-button svg {
        width: 11px;
        height: 11px;
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
        gap: 6px;
        font-size: var(--dominds-font-size-md, 13px);
        font-weight: 600;
      }

      .dialog-title {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dialog-meta-right {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: none;
        white-space: nowrap;
      }

      .dialog-count {
        font-size: var(--dominds-font-size-xs, 11px);
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
        font-size: var(--dominds-font-size-md, 13px);
      }

      .dialog-status {
        font-size: var(--dominds-font-size-xs, 11px);
        color: var(--dominds-muted, #666666);
        letter-spacing: 0.02em;
      }

      .dialog-time {
        font-size: var(--dominds-font-size-xs, 11px);
        color: var(--dominds-muted, #888888);
      }

      .dialog-topic {
        font-size: var(--dominds-font-size-xs, 11px);
        color: var(--dominds-muted, #888888);
      }

      .empty {
        padding: 12px;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, #666666);
      }
    `;
  }
}

if (!customElements.get('archived-dialog-list')) {
  customElements.define('archived-dialog-list', ArchivedDialogList);
}
