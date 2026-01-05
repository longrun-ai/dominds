/**
 * Q4H (Questions for Human) Input Component
 * Combined question list with inline input area
 * Displays pending questions and handles user answers via WebSocket
 */

import { getWebSocketManager } from '../services/websocket.js';
import type { Q4HDialogContext } from '../shared/types/q4h.js';
import type { DialogIdent } from '../shared/types/wire.js';
import { formatRelativeTime } from '../utils/time.js';

/**
 * Q4H Question interface for the input component
 * Combines question data with its dialog context
 */
export interface Q4HQuestion {
  id: string;
  headLine: string;
  bodyContent: string;
  askedAt: string;
  dialogContext: Q4HDialogContext;
}

/**
 * Props interface for the Q4H input component
 */
interface Q4HInputProps {
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

export class DomindsQ4HInput extends HTMLElement {
  private wsManager = getWebSocketManager();

  // Internal state
  private questions: Q4HQuestion[] = [];
  private selectedQuestionId: string | null = null;
  private expandedQuestions: Set<string> = new Set();
  private collapsedQuestions: Set<string> = new Set();
  private isListExpanded = false; // Start collapsed, auto-expand when questions arrive
  private props: Q4HInputProps = {
    disabled: false,
    placeholder: 'Type your answer...',
    maxLength: 4000,
  };
  private currentDialog: DialogIdent | null = null;

  // DOM elements (initialized after render)
  private textInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private inputWrapper!: HTMLElement;
  private questionListContainer!: HTMLElement;
  private questionFooter!: HTMLElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.setupEventListeners();
    this.updateUI();
  }

  // ==================== Public API Methods ====================

  /**
   * Full replace - used only for initial page load when backend sends all questions at once
   */
  public setQuestions(questions: Q4HQuestion[]): void {
    const hadQuestions = this.questions.length > 0;
    const hasQuestions = questions.length > 0;

    // Auto-expand when first question arrives
    if (!hadQuestions && hasQuestions) {
      this.isListExpanded = true;
      this.updateListVisibility();

      // Notify parent about state change to show resize-handle
      this.dispatchEvent(
        new CustomEvent('q4h-toggle', {
          detail: { expanded: true },
          bubbles: true,
          composed: true,
        }),
      );
    }

    // Get current IDs
    const currentIds = new Set(this.questions.map((q) => q.id));
    const newIds = new Set(questions.map((q) => q.id));

    // Remove questions not in new list
    for (const existing of this.questions) {
      if (!newIds.has(existing.id)) {
        this.removeQuestion(existing.id);
      }
    }

    // Add new questions (rebuild internal state from scratch for full replace)
    this.questions = [];
    // Clear all existing cards before rebuilding to prevent duplicates
    this.clearAllQuestionCards();
    // Remove empty state if present before adding questions
    if (this.questionListContainer) {
      const emptyState = this.questionListContainer.querySelector('.empty-state');
      if (emptyState) emptyState.remove();
    }
    for (const q of questions) {
      this.questions.push(q);
      this.appendQuestionCard(q);
    }

    // Auto-collapse when last question answered (goes to 0)
    if (hadQuestions && !hasQuestions) {
      this.isListExpanded = false;
    }

    this.updateCountBadge();
  }

  /**
   * Add a single question - for incremental realtime updates
   */
  public addQuestion(question: Q4HQuestion): void {
    const hadQuestions = this.questions.length > 0;
    const exists = this.questions.find((q) => q.id === question.id);
    if (!exists) {
      // Auto-expand when first question added
      if (!hadQuestions) {
        this.isListExpanded = true;
        // Notify parent about state change to show resize-handle
        this.dispatchEvent(
          new CustomEvent('q4h-toggle', {
            detail: { expanded: true },
            bubbles: true,
            composed: true,
          }),
        );
      }
      this.questions.push(question);
      this.appendQuestionCard(question);
      this.updateCountBadge();
      this.updateQuestionListVisibility();
    }
  }

  /**
   * Remove a question by ID - when answered
   */
  public removeQuestion(questionId: string): boolean {
    const hadQuestions = this.questions.length > 0;
    const index = this.questions.findIndex((q) => q.id === questionId);
    if (index < 0) return false;

    this.questions.splice(index, 1);

    if (this.selectedQuestionId === questionId) {
      this.selectedQuestionId = null;
    }

    // Auto-collapse when last question removed
    if (hadQuestions && this.questions.length === 0) {
      this.isListExpanded = false;
    }

    this.removeQuestionCard(questionId);
    this.updateCountBadge();
    this.updateQuestionListVisibility();

    return true;
  }

