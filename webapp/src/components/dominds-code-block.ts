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
            background: #0d1117;
            border: 1px solid #30363d;
          }
          .code-block-wrapper {
            display: flex;
            flex-direction: column;
          }
          .code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 16px;
            background: #161b22;
            border-bottom: 1px solid #30363d;
            color: #8b949e;
            font-size: calc(12px * var(--dominds-ui-scale, 1));
            font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
          }
          .copy-btn {
            background: transparent;
            border: 1px solid #30363d;
            border-radius: 4px;
            color: #c9d1d9;
            cursor: pointer;
            padding: 2px 8px;
            font-size: calc(14px * var(--dominds-ui-scale, 1));
            transition: all 0.2s;
          }
          .copy-btn:hover {
            background: #30363d;
            border-color: #8b949e;
          }
          pre {
            margin: 0;
            padding: 16px;
            overflow: auto;
          }
          code.hljs {
            padding: 0;
            background: transparent;
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
