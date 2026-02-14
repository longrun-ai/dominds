import hljs from 'highlight.js';

/**
 * Custom Web Component for Syntax Highlighted Code Blocks
 */
export class DomindsCodeBlock extends HTMLElement {
  private _language: string = '';
  private _code: string = '';

  static get observedAttributes() {
    return ['language'];
  }

  constructor() {
    super();
    this.style.display = 'block';
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (name === 'language' && oldValue !== newValue) {
      this._language = newValue;
      this.render();
    }
  }

  public set code(value: string) {
    this._code = value;
    this.render();
  }

  public get code(): string {
    return this._code;
  }

  /**
   * Public API: Append a code chunk and re-render
   */
  public appendChunk(chunk: string): void {
    this._code += chunk;
    this.render();
  }

  private render() {
    // If we have no code yet, try to get it from textContent
    if (!this._code && this.textContent) {
      // Preserve exact leading whitespace; trimming shifts the first line left.
      this._code = this.textContent;
    }

    if (!this._code) return;

    const language = this._language || 'plaintext';

    try {
      const highlighted = hljs.getLanguage(language)
        ? hljs.highlight(this._code, { language }).value
        : hljs.highlightAuto(this._code).value;

      this.innerHTML = `
        <style>
          dominds-code-block {
            margin: 0.75em 0;
            border-radius: 6px;
            overflow: hidden;
            background: var(--dominds-bg-secondary, var(--color-bg-secondary, #ffffff));
            border: 1px solid var(--dominds-border, var(--color-border-primary, #e5e5e5));
            font-size: var(--dominds-font-size-sm, 12px);
            line-height: var(--dominds-line-height-dense, 1.24);
          }
          .code-block-wrapper {
            display: flex;
            flex-direction: column;
          }
          .code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 2px 3px;
            background: var(--color-bg-tertiary, #f2f2f2);
            border-bottom: 1px solid var(--dominds-border, var(--color-border-primary, #e5e5e5));
            color: var(--dominds-muted, var(--color-fg-tertiary, #616161));
            font-size: var(--dominds-font-size-xs, 11px);
            font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
          }
          .copy-btn {
            background: transparent;
            border: 1px solid var(--dominds-border, var(--color-border-primary, #e5e5e5));
            border-radius: 4px;
            color: var(--dominds-fg, var(--color-fg-primary, #3b3b3b));
            cursor: pointer;
            padding: 1px 3px;
            font-size: var(--dominds-font-size-xs, 11px);
            transition: all 0.2s;
          }
          .copy-btn:hover {
            background: var(--dominds-hover, var(--color-bg-tertiary, #f2f2f2));
            border-color: var(--dominds-primary, var(--color-accent-primary, #005fb8));
          }
          pre {
            margin: 0;
            padding: 2px 3px;
            font-size: var(--dominds-font-size-sm, 12px);
            line-height: var(--dominds-line-height-dense, 1.24);
            background: var(--dominds-bg, var(--color-bg-primary, #f8f8f8));
            overflow: auto;
          }
          code.hljs {
            padding: 0;
            background: transparent;
            color: var(--dominds-fg, var(--color-fg-primary, #3b3b3b));
          }
        </style>
        <div class="code-block-wrapper">
          <div class="code-header">
            <span class="language">${language}</span>
            <button class="copy-btn" title="Copy code" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.querySelector('code').textContent)">📋</button>
          </div>
          <pre><code class="hljs language-${language}">${highlighted}</code></pre>
        </div>
      `;
    } catch (error) {
      console.error('Highlighting error:', error);
      this.innerHTML = `<pre><code>${this._code}</code></pre>`;
    }
  }
}

if (!customElements.get('dominds-code-block')) {
  customElements.define('dominds-code-block', DomindsCodeBlock);
}
