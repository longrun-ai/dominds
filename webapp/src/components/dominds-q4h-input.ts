/**
 * Q4H (Questions for Human) Input Component
 *
 * Owns only the input + answer routing (selected question id).
 * The Q4H question list UI is rendered by the bottom-panel Q4H tab
 * (`dominds-q4h-panel`).
 */

import { getUiStrings } from '../i18n/ui';
import { getWebSocketManager } from '../services/websocket.js';
import type { LanguageCode } from '../shared/types/language';
import type { Q4HDialogContext } from '../shared/types/q4h.js';
import type { DialogRunState } from '../shared/types/run-state.js';
import type { Q4HKind } from '../shared/types/storage.js';
import type { DialogIdent } from '../shared/types/wire.js';
import { generateShortId } from '../shared/utils/id.js';

export interface Q4HQuestion {
  id: string;
  kind: Q4HKind;
  headLine: string;
  bodyContent: string;
  askedAt: string;
  dialogContext: Q4HDialogContext;
}

interface Q4HInputProps {
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

export class DomindsQ4HInput extends HTMLElement {
  private wsManager = getWebSocketManager();
  private uiLanguage: LanguageCode = 'en';

  private questions: Q4HQuestion[] = [];
  private selectedQuestionId: string | null = null;
  private sendOnEnter = true;
  private isComposing = false;
  private inputUiRafId: number | null = null;
  private escPrimedAtMs: number | null = null;
  private props: Q4HInputProps = {
    disabled: false,
    placeholder: 'Type your answer...',
    maxLength: 4000,
  };
  private currentDialog: DialogIdent | null = null;
  private runState: DialogRunState | null = null;

  private textInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private inputWrapper!: HTMLElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.setupEventListeners();
    this.updateUI();
  }

  public setUiLanguage(language: LanguageCode): void {
    this.uiLanguage = language;
    const t = getUiStrings(language);
    this.props.placeholder = t.q4hInputPlaceholder;
    if (this.textInput) {
      this.textInput.placeholder = t.q4hInputPlaceholder;
    }

    const root = this.shadowRoot;
    if (!root) return;

    const toggle = root.querySelector('.send-on-enter-toggle') as HTMLButtonElement | null;
    if (toggle) {
      toggle.title = this.sendOnEnter ? t.q4hEnterToSendTitle : t.q4hCtrlEnterToSendTitle;
    }
  }

  public setQuestions(questions: Q4HQuestion[]): void {
    this.questions = questions;

    if (this.selectedQuestionId !== null) {
      const stillExists = this.questions.some((q) => q.id === this.selectedQuestionId);
      if (!stillExists) this.selectedQuestionId = null;
    }

    this.updateUI();
    this.updateSendButton();
  }

  public getQuestions(): readonly Q4HQuestion[] {
    return this.questions;
  }

  public getQuestionCount(): number {
    return this.questions.length;
  }

