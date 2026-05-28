import hljs from 'highlight.js';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';
import {
  getProgressiveExpandLabel,
  resolveProgressiveExpandStepParent,
  setupDownwardProgressiveExpandBehavior,
  type ProgressiveExpandState,
} from './progressive-expand';

export const DOMINDS_CODE_BLOCK_CODE_ATTR = 'data-code';

type ManualCopyTexts = {
  copyCode: string;
  title: string;
  close: string;
  selectAll: string;
  insecureHttpMessage: string;
  unavailableMessage: string;
};

const MANUAL_COPY_TEXTS: Record<'zh' | 'en', ManualCopyTexts> = {
  zh: {
    copyCode: '复制代码',
    title: '需要手动复制',
    close: '关闭',
    selectAll: '全选文本',
    insecureHttpMessage:
      '当前页面通过 HTTP 非 localhost 地址访问，浏览器不会开放剪贴板权限。请在下方只读文本框中手动全选并复制。',
    unavailableMessage: '浏览器当前没有开放剪贴板写入权限。请在下方只读文本框中手动全选并复制。',
  },
  en: {
    copyCode: 'Copy code',
    title: 'Manual copy required',
    close: 'Close',
    selectAll: 'Select all',
    insecureHttpMessage:
      'This page is loaded over HTTP from a non-localhost address, so the browser does not expose clipboard access. Select and copy the read-only text below manually.',
    unavailableMessage:
      'The browser has not granted clipboard write access. Select and copy the read-only text below manually.',
  },
};

const manualCopyModalCleanups = new WeakMap<HTMLElement, () => void>();

export function encodeDomindsCodeBlockDataCode(code: string): string {
  return encodeURIComponent(code);
}

