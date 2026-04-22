import hljs from 'highlight.js';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';
import {
  getProgressiveExpandLabel,
  resolveProgressiveExpandStepParent,
  setupProgressiveExpandBehavior,
  type ProgressiveExpandState,
} from './progressive-expand';

/**
 * Custom Web Component for Syntax Highlighted Code Blocks
 */
export class DomindsCodeBlock extends HTMLElement {
  private _language: string = '';
  private _code: string = '';
  private progressiveExpandCleanup: (() => void) | null = null;
  private progressiveExpandState: ProgressiveExpandState = { kind: 'initial' };

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

  disconnectedCallback() {
    this.progressiveExpandCleanup?.();
    this.progressiveExpandCleanup = null;
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
          ${ICON_MASK_BASE_CSS}
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
            width: 18px;
            height: 18px;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
          }
          .copy-btn .icon-mask {
            width: 11px;
            height: 11px;
            --icon-mask: ${ICON_MASK_URLS.copy};
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
          .code-expand-footer {
            --code-expand-border: var(
              --dominds-border,
              var(--color-border-primary, #e5e5e5)
            );
            --code-expand-tab-bg: var(
              --dominds-bg-secondary,
              var(--color-bg-secondary, #ffffff)
            );
            --code-expand-tab-height: 23px;
            position: relative;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 0;
            margin-top: 0;
            height: 3px;
            min-height: 3px;
            overflow: visible;
            border-top: 1px solid var(--code-expand-border);
            background: transparent;
          }
          .code-expand-footer.is-hidden {
            display: none;
          }
          .code-expand-btn {
            position: relative;
            transform: translateY(calc(-1 * var(--code-expand-tab-height)));
            width: 30px;
            height: var(--code-expand-tab-height);
            border-radius: 12px 12px 0 0;
            border: 1px solid var(--code-expand-border);
            border-bottom: 0;
            background: var(--code-expand-tab-bg);
            color: var(--dominds-muted, var(--color-fg-tertiary, #616161));
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition:
              background 0.2s ease,
              border-color 0.2s ease,
              color 0.2s ease;
          }
          .code-expand-btn:hover {
            border-color: var(--dominds-primary, var(--color-accent-primary, #005fb8));
            color: var(--dominds-primary, var(--color-accent-primary, #005fb8));
            background: color-mix(
              in srgb,
              var(--dominds-bg-secondary, #ffffff) 85%,
              var(--dominds-primary, #005fb8) 15%
            );
          }
          .code-expand-btn:focus-visible {
            outline: 2px solid var(--dominds-primary, var(--color-accent-primary, #005fb8));
            outline-offset: 1px;
          }
          .code-expand-icon {
            width: 15px;
            height: 15px;
            --icon-mask: ${ICON_MASK_URLS.chevronsDown};
            animation: progressive-expand-flash 2.2s ease-in-out infinite;
          }
          .code-expand-btn:hover .code-expand-icon,
          .code-expand-btn:focus-visible .code-expand-icon {
            animation-play-state: paused;
          }
          code.hljs {
            padding: 0;
            background: transparent;
            color: var(--dominds-fg, var(--color-fg-primary, #3b3b3b));
          }
          @keyframes progressive-expand-flash {
            0%,
            100% {
              opacity: 0.5;
              transform: translateY(0);
            }
            35% {
              opacity: 1;
              transform: translateY(1px);
            }
            60% {
              opacity: 0.75;
              transform: translateY(3px);
            }
          }
        </style>
        <div class="code-block-wrapper">
          <div class="code-header">
            <span class="language">${language}</span>
            <button class="copy-btn" title="Copy code" aria-label="Copy code" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.querySelector('code').textContent)"><span class="icon-mask" aria-hidden="true"></span></button>
          </div>
          <pre><code class="hljs language-${language}">${highlighted}</code></pre>
          <div class="code-expand-footer is-hidden">
            <button type="button" class="code-expand-btn">
              <span class="code-expand-icon icon-mask" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      `;
      this.setupProgressiveExpand();
    } catch (error) {
      console.error('Highlighting error:', error);
      this.innerHTML = `<pre><code>${this._code}</code></pre>`;
    }
  }

  private setupProgressiveExpand(): void {
    const target = this.querySelector('pre');
    const footer = this.querySelector('.code-expand-footer');
    const button = this.querySelector('.code-expand-btn');
    if (!(target instanceof HTMLElement)) return;
    if (!(footer instanceof HTMLElement)) return;
    if (!(button instanceof HTMLButtonElement)) return;

    const stepParent = resolveProgressiveExpandStepParent(this);
    const language = this.closest('[lang]')?.getAttribute('lang') ?? 'en';
    this.progressiveExpandCleanup?.();
    this.progressiveExpandCleanup = setupProgressiveExpandBehavior({
      target,
      footer,
      button,
      stepParent,
      label: getProgressiveExpandLabel(language),
      // Code blocks can keep growing while streaming output arrives. Observe only the code block
      // itself while its expand footer is hidden; never infer or observe parent containers here.
      observeTargetUntilOverflow: true,
      state: this.progressiveExpandState,
      onStateChange: (state) => {
        this.progressiveExpandState = state;
      },
    });
  }
}

if (!customElements.get('dominds-code-block')) {
  customElements.define('dominds-code-block', DomindsCodeBlock);
}
