import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import { renderDomindsMarkdown } from './dominds-markdown-render';

import type { LanguageCode } from '../shared/types/language';

type DocTab = {
  readonly key: string;
  readonly titleI18n: Readonly<Record<LanguageCode, string>>;
  readonly docName: string;
};

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; raw: string }
  | { kind: 'error'; message: string };

function buildDocTabs(): readonly DocTab[] {
  return [
    {
      key: 'terminology',
      titleI18n: { zh: '术语', en: 'Terminology' },
      docName: 'dominds-terminology',
    },
    {
      key: 'memory-system',
      titleI18n: { zh: '记忆系统', en: 'Memory System' },
      docName: 'memory-system',
    },
    {
      key: 'cli-usage',
      titleI18n: { zh: 'CLI 使用指南', en: 'CLI Usage Guide' },
      docName: 'cli-usage',
    },
    {
      key: 'mcp-support',
      titleI18n: { zh: 'MCP 支持', en: 'MCP Support' },
      docName: 'mcp-support',
    },
    {
      key: 'encapsulated-taskdocs',
      titleI18n: { zh: '差遣牒（Taskdoc）封装', en: 'Encapsulated Taskdocs' },
      docName: 'encapsulated-taskdoc',
    },
    {
      key: 'context-health',
      titleI18n: { zh: '上下文健康', en: 'Context Health' },
      docName: 'context-health',
    },
    {
      key: 'diligence-push',
      titleI18n: { zh: '鞭策机制', en: 'Diligence Push' },
      docName: 'diligence-push',
    },
    {
      key: 'design',
      titleI18n: { zh: 'Dominds 设计', en: 'Dominds Design' },
      docName: 'design',
    },
    {
      key: 'mottos',
      titleI18n: { zh: '警世名言', en: 'Mottos' },
      docName: 'mottos',
    },
    {
      key: 'oec-philosophy',
      titleI18n: { zh: 'OEC 哲学', en: 'OEC Philosophy' },
      docName: 'OEC-philosophy',
    },
  ] as const;
}

export class DomindsDocsPanel extends HTMLElement {
  private uiLanguage: LanguageCode = 'en';
  private docsTabs: readonly DocTab[] = buildDocTabs();
  private selectedTabKey: string = this.docsTabs[0]?.key ?? 'design';
  private fetchState: FetchState = { kind: 'idle' };
  private inFlightKey: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    void this.ensureLoaded();
  }

  public setUiLanguage(language: LanguageCode): void {
    this.uiLanguage = language;
    this.render();
    void this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    const active = this.docsTabs.find((t) => t.key === this.selectedTabKey) ?? this.docsTabs[0];
    if (!active) return;
    const key = `${active.key}:${this.uiLanguage}:${active.docName}`;
    if (this.inFlightKey === key) return;
    this.inFlightKey = key;
    this.fetchState = { kind: 'loading' };
    this.render();

    try {
      const api = getApiClient();
      const resp = await api.readDocsMarkdown(active.docName, this.uiLanguage);
      if (!resp.success) {
        const t = getUiStrings(this.uiLanguage);
        if (resp.status === 401) {
          this.fetchState = { kind: 'error', message: t.unauthorized };
        } else {
          const statusText = typeof resp.status === 'number' ? `HTTP ${resp.status}` : 'HTTP error';
          this.fetchState = { kind: 'error', message: resp.error ?? statusText };
        }
        this.render();
        return;
      }
      const payload = resp.data;
      if (!payload || !payload.success || typeof payload.raw !== 'string') {
        this.fetchState = { kind: 'error', message: payload?.error ?? 'Invalid response' };
        this.render();
        return;
      }
      this.fetchState = { kind: 'ready', raw: payload.raw };
      this.render();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.fetchState = { kind: 'error', message: msg };
      this.render();
    } finally {
      this.inFlightKey = null;
    }
  }

  private onSelectTab(key: string): void {
    if (key === this.selectedTabKey) return;
    this.selectedTabKey = key;
    this.fetchState = { kind: 'idle' };
    this.render();
    void this.ensureLoaded();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const tabsHtml = this.docsTabs
      .map((tab) => {
        const active = tab.key === this.selectedTabKey;
        const title = tab.titleI18n[this.uiLanguage];
        return `<button class="docs-tab ${active ? 'active' : ''}" type="button" data-doc-key="${tab.key}">${title}</button>`;
      })
      .join('');

    let bodyHtml = '';
    if (this.fetchState.kind === 'loading') {
      const t = getUiStrings(this.uiLanguage);
      bodyHtml = `<div class="muted">${this.escapeHtml(t.loading)}</div>`;
    } else if (this.fetchState.kind === 'error') {
      bodyHtml = `<div class="error">${this.escapeHtml(this.fetchState.message)}</div>`;
    } else if (this.fetchState.kind === 'ready') {
      bodyHtml = `<div class="doc-body">${renderDomindsMarkdown(this.fetchState.raw, { kind: 'chat' })}</div>`;
    } else {
      bodyHtml = `<div class="muted">—</div>`;
    }

    root.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="docs">
        <div class="docs-tabs" role="tablist">${tabsHtml}</div>
        <div class="docs-body">${bodyHtml}</div>
      </div>
    `;

    root.querySelectorAll<HTMLButtonElement>('button.docs-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.docKey;
        if (typeof k === 'string' && k) this.onSelectTab(k);
      });
    });

    const body = root.querySelector('.docs-body');
    if (body instanceof HTMLElement) {
      body.addEventListener('click', (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('a');
        if (!(link instanceof HTMLAnchorElement)) return;
        const href = link.getAttribute('href');
        if (typeof href !== 'string') return;
        // Prevent internal ToC links (e.g. #中文标题) from being treated as normal navigation.
        // Even if we can't locate the target heading, keep the browser on the same page.
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
      .docs{display:flex;flex-direction:column;min-height:0;width:100%;}
      .docs-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px;border-bottom:1px solid var(--color-border-primary,#e2e8f0);background:var(--color-bg-secondary,#f8fafc);}
      .docs-tab{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer;}
      .docs-tab.active{border-color:var(--dominds-primary,#007acc);color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 18%, transparent);}
      .docs-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;background:var(--dominds-bg,#fff);}
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

if (!customElements.get('dominds-docs-panel')) {
  customElements.define('dominds-docs-panel', DomindsDocsPanel);
}
