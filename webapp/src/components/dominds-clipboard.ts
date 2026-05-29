import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

const MANUAL_COPY_MODAL_ATTR = 'data-dominds-manual-copy-modal';

const MANUAL_COPY_TEXTS = {
  title: '需要手动复制 / Manual copy required',
  close: '关闭 / Close',
  selectAll: '全选文本 / Select all text',
  insecureHttpMessages: {
    zh: '当前页面通过 HTTP 非 localhost 地址访问，浏览器不会开放剪贴板权限。请在下方只读文本框中手动全选并复制。',
    en: 'This page is loaded over HTTP from a non-localhost address, so the browser does not expose clipboard access. Select and copy the read-only text below manually.',
  },
  unavailableMessages: {
    zh: '浏览器当前没有开放剪贴板写入权限。请在下方只读文本框中手动全选并复制。',
    en: 'The browser has not granted clipboard write access. Select and copy the read-only text below manually.',
  },
} as const;

const manualCopyModalCleanups = new WeakMap<HTMLElement, () => void>();

export type ClipboardCopyResult = { kind: 'copied' } | { kind: 'manual_copy_shown' };

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function getManualCopyMessageHtml(): string {
  const insecureHttp =
    window.location.protocol === 'http:' && !isLocalClipboardHost(window.location.hostname);
  const messages = insecureHttp
    ? MANUAL_COPY_TEXTS.insecureHttpMessages
    : MANUAL_COPY_TEXTS.unavailableMessages;

  return `
    <p class="manual-copy-message" id="manual-copy-message-zh" lang="zh">${escapeHtmlText(messages.zh)}</p>
    <p class="manual-copy-message" id="manual-copy-message-en" lang="en">${escapeHtmlText(messages.en)}</p>
  `;
}

async function copyTextToClipboard(
  text: string,
  restoreFocusTo: HTMLElement | null,
): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue to the legacy selection path before asking the user to copy manually.
    }
  }

  try {
    if (!document.body) return false;

    const ta = document.createElement('textarea');
    const previousActiveElement = document.activeElement;
    try {
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      return ok === true;
    } finally {
      ta.remove();
      const focusTarget =
        restoreFocusTo ??
        (previousActiveElement instanceof HTMLElement ? previousActiveElement : null);
      if (focusTarget !== null && focusTarget.isConnected) {
        focusTarget.focus();
      }
    }
  } catch {
    return false;
  }
}

export async function copyTextOrShowManualCopy(
  text: string,
  restoreFocusTo: HTMLElement | null,
): Promise<ClipboardCopyResult> {
  const ok = await copyTextToClipboard(text, restoreFocusTo);
  if (ok) return { kind: 'copied' };

  showManualCopyModal(text, restoreFocusTo);
  return { kind: 'manual_copy_shown' };
}

function showManualCopyModal(text: string, restoreFocusTo: HTMLElement | null): void {
  const existing = document.querySelector(`[${MANUAL_COPY_MODAL_ATTR}="true"]`);
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
      [${MANUAL_COPY_MODAL_ATTR}="true"] {
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
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.38);
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-dialog {
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
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--dominds-border, var(--color-border-primary, #e5e5e5));
        background: var(--color-bg-tertiary, #f6f6f6);
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-title {
        margin: 0;
        font-size: 14px;
        line-height: 1.35;
        font-weight: 650;
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-close {
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
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-close .icon-mask {
        width: 14px;
        height: 14px;
        --icon-mask: ${ICON_MASK_URLS.close};
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-close:hover,
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-close:focus-visible {
        border-color: var(--dominds-primary, var(--color-accent-primary, #005fb8));
        outline: none;
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        flex: 1 1 auto;
        min-height: 0;
        padding: 14px;
        overflow: hidden;
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-message {
        margin: 0;
        color: var(--dominds-muted, var(--color-fg-secondary, #525252));
        font-size: 13px;
        line-height: 1.45;
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-text {
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
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-footer {
        display: flex;
        justify-content: flex-end;
        padding: 0 14px 14px;
      }
      [${MANUAL_COPY_MODAL_ATTR}="true"] .manual-copy-select {
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
    <div class="manual-copy-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-copy-title" aria-describedby="manual-copy-message-zh manual-copy-message-en">
      <div class="manual-copy-header">
        <h3 class="manual-copy-title" id="manual-copy-title">${escapeHtmlText(MANUAL_COPY_TEXTS.title)}</h3>
        <button class="manual-copy-close" type="button" aria-label="${escapeHtmlText(MANUAL_COPY_TEXTS.close)}" title="${escapeHtmlText(MANUAL_COPY_TEXTS.close)}">
          <span class="icon-mask" aria-hidden="true"></span>
        </button>
      </div>
      <div class="manual-copy-body">
        ${getManualCopyMessageHtml()}
        <textarea class="manual-copy-text" readonly spellcheck="false"></textarea>
      </div>
      <div class="manual-copy-footer">
        <button class="manual-copy-select" type="button">${escapeHtmlText(MANUAL_COPY_TEXTS.selectAll)}</button>
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