export function decodeDomindsCodeBlockDataCode(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error(`Invalid ${DOMINDS_CODE_BLOCK_CODE_ATTR} on dominds-code-block.`);
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toLanguageClassToken(language: string): string {
  const token = language.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return token.length > 0 ? token : 'plaintext';
}

function isLocalClipboardHost(hostname: string): boolean {
  const loopbackIpv4Match = /^127(?:\.\d{1,3}){3}$/.test(hostname);
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    loopbackIpv4Match ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function getManualCopyTexts(language: string): ManualCopyTexts {
  return language.toLowerCase().startsWith('zh') ? MANUAL_COPY_TEXTS.zh : MANUAL_COPY_TEXTS.en;
}

function getElementLanguage(element: Element): string {
  const langElement = element.closest('[lang]');
  if (!(langElement instanceof Element)) return 'en';
  return langElement.getAttribute('lang') ?? 'en';
}

function getManualCopyMessage(texts: ManualCopyTexts): string {
  if (window.location.protocol === 'http:' && !isLocalClipboardHost(window.location.hostname)) {
    return texts.insecureHttpMessage;
  }

  return texts.unavailableMessage;
}

function showManualCopyModal(
  text: string,
  language: string,
  restoreFocusTo: HTMLElement | null,
): void {
  const texts = getManualCopyTexts(language);
  const existing = document.querySelector('[data-dominds-manual-copy-modal="true"]');
  if (existing instanceof HTMLElement) {
    const cleanup = manualCopyModalCleanups.get(existing);
    if (cleanup) {
      cleanup();
    } else {
      existing.remove();
    }
  }

  const modal = document.createElement('div');
  modal.dataset.domindsManualCopyModal = 'true';
  modal.innerHTML = `
    <style>
      ${ICON_MASK_BASE_CSS}
      [data-dominds-manual-copy-modal="true"] {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        min-height: 0;
        box-sizing: border-box;
        font-family: var(--dominds-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.38);
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-dialog {
        position: relative;
        z-index: 1;
        width: min(720px, 100%);
        max-height: calc(100vh - 40px);
        display: flex;
        flex-direction: column;
        background: var(--dominds-bg-secondary, var(--color-bg-secondary, #ffffff));
        color: var(--dominds-fg, var(--color-fg-primary, #242424));
        border: 1px solid var(--dominds-border, var(--color-border-primary, #d6d6d6));
        border-radius: 8px;
        box-shadow: 0 18px 54px rgba(0, 0, 0, 0.22);
        overflow: hidden;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--dominds-border, var(--color-border-primary, #e5e5e5));
        background: var(--color-bg-tertiary, #f6f6f6);
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-title {
        margin: 0;
        font-size: 14px;
        line-height: 1.35;
        font-weight: 650;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-close {
        width: 28px;
        height: 28px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #d6d6d6));
        border-radius: 6px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-close .icon-mask {
        width: 14px;
        height: 14px;
        --icon-mask: ${ICON_MASK_URLS.close};
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-close:hover,
      [data-dominds-manual-copy-modal="true"] .manual-copy-close:focus-visible {
        border-color: var(--dominds-primary, var(--color-accent-primary, #005fb8));
        outline: none;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        flex: 1 1 auto;
        min-height: 0;
        padding: 14px;
        overflow: hidden;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-message {
        margin: 0;
        color: var(--dominds-muted, var(--color-fg-secondary, #525252));
        font-size: 13px;
        line-height: 1.45;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-text {
        width: 100%;
        min-height: min(260px, 42vh);
        box-sizing: border-box;
        flex: 1 1 auto;
        resize: vertical;
        padding: 10px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #d6d6d6));
        border-radius: 6px;
        background: var(--dominds-bg, var(--color-bg-primary, #fbfbfb));
        color: var(--dominds-fg, var(--color-fg-primary, #242424));
        font: 12px/1.45 ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
        white-space: pre;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-footer {
        display: flex;
        justify-content: flex-end;
        padding: 0 14px 14px;
      }
      [data-dominds-manual-copy-modal="true"] .manual-copy-select {
        border: 1px solid var(--dominds-primary, var(--color-accent-primary, #005fb8));
        border-radius: 6px;
        background: var(--dominds-primary, var(--color-accent-primary, #005fb8));
        color: #ffffff;
        padding: 6px 12px;
        font-size: 13px;
        cursor: pointer;
      }
    </style>
    <div class="manual-copy-backdrop"></div>
    <div class="manual-copy-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-copy-title" aria-describedby="manual-copy-message">
      <div class="manual-copy-header">
        <h3 class="manual-copy-title" id="manual-copy-title">${escapeHtmlText(texts.title)}</h3>
        <button class="manual-copy-close" type="button" aria-label="${escapeHtmlText(
          texts.close,
        )}" title="${escapeHtmlText(texts.close)}">
          <span class="icon-mask" aria-hidden="true"></span>
        </button>
      </div>
      <div class="manual-copy-body">
        <p class="manual-copy-message" id="manual-copy-message">${escapeHtmlText(getManualCopyMessage(texts))}</p>
        <textarea class="manual-copy-text" readonly spellcheck="false"></textarea>
      </div>
      <div class="manual-copy-footer">
        <button class="manual-copy-select" type="button">${escapeHtmlText(texts.selectAll)}</button>
      </div>
    </div>
  `;

  const close = (): void => {
    document.removeEventListener('keydown', onDocumentKeydown, true);
    manualCopyModalCleanups.delete(modal);
    modal.remove();
    if (restoreFocusTo !== null && restoreFocusTo.isConnected) {
      restoreFocusTo.focus();
    }
  };

  const closeButton = modal.querySelector('.manual-copy-close');
  const backdrop = modal.querySelector('.manual-copy-backdrop');
  const selectButton = modal.querySelector('.manual-copy-select');
  const textarea = modal.querySelector('.manual-copy-text');
  if (!(closeButton instanceof HTMLButtonElement)) {
    throw new Error('Manual copy modal close button missing.');
  }
  if (!(backdrop instanceof HTMLElement)) {
    throw new Error('Manual copy modal backdrop missing.');
  }
  if (!(selectButton instanceof HTMLButtonElement)) {
    throw new Error('Manual copy modal select button missing.');
  }
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Manual copy modal textarea missing.');
  }

  const closeButtonEl = closeButton;
  const backdropEl = backdrop;
  const selectButtonEl = selectButton;
  const textareaEl = textarea;

  textareaEl.value = text;
  const selectText = (): void => {
    textareaEl.focus();
    textareaEl.select();
  };

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements: readonly HTMLElement[] = [closeButtonEl, textareaEl, selectButtonEl];
    const activeElement = document.activeElement;
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (
      activeElement !== closeButtonEl &&
      activeElement !== textareaEl &&
      activeElement !== selectButtonEl
    ) {
      event.preventDefault();
      if (event.shiftKey) {
        last.focus();
      } else {
        first.focus();
      }
      return;
    }
    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closeButtonEl.addEventListener('click', close);
  backdropEl.addEventListener('click', close);
  selectButtonEl.addEventListener('click', selectText);
  document.addEventListener('keydown', onDocumentKeydown, true);
  manualCopyModalCleanups.set(modal, close);
  document.body.appendChild(modal);
  selectText();
}

async function copyTextToClipboard(
  text: string,
  language: string,
  restoreFocusTo: HTMLElement | null,
): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  showManualCopyModal(text, language, restoreFocusTo);
}

/**
 * Custom Web Component for Syntax Highlighted Code Blocks
 */
export class DomindsCodeBlock extends HTMLElement {
  private _language: string = '';
  private _code: string = '';
  private hasCodeSource: boolean = false;
  private progressiveExpandCleanup: (() => void) | null = null;
  private progressiveExpandState: ProgressiveExpandState = { kind: 'initial' };

