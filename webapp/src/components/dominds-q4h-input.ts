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
import type { DialogIdent } from '../shared/types/wire.js';
import { generateShortId } from '../shared/utils/id.js';

export interface Q4HQuestion {
  id: string;
  tellaskContent: string;
  askedAt: string;
  dialogContext: Q4HDialogContext;
}

interface Q4HInputProps {
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

const RESIZE_HANDLE_ARIA_LABEL_I18N = {
  zh: '调整输入区高度',
  en: 'Resize input height',
} as const;

export class DomindsQ4HInput extends HTMLElement {
  private wsManager = getWebSocketManager();
  private uiLanguage: LanguageCode = 'en';

  private static readonly SEND_ON_ENTER_STORAGE_KEY = 'dominds-send-on-enter';
  private static readonly INPUT_HISTORY_STORAGE_KEY = 'dominds-user-input-history-v1';
  private static readonly INPUT_HISTORY_MAX = 100;

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
  private primaryActionMode: 'send' | 'stop' | 'stopping' = 'send';

  private inputHistory: string[] = [];
  private inputHistoryCursor: number | null = null; // 0..len, where len means draft/current
  private inputHistoryDraft: string | null = null;

  private textInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private declareDeathButton!: HTMLButtonElement;
  private inputWrapper!: HTMLElement;

  private resizeHandle!: HTMLDivElement;
  private manualHeightPx: number | null = null;
  private manualResizeMinPx: number = 0;
  private manualResizeMaxPx: number = 0;
  private manualResizeStartY: number = 0;
  private manualResizeStartHeight: number = 0;
  private isManualResizing: boolean = false;
  private boundManualMove?: (e: PointerEvent) => void;
  private boundManualUp?: (e: PointerEvent) => void;
  private activePointerId: number | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.restoreSendOnEnterPreference();
    this.restoreInputHistory();
    this.render();
    this.setupEventListeners();
    this.updateUI();
    this.recomputeResizeBounds();
    this.applyManualHeight();
    // Ensure initial textarea height is stable (avoid "growing a bit" on first blur).
    this.scheduleInputUiUpdate();
  }

  private restoreSendOnEnterPreference(): void {
    try {
      const raw = localStorage.getItem(DomindsQ4HInput.SEND_ON_ENTER_STORAGE_KEY);
      if (raw === '1') {
        this.sendOnEnter = true;
      } else if (raw === '0') {
        this.sendOnEnter = false;
      }
    } catch {
      // ignore
    }
  }

  private persistSendOnEnterPreference(): void {
    try {
      localStorage.setItem(DomindsQ4HInput.SEND_ON_ENTER_STORAGE_KEY, this.sendOnEnter ? '1' : '0');
    } catch {
      // ignore
    }
  }

  disconnectedCallback(): void {
    if (this.boundOnWindowResize) {
      window.removeEventListener('resize', this.boundOnWindowResize);
    }
  }

  private boundOnWindowResize = (): void => {
    this.recomputeResizeBounds();
    this.applyManualHeight();
  };

  private recomputeResizeBounds(): void {
    const lineHeight = this.getMessageInputLineHeightPx();
    const minLines = 3;
    const minTextHeight = lineHeight * minLines;
    const minHost = Math.ceil(minTextHeight + 32 + 24);
    const maxHost = Math.floor(window.innerHeight * 0.5);
    this.manualResizeMinPx = Math.max(120, minHost);
    this.manualResizeMaxPx = Math.max(this.manualResizeMinPx, maxHost);
  }

  private getMessageInputLineHeightPx(): number {
    if (!this.textInput) return 20;
    const computed = window.getComputedStyle(this.textInput);
    const lh = Number.parseFloat(computed.lineHeight);
    if (Number.isFinite(lh) && lh > 0) return lh;
    const fs = Number.parseFloat(computed.fontSize);
    if (Number.isFinite(fs) && fs > 0) return fs * 1.4;
    return 20;
  }