  /**
   * Get all current questions (read-only)
   */
  public getQuestions(): readonly Q4HQuestion[] {
    return this.questions;
  }

  /**
   * Get count of pending questions
   */
  public getQuestionCount(): number {
    return this.questions.length;
  }

  /**
   * Programmatically select a question
   * Automatically expands the selected question
   */
  public selectQuestion(questionId: string | null): void {
    // Remember expand/collapse state of previously selected question
    if (this.selectedQuestionId) {
      if (this.expandedQuestions.has(this.selectedQuestionId)) {
        this.collapsedQuestions.add(this.selectedQuestionId);
        this.expandedQuestions.delete(this.selectedQuestionId);
      } else {
        this.collapsedQuestions.delete(this.selectedQuestionId);
      }
    }

    this.selectedQuestionId = questionId;

    // Auto-expand newly selected question
    if (questionId) {
      this.expandedQuestions.add(questionId);
      this.collapsedQuestions.delete(questionId);
    }

    // Preserve input value and height across re-render
    const currentValue = this.textInput?.value || '';
    const currentHeight = this.textInput?.style.height || '';

    this.render();
    this.setupEventListeners();

    // Restore input value and height
    if (this.textInput) {
      this.textInput.value = currentValue;
      if (currentHeight) {
        this.textInput.style.height = currentHeight;
      }
    }

    this.updateUI();

    // Dispatch selection change event
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

  /**
   * Get the currently selected question ID
   */
  public getSelectedQuestionId(): string | null {
    return this.selectedQuestionId;
  }

  /**
   * Expand a specific question
   */
  public expandQuestion(questionId: string): void {
    this.expandedQuestions.add(questionId);
    this.collapsedQuestions.delete(questionId);
    this.render();
    this.setupEventListeners();
  }

  /**
   * Collapse a specific question
   */
  public collapseQuestion(questionId: string): void {
    this.expandedQuestions.delete(questionId);
    this.collapsedQuestions.add(questionId);
    this.render();
    this.setupEventListeners();
  }

  /**
   * Check if a question is expanded
   */
  public getQuestionExpandState(questionId: string): boolean {
    return this.expandedQuestions.has(questionId);
  }

  /**
   * Set the current dialog for message sending
   */
  public setDialog(dialog: DialogIdent): void {
    if (typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
      this.showError('Invalid dialog id: selfId/rootId must be strings');
      return;
    }
    this.currentDialog = dialog;
    this.updateUI();
  }

  /**
   * Enable or disable the input area
   */
  public setDisabled(disabled: boolean): void {
    this.props.disabled = disabled;
    this.updateUI();
  }

  /**
   * Focus the text input
   */
  public focusInput(): void {
    if (this.textInput) {
      this.textInput.focus();
      const length = this.textInput.value.length;
      this.textInput.setSelectionRange(length, length);
    }
  }

  /**
   * Clear the input field
   */
  public clear(): void {
    if (this.textInput) {
      this.textInput.value = '';
      this.updateSendButton();
    }
  }

  /**
   * Get current input value
   */
  public getValue(): string {
    return this.textInput?.value || '';
  }

  /**
   * Set input value programmatically
   */
  public setValue(value: string): void {
    if (this.textInput) {
      this.textInput.value = value;
      this.updateSendButton();
    }
  }

  // ==================== Private Methods ====================

  private toggleQuestion(questionId: string): void {
    if (this.expandedQuestions.has(questionId)) {
      this.expandedQuestions.delete(questionId);
      this.collapsedQuestions.add(questionId);
    } else {
      this.expandedQuestions.add(questionId);
      this.collapsedQuestions.delete(questionId);
    }
    this.render();
    this.setupEventListeners();
  }

  private toggleSelection(questionId: string): void {
    if (this.selectedQuestionId === questionId) {
      // Deselect if already selected
      this.selectQuestion(null);
    } else {
      // Select new question (auto-expands)
      this.selectQuestion(questionId);
    }
  }

  private navigateToCallSite(question: Q4HQuestion): void {
    this.dispatchEvent(
      new CustomEvent('q4h-navigate-call-site', {
        detail: {
          questionId: question.id,
          dialogId: question.dialogContext.selfId,
          rootId: question.dialogContext.rootId,
          round: 1,
          messageIndex: 0,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Append a new question card to the list
   */
  private appendQuestionCard(question: Q4HQuestion): void {
    if (!this.shadowRoot || !this.questionListContainer) {
      this.render();
      this.setupEventListeners();
      return;
    }

    // Check if card already exists to prevent duplicates
    const existingCard = this.questionListContainer.querySelector(
      `.q4h-question-card[data-question-id="${question.id}"]`,
    );
    if (existingCard) {
      return; // Card already exists, skip adding
    }

    // Remove empty state if present
    const emptyState = this.questionListContainer.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }

    const cardElement = this.renderQuestionCardElement(question);
    this.questionListContainer.appendChild(cardElement);
    this.setupCardEventListeners(cardElement);
  }

  /**
   * Remove a question card from the DOM
   */
  private removeQuestionCard(questionId: string): void {
    if (!this.shadowRoot) return;

    const card = this.shadowRoot.querySelector(
      `.q4h-question-card[data-question-id="${questionId}"]`,
    );
    card?.remove();
  }

  /**
   * Clear all question cards from the DOM (used before full rebuild)
   */
  private clearAllQuestionCards(): void {
    if (!this.shadowRoot || !this.questionListContainer) return;
    const cards = this.questionListContainer.querySelectorAll('.q4h-question-card');
    cards.forEach((card) => card.remove());
  }

  /**
   * Update the live count badge with bump animation
   */
  private updateCountBadge(): void {
    const badge = this.shadowRoot?.querySelector('.q4h-count-badge');
    if (badge) {
      const count = this.questions.length;
      badge.textContent = String(count);

      // Bump animation
      badge.classList.remove('bump');
      void (badge as HTMLElement).offsetWidth; // Trigger reflow
      badge.classList.add('bump');
    }
  }

  /**
   * Create a DOM element from question card template
   */
  private renderQuestionCardElement(question: Q4HQuestion): HTMLElement {
    const template = document.createElement('template');
    template.innerHTML = this.renderQuestionCard(question);
    const element = template.content.firstElementChild;
    if (!element) {
      throw new Error('Failed to render question card: template produced no elements');
    }
    return element as HTMLElement;
  }

  /**
   * Setup event listeners for a single card element
   */
  private setupCardEventListeners(card: HTMLElement): void {
    // Expand icon
    const expandIcon = card.querySelector('.q4h-expand-icon');
    expandIcon?.addEventListener('click', (e) => {
      e.stopPropagation();
      const questionId = card.getAttribute('data-question-id');
      if (questionId) {
        this.toggleQuestion(questionId);
      }
    });

    // Checkbox and header
    const header = card.querySelector('.q4h-question-header');
    const checkbox = card.querySelector('.q4h-checkbox');
    (header || checkbox)?.addEventListener('click', (e) => {
      e.stopPropagation();
      const questionId = card.getAttribute('data-question-id');
      if (questionId) {
        this.toggleSelection(questionId);
      }
    });

    // External link
    const externalLink = card.querySelector('.q4h-external-link');
    externalLink?.addEventListener('click', (e) => {
      e.stopPropagation();
      const questionId = card.getAttribute('data-question-id');
      const question = this.questions.find((q) => q.id === questionId);
      if (question) {
        this.navigateToCallSite(question);
      }
    });
  }

  /**
   * Update question list visibility based on question count
   */
  private updateQuestionListVisibility(): void {
    if (!this.questionListContainer) return;

    const hasQuestions = this.questions.length > 0;
    const emptyState = this.questionListContainer.querySelector('.empty-state');

    if (hasQuestions && emptyState) {
      emptyState.remove();
    } else if (!hasQuestions && !emptyState) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = 'No pending questions';
      this.questionListContainer.appendChild(emptyDiv);
    }
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) return;

    // Expand icon click handlers
    this.shadowRoot.querySelectorAll('.q4h-expand-icon').forEach((icon) => {
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = icon.closest('.q4h-question-card');
        const questionId = card?.getAttribute('data-question-id');
        if (questionId) {
          this.toggleQuestion(questionId);
        }
      });
    });

    // Checkbox and header click handlers (toggle selection)
    this.shadowRoot.querySelectorAll('.q4h-checkbox, .q4h-question-header').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = el.closest('.q4h-question-card');
        const questionId = card?.getAttribute('data-question-id');
        if (questionId) {
          this.toggleSelection(questionId);
        }
      });
    });

    // External link handlers
    this.shadowRoot.querySelectorAll('.q4h-external-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const questionId = link.getAttribute('data-question-id');
        const question = this.questions.find((q) => q.id === questionId);
        if (question) {
          this.navigateToCallSite(question);
        }
      });
    });

    // Text input handlers
    if (this.textInput) {
      this.textInput.addEventListener('input', () => {
        this.updateSendButton();
        this.autoResizeTextarea();
      });

      this.textInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }

    // Send button handler
    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => {
        this.sendMessage();
      });
    }

    // Question footer click handler (toggle list)
    this.questionFooter = this.shadowRoot.querySelector('.question-footer')!;
    if (this.questionFooter) {
      this.questionFooter.addEventListener('click', () => {
        this.toggleList();
      });
    }
  }

  /**
   * Toggle the question list expanded/collapsed state
   */
  private toggleList(): void {
    this.isListExpanded = !this.isListExpanded;
    this.updateListVisibility();

    // Notify parent about state change
    this.dispatchEvent(
      new CustomEvent('q4h-toggle', {
        detail: { expanded: this.isListExpanded },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Update list visibility based on expanded state
   */
  private updateListVisibility(): void {
    if (!this.questionListContainer || !this.questionFooter) return;

    // Update list collapse state
    if (this.isListExpanded) {
      this.questionListContainer.classList.remove('collapsed');
    } else {
      this.questionListContainer.classList.add('collapsed');
    }

    // Update arrow rotation (90deg anti-clockwise: right → up)
    const arrow = this.questionFooter.querySelector('.q4h-toggle-arrow');
    if (arrow) {
      (arrow as HTMLElement).style.transform = this.isListExpanded
        ? 'rotate(-90deg)'
        : 'rotate(0deg)';
    }
  }

  private async sendMessage(): Promise<void> {
    const content = this.textInput.value.trim();

    // Validate input
    if (!content) {
      return;
    }

    if (!this.currentDialog) {
      this.showError('No active dialog');
      return;
    }

    if (this.props.disabled) {
      return;
    }

    // Generate message ID
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    try {
      if (this.selectedQuestionId) {
        // Send as Q4H answer
        this.wsManager.sendRaw({
          type: 'drive_dialog_by_user_answer',
          dialog: this.currentDialog,
          content,
          msgId,
          questionId: this.selectedQuestionId,
          continuationType: 'answer',
        });
      } else {
        // Send as regular message
        this.wsManager.sendRaw({
          type: 'drive_dlg_by_user_msg',
          dialog: this.currentDialog,
          content,
          msgId,
        });
      }

      // Clear input and dispatch event
      this.clear();
      this.dispatchEvent(
        new CustomEvent('usersend', {
          detail: { content },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      this.showError(errorMessage);
    }
  }

  private updateSendButton(): void {
    if (!this.sendButton || !this.textInput) return;

    const hasContent = this.textInput.value.trim().length > 0;
    const canSend = hasContent && !this.props.disabled && !!this.currentDialog;

    this.sendButton.disabled = !canSend;
  }

  private updateUI(): void {
    if (!this.inputWrapper || !this.textInput) return;

    // Update disabled state
    const shouldDisable = this.props.disabled || !this.currentDialog;
    this.inputWrapper.classList.toggle('disabled', shouldDisable);
    this.textInput.disabled = shouldDisable;

    // Update send button
    this.updateSendButton();

    // Update list visibility
    this.updateListVisibility();
  }

  private autoResizeTextarea(): void {
    if (!this.textInput) return;

    this.textInput.style.height = 'auto';
    const scrollHeight = this.textInput.scrollHeight;
    const maxHeight = 120;

    this.textInput.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
  }

  private showError(message: string): void {
    // Add visual error indicator
    if (this.inputWrapper) {
      this.inputWrapper.style.borderColor = 'var(--dominds-danger, #dc3545)';
      this.inputWrapper.style.boxShadow = '0 0 0 3px rgba(220, 53, 69, 0.1)';

      setTimeout(() => {
        this.inputWrapper.style.borderColor = '';
        this.inputWrapper.style.boxShadow = '';
      }, 3000);
    }

    // Dispatch error event
    this.dispatchEvent(
      new CustomEvent('input-error', {
        detail: { message, type: 'error' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== Render Methods ====================

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getComponentHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    // Get element references
    this.textInput = this.shadowRoot.querySelector('.message-input')!;
    this.sendButton = this.shadowRoot.querySelector('.send-button')!;
    this.inputWrapper = this.shadowRoot.querySelector('.input-wrapper')!;
    this.questionListContainer = this.shadowRoot.querySelector('.question-list')!;
    this.questionFooter = this.shadowRoot.querySelector('.question-footer')!;
  }

  private getComponentHTML(): string {
    const questionCount = this.questions.length;
    return `
      <div class="q4h-input-container">
        <div class="question-list ${this.isListExpanded ? '' : 'collapsed'}">
          ${questionCount > 0 ? this.renderQuestions() : '<div class="empty-state">No pending questions</div>'}
        </div>
        <div class="question-footer">
          <div class="question-footer-content">
            <span class="q4h-toggle-arrow" style="transform: ${this.isListExpanded ? 'rotate(-90deg)' : 'rotate(0deg)'}"></span>
            <span class="question-footer-label">
              Pending Questions
              <span class="q4h-count-badge">
                ${questionCount}
              </span>
            </span>
          </div>
        </div>
        <div class="input-section">
          <div class="input-wrapper ${this.selectedQuestionId !== null ? 'q4h-active' : ''} ${this.props.disabled ? 'disabled' : ''}">
            <textarea
              class="message-input"
              placeholder="${this.props.placeholder}"
              maxlength="${this.props.maxLength}"
              rows="1"
              ${this.props.disabled ? 'disabled' : ''}
            ></textarea>
            <button class="send-button" type="button" disabled>
              <svg class="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 L2 22" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M12 2 L22 22" fill="none" stroke="currentColor" stroke-width="2"/>
                <line x1="12" y1="2" x2="12" y2="16.8" stroke="currentColor" stroke-width="2"/>
              </svg>
            </button>
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
        --dominds-primary: #6366f1;
      }

      /* Main container */
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

      /* Question list area - scrollable */
      .question-list {
        flex: 1 1 auto;
        overflow-y: auto;
        min-height: 0;
        padding: 8px 16px;
      }

      .question-list:empty {
        display: none;
      }

      .question-list.collapsed {
        flex: 0 0 0;
        max-height: 0;
        overflow: hidden;
        padding-top: 0;
        padding-bottom: 0;
        margin: 0;
        border: none;
      }

      /* Empty state */
      .empty-state {
        padding: 20px;
        text-align: center;
        color: var(--color-fg-tertiary, #64748b);
        font-size: 13px;
      }

      /* Footer with count badge */
      .question-footer {
        display: flex;
        flex: none;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--color-bg-secondary, #f8fafc);
        cursor: pointer;
        position: relative;
        z-index: 2;
      }

      .question-footer:hover {
        background: var(--color-bg-tertiary, #f1f5f9);
      }

      /* Toggle arrow - points right when collapsed, up when expanded */
      .q4h-toggle-arrow {
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--color-fg-tertiary, #64748b);
        transition: transform 0.2s ease;
        flex-shrink: 0;
        margin-right: 8px;
      }

      .question-footer-content {
        display: flex;
        align-items: center;
      }

      .question-footer-label {
        font-size: 13px;
        font-weight: 600;
        color: var(--color-fg-secondary, #475569);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* Count badge */
      .q4h-count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        background: var(--dominds-primary, #6366f1);
        color: white;
        font-size: 12px;
        font-weight: 600;
        border-radius: 10px;
        box-shadow: 0 2px 4px rgba(99, 102, 241, 0.3);
      }

      .q4h-count-badge.bump {
        animation: countBump 0.3s ease-out;
      }

      @keyframes countBump {
        0% { transform: scale(1); }
        50% { transform: scale(1.3); }
        100% { transform: scale(1); }
      }

      /* Question card styles */
      .q4h-question-card {
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--color-border-primary, #e2e8f0);
        border-radius: 8px;
        margin-bottom: 6px;
        overflow: hidden;
        transition: all 0.2s ease;
      }

      .q4h-question-card:hover {
        border-color: var(--color-accent-primary, #3b82f6);
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
      }

      /* Selected state - purple background */
      .q4h-question-card.selected {
        border-color: var(--dominds-primary, #6366f1);
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 12%, var(--color-bg-secondary, #ffffff));
      }

      .q4h-question-card.selected:hover {
        border-color: var(--dominds-primary, #6366f1);
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
      }

      .q4h-question-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        cursor: pointer;
      }

      .q4h-question-header:hover {
        background: var(--color-bg-tertiary, #f8fafc);
      }

      .q4h-question-card.selected .q4h-question-header:hover {
        background: transparent;
      }

      .q4h-expand-icon {
        font-size: 10px;
        color: var(--color-fg-tertiary, #64748b);
        transition: transform 0.2s ease;
        width: 16px;
        flex-shrink: 0;
      }

      .q4h-external-link {
        font-size: 14px;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        padding: 2px 4px;
        margin-left: auto;
        transition: color 0.2s ease;
        flex-shrink: 0;
      }

      .q4h-external-link:hover {
        color: var(--dominds-primary, #6366f1);
      }

      .q4h-question-card.expanded .q4h-expand-icon {
        transform: rotate(90deg);
      }

      .q4h-checkbox {
        width: 18px;
        height: 18px;
        border: 2px solid var(--color-border-primary, #94a3b8);
        border-radius: 4px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        background: transparent;
      }

      .q4h-question-card.selected .q4h-checkbox {
        background: var(--dominds-primary, #6366f1);
        border-color: var(--dominds-primary, #6366f1);
      }

      .q4h-checkbox-check {
        display: none;
        color: white;
        font-size: 12px;
        line-height: 1;
      }

      .q4h-question-card.selected .q4h-checkbox-check {
        display: block;
      }

      .q4h-question-headline {
        flex: 1;
        font-size: 14px;
        font-weight: 500;
        color: var(--color-fg-primary, #0f172a);
        line-height: 1.4;
      }

      .q4h-question-body {
        display: none;
        padding: 0 10px 10px;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
      }

      .q4h-question-card.expanded .q4h-question-body {
        display: block;
      }

      .q4h-question-content {
        margin-top: 12px;
        font-size: 13px;
        color: var(--color-fg-secondary, #475569);
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .q4h-question-timestamp {
        margin-top: 10px;
        font-size: 12px;
        color: var(--color-fg-tertiary, #64748b);
      }

      .q4h-goto-site-btn {
        margin-top: 12px;
        padding: 8px 14px;
        background: var(--color-accent-primary, #3b82f6);
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .q4h-goto-site-btn:hover {
        background: color-mix(in srgb, var(--color-accent-primary, #3b82f6) 85%, black);
      }

      /* Input section */
      .input-section {
        flex: none;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        padding: 16px;
        background: inherit;
        position: relative;
        z-index: 1;
      }

      .q4h-question-card.selected ~ .input-section {
        border-top-color: transparent;
      }

      .input-wrapper {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        background: var(--dominds-input-bg, #f8f9fa);
        border: 2px solid var(--dominds-border, #e0e0e0);
        border-radius: 24px;
        transition: all 0.2s ease;
        overflow: hidden;
      }

      /* Q4H active state - purple background, no top border */
      .input-wrapper.q4h-active {
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 12%, var(--color-bg-secondary, #ffffff));
        border-color: var(--dominds-primary, #6366f1);
        border-top-color: transparent; /* Remove top border when Q4H selected */
        border-radius: 0 0 24px 24px; /* Remove top rounded corners when Q4H selected */
      }

      .input-wrapper.q4h-active:focus-within {
        border-color: var(--dominds-primary, #6366f1);
        border-top-color: transparent;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
      }

      .input-wrapper:focus-within {
        border-color: var(--dominds-focus, #007acc);
        box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.1);
      }

      .input-wrapper.disabled {
        opacity: 0.6;
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 3%, var(--color-bg-secondary, #f8f9fa));
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
        min-height: 20px;
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
        background: var(--dominds-primary, #6366f1);
        color: white;
        cursor: pointer;
        transition: all 0.2s ease;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .send-button:hover:not(:disabled) {
        background: var(--dominds-primary-hover, #4f46e5);
        transform: scale(1.05);
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

      /* Dark theme */
      :host(.dark) {
        --dominds-bg: #2d2d2d;
        --dominds-fg: #ffffff;
        --dominds-border: #404040;
        --dominds-muted: #9ca3af;
        --dominds-primary: #6366f1;
        --dominds-primary-hover: #4f46e5;
        --dominds-disabled-bg: #2d2d2d;
      }

      :host(.dark) .q4h-input-container {
        background: var(--dominds-bg, #0f172a);
        border-color: var(--color-border-primary, #334155);
      }

      :host(.dark) .question-footer {
        background: var(--color-bg-tertiary, #1e293b);
        border-top-color: var(--color-border-primary, #334155);
      }

      :host(.dark) .question-footer-label {
        color: var(--color-fg-secondary, #cbd5e1);
      }

      :host(.dark) .q4h-question-card {
        background: var(--color-bg-secondary, #1e293b);
        border-color: var(--color-border-primary, #334155);
      }

      :host(.dark) .q4h-question-header:hover {
        background: var(--color-bg-tertiary, #334155);
      }

      :host(.dark) .q4h-question-headline {
        color: var(--color-fg-primary, #f8fafc);
      }

      :host(.dark) .q4h-question-body {
        border-top-color: var(--color-border-primary, #334155);
      }

      :host(.dark) .q4h-question-content {
        color: var(--color-fg-secondary, #cbd5e1);
      }

      :host(.dark) .q4h-question-timestamp {
        color: var(--color-fg-tertiary, #94a3b8);
      }

      :host(.dark) .q4h-external-link {
        color: var(--color-fg-tertiary, #94a3b8);
      }

      :host(.dark) .q4h-external-link:hover {
        color: var(--dominds-primary, #818cf8);
      }

      :host(.dark) .q4h-question-card.selected {
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 20%, var(--color-bg-secondary, #1e293b));
      }

      :host(.dark) .input-wrapper {
        background: var(--dominds-input-bg, #1e293b);
      }

      :host(.dark) .input-wrapper.q4h-active {
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 15%, var(--color-bg-secondary, #1e293b));
        border-top-color: transparent; /* Remove top border when Q4H selected */
        border-radius: 0 0 24px 24px; /* Remove top rounded corners when Q4H selected */
      }

      :host(.dark) .input-wrapper.disabled {
        background: color-mix(in srgb, var(--dominds-primary, #6366f1) 4%, var(--color-bg-secondary, #1e293b));
        border-color: var(--dominds-border, #404040);
      }

      :host(.dark) .message-input {
        color: var(--dominds-fg, #ffffff);
      }

      :host(.dark) .message-input::placeholder {
        color: var(--dominds-muted, #9ca3af);
      }
    `;
  }

  private renderQuestions(): string {
    return this.questions.map((question) => this.renderQuestionCard(question)).join('');
  }

  private renderQuestionCard(question: Q4HQuestion): string {
    const isExpanded = this.expandedQuestions.has(question.id);
    const isSelected = this.selectedQuestionId === question.id;
    const relativeTime = formatRelativeTime(question.askedAt);
    const expandedClass = isExpanded ? 'expanded' : '';
    const selectedClass = isSelected ? 'selected' : '';

    return `
      <div class="q4h-question-card ${expandedClass} ${selectedClass}" data-question-id="${question.id}">
        <div class="q4h-question-header" data-question-id="${question.id}">
          <span class="q4h-checkbox">
            <span class="q4h-checkbox-check">✓</span>
          </span>
          <span class="q4h-expand-icon">▶</span>
          <span class="q4h-question-headline">${this.escapeHtml(question.headLine)}</span>
          <span class="q4h-external-link" data-question-id="${question.id}">↗</span>
        </div>
        <div class="q4h-question-body">
          <div class="q4h-question-content">${this.escapeHtml(question.bodyContent)}</div>
          <div class="q4h-question-timestamp">Asked: ${relativeTime}</div>
        </div>
      </div>
    `;
  }
}

// Register the custom element
if (!customElements.get('dominds-q4h-input')) {
  customElements.define('dominds-q4h-input', DomindsQ4HInput);
}