  public selectQuestion(questionId: string | null): void {
    if (questionId === this.selectedQuestionId) return;
    this.selectedQuestionId = questionId;
    this.updateUI();
    this.updateSendButton();

    const question = this.questions.find((q) => q.id === questionId);
    if (question) {
      this.dispatchEvent(
        new CustomEvent('q4h-select-question', {
          detail: {
            questionId,
            dialogId: question.dialogContext.selfId,
            rootId: question.dialogContext.rootId,
            headLine: question.headLine,
            bodyContent: question.bodyContent,
          },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  public getSelectedQuestionId(): string | null {
    return this.selectedQuestionId;
  }

  public setDialog(dialog: DialogIdent): void {
    if (typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
      this.showError('Invalid dialog id: selfId/rootId must be strings');
      return;
    }
    this.currentDialog = dialog;
    this.updateUI();
  }

  public clearDialog(): void {
    this.currentDialog = null;
    this.runState = null;
    this.updateUI();
  }

  public setRunState(runState: DialogRunState | null): void {
    this.runState = runState;
    this.updateSendButton();
    this.safeRender();
  }

  public setDisabled(disabled: boolean): void {
    this.props.disabled = disabled;
    this.updateUI();
  }

  public focusInput(): void {
    if (this.textInput) {
      this.textInput.focus();
      const length = this.textInput.value.length;
      this.textInput.setSelectionRange(length, length);
    }
  }

  public clear(): void {
    if (this.textInput) {
      this.textInput.value = '';
      this.updateSendButton();
      this.scheduleInputUiUpdate();
    }
  }

  public getValue(): string {
    return this.textInput?.value || '';
  }

  public setValue(value: string): void {
    if (this.textInput) {
      this.textInput.value = value;
      this.updateSendButton();
    }
  }

  private safeRender(): void {
    if (this.inputUiRafId !== null) {
      window.cancelAnimationFrame(this.inputUiRafId);
      this.inputUiRafId = null;
    }

    const sr = this.shadowRoot;
    const active = sr ? sr.activeElement : null;
    const restoreFocus = active === this.textInput || active === this.sendButton;
    const selectionStart = active === this.textInput ? this.textInput.selectionStart : null;
    const selectionEnd = active === this.textInput ? this.textInput.selectionEnd : null;

    const currentValue = this.textInput?.value || '';
    const currentHeight = this.textInput?.style.height || '';

    this.render();
    this.setupEventListeners();

    if (this.textInput) {
      this.textInput.value = currentValue;
      if (currentHeight) {
        this.textInput.style.height = currentHeight;
      }
    }
    this.updateUI();

    if (restoreFocus && this.textInput && !this.textInput.disabled) {
      this.textInput.focus();
      const len = this.textInput.value.length;
      if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
        this.textInput.setSelectionRange(
          Math.min(selectionStart, len),
          Math.min(selectionEnd, len),
        );
      } else {
        this.textInput.setSelectionRange(len, len);
      }
    }
  }

  private autoResizeTextarea(): void {
    if (!this.textInput) return;
    this.textInput.style.height = 'auto';
    const scrollHeight = this.textInput.scrollHeight;
    const minHeight = 48;
    const maxHeight = 120;
    this.textInput.style.height = `${Math.max(minHeight, Math.min(scrollHeight, maxHeight))}px`;
  }

  private scheduleInputUiUpdate(): void {
    if (this.inputUiRafId !== null) return;
    this.inputUiRafId = window.requestAnimationFrame(() => {
      this.inputUiRafId = null;
      this.updateSendButton();
      if (!this.isComposing) {
        this.autoResizeTextarea();
      }
    });
  }

  private showError(message: string): void {
    if (this.inputWrapper) {
      this.inputWrapper.style.borderColor = 'var(--dominds-danger, #dc3545)';
      this.inputWrapper.style.boxShadow = '0 0 0 3px rgba(220, 53, 69, 0.1)';

      setTimeout(() => {
        this.inputWrapper.style.borderColor = '';
        this.inputWrapper.style.boxShadow = '';
      }, 3000);
    }

    this.dispatchEvent(
      new CustomEvent('input-error', {
        detail: { message, type: 'error' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) return;

    if (this.textInput) {
      this.isComposing = false;
      this.textInput.addEventListener('compositionstart', () => {
        this.isComposing = true;
      });
      this.textInput.addEventListener('compositionend', () => {
        this.isComposing = false;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('compositioncancel', () => {
        this.isComposing = false;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('blur', () => {
        this.isComposing = false;
        this.escPrimedAtMs = null;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('input', () => {
        this.scheduleInputUiUpdate();
      });

      this.textInput.addEventListener('keydown', (e) => {
        const isIme = this.isComposing || e.isComposing || e.keyCode === 229;

        if (e.key === 'Escape') {
          if (isIme) return;
          const hasContent = this.textInput.value.length > 0;
          if (!hasContent) {
            this.escPrimedAtMs = null;
            return;
          }

          const now = Date.now();
          const primedAt = this.escPrimedAtMs;
          const isSecondPress = typeof primedAt === 'number' && now - primedAt <= 650;
          if (isSecondPress) {
            this.escPrimedAtMs = null;
            e.preventDefault();
            e.stopPropagation();
            this.clear();
            this.focusInput();
            return;
          }

          this.escPrimedAtMs = now;
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        this.escPrimedAtMs = null;

        if (e.key === 'Enter' && isIme) {
          return;
        }

        if (this.sendOnEnter) {
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            void this.handlePrimaryAction();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
          }
        } else {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void this.handlePrimaryAction();
          }
        }
      });
    }

    const toggleBtn = this.shadowRoot.querySelector('.send-on-enter-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.sendOnEnter = !this.sendOnEnter;
        this.safeRender();
        this.focusInput();
      });
    }

    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => {
        void this.handlePrimaryAction();
      });
    }
  }

  private async requestStop(): Promise<void> {
    if (!this.currentDialog) {
      throw new Error('No active dialog');
    }

    if (this.props.disabled) {
      throw new Error('Input is disabled');
    }

    this.wsManager.sendRaw({ type: 'interrupt_dialog', dialog: this.currentDialog });
  }

  private async handlePrimaryAction(): Promise<void> {
    try {
      const state = this.runState;
      if (state && (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested')) {
        if (state.kind === 'proceeding_stop_requested') {
          return;
        }
        await this.requestStop();
        return;
      }
      await this.sendMessage();
    } catch (error: unknown) {
      console.error('Primary action failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Action failed';
      this.showError(errorMessage);
    }
  }

  private async sendMessage(): Promise<{ success: true; msgId: string }> {
    const content = this.textInput.value.trim();

    if (!content) {
      throw new Error('Message content is empty');
    }

    if (!this.currentDialog) {
      throw new Error('No active dialog');
    }

    if (this.props.disabled) {
      throw new Error('Input is disabled');
    }
    if (this.isBlockedByContextHealthCritical()) {
      throw new Error('Send is disabled (context health critical)');
    }

    const msgId = generateShortId();

    try {
      const sr = this.shadowRoot;
      const active = sr ? sr.activeElement : null;
      const restoreFocus = active === this.textInput || active === this.sendButton;

      if (this.selectedQuestionId) {
        this.wsManager.sendRaw({
          type: 'drive_dialog_by_user_answer',
          dialog: this.currentDialog,
          content,
          msgId,
          questionId: this.selectedQuestionId,
          continuationType: 'answer',
          userLanguageCode: this.uiLanguage,
        });
      } else {
        this.wsManager.sendRaw({
          type: 'drive_dlg_by_user_msg',
          dialog: this.currentDialog,
          content,
          msgId,
          userLanguageCode: this.uiLanguage,
        });
      }

      this.clear();
      this.dispatchEvent(
        new CustomEvent('usersend', {
          detail: { content },
          bubbles: true,
          composed: true,
        }),
      );

      if (restoreFocus) {
        queueMicrotask(() => {
          if (this.props.disabled) return;
          if (!this.currentDialog) return;
          this.focusInput();
        });
      }

      return { success: true, msgId };
    } catch (error: unknown) {
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      this.showError(errorMessage);
      throw error;
    }
  }

  private updateSendButton(): void {
    if (!this.sendButton || !this.textInput) return;

    const state = this.runState;
    if (state && (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested')) {
      const canStop = !this.props.disabled && !!this.currentDialog;
      this.sendButton.disabled = state.kind === 'proceeding_stop_requested' || !canStop;
      return;
    }

    const blocked = this.isBlockedByContextHealthCritical();
    const hasContent = this.textInput.value.trim().length > 0;
    const canSend = hasContent && !this.props.disabled && !blocked && !!this.currentDialog;
    this.sendButton.disabled = !canSend;
  }

  private isBlockedByContextHealthCritical(): boolean {
    const selectedQuestionId = this.selectedQuestionId;
    if (selectedQuestionId !== null) {
      for (const q of this.questions) {
        if (q.id === selectedQuestionId) {
          return q.kind === 'context_health_critical';
        }
      }
      return false;
    }

    const currentDialog = this.currentDialog;
    if (!currentDialog) return false;

    for (const q of this.questions) {
      if (q.dialogContext.selfId === currentDialog.selfId && q.kind === 'context_health_critical') {
        return true;
      }
    }
    return false;
  }

  private updateUI(): void {
    if (!this.inputWrapper || !this.textInput) return;

    const shouldDisable =
      this.props.disabled || this.isBlockedByContextHealthCritical() || !this.currentDialog;
    this.inputWrapper.classList.toggle('disabled', shouldDisable);
    this.inputWrapper.classList.toggle('q4h-active', this.selectedQuestionId !== null);
    this.textInput.disabled = shouldDisable;
    this.updateSendButton();
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getComponentHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    this.textInput = this.shadowRoot.querySelector('.message-input')!;
    this.sendButton = this.shadowRoot.querySelector('.send-button')!;
    this.inputWrapper = this.shadowRoot.querySelector('.input-wrapper')!;
  }

  private getComponentHTML(): string {
    const t = getUiStrings(this.uiLanguage);
    const state = this.runState;
    const isProceeding =
      state !== null && (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested');
    const isStopping = state !== null && state.kind === 'proceeding_stop_requested';
    const primaryTitle = isProceeding ? (isStopping ? t.stopping : t.stop) : t.send;
    const primaryClass = isProceeding ? 'send-button stop' : 'send-button';

    return `
      <div class="q4h-input-container">
        <div class="input-section">
          <div class="input-wrapper ${this.selectedQuestionId !== null ? 'q4h-active' : ''} ${this.props.disabled ? 'disabled' : ''}">
            <textarea
              class="message-input"
              placeholder="${this.props.placeholder}"
              maxlength="${this.props.maxLength}"
              rows="2"
              ${this.props.disabled ? 'disabled' : ''}
            ></textarea>
            <div class="input-actions">
              <button
                class="send-on-enter-toggle ${this.sendOnEnter ? 'active' : ''}"
                type="button"
                title="${this.sendOnEnter ? t.q4hEnterToSendTitle : t.q4hCtrlEnterToSendTitle}"
              >
                ${this.sendOnEnter ? '⏎' : '⌘'}
              </button>
              <button class="${primaryClass}" type="button" disabled title="${primaryTitle}" aria-label="${primaryTitle}">
                ${
                  isProceeding
                    ? `<svg class="stop-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      </svg>`
                    : `<svg class="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2 L2 22" fill="none" stroke="currentColor" stroke-width="2"/>
                        <path d="M12 2 L22 22" fill="none" stroke="currentColor" stroke-width="2"/>
                        <line x1="12" y1="2" x2="12" y2="16.8" stroke="currentColor" stroke-width="2"/>
                      </svg>`
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private getStyles(): string {
    return `
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color-scheme: inherit;
      }

      .q4h-input-container {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        border-left: 1px solid var(--color-border-primary, #e2e8f0);
        border-right: 1px solid var(--color-border-primary, #e2e8f0);
        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--dominds-bg, #ffffff);
        box-sizing: border-box;
      }

      .input-section {
        flex: none;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        padding: 16px;
        background: inherit;
        position: relative;
        z-index: 1;
      }

      .input-wrapper {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        background: var(--dominds-input-bg, #f8f9fa);
        border: 2px solid var(--dominds-border, #e0e0e0);
        border-radius: 24px;
        transition: all 0.2s ease;
        overflow: hidden;
        padding-right: 12px;
      }

      .input-actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding-bottom: 8px;
      }

      .send-on-enter-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s ease;
        padding: 0;
      }

      .send-on-enter-toggle:hover {
        background: var(--color-bg-tertiary, #f1f5f9);
        color: var(--color-fg-primary, #0f172a);
        border-color: var(--color-border-primary, #e2e8f0);
      }

      .send-on-enter-toggle.active {
        font-weight: bold;
      }

      .input-wrapper.q4h-active {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 12%, var(--color-bg-secondary, #ffffff));
        border-color: var(--dominds-primary, #007acc);
        border-top-color: transparent;
        border-radius: 0 0 24px 24px;
      }

      .input-wrapper.q4h-active:focus-within {
        border-color: var(--dominds-primary, #007acc);
        border-top-color: transparent;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-primary, #007acc) 20%, transparent);
      }

      .input-wrapper:focus-within {
        border-color: var(--dominds-focus, #007acc);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-focus, #007acc) 20%, transparent);
      }

      .input-wrapper.disabled {
        opacity: 0.6;
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 3%, var(--color-bg-secondary, #f8f9fa));
        border-color: var(--dominds-border, #e0e0e0);
      }

      .message-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        padding: 12px 16px;
        font-size: 14px;
        line-height: 1.4;
        color: var(--dominds-fg, #333333);
        resize: none;
        min-height: 48px;
        max-height: 120px;
        font-family: inherit;
        white-space: pre-wrap;
        height: auto;
        overflow-y: auto;
      }

      .message-input::placeholder {
        color: var(--dominds-muted, #666666);
      }

      .message-input:disabled {
        cursor: not-allowed;
      }

      .send-button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border: none;
        border-radius: 50%;
        background: var(--dominds-primary, #007acc);
        color: white;
        cursor: pointer;
        transition: all 0.2s ease;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .send-button.stop {
        background: var(--dominds-danger, #dc3545);
      }

      .send-button:hover:not(:disabled) {
        background: var(--dominds-primary-hover, #005ea6);
        transform: scale(1.05);
      }

      .send-button.stop:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dominds-danger, #dc3545) 85%, black);
      }

      .send-button:active:not(:disabled) {
        transform: scale(0.95);
      }

      .send-button:disabled {
        background: var(--dominds-disabled, #2d2d2d);
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
        opacity: 0.6;
      }

      .send-icon {
        width: 16px;
        height: 16px;
      }

      .stop-icon {
        width: 16px;
        height: 16px;
      }
    `;
  }
}

if (!customElements.get('dominds-q4h-input')) {
  customElements.define('dominds-q4h-input', DomindsQ4HInput);
}
