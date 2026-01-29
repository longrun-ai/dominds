import {
  TEAM_MGMT_MANUAL_UI_TOOL_TOPICS_BY_KEY,
  TEAM_MGMT_MANUAL_UI_TOPIC_ORDER,
  type TeamMgmtManualTopicKey,
  getTeamMgmtManualTopicTitle,
  isTeamMgmtManualTopicKey,
} from '../../../main/shared/team-mgmt-manual';
import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import type { LanguageCode } from '../shared/types/language';
import { renderDomindsMarkdown } from './dominds-markdown-render';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; markdown: string }
  | { kind: 'error'; message: string };

type TopicKey = TeamMgmtManualTopicKey;

export class DomindsTeamManualPanel extends HTMLElement {
  private uiLanguage: LanguageCode = 'en';
  private selectedTopic: TopicKey = 'topics';
  private state: LoadState = { kind: 'idle' };

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
      const topics = TEAM_MGMT_MANUAL_UI_TOOL_TOPICS_BY_KEY[this.selectedTopic];
      const resp = await api.teamMgmtManual({ topics, uiLanguage: this.uiLanguage });
      if (!resp.success && resp.status === 401) {
        this.dispatchEvent(
          new CustomEvent('ui-toast', {
            detail: { message: t.unauthorized, kind: 'warning' },
            bubbles: true,
            composed: true,
          }),
        );
        this.dispatchEvent(new CustomEvent('auth-required', { bubbles: true, composed: true }));
      }
      if (!resp.success || !resp.data) {
        this.state = { kind: 'error', message: resp.error ?? t.teamMgmtLoadFailed };
        this.render();
        return;
      }
      const payload = resp.data;
      if (!payload.success || typeof payload.markdown !== 'string') {
        this.state = {
          kind: 'error',
          message: payload.success ? t.teamMgmtLoadFailed : payload.error,
        };
        this.render();
        return;
      }
      this.state = { kind: 'ready', markdown: payload.markdown };
      this.render();
    } catch (error: unknown) {
      this.state = {
        kind: 'error',
        message: error instanceof Error ? error.message : t.teamMgmtLoadFailed,
      };
      this.render();
    }
  }

  private onSelectTopic(topic: TopicKey): void {
    if (topic === this.selectedTopic) return;
    this.selectedTopic = topic;
    void this.load();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const t = getUiStrings(this.uiLanguage);

    const topicButtons: Array<{ key: TopicKey; label: string }> =
      TEAM_MGMT_MANUAL_UI_TOPIC_ORDER.map((key) => ({
        key,
        label: getTeamMgmtManualTopicTitle(this.uiLanguage, key),
      }));

    const topicsHtml = topicButtons
      .map((item) => {
        const active = item.key === this.selectedTopic;
        return `<button type="button" class="topic ${active ? 'active' : ''}" data-topic="${item.key}">${item.label}</button>`;
      })
      .join('');

    let bodyHtml = '';
    if (this.state.kind === 'loading') {
      bodyHtml = `<div class="muted">${this.escapeHtml(t.loading)}</div>`;
    } else if (this.state.kind === 'error') {
      bodyHtml = `<div class="error">${this.escapeHtml(this.state.message)}</div>`;
    } else if (this.state.kind === 'ready') {
      bodyHtml = `<div class="doc-body">${renderDomindsMarkdown(this.state.markdown, { kind: 'chat' })}</div>`;
    } else {
      bodyHtml = `<div class="muted">—</div>`;
    }

    root.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="wrap">
        <div class="topics">
          <div class="topics-buttons">${topicsHtml}</div>
        </div>
        <div class="body">${bodyHtml}</div>
      </div>
    `;

    root.querySelectorAll<HTMLButtonElement>('button.topic').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.topic;
        if (typeof raw === 'string' && isTeamMgmtManualTopicKey(raw)) {
          this.onSelectTopic(raw);
        }
      });
    });

    const body = root.querySelector('.body');
    if (body instanceof HTMLElement) {
      body.addEventListener('click', (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('a');
        if (!(link instanceof HTMLAnchorElement)) return;
        const href = link.getAttribute('href');
        if (typeof href !== 'string') return;
        if (!href.startsWith('#')) return;
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // keep raw
        }
        if (!id) {
          e.preventDefault();
          return;
        }
        const anchor = body.querySelector(`#${CSS.escape(id)}`);
        e.preventDefault();
        if (!(anchor instanceof HTMLElement)) return;
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  private getStyles(): string {
    return `
      :host{display:flex;flex-direction:column;min-height:0;width:100%;}
      .wrap{display:flex;flex-direction:column;min-height:0;width:100%;}
      .topics{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--color-border-primary,#e2e8f0);background:var(--color-bg-secondary,#f8fafc);}
      .topics-buttons{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
      .topic{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer;}
      .topic.active{border-color:var(--dominds-primary,#007acc);color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 18%, transparent);}
      .body{flex:1;min-height:0;overflow:auto;padding:10px 12px;background:var(--dominds-bg,#fff);}
      .doc-body{max-width:980px;}
      .muted{color:var(--color-fg-tertiary,#64748b);font-size:12px;}
      .error{color:var(--dominds-danger,#dc3545);font-size:12px;white-space:pre-wrap;}
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

if (!customElements.get('dominds-team-manual-panel')) {
  customElements.define('dominds-team-manual-panel', DomindsTeamManualPanel);
}
