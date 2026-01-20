/**
 * Simple Dialog Container - Direct DOM Updates Based on Wire Protocol Packets
 */

import mannedToolIcon from '../assets/manned-tool.svg';
import walkieTalkieIcon from '../assets/walkie-talkie.svg';
import { formatToolCallErrorInline, parseToolCallError } from '../i18n/tool-call-errors';
import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import { getWebSocketManager } from '../services/websocket.js';
import type {
  EndOfUserSayingEvent,
  FullRemindersEvent,
  FuncCallStartEvent,
  SubdialogEvent,
  TeammateResponseEvent,
  ToolCallFinishEvent,
  ToolCallResponseEvent,
  TypedDialogEvent,
} from '../shared/types/dialog';
import type { LanguageCode } from '../shared/types/language';
import { normalizeLanguageCode } from '../shared/types/language';
import type { DialogInterruptionReason, DialogRunState } from '../shared/types/run-state';
import type { AssignmentFromSup, DialogIdent } from '../shared/types/wire';
import { formatTeammateResponseContent } from '../shared/utils/inter-dialog-format';
import { DomindsCodeBlock } from './dominds-code-block';
import { DomindsMarkdownSection } from './dominds-markdown-section';

type DialogContext = DialogIdent & {
  agentId?: string;
  supdialogId?: string;
  topicId?: string;
  assignmentFromSup?: AssignmentFromSup;
};

export class DomindsDialogContainer extends HTMLElement {
  private wsManager = getWebSocketManager();
  private currentDialog?: DialogContext;
  private uiLanguage: LanguageCode = 'en';
  private serverWorkLanguage: LanguageCode = 'en';
  private runState: DialogRunState | null = null;
  private activeGeneratingDialog?: DialogIdent;
  // Track previous dialog to handle race conditions during navigation
  // Events may arrive for the "old" dialog briefly after navigation
  private previousDialog?: DialogContext;

  // During dialog/round navigation, we intentionally clear the DOM. Late streaming events can still
  // arrive during that window; suppress them to avoid protocol errors from missing sections.
  private suppressEvents = false;

  public setServerWorkLanguage(language: LanguageCode): void {
    this.serverWorkLanguage = language;
  }

  // State tracking
  private currentRound?: number;
  private activeGenSeq?: number;

  // DOM references
  private generationBubble?: HTMLElement;
  private thinkingSection?: HTMLElement;
  private markdownSection?: DomindsMarkdownSection;
  private callingSection?: HTMLElement;
  private codeblockSection?: DomindsCodeBlock;

  // Best-effort cache to recover tool-call streaming sections by genseq.
  // Tool-call chunk events don't carry callId, so this is scoped to per-genseq recovery only.
  private toolCallingSectionBySeq = new Map<number, HTMLElement>();

  // Track calling sections by callId for direct lookup (tool calls only)
  private callingSectionByCallId = new Map<string, HTMLElement>();
  // Tool call responses can arrive before the corresponding calling section has finished streaming
  // (and therefore before tool_call_finish_evt sets data-call-id + populates callingSectionByCallId).
  // Buffer by callId and attach when the calling section is finalized.
  private pendingToolCallResponsesByCallId = new Map<string, ToolCallResponseEvent>();

