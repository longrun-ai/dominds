/**
 * Q4H (Questions for Human) Inline Panel Component
 * Displays pending questions from the dialog hierarchy with navigation to call sites
 * Used inline between conversation and input area
 */

import { getUiStrings } from '../i18n/ui';
import type { LanguageCode } from '../shared/types/language';
import type { HumanQuestion, Q4HDialogContext } from '../shared/types/q4h';
import { renderDomindsMarkdown } from './dominds-markdown-render';

interface Q4HPanelProps {
  /** Total question count */
  count: number;
  /** Dialog contexts with questions */
  dialogContexts: Q4HDialogContext[];
}

export class DomindsQ4HPanel extends HTMLElement {
  private uiLanguage: LanguageCode = 'en';
  private props: Q4HPanelProps = {
    count: 0,
    dialogContexts: [],
  };
  private expandedQuestions: Set<string> = new Set();
  private selectedQuestionId: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes(): string[] {
    return ['ui-language'];
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name !== 'ui-language') return;
    const next = (newValue ?? '').trim();
    this.uiLanguage = next === 'zh' ? 'zh' : 'en';
    this.render();
  }

  connectedCallback(): void {
    const langAttr = (this.getAttribute('ui-language') ?? '').trim();
    this.uiLanguage = langAttr === 'zh' ? 'zh' : 'en';
    this.render();
  }

  /**
   * Update panel state with new questions data
   */
  public setQuestions(count: number, dialogContexts: Q4HDialogContext[]): void {
    this.props.count = count;
    this.props.dialogContexts = dialogContexts;
    if (this.selectedQuestionId !== null) {
      let stillExists = false;
      for (const ctx of dialogContexts) {
        for (const q of ctx.questions) {
          if (q.id === this.selectedQuestionId) {
            stillExists = true;
            break;
          }
        }
        if (stillExists) break;
      }
      if (!stillExists) this.selectedQuestionId = null;
    }
    this.render();
  }

  /**
   * Navigate to a specific question's call site
   * Dispatches event for parent component to handle navigation
   */
  private navigateToCallSite(question: HumanQuestion, dialogContext: Q4HDialogContext): void {
    this.dispatchEvent(
      new CustomEvent('q4h-navigate-call-site', {
        detail: {
          questionId: question.id,
          dialogId: dialogContext.selfId,
          rootId: dialogContext.rootId,
          course: question.callSiteRef.course,
          messageIndex: question.callSiteRef.messageIndex,
          callId: question.callId,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleQuestion(questionId: string): void {
    const wasExpanded = this.expandedQuestions.has(questionId);
    if (wasExpanded) {
      this.expandedQuestions.delete(questionId);
      this.applyExpandedUi(questionId);
      return;
    }

    this.expandedQuestions.add(questionId);
    this.applyExpandedUi(questionId);
    this.dispatchEvent(
      new CustomEvent('q4h-question-expanded', {
        detail: { questionId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  public setSelectedQuestionIdFromApp(questionId: string | null): void {
    if (questionId === this.selectedQuestionId) return;
    this.selectedQuestionId = questionId;
    if (typeof questionId === 'string' && questionId.trim() !== '') {
      this.expandedQuestions.add(questionId);
      this.applyExpandedUi(questionId);
    }
    this.applySelectionUi();
  }

  private applyExpandedUi(questionId: string): void {
    const root = this.shadowRoot;
    if (!root) return;
    const card = root.querySelector(
      `.q4h-question-card[data-question-id="${CSS.escape(questionId)}"]`,
    );
    if (!(card instanceof HTMLElement)) return;
    card.classList.toggle('expanded', this.expandedQuestions.has(questionId));
  }

  private applySelectionUi(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const selectedId = this.selectedQuestionId;
    root.querySelectorAll<HTMLElement>('.q4h-question-card').forEach((card) => {
      const id = card.getAttribute('data-question-id');
      const selected = selectedId !== null && id === selectedId;
      card.classList.toggle('selected', selected);
    });

    if (selectedId !== null) {
      const selectedCard = root.querySelector(
        `.q4h-question-card[data-question-id="${CSS.escape(selectedId)}"]`,
      );
      if (selectedCard instanceof HTMLElement) {
        selectedCard.classList.toggle('expanded', this.expandedQuestions.has(selectedId));
        selectedCard.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /**
   * Toggle question selection (radio behavior - only one selected at a time)
   * If clicking the already selected question, deselect it
   * Dispatches event for parent component to handle the selection
   */
  private selectQuestion(question: HumanQuestion, dialogContext: Q4HDialogContext): void {
    const prevSelectedId = this.selectedQuestionId;
    // Toggle selection: if already selected, deselect it
    if (this.selectedQuestionId === question.id) {
      this.selectedQuestionId = null;
    } else {
      this.selectedQuestionId = question.id;
    }

    if (this.selectedQuestionId === question.id) {
      const wasExpanded = this.expandedQuestions.has(question.id);
      this.expandedQuestions.add(question.id);
      if (!wasExpanded || prevSelectedId !== question.id) {
        this.dispatchEvent(
          new CustomEvent('q4h-question-expanded', {
            detail: { questionId: question.id },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }
    this.applySelectionUi();

    // Dispatch selection event for parent components
    this.dispatchEvent(
      new CustomEvent('q4h-select-question', {
        detail: {
          questionId: this.selectedQuestionId,
          dialogId: dialogContext.selfId,
          rootId: dialogContext.rootId,
          tellaskContent: question.tellaskContent,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) return;

    // Prevent text selection while clicking/dragging inside the list.
    this.shadowRoot.querySelectorAll('.q4h-checkbox, .q4h-question-title').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
    });

    // Expand icon - toggle expand/collapse
    this.shadowRoot.querySelectorAll('.q4h-expand-icon').forEach((icon) => {
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const questionId = target.closest('.q4h-question-card')?.getAttribute('data-question-id');
        if (questionId) {
          this.toggleQuestion(questionId);
        }
      });
    });

    // Checkbox and title - toggle selection (use pointerdown to avoid losing the event if the panel re-renders).
    this.shadowRoot.querySelectorAll('.q4h-checkbox, .q4h-question-title').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = el.closest('.q4h-question-card');
        if (!card) return;

        const questionId = card.getAttribute('data-question-id');
        const dialogId = card.getAttribute('data-dialog-id');
        const rootId = card.getAttribute('data-root-id');

        if (!questionId || !dialogId || !rootId) {
          console.error('Q4H select: missing card identifiers', { questionId, dialogId, rootId });
          return;
        }

        const dialogContexts = this.props.dialogContexts;
        let dialogContext: Q4HDialogContext | undefined;
        for (const ctx of dialogContexts) {
          if (ctx.selfId === dialogId && ctx.rootId === rootId) {
            dialogContext = ctx;
            break;
          }
        }
        if (!dialogContext) {
          console.error('Q4H select: dialogContext not found', { questionId, dialogId, rootId });
          return;
        }

        let question: HumanQuestion | undefined;
        for (const q of dialogContext.questions) {
          if (q.id === questionId) {
            question = q;
            break;
          }
        }
        if (!question) {
          console.error('Q4H select: question not found in dialogContext', {
            questionId,
            dialogId,
            rootId,
          });
          return;
        }

        this.selectQuestion(question, dialogContext);
      });
    });

    // Go to call site button handlers
    this.shadowRoot.querySelectorAll('.q4h-goto-site-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const questionId = target.getAttribute('data-question-id');
        const dialogId = target.getAttribute('data-dialog-id');
        const rootId = target.getAttribute('data-root-id');
        const course = target.getAttribute('data-course');
        const messageIndex = target.getAttribute('data-message-index');
        const callId = target.getAttribute('data-call-id');

        if (questionId && dialogId && rootId && course && messageIndex) {
          this.dispatchEvent(
            new CustomEvent('q4h-navigate-call-site', {
              detail: {
                questionId,
                dialogId,
                rootId,
                course: parseInt(course, 10),
                messageIndex: parseInt(messageIndex, 10),
                callId: callId && callId.trim() !== '' ? callId.trim() : undefined,
              },
              bubbles: true,
              composed: true,
            }),
          );
        }
      });
    });

    // Open external deep link to call site (new tab/window)
    this.shadowRoot.querySelectorAll('.q4h-open-external-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const questionId = target.getAttribute('data-question-id');
        const dialogId = target.getAttribute('data-dialog-id');
        const rootId = target.getAttribute('data-root-id');
        const course = target.getAttribute('data-course');
        const messageIndex = target.getAttribute('data-message-index');
        const callId = target.getAttribute('data-call-id');

        if (!questionId || !dialogId || !rootId || !course || !messageIndex) return;
        const parsedCourse = Number.parseInt(course, 10);
        const parsedMsg = Number.parseInt(messageIndex, 10);
        if (!Number.isFinite(parsedCourse) || !Number.isFinite(parsedMsg)) return;

        this.dispatchEvent(
          new CustomEvent('q4h-open-external', {
            detail: {
              questionId,
              dialogId,
              rootId,
              course: parsedCourse,
              messageIndex: parsedMsg,
              callId: callId && callId.trim() !== '' ? callId.trim() : undefined,
            },
            bubbles: true,
            composed: true,
          }),
        );
      });
    });

    // Share/copy deep link (do NOT open a new tab/window)
    this.shadowRoot.querySelectorAll('.q4h-share-link-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const questionId = target.getAttribute('data-question-id');
        const dialogId = target.getAttribute('data-dialog-id');
        const rootId = target.getAttribute('data-root-id');
        const course = target.getAttribute('data-course');
        const messageIndex = target.getAttribute('data-message-index');
        const callId = target.getAttribute('data-call-id');

        if (!questionId || !dialogId || !rootId || !course || !messageIndex) return;
        const parsedCourse = Number.parseInt(course, 10);
        const parsedMsg = Number.parseInt(messageIndex, 10);
        if (!Number.isFinite(parsedCourse) || !Number.isFinite(parsedMsg)) return;

        this.dispatchEvent(
          new CustomEvent('q4h-share-link', {
            detail: {
              questionId,
              dialogId,
              rootId,
              course: parsedCourse,
              messageIndex: parsedMsg,
              callId: callId && callId.trim() !== '' ? callId.trim() : undefined,
            },
            bubbles: true,
            composed: true,
          }),
        );
      });
    });
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;
    this.setupEventListeners();
    this.applySelectionUi();
  }

  getStyles(): string {
    return `
      :host {
        display: flex;
        position: relative;
        right: auto;
        top: auto;
        bottom: auto;
        width: 100%;
        border-left: none;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        box-shadow: none;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .q4h-panel-content {
        padding: 8px 16px;
        height: 100%;
        min-height: 0;
        overflow-y: auto;
      }

      /* Dialog group styles */
      .q4h-dialog-group {
        margin-bottom: 12px;
      }

      .q4h-dialog-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--color-fg-secondary, #475569);
        margin-bottom: 6px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
      }

      .q4h-dialog-icon {
        font-size: 14px;
      }

      .q4h-dialog-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .q4h-agent-badge {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--color-bg-tertiary, #f1f5f9);
        color: var(--color-fg-tertiary, #64748b);
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
        border-color: var(--color-accent-primary, #007acc);
        box-shadow: 0 2px 8px color-mix(in srgb, var(--color-accent-primary, #007acc) 15%, transparent);
      }

      /* Selected state for question card */
      .q4h-question-card.selected {
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 25%, transparent);
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 12%, var(--color-bg-secondary, #ffffff));
      }

      .q4h-question-card.selected:hover {
        border-color: var(--dominds-primary, #007acc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dominds-primary, #007acc) 35%, transparent);
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

      .q4h-expand-icon {
        color: var(--color-fg-tertiary, #64748b);
        transition: transform 0.2s ease;
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        transform-origin: 50% 50%;
        flex-shrink: 0;
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
        background: var(--dominds-primary, #007acc);
        border-color: var(--dominds-primary, #007acc);
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

      .q4h-question-title {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-fg-primary, #0f172a);
        line-height: 1.35;
        display: inline-flex;
        gap: 6px;
        align-items: baseline;
        min-width: 0;
      }

      .q4h-question-actions-top {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        flex-shrink: 0;
      }

      .q4h-question-origin {
        white-space: nowrap;
      }

      .q4h-question-origin-id {
        white-space: nowrap;
      }

      .q4h-question-origin-asked-at {
        color: var(--color-fg-tertiary, #64748b);
        font-weight: 500;
        white-space: nowrap;
      }

      .q4h-question-origin-sep {
        color: var(--color-fg-tertiary, #64748b);
        font-weight: 400;
        white-space: nowrap;
      }

      .q4h-question-body {
        display: none;
        padding: 0 10px 10px;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
      }

      .q4h-question-card.expanded .q4h-question-body {
        display: block;
        animation: expandIn 0.2s ease-out;
      }

      @keyframes expandIn {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .q4h-tellask {
        margin-top: 12px;
        font-size: 12px;
        color: var(--color-fg-secondary, #334155);
        background: var(--color-bg-tertiary, #f8fafc);
        border: 1px solid var(--color-border-primary, #e2e8f0);
        border-radius: 8px;
        padding: 10px 10px;
      }

      .q4h-tellask-headline,
      .q4h-tellask-body {
        white-space: normal;
        word-break: break-word;
      }

      .q4h-tellask-headline p,
      .q4h-tellask-body p {
        margin: 0;
      }

      .q4h-tellask-headline pre,
      .q4h-tellask-body pre {
        margin: 8px 0 0 0;
      }

      .q4h-tellask-sep {
        border: none;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        margin: 8px 0;
      }

      .q4h-goto-site-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .q4h-open-external-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .q4h-share-link-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .q4h-goto-site-btn:hover,
      .q4h-open-external-btn:hover,
      .q4h-share-link-btn:hover {
        border-color: var(--color-border-primary, #e2e8f0);
        background: var(--color-bg-tertiary, #f8fafc);
        color: var(--color-fg-secondary, #475569);
      }

      .q4h-goto-site-btn:focus-visible,
      .q4h-open-external-btn:focus-visible,
      .q4h-share-link-btn:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--color-fg-tertiary, #64748b) 70%, transparent);
        outline-offset: 2px;
      }

    `;
  }

  getHTML(): string {
    const { dialogContexts } = this.props;

    // Return empty content when no questions - panel should be hidden when collapsed
    if (dialogContexts.length === 0) {
      return '';
    }

    return `
      <div class="q4h-panel-content">
        ${this.renderQuestions(dialogContexts)}
      </div>
    `;
  }

  private renderQuestions(dialogContexts: Q4HDialogContext[]): string {
    return dialogContexts
      .map((ctx) => {
        if (ctx.questions.length === 0) return '';

        return `
          <div class="q4h-dialog-group">
            <div class="q4h-dialog-header">
              <span class="q4h-dialog-icon">📍</span>
              <span class="q4h-dialog-name" title="${this.escapeHtml(ctx.taskDocPath)}">
                ${this.escapeHtml(this.truncatePath(ctx.taskDocPath, 30))}
              </span>
              <span class="q4h-agent-badge">@${this.escapeHtml(ctx.agentId)}</span>
            </div>
            ${ctx.questions.map((q) => this.renderQuestionCard(q, ctx)).join('')}
          </div>
        `;
      })
      .join('');
  }

  private renderQuestionCard(question: HumanQuestion, dialogContext: Q4HDialogContext): string {
    const isExpanded = this.expandedQuestions.has(question.id);
    const isSelected = this.selectedQuestionId === question.id;
    const expandedClass = isExpanded ? 'expanded' : '';
    const selectedClass = isSelected ? 'selected' : '';
    const t = getUiStrings(this.uiLanguage);

    return `
      <div class="q4h-question-card ${expandedClass} ${selectedClass}" data-question-id="${question.id}" data-dialog-id="${dialogContext.selfId}" data-root-id="${dialogContext.rootId}" data-agent-id="${dialogContext.agentId}" data-asked-at="${question.askedAt}">
        <div class="q4h-question-header" data-question-id="${question.id}">
          <span class="q4h-checkbox">
            <span class="q4h-checkbox-check">✓</span>
          </span>
          <span class="q4h-expand-icon" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" focusable="false">
              <polygon points="3,2 3,10 10,6"></polygon>
            </svg>
          </span>
          <span class="q4h-question-title">
            <span class="q4h-question-origin">@${this.escapeHtml(dialogContext.agentId)}</span>
            <span class="q4h-question-origin-sep">•</span>
            <span class="q4h-question-origin-id">${this.escapeHtml(dialogContext.selfId)}</span>
            <span class="q4h-question-origin-sep">•</span>
            <span class="q4h-question-origin-asked-at">${this.escapeHtml(question.askedAt)}</span>
          </span>
          <span class="q4h-question-actions-top">
            <button
              class="q4h-goto-site-btn"
              type="button"
              title="${this.escapeHtml(t.q4hGoToCallSiteTitle)}"
              aria-label="${this.escapeHtml(t.q4hGoToCallSiteTitle)}"
              data-question-id="${question.id}"
              data-dialog-id="${dialogContext.selfId}"
              data-root-id="${dialogContext.rootId}"
              data-course="${question.callSiteRef.course}"
              data-message-index="${question.callSiteRef.messageIndex}"
              data-call-id="${this.escapeHtml(question.callId ?? '')}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 19V5"></path>
                <path d="m5 12 7-7 7 7"></path>
              </svg>
            </button>
            <button
              class="q4h-open-external-btn"
              type="button"
              title="${this.escapeHtml(t.q4hOpenInNewTabTitle)}"
              aria-label="${this.escapeHtml(t.q4hOpenInNewTabTitle)}"
              data-question-id="${question.id}"
              data-dialog-id="${dialogContext.selfId}"
              data-root-id="${dialogContext.rootId}"
              data-course="${question.callSiteRef.course}"
              data-message-index="${question.callSiteRef.messageIndex}"
              data-call-id="${this.escapeHtml(question.callId ?? '')}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3h7v7"></path>
                <path d="M10 14L21 3"></path>
                <path d="M21 14v7H3V3h7"></path>
              </svg>
            </button>
            <button
              class="q4h-share-link-btn"
              type="button"
              title="${this.escapeHtml(t.q4hCopyLinkTitle)}"
              aria-label="${this.escapeHtml(t.q4hCopyLinkTitle)}"
              data-question-id="${question.id}"
              data-dialog-id="${dialogContext.selfId}"
              data-root-id="${dialogContext.rootId}"
              data-course="${question.callSiteRef.course}"
              data-message-index="${question.callSiteRef.messageIndex}"
              data-call-id="${this.escapeHtml(question.callId ?? '')}"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"></path>
                <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"></path>
              </svg>
            </button>
          </span>
        </div>
        <div class="q4h-question-body">
          <div class="q4h-tellask">
            <div class="q4h-tellask-headline">Q4H</div>
            <hr class="q4h-tellask-sep" />
            <div class="q4h-tellask-body">${renderDomindsMarkdown(question.tellaskContent, { kind: 'chat' })}</div>
          </div>
        </div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private truncatePath(path: string, maxLength: number): string {
    if (path.length <= maxLength) return path;
    const parts = path.split('/');
    if (parts.length <= 2) return path;
    return '...' + parts.slice(-2).join('/');
  }
}

// Register the custom element
if (!customElements.get('dominds-q4h-panel')) {
  customElements.define('dominds-q4h-panel', DomindsQ4HPanel);
}