  static get observedAttributes() {
    return ['language', DOMINDS_CODE_BLOCK_CODE_ATTR];
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
    if (oldValue === newValue) return;
    switch (name) {
      case 'language':
        this._language = newValue;
        this.render();
        return;
      case DOMINDS_CODE_BLOCK_CODE_ATTR:
        this.setCodeSource(decodeDomindsCodeBlockDataCode(newValue ?? ''));
        this.render();
        return;
    }
  }

  private setCodeSource(value: string): void {
    this._code = value;
    this.hasCodeSource = true;
  }

  public set code(value: string) {
    this.setCodeSource(value);
    this.render();
  }

  public get code(): string {
    return this._code;
  }

  /**
   * Public API: Append a code chunk and re-render
   */
  public appendChunk(chunk: string): void {
    this.setCodeSource(this._code + chunk);
    this.render();
  }

  private readCodeAttribute(): string | null {
    const encoded = this.getAttribute(DOMINDS_CODE_BLOCK_CODE_ATTR);
    if (encoded === null) return null;
    return decodeDomindsCodeBlockDataCode(encoded);
  }

  private render() {
    if (!this.hasCodeSource) {
      const codeFromAttribute = this.readCodeAttribute();
      if (codeFromAttribute !== null) {
        this.setCodeSource(codeFromAttribute);
      }
    }

    if (!this.hasCodeSource) return;

    const language = this._language || 'plaintext';
    const texts = getManualCopyTexts(getElementLanguage(this));
    const languageLabel = escapeHtmlText(language);
    const languageClassToken = toLanguageClassToken(language);

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
            padding: 0;
            margin-top: 0;
            height: 3px;
            min-height: 3px;
            overflow: visible;
            background: transparent;
          }
          .code-expand-footer-down {
            align-items: flex-start;
            border-top: 1px solid var(--code-expand-border);
          }
          .code-expand-footer.is-hidden {
            display: none;
          }
          .code-expand-btn {
            position: relative;
            width: 30px;
            height: var(--code-expand-tab-height);
            border: 1px solid var(--code-expand-border);
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
          .code-expand-btn-down {
            transform: translateY(calc(-1 * var(--code-expand-tab-height)));
            border-bottom: 0;
            border-radius: 12px 12px 0 0;
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
          }
          .code-expand-icon-down {
            animation: progressive-expand-flash-down 2.2s ease-in-out infinite;
            --icon-mask: ${ICON_MASK_URLS.chevronsDown};
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
          @keyframes progressive-expand-flash-down {
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
            <span class="language">${languageLabel}</span>
            <button class="copy-btn" title="${escapeHtmlText(texts.copyCode)}" aria-label="${escapeHtmlText(texts.copyCode)}"><span class="icon-mask" aria-hidden="true"></span></button>
          </div>
          <pre><code class="hljs language-${languageClassToken}">${highlighted}</code></pre>
          <div class="code-expand-footer code-expand-footer-down is-hidden">
            <button type="button" class="code-expand-btn code-expand-btn-down">
              <span class="code-expand-icon code-expand-icon-down icon-mask" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      `;
      this.setupCopyButton();
      this.setupProgressiveExpand();
    } catch (error) {
      console.error('Highlighting error:', error);
      this.innerHTML = `<pre><code>${escapeHtmlText(this._code)}</code></pre>`;
    }
  }

  private setupCopyButton(): void {
    const button = this.querySelector('.copy-btn');
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener('click', () => {
      const language = getElementLanguage(this);
      void copyTextToClipboard(this._code, language, button).catch((error: unknown) => {
        console.error('Copy code failed:', error);
        showManualCopyModal(this._code, language, button);
      });
    });
  }

  private setupProgressiveExpand(): void {
    const target = this.querySelector('pre');
    const footer = this.querySelector('.code-expand-footer');
    const button = this.querySelector('.code-expand-btn');
    if (!(target instanceof HTMLElement)) return;
    if (!(footer instanceof HTMLElement)) return;
    if (!(button instanceof HTMLButtonElement)) return;

    const stepParent = resolveProgressiveExpandStepParent(this);
    const language = getElementLanguage(this);
    this.progressiveExpandCleanup?.();
    this.progressiveExpandCleanup = setupDownwardProgressiveExpandBehavior({
      target,
      footer,
      button,
      footerDirectionClassBase: 'code-expand-footer',
      buttonDirectionClassBase: 'code-expand-btn',
      iconDirectionClassBase: 'code-expand-icon',
      stepParent,
      label: getProgressiveExpandLabel(language),
      // Code blocks can keep growing while streaming output arrives. Observe only the code block
      // itself while its expand footer is hidden; never infer or observe parent containers here.
      observeTargetUntilOverflow: true,
      isContentComplete: () => {
        const bubble = this.closest('.generation-bubble');
        if (!(bubble instanceof HTMLElement)) return true;
        return bubble.dataset.finalized === 'true' || bubble.classList.contains('completed');
      },
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