  // Team configuration for dynamic agent labels and icons
  private teamConfiguration: {
    memberDefaults: { icon?: string; name?: string };
    members: Record<string, { icon?: string; name?: string }>;
  } | null = null;

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
    const parsed = normalizeLanguageCode(newValue || '');
    this.uiLanguage = parsed ?? 'en';
    this.updateResumePanel();
  }

  async connectedCallback(): Promise<void> {
    const parsed = normalizeLanguageCode(this.getAttribute('ui-language') || '');
    this.uiLanguage = parsed ?? 'en';
    this.render();
    await this.loadTeamConfiguration();
    const sr = this.shadowRoot;
    if (sr) {
      sr.addEventListener('click', async (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const btn = target.closest('.codeblock-action') as HTMLButtonElement | null;
        if (btn) {
          const section = btn.closest('.codeblock-section') as HTMLElement | null;
          const contentEl = section?.querySelector('.codeblock-content') as HTMLElement | null;
          const text = contentEl?.textContent || '';
          try {
            await navigator.clipboard.writeText(text);
            const prev = btn.textContent || '';
            btn.textContent = '✅';
            setTimeout(() => (btn.textContent = prev || '📋'), 1200);
          } catch (err) {
            try {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              document.execCommand('copy');
              ta.remove();
              const prev = btn.textContent || '';
              btn.textContent = '✅';
              setTimeout(() => (btn.textContent = prev || '📋'), 1200);
            } catch (err2) {
              console.warn('Clipboard write failed', err2);
            }
          }
        }
      });
    }
  }

  disconnectedCallback(): void {
    this.cleanup();
  }

  private async loadTeamConfiguration(): Promise<void> {
    try {
      const api = getApiClient();
      const resp = await api.getTeamConfig();
      if (!resp.success || !resp.data) {
        throw new Error(resp.error || 'Failed to load team config');
      }
      const cfg = resp.data.configuration;
      this.teamConfiguration = {
        memberDefaults: { icon: cfg.memberDefaults.icon, name: cfg.memberDefaults.name },
        members: Object.fromEntries(
          Object.entries(cfg.members).map(([id, m]) => [id, { icon: m.icon, name: m.name }]),
        ),
      };
    } catch (error) {
      console.warn('Failed to load team configuration, using defaults:', error);
      // Fallback to basic configuration if API fails
      this.teamConfiguration = {
        memberDefaults: { icon: '🤖' },
        members: {},
      };
    }
  }

  public async setDialog(dialog: DialogContext): Promise<void> {
    this.suppressEvents = true;
    // Save current dialog as previous before cleanup
    // This allows events for the "old" dialog to be processed during navigation race conditions
    if (this.currentDialog) {
      this.previousDialog = this.currentDialog;
    }
    this.cleanup();
    if (typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
      this.handleProtocolError('Invalid dialog id: selfId/rootId must be strings');
      console.error('Invalid DialogIdent', dialog);
      this.suppressEvents = false;
      return;
    }
    this.currentDialog = dialog;

    this.render();
    this.suppressEvents = false;
  }

  public clearDialog(): void {
    this.suppressEvents = true;
    this.cleanup();
    this.currentDialog = undefined;
    this.render();
    this.suppressEvents = false;
  }

  public getCurrentDialog(): DialogContext | undefined {
    return this.currentDialog;
  }

  public updateDialogContext(dialog: DialogContext): void {
    const current = this.currentDialog;
    if (!current) {
      this.currentDialog = dialog;
      return;
    }
    if (current.selfId !== dialog.selfId || current.rootId !== dialog.rootId) {
      return;
    }
    const merged: DialogContext = { ...current, ...dialog };
    if (!dialog.assignmentFromSup && current.assignmentFromSup) {
      merged.assignmentFromSup = current.assignmentFromSup;
    }
    this.currentDialog = merged;
  }

  public async setCurrentRound(round: number): Promise<void> {
    if (!this.currentDialog) return;
    this.suppressEvents = true;
    this.cleanup();
    this.currentRound = round;
    this.wsManager.sendRaw({
      type: 'display_round',
      dialog: this.currentDialog,
      round: round,
    });
    this.render();
    this.suppressEvents = false;
  }

  /**
   * Reset the dialog container for an in-place round transition (new round started).
   * This clears all bubbles/sections from the previous round so the UI only shows the new round.
   *
   * Unlike setCurrentRound(), this does NOT request a round replay from the backend;
   * it relies on live events that follow the round_update event.
   */
  public resetForRound(round: number): void {
    this.clearGenerationGlow();
    // Reset per-round rendering state, but keep currentDialog/previousDialog intact.
    this.generationBubble = undefined;
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.codeblockSection = undefined;
    this.currentRound = round;
    this.activeGenSeq = undefined;
    this.callingSectionByCallId.clear();
    this.pendingToolCallResponsesByCallId.clear();

    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (messages) {
      messages.innerHTML = '';
    }
  }

  // Clean up current state and DOM content
  private cleanup(): void {
    this.clearGenerationGlow();
    this.previousDialog = undefined;
    this.runState = null;
    this.generationBubble = undefined;
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.codeblockSection = undefined;
    this.currentRound = undefined;
    this.activeGenSeq = undefined;
    this.callingSectionByCallId.clear();
    this.pendingToolCallResponsesByCallId.clear();

    // Clear all DOM messages when switching dialogs
    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (messages) {
      messages.innerHTML = '';
    }
  }

  private clearGenerationGlow(): void {
    const active = this.activeGeneratingDialog;
    if (!active) return;
    this.dispatchEvent(
      new CustomEvent('dlg-generation-state', {
        detail: { rootId: active.rootId, selfId: active.selfId, active: false },
        bubbles: true,
        composed: true,
      }),
    );
    this.activeGeneratingDialog = undefined;
  }

  private setGenerationGlowActive(active: boolean): void {
    const dialog = this.currentDialog;
    if (!dialog) return;
    const ident: DialogIdent = { rootId: dialog.rootId, selfId: dialog.selfId };
    this.activeGeneratingDialog = active ? ident : undefined;
    this.dispatchEvent(
      new CustomEvent('dlg-generation-state', {
        detail: { rootId: ident.rootId, selfId: ident.selfId, active },
        bubbles: true,
        composed: true,
      }),
    );
  }

  public async handleDialogEvent(event: TypedDialogEvent): Promise<void> {
    // Security check: only process events for the current active dialog
    // Also allow events for the previous dialog during navigation race conditions
    if (event.dialog) {
      const isCurrentDialog =
        this.currentDialog &&
        event.dialog.selfId === this.currentDialog.selfId &&
        event.dialog.rootId === this.currentDialog.rootId;
      const isPreviousDialog =
        this.previousDialog &&
        event.dialog.selfId === this.previousDialog.selfId &&
        event.dialog.rootId === this.previousDialog.rootId;

      if (!isCurrentDialog && !isPreviousDialog) {
        console.warn('DialogContainer: Ignoring event for different dialog', {
          eventDialog: event.dialog,
          currentDialog: this.currentDialog,
          previousDialog: this.previousDialog,
        });
        return;
      }
    }

    if (
      this.suppressEvents &&
      event.type !== 'full_reminders_update' &&
      event.type !== 'new_q4h_asked' &&
      event.type !== 'q4h_answered'
    ) {
      return;
    }

    const currentRound = this.currentRound;
    if (currentRound !== undefined) {
      // After a round transition (round_update -> resetForRound), the backend can still emit
      // late events from the previous round. The UX rule is "one round in the timeline",
      // so we must drop out-of-round events instead of trying to attach them to missing bubbles.
      if ('round' in event && typeof (event as { round?: unknown }).round === 'number') {
        const round = (event as { round: number }).round;
        if (round !== currentRound) {
          return;
        }
      }
    }

    switch (event.type) {
      case 'dlg_run_state_evt':
        this.runState = event.runState;
        this.updateResumePanel();
        break;

      case 'dlg_run_state_marker_evt': {
        let reasonText: string | undefined;
        const reason = event.reason;
        if (reason) {
          reasonText = this.formatInterruptionReason(reason);
        }
        this.appendRunStateMarker({ kind: event.kind, reason: reasonText });
        break;
      }

      case 'end_of_user_saying_evt':
        {
          // Render <hr/> separator between user content and AI response
          const ev: EndOfUserSayingEvent = event;
          if (typeof ev.round !== 'number' || typeof ev.genseq !== 'number') {
            this.handleProtocolError('end_of_user_saying_evt missing required fields');
            break;
          }
          if (typeof ev.msgId !== 'string' || typeof ev.content !== 'string') {
            this.handleProtocolError('end_of_user_saying_evt missing required fields');
            break;
          }
          this.handleEndOfUserSaying(ev);
        }
        break;

      // LLM Generation Signals (frontend bubble management)
      case 'generating_start_evt':
        if (typeof event.round !== 'number') {
          this.handleProtocolError('generating_start_evt missing required field: round');
        }
        if (typeof event.genseq !== 'number') {
          this.handleProtocolError('generating_start_evt missing required field: genseq');
        }
        this.currentRound = event.round;
        this.activeGenSeq = event.genseq;
        this.setGenerationGlowActive(true);
        // Mark generation as started - this ensures substreams arrive in correct order
        this.handleGeneratingStart(event.genseq, event.timestamp);
        break;
      case 'generating_finish_evt':
        {
          if (typeof event.genseq !== 'number') {
            this.handleProtocolError('generating_finish_evt missing required field: genseq');
            break;
          }
          // Delegate to handleGeneratingFinish which handles all cases gracefully:
          // - missing bubble: logs warning, cleans up state, returns
          // - seq mismatch: logs warning but proceeds
          // - valid case: completes the bubble
          this.handleGeneratingFinish(event.genseq);
          this.activeGenSeq = undefined;
          this.clearGenerationGlow();
        }
        break;
      case 'context_health_evt':
        // Handled at the app toolbar layer; ignore in dialog timeline.
        break;

      // Thinking stream
      case 'thinking_start_evt':
        this.handleThinkingStart(event.genseq, event.timestamp);
        break;
      case 'thinking_chunk_evt':
        this.handleThinkingChunk(event.genseq, event.chunk, event.timestamp);
        break;
      case 'thinking_finish_evt':
        this.handleThinkingFinish(event.genseq);
        break;

      // Saying events, delimit substreams (markdown/codeblock/calling) derived from the same saying stream
      case 'saying_start_evt':
        break;
      case 'saying_finish_evt':
        break;

      // Markdown stream
      case 'markdown_start_evt':
        this.handleMarkdownStart(event.genseq, event.timestamp);
        break;
      case 'markdown_chunk_evt':
        this.handleMarkdownChunk(event.genseq, event.chunk, event.timestamp);
        break;
      case 'markdown_finish_evt':
        this.handleMarkdownFinish(event.genseq);
        break;

      // === TOOL CALL EVENTS (streaming mode - @tool_name calls) ===
      // Renamed from call_* to tool_call_* for consistency
      // callId is now set at finish event (not start) - content-hash based
      case 'tool_call_start_evt':
        this.handleToolCallStart(event);
        break;
      case 'tool_call_headline_chunk_evt':
        this.handleToolCallHeadlineChunk(event.genseq, event.chunk);
        break;
      case 'tool_call_headline_finish_evt':
        this.handleToolCallHeadlineFinish(event.genseq);
        break;
      case 'tool_call_body_start_evt':
        this.handleToolCallBodyStart(event.genseq, event.infoLine);
        break;
      case 'tool_call_body_chunk_evt':
        this.handleToolCallBodyChunk(event.genseq, event.chunk);
        break;
      case 'tool_call_body_finish_evt':
        this.handleToolCallBodyFinish(event.genseq, event.endQuote);
        break;
      case 'tool_call_finish_evt':
        this.handleToolCallFinish(event);
        break;

      // === TEAMMATE CALL EVENTS (streaming mode - @agentName and @human calls) ===
      // Q4H (Quest for Human) support: @human uses calleeDialogId="human" (no subdialog)
      case 'teammate_call_start_evt':
        this.handleTeammateCallStart(event);
        break;
      case 'teammate_call_headline_chunk_evt':
        this.handleTeammateCallHeadlineChunk(event.genseq, event.chunk);
        break;
      case 'teammate_call_headline_finish_evt':
        this.handleTeammateCallHeadlineFinish(event.genseq);
        break;
      case 'teammate_call_body_start_evt':
        this.handleTeammateCallBodyStart(event.genseq, event.infoLine);
        break;
      case 'teammate_call_body_chunk_evt':
        this.handleTeammateCallBodyChunk(event.genseq, event.chunk);
        break;
      case 'teammate_call_body_finish_evt':
        this.handleTeammateCallBodyFinish(event.genseq, event.endQuote);
        break;
      case 'teammate_call_finish_evt':
        this.handleTeammateCallFinish();
        break;

      // === FUNCTION CALLS (non-streaming mode - direct tool execution) ===
      case 'func_call_requested_evt': {
        const ev: FuncCallStartEvent = event;
        this.handleFuncCallRequested(ev.funcId, ev.funcName, ev.arguments);
        break;
      }

      // Code block stream
      case 'codeblock_start_evt':
        this.handleCodeBlockStart(event.infoLine);
        break;
      case 'codeblock_chunk_evt':
        this.handleCodeBlockChunk(event.chunk);
        break;
      case 'codeblock_finish_evt':
        this.handleCodeBlockFinish(event.endQuote);
        break;

      // Function results
      case 'func_result_evt':
        if (this.generationBubble && this.currentRound !== event.round) {
          this.handleProtocolError('func_result event.round mismatch with active generation');
          console.error('Function result mismatch', {
            activeSeq: this.activeGenSeq,
            round: this.currentRound,
            evtRound: event.round,
          });
          return;
        }
        this.handleFuncResult(event);
        break;

      // Texting responses (tool calls - attach inline)
      case 'tool_call_response_evt':
        this.handleToolCallResponse(event);
        break;

      // Teammate responses (separate bubble)
      case 'teammate_response_evt':
        this.handleTeammateResponse(event);
        break;

      // Subdialog events
      case 'subdialog_created_evt':
        this.handleSubdialogCreated(event);
        break;

      // Reminder events
      case 'full_reminders_update':
        this.handleFullRemindersUpdate(event);
        break;

      case 'stream_error_evt':
        if (!this.generationBubble) {
          const host = (this.getRootNode() as ShadowRoot)?.host as HTMLElement | null;
          const detail = { message: String(event.error || 'Unknown stream error'), kind: 'error' };
          host?.dispatchEvent(
            new CustomEvent('ui-toast', { detail, bubbles: true, composed: true }),
          );
          break;
        }
        if (
          event.genseq !== undefined &&
          (this.activeGenSeq === undefined || this.activeGenSeq !== event.genseq)
        ) {
          this.handleProtocolError('stream_error_evt event.genseq mismatch');
          console.error('Stream error mismatch', {
            activeSeq: this.activeGenSeq,
            seq: event.genseq,
            round: this.currentRound,
            evtRound: event.round,
          });
        }
        this.handleError(String(event.error));
        break;

      // Historical stream events removed; only stream_error_evt may appear and is handled elsewhere
      default:
        this.handleProtocolError(`Unhandled dialog event: ${String(event.type)}`);
    }
  }

  // === GENERATING EVENTS (Frontend Bubble Management) ===
  private handleGeneratingStart(seq: number, timestamp: string): void {
    const existingBubble = this.generationBubble;
    if (existingBubble) {
      const existingSeq = existingBubble.getAttribute('data-seq');
      if (existingSeq === String(seq)) {
        // Generation bubble was created earlier (out-of-order event recovery).
        // Still ensure the bubble is in "generating" state and the timestamp is correct.
        existingBubble.classList.add('generating');
        existingBubble.setAttribute('data-finalized', 'false');
        this.setBubbleTimestamp(existingBubble, timestamp);
        this.activeGenSeq = seq;
        return;
      }

      // If a new generation starts before we saw finish for the prior bubble,
      // finalize the old bubble to avoid mixing streams across seq values.
      existingBubble.classList.remove('generating');
      existingBubble.classList.add('completed');
      existingBubble.setAttribute('data-finalized', 'true');
      this.thinkingSection = undefined;
      this.markdownSection = undefined;
      this.callingSection = undefined;
      this.codeblockSection = undefined;
      this.generationBubble = undefined;
    }

    this.activeGenSeq = seq;

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;

    const bubble = this.createGenerationBubble(timestamp);
    bubble.setAttribute('data-seq', String(seq));
    bubble.classList.add('generating'); // Start breathing glow animation
    if (container) {
      container.appendChild(bubble);
    }
    this.generationBubble = bubble;
  }

  private ensureGenerationBubbleForSeq(seq: number, timestamp: string): HTMLElement | null {
    const currentBubble = this.generationBubble;
    if (currentBubble && currentBubble.getAttribute('data-seq') === String(seq)) {
      return currentBubble;
    }

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    const existing = container
      ? (container.querySelector(`.generation-bubble[data-seq="${seq}"]`) as HTMLElement | null)
      : null;
    if (existing) {
      this.generationBubble = existing;
      this.activeGenSeq = seq;
      return existing;
    }

    this.handleGeneratingStart(seq, timestamp);
    return this.generationBubble ?? null;
  }

  private handleGeneratingFinish(seq: number): void {
    const bubble = this.generationBubble;
    if (!bubble) {
      // Gracefully handle orphan finish - no active generation bubble
      // This can happen when navigation clears the bubble but events still arrive
      if (this.activeGenSeq === seq) {
        console.warn(
          'generating_finish_evt: bubble was cleared during navigation, cleaning up activeGenSeq',
          { seq, activeGenSeq: this.activeGenSeq },
        );
        this.activeGenSeq = undefined;
      } else {
        console.warn('generating_finish_evt received without active generation bubble, skipping', {
          seq,
          activeGenSeq: this.activeGenSeq,
        });
      }
      return;
    }

    const attrSeq = bubble.getAttribute('data-seq');
    if (attrSeq !== String(seq)) {
      // Log warning but still complete - sequence mismatch but bubble exists
      console.warn(
        `generating_finish_evt seq mismatch: expected ${attrSeq}, got ${seq}, proceeding anyway`,
      );
    }

    bubble.classList.remove('generating');
    bubble.classList.add('completed');
    bubble.setAttribute('data-finalized', 'true');
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.codeblockSection = undefined;
    this.generationBubble = undefined;
    // Clear previousDialog since we've completed the generation for that dialog
    this.previousDialog = undefined;
  }

  // === THINKING EVENTS (Inside Generation Bubble) ===
  private handleThinkingStart(genseq: number, timestamp: string): void {
    const bubble = this.ensureGenerationBubbleForSeq(genseq, timestamp);
    if (!bubble) {
      console.warn('thinking_start_evt received without generation bubble, skipping');
      return;
    }
    // Always create new thinking section - no existing check logic
    const thinkingSection = this.createThinkingSection();
    const body = bubble.querySelector('.bubble-body');
    (body || bubble).appendChild(thinkingSection);
    this.thinkingSection = thinkingSection;
    this.scrollToBottom();
  }
  private handleThinkingChunk(genseq: number, chunk: string, timestamp: string): void {
    const thinkingSection = this.thinkingSection;
    if (!thinkingSection) {
      // Gracefully handle orphan chunk - auto-create thinking section if needed
      if (
        !this.generationBubble ||
        this.generationBubble.getAttribute('data-seq') !== String(genseq)
      ) {
        console.warn(
          'thinking_chunk_evt received without generation bubble, creating minimal state',
        );
        this.handleGeneratingStart(genseq, timestamp);
      }
      console.warn('thinking_chunk_evt received without thinking section, auto-creating');
      this.handleThinkingStart(genseq, timestamp);
    }
    const section = this.thinkingSection!;
    const contentEl = section.querySelector('.thinking-content') as HTMLElement;
    if (contentEl) {
      contentEl.textContent += chunk;
      this.scrollToBottom();
    }
  }
  private handleThinkingFinish(_genseq: number): void {
    const thinkingSection = this.thinkingSection;
    if (!thinkingSection) {
      // Gracefully handle orphan finish - no active thinking section to complete
      console.warn('thinking_finish_evt received without active thinking section, skipping');
      return;
    }
    thinkingSection.classList.add('completed');
    this.thinkingSection = undefined;
  }

  // === MARKDOWN EVENTS (Inside Generation Bubble) ===
  private handleMarkdownStart(genseq: number, timestamp: string): void {
    const bubble = this.ensureGenerationBubbleForSeq(genseq, timestamp);
    if (!bubble) {
      console.warn('markdown_start_evt received without generation bubble, skipping');
      return;
    }
    // Create and append markdown section directly
    const markdownSection = this.createMarkdownSection();
    const body = bubble.querySelector('.bubble-body');
    (body || bubble).appendChild(markdownSection);
    this.markdownSection = markdownSection;
    this.scrollToBottom();
  }
  private handleMarkdownChunk(genseq: number, chunk: string, timestamp: string): void {
    if (!this.markdownSection) {
      // Attempt to recover by creating a markdown section (and bubble if needed).
      this.handleMarkdownStart(genseq, timestamp);
    }
    if (!this.markdownSection) {
      console.warn('markdown_chunk_evt received without markdown section, skipping');
      return;
    }

    // Use the component's public API for incremental rendering
    this.markdownSection.appendChunk(chunk);
    this.scrollToBottom();
  }
  private handleMarkdownFinish(_genseq: number): void {
    if (!this.markdownSection) {
      // Gracefully handle orphan finish - no active markdown section to complete
      console.warn('markdown_finish_evt received without active markdown section, skipping');
      return;
    }
    // Complete the markdown section
    this.markdownSection.classList.add('completed');
    this.markdownSection = undefined;
  }

  // === FUNCTION CALL EVENTS (Non-streaming mode) ===
  private handleFuncCallRequested(funcId: string, funcName: string, argumentsStr: string): void {
    // Guard: ensure generation bubble exists before appending
    if (!this.generationBubble) {
      console.warn('func_call_requested_evt received without generation bubble, skipping');
      return;
    }
    // Create and append func-call section with all data at once (non-streaming mode)
    const funcCallSection = this.createFuncCallSection(funcId, funcName, argumentsStr);
    if (typeof this.activeGenSeq === 'number') {
      funcCallSection.setAttribute('data-genseq', String(this.activeGenSeq));
    }
    const body = this.generationBubble.querySelector('.bubble-body');
    (body || this.generationBubble).appendChild(funcCallSection);
    this.scrollToBottom();
  }

  // === TEXTING CALL EVENTS (Streaming mode - @tool_name calls) ===
  // Renamed from handleCall* to handleToolCall* for clarity
  // callId is now set at finish event (not start) - content-hash based
  private findInFlightToolCallingSectionForGenseq(genseq: number): HTMLElement | undefined {
    const sr = this.shadowRoot;
    if (!sr) return undefined;
    const selector = `.calling-section:not(.teammate-call)[data-genseq="${String(genseq)}"]`;
    const nodes = sr.querySelectorAll(selector);
    if (nodes.length < 1) return undefined;

    // Prefer an in-flight (not .completed) section; fall back to the latest completed section.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes.item(i);
      if (n instanceof HTMLElement && !n.classList.contains('completed')) {
        return n;
      }
    }
    const last = nodes.item(nodes.length - 1);
    return last instanceof HTMLElement ? last : undefined;
  }

  private getActiveToolCallingSection(genseq: number): HTMLElement | undefined {
    const current = this.callingSection;
    if (current && !current.classList.contains('teammate-call')) {
      const seqAttr = current.getAttribute('data-genseq');
      if (seqAttr === String(genseq)) {
        return current;
      }
    }
    const recovered = this.findInFlightToolCallingSectionForGenseq(genseq);
    if (recovered) {
      this.callingSection = recovered;
      return recovered;
    }
    const cached = this.toolCallingSectionBySeq.get(genseq);
    if (cached && cached.isConnected) {
      this.callingSection = cached;
      return cached;
    }
    return undefined;
  }

  private handleToolCallStart(
    event: Extract<TypedDialogEvent, { type: 'tool_call_start_evt' }>,
  ): void {
    const firstMention = event.firstMention;
    const genseq = event.genseq;

    const bubble = this.ensureGenerationBubbleForSeq(genseq, event.timestamp);
    if (!bubble) {
      console.warn('[ToolCallStart] No generation bubble, skipping');
      return;
    }
    const body = bubble.querySelector('.bubble-body');

    const callingSection = this.createCallingSection(firstMention);
    callingSection.setAttribute('data-genseq', String(genseq));
    // NOTE: callId is NO LONGER set here - it's set at tool_call_finish_evt
    // This is because callId is now a content-hash computed from the complete call
    (body || bubble).appendChild(callingSection);
    this.callingSection = callingSection;
    this.toolCallingSectionBySeq.set(genseq, callingSection);

    this.scrollToBottom();
  }

  private handleToolCallHeadlineChunk(genseq: number, chunk: string): void {
    const callingSection = this.getActiveToolCallingSection(genseq);
    if (!callingSection) {
      this.handleProtocolError(
        `tool_call_headline_chunk_evt received without calling section ${JSON.stringify({
          genseq,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const headlineEl = callingSection.querySelector('.calling-headline') as HTMLElement;
    if (headlineEl) headlineEl.textContent += chunk;
    this.scrollToBottom();
  }

  private handleToolCallHeadlineFinish(genseq: number): void {
    const callingSection = this.getActiveToolCallingSection(genseq);
    if (!callingSection) {
      this.handleProtocolError(
        `tool_call_headline_finish_evt received without calling section ${JSON.stringify({
          genseq,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const headlineEl = callingSection.querySelector('.calling-headline') as HTMLElement;
    if (headlineEl) headlineEl.classList.add('completed');
  }

  private handleToolCallBodyStart(genseq: number, _infoLine?: string): void {
    const callingSection = this.getActiveToolCallingSection(genseq);
    if (!callingSection) {
      // This can happen when the UI intentionally clears DOM during navigation/round transitions,
      // or when replay/streaming events arrive late. Treat as a tolerated orphan event.
      console.warn('tool_call_body_start_evt received without calling section', {
        genseq,
        round: this.currentRound,
      });
      return;
    }
    // Body section is already created in DOM structure
    this.scrollToBottom();
  }

  private handleToolCallBodyChunk(genseq: number, chunk: string): void {
    const callingSection = this.getActiveToolCallingSection(genseq);
    if (!callingSection) {
      console.warn('tool_call_body_chunk_evt received without calling section', {
        genseq,
        round: this.currentRound,
      });
      return;
    }
    const bodyEl = callingSection.querySelector('.calling-body') as HTMLElement;
    if (bodyEl) bodyEl.textContent += chunk;
    this.scrollToBottom();
  }

  private handleToolCallBodyFinish(genseq: number, _endQuote?: string): void {
    const callingSection = this.getActiveToolCallingSection(genseq);
    if (!callingSection) {
      console.warn('tool_call_body_finish_evt received without calling section', {
        genseq,
        round: this.currentRound,
      });
      return;
    }
    const bodyEl = callingSection.querySelector('.calling-body') as HTMLElement;
    if (bodyEl) bodyEl.classList.add('completed');
  }

  private handleToolCallFinish(event: ToolCallFinishEvent): void {
    const currentSection = this.getActiveToolCallingSection(event.genseq);
    if (!currentSection) {
      this.handleProtocolError(
        `tool_call_finish_evt received without calling section ${JSON.stringify({
          genseq: event.genseq,
          round: this.currentRound,
          callId: event.callId,
        })}`,
      );
      return;
    }
    const callId = String(event.callId || '').trim();
    if (!callId) {
      this.handleProtocolError(
        `tool_call_finish_evt missing callId ${JSON.stringify({ genseq: event.genseq })}`,
      );
      return;
    }
    currentSection.setAttribute('data-call-id', callId);
    this.callingSectionByCallId.set(callId, currentSection);
    currentSection.classList.add('completed');
    this.callingSection = undefined;
    this.toolCallingSectionBySeq.set(event.genseq, currentSection);

    const pending = this.pendingToolCallResponsesByCallId.get(callId);
    if (pending) {
      const display = this.formatToolCallResultForSection(currentSection, pending);
      if (typeof display === 'string') {
        this.pendingToolCallResponsesByCallId.delete(callId);
        this.attachResultInline(currentSection, display, pending.status);
      }
    }
  }

  // === TEAMMATE CALL EVENTS (Streaming mode - @agentName and @human calls) ===
  // Q4H (Quest for Human) support: @human uses calleeDialogId="human" (no subdialog)
  private handleTeammateCallStart(
    event: Extract<TypedDialogEvent, { type: 'teammate_call_start_evt' }>,
  ): void {
    const firstMention = event.firstMention;
    const calleeDialogId = event.calleeDialogId;
    const isHuman = calleeDialogId === 'human';

    const bubble = this.ensureGenerationBubbleForSeq(event.genseq, event.timestamp);
    if (!bubble) {
      console.warn('[TeammateCallStart] No generation bubble, skipping');
      return;
    }
    const body = bubble.querySelector('.bubble-body');

    // Create teammate calling section with Q4H awareness
    const callingSection = this.createTeammateCallingSection(firstMention, isHuman);
    callingSection.setAttribute('data-call-site-id', String(event.genseq));
    (body || bubble).appendChild(callingSection);
    this.callingSection = callingSection;

    this.scrollToBottom();
  }

  private findInFlightTeammateCallingSectionForCallSiteId(
    callSiteId: number,
  ): HTMLElement | undefined {
    const sr = this.shadowRoot;
    if (!sr) return undefined;
    const selector = `.calling-section.teammate-call[data-call-site-id="${String(callSiteId)}"]:not(.completed)`;
    const nodes = sr.querySelectorAll(selector);
    if (nodes.length < 1) return undefined;
    const last = nodes.item(nodes.length - 1);
    return last instanceof HTMLElement ? last : undefined;
  }

  private getActiveTeammateCallingSection(callSiteId: number): HTMLElement | undefined {
    const current = this.callingSection;
    if (current && current.classList.contains('teammate-call')) {
      const idAttr = current.getAttribute('data-call-site-id');
      if (idAttr === String(callSiteId)) {
        return current;
      }
    }
    const recovered = this.findInFlightTeammateCallingSectionForCallSiteId(callSiteId);
    if (recovered) {
      this.callingSection = recovered;
      return recovered;
    }
    return undefined;
  }

  private handleTeammateCallHeadlineChunk(callSiteId: number, chunk: string): void {
    const callingSection = this.getActiveTeammateCallingSection(callSiteId);
    if (!callingSection) {
      this.handleProtocolError(
        `teammate_call_headline_chunk_evt received without calling section ${JSON.stringify({
          callSiteId,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const headlineEl = callingSection.querySelector('.calling-headline') as HTMLElement;
    if (headlineEl) headlineEl.textContent += chunk;
    this.scrollToBottom();
  }

  private handleTeammateCallHeadlineFinish(callSiteId: number): void {
    const callingSection = this.getActiveTeammateCallingSection(callSiteId);
    if (!callingSection) {
      this.handleProtocolError(
        `teammate_call_headline_finish_evt received without calling section ${JSON.stringify({
          callSiteId,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const headlineEl = callingSection.querySelector('.calling-headline') as HTMLElement;
    if (headlineEl) headlineEl.classList.add('completed');
  }

  private handleTeammateCallBodyStart(callSiteId: number, _infoLine?: string): void {
    const callingSection = this.getActiveTeammateCallingSection(callSiteId);
    if (!callingSection) {
      this.handleProtocolError(
        `teammate_call_body_start_evt received without calling section ${JSON.stringify({
          callSiteId,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    this.scrollToBottom();
  }

  private handleTeammateCallBodyChunk(callSiteId: number, chunk: string): void {
    const callingSection = this.getActiveTeammateCallingSection(callSiteId);
    if (!callingSection) {
      this.handleProtocolError(
        `teammate_call_body_chunk_evt received without calling section ${JSON.stringify({
          callSiteId,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const bodyEl = callingSection.querySelector('.calling-body') as HTMLElement;
    if (bodyEl) bodyEl.textContent += chunk;
    this.scrollToBottom();
  }

  private handleTeammateCallBodyFinish(callSiteId: number, _endQuote?: string): void {
    const callingSection = this.getActiveTeammateCallingSection(callSiteId);
    if (!callingSection) {
      this.handleProtocolError(
        `teammate_call_body_finish_evt received without calling section ${JSON.stringify({
          callSiteId,
          round: this.currentRound,
        })}`,
      );
      return;
    }
    const bodyEl = callingSection.querySelector('.calling-body') as HTMLElement;
    if (bodyEl) bodyEl.classList.add('completed');
  }

  private handleTeammateCallFinish(): void {
    const currentSection = this.callingSection;
    if (!currentSection) {
      const error = 'teammate_call_finish_evt received without active calling section';
      this.handleProtocolError(error);
      return;
    }
    currentSection.classList.remove('teammate-call-pending');
    currentSection.classList.add('completed');
    // The callId is not available at this point - it will be set when the response arrives
    // and the "Jump to response" link will be made visible at that time
    this.callingSection = undefined;
  }

  // Create teammate calling section with Q4H awareness
  private createTeammateCallingSection(firstMention: string, isHuman: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'calling-section teammate-call teammate-call-pending';
    el.setAttribute('data-first-mention', firstMention);
    el.setAttribute('data-is-human', String(isHuman));

    if (isHuman) {
      // Q4H: Show headline content from backend
      el.innerHTML = `
        <div class="calling-header">
          <span class="calling-icon teammate-icon">
            <img src="${walkieTalkieIcon}" class="calling-img" alt="calling">
          </span>
          <span class="calling-headline"></span>
        </div>
        <div class="calling-content">
          <div class="calling-body"></div>
          <div class="calling-result" style="display:none"></div>
        </div>
        <a href="#" class="call-site-link" data-call-id="" style="display:none">Jump to response</a>
      `;
    } else {
      // @agentName: Show headline content from backend with arrow icon (→) for subdialog navigation
      el.innerHTML = `
        <div class="calling-header">
          <span class="calling-icon teammate-icon">
            <img src="${walkieTalkieIcon}" class="calling-img" alt="calling">
          </span>
          <span class="calling-headline"></span>
          <span class="subdialog-arrow">→</span>
        </div>
        <div class="calling-content">
          <div class="calling-body"></div>
          <div class="calling-result" style="display:none"></div>
        </div>
        <a href="#" class="call-site-link" data-call-id="" style="display:none">Jump to response</a>
      `;
    }
    return el;
  }

  // === CODE BLOCK EVENTS (Inside Markdown Section) ===
  private handleCodeBlockStart(infoLine?: string): void {
    // Guard: ensure generation bubble exists before appending
    if (!this.generationBubble) {
      console.warn('codeblock_start_evt received without generation bubble, skipping');
      return;
    }
    if (this.codeblockSection) {
      const error = 'codeblock_start_evt received while codeblock section is already active';
      this.handleProtocolError(error);
      return;
    }
    // Create and append codeblock section directly
    const codeBlockSection = this.createCodeBlockSection(infoLine);
    const body = this.generationBubble.querySelector('.bubble-body');
    (body || this.generationBubble).appendChild(codeBlockSection);
    this.codeblockSection = codeBlockSection;
    this.scrollToBottom();
  }
  private handleCodeBlockChunk(chunk: string): void {
    const codeBlockSection = this.codeblockSection;
    if (!codeBlockSection) {
      const error = 'codeblock_chunk_evt received without active codeblock section';
      this.handleProtocolError(error);
      return;
    }

    // Always use the 'appendChunk' API
    codeBlockSection.appendChunk(chunk || '');
    this.scrollToBottom();
  }
  private handleCodeBlockFinish(endQuote?: string): void {
    const codeBlockSection = this.codeblockSection;
    if (!codeBlockSection) {
      const error = 'codeblock_finish_evt received without active codeblock section';
      this.handleProtocolError(error);
      return;
    }

    const finalText = codeBlockSection.code || '';

    if (!finalText.trim()) {
      console.warn('UI: Codeblock final text empty, removing section');
      codeBlockSection.remove();
    } else {
      codeBlockSection.classList.add('completed');
    }
    this.codeblockSection = undefined;
  }

  // === FUNCTION RESULTS ===
  private handleFuncResult(event: Extract<TypedDialogEvent, { type: 'func_result_evt' }>): void {
    // Try to find the func-call section this result belongs to by funcId
    if (event.id) {
      const funcCallSection = this.generationBubble?.querySelector(
        `.func-call-section[data-func-id="${event.id}"]`,
      ) as HTMLElement | null;

      if (funcCallSection) {
        // Found the func-call section - show result inside it
        const resultEl = funcCallSection.querySelector('.func-call-result') as HTMLElement | null;
        if (resultEl) {
          resultEl.textContent = event.content;
          resultEl.classList.add('completed');
          resultEl.style.display = 'block';
        }
        this.scrollToBottom();
        return;
      }
    }

    // Fallback: If no matching func-call section found, create a separate message
    // This handles historical results or subdialog results
    const content = `**Function Result: ${event.name}**\n\n${event.content}`;
    const messageEl = this.createMessageElement(content, 'tool', event.timestamp);
    const container = this.shadowRoot?.querySelector('.messages');
    if (container) {
      container.appendChild(messageEl);
      this.scrollToBottom();
    }
  }

  // === TEXTING TOOL RESPONSE HANDLER ===
  // Handles responses for @tool_name calls - displays result INLINE in same bubble
  // Renamed from handleTextingResponse to handleToolCallResponse
  //
  // Call Type Distinction:
  // - Texting Tool Call: !!@tool_name (e.g., !!@add_reminder, !!@list_files)
  //   - Result displays INLINE in same bubble via attachResultInline()
  //   - Uses callId for correlation (callingSectionByCallId map)
  //   - Uses this handler (handleToolCallResponse)
  //
  // - Teammate Call: !!@agentName (e.g., !!@coder, !!@tester)
  //   - Result displays in SEPARATE bubble (subdialog response)
  //   - Uses calleeDialogId for correlation
  //   - Uses handleTeammateResponse() instead
  //
  // - Supdialog Call: subdialog responding to @parentAgentId from within
  //   - Result displays INLINE in parent's bubble
  //   - Uses callId for correlation
  //   - Uses this handler (handleToolCallResponse)
  private handleToolCallResponse(event: ToolCallResponseEvent): void {
    // Ignore late tool responses for a different round than the one currently displayed.
    // This can happen when a tool (e.g., @clear_mind) triggers a round transition
    // and the UI clears the previous round before the response event arrives.
    if (typeof this.currentRound === 'number' && event.round !== this.currentRound) {
      return;
    }

    const callId = String(event.callId || '').trim();
    if (!callId) {
      this.handleProtocolError(
        `tool_call_response_evt missing callId ${JSON.stringify({
          responderId: event.responderId,
          headLine: event.headLine,
          calling_genseq: event.calling_genseq,
        })}`,
      );
      return;
    }

    const callingSection = this.callingSectionByCallId.get(callId);
    if (!callingSection) {
      // Normal race: tool result can arrive before tool_call_finish_evt registers the callId.
      // Buffer and attach when the calling section is finalized.
      this.pendingToolCallResponsesByCallId.set(callId, event);
      return;
    }

    const display = this.formatToolCallResultForSection(callingSection, event);
    if (typeof display !== 'string') {
      // Delay rendering until bubble language becomes known (end_of_user_saying_evt),
      // otherwise we may incorrectly localize tool-call errors based on current UI language.
      this.pendingToolCallResponsesByCallId.set(callId, event);
      return;
    }
    this.attachResultInline(callingSection, display, event.status);
    this.pendingToolCallResponsesByCallId.delete(callId);
    if (event.status === 'failed') {
      const host = (this.getRootNode() as ShadowRoot)?.host as HTMLElement | null;
      host?.dispatchEvent(
        new CustomEvent('ui-toast', {
          detail: { message: String(display || 'Tool call failed'), kind: 'error' },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private resolveBubbleLanguageForSection(section: HTMLElement): LanguageCode | null {
    const bubble = section.closest('.generation-bubble');
    if (bubble instanceof HTMLElement) {
      const raw = bubble.getAttribute('data-user-language-code');
      if (typeof raw === 'string') {
        const parsed = normalizeLanguageCode(raw);
        if (parsed) return parsed;
      }
    }

    return null;
  }

  private formatToolCallResultForSection(
    section: HTMLElement,
    event: ToolCallResponseEvent,
  ): string | undefined {
    const rawResult = String(event.result || '');
    if (event.status !== 'failed') return rawResult;

    const parsed = parseToolCallError(rawResult);
    if (!parsed) return rawResult;

    const bubbleLanguage = this.resolveBubbleLanguageForSection(section);
    if (!bubbleLanguage) {
      // Don't guess based on current UI language: tool-call errors must match the language of
      // the originating user prompt (per-bubble data-user-language-code). Defer until known.
      return undefined;
    }

    return formatToolCallErrorInline({
      language: bubbleLanguage,
      responderId: String(event.responderId || ''),
      headLine: String(event.headLine || ''),
      parsed,
    });
  }

  // Attach result inline to calling section (TEXTING TOOL CALLS only)
  private attachResultInline(
    section: HTMLElement,
    result: string,
    status: 'completed' | 'failed',
  ): void {
    section.classList.toggle('failed', status === 'failed');
    const resultEl = section.querySelector('.calling-result') as HTMLElement | null;
    if (resultEl) {
      resultEl.textContent = String(result || '');
      resultEl.classList.toggle('failed', status === 'failed');
      resultEl.style.display = 'block';
    }
    this.scrollToBottom();
  }

  // === TEAMMATE RESPONSE HANDLER ===
  // Handles responses for @agentName calls - displays result in SEPARATE bubble
  // Now includes full response and agentId from subdialog completion
  //
  // Call Type Distinction:
  // - Texting Tool Call: !!@tool_name (e.g., !!@add_reminder)
  //   - Result displays INLINE in same bubble
  //   - Uses callId for correlation
  //   - Uses handleToolCallResponse() instead
  //
  // - Teammate Call: !!@agentName (e.g., !!@coder, !!@tester)
  //   - Result displays in SEPARATE bubble (subdialog or supdialog response)
  //   - Uses calleeDialogId for correlation (event.calleeDialogId)
  //   - Uses this handler (handleTeammateResponse)
  //
  // - Parent Call: subdialog responding to @parentAgentId from within
  //   - Result displays INLINE in parent's bubble
  //   - Uses callId for correlation
  //   - Uses handleToolCallResponse() instead
  private handleTeammateResponse(event: TeammateResponseEvent): void {
    // Validate calleeDialogId is present
    if (!event.calleeDialogId) {
      console.error('handleTeammateResponse: Missing calleeDialogId', {
        responderId: event.responderId,
        result: event.result?.substring(0, 100),
      });
      return;
    }

    // Create separate bubble for teammate response
    // The calleeDialogId (event.calleeDialogId) can refer to either:
    // - A subdialog (for @agentName calls from parent)
    // - A supdialog (for @parentAgentId calls from subdialog)

    // Determine agentId for the bubble (use event.agentId if available, otherwise responderId)
    const agentId = event.agentId || event.responderId;
    const requesterId = event.originMemberId;
    if (!requesterId || requesterId.trim() === '') {
      throw new Error('handleTeammateResponse: Missing originMemberId (requesterId)');
    }
    if (typeof event.result !== 'string') {
      throw new Error('handleTeammateResponse: Missing result payload');
    }

    // In prod, trust the backend to send the fully-formatted narrative. In dev, verify that
    // `event.result` matches the canonical formatting from structured fields.
    if (import.meta.env.DEV) {
      const expectedResult = formatTeammateResponseContent({
        responderId: event.responderId,
        requesterId,
        originalCallHeadLine: event.headLine,
        responseBody: event.response,
        language: this.serverWorkLanguage,
      });
      if (event.result !== expectedResult) {
        throw new Error(
          `handleTeammateResponse: Response formatting mismatch. Expected "${expectedResult}" but received "${event.result}".`,
        );
      }
    }
    const responseNarr = event.result;

    // If callId is provided, find the calling section and set its data-call-id attribute
    // and show the "Jump to response" link
    if (event.callId) {
      // Find the calling section by looking for the one without data-call-id set yet
      // Since we don't have a direct map, we'll search for it
      const callingSections = this.shadowRoot?.querySelectorAll('.calling-section.teammate-call');
      if (callingSections) {
        for (const section of Array.from(callingSections)) {
          if (!section.hasAttribute('data-call-id')) {
            section.setAttribute('data-call-id', event.callId);
            // Show the "Jump to response" link
            const jumpLink = section.querySelector('.call-site-link') as HTMLAnchorElement | null;
            if (jumpLink) {
              jumpLink.style.display = 'inline';
              jumpLink.setAttribute('data-call-id', event.callId);
              // Add click handler for navigation to response
              jumpLink.addEventListener('click', (e) => {
                e.preventDefault();
                const responseBubble = this.shadowRoot?.querySelector(
                  `.message.teammate[data-call-id="${event.callId}"]`,
                ) as HTMLElement | null;
                if (responseBubble) {
                  responseBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  responseBubble.classList.add('highlighted');
                  setTimeout(() => responseBubble.classList.remove('highlighted'), 2000);
                }
              });
            }
            break;
          }
        }
      }
    }

    // Create teammate bubble with the response
    const messageEl = this.createTeammateBubble(
      event.calleeDialogId,
      agentId,
      responseNarr,
      event.calling_genseq,
      event.callId,
      event.originMemberId,
    );

    const container = this.shadowRoot?.querySelector('.messages');
    if (container) {
      container.appendChild(messageEl);
      this.scrollToBottom();
    }
  }

  // === SUBDIALOG EVENTS ===
  private handleSubdialogCreated(event: TypedDialogEvent): void {
    // Validate this is actually a subdialog_created_evt before casting
    if (event.type !== 'subdialog_created_evt') {
      console.warn('handleSubdialogCreated: Ignoring non-subdialog event', event.type);
      return;
    }

    const subdialogEvent = event as SubdialogEvent;
    const { subDialog } = subdialogEvent;

    // Validate subDialog exists
    if (!subDialog?.selfId) {
      console.error('handleSubdialogCreated: Missing subDialog or selfId', subdialogEvent);
      return;
    }

    const calleeDialogId = subDialog.selfId;

    // Dispatch event for dialog list to update callee dialog count
    const host = (this.getRootNode() as ShadowRoot)?.host as HTMLElement | null;
    host?.dispatchEvent(
      new CustomEvent('subdialog-created', {
        detail: {
          rootId: subDialog.rootId,
          calleeDialogId: calleeDialogId,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // Create teammate bubble for subagent responses
  // calleeDialogId: ID of the callee dialog (subdialog OR supdialog)
  private createTeammateBubble(
    calleeDialogId: string,
    agentId: string | undefined,
    responseNarr: string,
    callSiteId?: number,
    callId?: string,
    originMemberId?: string,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'message teammate';
    el.setAttribute('data-callee-dialog-id', calleeDialogId);
    if (typeof callSiteId === 'number') {
      el.setAttribute('data-call-site-id', String(callSiteId));
    }
    if (callId) {
      el.setAttribute('data-call-id', callId);
    }
    const callsign = agentId ? `@${agentId}` : 'Teammate';
    const responseIndicator = this.getTeammateResponseIndicator(agentId, originMemberId);
    el.innerHTML = `
      <div class="bubble-content">
        <div class="bubble-header">
          <div class="bubble-title">
            <div class="title-row">
              <span class="author-name">${callsign}</span><span class="response-indicator">${responseIndicator}</span>
            </div>
          </div>
          ${
            callId
              ? `<a href="#" class="response-call-site-link" data-call-id="${callId}">Call site ↗</a>`
              : ''
          }
        </div>
        <div class="bubble-body">
          <div class="teammate-content"></div>
        </div>
      </div>
    `;
    const contentEl = el.querySelector('.teammate-content');
    if (contentEl) {
      const md = this.createMarkdownSection();
      md.setRawMarkdown(responseNarr);
      contentEl.appendChild(md);
    }
    // Add click handler for call site link
    const responseCallSiteLink = el.querySelector(
      '.response-call-site-link',
    ) as HTMLAnchorElement | null;
    if (responseCallSiteLink && callId) {
      responseCallSiteLink.addEventListener('click', (e) => {
        e.preventDefault();
        const callingSection = this.shadowRoot?.querySelector(
          `.calling-section.teammate-call[data-call-id="${callId}"]`,
        ) as HTMLElement | null;
        if (callingSection) {
          callingSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
          callingSection.classList.add('highlighted');
          setTimeout(() => callingSection.classList.remove('highlighted'), 2000);
        }
      });
    }
    return el;
  }

  // === REMINDER EVENTS ===
  private handleFullRemindersUpdate(event: FullRemindersEvent): void {
    // Dispatch custom event for reminders widget to listen to
    const host = (this.getRootNode() as ShadowRoot)?.host as HTMLElement | null;
    host?.dispatchEvent(
      new CustomEvent('reminders-update', {
        detail: { reminders: event.reminders },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private formatAgentLabel(agentId: string): string {
    if (agentId === 'human' || agentId === '@human') {
      return 'Human';
    }
    return agentId.startsWith('@') ? agentId : `@${agentId}`;
  }

  private formatCallerLabel(assignment: AssignmentFromSup): string {
    const originMemberId = assignment.originMemberId;
    if (originMemberId && originMemberId.trim() !== '') {
      if (originMemberId === 'human') {
        return 'Human';
      }
      return this.formatAgentLabel(originMemberId);
    }
    return 'Assistant';
  }

  private getTeammateResponseIndicator(responderId?: string, originMemberId?: string): string {
    const dialog = this.currentDialog;
    if (!dialog || !dialog.agentId || !responderId) {
      return 'Response';
    }
    let caller = this.formatAgentLabel(dialog.agentId);
    if (originMemberId === 'human') {
      caller = 'Human';
    } else if (originMemberId && originMemberId.trim() !== '') {
      caller = this.formatAgentLabel(originMemberId);
    }
    return `Response → ${caller}`;
  }

  private buildGenerationBubbleHeaderHtml(timestamp: string): string {
    const authorLabel = this.getAuthorLabel('assistant');
    return `
      <div class="bubble-header">
        <div class="bubble-title">
          <div class="bubble-author">${authorLabel}</div>
        </div>
        <div class="timestamp">${timestamp}</div>
      </div>
    `;
  }

  // === DOM HELPERS ===

  // Create unified generation bubble
  private createGenerationBubble(timestamp: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'generation-bubble';
    el.setAttribute('data-testid', 'message-bubble');
    el.setAttribute('data-finalized', 'false');
    el.innerHTML = `
      <div class="bubble-content">
        ${this.buildGenerationBubbleHeaderHtml(timestamp)}
        <div class="bubble-body">
          <!-- User message parsed events and AI content will be inserted here -->
        </div>
      </div>
    `;
    return el;
  }

  // Render <hr/> separator between user content and AI response
  // Called when end_of_user_saying_evt is received
  private handleEndOfUserSaying(event: EndOfUserSayingEvent): void {
    let bubble = this.generationBubble;
    if (bubble && bubble.getAttribute('data-seq') !== String(event.genseq)) {
      bubble = undefined;
    }
    if (!bubble) {
      const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | undefined;
      bubble = container
        ? (container.querySelector(`.generation-bubble[data-seq="${event.genseq}"]`) as
            | HTMLElement
            | undefined)
        : undefined;
    }
    if (!bubble) {
      console.warn('handleEndOfUserSaying called but no generation bubble exists');
      return;
    }

    const body = bubble.querySelector('.bubble-body');
    if (!body) {
      console.warn('handleEndOfUserSaying: no bubble-body found');
      return;
    }

    // Add divider to separate user content from AI response
    const divider = document.createElement('hr');
    divider.className = 'user-response-divider';
    body.appendChild(divider);
    bubble.setAttribute('data-user-msg-id', event.msgId);
    bubble.setAttribute('data-raw-user-msg', event.content);
    if (typeof event.userLanguageCode === 'string' && event.userLanguageCode.trim() !== '') {
      bubble.setAttribute('data-user-language-code', event.userLanguageCode);
    } else {
      bubble.removeAttribute('data-user-language-code');
    }

    // If any tool-call responses were deferred due to missing bubble language, try attaching now.
    this.flushPendingToolCallResponsesForBubble(bubble);
    this.scrollToBottom();
  }

  private flushPendingToolCallResponsesForBubble(bubble: HTMLElement): void {
    const sections = bubble.querySelectorAll('.calling-section[data-call-id]');
    if (sections.length < 1) return;

    for (const section of Array.from(sections)) {
      if (!(section instanceof HTMLElement)) continue;
      const callId = String(section.getAttribute('data-call-id') || '').trim();
      if (!callId) continue;

      const pending = this.pendingToolCallResponsesByCallId.get(callId);
      if (!pending) continue;

      const display = this.formatToolCallResultForSection(section, pending);
      if (typeof display !== 'string') continue;

      this.pendingToolCallResponsesByCallId.delete(callId);
      this.attachResultInline(section, display, pending.status);
    }
  }

  // Create thinking section (inside generation bubble)
  private createThinkingSection(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'thinking-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon">🧠</span>
        <span class="section-title">Thinking</span>
      </div>
      <div class="thinking-content"></div>
    `;
    return el;
  }

  // Create markdown section (inside generation bubble)
  private createMarkdownSection(): DomindsMarkdownSection {
    return new DomindsMarkdownSection();
  }

  // Create calling section (inside markdown section) - streaming mode for texting calls
  private createCallingSection(firstMention: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'calling-section';
    el.setAttribute('data-first-mention', firstMention);
    el.innerHTML = `
      <div class="calling-header">
        <span class="calling-icon tool-icon">
          <img src="${mannedToolIcon}" class="calling-img" alt="calling">
        </span>
        <span class="calling-headline"></span>
      </div>
      <div class="calling-content">
        <div class="calling-body"></div>
        <div class="calling-result" style="display:none"></div>
      </div>
    `;
    return el;
  }

  // Create func-call section (inside markdown section) - non-streaming mode
  private createFuncCallSection(
    funcId: string,
    funcName: string,
    argumentsStr: string,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'func-call-section';
    el.setAttribute('data-func-id', funcId);
    el.setAttribute('data-func-name', funcName);
    // Parse arguments for display
    let argsDisplay = argumentsStr;
    try {
      const parsed = JSON.parse(argumentsStr);
      argsDisplay = JSON.stringify(parsed, null, 2);
    } catch {
      // Not JSON, use as-is
    }
    el.innerHTML = `
      <div class="func-call-header">
        <span class="func-call-icon">⚡</span>
        <span class="func-call-title">Function: ${funcName}</span>
      </div>
      <div class="func-call-content">
        <pre class="func-call-arguments">${argsDisplay}</pre>
        <div class="func-call-result" style="display:none"></div>
      </div>
    `;
    return el;
  }

  private createCodeBlockSection(infoLine?: string): DomindsCodeBlock {
    const lang = this.extractLanguage(infoLine);
    const el = new DomindsCodeBlock();
    if (lang) {
      el.setAttribute('language', lang);
    }
    return el;
  }

  private handleError(err: string): void {
    if (!this.generationBubble) return;
    const el = document.createElement('div');
    el.className = 'error-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon">⚠️</span>
        <span class="section-title">Stream Error</span>
      </div>
      <div class="error-content">${err}</div>
    `;
    const body = this.generationBubble.querySelector('.bubble-body');
    (body || this.generationBubble).appendChild(el);
    this.scrollToBottom();
  }

  private handleProtocolError(err: unknown): void {
    const container = this.shadowRoot?.querySelector('.messages');
    if (!container) return;

    // Extract error details - try to parse JSON from error message
    let errorMessage = 'Unknown protocol error';
    let errorDetails: Record<string, unknown> | undefined;

    try {
      const errStr = String(err);
      const m = errStr.match(/\{.*\}$/);
      if (m) {
        try {
          errorDetails = JSON.parse(m[0]);
          errorMessage = errStr.replace(m[0], '').trim() || 'Protocol error with details';
        } catch (parseErr) {
          // JSON parse failed, use original error
          errorMessage = errStr;
        }
      } else {
        errorMessage = errStr;
      }
    } catch (stringifyErr) {
      errorMessage = String(err);
    }

    console.error('🚨 Protocol Error', errorMessage, errorDetails);
    const el = document.createElement('div');
    el.className = 'error-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon">🚨</span>
        <span class="section-title">Protocol Error</span>
      </div>
      <div class="error-content">${errorMessage}</div>
    `;
    container.appendChild(el);
    this.scrollToBottom();
  }

  private extractLanguage(infoLine?: string): string {
    if (!infoLine) return '';
    // Remove triple backticks and extract language
    const cleanInfo = infoLine.replace(/^```+/, '').trim();
    return cleanInfo || 'text';
  }

  // Create message element for non-generation messages (tool results, etc.)
  private createMessageElement(
    content: string,
    role: string,
    timestamp: string,
    msgId?: string,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = `message ${role}`;
    el.setAttribute('data-testid', 'message-bubble');
    if (role === 'user') {
      if (!msgId) {
        throw new Error('msgId is required for user messages');
      }
      el.setAttribute('data-user-msg-id', msgId);
    } else if (msgId) {
      // For non-user messages, still allow but don't require
      el.setAttribute('data-user-msg-id', msgId);
    }
    el.innerHTML = `
      <div class="content-area">
        <div class="bubble-header">
          <div class="author">${this.getAuthorLabel(role)}</div>
          <div class="timestamp">${timestamp}</div>
        </div>
        <div class="content"></div>
        <div class="status"></div>
      </div>
    `;
    const md = this.createMarkdownSection();
    md.setRawMarkdown(content);
    const contentHost = el.querySelector('.content');
    if (contentHost) {
      contentHost.appendChild(md);
    }
    return el;
  }

  private setBubbleTimestamp(bubble: HTMLElement, timestamp: string): void {
    const timestampEl = bubble.querySelector('.timestamp') as HTMLElement | null;
    if (!timestampEl) return;
    timestampEl.textContent = timestamp;
  }

  // === PUBLIC API FOR USER MESSAGE ===
  // User messages are now handled by 'end_of_user_saying_evt' event - see handleDialogEvent()

  private getAuthorLabel(role: string, responderId?: string): string {
    if (role === 'user') return 'Human';

    const id = responderId || this.currentDialog?.agentId || '';
    if (!id) return '🤖 Assistant';

    // Use team configuration if available
    if (this.teamConfiguration?.members?.[id]) {
      const member = this.teamConfiguration.members[id];
      const icon = member.icon || this.teamConfiguration.memberDefaults?.icon || '🤖';
      const name = member.name || `@${id}`;
      return `${icon} ${name}`;
    }

    // Fallback to member defaults if specific member not found
    if (this.teamConfiguration?.memberDefaults) {
      const icon = this.teamConfiguration.memberDefaults.icon || '🤖';
      return `${icon} @${id}`;
    }

    // Ultimate fallback
    return `🤖 @${id}`;
  }
  // addMessageToDOM was removed - use direct container.appendChild() instead

  private render(): void {
    if (!this.shadowRoot) return;

    const t = getUiStrings(this.uiLanguage);
    this.shadowRoot!.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="container">
        <div class="messages"></div>
        <div id="resume-panel" class="resume-panel hidden">
          <div class="resume-text">
            <div class="resume-title">${t.continueLabel}</div>
            <div id="resume-reason" class="resume-reason"></div>
          </div>
          <div class="resume-actions">
            <button id="resume-btn" class="resume-btn" type="button">${t.continueLabel}</button>
          </div>
        </div>
      </div>
    `;

    const btn = this.shadowRoot.querySelector('#resume-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.onclick = () => {
        const dialog = this.currentDialog;
        if (!dialog) return;
        this.wsManager.sendRaw({ type: 'resume_dialog', dialog });
      };
    }
    this.updateResumePanel();
  }

  private updateResumePanel(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const panel = root.querySelector('#resume-panel') as HTMLElement | null;
    const reasonEl = root.querySelector('#resume-reason') as HTMLElement | null;
    const btn = root.querySelector('#resume-btn') as HTMLButtonElement | null;
    const titleEl = root.querySelector('.resume-title') as HTMLElement | null;
    if (!panel || !reasonEl || !btn) return;

    const t = getUiStrings(this.uiLanguage);
    if (titleEl) titleEl.textContent = t.continueLabel;
    btn.textContent = t.continueLabel;

    const state = this.runState;
    const canShow = !!this.currentDialog && state !== null && state.kind === 'interrupted';
    panel.classList.toggle('hidden', !canShow);

    if (!canShow) {
      reasonEl.textContent = '';
      btn.disabled = true;
      return;
    }

    btn.disabled = false;

    const reason = state.reason;
    switch (reason.kind) {
      case 'user_stop':
        reasonEl.textContent = t.stoppedByYou;
        break;
      case 'emergency_stop':
        reasonEl.textContent = t.stoppedByEmergencyStop;
        break;
      case 'server_restart':
        reasonEl.textContent = t.interruptedByServerRestart;
        break;
      case 'system_stop':
        reasonEl.textContent = reason.detail;
        break;
      default: {
        const _exhaustive: never = reason;
        reasonEl.textContent = String(_exhaustive);
      }
    }
  }

  private formatInterruptionReason(reason: DialogInterruptionReason): string {
    const t = getUiStrings(this.uiLanguage);
    switch (reason.kind) {
      case 'user_stop':
        return t.stoppedByYou;
      case 'emergency_stop':
        return t.stoppedByEmergencyStop;
      case 'server_restart':
        return t.interruptedByServerRestart;
      case 'system_stop':
        return reason.detail;
      default: {
        const _exhaustive: never = reason;
        return String(_exhaustive);
      }
    }
  }

  private appendRunStateMarker(marker: { kind: 'interrupted' | 'resumed'; reason?: string }): void {
    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (!messages) return;

    const el = document.createElement('div');
    el.className = 'message system run-marker';
    const t = getUiStrings(this.uiLanguage);
    const label = marker.kind === 'resumed' ? t.runMarkerResumed : t.runMarkerInterrupted;
    const reason = marker.reason ? ` • ${marker.reason}` : '';
    el.innerHTML = `<div class="content"><div class="system-marker">${label}${reason}</div></div>`;
    messages.appendChild(el);
  }

  private getStyles(): string {
    return `
      :host { display: block; height: 100%; }
      .container { height: 100%; background: var(--dominds-bg, var(--color-bg-primary, #ffffff)); }
      .messages { box-sizing: border-box; padding: 16px; }

      .resume-panel {
        margin: 0 16px 16px 16px;
        padding: 12px 12px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        border-radius: 10px;
        background: var(--dominds-bg, var(--color-bg-secondary, #ffffff));
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .resume-panel.hidden {
        display: none;
      }

      .resume-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--dominds-fg, var(--color-fg-primary, #0f172a));
      }

      .resume-reason {
        font-size: 12px;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        margin-top: 2px;
      }

      .resume-btn {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        background: var(--dominds-primary, var(--color-accent-primary, #007acc));
        color: white;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
      }

      .resume-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .run-marker {
        padding: 10px 12px;
      }

      .system-marker {
        font-size: 12px;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
      }
      
      /* Message styles for tool results and other content */
      .message {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
        padding: 12px;
        background: var(--dominds-bg, var(--color-bg-secondary, white));
        border-radius: 8px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        transition: all 0.2s ease;
      }
      .message.thinking { border-left: 4px solid var(--dominds-primary, var(--color-accent-primary, #007acc)); }
      .message.assistant { border-left: 4px solid var(--dominds-success, var(--color-success, #10b981)); }
      .message.tool { border-left: 4px solid var(--dominds-warning, var(--color-warning, #f59e0b)); }
      .message.calling { border-left: 4px solid var(--dominds-info, var(--color-info, #06b6d4)); }
      .message.system { border-left: 4px solid var(--dominds-primary, var(--color-accent-primary, #007acc)); background: var(--color-bg-tertiary, #f1f5f9); }
      .message.subdialog { border-left: 4px solid var(--dominds-primary, var(--color-accent-primary, #007acc)); background: var(--color-bg-tertiary, #f1f5f9); }
      
      /* New generation bubble styles */
      .generation-bubble { 
        display: flex; 
        gap: 12px; 
        margin-bottom: 16px; 
        padding: 16px; 
        background: var(--dominds-bg, var(--color-bg-secondary, white)); 
        border-radius: 12px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        box-shadow: var(--shadow-sm);
        transition: all 0.2s ease;
      }
      
      .bubble-content { flex: 1; min-width: 0; }
      
      .bubble-header { 
        display: flex; 
        align-items: baseline; 
        justify-content: space-between; 
        margin-bottom: 12px; 
      }
      
      .bubble-author { 
        font-weight: 600; 
        color: var(--dominds-fg, var(--color-fg-primary, #333)); 
      }

      .bubble-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .title-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }

      .call-context {
        font-size: 11px;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
      }
      
      .bubble-header { 
        font-size: 12px; 
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); 
        margin-left: 8px;
      }
      
      .generation-bubble.completed {
        color: var(--dominds-success, var(--color-success, #10b981));
        font-weight: 500;
      }

      /* Breathing glow animation for generation bubble */
      .generation-bubble.generating {
        animation: breath-glow 3s ease-in-out infinite;
        border: 2px solid transparent;
      }

      @keyframes breath-glow {
        0%, 100% {
          box-shadow: 0 0 5px color-mix(in srgb, var(--dominds-primary, #007acc) 30%, transparent);
          border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 20%, transparent);
        }
        50% {
          box-shadow: 0 0 20px color-mix(in srgb, var(--dominds-primary, #007acc) 60%, transparent), 0 0 40px color-mix(in srgb, var(--dominds-primary, #007acc) 25%, transparent);
          border-color: color-mix(in srgb, var(--dominds-primary, #007acc) 50%, transparent);
        }
      }

      .bubble-body {
        display: flex;
        flex-direction: column !important;
        gap: 12px;
        line-height: 1.5;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        width: 100%;
        max-width: 100%;
        overflow: hidden;
      }

      /* User message and divider styles */
      .user-message {
        font-family: inherit;
        font-weight: 500;
        font-size: 14px;
        line-height: 1.4;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        margin: 0;
        padding: 0;
        width: 100%;
        height: auto;
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        overflow: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        display: block;
      }

      .user-response-divider {
        border: none;
        border-top: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        margin: 8px 0;
      }
      
      
      /* Section styles (thinking, markdown) */
  .thinking-section, .markdown-section {
        margin-bottom: 0; /* bubble-body gap provides spacing */
        padding: 12px; 
        border-radius: 8px; 
        background: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9)); 
        border-left: 3px solid var(--dominds-primary, var(--color-accent-primary, #007acc)); 
        display: block;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        overflow: hidden;
      }
      
      .markdown-section {
        border-left-color: transparent;
        background: transparent;
      }

      .markdown-content {
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
        word-wrap: break-word;
        line-height: 1.5;
      }

      .markdown-content p {
        margin-top: 0;
        margin-bottom: 0.75em;
      }

      .markdown-content p:last-child {
        margin-bottom: 0;
      }

      .markdown-content ul, .markdown-content ol {
        margin-top: 0;
        margin-bottom: 0.75em;
        padding-left: 1.5em;
      }

      .markdown-content li {
        margin-bottom: 0.25em;
      }

      .markdown-content h1, .markdown-content h2, .markdown-content h3, 
      .markdown-content h4, .markdown-content h5, .markdown-content h6 {
        margin-top: 1.25em;
        margin-bottom: 0.5em;
        font-weight: 600;
        line-height: 1.25;
        color: var(--dominds-fg-primary, var(--color-fg-primary, #1e293b));
      }

      .markdown-content h1:first-child, .markdown-content h2:first-child, .markdown-content h3:first-child {
        margin-top: 0;
      }

      .markdown-content blockquote {
        margin: 0 0 0.75em 0;
        padding: 0 1em;
        color: var(--dominds-fg-muted, var(--color-fg-muted, #64748b));
        border-left: 0.25em solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
      }

      .markdown-content code:not([class]) {
        background-color: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
        padding: 0.2em 0.4em;
        border-radius: 4px;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        font-size: 85%;
      }

      .markdown-content table {
        border-collapse: collapse;
        width: 100%;
        margin-bottom: 0.75em;
      }

      .markdown-content th, .markdown-content td {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        padding: 6px 13px;
      }

      .markdown-content tr:nth-child(2n) {
        background-color: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
      }

      .section-header { 
        display: flex; 
        align-items: center; 
        gap: 8px; 
        margin-bottom: 8px; 
      }
      
      .section-icon { 
        font-size: 16px; 
      }
      
      .section-title { 
        font-weight: 600; 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        font-size: 14px; 
      }
      
      .thinking-content, .markdown-text-block { 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        white-space: pre-wrap; 
        word-wrap: break-word;
        margin-bottom: 8px;
      }
      
      .markdown-text-block:last-child {
        margin-bottom: 0;
      }
      
      .thinking-section.completed, .markdown-section.completed {
        opacity: 0.8;
      }
      
      /* Calling section styles (nested inside markdown) */
      .calling-section { 
        margin: 6px 0; 
        padding: 8px; 
        border-radius: 6px; 
        background: var(--color-bg-tertiary, #f1f5f9); 
        border-left: 3px solid var(--color-info, #06b6d4);
      }
      
      .calling-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .calling-icon {
        display: flex;
        align-items: center;
      }

      .calling-img {
        width: 26px;
        height: 26px;
        color: var(--color-info, #06b6d4);
      }

      .calling-icon.tool-icon .calling-img {
        width: 28px;
        height: 28px;
        color: var(--color-info, #06b6d4);
      }

      .calling-icon.teammate-icon .calling-img {
        width: 24px;
        height: 24px;
        color: var(--dominds-primary, #007acc);
      }

      .calling-headline {
        font-weight: 600;
        color: var(--color-info, #06b6d4);
        font-size: 12px;
      }

      .subdialog-arrow {
        color: var(--color-info, #06b6d4);
        font-size: 12px;
        font-weight: 500;
      }

      .calling-content {
        margin-left: 18px;
        max-height: 120px;
        overflow: auto;
      }

      .calling-body {
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        white-space: pre-wrap;
        font-size: 12px;
        line-height: 1.35;
      }

      .calling-result {
        margin-top: 8px;
        padding: 8px;
        border-radius: 6px;
        font-size: 12px;
        white-space: pre-wrap;
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
      }

      .calling-result.failed {
        border-color: var(--color-danger, #ef4444);
        color: var(--color-danger, #ef4444);
      }

      .calling-section.failed {
        border-left-color: var(--color-danger, #ef4444);
        background: rgba(239, 68, 68, 0.08);
      }
      
      .calling-section.completed {
        opacity: 0.9;
      }
      
      .calling-headline.completed {
        opacity: 0.8;
      }
      
      .calling-body.completed {
        opacity: 0.8;
      }

      /* Function call section styles (nested inside markdown) - non-streaming mode */
      .func-call-section {
        margin: 6px 0;
        padding: 8px;
        border-radius: 6px;
        background: var(--color-bg-tertiary, #f1f5f9);
        border-left: 3px solid var(--color-warning, #f59e0b);
      }

      .func-call-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .func-call-icon {
        font-size: 14px;
      }

      .func-call-title {
        font-weight: 600;
        color: var(--color-warning, #f59e0b);
        font-size: 12px;
      }

      .func-call-content {
        margin-left: 18px;
      }

      .func-call-arguments {
        margin: 0;
        padding: 8px;
        border-radius: 4px;
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        font-size: 11px;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        overflow-x: auto;
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
      }

      .func-call-result {
        margin-top: 8px;
        padding: 8px;
        border-radius: 6px;
        font-size: 12px;
        white-space: pre-wrap;
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
      }

      .func-call-result.failed {
        border-color: var(--color-danger, #ef4444);
        color: var(--color-danger, #ef4444);
      }

      .func-call-section.failed {
        border-left-color: var(--color-danger, #ef4444);
        background: rgba(239, 68, 68, 0.08);
      }

      .func-call-section.completed {
        opacity: 0.9;
      }

      /* Code block section styles (nested inside markdown) */
      .codeblock-section { 
        margin: 0; 
        border-radius: 6px; 
        overflow: hidden;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        background: var(--color-bg-secondary, #f8fafc);
      }
      
      .codeblock-header { 
        display: flex; 
        align-items: center; 
        justify-content: space-between;
        padding: 8px 12px; 
        background: var(--color-bg-tertiary, #f1f5f9); 
        border-bottom: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
      }
      
      .codeblock-icon { 
        font-size: 14px; 
      }
      
      .codeblock-title { 
        font-weight: 500; 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        font-size: 13px; 
      }
      
      .codeblock-actions {
        display: flex;
        gap: 4px;
      }
      
      .codeblock-action {
        background: none;
        border: none;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        transition: all 0.2s ease;
      }
      
      .codeblock-action:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }
      
      .codeblock-wrapper { background: transparent; }
      .codeblock-wrapper pre { margin: 0; background: var(--color-bg-primary, #ffffff); }
      .codeblock-wrapper pre > code.codeblock-content {
        display: block;
        padding: 12px;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: 12px;
        line-height: 1.4;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        white-space: pre;
        overflow-x: auto;
        tab-size: 2;
        background: transparent;
      }

      .codeblock-section.completed {
        opacity: 0.9;
      }
      
      /* Content area styles */
      .content-area { flex: 1; min-width: 0; }
      .content-area .bubble-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
      .content-area .author { font-weight: 600; color: var(--dominds-fg, var(--color-fg-primary, #333)); }
      .content-area .timestamp { font-size: 12px; color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); }
      .content { 
        line-height: 1.5; 
        color: var(--dominds-fg, var(--color-fg-primary, #333)); 
        white-space: pre-wrap; 
        word-wrap: break-word;
      }
      .status { font-size: 12px; color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); margin-top: 4px; font-style: italic; }
      .timestamp { 
        font-size: 12px; 
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); 
        margin-top: 4px; 
      }
      /* Removed welcome placeholder to avoid initial blank height issues */
      
      /* Responsive design */
      @media (max-width: 768px) {
        .messages { padding: 12px; }
        .message { margin-bottom: 12px; padding: 10px; }
        .generation-bubble { margin-bottom: 12px; padding: 12px; }
        .avatar { width: 28px; height: 28px; }
        .bubble-avatar { width: 32px; height: 32px; }
        .author, .content, .status, .timestamp { font-size: 14px; }
        .section-title { font-size: 13px; }
        .calling-headline, .calling-body { font-size: 12px; }
      }

      /* Teammate bubble styles */
      .message.teammate {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
        padding: 16px;
        background: var(--color-bg-secondary, #f7fafc);
        border-radius: 12px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        border-left: 4px solid var(--dominds-primary, #007acc);
      }

      .author-name {
        font-weight: 600;
        color: var(--dominds-primary, #007acc);
      }

      .response-indicator {
        font-size: 0.75em;
        color: var(--dominds-text-secondary, #64748b);
        margin-left: 0.5em;
      }

      .teammate-call-pending {
        animation: pending-glow 2s ease-in-out infinite;
        border-left-color: var(--dominds-primary, #007acc);
      }

      @keyframes pending-glow {
        0%, 100% { box-shadow: 0 0 5px color-mix(in srgb, var(--dominds-primary, #007acc) 30%, transparent); }
        50% { box-shadow: 0 0 15px color-mix(in srgb, var(--dominds-primary, #007acc) 50%, transparent); }
      }

      .call-site-link {
        color: var(--dominds-primary, #007acc);
        text-decoration: none;
        font-size: 12px;
        margin-left: auto;
      }

      .call-site-link:hover {
        text-decoration: underline;
      }

      .response-call-site-link {
        color: var(--dominds-primary, #007acc);
        text-decoration: none;
        font-size: 12px;
        margin-left: 8px;
        cursor: pointer;
      }

      .response-call-site-link:hover {
        text-decoration: underline;
      }

      .teammate-content {
        margin-top: 12px;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        line-height: 1.6;
      }

      .teammate-headline {
        margin: 0 0 8px 0;
        padding-left: 12px;
        border-left: 3px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-text-secondary, #475569);
        font-size: 0.95em;
      }

      .teammate-response-divider {
        border: 0;
        border-top: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        margin: 8px 0 10px 0;
      }

      /* Highlight animation for call site navigation */
      .calling-section.highlighted {
        animation: highlight-pulse 1s ease-in-out;
      }

      .message.teammate.highlighted {
        animation: highlight-pulse 1s ease-in-out;
      }

      @keyframes highlight-pulse {
        0%, 100% {
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--dominds-primary, #007acc) 40%, transparent);
        }
        50% {
          box-shadow: 0 0 0 8px transparent;
        }
      }

    `;
  }

  private scrollToBottom(): void {
    // Scroll the parent element (.conversation-scroll-area) which has overflow-y: auto
    const scrollContainer = this.parentElement as HTMLElement;
    if (!scrollContainer) return;

    const doScroll = () => {
      const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      scrollContainer.scrollTop = maxScroll;
    };

    doScroll();
    requestAnimationFrame(doScroll);
    requestAnimationFrame(() => {
      doScroll();
      if (this.generationBubble) {
        requestAnimationFrame(doScroll);
      }
    });
  }
}

// Register element
if (!customElements.get('dominds-dialog-container')) {
  customElements.define('dominds-dialog-container', DomindsDialogContainer);
}
