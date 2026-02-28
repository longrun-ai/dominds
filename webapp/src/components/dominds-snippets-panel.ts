import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import type { LanguageCode } from '../shared/types/language';
import type {
  SnippetCatalogResponse,
  SnippetTemplateGroup as SnippetGroup,
  SnippetTemplate as SnippetItem,
} from '../shared/types/snippets';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; groups: SnippetGroup[]; selectedGroupKey: string }
  | { kind: 'error'; message: string };

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

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    void this.load();
  }

  public setUiLanguage(language: LanguageCode): void {
    this.uiLanguage = language;
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    this.state = { kind: 'loading' };
    this.render();
    try {
      const api = getApiClient();
      const catalogResp = await api.getSnippetCatalog(this.uiLanguage);

      if (!catalogResp.success && catalogResp.status === 401) {
        this.dispatchEvent(
          new CustomEvent('ui-toast', {
            detail: { message: t.unauthorized, kind: 'warning' },
            bubbles: true,
            composed: true,
          }),
        );
        this.dispatchEvent(new CustomEvent('auth-required', { bubbles: true, composed: true }));
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
      this.render();
    } catch (error: unknown) {
      this.state = {
        kind: 'error',
        message: error instanceof Error ? error.message : t.snippetsLoadFailed,
      };
      this.render();
    }
  }

  private emitInsertContent(content: string): void {
    const normalized = typeof content === 'string' ? content : '';
    if (normalized.trim() === '') return;
    this.dispatchEvent(
      new CustomEvent('snippet-insert', {
        detail: { content: normalized },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private selectSnippet(snippet: SnippetItem | null): void {
    if (!snippet) {
      this.selectedSnippetId = null;
      this.selectedSnippetPath = null;
      this.draftName = '';
      this.draftFileName = '';
      this.draftDescription = '';
      this.draftContent = '';
      this.render();
      return;
    }

    this.selectedSnippetId = snippet.id;
    this.selectedSnippetPath = typeof snippet.path === 'string' ? snippet.path : null;
    this.draftName = snippet.name;
    this.draftFileName = this.deriveFileNameForEditing(snippet);
    this.draftDescription = typeof snippet.description === 'string' ? snippet.description : '';
    this.draftContent = snippet.content;
    this.render();
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
      this.selectedSnippetId = null;
      this.selectedSnippetPath = null;
      this.draftName = '';
      this.draftFileName = '';
      this.draftDescription = '';
      this.draftContent = '';
      await this.load();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t.snippetsSaveFailed;
      this.state = { kind: 'error', message: msg };
      this.render();
    }
  }

  private onSelectGroup(key: string): void {
    const state = this.state;
    if (state.kind !== 'ready') return;
    if (key === state.selectedGroupKey) return;
    this.lastSelectedGroupKey = key;
    this.state = { ...state, selectedGroupKey: key };
    this.selectedSnippetId = null;
    this.selectedSnippetPath = null;
    this.draftName = '';
    this.draftFileName = '';
    this.draftDescription = '';
    this.draftContent = '';
    this.render();
  }

  private startCreateGroup(): void {
    this.creatingGroup = true;
    this.newGroupDraftTitle = '';
    this.newGroupPendingFocus = true;
    this.render();
  }

  private cancelCreateGroup(): void {
    if (!this.creatingGroup) return;
    this.creatingGroup = false;
    this.newGroupDraftTitle = '';
    this.newGroupPendingFocus = false;
    this.render();
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
      this.selectedSnippetId = null;
      this.selectedSnippetPath = null;
      this.draftName = '';
      this.draftFileName = '';
      this.draftDescription = '';
      this.draftContent = '';
      await this.load();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t.snippetsLoadFailed;
      this.dispatchEvent(
        new CustomEvent('ui-toast', {
          detail: { message, kind: 'error' },
          bubbles: true,
          composed: true,
        }),
      );
      this.newGroupPendingFocus = true;
      this.render();
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
          snippet.source === 'builtin' ? t.snippetsBuiltinTitle : t.snippetsWorkspaceTitle;
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
      bodyHtml = `
        ${this.renderGroupTabs()}
	        <div class="layout">
	          <div class="pane left" aria-label="${this.escapeHtml(groupTitle)}">
	            <div class="pane-scroll">
	              <div class="section section-snippets">${this.renderSnippets(snippets)}</div>
	            </div>
	          </div>
	          <div class="pane right">
	            <div class="section section-editor">
	              <textarea id="snippet-content" class="textarea" spellcheck="false">${this.escapeHtml(this.draftContent)}</textarea>
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
      newGroupInput.addEventListener('input', () => {
        this.newGroupDraftTitle = newGroupInput.value;
      });
      newGroupInput.addEventListener('keydown', (e: KeyboardEvent) => {
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
    if (this.newGroupPendingFocus && newGroupInput instanceof HTMLInputElement) {
      this.newGroupPendingFocus = false;
      queueMicrotask(() => {
        newGroupInput.focus();
        newGroupInput.select();
      });
    }

    root.querySelectorAll<HTMLElement>('.snippet[data-id]').forEach((card) => {
      card.addEventListener('click', (e: Event) => {
        const target = e.target;
        if (target instanceof Element && target.closest('button')) return;
        if (this.state.kind !== 'ready') return;
        const id = card.getAttribute('data-id');
        if (typeof id !== 'string' || id === '') return;
        const all = this.state.groups.flatMap((g) => g.templates);
        const snippet = all.find((x) => x.id === id);
        this.selectSnippet(snippet ?? null);
      });

      card.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (this.state.kind !== 'ready') return;
        const id = card.getAttribute('data-id');
        if (typeof id !== 'string' || id === '') return;
        const all = this.state.groups.flatMap((g) => g.templates);
        const snippet = all.find((x) => x.id === id);
        this.selectSnippet(snippet ?? null);
      });
    });

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
        this.emitInsertContent(this.draftContent);
      });
    }

    this.updateActionButtons();
  }

  private updateActionButtons(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const saveBtn = root.querySelector('#save');
    if (saveBtn instanceof HTMLButtonElement) {
      const canSave = this.draftName.trim() !== '' && this.draftContent.trim() !== '';
      saveBtn.disabled = !canSave;
      saveBtn.classList.toggle('disabled', !canSave);
      saveBtn.classList.toggle('soft', canSave);
    }

    const insertBtn = root.querySelector('#insert');
    if (insertBtn instanceof HTMLButtonElement) {
      const canInsert = this.draftContent.trim() !== '';
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
      .label-text{font-size: var(--dominds-font-size-sm, 12px);color:var(--color-fg-secondary,#475569);}
      .input{border:1px solid var(--color-border-primary,#e2e8f0);border-radius:6px;padding:2px 8px;font-size: var(--dominds-font-size-sm, 12px);background:var(--dominds-bg,#fff);color:var(--dominds-fg,#0f172a);}
      .form-row .input{width:100%;box-sizing:border-box;}
      .textarea{border:1px solid var(--color-border-primary,#e2e8f0);border-radius:6px;padding:3px 8px;font-size:12px;min-height:120px;height:100%;width:100%;box-sizing:border-box;resize:vertical;background:var(--dominds-bg,#fff);color:var(--dominds-fg,#0f172a);font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
      .section-editor{padding:6px 8px;display:grid;grid-template-rows:minmax(120px,1fr) auto auto;gap:6px;flex:1;min-height:0;}
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
