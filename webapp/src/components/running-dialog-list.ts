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
  maxHeight?: string;
  onSelect?: (dialog: DialogInfo) => void;
  uiLanguage: LanguageCode;
  loading: boolean;
}

export type DialogCreateAction =
  | { kind: 'task'; taskDocPath: string }
  | { kind: 'root'; rootId: string; taskDocPath: string; agentId: string };

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

export class RunningDialogList extends HTMLElement {
  private props: RunningDialogListProps = {
    maxHeight: 'none',
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
  private generatingKeys: Set<string> = new Set();
  private static readonly SHOW_MORE_STEP = 5;
  private static readonly RUN_STATE_CLASSES = [
    'state-proceeding',
    'state-proceeding-stop',
    'state-interrupted',
    'state-blocked-q4h',
    'state-blocked-subdialogs',
    'state-blocked-both',
  ];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
  }

  public setProps(props: Partial<RunningDialogListProps>): void {
    const prevLanguage = this.props.uiLanguage;
    this.props = { ...this.props, ...props };
    if (this.props.loading) {
      this.renderLoading();
      return;
    }
    if (prevLanguage !== this.props.uiLanguage || props.maxHeight) {
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

  public getSelectedDialogId(): string | null {
    if (this.selectionState.kind !== 'selected') return null;
    return this.selectionState.rootId;
  }

  public findDialogByRootId(rootId: string): ApiRootDialogResponse | undefined {
    if (this.dialogIndex.size === 0) {
      this.refreshFromDom();
    }
    const rootKey = this.dialogKey(rootId, rootId);
    const entry = this.dialogIndex.get(rootKey);
    const el = entry?.el;
    if (!el) return undefined;
    return this.decodeDialogDataset(el) ?? undefined;
  }

  public findSubdialog(rootId: string, selfId: string): ApiRootDialogResponse | undefined {
    if (this.dialogIndex.size === 0) {
      this.refreshFromDom();
    }
    const key = this.dialogKey(rootId, selfId);
    const entry = this.dialogIndex.get(key);
    const el = entry?.el;
    if (!el) return undefined;
    return this.decodeDialogDataset(el) ?? undefined;
  }

  public selectDialogById(rootId: string): boolean {
    const dialog = this.findDialogByRootId(rootId);
    if (!dialog) return false;
    this.applySelection(dialog);
    this.notifySelection(dialog);
    return true;
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
    const key = targetKey;
    const entry = this.dialogIndex.get(key);
    if (!entry) return false;
    const existing = this.decodeDialogDataset(entry.el);
    if (!existing) return false;
    const next: ApiRootDialogResponse = { ...existing, ...patch };
    next.rootId = existing.rootId;
    next.selfId = existing.selfId;

    entry.el.dataset.dialogJson = this.encodeDialogDataset(next);
    if (patch.runState !== undefined) {
      this.updateRunStateForEntry(entry.el, next);
    }
    if (patch.lastModified !== undefined) {
      const timeEl = entry.el.querySelector('.dialog-time');
      if (timeEl instanceof HTMLElement) {
        timeEl.textContent = next.lastModified || '';
      }
      if (targetSelf === rootId) {
        this.reorderVisibleRoots(next.taskDocPath);
      } else {
        this.reorderVisibleSubdialogs(rootId);
        const rootDialog = this.findDialogByRootId(rootId);
        if (rootDialog) {
          this.reorderVisibleRoots(rootDialog.taskDocPath);
        }
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

  private isGenerating(dialog: ApiRootDialogResponse): boolean {
    const key = this.getDialogKey(dialog);
    return this.generatingKeys.has(key);
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

  private updateRunStateForEntry(el: HTMLElement, dialog: ApiRootDialogResponse): void {
    for (const cls of RunningDialogList.RUN_STATE_CLASSES) {
      el.classList.remove(cls);
    }
    const suffix = runStateClassSuffixFromRunState(dialog.runState);
    if (suffix) {
      el.classList.add(suffix);
    }
    el.classList.toggle('gen-active', this.isGenerating(dialog));

    const badgesHtml = this.renderRunBadges(dialog);
    const meta = el.querySelector('.dialog-meta-right');
    if (!(meta instanceof HTMLElement)) return;
    const existing = meta.querySelector('.run-badges') as HTMLElement | null;
    if (badgesHtml === '') {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.outerHTML !== badgesHtml) {
        existing.outerHTML = badgesHtml;
      }
      return;
    }
    meta.insertAdjacentHTML('afterbegin', badgesHtml);
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
        this.visibleRootCountByTask.set(taskPath, RunningDialogList.SHOW_MORE_STEP);
      }
    }
    for (const existing of Array.from(this.visibleRootCountByTask.keys())) {
      if (!taskPaths.has(existing)) {
        this.visibleRootCountByTask.delete(existing);
      }
    }
    for (const rootId of rootIds) {
      if (!this.visibleSubdialogCountByRoot.has(rootId)) {
        this.visibleSubdialogCountByRoot.set(rootId, RunningDialogList.SHOW_MORE_STEP);
      }
    }
    for (const existing of Array.from(this.visibleSubdialogCountByRoot.keys())) {
      if (!rootIds.has(existing)) {
        this.visibleSubdialogCountByRoot.delete(existing);
      }
    }

    const selection = this.selectionState;
    if (selection.kind === 'selected') {
      const hasSelection = validated.some((dialog) => this.isSelectedDialog(dialog, selection));
      if (!hasSelection) {
        this.clearSelection();
      } else {
        this.ensureDialogVisible(selection.rootId, selection.selfId, selection.isRoot);
      }
    }

    const t = getUiStrings(this.props.uiLanguage);
    if (groups.length === 0) {
      this.listEl.innerHTML = `
        <div class="empty">${t.noDialogsYet}</div>
      `;
      this.refreshFromDom();
      return;
    }

    const html = groups
      .map((group) => {
        const taskCollapsed = this.collapsedTasks.has(group.taskDocPath);
        const taskToggle = this.renderToggleIcon(taskCollapsed);
        const visibleRootCount =
          this.visibleRootCountByTask.get(group.taskDocPath) ?? RunningDialogList.SHOW_MORE_STEP;
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
              RunningDialogList.SHOW_MORE_STEP;
            const visibleSubdialogs = rootGroup.subdialogs.slice(0, visibleSubdialogCount);
            const hiddenSubdialogCount = Math.max(
              rootGroup.subdialogs.length - visibleSubdialogs.length,
              0,
            );
            const subNodes = visibleSubdialogs
              .map((subdialog) => this.renderDialogRow(subdialog, 'sub'))
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
                <button class="action icon-button" data-action="task-mark-done" data-task-path="${group.taskDocPath}" type="button" title="${t.dialogActionMarkAllDone}" aria-label="${t.dialogActionMarkAllDone}">
                  ${this.renderDoneIcon()}
                </button>
                <button class="action icon-button" data-action="task-archive" data-task-path="${group.taskDocPath}" type="button" title="${t.dialogActionArchiveAll}" aria-label="${t.dialogActionArchiveAll}">
                  ${this.renderArchiveIcon()}
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

  public setGeneratingKeys(keys: ReadonlySet<string>): void {
    this.generatingKeys = new Set(keys);
    this.refreshGeneratingBadges();
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

    const selectedRootId =
      this.selectionState.kind === 'selected' ? this.selectionState.rootId : undefined;
    this.applyIntensityDim(selectedRootId);
    this.refreshGeneratingBadges();
  }

  private applyIntensityDim(selectedRootId?: string): void {
    this.dialogIndex.forEach((entry) => {
      const shouldDim = !!selectedRootId && entry.rootId !== selectedRootId;
      entry.el.classList.toggle('other-root-glow', shouldDim);
    });
  }

  private getDialogUpdatedAtMsFromElement(el: HTMLElement): number {
    const dialog = this.decodeDialogDataset(el);
    if (!dialog) return 0;
    return this.parseTimestamp(dialog.lastModified);
  }

  private reorderVisibleSubdialogs(rootId: string): void {
    if (!this.listEl) return;
    const rootChildren = this.listEl.querySelector(
      `.rdlg-node[data-rdlg-root-id="${this.escapeSelector(rootId)}"] > .sdlg-children`,
    );
    if (!(rootChildren instanceof HTMLElement)) return;
    const subRows = Array.from(
      rootChildren.querySelectorAll<HTMLElement>(':scope > .dialog-item.sub-dialog'),
    );
    if (subRows.length <= 1) return;
    subRows.sort((a, b) => {
      const delta =
        this.getDialogUpdatedAtMsFromElement(b) - this.getDialogUpdatedAtMsFromElement(a);
      if (delta !== 0) return delta;
      const aSelf = a.getAttribute('data-self-id') ?? '';
      const bSelf = b.getAttribute('data-self-id') ?? '';
      return aSelf.localeCompare(bSelf);
    });
    const anchor = rootChildren.querySelector(':scope > .show-more-row');
    for (const row of subRows) {
      rootChildren.insertBefore(row, anchor);
    }
  }

  private reorderVisibleRoots(taskDocPath: string): void {
    if (!this.listEl) return;
    const taskTitle = this.listEl.querySelector(
      `.task-title[data-task-path="${this.escapeSelector(taskDocPath)}"]`,
    );
    const taskGroup = taskTitle?.closest('.task-group');
    if (!(taskGroup instanceof HTMLElement)) return;
    const taskRows = taskGroup.querySelector('.task-rows');
    if (!(taskRows instanceof HTMLElement)) return;
    const rootNodes = Array.from(taskRows.querySelectorAll<HTMLElement>(':scope > .rdlg-node'));
    if (rootNodes.length <= 1) return;
    rootNodes.sort((a, b) => {
      const aRoot = a.querySelector<HTMLElement>(':scope > .dialog-item.root-dialog');
      const bRoot = b.querySelector<HTMLElement>(':scope > .dialog-item.root-dialog');
      const delta =
        (bRoot ? this.getDialogUpdatedAtMsFromElement(bRoot) : 0) -
        (aRoot ? this.getDialogUpdatedAtMsFromElement(aRoot) : 0);
      if (delta !== 0) return delta;
      const aRootId = (a.getAttribute('data-rdlg-root-id') ?? '').trim();
      const bRootId = (b.getAttribute('data-rdlg-root-id') ?? '').trim();
      return aRootId.localeCompare(bRootId);
    });
    const anchor = taskRows.querySelector(':scope > .show-more-row');
    for (const node of rootNodes) {
      taskRows.insertBefore(node, anchor);
    }
    this.reorderTaskGroups();
  }

  private reorderTaskGroups(): void {
    if (!this.listEl) return;
    const groups = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(':scope > .task-group.task-node'),
    );
    if (groups.length <= 1) return;
    groups.sort((a, b) => {
      const aTs = this.getTaskMaxUpdatedAtMs(a);
      const bTs = this.getTaskMaxUpdatedAtMs(b);
      const delta = bTs - aTs;
      if (delta !== 0) return delta;
      const aPath = (a.querySelector('.task-title')?.getAttribute('data-task-path') ?? '').trim();
      const bPath = (b.querySelector('.task-title')?.getAttribute('data-task-path') ?? '').trim();
      return aPath.localeCompare(bPath);
    });
    for (const group of groups) {
      this.listEl.appendChild(group);
    }
    this.refreshFromDom();
  }

  private getTaskMaxUpdatedAtMs(taskGroup: HTMLElement): number {
    let max = 0;
    const roots = taskGroup.querySelectorAll<HTMLElement>(
      '.dialog-item.root-dialog[data-dialog-json]',
    );
    roots.forEach((row) => {
      const ts = this.getDialogUpdatedAtMsFromElement(row);
      if (ts > max) max = ts;
    });
    return max;
  }

  private refreshGeneratingBadges(): void {
    const t = getUiStrings(this.props.uiLanguage);
    this.dialogIndex.forEach((entry) => {
      const isGenerating = this.generatingKeys.has(entry.key);
      entry.el.classList.toggle('gen-active', isGenerating);
      const badges = entry.el.querySelector('.run-badges') as HTMLElement | null;
      const existing = badges?.querySelector('.run-badge.generating');
      if (isGenerating) {
        if (!existing) {
          const badgeHtml = `<span class="run-badge generating" title="${t.runBadgeGeneratingTitle}">GEN</span>`;
          if (badges) {
            badges.insertAdjacentHTML('beforeend', badgeHtml);
          } else {
            const meta = entry.el.querySelector('.dialog-meta-right');
            if (meta) {
              meta.insertAdjacentHTML('afterbegin', `<span class="run-badges">${badgeHtml}</span>`);
            }
          }
        }
      } else if (existing) {
        existing.remove();
        const parent = badges ?? existing.parentElement;
        if (parent instanceof HTMLElement && parent.classList.contains('run-badges')) {
          if (parent.querySelector('.run-badge') === null) {
            parent.remove();
          }
        }
      }
    });
  }

  private clearSelection(): void {
    if (this.listEl) {
      const selected = this.listEl.querySelector('.dialog-item.selected');
      selected?.classList.remove('selected');
    }
    this.selectionState = { kind: 'none' };
    this.selectedKey = null;
    this.applyIntensityDim(undefined);
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
    const isGenerating = this.isGenerating(dialog);
    const runStateClass = this.getRunStateClass(dialog);
    const badges = this.renderRunBadges(dialog);
    const dialogId = dialog.rootId;
    const updatedAt = dialog.lastModified || '';
    const dialogKey = this.getDialogKey(dialog);
    const dialogJson = this.encodeDialogDataset(dialog);

    return `
      <div
        class="dialog-item root-dialog${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
        data-root-id="${dialog.rootId}"
        data-self-id=""
        data-dialog-key="${dialogKey}"
        data-dialog-json="${dialogJson}"
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

  private renderDialogRow(dialog: ApiRootDialogResponse, kind: 'root' | 'sub'): string {
    const t = getUiStrings(this.props.uiLanguage);
    const isSelected = this.isSelectedDialog(dialog, this.selectionState);
    const isGenerating = this.isGenerating(dialog);
    const runStateClass = this.getRunStateClass(dialog);
    const badges = this.renderRunBadges(dialog);
    const dialogId =
      kind === 'sub' ? (dialog.selfId ?? '') : dialog.selfId ? dialog.selfId : dialog.rootId;
    const rowClass = kind === 'sub' ? 'dialog-item sub-dialog' : 'dialog-item root-dialog';
    const updatedAt = dialog.lastModified || '';
    const sessionSlugMark = dialog.sessionSlug ?? '';
    const dialogKey = this.getDialogKey(dialog);
    const dialogJson = this.encodeDialogDataset(dialog);

    if (kind === 'sub') {
      const callsign = this.getDialogDisplayCallsign(dialog);
      return `
        <div
          class="${rowClass} sdlg-node${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
          data-root-id="${dialog.rootId}"
          data-self-id="${dialog.selfId ?? ''}"
          data-dialog-key="${dialogKey}"
          data-dialog-json="${dialogJson}"
        >
          <div class="dialog-row dialog-subrow">
              <span class="dialog-title">${callsign}</span>
              <span class="dialog-meta-right">
                ${badges}
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

    return `
      <div
        class="${rowClass}${isSelected ? ' selected' : ''}${isGenerating ? ' gen-active' : ''}${runStateClass}"
        data-root-id="${dialog.rootId}"
        data-self-id="${dialog.selfId ?? ''}"
        data-dialog-key="${dialogKey}"
        data-dialog-json="${dialogJson}"
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
    this.applyIntensityDim(dialog.rootId);
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
        this.visibleRootCountByTask.get(group.taskDocPath) ?? RunningDialogList.SHOW_MORE_STEP;
      if (currentTaskLimit < rootIndex + 1) {
        this.visibleRootCountByTask.set(group.taskDocPath, rootIndex + 1);
        changed = true;
      }
      if (!isRoot) {
        const rootGroup = group.roots[rootIndex];
        const subIndex = rootGroup.subdialogs.findIndex((sub) => sub.selfId === selfId);
        if (subIndex >= 0) {
          const currentSubLimit =
            this.visibleSubdialogCountByRoot.get(rootId) ?? RunningDialogList.SHOW_MORE_STEP;
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
      this.visibleRootCountByTask.get(taskDocPath) ?? RunningDialogList.SHOW_MORE_STEP;
    this.visibleRootCountByTask.set(taskDocPath, current + RunningDialogList.SHOW_MORE_STEP);
    this.applySnapshot(this.snapshotDialogs);
  }

  private showMoreSubdialogs(rootId: string): void {
    const current =
      this.visibleSubdialogCountByRoot.get(rootId) ?? RunningDialogList.SHOW_MORE_STEP;
    this.visibleSubdialogCountByRoot.set(rootId, current + RunningDialogList.SHOW_MORE_STEP);
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
            detail: { rootId, status: 'running' },
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
          detail: { rootId, status: 'running' },
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
      status: 'running',
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

      .show-more-row {
        display: flex;
        justify-content: center;
        padding: 6px 0 10px;
      }

      .show-more-button {
        color: var(--dominds-muted, #666666);
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

      .dialog-item.other-root-glow.state-proceeding::after,
      .dialog-item.other-root-glow.gen-active::after {
        opacity: 0;
        animation: none;
      }

      .dialog-item.other-root-glow.state-proceeding::before,
      .dialog-item.other-root-glow.gen-active::before {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        border-radius: 8px;
        background:
          radial-gradient(
            ellipse at 50% 40%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 35%, transparent)
              0%,
            color-mix(in srgb, var(--dialog-glow-color, var(--dominds-primary, #007acc)) 18%, transparent)
              45%,
            transparent 75%
          );
        opacity: 0;
        filter: blur(6px);
        transform: scale(0.96);
        animation: dialogNodeGlowPulse 2.7s ease-in-out infinite;
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

      @keyframes dialogNodeGlowPulse {
        0% {
          opacity: 0;
          transform: scale(0.96);
        }
        50% {
          opacity: 0.8;
          transform: scale(1.06);
        }
        100% {
          opacity: 0;
          transform: scale(0.96);
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

        .dialog-item.other-root-glow.state-proceeding::before,
        .dialog-item.other-root-glow.gen-active::before {
          animation: none;
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
        font-weight: 500;
        flex: none;
        white-space: nowrap;
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
