import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  SnippetCatalogResponse,
  SnippetTemplateGroup as SnippetGroup,
  SnippetTemplate as SnippetItem,
} from '@longrun-ai/kernel/types/snippets';
import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import { dispatchDomindsEvent } from './dom-events';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; groups: SnippetGroup[]; selectedGroupKey: string }
  | { kind: 'error'; message: string };

type McpPromptPreviewState =
  | { kind: 'idle' }
  | { kind: 'loading'; promptId: string; seq: number }
  | { kind: 'ready'; promptId: string; seq: number }
  | { kind: 'blocked'; promptId: string; missingArgs: string[] }
  | { kind: 'error'; promptId: string; seq: number; message: string };

type McpPromptArg = NonNullable<NonNullable<SnippetItem['mcpPrompt']>['arguments']>[number];

export class DomindsSnippetsPanel extends HTMLElement {
  private uiLanguage: LanguageCode = 'en';
  private state: LoadState = { kind: 'idle' };
  private lastSelectedGroupKey: string | null = null;
  private selectedSnippetId: string | null = null;
  private selectedSnippetPath: string | null = null;
  private newGroupDraftTitle: string = '';
  private newGroupPendingFocus: boolean = false;
  private creatingGroup: boolean = false;
  private draftName: string = '';
  private draftFileName: string = '';
  private draftDescription: string = '';
  private draftContent: string = '';
  private selectedSnippetReadonly: boolean = false;
  private mcpPromptArgDrafts: Record<string, string> = {};
  private snippetScrollTops: Record<string, number> = {};
  private loadSeq: number = 0;
  private mcpPreviewSeq: number = 0;
  private mcpPreviewTimer: ReturnType<typeof window.setTimeout> | null = null;
  private mcpPreviewState: McpPromptPreviewState = { kind: 'idle' };

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    void this.load();
  }

  disconnectedCallback(): void {
    this.loadSeq += 1;
    this.mcpPreviewSeq += 1;
    this.clearMcpPreviewTimer();
  }

  public setUiLanguage(language: LanguageCode): void {
    if (this.uiLanguage === language) return;
    this.uiLanguage = language;
    void this.load();
  }

  private async load(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    const seq = this.loadSeq + 1;
    this.loadSeq = seq;
    this.clearMcpPreviewTimer();
    this.mcpPreviewSeq += 1;
    this.mcpPreviewState = { kind: 'idle' };
    this.state = { kind: 'loading' };
    this.render();
    try {
      const api = getApiClient();
      const catalogResp = await api.getSnippetCatalog(this.uiLanguage);
      if (this.loadSeq !== seq) return;

      if (!catalogResp.success && catalogResp.status === 401) {
        dispatchDomindsEvent(
          this,
          'ui-toast',
          { message: t.unauthorized, kind: 'warning' },
          { bubbles: true, composed: true },
        );
        dispatchDomindsEvent(this, 'auth-required', undefined, {
          bubbles: true,
          composed: true,
        });
      }

      if (!catalogResp.success || !catalogResp.data) {
        this.state = { kind: 'error', message: catalogResp.error ?? t.snippetsLoadFailed };
        this.render();
        return;
      }
      const payload: SnippetCatalogResponse = catalogResp.data;
      if (!payload.success) {
        this.state = { kind: 'error', message: payload.error };
        this.render();
        return;
      }
      const groups = Array.isArray(payload.groups) ? payload.groups : [];
      const fallbackKey = groups[0]?.key;
      const desiredKey =
        typeof this.lastSelectedGroupKey === 'string' &&
        groups.some((g) => g.key === this.lastSelectedGroupKey)
          ? this.lastSelectedGroupKey
          : fallbackKey;
      if (!desiredKey) {
        this.state = { kind: 'error', message: t.snippetsLoadFailed };
        this.render();
        return;
      }
      this.state = { kind: 'ready', groups, selectedGroupKey: desiredKey };
      this.reconcileSelectionAfterCatalogLoad();
      this.render();
      if (this.getSelectedSnippet()?.source === 'mcp_prompt') {
        void this.refreshMcpPromptPreview();
      }
    } catch (error: unknown) {
      if (this.loadSeq !== seq) return;
      this.state = {
        kind: 'error',
        message: error instanceof Error ? error.message : t.snippetsLoadFailed,
      };
      this.render();
    }
  }

  private reconcileSelectionAfterCatalogLoad(): void {
    if (this.selectedSnippetId === null) return;
    const selected = this.getSelectedSnippet();
    if (!selected) {
      this.clearSelectedSnippetDraft();
      return;
    }
    this.selectedSnippetPath = typeof selected.path === 'string' ? selected.path : null;
    this.selectedSnippetReadonly = selected.readonly === true || selected.source === 'mcp_prompt';
    this.draftName = selected.name;
    this.draftFileName = this.deriveFileNameForEditing(selected);
    this.draftDescription = typeof selected.description === 'string' ? selected.description : '';
    this.draftContent = selected.content;
    const promptArgs: Record<string, string> = {};
    for (const arg of selected.mcpPrompt?.arguments ?? []) {
      promptArgs[arg.name] = this.mcpPromptArgDrafts[arg.name] ?? '';
    }
    this.mcpPromptArgDrafts = promptArgs;
    this.mcpPreviewState = { kind: 'idle' };
  }

  private clearMcpPreviewTimer(): void {
    if (this.mcpPreviewTimer === null) return;
    window.clearTimeout(this.mcpPreviewTimer);
    this.mcpPreviewTimer = null;
  }

  private clearSelectedSnippetDraft(): void {
    this.clearMcpPreviewTimer();
    this.mcpPreviewSeq += 1;
    this.selectedSnippetId = null;
    this.selectedSnippetPath = null;
    this.draftName = '';
    this.draftFileName = '';
    this.draftDescription = '';
    this.draftContent = '';
    this.selectedSnippetReadonly = false;
    this.mcpPromptArgDrafts = {};
    this.mcpPreviewState = { kind: 'idle' };
  }

  private emitInsertContent(content: string): void {
    const normalized = typeof content === 'string' ? content : '';
    if (normalized.trim() === '') return;
    dispatchDomindsEvent(
      this,
      'snippet-insert',
      { content: normalized },
      {
        bubbles: true,
        composed: true,
      },
    );
  }

  private getSelectedSnippet(): SnippetItem | null {
    if (this.state.kind !== 'ready' || this.selectedSnippetId === null) return null;
    const all = this.state.groups.flatMap((g) => g.templates);
    return all.find((snippet) => snippet.id === this.selectedSnippetId) ?? null;
  }

  private async insertSelectedSnippet(): Promise<void> {
    const selected = this.getSelectedSnippet();
    if (selected?.source !== 'mcp_prompt' || !selected.mcpPrompt) {
      this.emitInsertContent(this.draftContent);
      return;
    }
    const args = this.buildMcpPromptArgumentPayload(selected);
    if (args.kind === 'blocked') {
      this.mcpPreviewState = {
        kind: 'blocked',
        promptId: selected.mcpPrompt.promptId,
        missingArgs: args.missingArgs,
      };
      this.draftContent = this.renderMcpPromptBlockedPreview(selected, args.missingArgs);
      this.patchPreviewDom();
      return;
    }
    try {
      const api = getApiClient();
      const resp = await api.renderMcpPromptSnippet({
        promptId: selected.mcpPrompt.promptId,
        arguments: args.arguments,
      });
      if (!resp.success || !resp.data) {
        const message = resp.error ?? getUiStrings(this.uiLanguage).snippetsLoadFailed;
        throw new Error(message);
      }
      if (!resp.data.success) {
        const message = resp.data.error;
        throw new Error(message);
      }
      this.emitInsertContent(resp.data.content);
    } catch (error: unknown) {
      dispatchDomindsEvent(
        this,
        'ui-toast',
        {
          message:
            error instanceof Error
              ? error.message
              : getUiStrings(this.uiLanguage).snippetsLoadFailed,
          kind: 'error',
        },
        { bubbles: true, composed: true },
      );
    }
  }

  private buildMcpPromptArgumentPayload(
    snippet: SnippetItem,
  ):
    | { kind: 'ready'; arguments: Record<string, string> }
    | { kind: 'blocked'; missingArgs: string[] } {
    const promptArguments: Record<string, string> = {};
    const missingArgs: string[] = [];
    for (const arg of snippet.mcpPrompt?.arguments ?? []) {
      const value = this.mcpPromptArgDrafts[arg.name]?.trim() ?? '';
      if (value === '') {
        if (arg.required) missingArgs.push(arg.name);
        continue;
      }
      promptArguments[arg.name] = value;
    }
    if (missingArgs.length > 0) return { kind: 'blocked', missingArgs };
    return { kind: 'ready', arguments: promptArguments };
  }

  private renderMcpPromptBlockedPreview(snippet: SnippetItem, missingArgs: string[]): string {
    const t = getUiStrings(this.uiLanguage);
    const parts: string[] = [];
    if (typeof snippet.description === 'string' && snippet.description.trim() !== '') {
      parts.push(`<!-- ${snippet.description.trim()} -->`);
    }
    parts.push(`${t.snippetsMcpPreviewMissingArgs} ${missingArgs.join(', ')}`);
    return parts.join('\n\n');
  }

  private renderMcpPromptLoadingPreview(snippet: SnippetItem): string {
    const t = getUiStrings(this.uiLanguage);
    const parts: string[] = [];
    if (typeof snippet.description === 'string' && snippet.description.trim() !== '') {
      parts.push(`<!-- ${snippet.description.trim()} -->`);
    }
    parts.push(t.snippetsMcpPreviewLoading);
    return parts.join('\n\n');
  }

  private renderMcpPromptErrorPreview(snippet: SnippetItem, message: string): string {
    const t = getUiStrings(this.uiLanguage);
    const parts: string[] = [];
    if (typeof snippet.description === 'string' && snippet.description.trim() !== '') {
      parts.push(`<!-- ${snippet.description.trim()} -->`);
    }
    parts.push(`${t.snippetsMcpPreviewFailed}: ${message}`);
    return parts.join('\n\n');
  }

  private scheduleMcpPromptPreview(): void {
    this.clearMcpPreviewTimer();
    this.mcpPreviewTimer = window.setTimeout(() => {
      this.mcpPreviewTimer = null;
      void this.refreshMcpPromptPreview();
    }, 250);
  }

  private async refreshMcpPromptPreview(): Promise<void> {
    const selected = this.getSelectedSnippet();
    if (selected?.source !== 'mcp_prompt' || !selected.mcpPrompt) {
      this.mcpPreviewState = { kind: 'idle' };
      return;
    }

    const promptId = selected.mcpPrompt.promptId;
    const seq = this.mcpPreviewSeq + 1;
    this.mcpPreviewSeq = seq;
    const args = this.buildMcpPromptArgumentPayload(selected);
    if (args.kind === 'blocked') {
      this.mcpPreviewState = { kind: 'blocked', promptId, missingArgs: args.missingArgs };
      this.draftContent = this.renderMcpPromptBlockedPreview(selected, args.missingArgs);
      this.patchPreviewDom();
      return;
    }

    this.mcpPreviewState = { kind: 'loading', promptId, seq };
    this.draftContent = this.renderMcpPromptLoadingPreview(selected);
    this.patchPreviewDom();

    try {
      const api = getApiClient();
      const resp = await api.renderMcpPromptSnippet({
        promptId,
        arguments: args.arguments,
      });
      if (!resp.success || !resp.data) {
        const message = resp.error ?? getUiStrings(this.uiLanguage).snippetsMcpPreviewFailed;
        throw new Error(message);
      }
      if (!resp.data.success) {
        throw new Error(resp.data.error);
      }
      if (this.selectedSnippetId !== selected.id || this.mcpPreviewSeq !== seq) return;
      this.mcpPreviewState = { kind: 'ready', promptId, seq };
      this.draftContent = resp.data.content;
      this.patchPreviewDom();
    } catch (error: unknown) {
      if (this.selectedSnippetId !== selected.id || this.mcpPreviewSeq !== seq) return;
      const message =
        error instanceof Error
          ? error.message
          : getUiStrings(this.uiLanguage).snippetsMcpPreviewFailed;
      this.mcpPreviewState = { kind: 'error', promptId, seq, message };
      this.draftContent = this.renderMcpPromptErrorPreview(selected, message);
      this.patchPreviewDom();
    }
  }

  private selectSnippet(snippet: SnippetItem | null): void {
    if (!snippet) {
      const previousSnippetId = this.selectedSnippetId;
      this.clearSelectedSnippetDraft();
      this.patchSelectedSnippetDom(previousSnippetId, null);
      this.patchEditorDom();
      return;
    }
    if (this.selectedSnippetId === snippet.id) return;

    this.clearMcpPreviewTimer();
    this.mcpPreviewSeq += 1;
    const previousSnippetId = this.selectedSnippetId;
    this.selectedSnippetId = snippet.id;
    this.selectedSnippetPath = typeof snippet.path === 'string' ? snippet.path : null;
    this.selectedSnippetReadonly = snippet.readonly === true || snippet.source === 'mcp_prompt';
    this.draftName = snippet.name;
    this.draftFileName = this.deriveFileNameForEditing(snippet);
    this.draftDescription = typeof snippet.description === 'string' ? snippet.description : '';
    this.draftContent = snippet.content;
    const promptArgs: Record<string, string> = {};
    for (const arg of snippet.mcpPrompt?.arguments ?? []) {
      promptArgs[arg.name] = '';
    }
    this.mcpPromptArgDrafts = promptArgs;
    this.mcpPreviewState = { kind: 'idle' };
    this.patchSelectedSnippetDom(previousSnippetId, snippet.id);
    this.patchEditorDom();
    if (snippet.source === 'mcp_prompt') {
      void this.refreshMcpPromptPreview();
    }
  }

  private deriveFileNameForEditing(snippet: SnippetItem): string {
    const p = typeof snippet.path === 'string' ? snippet.path : '';
    const rel = p.startsWith('.minds/snippets/')
      ? p.slice('.minds/snippets/'.length)
      : p.startsWith('snippets/')
        ? p.slice('snippets/'.length)
        : '';
    if (!rel) return '';

    const parts = rel.split('/').filter((x) => x !== '');
    if (parts.length < 1) return '';
    const base = parts[parts.length - 1] ?? '';
    if (!base) return '';
    const withoutMd = base.toLowerCase().endsWith('.md') ? base.slice(0, -'.md'.length) : base;
    if (withoutMd.endsWith('.zh')) return withoutMd.slice(0, -'.zh'.length);
    if (withoutMd.endsWith('.en')) return withoutMd.slice(0, -'.en'.length);
    return withoutMd;
  }

  private async saveNewSnippet(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    const name = this.draftName.trim();
    const fileName = this.draftFileName.trim();
    const description = this.draftDescription.trim();
    const content = this.draftContent;
    if (name === '' || content.trim() === '') return;
    if (this.state.kind !== 'ready') return;
    const groupKey = this.state.selectedGroupKey;

    try {
      const api = getApiClient();
      const resp = await api.saveRtwsSnippet({
        groupKey,
        fileName: fileName === '' ? undefined : fileName,
        uiLanguage: this.uiLanguage,
        name,
        description: description === '' ? undefined : description,
        content,
      });
      if (!resp.success || !resp.data) {
        throw new Error(resp.error ?? t.snippetsSaveFailed);
      }
      if (!resp.data.success) {
        throw new Error(resp.data.error);
      }
      this.clearSelectedSnippetDraft();
      await this.load();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t.snippetsSaveFailed;
      dispatchDomindsEvent(
        this,
        'ui-toast',
        { message: msg, kind: 'error' },
        {
          bubbles: true,
          composed: true,
        },
      );
    }
  }

  private onSelectGroup(key: string): void {
    const state = this.state;
    if (state.kind !== 'ready') return;
    if (key === state.selectedGroupKey) return;
    const previousKey = state.selectedGroupKey;
    this.captureSnippetScroll();
    this.lastSelectedGroupKey = key;
    this.state = { ...state, selectedGroupKey: key };
    this.clearSelectedSnippetDraft();
    this.patchSelectedGroupDom(previousKey, key);
    this.patchSnippetListDom();
    this.patchEditorDom();
  }

  private startCreateGroup(): void {
    if (this.creatingGroup) return;
    this.creatingGroup = true;
    this.newGroupDraftTitle = '';
    this.newGroupPendingFocus = true;
    this.patchCreateGroupInputDom();
  }

  private cancelCreateGroup(): void {
    if (!this.creatingGroup) return;
    this.creatingGroup = false;
    this.newGroupDraftTitle = '';
    this.newGroupPendingFocus = false;
    this.patchCreateGroupInputDom();
  }

  private async confirmCreateGroup(): Promise<void> {
    const title = this.newGroupDraftTitle.trim();
    if (title === '') {
      this.cancelCreateGroup();
      return;
    }

    const t = getUiStrings(this.uiLanguage);
    try {
      const api = getApiClient();
      const resp = await api.createRtwsSnippetGroup({ title, uiLanguage: this.uiLanguage });
      if (!resp.success || !resp.data) {
        throw new Error(resp.error ?? t.snippetsLoadFailed);
      }
      const payload = resp.data;
      if (!payload.success) {
        throw new Error(payload.error);
      }

      this.creatingGroup = false;
      this.newGroupDraftTitle = '';
      this.newGroupPendingFocus = false;
      this.lastSelectedGroupKey = payload.groupKey;
      this.clearSelectedSnippetDraft();
      await this.load();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t.snippetsLoadFailed;
      dispatchDomindsEvent(
        this,
        'ui-toast',
        { message, kind: 'error' },
        {
          bubbles: true,
          composed: true,
        },
      );
      this.newGroupPendingFocus = true;
      this.patchCreateGroupInputDom();
    }
  }

  private getSelectedGroupSnippets(): SnippetItem[] {
    const state = this.state;
    if (state.kind !== 'ready') return [];
    const group = state.groups.find((g) => g.key === state.selectedGroupKey);
    if (!group) return [];
    const snippets = group.templates;
    return Array.isArray(snippets) ? snippets : [];
  }

  private renderGroupTabs(): string {
    const state = this.state;
    if (state.kind !== 'ready') return '';
    const t = getUiStrings(this.uiLanguage);
    const groups = state.groups;
    const chips = groups
      .map((g) => {
        const title = g.titleI18n[this.uiLanguage] ?? g.key;
        const active = g.key === state.selectedGroupKey;
        return `<button type="button" class="group ${active ? 'active' : ''}" data-group="${this.escapeHtml(g.key)}">${this.escapeHtml(title)}</button>`;
      })
      .join('');
    const newGroupPill = this.creatingGroup
      ? `<span class="group group-input" aria-label="new-group">
          <input id="new-group-input" class="group-input-el" type="text" value="${this.escapeHtml(
            this.newGroupDraftTitle,
          )}" />
        </span>`
      : '';
    const addBtn = `<button type="button" class="group-add" id="add-group" title="Add group" aria-label="Add group">
        <span class="icon-mask snippets-icon-add-group" aria-hidden="true"></span>
      </button>`;
    return `<div class="groups"><div class="groups-title">${this.escapeHtml(
      t.snippetsTabTitle,
    )}</div><div class="groups-buttons">${chips}${newGroupPill}${addBtn}</div></div>`;
  }

  private renderSnippets(snippets: SnippetItem[]): string {
    const t = getUiStrings(this.uiLanguage);
    if (snippets.length === 0) return `<div class="muted">—</div>`;
    const cards = snippets
      .map((snippet) => {
        const selected = this.selectedSnippetId === snippet.id;
        const desc =
          typeof snippet.description === 'string' && snippet.description.trim() !== ''
            ? snippet.description
            : '';
        const badge =
          snippet.source === 'builtin'
            ? t.snippetsBuiltinTitle
            : snippet.source === 'mcp_prompt'
              ? 'MCP'
              : t.snippetsWorkspaceTitle;
        return `
          <div class="snippet ${selected ? 'selected' : ''}" data-id="${this.escapeHtml(snippet.id)}" role="button" tabindex="0" aria-label="${this.escapeHtml(snippet.name)}">
            <div class="snippet-head">
              <div class="snippet-name">${this.escapeHtml(snippet.name)}</div>
              <div class="snippet-actions">
                <span class="badge">${this.escapeHtml(badge)}</span>
              </div>
            </div>
            ${desc ? `<div class="snippet-desc">${this.escapeHtml(desc)}</div>` : ''}
          </div>
        `;
      })
      .join('');
    return `<div class="snippet-list">${cards}</div>`;
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    this.captureSnippetScroll();
    const t = getUiStrings(this.uiLanguage);
    const state = this.state;

    let bodyHtml = '';
    if (state.kind === 'loading') {
      bodyHtml = `<div class="muted">${this.escapeHtml(t.loading)}</div>`;
    } else if (state.kind === 'error') {
      bodyHtml = `<div class="error">${this.escapeHtml(state.message)}</div>`;
    } else if (state.kind === 'ready') {
      const snippets = this.getSelectedGroupSnippets();
      const groupTitle =
        state.groups.find((g) => g.key === state.selectedGroupKey)?.titleI18n[this.uiLanguage] ??
        state.selectedGroupKey;
      const editorTitle =
        this.selectedSnippetId === null ? t.snippetsNewTitle : t.snippetsEditorTitle;
      const selectedSnippet = this.getSelectedSnippet();
      const mcpPromptArgs = selectedSnippet?.mcpPrompt?.arguments ?? [];
      const mcpPromptArgsHtml =
        selectedSnippet?.source === 'mcp_prompt' && mcpPromptArgs.length > 0
          ? this.renderMcpPromptArgsHtml(mcpPromptArgs)
          : '';
      const hasPromptArgs = mcpPromptArgsHtml !== '';
      const previewBusy = this.mcpPreviewState.kind === 'loading';
      bodyHtml = `
        ${this.renderGroupTabs()}
	        <div class="layout">
	          <div class="pane left" aria-label="${this.escapeHtml(groupTitle)}">
	            <div class="pane-scroll" data-scroll-group="${this.escapeHtml(state.selectedGroupKey)}">
	              <div class="section section-snippets">${this.renderSnippets(snippets)}</div>
	            </div>
	          </div>
	          <div class="pane right">
	            <div class="section section-editor ${hasPromptArgs ? 'with-args' : ''}">
                  ${mcpPromptArgsHtml}
        <textarea id="snippet-content" class="textarea ${previewBusy ? 'loading' : ''}" spellcheck="false" ${this.selectedSnippetReadonly ? 'readonly' : ''}>${this.escapeHtml(this.draftContent)}</textarea>
	              <div class="actions">
	                <div class="actions-left">
	                  <span class="section-title section-title-inline">${this.escapeHtml(editorTitle)}</span>
	                  <button type="button" class="btn btn-icon" id="save" title="${this.escapeHtml(t.snippetsSave)}" aria-label="${this.escapeHtml(t.snippetsSave)}">
	                    <span class="icon-mask snippets-icon-save" aria-hidden="true"></span>
	                  </button>
	                </div>
	                <div class="actions-right">
	                  <button type="button" class="btn btn-icon" id="insert" title="${this.escapeHtml(t.snippetsInsert)}" aria-label="${this.escapeHtml(t.snippetsInsert)}">
	                    <span class="icon-mask snippets-icon-insert" aria-hidden="true"></span>
	                  </button>
	                </div>
	              </div>
	              <div class="form-row">
	                <label class="label filename">
	                  <div class="label-text">${this.escapeHtml(t.snippetsFileNameLabel)}</div>
	                  <input id="new-filename" class="input" type="text" value="${this.escapeHtml(this.draftFileName)}" />
	                </label>
	                <label class="label name">
	                  <div class="label-text">${this.escapeHtml(t.snippetsNameLabel)}</div>
	                  <input id="new-name" class="input" type="text" value="${this.escapeHtml(this.draftName)}" />
	                </label>
	                <label class="label description">
	                  <div class="label-text">${this.escapeHtml(t.snippetsDescriptionLabel)}</div>
		                  <input id="new-description" class="input" type="text" value="${this.escapeHtml(this.draftDescription)}" />
			                </label>
			              </div>
		            </div>
	          </div>
	        </div>
	      `;
    } else {
      bodyHtml = `<div class="muted">—</div>`;
    }

    root.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="wrap">${bodyHtml}</div>
    `;

    const addGroupBtn = root.querySelector('#add-group');
    if (addGroupBtn instanceof HTMLButtonElement) {
      addGroupBtn.addEventListener('click', () => {
        this.startCreateGroup();
      });
    }

    const newGroupInput = root.querySelector('#new-group-input');
    if (newGroupInput instanceof HTMLInputElement) {
      this.bindNewGroupInput(newGroupInput);
    }
    if (this.newGroupPendingFocus && newGroupInput instanceof HTMLInputElement) {
      this.newGroupPendingFocus = false;
      queueMicrotask(() => {
        newGroupInput.focus();
        newGroupInput.select();
      });
    }

    this.bindSnippetCards();

    root.querySelectorAll<HTMLButtonElement>('button.group').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.group;
        if (typeof key !== 'string' || key === '') return;
        this.onSelectGroup(key);
      });
    });

    const fileNameInput = root.querySelector('#new-filename');
    if (fileNameInput instanceof HTMLInputElement) {
      fileNameInput.addEventListener('input', () => {
        this.draftFileName = fileNameInput.value;
        this.updateActionButtons();
      });
    }

    const nameInput = root.querySelector('#new-name');
    if (nameInput instanceof HTMLInputElement) {
      nameInput.addEventListener('input', () => {
        this.draftName = nameInput.value;
        this.updateActionButtons();
      });
    }

    const descInput = root.querySelector('#new-description');
    if (descInput instanceof HTMLInputElement) {
      descInput.addEventListener('input', () => {
        this.draftDescription = descInput.value;
        this.updateActionButtons();
      });
    }
    this.bindMcpArgInputs();
    const contentInput = root.querySelector('#snippet-content');
    if (contentInput instanceof HTMLTextAreaElement) {
      contentInput.addEventListener('input', () => {
        this.draftContent = contentInput.value;
        this.updateActionButtons();
      });
    }
    const saveBtn = root.querySelector('#save');
    if (saveBtn instanceof HTMLButtonElement) {
      saveBtn.addEventListener('click', () => {
        void this.saveNewSnippet();
      });
    }

    const insertBtn = root.querySelector('#insert');
    if (insertBtn instanceof HTMLButtonElement) {
      insertBtn.addEventListener('click', () => {
        void this.insertSelectedSnippet();
      });
    }

    this.updateActionButtons();
    this.restoreSnippetScroll();
  }

  private patchPreviewDom(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const textarea = root.querySelector('#snippet-content');
    if (textarea instanceof HTMLTextAreaElement && textarea.value !== this.draftContent) {
      textarea.value = this.draftContent;
    }
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.classList.toggle('loading', this.mcpPreviewState.kind === 'loading');
    }
    this.updateActionButtons();
  }

  private patchSelectedSnippetDom(previousId: string | null, nextId: string | null): void {
    const root = this.shadowRoot;
    if (!root) return;
    if (previousId !== null) {
      const previous = root.querySelector<HTMLElement>(
        `.snippet[data-id="${CSS.escape(previousId)}"]`,
      );
      if (previous instanceof HTMLElement) previous.classList.remove('selected');
    }
    if (nextId !== null) {
      const next = root.querySelector<HTMLElement>(`.snippet[data-id="${CSS.escape(nextId)}"]`);
      if (next instanceof HTMLElement) next.classList.add('selected');
    }
  }

  private patchSelectedGroupDom(previousKey: string, nextKey: string): void {
    const root = this.shadowRoot;
    if (!root) return;
    const previous = root.querySelector<HTMLButtonElement>(
      `button.group[data-group="${CSS.escape(previousKey)}"]`,
    );
    if (previous instanceof HTMLButtonElement) previous.classList.remove('active');
    const next = root.querySelector<HTMLButtonElement>(
      `button.group[data-group="${CSS.escape(nextKey)}"]`,
    );
    if (next instanceof HTMLButtonElement) next.classList.add('active');
  }

  private patchSnippetListDom(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const pane = root.querySelector('.pane.left');
    const scroll = root.querySelector('.pane-scroll');
    const section = root.querySelector('.section-snippets');
    if (
      !(pane instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(section instanceof HTMLElement) ||
      this.state.kind !== 'ready'
    ) {
      this.render();
      return;
    }
    const state = this.state;
    const groupTitle =
      state.groups.find((g) => g.key === state.selectedGroupKey)?.titleI18n[this.uiLanguage] ??
      state.selectedGroupKey;
    pane.setAttribute('aria-label', groupTitle);
    scroll.dataset.scrollGroup = state.selectedGroupKey;
    section.innerHTML = this.renderSnippets(this.getSelectedGroupSnippets());
    this.bindSnippetCards();
    this.restoreSnippetScroll();
  }

  private patchEditorDom(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const editor = root.querySelector('.section-editor');
    if (!(editor instanceof HTMLElement)) {
      this.render();
      return;
    }

    const selectedSnippet = this.getSelectedSnippet();
    const mcpPromptArgs = selectedSnippet?.mcpPrompt?.arguments ?? [];
    const hasPromptArgs = selectedSnippet?.source === 'mcp_prompt' && mcpPromptArgs.length > 0;
    editor.classList.toggle('with-args', hasPromptArgs);

    const existingArgs = editor.querySelector('.args-row');
    const nextArgsSignature = hasPromptArgs ? this.getMcpPromptArgsSignature(mcpPromptArgs) : '';
    const argsHtml = hasPromptArgs ? this.renderMcpPromptArgsHtml(mcpPromptArgs) : '';
    if (existingArgs instanceof HTMLElement) {
      if (argsHtml === '') {
        existingArgs.remove();
      } else if (existingArgs.dataset.argsSignature === nextArgsSignature) {
        this.patchMcpPromptArgValues(existingArgs);
      } else {
        existingArgs.outerHTML = argsHtml;
      }
    } else if (argsHtml !== '') {
      editor.insertAdjacentHTML('afterbegin', argsHtml);
    }
    this.bindMcpArgInputs();

    const textarea = root.querySelector('#snippet-content');
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.readOnly = this.selectedSnippetReadonly;
      textarea.value = this.draftContent;
      textarea.classList.toggle('loading', this.mcpPreviewState.kind === 'loading');
    }

    const title = root.querySelector('.section-title-inline');
    if (title instanceof HTMLElement) {
      title.textContent =
        this.selectedSnippetId === null
          ? getUiStrings(this.uiLanguage).snippetsNewTitle
          : getUiStrings(this.uiLanguage).snippetsEditorTitle;
    }

    const fileNameInput = root.querySelector('#new-filename');
    if (fileNameInput instanceof HTMLInputElement) fileNameInput.value = this.draftFileName;
    const nameInput = root.querySelector('#new-name');
    if (nameInput instanceof HTMLInputElement) nameInput.value = this.draftName;
    const descInput = root.querySelector('#new-description');
    if (descInput instanceof HTMLInputElement) descInput.value = this.draftDescription;
    this.updateActionButtons();
  }

  private patchCreateGroupInputDom(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const buttons = root.querySelector('.groups-buttons');
    if (!(buttons instanceof HTMLElement)) {
      this.render();
      return;
    }
    const existing = root.querySelector('#new-group-input');
    if (!this.creatingGroup) {
      const wrapper = existing?.closest('.group-input');
      if (wrapper instanceof HTMLElement) wrapper.remove();
      return;
    }
    if (!(existing instanceof HTMLInputElement)) {
      const addGroupBtn = root.querySelector('#add-group');
      const inputHtml = `<span class="group group-input" aria-label="new-group">
        <input id="new-group-input" class="group-input-el" type="text" value="${this.escapeHtml(
          this.newGroupDraftTitle,
        )}" />
      </span>`;
      if (addGroupBtn instanceof HTMLButtonElement) {
        addGroupBtn.insertAdjacentHTML('beforebegin', inputHtml);
      } else {
        buttons.insertAdjacentHTML('beforeend', inputHtml);
      }
    }
    const input = root.querySelector('#new-group-input');
    if (!(input instanceof HTMLInputElement)) return;
    this.bindNewGroupInput(input);
    if (!this.newGroupPendingFocus) return;
    this.newGroupPendingFocus = false;
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  }

  private renderMcpPromptArgsHtml(mcpPromptArgs: readonly McpPromptArg[]): string {
    if (!mcpPromptArgs || mcpPromptArgs.length === 0) return '';
    return `<div class="form-row args-row" data-args-signature="${this.escapeHtml(
      this.getMcpPromptArgsSignature(mcpPromptArgs),
    )}">
      ${this.getOrderedMcpPromptArgs(mcpPromptArgs)
        .map((arg) => {
          const value = this.mcpPromptArgDrafts[arg.name] ?? '';
          const required = arg.required ? ' *' : '';
          const description =
            typeof arg.description === 'string' && arg.description.trim() !== ''
              ? arg.description
              : '';
          return `<label class="label arg">
            <div class="label-text">${this.escapeHtml(arg.name + required)}</div>
            <input class="input mcp-arg" data-arg="${this.escapeHtml(arg.name)}" type="text" value="${this.escapeHtml(value)}" ${description ? `placeholder="${this.escapeHtml(description)}" title="${this.escapeHtml(description)}"` : ''} />
          </label>`;
        })
        .join('')}
    </div>`;
  }

  private getOrderedMcpPromptArgs(mcpPromptArgs: readonly McpPromptArg[]): McpPromptArg[] {
    return [...mcpPromptArgs].sort((left, right) => {
      if (left.required === right.required) return 0;
      return left.required ? -1 : 1;
    });
  }

  private getMcpPromptArgsSignature(mcpPromptArgs: readonly McpPromptArg[]): string {
    return this.getOrderedMcpPromptArgs(mcpPromptArgs)
      .map((arg): readonly [string, boolean, string] => {
        const description =
          typeof arg.description === 'string' && arg.description.trim() !== ''
            ? arg.description
            : '';
        return [arg.name, arg.required === true, description];
      })
      .map((entry) => JSON.stringify(entry))
      .join('|');
  }

  private patchMcpPromptArgValues(argsRow: HTMLElement): void {
    argsRow.querySelectorAll<HTMLInputElement>('input.mcp-arg').forEach((input) => {
      const argName = input.dataset.arg;
      if (typeof argName !== 'string' || argName === '') return;
      const nextValue = this.mcpPromptArgDrafts[argName] ?? '';
      if (input.value !== nextValue) input.value = nextValue;
    });
  }

  private bindMcpArgInputs(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLInputElement>('input.mcp-arg').forEach((input) => {
      if (input.dataset.bound === 'true') return;
      input.dataset.bound = 'true';
      input.addEventListener('input', () => {
        const argName = input.dataset.arg;
        if (typeof argName !== 'string' || argName === '') return;
        this.mcpPromptArgDrafts = { ...this.mcpPromptArgDrafts, [argName]: input.value };
        this.updateActionButtons();
        this.scheduleMcpPromptPreview();
      });
    });
  }

  private bindNewGroupInput(input: HTMLInputElement): void {
    if (input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    input.addEventListener('input', () => {
      this.newGroupDraftTitle = input.value;
    });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelCreateGroup();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.confirmCreateGroup();
      }
    });
  }

  private bindSnippetCards(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.snippet[data-id]').forEach((card) => {
      if (card.dataset.bound === 'true') return;
      card.dataset.bound = 'true';
      card.addEventListener('click', (e: Event) => {
        const target = e.target;
        if (target instanceof Element && target.closest('button')) return;
        this.selectSnippetFromCard(card);
      });

      card.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.selectSnippetFromCard(card);
      });
    });
  }

  private selectSnippetFromCard(card: HTMLElement): void {
    if (this.state.kind !== 'ready') return;
    const id = card.getAttribute('data-id');
    if (typeof id !== 'string' || id === '') return;
    const all = this.state.groups.flatMap((g) => g.templates);
    const snippet = all.find((x) => x.id === id);
    this.selectSnippet(snippet ?? null);
  }

  private captureSnippetScroll(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const scroll = root.querySelector('.pane-scroll');
    if (!(scroll instanceof HTMLElement)) return;
    const groupKey = scroll.dataset.scrollGroup;
    if (typeof groupKey !== 'string' || groupKey === '') return;
    this.snippetScrollTops = { ...this.snippetScrollTops, [groupKey]: scroll.scrollTop };
  }

  private restoreSnippetScroll(): void {
    const root = this.shadowRoot;
    if (!root || this.state.kind !== 'ready') return;
    const scroll = root.querySelector('.pane-scroll');
    if (!(scroll instanceof HTMLElement)) return;
    const saved = this.snippetScrollTops[this.state.selectedGroupKey];
    scroll.scrollTop = typeof saved === 'number' ? saved : 0;
  }

  private updateActionButtons(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const saveBtn = root.querySelector('#save');
    if (saveBtn instanceof HTMLButtonElement) {
      const canSave =
        !this.selectedSnippetReadonly &&
        this.draftName.trim() !== '' &&
        this.draftContent.trim() !== '';
      saveBtn.disabled = !canSave;
      saveBtn.classList.toggle('disabled', !canSave);
      saveBtn.classList.toggle('soft', canSave);
    }

    const insertBtn = root.querySelector('#insert');
    if (insertBtn instanceof HTMLButtonElement) {
      const selectedSnippet = this.getSelectedSnippet();
      const missingRequiredArg =
        selectedSnippet?.source === 'mcp_prompt'
          ? (selectedSnippet.mcpPrompt?.arguments ?? []).some(
              (arg) => arg.required && (this.mcpPromptArgDrafts[arg.name] ?? '').trim() === '',
            )
          : false;
      const canInsert =
        !missingRequiredArg &&
        (this.draftContent.trim() !== '' ||
          (this.selectedSnippetId !== null && selectedSnippet?.source === 'mcp_prompt'));
      insertBtn.disabled = !canInsert;
      insertBtn.classList.toggle('disabled', !canInsert);
      insertBtn.classList.toggle('preferred', canInsert);
    }
  }

  private getStyles(): string {
    return `
      ${ICON_MASK_BASE_CSS}
      :host{display:flex;flex-direction:column;min-height:0;width:100%;height:100%;}
      .wrap{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;width:100%;max-width:100%;box-sizing:border-box;overflow:hidden;padding:0;background:var(--dominds-bg,#fff);}
      .groups{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;padding:2px 8px;border:none;border-bottom:1px solid var(--color-border-primary,#e2e8f0);border-radius:0;background:var(--color-bg-secondary,#f8fafc);}
      .groups-title{font-size: var(--dominds-font-size-sm, 12px);color:var(--color-fg-tertiary,#64748b);}
      .groups-buttons{display:flex;gap:4px;align-items:center;overflow-x:auto;min-width:0;flex:1;}
      .groups-buttons::-webkit-scrollbar{height:8px;}
      .groups-buttons::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--color-border-primary,#e2e8f0) 60%, transparent);border-radius:999px;}
      .group{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;padding:2px 8px;font-size: var(--dominds-font-size-sm, 12px);cursor:pointer;flex:0 0 auto;}
      .group.active{border-color:var(--dominds-primary,#007acc);color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 18%, transparent);}
      .group-add{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;}
      .group-input{display:inline-flex;align-items:center;gap:4px;padding:0 6px;min-height:24px;border-radius:999px;border:1px solid var(--dominds-primary,#007acc);background:var(--dominds-bg,#fff);flex:0 0 auto;}
      .group-input-el{border:none;outline:none;background:transparent;font-size: var(--dominds-font-size-sm, 12px);min-width:120px;color:var(--dominds-fg,#0f172a);}

      .layout{display:flex;gap:6px;flex:1;min-height:0;width:100%;max-width:100%;box-sizing:border-box;}
      .pane{display:flex;flex-direction:column;min-height:0;min-width:0;}
      .pane.left{flex:0 0 360px;max-width:420px;border-right:1px solid var(--color-border-primary,#e2e8f0);}
      .pane.right{flex:1 1 auto;display:flex;min-height:0;}
      .pane-scroll{overflow:auto;min-height:0;flex:1;}
      .section{display:flex;flex-direction:column;gap:4px;padding:6px 8px 0 8px;}
      .section-title{font-weight:600;font-size: var(--dominds-font-size-sm, 12px);color:var(--color-fg-secondary,#475569);}
      .section-title-inline{display:inline-flex;align-items:center;line-height:1;}
      .snippet-list{display:flex;flex-direction:column;gap:4px;}
      .snippet{border:1px solid var(--color-border-primary,#e2e8f0);border-radius:8px;padding:4px 6px;background:var(--dominds-bg,#fff);}
      .snippet.selected{border-color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 15%, transparent);}
      .snippet-head{display:flex;align-items:center;justify-content:space-between;gap:6px;}
      .snippet-name{font-weight:600;font-size:12px;color:var(--dominds-fg,#0f172a);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .snippet-actions{display:flex;align-items:center;gap:4px;}
      .badge{font-size: var(--dominds-font-size-xs, 11px);color:var(--color-fg-tertiary,#64748b);border:1px solid var(--color-border-primary,#e2e8f0);padding:1px 6px;border-radius:999px;background:var(--color-bg-secondary,#f8fafc);}
      .snippet-desc{margin-top:3px;font-size: var(--dominds-font-size-sm, 12px);color:var(--color-fg-tertiary,#64748b);white-space:pre-wrap;}
      .muted{color:var(--color-fg-tertiary,#64748b);font-size: var(--dominds-font-size-sm, 12px);}
      .error{color:var(--dominds-danger,#dc3545);font-size: var(--dominds-font-size-sm, 12px);white-space:pre-wrap;}
      .form-row{display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;}
      .label{display:flex;flex-direction:column;gap:3px;}
      .form-row .label{min-width:0;}
      .form-row .label.filename{flex:0 0 140px;}
      .form-row .label.name{flex:0 0 180px;}
      .form-row .label.description{flex:1 1 320px;}
      .form-row .label.arg{flex:1 1 180px;}
      .label-text{font-size: var(--dominds-font-size-sm, 12px);color:var(--color-fg-secondary,#475569);}
      .input{border:1px solid var(--color-border-primary,#e2e8f0);border-radius:6px;padding:2px 8px;font-size: var(--dominds-font-size-sm, 12px);background:var(--dominds-bg,#fff);color:var(--dominds-fg,#0f172a);}
      .form-row .input{width:100%;box-sizing:border-box;}
      .textarea{border:1px solid var(--color-border-primary,#e2e8f0);border-radius:6px;padding:3px 8px;font-size:12px;min-height:120px;height:100%;width:100%;box-sizing:border-box;resize:vertical;background:var(--dominds-bg,#fff);color:var(--dominds-fg,#0f172a);font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
      .textarea.loading{color:var(--color-fg-tertiary,#64748b);}
      .section-editor{padding:6px 8px;display:grid;grid-template-rows:minmax(120px,1fr) auto auto;gap:6px;flex:1;min-height:0;}
      .section-editor.with-args{grid-template-rows:auto minmax(120px,1fr) auto auto;}
      .actions{display:flex;align-items:center;justify-content:space-between;gap:6px;}
      .actions-left,.actions-right{display:flex;align-items:center;gap:6px;}
      .btn{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;padding:2px 8px;font-size: var(--dominds-font-size-sm, 12px);cursor:pointer;}
      .btn.btn-icon{width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;}
      .group-add .icon-mask{width:16px;height:16px;}
      .btn.btn-icon .icon-mask{width:14px;height:14px;}
      .snippets-icon-add-group{--icon-mask:${ICON_MASK_URLS.plusCircle};}
      .snippets-icon-save{--icon-mask:${ICON_MASK_URLS.save};}
      .snippets-icon-insert{--icon-mask:${ICON_MASK_URLS.insertDown};}
      .btn.disabled{opacity:0.45;cursor:not-allowed;box-shadow:none !important;border-color:var(--color-border-primary,#e2e8f0);color:var(--color-fg-tertiary,#64748b);}
      .btn.soft{border-color:color-mix(in srgb, var(--dominds-primary,#007acc) 22%, var(--color-border-primary,#e2e8f0));color:color-mix(in srgb, var(--dominds-primary,#007acc) 55%, var(--color-fg-secondary,#475569));background:color-mix(in srgb, var(--dominds-primary,#007acc) 6%, var(--dominds-bg,#fff));box-shadow:none;}
      .btn.preferred{border-color:var(--dominds-primary,#007acc);color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 15%, transparent);}

      @media (max-width: 860px) {
        .layout{flex-direction:column;gap:6px;}
        .pane.left{flex:0 0 auto;max-width:none;border-right:none;border-bottom:1px solid var(--color-border-primary,#e2e8f0);}
      }
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

if (!customElements.get('dominds-snippets-panel')) {
  customElements.define('dominds-snippets-panel', DomindsSnippetsPanel);
}
