/**
 * Q4H (Questions for Human) Inline Panel Component
 * Displays pending questions from the dialog hierarchy with navigation to call sites
 * Used inline between conversation and input area
 */

import type { HumanQuestion, Q4HDialogContext } from '../shared/types/q4h';

interface Q4HPanelProps {
  /** Total question count */
  count: number;
  /** Dialog contexts with questions */
  dialogContexts: Q4HDialogContext[];
}

export class DomindsQ4HPanel extends HTMLElement {
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

  connectedCallback(): void {
    this.render();
  }

  /**
   * Update panel state with new questions data
   */
  public setQuestions(count: number, dialogContexts: Q4HDialogContext[]): void {
    this.props.count = count;
    this.props.dialogContexts = dialogContexts;
    this.render();
    this.setupEventListeners();
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
          round: question.callSiteRef.round,
          messageIndex: question.callSiteRef.messageIndex,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleQuestion(questionId: string): void {
    if (this.expandedQuestions.has(questionId)) {
      this.expandedQuestions.delete(questionId);
    } else {
      this.expandedQuestions.add(questionId);
    }
    this.render();
    this.setupEventListeners();
  }

  /**
   * Toggle question selection (radio behavior - only one selected at a time)
   * If clicking the already selected question, deselect it
   * Dispatches event for parent component to handle the selection
   */
  private selectQuestion(question: HumanQuestion, dialogContext: Q4HDialogContext): void {
    // Toggle selection: if already selected, deselect it
    if (this.selectedQuestionId === question.id) {
      this.selectedQuestionId = null;
    } else {
      this.selectedQuestionId = question.id;
    }
    this.render();
    this.setupEventListeners();

    // Dispatch selection event for parent components
    this.dispatchEvent(
      new CustomEvent('q4h-select-question', {
        detail: {
          questionId: this.selectedQuestionId,
          dialogId: dialogContext.selfId,
          rootId: dialogContext.rootId,
          kind: question.kind,
          headLine: question.headLine,
          bodyContent: question.bodyContent,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) return;

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

    // Checkbox and title - toggle selection
    this.shadowRoot.querySelectorAll('.q4h-checkbox, .q4h-question-title').forEach((el) => {
      el.addEventListener('click', (e) => {
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
        const target = e.currentTarget as HTMLElement;
        const questionId = target.getAttribute('data-question-id');
        const dialogId = target.getAttribute('data-dialog-id');
        const rootId = target.getAttribute('data-root-id');
        const round = target.getAttribute('data-round');
        const messageIndex = target.getAttribute('data-message-index');

        if (questionId && dialogId && rootId && round && messageIndex) {
          this.dispatchEvent(
            new CustomEvent('q4h-navigate-call-site', {
              detail: {
                questionId,
                dialogId,
                rootId,
                round: parseInt(round, 10),
                messageIndex: parseInt(messageIndex, 10),
              },
              bubbles: true,
              composed: true,
            }),
          );
        }
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
        max-height: 150px;
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
        font-size: 10px;
        color: var(--color-fg-tertiary, #64748b);
        transition: transform 0.2s ease;
        width: 16px;
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

      .q4h-question-call {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .q4h-question-call-headline {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
          'Courier New', monospace;
        font-size: 12px;
        color: var(--color-fg-primary, #0f172a);
        background: var(--color-bg-tertiary, #f8fafc);
        border: 1px solid var(--color-border-primary, #e2e8f0);
        border-radius: 6px;
        padding: 6px 8px;
        white-space: pre-wrap;
      }

      .q4h-question-call-body {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
          'Courier New', monospace;
        font-size: 12px;
        color: var(--color-fg-secondary, #475569);
        background: var(--color-bg-tertiary, #f8fafc);
        border: 1px solid var(--color-border-primary, #e2e8f0);
        border-radius: 6px;
        padding: 8px;
        margin: 0;
        white-space: pre-wrap;
      }

      .q4h-goto-site-btn {
        margin-top: 12px;
        padding: 8px 14px;
        background: var(--color-accent-primary, #007acc);
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .q4h-goto-site-btn:hover {
        background: color-mix(in srgb, var(--color-accent-primary, #007acc) 85%, black);
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

    return `
      <div class="q4h-question-card ${expandedClass} ${selectedClass}" data-question-id="${question.id}" data-dialog-id="${dialogContext.selfId}" data-root-id="${dialogContext.rootId}" data-agent-id="${dialogContext.agentId}" data-asked-at="${question.askedAt}">
        <div class="q4h-question-header" data-question-id="${question.id}">
          <span class="q4h-checkbox">
            <span class="q4h-checkbox-check">✓</span>
          </span>
          <span class="q4h-expand-icon">▶</span>
          <span class="q4h-question-title">
            <span class="q4h-question-origin">@${this.escapeHtml(dialogContext.agentId)}</span>
            <span class="q4h-question-origin-sep">•</span>
            <span class="q4h-question-origin-id">${this.escapeHtml(dialogContext.selfId)}</span>
            <span class="q4h-question-origin-sep">•</span>
            <span class="q4h-question-origin-asked-at">${this.escapeHtml(question.askedAt)}</span>
          </span>
        </div>
        <div class="q4h-question-body">
          <div class="q4h-question-call">
            <code class="q4h-question-call-headline">${this.escapeHtml(question.headLine)}</code>
            <pre class="q4h-question-call-body">${this.escapeHtml(question.bodyContent)}</pre>
          </div>
          <button
            class="q4h-goto-site-btn"
            data-question-id="${question.id}"
            data-dialog-id="${dialogContext.selfId}"
            data-root-id="${dialogContext.rootId}"
            data-round="${question.callSiteRef.round}"
            data-message-index="${question.callSiteRef.messageIndex}"
          >
            Go to call site →
          </button>
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
