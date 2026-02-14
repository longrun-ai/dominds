import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import { renderDomindsMarkdown } from './dominds-markdown-render';

import { normalizeLanguageCode, type LanguageCode } from '../shared/types/language';

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

type DocsLinkTarget = {
  readonly docName: string;
  readonly language: LanguageCode;
  readonly anchorId: string | null;
};

function buildDocTabs(): readonly DocTab[] {
  return [
    {
      key: 'terminology',
      titleI18n: { zh: '术语', en: 'Terminology' },
      docName: 'dominds-terminology',
    },
    {
      key: 'memory-system',
      titleI18n: { zh: '分层记忆系统', en: 'Hierarchical Memory System' },
      docName: 'memory-system',
    },
    {
      key: 'cli-usage',
      titleI18n: { zh: 'CLI 使用指南', en: 'CLI Usage Guide' },
      docName: 'cli-usage',
    },
    {
      key: 'q4h',
      titleI18n: { zh: 'Q4H', en: 'Q4H' },
      docName: 'q4h',
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
      key: 'fbr',
      titleI18n: { zh: 'FBR（扪心自问）', en: 'FBR (Fresh Boots Reasoning)' },
      docName: 'fbr',
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
      key: 'dominds-agent-priming',
      titleI18n: { zh: '智能体启动', en: 'Agent Priming' },
      docName: 'dominds-agent-priming',
    },
    {
      key: 'design',
      titleI18n: { zh: 'Dominds 设计', en: 'Dominds Design' },
      docName: 'design',
    },
    {
      key: 'roadmap',
      titleI18n: { zh: '发展规划', en: 'Roadmap' },
      docName: 'roadmap',
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
  private docLanguageOverride: LanguageCode | null = null;
  private pendingScrollAnchorId: string | null = null;

  static get observedAttributes(): string[] {
    return ['ui-language'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name !== 'ui-language') return;
    const parsed = normalizeLanguageCode(newValue || '');
    if (!parsed) return;
    if (parsed === this.uiLanguage) return;

    // If we're not connected yet, just stash the new language. `connectedCallback()`
    // will render and load using the latest attribute value.
    if (!this.isConnected) {
      this.uiLanguage = parsed;
      return;
    }

    this.setUiLanguage(parsed);
  }

  connectedCallback(): void {
    const parsed = normalizeLanguageCode(this.getAttribute('ui-language') || '');
    if (parsed) this.uiLanguage = parsed;
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
    const language = this.docLanguageOverride ?? this.uiLanguage;
    const key = `${active.key}:${language}:${active.docName}`;
    if (this.inFlightKey === key) return;
    this.inFlightKey = key;
    this.fetchState = { kind: 'loading' };
    this.render();

    try {
      const api = getApiClient();
      const resp = await api.readDocsMarkdown(active.docName, language);
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
      this.scrollToPendingAnchorIfAny();
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
    this.docLanguageOverride = null;
    this.pendingScrollAnchorId = null;
    this.fetchState = { kind: 'idle' };
    this.render();
    void this.ensureLoaded();
  }

  private ensureTabForDocName(docName: string): string {
    const existing = this.docsTabs.find((t) => t.docName === docName);
    if (existing) return existing.key;

    const isSafeDocName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(docName);
    if (!isSafeDocName) {
      return this.docsTabs[0]?.key ?? this.selectedTabKey;
    }

    const baseKey = `doc:${docName}`;
    let key = baseKey;
    let i = 2;
    while (this.docsTabs.some((t) => t.key === key)) {
      key = `${baseKey}:${i}`;
      i += 1;
    }

    const newTab: DocTab = {
      key,
      titleI18n: { zh: docName, en: docName },
      docName,
    };
    this.docsTabs = [...this.docsTabs, newTab];
    return key;
  }

  private parseDocsLinkTarget(href: string): DocsLinkTarget | null {
    if (href.startsWith('#')) return null;

    const [rawPathPart, rawHashPart] = href.split('#', 2);
    const pathPart = rawPathPart ?? '';
    if (!pathPart) return null;

    const fileName = pathPart.split('/').filter(Boolean).pop();
    if (!fileName) return null;

    const mdExt = '.md';
    const zhSuffix = '.zh.md';

    let docName: string | null = null;
    let language: LanguageCode | null = null;
    if (fileName.endsWith(zhSuffix)) {
      docName = fileName.slice(0, -zhSuffix.length);
      language = 'zh';
    } else if (fileName.endsWith(mdExt)) {
      docName = fileName.slice(0, -mdExt.length);
      language = 'en';
    } else {
      return null;
    }

    const isSafeDocName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(docName);
    if (!isSafeDocName) return null;

    let anchorId: string | null = null;
    if (typeof rawHashPart === 'string' && rawHashPart) {
      try {
        anchorId = decodeURIComponent(rawHashPart);
      } catch {
        anchorId = rawHashPart;
      }
      if (anchorId === '') anchorId = null;
    }

    return { docName, language, anchorId };
  }

  private isExternalLink(href: string): boolean {
    // Allowlist: links with these schemes are treated as "external".
    return (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    );
  }

  private openExternalLink(href: string): void {
    // Keep the current SPA URL stable: open external links in a new tab/window.
    window.open(href, '_blank', 'noopener,noreferrer');
  }

  private scrollToPendingAnchorIfAny(): void {
    if (!this.pendingScrollAnchorId) return;
    const id = this.pendingScrollAnchorId;
    this.pendingScrollAnchorId = null;
    this.scrollToAnchorId(id);
  }

  private scrollToAnchorId(id: string): void {
    const root = this.shadowRoot;
    if (!root) return;
    const body = root.querySelector('.docs-body');
    if (!(body instanceof HTMLElement)) return;
    const anchor = body.querySelector(`#${CSS.escape(id)}`);
    if (!(anchor instanceof HTMLElement)) return;
    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

        // Never allow markdown links inside the docs panel to navigate the whole SPA.
        // Best-effort: interpret doc links and open them in-panel; otherwise keep URL unchanged.
        e.preventDefault();

        if (href.startsWith('#')) {
          const idRaw = href.slice(1);
          if (!idRaw) return;
          let id = idRaw;
          try {
            id = decodeURIComponent(idRaw);
          } catch {
            // keep raw
          }
          if (!id) return;
          this.scrollToAnchorId(id);
          return;
        }

        if (this.isExternalLink(href)) {
          this.openExternalLink(href);
          return;
        }

        const docsTarget = this.parseDocsLinkTarget(href);
        if (!docsTarget) return;

        const tabKey = this.ensureTabForDocName(docsTarget.docName);
        this.selectedTabKey = tabKey;
        this.docLanguageOverride = docsTarget.language;
        this.pendingScrollAnchorId = docsTarget.anchorId;
        this.fetchState = { kind: 'idle' };
        this.render();
        void this.ensureLoaded();
      });
    }
  }

  private getStyles(): string {
    return `
      :host{display:flex;flex-direction:column;min-height:0;width:100%;}
      .docs{display:flex;flex-direction:column;min-height:0;width:100%;}
      .docs-tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:2px 8px;border-bottom:1px solid var(--color-border-primary,#e2e8f0);background:var(--color-bg-secondary,#f8fafc);}
      .docs-tab{appearance:none;border:1px solid var(--color-border-primary,#e2e8f0);background:var(--dominds-bg,#fff);color:var(--color-fg-secondary,#475569);border-radius:999px;padding:2px 8px;font-size: var(--dominds-font-size-sm, 12px);cursor:pointer;}
      .docs-tab.active{border-color:var(--dominds-primary,#007acc);color:var(--dominds-primary,#007acc);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 18%, transparent);}
      .docs-body{flex:1;min-height:0;overflow:auto;padding:3px 10px;background:var(--dominds-bg,#fff);}
      .doc-body{
        max-width:980px;
        font-size: var(--dominds-font-size-md, 13px);
        line-height: var(--dominds-line-height-dense, 1.4);
        color: var(--color-fg-secondary,#475569);
        word-break: break-word;
      }
      .doc-body p{margin-top:0;margin-bottom:0.4em;}
      .doc-body p:last-child{margin-bottom:0;}
      .doc-body ul,.doc-body ol{margin-top:0;margin-bottom:0.4em;padding-left:1.35em;}
      .doc-body li{margin-bottom:0.2em;}
      .doc-body h1,.doc-body h2,.doc-body h3,.doc-body h4,.doc-body h5,.doc-body h6{
        margin-top:0.75em;
        margin-bottom:0.2em;
        font-weight:600;
        line-height:var(--dominds-line-height-dense,1.4);
        color:var(--color-fg-primary,#1e293b);
      }
      .doc-body h1{font-size:calc(var(--dominds-font-size-base, 14px) + 3px);}
      .doc-body h2{font-size:calc(var(--dominds-font-size-base, 14px) + 1px);}
      .doc-body h3{font-size:calc(var(--dominds-font-size-base, 14px) + 1px);}
      .doc-body h4{font-size:var(--dominds-font-size-base, 14px);}
      .doc-body h5{font-size:var(--dominds-font-size-md, 13px);}
      .doc-body h6{font-size:var(--dominds-font-size-sm, 12px);}
      .doc-body h1:first-child,.doc-body h2:first-child,.doc-body h3:first-child{margin-top:0;}
      .doc-body blockquote{
        margin:0 0 0.4em 0;
        padding:0 0.8em;
        font-size:var(--dominds-font-size-md, 13px);
        color:var(--color-fg-tertiary,#64748b);
        border-left:0.25em solid var(--color-border-primary,#e2e8f0);
      }
      .doc-body code:not([class]){
        background-color:var(--color-bg-tertiary,#f1f5f9);
        padding:0.2em 0.4em;
        border-radius:4px;
        font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        font-size:90%;
      }
      .doc-body table{border-collapse:collapse;width:100%;margin-bottom:0.5em;}
      .doc-body th,.doc-body td{border:1px solid var(--color-border-primary,#e2e8f0);padding:5px 10px;}
      .doc-body tr:nth-child(2n){background-color:var(--color-bg-tertiary,#f8fafc);}
      .muted{color:var(--color-fg-tertiary,#64748b);font-size: var(--dominds-font-size-sm, 12px);}
      .error{color:var(--dominds-danger,#dc3545);font-size: var(--dominds-font-size-sm, 12px);white-space:pre-wrap;}
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
