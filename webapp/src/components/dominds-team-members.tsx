/**
 * Team Members Activity View (Sidebar)
 * Renders the current team roster from `/api/team/config` and supports quick @mention insertion.
 */

import { formatTeamMembersTitle, getUiStrings } from '../i18n/ui';
import type { FrontendTeamMember } from '../services/api';
import type { LanguageCode } from '../shared/types/language';

export interface TeamMembersProps {
  members: FrontendTeamMember[];
  defaultResponder: string | null;
  loading: boolean;
  uiLanguage: LanguageCode;
}

type TeamMembersUiState =
  | { kind: 'ready'; query: string; showHidden: boolean; selectedMemberId: string | null }
  | { kind: 'error'; query: string; showHidden: boolean; selectedMemberId: string | null; message: string };

export type TeamMembersMentionEventDetail = {
  memberId: string;
  mention: string;
};

export class DomindsTeamMembers extends HTMLElement {
  private props: TeamMembersProps = {
    members: [],
    defaultResponder: null,
    loading: false,
    uiLanguage: 'en',
  };

  private state: TeamMembersUiState = {
    kind: 'ready',
    query: '',
    showHidden: false,
    selectedMemberId: null,
  };

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.bindEvents();
  }

  public setMembers(members: FrontendTeamMember[]): void {
    this.props.members = members;
    const selected = this.getSelectedMemberId();
    if (selected && !members.some((m) => m.id === selected)) {
      this.setSelectedMemberId(null);
    }
    this.render();
    this.bindEvents();
  }

  public setDefaultResponder(defaultResponder: string | null): void {
    this.props.defaultResponder = defaultResponder;
    this.render();
    this.bindEvents();
  }

  public setLoading(loading: boolean): void {
    this.props.loading = loading;
    this.render();
    this.bindEvents();
  }

  public setProps(props: Partial<TeamMembersProps>): void {
    this.props = { ...this.props, ...props };
    this.render();
    this.bindEvents();
  }

  private getSelectedMemberId(): string | null {
    switch (this.state.kind) {
      case 'ready':
        return this.state.selectedMemberId;
      case 'error':
        return this.state.selectedMemberId;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private setSelectedMemberId(selectedMemberId: string | null): void {
    switch (this.state.kind) {
      case 'ready':
        this.state = { ...this.state, selectedMemberId };
        return;
      case 'error':
        this.state = { ...this.state, selectedMemberId };
        return;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private getQuery(): string {
    switch (this.state.kind) {
      case 'ready':
        return this.state.query;
      case 'error':
        return this.state.query;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private setQuery(query: string): void {
    switch (this.state.kind) {
      case 'ready':
        this.state = { ...this.state, query };
        return;
      case 'error':
        this.state = { ...this.state, query };
        return;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private getShowHidden(): boolean {
    switch (this.state.kind) {
      case 'ready':
        return this.state.showHidden;
      case 'error':
        return this.state.showHidden;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private setShowHidden(showHidden: boolean): void {
    switch (this.state.kind) {
      case 'ready':
        this.state = { ...this.state, showHidden };
        return;
      case 'error':
        this.state = { ...this.state, showHidden };
        return;
      default: {
        const _exhaustive: never = this.state;
        throw new Error(`Unhandled TeamMembersUiState: ${String(_exhaustive)}`);
      }
    }
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const preserved = this.captureRenderContext(root);

    const t = getUiStrings(this.props.uiLanguage);

    const query = this.getQuery();
    const showHidden = this.getShowHidden();
    const filtered = this.filterMembers(this.props.members, query, showHidden);
    const visible = filtered.filter((m) => m.hidden !== true);
    const hidden = filtered.filter((m) => m.hidden === true);

    const selectedId = this.getSelectedMemberId();
    const selected = selectedId ? this.props.members.find((m) => m.id === selectedId) : undefined;

    const loadingOverlay = this.props.loading
      ? `<div class="loading-overlay" aria-label="${t.loading}">${t.loading}</div>`
      : '';

    const emptyState =
      this.props.members.length === 0
        ? `
          <div class="empty-state">
            <div class="empty-title">${t.noTeamMembers}</div>
            <div class="empty-text">${t.teamMembersWillAppear}</div>
          </div>
        `
        : filtered.length === 0
          ? `
          <div class="empty-state">
            <div class="empty-title">${t.teamMembersNoMatches}</div>
            <div class="empty-text">${t.teamMembersNoMatchesHint}</div>
          </div>
        `
          : '';

    root.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="team-members">
        <div class="team-members-header">
          <div class="team-members-title" id="team-members-title">
            ${formatTeamMembersTitle(this.props.uiLanguage, this.props.members.length)}
          </div>
          <button type="button" class="icon-button" id="team-members-refresh" title="${t.teamMembersRefresh}" aria-label="${t.teamMembersRefresh}">
            ↻
          </button>
        </div>

        <div class="team-members-controls">
          <input
            id="team-members-search"
            class="search"
            type="text"
            value="${this.escapeAttr(query)}"
            placeholder="${this.escapeAttr(t.teamMembersSearchPlaceholder)}"
            autocomplete="off"
          />
          <label class="toggle">
            <input id="team-members-show-hidden" type="checkbox" ${showHidden ? 'checked' : ''} />
            <span>${t.teamMembersShowHidden}</span>
          </label>
        </div>

        <div class="team-members-body">
          ${loadingOverlay}
          ${emptyState}
          ${
            filtered.length > 0
              ? `
            <div class="members-list" id="team-members-list">
              <div class="section">
                <div class="section-title">${t.teamMembersVisibleSection} (${String(
                  visible.length,
                )})</div>
                ${visible.map((m) => this.renderMemberRow(m)).join('')}
              </div>
              ${
                showHidden
                  ? `
                <div class="section">
                  <div class="section-title">${t.teamMembersHiddenSection} (${String(
                    hidden.length,
                  )})</div>
                  ${hidden.map((m) => this.renderMemberRow(m)).join('')}
                </div>
              `
                  : ''
              }
            </div>
          `
              : ''
          }

          <div class="member-details" id="team-member-details" ${selected ? '' : 'hidden'}>
            ${selected ? this.renderMemberDetails(selected) : ''}
          </div>
        </div>
      </div>
    `;

    this.restoreRenderContext(root, preserved);
  }

  private captureRenderContext(root: ShadowRoot): {
    focusedId: string | null;
    selectionStart: number | null;
    selectionEnd: number | null;
    membersListScrollTop: number;
    memberDetailsScrollTop: number;
  } {
    const active = root.activeElement;
    const focusedId = active instanceof HTMLElement ? active.id : null;

    const selectionStart = active instanceof HTMLInputElement ? active.selectionStart : null;
    const selectionEnd = active instanceof HTMLInputElement ? active.selectionEnd : null;

    const list = root.querySelector('#team-members-list');
    const membersListScrollTop = list instanceof HTMLElement ? list.scrollTop : 0;

    const details = root.querySelector('#team-member-details');
    const memberDetailsScrollTop = details instanceof HTMLElement ? details.scrollTop : 0;

    return { focusedId, selectionStart, selectionEnd, membersListScrollTop, memberDetailsScrollTop };
  }

  private restoreRenderContext(
    root: ShadowRoot,
    ctx: {
      focusedId: string | null;
      selectionStart: number | null;
      selectionEnd: number | null;
      membersListScrollTop: number;
      memberDetailsScrollTop: number;
    },
  ): void {
    const list = root.querySelector('#team-members-list');
    if (list instanceof HTMLElement) list.scrollTop = ctx.membersListScrollTop;

    const details = root.querySelector('#team-member-details');
    if (details instanceof HTMLElement) details.scrollTop = ctx.memberDetailsScrollTop;

    if (ctx.focusedId === 'team-members-search') {
      const input = root.querySelector('#team-members-search');
      if (input instanceof HTMLInputElement) {
        input.focus();
        if (typeof ctx.selectionStart === 'number' && typeof ctx.selectionEnd === 'number') {
          input.setSelectionRange(ctx.selectionStart, ctx.selectionEnd);
        }
      }
    }
  }

  private renderMemberRow(member: FrontendTeamMember): string {
    const t = getUiStrings(this.props.uiLanguage);
    const isDefault = typeof this.props.defaultResponder === 'string' && member.id === this.props.defaultResponder;
    const isSelected = this.getSelectedMemberId() === member.id;
    const icon = this.getMemberIcon(member);
    const provider = typeof member.provider === 'string' ? member.provider : t.teamMembersUnknownProvider;
    const model = typeof member.model === 'string' ? member.model : t.teamMembersUnknownModel;

    const hiddenBadge = member.hidden === true ? `<span class="badge badge-hidden">${t.teamMembersHiddenBadge}</span>` : '';
    const defaultBadge = isDefault ? `<span class="badge badge-default">${t.teamMembersDefaultBadge}</span>` : '';

    return `
      <div class="member-row" role="button" tabindex="0" data-member-id="${this.escapeAttr(member.id)}" aria-pressed="${
        isSelected ? 'true' : 'false'
      }">
        <div class="member-avatar" aria-hidden="true">${this.escapeHtml(icon)}</div>
        <div class="member-main">
          <div class="member-top">
            <div class="member-name">${this.escapeHtml(member.name)}</div>
            ${defaultBadge}
            ${hiddenBadge}
          </div>
          <div class="member-sub">
            <span class="member-id">@${this.escapeHtml(member.id)}</span>
            <span class="member-meta">${this.escapeHtml(provider)} · ${this.escapeHtml(model)}</span>
          </div>
        </div>
        <div class="member-actions">
          <button type="button" class="member-action" data-action="mention" data-member-id="${this.escapeAttr(
            member.id,
          )}" title="${t.teamMembersMention}" aria-label="${t.teamMembersMention}">
            @
          </button>
          <button type="button" class="member-action" data-action="copy" data-member-id="${this.escapeAttr(
            member.id,
          )}" title="${t.teamMembersCopyMention}" aria-label="${t.teamMembersCopyMention}">
            ⧉
          </button>
        </div>
      </div>
    `;
  }

  private renderMemberDetails(member: FrontendTeamMember): string {
    const t = getUiStrings(this.props.uiLanguage);
    const isDefault = typeof this.props.defaultResponder === 'string' && member.id === this.props.defaultResponder;

    const provider = typeof member.provider === 'string' ? member.provider : t.teamMembersUnknownProvider;
    const model = typeof member.model === 'string' ? member.model : t.teamMembersUnknownModel;
    const streaming = member.streaming === true ? t.teamMembersYes : t.teamMembersNo;
    const gofor = Array.isArray(member.gofor) ? member.gofor : [];
    const toolsets = Array.isArray(member.toolsets) ? member.toolsets : [];
    const tools = Array.isArray(member.tools) ? member.tools : [];

    return `
      <div class="details-header">
        <div class="details-title">
          <span class="details-icon" aria-hidden="true">${this.escapeHtml(this.getMemberIcon(member))}</span>
          <span>${this.escapeHtml(member.name)}</span>
          <span class="details-callsign">@${this.escapeHtml(member.id)}</span>
          ${isDefault ? `<span class="badge badge-default">${t.teamMembersDefaultBadge}</span>` : ''}
          ${member.hidden === true ? `<span class="badge badge-hidden">${t.teamMembersHiddenBadge}</span>` : ''}
        </div>
        <div class="details-actions">
          <button type="button" class="details-action" id="team-members-details-mention" data-member-id="${this.escapeAttr(
            member.id,
          )}" title="${t.teamMembersMention}" aria-label="${t.teamMembersMention}">
            ${t.teamMembersMention}
          </button>
          <button type="button" class="details-action" id="team-members-details-copy" data-member-id="${this.escapeAttr(
            member.id,
          )}" title="${t.teamMembersCopyMention}" aria-label="${t.teamMembersCopyMention}">
            ${t.teamMembersCopyMention}
          </button>
        </div>
      </div>
      <div class="details-grid">
        <div class="details-row"><span class="k">${t.teamMembersProviderLabel}</span><span class="v">${this.escapeHtml(
          provider,
        )}</span></div>
        <div class="details-row"><span class="k">${t.teamMembersModelLabel}</span><span class="v">${this.escapeHtml(
          model,
        )}</span></div>
        <div class="details-row"><span class="k">${t.teamMembersStreamingLabel}</span><span class="v">${this.escapeHtml(
          streaming,
        )}</span></div>
        ${
          gofor.length > 0
            ? `<div class="details-row"><span class="k">${t.teamMembersSpecializesLabel}</span><span class="v">${this.escapeHtml(
                gofor.join(', '),
              )}</span></div>`
            : ''
        }
        ${
          toolsets.length > 0
            ? `<div class="details-row"><span class="k">${t.teamMembersToolsetsLabel}</span><span class="v">${this.escapeHtml(
                toolsets.join(', '),
              )}</span></div>`
            : ''
        }
        ${
          tools.length > 0
            ? `<div class="details-row"><span class="k">${t.teamMembersToolsLabel}</span><span class="v">${this.escapeHtml(
                tools.join(', '),
              )}</span></div>`
            : ''
        }
      </div>
    `;
  }

  private bindEvents(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const refresh = root.querySelector('#team-members-refresh');
    if (refresh instanceof HTMLButtonElement) {
      refresh.onclick = () => {
        this.dispatchEvent(
          new CustomEvent('team-members-refresh', { bubbles: true, composed: true }),
        );
      };
    }

    const search = root.querySelector('#team-members-search');
    if (search instanceof HTMLInputElement) {
      search.oninput = () => {
        this.setQuery(search.value);
        this.render();
        this.bindEvents();
      };
    }

    const showHidden = root.querySelector('#team-members-show-hidden');
    if (showHidden instanceof HTMLInputElement) {
      showHidden.onchange = () => {
        this.setShowHidden(showHidden.checked);
        this.render();
        this.bindEvents();
      };
    }

    const list = root.querySelector('#team-members-list');
    if (list instanceof HTMLElement) {
      list.onclick = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const actionBtn = target.closest('button[data-action]');
        if (actionBtn instanceof HTMLButtonElement) {
          event.preventDefault();
          event.stopPropagation();
          const action = actionBtn.getAttribute('data-action');
          const memberId = actionBtn.getAttribute('data-member-id');
          if (typeof memberId !== 'string' || memberId.length === 0) return;
          if (action === 'mention') {
            this.emitMention(memberId);
          } else if (action === 'copy') {
            void this.copyMention(memberId);
          }
          return;
        }

        const row = target.closest('.member-row');
        if (!(row instanceof HTMLElement)) return;
        const memberId = row.getAttribute('data-member-id');
        if (typeof memberId !== 'string' || memberId.length === 0) return;
        this.setSelectedMemberId(memberId);
        this.render();
        this.bindEvents();
      };

      list.onkeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const row = target.closest('.member-row');
        if (!(row instanceof HTMLElement)) return;
        const memberId = row.getAttribute('data-member-id');
        if (typeof memberId !== 'string' || memberId.length === 0) return;
        event.preventDefault();
        this.setSelectedMemberId(memberId);
        this.render();
        this.bindEvents();
      };
    }

    const details = root.querySelector('#team-member-details');
    if (details instanceof HTMLElement) {
      details.onclick = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('button[data-member-id]');
        if (!(btn instanceof HTMLButtonElement)) return;
        event.preventDefault();
        const memberId = btn.getAttribute('data-member-id');
        if (typeof memberId !== 'string' || memberId.length === 0) return;

        if (btn.id === 'team-members-details-mention') {
          this.emitMention(memberId);
        } else if (btn.id === 'team-members-details-copy') {
          void this.copyMention(memberId);
        }
      };
    }
  }

  private emitMention(memberId: string): void {
    const mention = `@${memberId}`;
    const detail: TeamMembersMentionEventDetail = { memberId, mention };
    this.dispatchEvent(
      new CustomEvent<TeamMembersMentionEventDetail>('team-member-mention', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async copyMention(memberId: string): Promise<void> {
    const t = getUiStrings(this.props.uiLanguage);
    const mention = `@${memberId}`;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(mention);
        this.emitToast(`${t.teamMembersCopiedPrefix}${mention}`);
        return;
      }

      // Clipboard API might be unavailable in some contexts; fall back to execCommand.
      const ta = document.createElement('textarea');
      ta.value = mention;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.emitToast(`${t.teamMembersCopiedPrefix}${mention}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.emitToast(`${t.teamMembersCopyFailedPrefix}${msg}`, 'warning');
    }
  }

  private emitToast(message: string, kind: 'error' | 'warning' | 'info' = 'info'): void {
    this.dispatchEvent(
      new CustomEvent('ui-toast', { detail: { message, kind }, bubbles: true, composed: true }),
    );
  }

  private filterMembers(
    members: FrontendTeamMember[],
    query: string,
    showHidden: boolean,
  ): FrontendTeamMember[] {
    const trimmed = query.trim();
    const q = trimmed.length > 0 ? trimmed.toLowerCase() : '';

    const list = showHidden ? members : members.filter((m) => m.hidden !== true);
    if (!q) return list;

    return list.filter((m) => this.memberMatches(m, q));
  }

  private memberMatches(member: FrontendTeamMember, q: string): boolean {
    const fields: string[] = [];
    fields.push(member.id);
    fields.push(member.name);

    if (typeof member.provider === 'string') fields.push(member.provider);
    if (typeof member.model === 'string') fields.push(member.model);
    if (Array.isArray(member.gofor)) fields.push(member.gofor.join(' '));
    if (Array.isArray(member.toolsets)) fields.push(member.toolsets.join(' '));
    if (Array.isArray(member.tools)) fields.push(member.tools.join(' '));

    return fields.some((f) => f.toLowerCase().includes(q));
  }

  private getMemberIcon(member: FrontendTeamMember): string {
    if (typeof member.icon === 'string' && member.icon.length > 0) return member.icon;
    return '🛠';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeAttr(text: string): string {
    return this.escapeHtml(text);
  }

  private getStyles(): string {
    return `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .team-members {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        padding: 0 10px;
      }

      .team-members-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
      }

      .team-members-title {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .icon-button {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }

      .icon-button:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .team-members-controls {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 6px 0 10px 0;
      }

      .search {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        outline: none;
      }

      .search:focus {
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.18);
      }

      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        user-select: none;
      }

      .team-members-body {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .members-list {
        overflow: auto;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
        background: var(--dominds-bg, #ffffff);
        padding: 8px 0;
      }

      .section {
        display: flex;
        flex-direction: column;
      }

      .section-title {
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--dominds-muted, #666666);
        padding: 6px 10px;
      }

      .member-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        cursor: pointer;
        border-top: 1px solid rgba(224, 224, 224, 0.5);
      }

      .member-row:first-of-type {
        border-top: none;
      }

      .member-row:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      .member-row[aria-pressed="true"] {
        background: rgba(0, 122, 204, 0.08);
      }

      .member-avatar {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--dominds-primary, #007acc);
        color: #ffffff;
        font-size: 14px;
        flex-shrink: 0;
      }

      .member-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .member-top {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      .member-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .member-sub {
        display: flex;
        align-items: baseline;
        gap: 10px;
        min-width: 0;
      }

      .member-id {
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        white-space: nowrap;
      }

      .member-meta {
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .member-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }

      .member-action {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 8px;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 12px;
      }

      .member-action:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .badge {
        border: 1px solid rgba(224, 224, 224, 0.8);
        border-radius: 999px;
        font-size: 11px;
        padding: 1px 6px;
        color: var(--dominds-muted, #666666);
        background: rgba(0, 0, 0, 0.02);
        flex-shrink: 0;
      }

      .badge-default {
        border-color: rgba(0, 122, 204, 0.35);
        color: var(--dominds-primary, #007acc);
        background: rgba(0, 122, 204, 0.08);
      }

      .badge-hidden {
        border-color: rgba(255, 193, 7, 0.5);
        color: var(--dominds-warning, #b45309);
        background: rgba(255, 193, 7, 0.12);
      }

      .member-details {
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 10px;
        background: var(--dominds-bg, #ffffff);
        padding: 10px;
        overflow: auto;
      }

      .details-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }

      .details-title {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }

      .details-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
      }

      .details-callsign {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        color: var(--dominds-muted, #666666);
      }

      .details-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }

      .details-action {
        border: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 10px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
      }

      .details-action:hover {
        border-color: var(--dominds-primary, #007acc);
      }

      .details-grid {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .details-row {
        display: flex;
        gap: 10px;
        font-size: 12px;
      }

      .details-row .k {
        width: 110px;
        color: var(--dominds-muted, #666666);
        flex-shrink: 0;
      }

      .details-row .v {
        flex: 1;
        min-width: 0;
        color: var(--dominds-fg, #333333);
        word-break: break-word;
      }

      .empty-state {
        padding: 14px 10px;
        border: 1px dashed rgba(224, 224, 224, 0.9);
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.01);
      }

      .empty-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dominds-fg, #333333);
        margin-bottom: 4px;
      }

      .empty-text {
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        line-height: 1.4;
      }

      .loading-overlay {
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.65);
        color: var(--dominds-muted, #666666);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        z-index: 10;
        border-radius: 10px;
      }

      @media (prefers-color-scheme: dark) {
        .loading-overlay {
          background: rgba(0, 0, 0, 0.35);
        }
      }
    `;
  }
}

// Register the custom element
if (!customElements.get('dominds-team-members')) {
  customElements.define('dominds-team-members', DomindsTeamMembers);
}