  private applyManualHeight(): void {
    if (this.manualHeightPx === null) {
      this.style.height = '';
      this.style.maxHeight = '';
      return;
    }
    const clamped = Math.max(
      this.manualResizeMinPx,
      Math.min(this.manualResizeMaxPx, this.manualHeightPx),
    );
    this.manualHeightPx = clamped;
    this.style.height = `${clamped}px`;
    this.style.maxHeight = `${clamped}px`;
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

    this.applyPrimaryActionMode();

    if (this.declareDeathButton) {
      this.declareDeathButton.textContent = t.declareDeath;
      this.declareDeathButton.title = t.declareDeath;
      this.declareDeathButton.setAttribute('aria-label', t.declareDeath);
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
            tellaskContent: question.tellaskContent,
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
      const t = getUiStrings(this.uiLanguage);
      this.showError(t.q4hInvalidDialogToast);
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
    this.applyPrimaryActionMode();
    this.updateUI();
  }

  private hasSelectedQ4HTarget(): boolean {
    return (
      this.selectedQuestionId !== null &&
      this.questions.some((q) => q.id === this.selectedQuestionId)
    );
  }

  private resolvePrimaryActionMode(): 'send' | 'stop' | 'stopping' {
    // Design choice: when a Q4H item is selected, primary action is always "send answer".
    // The selected Q4H target is treated as the active routing context and intentionally
    // takes precedence over stop semantics for the currently selected dialog.
    // Do not reorder this priority without revisiting the product behavior.
    if (this.hasSelectedQ4HTarget()) return 'send';
    if (this.currentDialog === null) return 'send';

    const state = this.runState;
    if (state === null) return 'send';
    if (state.kind === 'proceeding_stop_requested') return 'stopping';
    if (state.kind === 'proceeding') return 'stop';
    return 'send';
  }

  private applyPrimaryActionMode(): void {
    if (!this.sendButton) return;
    const t = getUiStrings(this.uiLanguage);
    const nextMode = this.resolvePrimaryActionMode();
    const title = nextMode === 'send' ? t.send : nextMode === 'stop' ? t.stop : t.stopping;
    this.sendButton.title = title;
    this.sendButton.setAttribute('aria-label', title);

    if (nextMode === this.primaryActionMode) {
      return;
    }

    this.primaryActionMode = nextMode;
    this.sendButton.classList.toggle('stop', nextMode !== 'send');
    if (nextMode === 'send') {
      this.sendButton.innerHTML = `
        <svg class="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2 L2 22" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M12 2 L22 22" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="12" y1="2" x2="12" y2="16.8" stroke="currentColor" stroke-width="2"/>
        </svg>
      `;
      return;
    }
    this.sendButton.innerHTML = `
      <svg class="stop-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      </svg>
    `;
  }

  private restoreInputHistory(): void {
    try {
      const raw = localStorage.getItem(DomindsQ4HInput.INPUT_HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const items: string[] = [];
      for (const item of parsed) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed === '') continue;
        items.push(trimmed);
      }
      this.inputHistory = items.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX);
    } catch {
      // ignore
    }
  }

  private persistInputHistory(): void {
    try {
      localStorage.setItem(
        DomindsQ4HInput.INPUT_HISTORY_STORAGE_KEY,
        JSON.stringify(this.inputHistory.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX)),
      );
    } catch {
      // ignore
    }
  }

  private recordInputHistoryEntry(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const last =
      this.inputHistory.length > 0 ? this.inputHistory[this.inputHistory.length - 1] : null;
    if (last === trimmed) return;
    this.inputHistory.push(trimmed);
    if (this.inputHistory.length > DomindsQ4HInput.INPUT_HISTORY_MAX) {
      this.inputHistory = this.inputHistory.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX);
    }
    this.persistInputHistory();
  }

  private resetInputHistoryNavigation(): void {
    this.inputHistoryCursor = null;
    this.inputHistoryDraft = null;
  }

  private applyInputHistoryCursorValue(cursorAt: 'start' | 'end' = 'end'): void {
    if (!this.textInput) return;
    if (this.inputHistoryCursor === null) return;
    const len = this.inputHistory.length;
    const nextValue =
      this.inputHistoryCursor >= len
        ? (this.inputHistoryDraft ?? '')
        : (this.inputHistory[this.inputHistoryCursor] ?? '');
    this.textInput.value = nextValue;
    this.updateSendButton();
    this.scheduleInputUiUpdate();
    const nextPos = cursorAt === 'start' ? 0 : this.textInput.value.length;
    this.textInput.setSelectionRange(nextPos, nextPos);
  }

  private recallPreviousInputHistory(): void {
    if (!this.textInput) return;
    if (this.inputHistory.length === 0) return;

    if (this.inputHistoryCursor === null) {
      this.inputHistoryDraft = this.textInput.value;
      this.inputHistoryCursor = this.inputHistory.length;
    }

    if (this.inputHistoryCursor <= 0) return;
    this.inputHistoryCursor -= 1;
    this.applyInputHistoryCursorValue('start');
  }

  private recallNextInputHistory(): void {
    if (!this.textInput) return;
    if (this.inputHistoryCursor === null) return;
    const len = this.inputHistory.length;
    if (this.inputHistoryCursor >= len) return;
    this.inputHistoryCursor += 1;
    this.applyInputHistoryCursorValue();
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
      this.resetInputHistoryNavigation();
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

  public insertPromptTemplate(content: string): void {
    if (!this.textInput) return;
    const template = typeof content === 'string' ? content : '';
    if (template.trim() === '') return;

    const textarea = this.textInput;
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);

    const needsPrefix = before.trim().length > 0 && !/\s$/.test(before);
    const needsSuffix = after.trim().length > 0 && !/^\s/.test(after);
    const prefix = needsPrefix ? '\n\n' : '';
    const suffix = needsSuffix ? '\n\n' : '';

    const inserted = `${prefix}${template}${suffix}`;
    textarea.value = `${before}${inserted}${after}`;

    const nextPos = before.length + inserted.length;
    textarea.setSelectionRange(nextPos, nextPos);
    this.updateSendButton();
    this.scheduleInputUiUpdate();
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
    const lineHeight = this.getMessageInputLineHeightPx();
    const minHeight = Math.ceil(lineHeight * 3);
    const maxHeight = Math.ceil(lineHeight * 20);
    this.textInput.style.height = `${Math.max(minHeight, Math.min(scrollHeight, maxHeight))}px`;
  }

  private scheduleInputUiUpdate(): void {
    if (this.inputUiRafId !== null) return;
    this.inputUiRafId = window.requestAnimationFrame(() => {
      this.inputUiRafId = null;
      this.updateSendButton();
      if (!this.isComposing && this.manualHeightPx === null) {
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

    window.removeEventListener('resize', this.boundOnWindowResize);
    window.addEventListener('resize', this.boundOnWindowResize);

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
        if (
          this.inputHistoryCursor !== null &&
          this.inputHistoryCursor !== this.inputHistory.length
        ) {
          // User started editing a recalled history item; exit history navigation mode.
          this.resetInputHistoryNavigation();
        }
        this.scheduleInputUiUpdate();
      });

      this.textInput.addEventListener('keydown', (e) => {
        const isIme = this.isComposing || e.isComposing || e.keyCode === 229;

        if (!isIme && e.key === 'ArrowUp') {
          const start = this.textInput.selectionStart;
          const end = this.textInput.selectionEnd;
          if (start === 0 && end === 0) {
            e.preventDefault();
            e.stopPropagation();
            this.recallPreviousInputHistory();
            return;
          }
        }

        if (!isIme && e.key === 'ArrowDown') {
          const start = this.textInput.selectionStart;
          const end = this.textInput.selectionEnd;
          const len = this.textInput.value.length;
          if (start === len && end === len) {
            e.preventDefault();
            e.stopPropagation();
            this.recallNextInputHistory();
            return;
          }
        }

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
        this.persistSendOnEnterPreference();
        this.safeRender();
        this.focusInput();
      });
    }

    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => {
        void this.handlePrimaryAction();
      });
    }

    if (this.declareDeathButton) {
      this.declareDeathButton.addEventListener('click', () => {
        void this.handleDeclareDeath();
      });
    }

    if (this.resizeHandle) {
      this.resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.recomputeResizeBounds();
        if (this.textInput) {
          // Clear any inline height set by auto-resize so the textarea can stretch.
          this.textInput.style.height = '';
        }
        const current = this.getBoundingClientRect().height;
        const startHeight = this.manualHeightPx ?? current;
        this.manualResizeStartHeight = startHeight;
        this.manualResizeStartY = e.clientY;
        this.isManualResizing = true;
        this.activePointerId = e.pointerId;
        this.manualHeightPx = startHeight;
        this.applyManualHeight();

        this.resizeHandle.setPointerCapture(e.pointerId);

        this.boundManualMove = (evt: PointerEvent) => {
          if (!this.isManualResizing) return;
          const delta = evt.clientY - this.manualResizeStartY;
          const next = this.manualResizeStartHeight - delta;
          this.manualHeightPx = next;
          this.applyManualHeight();
        };
        this.boundManualUp = () => {
          this.isManualResizing = false;
          if (this.activePointerId !== null) {
            try {
              this.resizeHandle.releasePointerCapture(this.activePointerId);
            } catch {
              // ignore
            }
          }
          this.activePointerId = null;
          if (this.boundManualMove) {
            this.resizeHandle.removeEventListener('pointermove', this.boundManualMove);
          }
          this.boundManualMove = undefined;
          this.boundManualUp = undefined;
        };

        this.resizeHandle.addEventListener('pointermove', this.boundManualMove);
        this.resizeHandle.addEventListener('pointerup', this.boundManualUp, { once: true });
        this.resizeHandle.addEventListener('pointercancel', this.boundManualUp, { once: true });
      });
    }
  }

  private async requestDeclareDeath(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    const dialog = this.currentDialog;
    if (!dialog) {
      throw new Error(t.noActiveDialogToast);
    }
    if (dialog.selfId === dialog.rootId) {
      throw new Error(t.q4hDeclareDeadOnlySidelineToast);
    }
    const state = this.runState;
    if (state === null || state.kind !== 'interrupted') {
      throw new Error(t.q4hDeclareDeadOnlyInterruptedToast);
    }
    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }
    const ok = window.confirm(t.declareDeathConfirm);
    if (!ok) return;
    const note = this.textInput ? this.textInput.value : '';
    this.wsManager.sendRaw({ type: 'declare_subdialog_dead', dialog, note });
    this.recordInputHistoryEntry(note);
    this.clear();
  }

  private async requestStop(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    if (!this.currentDialog) {
      throw new Error(t.noActiveDialogToast);
    }
    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }
    this.wsManager.sendRaw({ type: 'interrupt_dialog', dialog: this.currentDialog });
  }

  private async handlePrimaryAction(): Promise<void> {
    try {
      const mode = this.resolvePrimaryActionMode();
      if (mode === 'stop') {
        await this.requestStop();
        return;
      }
      if (mode === 'stopping') {
        return;
      }
      await this.sendMessage();
    } catch (error: unknown) {
      console.error('Primary action failed:', error);
      const t = getUiStrings(this.uiLanguage);
      const errorMessage = error instanceof Error ? error.message : t.q4hActionFailedToast;
      this.showError(errorMessage);
    }
  }

  private async handleDeclareDeath(): Promise<void> {
    try {
      await this.requestDeclareDeath();
    } catch (error: unknown) {
      console.error('Declare dead failed:', error);
      const t = getUiStrings(this.uiLanguage);
      const errorMessage = error instanceof Error ? error.message : t.q4hActionFailedToast;
      this.showError(errorMessage);
    }
  }

  private async sendMessage(): Promise<{ success: true; msgId: string }> {
    const t = getUiStrings(this.uiLanguage);
    const content = this.textInput.value.trim();
    const answeredQuestionId = this.selectedQuestionId;
    const answeredQuestion =
      answeredQuestionId !== null
        ? (this.questions.find((q) => q.id === answeredQuestionId) ?? null)
        : null;
    if (answeredQuestionId !== null && answeredQuestion === null) {
      throw new Error(`${t.q4hSelectedQuestionStaleToastPrefix}${answeredQuestionId}`);
    }
    const targetDialog =
      answeredQuestion !== null
        ? {
            selfId: answeredQuestion.dialogContext.selfId,
            rootId: answeredQuestion.dialogContext.rootId,
          }
        : this.currentDialog;

    if (!content) {
      throw new Error(t.q4hMessageEmptyToast);
    }

    if (!targetDialog) {
      throw new Error(t.q4hNoRoutableTargetToast);
    }

    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }

    const msgId = generateShortId();

    try {
      const sr = this.shadowRoot;
      const active = sr ? sr.activeElement : null;
      const restoreFocus = active === this.textInput || active === this.sendButton;

      if (answeredQuestion !== null) {
        this.wsManager.sendRaw({
          type: 'drive_dialog_by_user_answer',
          dialog: targetDialog,
          content,
          msgId,
          questionId: answeredQuestion.id,
          continuationType: 'answer',
          userLanguageCode: this.uiLanguage,
        });
      } else {
        this.wsManager.sendRaw({
          type: 'drive_dlg_by_user_msg',
          dialog: targetDialog,
          content,
          msgId,
          userLanguageCode: this.uiLanguage,
        });
      }

      this.recordInputHistoryEntry(content);
      if (answeredQuestion !== null) {
        // Q4H answer flow: clear question selection/styling immediately after answer routing.
        this.selectQuestion(null);
        const dialogId = answeredQuestion.dialogContext.selfId;
        const rootId = answeredQuestion.dialogContext.rootId;
        if (typeof dialogId === 'string' && typeof rootId === 'string') {
          this.dispatchEvent(
            new CustomEvent('q4h-select-question', {
              detail: {
                questionId: null,
                dialogId,
                rootId,
                tellaskContent: '',
              },
              bubbles: true,
              composed: true,
            }),
          );
        }
      } else {
        // Normal user-message flow: no Q4H style transition side effects.
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
          this.focusInput();
        });
      }

      return { success: true, msgId };
    } catch (error: unknown) {
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : t.q4hSendFailedToast;
      this.showError(errorMessage);
      throw error;
    }
  }

  private updateSendButton(): void {
    if (!this.sendButton || !this.textInput) return;

    this.applyPrimaryActionMode();
    const mode = this.resolvePrimaryActionMode();
    if (mode !== 'send') {
      const canStop = !this.props.disabled && this.currentDialog !== null;
      this.sendButton.disabled = mode === 'stopping' || !canStop;
      return;
    }

    const hasContent = this.textInput.value.trim().length > 0;
    const hasSelectedQ4H = this.hasSelectedQ4HTarget();
    const hasCurrentDialog = this.currentDialog !== null;
    const hasRoutableTarget = hasSelectedQ4H || hasCurrentDialog;
    const canSend = hasContent && !this.props.disabled && hasRoutableTarget;
    this.sendButton.disabled = !canSend;
  }

  private updateUI(): void {
    if (!this.inputWrapper || !this.textInput) return;

    const state = this.runState;
    const isProceeding =
      state !== null && (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested');
    const shouldDisable = this.props.disabled === true;
    this.inputWrapper.classList.toggle('disabled', shouldDisable);
    this.inputWrapper.classList.toggle('q4h-active', this.selectedQuestionId !== null);
    this.textInput.disabled = shouldDisable;
    this.textInput.readOnly = false;

    this.setAttribute('data-run-state', state ? state.kind : 'none');
    this.setAttribute('aria-busy', isProceeding ? 'true' : 'false');
    this.updateSendButton();

    if (this.declareDeathButton) {
      const dialog = this.currentDialog;
      const isDead = state !== null && state.kind === 'dead';
      const isSubdialog = dialog !== null && dialog.selfId !== dialog.rootId;
      const shouldShow = isSubdialog && !isDead && state !== null && state.kind === 'interrupted';
      this.declareDeathButton.hidden = !shouldShow;
      this.declareDeathButton.disabled = this.props.disabled || dialog === null;

      const t = getUiStrings(this.uiLanguage);
      this.declareDeathButton.textContent = t.declareDeath;
      this.declareDeathButton.title = t.declareDeath;
      this.declareDeathButton.setAttribute('aria-label', t.declareDeath);
    }
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
    this.declareDeathButton = this.shadowRoot.querySelector('.declare-death-button')!;
    this.inputWrapper = this.shadowRoot.querySelector('.input-wrapper')!;
    this.resizeHandle = this.shadowRoot.querySelector('.input-resize-handle')!;
  }

  private getComponentHTML(): string {
    const t = getUiStrings(this.uiLanguage);
    const mode = this.resolvePrimaryActionMode();
    const primaryTitle = mode === 'send' ? t.send : mode === 'stop' ? t.stop : t.stopping;
    const primaryClass = mode === 'send' ? 'send-button' : 'send-button stop';
    const dialog = this.currentDialog;
    const isSubdialog = dialog !== null && dialog.selfId !== dialog.rootId;
    const state = this.runState;
    const isDead = state !== null && state.kind === 'dead';
    const showDeclareDeath =
      isSubdialog && !isDead && state !== null && state.kind === 'interrupted';

    return `
      <div class="q4h-input-container">
        <div class="input-section">
          <div class="input-resize-handle" role="separator" aria-orientation="horizontal" aria-label="${RESIZE_HANDLE_ARIA_LABEL_I18N[this.uiLanguage]}"></div>
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
                  mode === 'send'
                    ? `<svg class="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2 L2 22" fill="none" stroke="currentColor" stroke-width="2"/>
                        <path d="M12 2 L22 22" fill="none" stroke="currentColor" stroke-width="2"/>
                        <line x1="12" y1="2" x2="12" y2="16.8" stroke="currentColor" stroke-width="2"/>
                      </svg>`
                    : `<svg class="stop-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      </svg>`
                }
              </button>
              <button
                class="declare-death-button"
                type="button"
                title="${t.declareDeath}"
                aria-label="${t.declareDeath}"
                ${showDeclareDeath ? '' : 'hidden'}
              >${t.declareDeath}</button>
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
        max-height: 50vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color-scheme: inherit;
      }

      [hidden] {
        display: none !important;
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

      .input-resize-handle {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 12px;
        cursor: ns-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        z-index: 2;
      }

      .input-resize-handle::after {
        content: '';
        position: absolute;
        inset: 0;
      }

      .input-resize-handle::before {
        content: '';
        width: 44px;
        height: 3px;
        border-radius: 999px;
        background: var(--dominds-border, #e0e0e0);
      }

      .input-resize-handle:hover::before {
        background: var(--dominds-primary, #007acc);
      }

      .input-section {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        padding: 10px;
        background: inherit;
        position: relative;
        z-index: 1;
      }

      .input-wrapper {
        display: flex;
        align-items: stretch;
        flex: 1;
        min-height: 0;
        gap: 6px;
        background: var(--dominds-input-bg, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 18px;
        transition: all 0.2s ease;
        overflow: hidden;
        padding-right: 8px;
      }

      .input-actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        align-self: flex-end;
        padding-bottom: 6px;
      }

      .declare-death-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--dominds-danger, #dc3545);
        background: transparent;
        color: var(--dominds-danger, #dc3545);
        font-size: var(--dominds-font-size-xs, 11px);
        font-weight: 600;
        cursor: pointer;
        user-select: none;
      }

      .declare-death-button:hover:not(:disabled) {
        background: rgba(220, 53, 69, 0.08);
      }

      .declare-death-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .send-on-enter-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        font-size: var(--dominds-font-size-sm, 12px);
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
        border-radius: 0 0 18px 18px;
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
        padding: 9px 12px;
        font-size: var(--dominds-font-size-md, 13px);
        line-height: var(--dominds-line-height-dense, 1.4);
        color: var(--dominds-fg, #333333);
        resize: none;
        min-height: 42px;
        font-family: inherit;
        white-space: pre-wrap;
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
        width: 27px;
        height: 27px;
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
        width: 11px;
        height: 11px;
      }

      .stop-icon {
        width: 11px;
        height: 11px;
      }

    `;
  }
}

if (!customElements.get('dominds-q4h-input')) {
  customElements.define('dominds-q4h-input', DomindsQ4HInput);
}
