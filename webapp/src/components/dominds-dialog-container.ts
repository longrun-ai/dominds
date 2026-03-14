/**
 * Simple Dialog Container - Direct DOM Updates Based on Wire Protocol Packets
 */

import mannedToolIcon from '../assets/manned-tool.svg';
import { getUiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import { getWebSocketManager } from '../services/websocket.js';
import type {
  EndOfUserSayingEvent,
  FullRemindersEvent,
  FuncCallStartEvent,
  SubdialogEvent,
  TypedDialogEvent,
  WebSearchCallEvent,
} from '../shared/types/dialog';
import type { DialogDisplayState, DialogInterruptionReason } from '../shared/types/display-state';
import type { LanguageCode } from '../shared/types/language';
import { normalizeLanguageCode } from '../shared/types/language';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCalleeCourseNumber,
  toCallerCourseNumber,
  type AssignmentCourseNumber,
  type AssignmentGenerationSeqNumber,
  type CalleeCourseNumber,
  type CallerCourseNumber,
  type CallingGenerationSeqNumber,
} from '../shared/types/storage';
import type { AssignmentFromSup, DialogIdent, DialogStatusKind } from '../shared/types/wire';
import { renderDomindsMarkdown } from './dominds-markdown-render';
import { DomindsMarkdownSection } from './dominds-markdown-section';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

type DialogContext = DialogIdent & {
  status?: DialogStatusKind;
  agentId?: string;
  supdialogId?: string;
  sessionSlug?: string;
  assignmentFromSup?: AssignmentFromSup;
};

type PendingScrollRequest =
  | { kind: 'by_call_id'; course: number; callId: string }
  | { kind: 'by_message_index'; course: number; messageIndex: number }
  | { kind: 'by_genseq'; course: number; genseq: number };

type TellaskCallAnchorMeta = {
  callId: string;
  anchorRole: 'assignment' | 'response';
  assignmentCourse?: AssignmentCourseNumber;
  assignmentGenseq?: AssignmentGenerationSeqNumber;
  callerDialogId?: string;
  callerCourse?: CallerCourseNumber;
};

type TellaskAssignmentTarget = {
  course: AssignmentCourseNumber;
  genseq: AssignmentGenerationSeqNumber;
};

type TellaskCallSiteTarget = {
  selfId?: string;
  course?: CallerCourseNumber | CalleeCourseNumber;
};

type ScrollToCallIdDetail = {
  course: number;
  callId: string;
};

type ScrollToGenseqDetail = {
  course: number;
  genseq: number;
};

type ScrollToCallSiteDetail =
  | {
      course: number;
      callId: string;
      messageIndex?: undefined;
    }
  | {
      course: number;
      messageIndex: number;
      callId?: undefined;
    };
type AutoScrollMode = 'following' | 'paused';
type AutoScrollKeyboardIntent = 'none' | 'toward_latest';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePositiveIntField(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function readScrollToCallIdDetail(value: unknown): ScrollToCallIdDetail | null {
  if (!isObjectRecord(value)) return null;
  const course = parsePositiveIntField(value['course']);
  const callId = typeof value['callId'] === 'string' ? value['callId'].trim() : '';
  if (course === null || callId === '') return null;
  return { course, callId };
}

function readScrollToGenseqDetail(value: unknown): ScrollToGenseqDetail | null {
  if (!isObjectRecord(value)) return null;
  const course = parsePositiveIntField(value['course']);
  const genseq = parsePositiveIntField(value['genseq']);
  if (course === null || genseq === null) return null;
  return { course, genseq };
}

function readScrollToCallSiteDetail(value: unknown): ScrollToCallSiteDetail | null {
  if (!isObjectRecord(value)) return null;
  const course = parsePositiveIntField(value['course']);
  if (course === null) return null;
  const callId = typeof value['callId'] === 'string' ? value['callId'].trim() : '';
  if (callId !== '') {
    return { course, callId };
  }
  const messageIndex = parsePositiveIntField(value['messageIndex']);
  if (messageIndex === null) return null;
  return { course, messageIndex };
}

const CALLING_CONTENT_INITIAL_MAX_HEIGHT_PX = 120;
const CALLING_EXPAND_STEP_VIEWPORT_RATIO = 1 / 3;
const AUTO_SCROLL_FOLLOW_THRESHOLD_PX = 32;
const AUTO_SCROLL_WHEEL_RESISTANCE_PX = 56;
const AUTO_SCROLL_WHEEL_DECAY_MS = 520;
const AUTO_SCROLL_WHEEL_MAX_RESISTANCE = 1.8;
const AUTO_SCROLL_WHEEL_IDLE_EPSILON = 0.03;

type LlmRetryEvent = Extract<TypedDialogEvent, { type: 'llm_retry_evt' }>;

type RetryPanelState =
  | { kind: 'hidden' }
  | {
      kind: 'retry-waiting';
      genseq: number;
      attempt: number;
      totalAttempts: number;
      provider: string;
      failureLabel: string;
      error: string;
      nextRetryAtMs: number;
    }
  | {
      kind: 'retry-running';
      genseq: number;
      attempt: number;
      totalAttempts: number;
      provider: string;
      failureLabel: string;
      error: string;
    };

export type DialogViewportRetryPanelState = RetryPanelState;

export class DomindsDialogContainer extends HTMLElement {
  private wsManager = getWebSocketManager();
  private currentDialog?: DialogContext;
  private uiLanguage: LanguageCode = 'en';
  private serverWorkLanguage: LanguageCode = 'en';
  private displayState: DialogDisplayState | null = null;
  // Track previous dialog to handle race conditions during navigation
  // Events may arrive for the "old" dialog briefly after navigation
  private previousDialog?: DialogContext;

  // During dialog/course navigation, we intentionally clear the DOM. Late streaming events can still
  // arrive during that window; suppress them to avoid protocol errors from missing sections.
  private suppressEvents = false;

  public setServerWorkLanguage(language: LanguageCode): void {
    this.serverWorkLanguage = language;
  }

  // State tracking
  private currentCourse?: number;
  private activeGenSeq?: number;

  // DOM references
  private generationBubble?: HTMLElement;
  private thinkingSection?: HTMLElement;
  private markdownSection?: DomindsMarkdownSection;
  private callingSection?: HTMLElement;

  // Smart auto-scroll state machine.
  // UX contract:
  // - Programmatic layout changes must never disable follow. Retry/resume panels and streaming
  //   growth can change viewport geometry while the user still expects follow to stay on.
  // - "Move away from latest" disables follow; "move toward latest" does not.
  // - Reverse wheel/trackpad input is intentionally NOT judged by current viewport position.
  //   We previously mixed "where the viewport ended up" with "did the user mean to cancel
  //   follow", which created a race against ongoing follow-to-bottom scrolls and made canceling
  //   follow unreliable. Wheel now uses resistance only; explicit pointer dragging still uses
  //   position delta because that input is high-confidence.
  private autoScrollMode: AutoScrollMode = 'following';
  private autoScrollPinnedToBottom = true;
  private autoScrollLastRemainingPx = 0;
  private scrollContainer: HTMLElement | null = null;
  private boundOnScrollContainerScroll: (() => void) | null = null;
  private boundOnScrollContainerWheel: ((event: WheelEvent) => void) | null = null;
  private boundOnScrollContainerPointerDown: (() => void) | null = null;
  private boundOnWindowPointerUp: (() => void) | null = null;
  private boundOnWindowKeyDown: ((event: KeyboardEvent) => void) | null = null;
  private autoScrollResizeObserver: ResizeObserver | null = null;
  private autoScrollResizeScrollRaf: number | null = null;
  private autoScrollResizeObservedEl: HTMLElement | null = null;
  private autoScrollRealignRaf: number | null = null;
  private autoScrollWheelResistance = 0;
  private autoScrollWheelLastDecayAtMs = 0;
  private autoScrollWheelLastUpEventAtMs = 0;
  private autoScrollPointerActive = false;
  private autoScrollKeyboardIntent: AutoScrollKeyboardIntent = 'none';
  private autoScrollKeyboardIntentRaf: number | null = null;

  // Best-effort cache to recover teammate-call streaming sections by genseq.
  // Chunk events don't carry callId, so this is scoped to per-genseq recovery only.
  private tellaskCallingSectionBySeq = new Map<number, HTMLElement>();

  // Track calling sections by callId for direct lookup (teammate-call blocks only)
  private callingSectionByCallId = new Map<string, HTMLElement>();
  private pendingCallTimingById = new Map<string, { section: HTMLElement; startedAtMs: number }>();
  private callTimingTicker: number | null = null;
  private webSearchSectionByItemId = new Map<string, HTMLElement>();
  private webSearchSectionBySeq = new Map<number, HTMLElement>();
  private queuedUserBubbleByMsgId = new Map<string, HTMLElement>();
  private pendingTellaskCallAnchorByGenseq = new Map<number, TellaskCallAnchorMeta>();
  private progressiveExpandObserverByTarget = new WeakMap<HTMLElement, ResizeObserver>();
  private retryPanelState: RetryPanelState = { kind: 'hidden' };

  // Call-site navigation can be requested before course replay content is rendered.
  // Store the intent and apply when the DOM is ready.
  private pendingScrollRequest: PendingScrollRequest | null = null;

  private highlightSeq: number = 0;
  private pendingHighlight: { selector: string; token: string; expiresAtMs: number } | null = null;

  private applyHighlight(target: HTMLElement): void {
    // Restart animation even if the element was highlighted recently.
    target.classList.remove('highlighted');
    void target.offsetWidth;
    target.classList.add('highlighted');

    const token = String((this.highlightSeq += 1));
    target.setAttribute('data-highlight-token', token);
    setTimeout(() => {
      if (target.getAttribute('data-highlight-token') !== token) return;
      target.classList.remove('highlighted');
    }, 5200);
  }

  private applyHighlightWithToken(target: HTMLElement, token: string, expiresAtMs: number): void {
    // Only apply if this node isn't already tagged with our token.
    if (target.getAttribute('data-highlight-token') === token) return;
    target.classList.remove('highlighted');
    void target.offsetWidth;
    target.setAttribute('data-highlight-token', token);
    target.classList.add('highlighted');

    const remaining = Math.max(0, expiresAtMs - Date.now());
    setTimeout(() => {
      if (target.getAttribute('data-highlight-token') !== token) return;
      target.classList.remove('highlighted');
    }, remaining);
  }

  private maybeReapplyPendingHighlight(): void {
    const pending = this.pendingHighlight;
    if (!pending) return;
    if (Date.now() >= pending.expiresAtMs) {
      this.pendingHighlight = null;
      return;
    }
    const root = this.shadowRoot;
    if (!root) return;
    const messages = root.querySelector('.messages');
    if (!(messages instanceof HTMLElement)) return;
    const target = messages.querySelector(pending.selector);
    if (!(target instanceof HTMLElement)) return;
    this.applyHighlightWithToken(target, pending.token, pending.expiresAtMs);
  }

  private applyHighlightWhenVisible(target: HTMLElement): void {
    if (document.visibilityState !== 'visible') {
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisible);
        // Give the browser a beat to paint after tab activation.
        setTimeout(() => {
          if (!target.isConnected) return;
          this.applyHighlightWhenVisible(target);
        }, 120);
      };
      document.addEventListener('visibilitychange', onVisible);
      return;
    }

    // On fresh page loads (external deeplinks), we often scroll to a far-away element.
    // If we start the animation immediately, it may finish before the element is in view.
    // Use IntersectionObserver (rooted at the scroll container) to trigger the highlight
    // once the target becomes visible.
    const root = this.scrollContainer;
    if (!root) {
      requestAnimationFrame(() => this.applyHighlight(target));
      return;
    }

    let didApply = false;
    const applyOnce = () => {
      if (didApply) return;
      didApply = true;
      this.applyHighlight(target);
    };

    // Fallback: even if the observer doesn't fire (rare), still highlight shortly after.
    setTimeout(() => applyOnce(), 900);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== target) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
            observer.disconnect();
            applyOnce();
            return;
          }
        }
      },
      { root, threshold: [0, 0.3, 0.6, 1] },
    );

    try {
      observer.observe(target);
    } catch {
      // If observing fails (e.g. target is not in the document yet), fall back.
      applyOnce();
    }
  }

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
  }

  async connectedCallback(): Promise<void> {
    const parsed = normalizeLanguageCode(this.getAttribute('ui-language') || '');
    this.uiLanguage = parsed ?? 'en';
    this.render();
    this.ensureScrollContainerListener();
    this.ensureAutoScrollWindowListeners();
    this.installCallSiteScrollListeners();
    await this.loadTeamConfiguration();
    const sr = this.shadowRoot;
    if (sr) {
      sr.addEventListener('click', async (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const assignmentBtn = target.closest(
          '.bubble-anchor-assignment-btn',
        ) as HTMLButtonElement | null;
        if (assignmentBtn) {
          e.preventDefault();
          e.stopPropagation();
          const bubble = assignmentBtn.closest('.generation-bubble') as HTMLElement | null;
          if (!bubble) return;
          const assignmentCourseRaw = Number.parseInt(
            bubble.getAttribute('data-assignment-course') ?? '',
            10,
          );
          const assignmentGenseqRaw = Number.parseInt(
            bubble.getAttribute('data-assignment-genseq') ?? '',
            10,
          );
          if (!Number.isFinite(assignmentCourseRaw) || assignmentCourseRaw <= 0) return;
          if (!Number.isFinite(assignmentGenseqRaw) || assignmentGenseqRaw <= 0) return;
          this.navigateToGenerationBubbleInApp({
            course: toAssignmentCourseNumber(assignmentCourseRaw),
            genseq: toAssignmentGenerationSeqNumber(assignmentGenseqRaw),
          });
          return;
        }
        const requesterCallsiteBtn = target.closest(
          '.bubble-anchor-caller-callsite-btn',
        ) as HTMLButtonElement | null;
        if (requesterCallsiteBtn) {
          e.preventDefault();
          e.stopPropagation();
          const bubble = requesterCallsiteBtn.closest('.generation-bubble') as HTMLElement | null;
          if (!bubble) return;
          const callId = (bubble.getAttribute('data-call-id') ?? '').trim();
          const callerDialogId = (bubble.getAttribute('data-caller-dialog-id') ?? '').trim();
          const callerCourseRaw = Number.parseInt(
            bubble.getAttribute('data-caller-course') ?? '',
            10,
          );
          if (callId === '' || callerDialogId === '') return;
          if (!Number.isFinite(callerCourseRaw) || callerCourseRaw <= 0) return;
          this.openCallSiteDeepLinkInNewTab(callId, {
            selfId: callerDialogId,
            course: toCallerCourseNumber(callerCourseRaw),
          });
          return;
        }
        const userAnswerCallsiteBtn = target.closest(
          '.user-answer-callsite-link-btn',
        ) as HTMLButtonElement | null;
        if (userAnswerCallsiteBtn) {
          e.preventDefault();
          e.stopPropagation();
          const callId = (userAnswerCallsiteBtn.getAttribute('data-call-id') ?? '').trim();
          if (callId === '') return;
          this.navigateToCallSiteInApp(callId);
          return;
        }
        const shareBtn = target.closest('.bubble-share-link-btn') as HTMLButtonElement | null;
        if (shareBtn) {
          e.preventDefault();
          e.stopPropagation();
          const bubble = shareBtn.closest('.generation-bubble') as HTMLElement | null;
          const raw = bubble ? bubble.getAttribute('data-seq') : null;
          const seq = raw ? Number.parseInt(raw, 10) : Number.NaN;
          if (!Number.isFinite(seq)) return;
          await this.copyGenerationBubbleDeepLinkToClipboard(seq);
          return;
        }
        const forkBtn = target.closest('.bubble-fork-btn') as HTMLButtonElement | null;
        if (forkBtn) {
          e.preventDefault();
          e.stopPropagation();
          const bubble = forkBtn.closest('.generation-bubble') as HTMLElement | null;
          const dialog = this.currentDialog;
          if (!bubble || !dialog) return;
          const courseRaw = Number.parseInt(bubble.getAttribute('data-course') ?? '', 10);
          const seqRaw = Number.parseInt(bubble.getAttribute('data-seq') ?? '', 10);
          if (!Number.isFinite(courseRaw) || courseRaw <= 0) return;
          if (!Number.isFinite(seqRaw) || seqRaw <= 0) return;
          this.dispatchEvent(
            new CustomEvent('fork-dialog-request', {
              detail: {
                rootId: dialog.rootId,
                selfId: dialog.selfId,
                status: dialog.status ?? 'running',
                course: Math.floor(courseRaw),
                genseq: Math.floor(seqRaw),
              },
              bubbles: true,
              composed: true,
            }),
          );
          return;
        }
        const btn = target.closest('.codeblock-action') as HTMLButtonElement | null;
        if (btn) {
          const section = btn.closest('.codeblock-section') as HTMLElement | null;
          const contentEl = section?.querySelector('.codeblock-content') as HTMLElement | null;
          const text = contentEl?.textContent || '';
          const doneIconHtml =
            '<span class="icon-mask dc-icon-check-circle" aria-hidden="true"></span>';
          const copyIconHtml = '<span class="icon-mask dc-icon-copy" aria-hidden="true"></span>';
          try {
            await navigator.clipboard.writeText(text);
            const prev = btn.innerHTML || '';
            btn.innerHTML = doneIconHtml;
            setTimeout(() => (btn.innerHTML = prev || copyIconHtml), 1200);
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
              const prev = btn.innerHTML || '';
              btn.innerHTML = doneIconHtml;
              setTimeout(() => (btn.innerHTML = prev || copyIconHtml), 1200);
            } catch (err2) {
              console.warn('Clipboard write failed', err2);
            }
          }
        }
      });
    }
  }

  disconnectedCallback(): void {
    this.detachScrollContainerListener();
    this.detachAutoScrollWindowListeners();
    this.cleanup();
  }

  private installCallSiteScrollListeners(): void {
    this.removeEventListener('scroll-to-call-site', this.onScrollToCallSite as EventListener);
    this.removeEventListener('scroll-to-call-id', this.onScrollToCallId as EventListener);
    this.removeEventListener('scroll-to-genseq', this.onScrollToGenSeq as EventListener);
    this.addEventListener('scroll-to-call-site', this.onScrollToCallSite as EventListener);
    this.addEventListener('scroll-to-call-id', this.onScrollToCallId as EventListener);
    this.addEventListener('scroll-to-genseq', this.onScrollToGenSeq as EventListener);
  }

  private onScrollToCallSite = (event: Event): void => {
    const ce = event as CustomEvent<unknown>;
    const detail = readScrollToCallSiteDetail(ce.detail);
    if (!detail) return;

    if (detail.callId !== undefined) {
      this.pendingScrollRequest = {
        kind: 'by_call_id',
        course: detail.course,
        callId: detail.callId,
      };
      this.maybeApplyPendingScrollRequest();
      return;
    }

    this.pendingScrollRequest = {
      kind: 'by_message_index',
      course: detail.course,
      messageIndex: detail.messageIndex,
    };
    this.maybeApplyPendingScrollRequest();
  };

  private onScrollToCallId = (event: Event): void => {
    const ce = event as CustomEvent<unknown>;
    const detail = readScrollToCallIdDetail(ce.detail);
    if (!detail) return;

    this.pendingScrollRequest = {
      kind: 'by_call_id',
      course: detail.course,
      callId: detail.callId,
    };
    this.maybeApplyPendingScrollRequest();
  };

  private onScrollToGenSeq = (event: Event): void => {
    const ce = event as CustomEvent<unknown>;
    const detail = readScrollToGenseqDetail(ce.detail);
    if (!detail) return;

    this.pendingScrollRequest = { kind: 'by_genseq', course: detail.course, genseq: detail.genseq };
    this.maybeApplyPendingScrollRequest();
  };

  private buildCallIdSelector(callId: string): string {
    const escaped = CSS.escape(callId);
    return `.calling-section[data-call-id="${escaped}"]`;
  }

  private findCallSiteTargetByCallId(messages: HTMLElement, callId: string): HTMLElement | null {
    const selector = this.buildCallIdSelector(callId);
    const matches = Array.from(messages.querySelectorAll<HTMLElement>(selector));
    if (matches.length < 1) return null;
    return matches[matches.length - 1] ?? null;
  }

  private maybeApplyPendingScrollRequest(): void {
    const req = this.pendingScrollRequest;
    if (!req) return;
    const currentCourse = this.currentCourse;
    if (typeof currentCourse === 'number' && req.course !== currentCourse) {
      return;
    }

    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    const messages = root.querySelector('.messages');
    if (!(messages instanceof HTMLElement)) {
      return;
    }

    let target: HTMLElement | null = null;

    if (req.kind === 'by_call_id') {
      target = this.findCallSiteTargetByCallId(messages, req.callId);
    } else if (req.kind === 'by_genseq') {
      const found = messages.querySelector(`.generation-bubble[data-seq="${String(req.genseq)}"]`);
      target = found instanceof HTMLElement ? found : null;
    } else {
      const bySeq = messages.querySelector(
        `.generation-bubble[data-seq="${String(req.messageIndex)}"]`,
      );
      if (bySeq instanceof HTMLElement) {
        const call = bySeq.querySelector('.calling-section');
        target = call instanceof HTMLElement ? call : bySeq;
      } else {
        const bubbles = Array.from(messages.querySelectorAll<HTMLElement>('.generation-bubble'));
        const idx = req.messageIndex;
        const direct = idx >= 0 && idx < bubbles.length ? bubbles[idx] : null;
        const oneBased = idx > 0 && idx - 1 < bubbles.length ? bubbles[idx - 1] : null;
        const bubble = direct ?? oneBased;
        if (bubble) {
          const call = bubble.querySelector('.calling-section');
          target = call instanceof HTMLElement ? call : bubble;
        }
      }
    }

    if (!target) return;

    this.pendingScrollRequest = null;
    // This navigation is explicit (deeplink / internal jump). Disable auto-scroll so we don't
    // immediately snap back to the bottom while the dialog continues streaming/replaying.
    this.resetAutoScrollState(false);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Persist highlight intent for a short period. External deeplinks can trigger DOM replacement
    // after we've already applied the highlight, making it appear as "no flash". Reapply on the
    // first matching node we see until expiry.
    let selector: string | null = null;
    if (req.kind === 'by_call_id') {
      selector = this.buildCallIdSelector(req.callId);
    } else if (req.kind === 'by_genseq') {
      selector = `.generation-bubble[data-seq="${String(req.genseq)}"]`;
    } else {
      // by_message_index: best effort: treat messageIndex as bubble seq (current convention).
      selector = `.generation-bubble[data-seq="${String(req.messageIndex)}"] .calling-section, .generation-bubble[data-seq="${String(
        req.messageIndex,
      )}"]`;
    }
    if (selector) {
      const expiresAtMs = Date.now() + 5200;
      const token = `hl-${String(Date.now())}-${String((this.highlightSeq += 1))}`;
      this.pendingHighlight = { selector, token, expiresAtMs };
      // Apply immediately to the current node too.
      this.applyHighlightWithToken(target, token, expiresAtMs);
    } else {
      this.applyHighlightWhenVisible(target);
    }
    // Ensure we also reapply after the next few DOM mutations.
    this.maybeReapplyPendingHighlight();
  }

  private detachScrollContainerListener(): void {
    const container = this.scrollContainer;
    const scrollListener = this.boundOnScrollContainerScroll;
    if (container && scrollListener) {
      container.removeEventListener('scroll', scrollListener);
    }
    const wheelListener = this.boundOnScrollContainerWheel;
    if (container && wheelListener) {
      container.removeEventListener('wheel', wheelListener);
    }
    const pointerDownListener = this.boundOnScrollContainerPointerDown;
    if (container && pointerDownListener) {
      container.removeEventListener('pointerdown', pointerDownListener);
    }
    this.scrollContainer = null;
    this.boundOnScrollContainerScroll = null;
    this.boundOnScrollContainerWheel = null;
    this.boundOnScrollContainerPointerDown = null;
    this.resetAutoScrollTransientState();
  }

  private ensureAutoScrollWindowListeners(): void {
    if (this.boundOnWindowPointerUp === null) {
      this.boundOnWindowPointerUp = () => {
        this.autoScrollPointerActive = false;
      };
      window.addEventListener('pointerup', this.boundOnWindowPointerUp, { passive: true });
      window.addEventListener('pointercancel', this.boundOnWindowPointerUp, { passive: true });
    }
    if (this.boundOnWindowKeyDown === null) {
      this.boundOnWindowKeyDown = (event: KeyboardEvent) => {
        this.handleAutoScrollKeyDown(event);
      };
      window.addEventListener('keydown', this.boundOnWindowKeyDown, { passive: true });
    }
  }

  private detachAutoScrollWindowListeners(): void {
    if (this.boundOnWindowPointerUp !== null) {
      window.removeEventListener('pointerup', this.boundOnWindowPointerUp);
      window.removeEventListener('pointercancel', this.boundOnWindowPointerUp);
      this.boundOnWindowPointerUp = null;
    }
    if (this.boundOnWindowKeyDown !== null) {
      window.removeEventListener('keydown', this.boundOnWindowKeyDown);
      this.boundOnWindowKeyDown = null;
    }
    this.autoScrollPointerActive = false;
    this.clearAutoScrollKeyboardIntent();
  }

  private ensureScrollContainerListener(): void {
    const container = this.parentElement instanceof HTMLElement ? this.parentElement : null;
    if (!container) return;
    if (this.scrollContainer === container && this.boundOnScrollContainerScroll) return;

    this.detachScrollContainerListener();
    this.scrollContainer = container;
    this.boundOnScrollContainerScroll = () => {
      const current = this.scrollContainer;
      if (!current) return;
      this.refreshAutoScrollStateFromScroll(current);
    };
    this.boundOnScrollContainerWheel = (event: WheelEvent) => {
      this.handleAutoScrollWheel(event);
    };
    this.boundOnScrollContainerPointerDown = () => {
      this.autoScrollPointerActive = true;
    };
    container.addEventListener('scroll', this.boundOnScrollContainerScroll, { passive: true });
    container.addEventListener('wheel', this.boundOnScrollContainerWheel, { passive: true });
    container.addEventListener('pointerdown', this.boundOnScrollContainerPointerDown, {
      passive: true,
    });

    // Initialize based on current scroll position.
    this.refreshAutoScrollStateFromScroll(container);
  }

  private getScrollContainerRemainingPx(container: HTMLElement): number {
    return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
  }

  private isScrollContainerAtBottom(container: HTMLElement): boolean {
    return this.getScrollContainerRemainingPx(container) <= AUTO_SCROLL_FOLLOW_THRESHOLD_PX;
  }

  private isAutoScrollFollowing(): boolean {
    return this.autoScrollMode === 'following';
  }

  private resetAutoScrollWheelResistance(): void {
    this.autoScrollWheelResistance = 0;
    this.autoScrollWheelLastDecayAtMs = 0;
    this.autoScrollWheelLastUpEventAtMs = 0;
  }

  private resetAutoScrollTransientState(): void {
    this.resetAutoScrollWheelResistance();
    this.clearAutoScrollKeyboardIntent();
  }

  private decayAutoScrollWheelResistance(nowMs: number): number {
    if (this.autoScrollWheelLastDecayAtMs === 0) {
      this.autoScrollWheelLastDecayAtMs = nowMs;
      return this.autoScrollWheelResistance;
    }
    const elapsedMs = Math.max(0, nowMs - this.autoScrollWheelLastDecayAtMs);
    if (elapsedMs > 0 && this.autoScrollWheelResistance > 0) {
      this.autoScrollWheelResistance *= Math.exp(-elapsedMs / AUTO_SCROLL_WHEEL_DECAY_MS);
      if (this.autoScrollWheelResistance < AUTO_SCROLL_WHEEL_IDLE_EPSILON / 2) {
        this.autoScrollWheelResistance = 0;
      }
    }
    this.autoScrollWheelLastDecayAtMs = nowMs;
    return this.autoScrollWheelResistance;
  }

  private getAutoScrollWheelResistancePx(nowMs: number): number {
    return this.decayAutoScrollWheelResistance(nowMs) * AUTO_SCROLL_WHEEL_RESISTANCE_PX;
  }

  private clearAutoScrollKeyboardIntent(): void {
    if (this.autoScrollKeyboardIntentRaf !== null) {
      cancelAnimationFrame(this.autoScrollKeyboardIntentRaf);
      this.autoScrollKeyboardIntentRaf = null;
    }
    this.autoScrollKeyboardIntent = 'none';
  }

  private scheduleAutoScrollKeyboardIntentClear(): void {
    if (this.autoScrollKeyboardIntentRaf !== null) return;
    this.autoScrollKeyboardIntentRaf = requestAnimationFrame(() => {
      this.autoScrollKeyboardIntentRaf = null;
      this.autoScrollKeyboardIntent = 'none';
    });
  }

  private pauseAutoScroll(): void {
    this.autoScrollMode = 'paused';
    this.resetAutoScrollWheelResistance();
    this.updateScrollToBottomButton();
  }

  private resumeAutoScroll(): void {
    this.autoScrollMode = 'following';
    this.autoScrollPinnedToBottom = true;
    this.autoScrollLastRemainingPx = 0;
    this.autoScrollPointerActive = false;
    this.clearAutoScrollKeyboardIntent();
    this.resetAutoScrollWheelResistance();
    this.updateScrollToBottomButton();
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tagName = target.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  }

  private isAutoScrollNavigationKey(key: string): boolean {
    return (
      key === 'Home' ||
      key === 'End' ||
      key === 'PageUp' ||
      key === 'PageDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === ' ' ||
      key === 'Spacebar'
    );
  }

  private isTowardLatestNavigationKey(event: KeyboardEvent): boolean {
    if (event.key === 'End' || event.key === 'PageDown' || event.key === 'ArrowDown') {
      return true;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      return event.shiftKey !== true;
    }
    return false;
  }

  private didUserMoveTowardLatest(nextRemainingPx: number): boolean {
    return nextRemainingPx <= this.autoScrollLastRemainingPx + 0.5;
  }

  private tryResumeAutoScrollFromBottom(): boolean {
    const container = this.scrollContainer;
    if (!container) return false;
    if (this.isAutoScrollFollowing()) return false;
    if (!this.isScrollContainerAtBottom(container)) return false;
    this.resumeAutoScroll();
    this.scrollToBottom({ force: true });
    return true;
  }

  private handleAutoScrollKeyDown(event: KeyboardEvent): void {
    if (!this.isAutoScrollNavigationKey(event.key)) return;
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (this.isEditableTarget(event.target)) return;
    if (this.isTowardLatestNavigationKey(event) && this.tryResumeAutoScrollFromBottom()) {
      return;
    }
    if (this.isTowardLatestNavigationKey(event)) {
      this.autoScrollKeyboardIntent = 'toward_latest';
      this.scheduleAutoScrollKeyboardIntentClear();
      return;
    }
    this.pauseAutoScroll();
  }

  private scheduleAutoScrollRealign(): void {
    if (this.autoScrollRealignRaf !== null) return;
    this.autoScrollRealignRaf = requestAnimationFrame(() => {
      this.autoScrollRealignRaf = null;
      if (!this.isAutoScrollFollowing()) return;
      this.scrollToBottom({ force: true });
    });
  }

  private refreshAutoScrollStateFromScroll(container: HTMLElement): void {
    const remainingPx = this.getScrollContainerRemainingPx(container);
    const atBottom = this.isScrollContainerAtBottom(container);
    const movedTowardLatest = this.didUserMoveTowardLatest(remainingPx);
    this.autoScrollPinnedToBottom = atBottom;

    if (this.autoScrollPointerActive) {
      // Pointer-driven scrolling is explicit and high-confidence: use scroll position delta to
      // decide whether the user moved toward latest or away from it.
      if (this.isAutoScrollFollowing()) {
        if (!movedTowardLatest) {
          this.pauseAutoScroll();
        } else if (!atBottom) {
          this.scheduleAutoScrollRealign();
        }
      }
      this.autoScrollLastRemainingPx = remainingPx;
      return;
    }

    if (this.autoScrollKeyboardIntent === 'toward_latest') {
      // Toward-latest keyboard actions (for example PageDown/End) must never disable follow.
      // They either keep follow active or help the user rejoin latest before resuming follow.
      if (this.isAutoScrollFollowing() && !atBottom) {
        this.scheduleAutoScrollRealign();
      }
      this.autoScrollLastRemainingPx = remainingPx;
      this.clearAutoScrollKeyboardIntent();
      return;
    }

    if (this.isAutoScrollFollowing()) {
      if (!atBottom) {
        this.scheduleAutoScrollRealign();
      }
      this.autoScrollLastRemainingPx = 0;
      this.updateScrollToBottomButton();
      return;
    }

    this.autoScrollLastRemainingPx = remainingPx;
    this.updateScrollToBottomButton();
  }

  private resetAutoScrollState(enabled: boolean): void {
    if (enabled) {
      this.resumeAutoScroll();
      return;
    }
    this.autoScrollMode = 'paused';
    this.autoScrollPinnedToBottom = false;
    this.autoScrollLastRemainingPx = AUTO_SCROLL_FOLLOW_THRESHOLD_PX + 1;
    this.autoScrollPointerActive = false;
    this.clearAutoScrollKeyboardIntent();
    this.resetAutoScrollWheelResistance();
    this.updateScrollToBottomButton();
  }

  private handleAutoScrollWheel(event: WheelEvent): void {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    if (event.deltaY > 0 && this.tryResumeAutoScrollFromBottom()) {
      return;
    }
    const nowMs = performance.now();
    const currentResistance = this.decayAutoScrollWheelResistance(nowMs);
    const intensity = Math.min(1.25, Math.abs(event.deltaY) / 90);

    if (event.deltaY < 0) {
      // Reverse wheel/trackpad input uses accumulated resistance instead of instantaneous viewport
      // position. This avoids a race where follow keeps pulling downward while tiny reverse deltas
      // try to move upward; judging by resulting scroll position made "stop follow" too hard.
      const gapMs =
        this.autoScrollWheelLastUpEventAtMs === 0
          ? Number.POSITIVE_INFINITY
          : nowMs - this.autoScrollWheelLastUpEventAtMs;
      const continuityBoost = gapMs < 140 ? 0.38 : gapMs < 260 ? 0.22 : gapMs < 420 ? 0.1 : 0;
      this.autoScrollWheelResistance = Math.min(
        AUTO_SCROLL_WHEEL_MAX_RESISTANCE,
        currentResistance + 0.18 + intensity * 0.32 + continuityBoost,
      );
      this.autoScrollWheelLastUpEventAtMs = nowMs;
      if (
        this.isAutoScrollFollowing() &&
        this.getAutoScrollWheelResistancePx(nowMs) > AUTO_SCROLL_FOLLOW_THRESHOLD_PX
      ) {
        this.pauseAutoScroll();
      }
    } else {
      this.autoScrollWheelResistance = Math.max(0, currentResistance - (0.1 + intensity * 0.2));
    }

    this.autoScrollWheelLastDecayAtMs = nowMs;
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

  public async refreshTeamConfiguration(): Promise<void> {
    await this.loadTeamConfiguration();
  }

  public async setDialog(dialog: DialogContext): Promise<void> {
    this.suppressEvents = true;
    // Dialog navigation is a user-initiated context switch; reset auto-scroll so the freshly
    // loaded dialog can follow streaming output until the user scrolls up.
    this.resetAutoScrollState(true);
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
    this.resetAutoScrollState(true);
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

  public async setCurrentCourse(course: number): Promise<void> {
    if (!this.currentDialog) return;
    this.suppressEvents = true;
    // Course navigation replays content; default to following the newest output unless user scrolls up.
    this.resetAutoScrollState(true);
    this.cleanup();
    this.currentCourse = course;
    this.wsManager.sendRaw({
      type: 'display_course',
      dialog: this.currentDialog,
      course: course,
    });
    this.render();
    this.suppressEvents = false;
  }

  /**
   * Reset the dialog container for an in-place course transition (new course started).
   * This clears all bubbles/sections from the previous course so the UI only shows the new course.
   *
   * Unlike setCurrentCourse(), this does NOT request a course replay from the backend;
   * it relies on live events that follow the course_update event.
   */
  public resetForCourse(course: number): void {
    this.stopAutoScrollObservation();
    this.resetAutoScrollTransientState();
    this.clearRetryPanel();
    // Reset per-course rendering state, but keep currentDialog/previousDialog intact.
    this.generationBubble = undefined;
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.currentCourse = course;
    this.activeGenSeq = undefined;
    this.callingSectionByCallId.clear();
    this.pendingCallTimingById.clear();
    this.stopCallTimingTicker();
    this.webSearchSectionByItemId.clear();
    this.webSearchSectionBySeq.clear();
    this.queuedUserBubbleByMsgId.clear();
    this.pendingTellaskCallAnchorByGenseq.clear();

    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (messages) {
      messages.innerHTML = '';
    }
  }

  // Clean up current state and DOM content
  private cleanup(): void {
    this.stopAutoScrollObservation();
    this.resetAutoScrollTransientState();
    this.clearRetryPanel();
    this.previousDialog = undefined;
    this.displayState = null;
    this.generationBubble = undefined;
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.currentCourse = undefined;
    this.activeGenSeq = undefined;
    this.callingSectionByCallId.clear();
    this.pendingCallTimingById.clear();
    this.stopCallTimingTicker();
    this.webSearchSectionByItemId.clear();
    this.webSearchSectionBySeq.clear();
    this.queuedUserBubbleByMsgId.clear();
    this.pendingTellaskCallAnchorByGenseq.clear();

    // Clear all DOM messages when switching dialogs
    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (messages) {
      messages.innerHTML = '';
    }
  }

  private stopAutoScrollObservation(): void {
    if (this.autoScrollRealignRaf !== null) {
      cancelAnimationFrame(this.autoScrollRealignRaf);
      this.autoScrollRealignRaf = null;
    }
    if (this.autoScrollResizeScrollRaf !== null) {
      cancelAnimationFrame(this.autoScrollResizeScrollRaf);
      this.autoScrollResizeScrollRaf = null;
    }
    this.autoScrollResizeObserver?.disconnect();
    this.autoScrollResizeObserver = null;
    this.autoScrollResizeObservedEl = null;
  }

  private startAutoScrollObservation(el: HTMLElement): void {
    if (this.autoScrollResizeObservedEl === el && this.autoScrollResizeObserver) return;
    this.stopAutoScrollObservation();
    if (typeof ResizeObserver === 'undefined') return;

    this.autoScrollResizeObservedEl = el;
    this.autoScrollResizeObserver = new ResizeObserver(() => {
      if (!this.isAutoScrollFollowing()) return;
      if (this.autoScrollResizeScrollRaf !== null) return;
      this.autoScrollResizeScrollRaf = requestAnimationFrame(() => {
        this.autoScrollResizeScrollRaf = null;
        this.scrollToBottom();
      });
    });
    this.autoScrollResizeObserver.observe(el);
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

    const currentCourse = this.currentCourse;
    if (currentCourse !== undefined) {
      // After a course transition (course_update -> resetForCourse), the backend can still emit
      // late events from the previous course. The UX rule is "one course in the timeline",
      // so we must drop out-of-course events instead of trying to attach them to missing bubbles.
      if ('course' in event && typeof (event as { course?: unknown }).course === 'number') {
        const course = (event as { course: number }).course;
        if (course !== currentCourse) {
          return;
        }
      }
    }

    switch (event.type) {
      case 'dlg_display_state_evt':
        if (
          !this.currentDialog ||
          event.dialog.selfId !== this.currentDialog.selfId ||
          event.dialog.rootId !== this.currentDialog.rootId
        ) {
          break;
        }
        this.displayState = event.displayState;
        if (event.displayState.kind === 'interrupted' || event.displayState.kind === 'dead') {
          this.clearRetryPanel();
        }
        break;

      case 'dlg_display_state_marker_evt': {
        if (
          !this.currentDialog ||
          event.dialog.selfId !== this.currentDialog.selfId ||
          event.dialog.rootId !== this.currentDialog.rootId
        ) {
          break;
        }
        if (event.kind === 'interrupted') {
          this.displayState = {
            kind: 'interrupted',
            reason: event.reason ?? { kind: 'system_stop', detail: 'Interrupted.' },
          };
          this.clearRetryPanel();
        } else if (this.displayState !== null && this.displayState.kind === 'interrupted') {
          this.displayState = { kind: 'proceeding' };
        }
        let reasonText: string | undefined;
        const reason = event.reason;
        if (reason) {
          reasonText = this.formatInterruptionReason(reason);
        }
        this.appendDisplayStateMarker({ kind: event.kind, reason: reasonText });
        break;
      }

      case 'queue_user_msg_evt':
        this.handleQueuedUserMsg(event);
        break;

      case 'end_of_user_saying_evt':
        {
          // Render optional user divider/content for this generation.
          // IMPORTANT: this event is NOT guaranteed for every generation (tool-only turns often skip it).
          // Never gate assistant substreams (thinking/markdown/calling/web-search) on its presence.
          const ev: EndOfUserSayingEvent = event;
          if (typeof ev.course !== 'number' || typeof ev.genseq !== 'number') {
            this.handleProtocolError('end_of_user_saying_evt missing required fields');
            break;
          }
          if (typeof ev.msgId !== 'string' || typeof ev.content !== 'string') {
            this.handleProtocolError('end_of_user_saying_evt missing required fields');
            break;
          }
          if (ev.origin !== 'user' && ev.origin !== 'diligence_push' && ev.origin !== 'runtime') {
            this.handleProtocolError('end_of_user_saying_evt missing/invalid origin');
            break;
          }
          this.handleEndOfUserSaying(ev);
        }
        break;

      // LLM Generation Signals (frontend bubble management)
      case 'generating_start_evt':
        if (typeof event.course !== 'number') {
          this.handleProtocolError('generating_start_evt missing required field: course');
        }
        if (typeof event.genseq !== 'number') {
          this.handleProtocolError('generating_start_evt missing required field: genseq');
        }
        this.currentCourse = event.course;
        this.activeGenSeq = event.genseq;
        // Mark generation as started - this ensures substreams arrive in correct order
        this.handleGeneratingStart(event.genseq, event.timestamp, event.msgId);
        break;
      case 'generating_finish_evt':
        {
          if (typeof event.genseq !== 'number') {
            this.handleProtocolError('generating_finish_evt missing required field: genseq');
            break;
          }
          const llmGenModel = typeof event.llmGenModel === 'string' ? event.llmGenModel : undefined;
          // Delegate to handleGeneratingFinish which handles all cases gracefully:
          // - missing bubble: logs warning, cleans up state, returns
          // - seq mismatch: logs warning but proceeds
          // - valid case: completes the bubble
          this.handleGeneratingFinish(event.genseq, llmGenModel);
          this.activeGenSeq = undefined;
        }
        break;
      case 'genseq_discard_evt':
        this.handleGenerationDiscard(event.genseq);
        break;
      case 'llm_retry_evt':
        this.handleLlmRetry(event);
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
      // IMPORTANT: these events must render independently from end_of_user_saying_evt.
      // Reintroducing a "wait for user divider" gate here will recreate empty/air bubbles.
      case 'markdown_start_evt':
        this.handleMarkdownStart(event.genseq, event.timestamp);
        break;
      case 'markdown_chunk_evt':
        this.handleMarkdownChunk(event.genseq, event.chunk, event.timestamp);
        break;
      case 'markdown_finish_evt':
        this.handleMarkdownFinish(event.genseq);
        break;

      // === TELLASK CALL EVENTS (function-tool channel) ===
      case 'tellask_call_start_evt':
        this.handleToolCallStart(event);
        break;

      // === FUNCTION CALLS (non-streaming mode - direct tool execution) ===
      case 'func_call_requested_evt': {
        const ev: FuncCallStartEvent = event;
        this.handleFuncCallRequested(ev.funcId, ev.funcName, ev.arguments);
        break;
      }
      case 'web_search_call_evt':
        this.handleWebSearchCall(event);
        break;

      // Function results
      case 'func_result_evt':
        if (this.generationBubble && this.currentCourse !== event.course) {
          this.handleProtocolError('func_result event.course mismatch with active generation');
          console.error('Function result mismatch', {
            activeSeq: this.activeGenSeq,
            course: this.currentCourse,
            evtCourse: event.course,
          });
          return;
        }
        this.handleFuncResult(event);
        break;

      // Teammate-call lifecycle updates (call site timing + status)
      case 'tellask_call_result_evt':
        this.handleToolCallResponse(event);
        break;
      case 'tellask_call_carryover_evt':
        this.handleTellaskCallCarryover(event);
        break;
      case 'tellask_call_anchor_evt':
        this.handleTellaskCallAnchor(event);
        break;

      // Teammate responses (separate bubble)
      case 'tellask_response_evt':
        this.handleTellaskResponse(event);
        break;
      case 'tellask_carryover_result_evt':
        this.handleTellaskCarryoverResult(event);
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
          const t = getUiStrings(this.uiLanguage);
          const detail = {
            message: String(event.error || t.unknownStreamErrorToast),
            kind: 'error' as const,
          };
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
            course: this.currentCourse,
            evtCourse: event.course,
          });
        }
        this.handleError(String(event.error));
        break;

      // Historical stream events removed; only stream_error_evt may appear and is handled elsewhere
      default:
        this.handleProtocolError(`Unhandled dialog event: ${String(event.type)}`);
    }

    // Best-effort: apply pending call-site scroll requests after any DOM mutation.
    this.maybeApplyPendingScrollRequest();
    this.maybeReapplyPendingHighlight();
  }

  // === GENERATING EVENTS (Frontend Bubble Management) ===
  private handleGeneratingStart(seq: number, timestamp: string, msgId?: string): void {
    if (this.retryPanelState.kind !== 'hidden' && this.retryPanelState.genseq !== seq) {
      this.clearRetryPanel();
    }

    const applyPendingCallAnchor = (bubble: HTMLElement): void => {
      const pendingAnchor = this.pendingTellaskCallAnchorByGenseq.get(seq);
      if (!pendingAnchor) return;
      this.applyTellaskCallAnchorToBubble(bubble, pendingAnchor);
      this.pendingTellaskCallAnchorByGenseq.delete(seq);
    };

    const finalizeExistingBubble = (existingBubble: HTMLElement): void => {
      existingBubble.classList.remove('generating');
      existingBubble.classList.add('completed');
      existingBubble.setAttribute('data-finalized', 'true');
      this.thinkingSection = undefined;
      this.markdownSection = undefined;
      this.callingSection = undefined;
      this.generationBubble = undefined;
    };

    const queuedMsgId = typeof msgId === 'string' ? msgId.trim() : '';
    const queuedBubble = queuedMsgId === '' ? undefined : this.takeQueuedUserBubble(queuedMsgId);

    const existingBubble = this.generationBubble;
    if (queuedBubble) {
      if (existingBubble && existingBubble !== queuedBubble) {
        finalizeExistingBubble(existingBubble);
      }
      this.activeGenSeq = seq;
      const bubble = this.reuseQueuedUserBubbleForGeneration(
        queuedBubble,
        seq,
        timestamp,
        queuedMsgId,
      );
      if (typeof this.currentCourse === 'number') {
        bubble.setAttribute('data-course', String(this.currentCourse));
      }
      applyPendingCallAnchor(bubble);
      this.generationBubble = bubble;
      this.startAutoScrollObservation(bubble);
      this.scrollToBottom();
      return;
    }

    if (existingBubble) {
      const existingSeq = existingBubble.getAttribute('data-seq');
      if (existingSeq === String(seq)) {
        // Generation bubble was created earlier (out-of-order event recovery).
        // Still ensure the bubble is in "generating" state and the timestamp is correct.
        existingBubble.classList.add('generating');
        existingBubble.setAttribute('data-finalized', 'false');
        this.setBubbleTimestamp(existingBubble, timestamp);
        if (typeof this.currentCourse === 'number') {
          existingBubble.setAttribute('data-course', String(this.currentCourse));
        }
        this.activeGenSeq = seq;
        applyPendingCallAnchor(existingBubble);
        this.startAutoScrollObservation(existingBubble);
        this.scrollToBottom();
        return;
      }

      // If a new generation starts before we saw finish for the prior bubble,
      // finalize the old bubble to avoid mixing streams across seq values.
      finalizeExistingBubble(existingBubble);
    }

    this.activeGenSeq = seq;

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;

    const bubble = this.createGenerationBubble(timestamp);
    if (typeof this.currentCourse === 'number') {
      bubble.setAttribute('data-course', String(this.currentCourse));
    }
    bubble.setAttribute('data-seq', String(seq));
    applyPendingCallAnchor(bubble);
    bubble.classList.add('generating'); // Start breathing glow animation
    if (container) {
      container.appendChild(bubble);
    }
    this.generationBubble = bubble;
    this.startAutoScrollObservation(bubble);
    this.scrollToBottom();
  }

  private ensureGenerationBubbleForSeq(seq: number, timestamp: string): HTMLElement | null {
    const applyPendingCallAnchor = (bubble: HTMLElement): void => {
      const pendingAnchor = this.pendingTellaskCallAnchorByGenseq.get(seq);
      if (!pendingAnchor) return;
      this.applyTellaskCallAnchorToBubble(bubble, pendingAnchor);
      this.pendingTellaskCallAnchorByGenseq.delete(seq);
    };

    const currentBubble = this.generationBubble;
    if (currentBubble && currentBubble.getAttribute('data-seq') === String(seq)) {
      applyPendingCallAnchor(currentBubble);
      this.startAutoScrollObservation(currentBubble);
      return currentBubble;
    }

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    const existing = container
      ? (container.querySelector(`.generation-bubble[data-seq="${seq}"]`) as HTMLElement | null)
      : null;
    if (existing) {
      this.generationBubble = existing;
      this.activeGenSeq = seq;
      applyPendingCallAnchor(existing);
      this.startAutoScrollObservation(existing);
      return existing;
    }

    this.handleGeneratingStart(seq, timestamp);
    return this.generationBubble ?? null;
  }

  private handleQueuedUserMsg(
    event: Extract<TypedDialogEvent, { type: 'queue_user_msg_evt' }>,
  ): void {
    const msgId = typeof event.msgId === 'string' ? event.msgId.trim() : '';
    const rawContent = typeof event.content === 'string' ? event.content : '';
    const content = rawContent.trim();
    if (msgId === '' || content === '') {
      this.handleProtocolError('queue_user_msg_evt missing required fields: msgId/content');
      return;
    }

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (!container) return;

    let bubble = this.queuedUserBubbleByMsgId.get(msgId);
    if (bubble && !bubble.isConnected) {
      this.queuedUserBubbleByMsgId.delete(msgId);
      bubble = undefined;
    }
    if (!bubble) {
      for (const node of Array.from(
        container.querySelectorAll<HTMLElement>('.message.user[data-queued-user-msg="true"]'),
      )) {
        if (node.getAttribute('data-user-msg-id') === msgId) {
          bubble = node;
          break;
        }
      }
    }
    if (!bubble) {
      bubble = this.createMessageElement(content, 'user', event.timestamp, msgId);
      bubble.setAttribute('data-queued-user-msg', 'true');
    } else {
      const contentEl = bubble.querySelector('.user-message') as HTMLElement | null;
      if (contentEl) {
        contentEl.textContent = content;
      }
      this.setBubbleTimestamp(bubble, event.timestamp);
    }
    this.queuedUserBubbleByMsgId.set(msgId, bubble);

    const anchor = this.resolveQueuedUserInsertionAnchor(container);
    if (anchor && anchor.parentElement === container) {
      if (bubble.parentElement !== container || bubble.previousElementSibling !== anchor) {
        if (anchor.nextSibling) {
          container.insertBefore(bubble, anchor.nextSibling);
        } else {
          container.appendChild(bubble);
        }
      }
    } else if (bubble.parentElement !== container) {
      container.appendChild(bubble);
    }
    this.scrollToBottom();
  }

  private resolveQueuedUserInsertionAnchor(container: HTMLElement): HTMLElement | undefined {
    const activeBubble = this.generationBubble;
    if (activeBubble && activeBubble.isConnected && activeBubble.parentElement === container) {
      return activeBubble;
    }
    const generationBubbles = container.querySelectorAll<HTMLElement>('.generation-bubble');
    if (generationBubbles.length < 1) return undefined;
    const last = generationBubbles.item(generationBubbles.length - 1);
    return last instanceof HTMLElement ? last : undefined;
  }

  private takeQueuedUserBubble(msgId: string): HTMLElement | undefined {
    const tracked = this.queuedUserBubbleByMsgId.get(msgId);
    if (tracked) {
      this.queuedUserBubbleByMsgId.delete(msgId);
      if (tracked.isConnected) return tracked;
    }
    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (!container) return undefined;
    for (const node of Array.from(
      container.querySelectorAll<HTMLElement>('.message.user[data-queued-user-msg="true"]'),
    )) {
      if (node.getAttribute('data-user-msg-id') !== msgId) continue;
      return node;
    }
    return undefined;
  }

  private reuseQueuedUserBubbleForGeneration(
    queuedBubble: HTMLElement,
    seq: number,
    timestamp: string,
    msgId: string,
  ): HTMLElement {
    const queuedContentEl = queuedBubble.querySelector('.user-message') as HTMLElement | null;
    const queuedRawContent = queuedContentEl?.textContent ?? '';

    const bubble = this.createGenerationBubble(timestamp);
    if (typeof this.currentCourse === 'number') {
      bubble.setAttribute('data-course', String(this.currentCourse));
    }
    bubble.setAttribute('data-seq', String(seq));
    bubble.classList.add('generating');
    bubble.setAttribute('data-finalized', 'false');
    if (msgId !== '') {
      bubble.setAttribute('data-user-msg-id', msgId);
    }
    if (queuedRawContent.trim() !== '') {
      const body = bubble.querySelector('.bubble-body') as HTMLElement | null;
      if (body) {
        const divider = document.createElement('hr');
        divider.className = 'user-response-divider';
        body.appendChild(divider);
        this.upsertUserPlainTextMessage(body, queuedRawContent);
        bubble.setAttribute('data-raw-user-msg', queuedRawContent);
      }
    }

    queuedBubble.replaceWith(bubble);
    return bubble;
  }

  private removeQueuedUserBubbleIfPresent(msgIdRaw: string): void {
    const msgId = msgIdRaw.trim();
    if (msgId === '') return;
    const tracked = this.queuedUserBubbleByMsgId.get(msgId);
    if (tracked) {
      this.queuedUserBubbleByMsgId.delete(msgId);
      if (tracked.isConnected) tracked.remove();
    }

    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    if (!container) return;
    for (const node of Array.from(
      container.querySelectorAll<HTMLElement>('.message.user[data-queued-user-msg="true"]'),
    )) {
      if (node.getAttribute('data-user-msg-id') !== msgId) continue;
      node.remove();
    }
  }

  private handleGeneratingFinish(seq: number, llmGenModel?: string): void {
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

    if (typeof llmGenModel === 'string') {
      const trimmed = llmGenModel.trim();
      if (trimmed.length > 0) {
        const modelEl = bubble.querySelector('.bubble-author-model');
        if (modelEl instanceof HTMLElement) {
          modelEl.textContent = trimmed;
        }
      }
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
    if (this.retryPanelState.kind !== 'hidden' && this.retryPanelState.genseq === seq) {
      this.clearRetryPanel();
    }
    this.thinkingSection = undefined;
    this.markdownSection = undefined;
    this.callingSection = undefined;
    this.generationBubble = undefined;
    // Clear previousDialog since we've completed the generation for that dialog
    this.previousDialog = undefined;
  }

  private handleGenerationDiscard(seq: number): void {
    const container = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    const activeBubble = this.generationBubble;
    const targetBubble =
      activeBubble && activeBubble.getAttribute('data-seq') === String(seq)
        ? activeBubble
        : container
          ? (container.querySelector(
              `.generation-bubble[data-seq="${String(seq)}"]`,
            ) as HTMLElement | null)
          : null;

    if (targetBubble) {
      this.resetGenerationBubbleForRetry(targetBubble);
      this.generationBubble = targetBubble;
      this.thinkingSection = undefined;
      this.markdownSection = undefined;
      this.callingSection = undefined;
    }

    this.tellaskCallingSectionBySeq.delete(seq);
    this.webSearchSectionBySeq.delete(seq);
    this.pendingTellaskCallAnchorByGenseq.delete(seq);

    for (const [itemId, section] of this.webSearchSectionByItemId.entries()) {
      const sectionSeq = section.getAttribute('data-genseq');
      if (sectionSeq === String(seq) || !section.isConnected) {
        this.webSearchSectionByItemId.delete(itemId);
      }
    }

    for (const [callId, section] of this.callingSectionByCallId.entries()) {
      if (!section.isConnected || section.getAttribute('data-genseq') === String(seq)) {
        this.callingSectionByCallId.delete(callId);
      }
    }
    for (const [callId, pending] of this.pendingCallTimingById.entries()) {
      if (
        !pending.section.isConnected ||
        pending.section.getAttribute('data-genseq') === String(seq)
      ) {
        this.pendingCallTimingById.delete(callId);
      }
    }
    if (this.pendingCallTimingById.size === 0) {
      this.stopCallTimingTicker();
    }
  }

  // === THINKING EVENTS (Inside Generation Bubble) ===
  private handleThinkingStart(genseq: number, timestamp: string): void {
    const bubble = this.ensureGenerationBubbleForSeq(genseq, timestamp);
    if (!bubble) {
      console.warn('thinking_start_evt received without generation bubble, skipping');
      return;
    }

    if (this.thinkingSection) {
      console.error(
        'Protocol error: thinking_start_evt while a thinking section is already active',
      );
    }

    const thinkingSection = this.createThinkingSection();
    const body = bubble.querySelector('.bubble-body') as HTMLElement | null;
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
    // NOTE: Do not add end_of_user_saying_evt-based gating here.
    // This handler must render assistant output even when the turn has no user-side prompt payload.
    const bubble = this.ensureGenerationBubbleForSeq(genseq, timestamp);
    if (!bubble) {
      console.warn('markdown_start_evt received without generation bubble, skipping');
      return;
    }
    if (this.markdownSection) {
      console.error(
        'Protocol error: markdown_start_evt while a markdown section is already active',
      );
    }
    // Create and append markdown section directly
    const markdownSection = this.createMarkdownSection();
    const body = bubble.querySelector('.bubble-body') as HTMLElement | null;
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
    this.setupFuncCallArgsProgressiveExpand(funcCallSection);
    this.scrollToBottom();
  }

  private handleWebSearchCall(
    event: Extract<TypedDialogEvent, { type: 'web_search_call_evt' }>,
  ): void {
    const bubble = this.ensureGenerationBubbleForSeq(event.genseq, event.timestamp);
    if (!bubble) {
      console.warn('web_search_call_evt received without generation bubble, skipping');
      return;
    }

    const itemId = typeof event.itemId === 'string' ? event.itemId.trim() : '';
    if (itemId === '') {
      // Should never happen (backend drops invalid web_search_call events), but guard anyway.
      console.warn('web_search_call_evt missing itemId, ignoring');
      return;
    }

    let section: HTMLElement | undefined;

    const fromItemId = this.webSearchSectionByItemId.get(itemId);
    if (fromItemId && fromItemId.isConnected) {
      section = fromItemId;
    }

    if (!section) {
      const fromSeq = this.webSearchSectionBySeq.get(event.genseq);
      if (fromSeq && fromSeq.isConnected && !fromSeq.classList.contains('completed')) {
        section = fromSeq;
      }
    }

    if (!section) {
      section = this.createWebSearchSection();
      section.setAttribute('data-genseq', String(event.genseq));
      const body = bubble.querySelector('.bubble-body');
      (body || bubble).appendChild(section);
    }

    section.setAttribute('data-web-search-item-id', itemId);
    this.webSearchSectionByItemId.set(itemId, section);
    this.webSearchSectionBySeq.set(event.genseq, section);

    this.renderWebSearchSection(section, event);
    this.scrollToBottom();
  }

  private extractWebSearchFocusText(event: WebSearchCallEvent): string | undefined {
    const action = event.action;
    if (!action) return undefined;
    switch (action.type) {
      case 'search': {
        const query = typeof action.query === 'string' ? action.query.trim() : '';
        return query === '' ? undefined : query;
      }
      case 'open_page': {
        const url = typeof action.url === 'string' ? action.url.trim() : '';
        return url === '' ? undefined : url;
      }
      case 'find_in_page': {
        const pattern = typeof action.pattern === 'string' ? action.pattern.trim() : '';
        if (pattern !== '') return pattern;
        const url = typeof action.url === 'string' ? action.url.trim() : '';
        return url === '' ? undefined : url;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled web search action: ${String(_exhaustive)}`);
      }
    }
  }

  private resetGenerationBubbleForRetry(bubble: HTMLElement): void {
    bubble.classList.remove('completed');
    bubble.classList.add('generating');
    bubble.setAttribute('data-finalized', 'false');

    const modelEl = bubble.querySelector('.bubble-author-model') as HTMLElement | null;
    if (modelEl) {
      modelEl.textContent = '';
    }

    const body = bubble.querySelector('.bubble-body') as HTMLElement | null;
    if (!body) return;

    let sawDivider = false;
    for (const child of Array.from(body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains('user-response-divider')) {
        sawDivider = true;
        continue;
      }
      if (sawDivider) {
        child.remove();
      }
    }
  }

  private compactWebSearchItemId(itemId: string): string {
    const raw = itemId.trim();
    if (raw.length <= 28) return raw;
    return `${raw.slice(0, 16)}...${raw.slice(-8)}`;
  }

  private renderWebSearchSection(section: HTMLElement, event: WebSearchCallEvent): void {
    const t = getUiStrings(this.uiLanguage);
    const stateEl = section.querySelector('.web-search-state') as HTMLElement | null;
    const summaryEl = section.querySelector('.web-search-summary') as HTMLElement | null;
    const detailsEl = section.querySelector('.web-search-details') as HTMLElement | null;
    if (!stateEl || !summaryEl || !detailsEl) return;

    const phase = event.phase;
    const status = typeof event.status === 'string' ? event.status.trim() : '';
    const itemId = event.itemId.trim();

    const phaseLabel = phase === 'added' ? t.webSearchPhaseStarted : t.webSearchPhaseDone;
    const stateLabel =
      status === ''
        ? `${t.webSearchProgressPrefix}${phaseLabel}`
        : `${t.webSearchStatusPrefix}${status}`;
    stateEl.textContent = stateLabel;
    stateEl.classList.toggle('is-completed', status === 'completed');
    stateEl.classList.toggle('is-failed', status === 'failed');
    section.classList.toggle('completed', phase === 'done');

    const focusText = this.extractWebSearchFocusText(event);
    if (focusText) {
      summaryEl.textContent = focusText;
      summaryEl.classList.remove('is-empty');
    } else {
      summaryEl.textContent = event.action ? event.action.type : t.webSearchNoDetails;
      summaryEl.classList.add('is-empty');
    }

    const metaParts: string[] = [];
    if (event.action) {
      metaParts.push(`type: ${event.action.type}`);
    }
    metaParts.push(`item: ${this.compactWebSearchItemId(itemId)}`);
    detailsEl.title = `itemId: ${itemId}`;
    detailsEl.textContent = metaParts.join(' · ');
  }

  // === TELLASK CALL EVENTS (function-call mode) ===
  // callId is set at finish event (not start) - content-hash based
  private findInFlightToolCallingSectionForGenseq(genseq: number): HTMLElement | undefined {
    const sr = this.shadowRoot;
    if (!sr) return undefined;
    const selector = `.calling-section[data-genseq="${String(genseq)}"]`;
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
    if (current) {
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
    const cached = this.tellaskCallingSectionBySeq.get(genseq);
    if (cached && cached.isConnected) {
      this.callingSection = cached;
      return cached;
    }
    return undefined;
  }

  private parseEventTimestampMs(rawTimestamp: string | undefined): number | null {
    if (typeof rawTimestamp !== 'string' || rawTimestamp.trim() === '') return null;
    const ts = Date.parse(rawTimestamp);
    return Number.isFinite(ts) ? ts : null;
  }

  private formatAbsoluteTime(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (this.uiLanguage === 'zh') {
      const parts: string[] = [];
      if (days > 0) parts.push(`${days}天`);
      if (hours > 0) parts.push(`${hours}小时`);
      if (minutes > 0) parts.push(`${minutes}分`);
      parts.push(`${seconds}秒`);
      return parts.join('');
    }
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  private normalizeMentionToken(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  }

  private extractMentionListFromHeadline(headline: string): string[] {
    const re = /@([A-Za-z0-9_.-]+)/g;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of headline.matchAll(re)) {
      const id = (match[1] ?? '').trim();
      if (id === '') continue;
      const mention = `@${id}`;
      if (seen.has(mention)) continue;
      seen.add(mention);
      out.push(mention);
    }
    return out;
  }

  private renderMentionList(
    section: HTMLElement,
    mentions: readonly string[],
    sessionSlug?: string,
  ): void {
    const mentionEl = section.querySelector('.calling-headline') as HTMLElement | null;
    if (!mentionEl) return;
    const normalized = mentions
      .map((item) => this.normalizeMentionToken(item))
      .filter((item) => item !== '');
    const unique = Array.from(new Set(normalized));
    const joined =
      unique.length > 0 ? unique.join(', ') : this.uiLanguage === 'zh' ? '（无）' : '(none)';
    const sessionPart = (() => {
      if (!sessionSlug || sessionSlug.trim() === '') return '';
      return ` · ${sessionSlug}`;
    })();
    mentionEl.textContent =
      this.uiLanguage === 'zh'
        ? `诉请对象: ${joined}${sessionPart}`
        : `Mentions: ${joined}${sessionPart}`;
  }

  private renderSpecialCallingHeadline(
    section: HTMLElement,
    callName: 'tellaskBack' | 'askHuman' | 'freshBootsReasoning',
  ): void {
    const headlineEl = section.querySelector('.calling-headline') as HTMLElement | null;
    if (!headlineEl) return;

    switch (callName) {
      case 'tellaskBack': {
        const assignment = this.currentDialog?.assignmentFromSup;
        const requesterLabel =
          assignment && assignment.originMemberId.trim() !== ''
            ? this.formatCallerLabel(assignment)
            : undefined;
        headlineEl.textContent =
          this.uiLanguage === 'zh'
            ? `回问对象: 上游诉请者${requesterLabel ? ` ${requesterLabel}` : ''}`
            : `Ask-back target: upstream requester${requesterLabel ? ` ${requesterLabel}` : ''}`;
        return;
      }
      case 'askHuman':
        headlineEl.textContent =
          this.uiLanguage === 'zh' ? '诉请对象: 人类用户' : 'Target: human user';
        return;
      case 'freshBootsReasoning':
        headlineEl.textContent =
          this.uiLanguage === 'zh' ? '支线类型: 扪心自问（FBR）' : 'Sideline type: FBR';
        return;
    }
  }

  private renderCallTiming(
    section: HTMLElement,
    state: 'pending' | 'completed' | 'failed',
    startedAtMs: number,
    endedAtMs?: number,
    extraNote?: string,
  ): void {
    const timingEl = section.querySelector('.calling-timing') as HTMLElement | null;
    if (!timingEl) return;
    const startText = this.formatAbsoluteTime(startedAtMs);
    if (state === 'pending') {
      const elapsed = this.formatDuration(Date.now() - startedAtMs);
      timingEl.textContent =
        this.uiLanguage === 'zh'
          ? `开始: ${startText} · 已用时: ${elapsed}`
          : `Started: ${startText} · Elapsed: ${elapsed}`;
      return;
    }
    const finishedAt = endedAtMs ?? Date.now();
    const endText = this.formatAbsoluteTime(finishedAt);
    const total = this.formatDuration(finishedAt - startedAtMs);
    const statusMark = state === 'failed' ? (this.uiLanguage === 'zh' ? '失败' : 'failed') : '';
    const baseText =
      this.uiLanguage === 'zh'
        ? `${statusMark ? `状态: ${statusMark} · ` : ''}结束: ${endText} · 总用时: ${total}`
        : `${statusMark ? `Status: ${statusMark} · ` : ''}Ended: ${endText} · Total: ${total}`;
    timingEl.textContent =
      typeof extraNote === 'string' && extraNote.trim() !== ''
        ? `${baseText} · ${extraNote}`
        : baseText;
  }

  private refreshPendingCallTimingDisplay(): void {
    if (this.pendingCallTimingById.size === 0) {
      this.stopCallTimingTicker();
      return;
    }
    for (const [callId, entry] of this.pendingCallTimingById.entries()) {
      if (!entry.section.isConnected) {
        this.pendingCallTimingById.delete(callId);
        continue;
      }
      this.renderCallTiming(entry.section, 'pending', entry.startedAtMs);
    }
    if (this.pendingCallTimingById.size === 0) {
      this.stopCallTimingTicker();
    }
  }

  private ensureCallTimingTicker(): void {
    if (this.callTimingTicker !== null) return;
    this.callTimingTicker = window.setInterval(() => {
      this.refreshPendingCallTimingDisplay();
    }, 1000);
  }

  private stopCallTimingTicker(): void {
    if (this.callTimingTicker === null) return;
    window.clearInterval(this.callTimingTicker);
    this.callTimingTicker = null;
  }

  private markCallSitePending(callId: string, section: HTMLElement, startedAtMs: number): void {
    section.classList.remove('completed');
    section.classList.remove('failed');
    section.classList.add('pending');
    this.pendingCallTimingById.set(callId, { section, startedAtMs });
    this.renderCallTiming(section, 'pending', startedAtMs);
    this.ensureCallTimingTicker();
  }

  private markCallSiteSettled(
    callId: string,
    status: 'completed' | 'failed',
    endedAtMs: number,
  ): void {
    const section = this.callingSectionByCallId.get(callId);
    if (!section) return;
    const startedRaw = section.getAttribute('data-call-start-ms');
    const startedAtMsParsed = startedRaw ? Number.parseInt(startedRaw, 10) : Number.NaN;
    const startedAtMs = Number.isFinite(startedAtMsParsed) ? startedAtMsParsed : endedAtMs;
    section.classList.remove('pending');
    section.classList.remove('carried-over');
    section.classList.add('completed');
    section.classList.toggle('failed', status === 'failed');
    section.removeAttribute('data-carryover-course');
    this.pendingCallTimingById.delete(callId);
    this.renderCallTiming(section, status, startedAtMs, endedAtMs);
    if (this.pendingCallTimingById.size === 0) {
      this.stopCallTimingTicker();
    }
  }

  private markCallSiteCarriedOver(
    callId: string,
    status: 'completed' | 'failed',
    carryoverCourse: number,
    endedAtMs: number,
  ): void {
    const section = this.callingSectionByCallId.get(callId);
    if (!section) return;
    const startedRaw = section.getAttribute('data-call-start-ms');
    const startedAtMsParsed = startedRaw ? Number.parseInt(startedRaw, 10) : Number.NaN;
    const startedAtMs = Number.isFinite(startedAtMsParsed) ? startedAtMsParsed : endedAtMs;
    section.classList.remove('pending');
    section.classList.add('completed');
    section.classList.add('carried-over');
    section.classList.toggle('failed', status === 'failed');
    section.setAttribute('data-carryover-course', String(carryoverCourse));
    this.pendingCallTimingById.delete(callId);
    const extraNote =
      this.uiLanguage === 'zh'
        ? `结果在 C${String(carryoverCourse)} 补入，本程未见此反馈`
        : `Result carried into C${String(carryoverCourse)}; this course never saw the feedback`;
    this.renderCallTiming(section, status, startedAtMs, endedAtMs, extraNote);
    if (this.pendingCallTimingById.size === 0) {
      this.stopCallTimingTicker();
    }
  }

  private getProgressiveExpandLabel(): { text: string; title: string } {
    if (this.uiLanguage === 'zh') {
      return { text: '展开更多', title: '展开更多' };
    }
    return { text: 'Show more', title: 'Show more' };
  }

  private setupProgressiveExpand(options: {
    target: HTMLElement;
    footer: HTMLElement;
    button: HTMLButtonElement;
  }): void {
    const { target, footer, button } = options;
    const label = this.getProgressiveExpandLabel();
    button.innerHTML = `
      <span class="progressive-expand-icon icon-mask" aria-hidden="true"></span>
    `;
    button.setAttribute('aria-label', label.text);
    button.title = label.title;

    const collapseToInitial = (): void => {
      target.style.maxHeight = `${CALLING_CONTENT_INITIAL_MAX_HEIGHT_PX}px`;
      target.style.overflowY = 'hidden';
    };

    const expandFully = (): void => {
      target.style.maxHeight = 'none';
      target.style.overflowY = 'visible';
      footer.classList.add('is-hidden');
    };

    const refreshExpandFooter = (): void => {
      if (!target.isConnected) return;
      const overflow = target.scrollHeight > target.clientHeight + 1;
      if (overflow) {
        footer.classList.remove('is-hidden');
        return;
      }
      expandFully();
    };

    button.onclick = () => {
      const stepPx = Math.max(
        1,
        Math.floor(window.innerHeight * CALLING_EXPAND_STEP_VIEWPORT_RATIO),
      );
      const nextMaxHeightPx =
        Math.max(target.clientHeight, CALLING_CONTENT_INITIAL_MAX_HEIGHT_PX) + stepPx;
      target.style.maxHeight = `${nextMaxHeightPx}px`;
      target.style.overflowY = 'hidden';
      requestAnimationFrame(() => {
        refreshExpandFooter();
        this.scrollToBottom();
      });
    };

    const previousObserver = this.progressiveExpandObserverByTarget.get(target);
    if (previousObserver) {
      previousObserver.disconnect();
    }
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        refreshExpandFooter();
      });
      observer.observe(target);
      this.progressiveExpandObserverByTarget.set(target, observer);
    }

    collapseToInitial();
    requestAnimationFrame(() => {
      refreshExpandFooter();
    });
  }

  private setupCallingProgressiveExpand(section: HTMLElement): void {
    const content = section.querySelector('.calling-content') as HTMLElement | null;
    const footer = section.querySelector('.calling-expand-footer') as HTMLElement | null;
    const button = section.querySelector('.calling-expand-btn') as HTMLButtonElement | null;
    if (!content || !footer || !button) return;
    this.setupProgressiveExpand({ target: content, footer, button });
  }

  private setupFuncCallArgsProgressiveExpand(section: HTMLElement): void {
    const target = section.querySelector('.func-call-arguments') as HTMLElement | null;
    const footer = section.querySelector(
      '.func-call-arguments-expand-footer',
    ) as HTMLElement | null;
    const button = section.querySelector(
      '.func-call-arguments-expand-btn',
    ) as HTMLButtonElement | null;
    if (!target || !footer || !button) return;
    this.setupProgressiveExpand({ target, footer, button });
  }

  private setupFuncCallResultProgressiveExpand(section: HTMLElement): void {
    const target = section.querySelector('.func-call-result') as HTMLElement | null;
    const footer = section.querySelector('.func-call-result-expand-footer') as HTMLElement | null;
    const button = section.querySelector(
      '.func-call-result-expand-btn',
    ) as HTMLButtonElement | null;
    if (!target || !footer || !button) return;
    this.setupProgressiveExpand({ target, footer, button });
  }

  private setupTellaskResponseProgressiveExpand(section: HTMLElement): void {
    const target = section.querySelector('.teammate-content') as HTMLElement | null;
    const footer = section.querySelector('.teammate-expand-footer') as HTMLElement | null;
    const button = section.querySelector('.teammate-expand-btn') as HTMLButtonElement | null;
    if (!target || !footer || !button) return;
    this.setupProgressiveExpand({ target, footer, button });
  }

  private handleToolCallStart(
    event: Extract<TypedDialogEvent, { type: 'tellask_call_start_evt' }>,
  ): void {
    const genseq = event.genseq;
    const mentionList = (() => {
      switch (event.callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return event.mentionList;
        case 'tellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return [] as string[];
      }
    })();
    const firstMention = (() => {
      if (mentionList.length > 0) {
        const primaryMention = mentionList[0] ?? '@unknown';
        return primaryMention.startsWith('@') ? primaryMention.slice(1) : primaryMention;
      }
      switch (event.callName) {
        case 'tellaskBack':
          return 'tellaskBack';
        case 'askHuman':
          return 'askHuman';
        case 'freshBootsReasoning':
          return 'freshBootsReasoning';
        case 'tellask':
        case 'tellaskSessionless':
          return 'unknown';
      }
    })();

    const bubble = this.ensureGenerationBubbleForSeq(genseq, event.timestamp);
    if (!bubble) {
      console.warn('[TellaskCallStart] No generation bubble, skipping');
      return;
    }
    const body = bubble.querySelector('.bubble-body');

    const callingSection = this.createCallingSection(event.callName, firstMention);
    const startedAtMs = this.parseEventTimestampMs(event.timestamp) ?? Date.now();
    callingSection.setAttribute('data-call-start-ms', String(startedAtMs));
    callingSection.setAttribute('data-call-id', event.callId);
    switch (event.callName) {
      case 'tellask':
        this.renderMentionList(callingSection, mentionList, event.sessionSlug);
        break;
      case 'tellaskSessionless':
        this.renderMentionList(callingSection, mentionList);
        break;
      case 'tellaskBack':
      case 'askHuman':
      case 'freshBootsReasoning':
        this.renderSpecialCallingHeadline(callingSection, event.callName);
        break;
    }
    const bodyEl = callingSection.querySelector('.calling-body') as HTMLElement | null;
    if (bodyEl) {
      bodyEl.innerHTML = renderDomindsMarkdown(event.tellaskContent, {
        kind: 'chat',
        allowRelativeWorkspaceLinks: true,
      });
      bodyEl.classList.add('markdown-content');
      bodyEl.setAttribute('data-raw-md', event.tellaskContent);
      bodyEl.classList.add('completed');
    }
    this.renderCallTiming(callingSection, 'pending', startedAtMs);
    callingSection.setAttribute('data-genseq', String(genseq));
    (body || bubble).appendChild(callingSection);
    this.setupCallingProgressiveExpand(callingSection);
    this.callingSection = undefined;
    this.tellaskCallingSectionBySeq.set(genseq, callingSection);
    this.callingSectionByCallId.set(event.callId, callingSection);
    this.markCallSitePending(event.callId, callingSection, startedAtMs);

    this.scrollToBottom();
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
          const items = event.contentItems;
          if (Array.isArray(items) && items.length > 0) {
            resultEl.innerHTML = '';
            for (const item of items) {
              if (item.type === 'input_text') {
                const raw = String(item.text || '');
                const block = document.createElement('div');
                block.innerHTML = renderDomindsMarkdown(raw, {
                  kind: 'chat',
                  allowRelativeWorkspaceLinks: true,
                });
                block.classList.add('markdown-content');
                block.setAttribute('data-raw-md', raw);
                resultEl.appendChild(block);
                continue;
              }

              if (item.type === 'input_image') {
                const img = document.createElement('img');
                img.alt = 'tool image';
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.style.display = 'block';

                const placeholder = document.createElement('div');
                placeholder.textContent = `Loading image (${item.mimeType}, ${item.byteLength} bytes)…`;
                placeholder.style.opacity = '0.8';
                placeholder.style.fontSize = '12px';
                placeholder.style.margin = '6px 0';
                resultEl.appendChild(placeholder);
                resultEl.appendChild(img);

                const api = getApiClient();
                const params = new URLSearchParams();
                params.set('path', item.artifact.relPath);
                params.set(
                  'status',
                  item.artifact.status ?? this.currentDialog?.status ?? 'running',
                );
                const endpoint = `/api/dialogs/${encodeURIComponent(item.artifact.rootId)}/${encodeURIComponent(
                  item.artifact.selfId,
                )}/artifact?${params.toString()}`;

                void (async () => {
                  try {
                    const response = await api.fetchBlob(endpoint);
                    if (!response.success || !response.data) {
                      placeholder.textContent = response.error
                        ? `Failed to load image: ${response.error}`
                        : 'Failed to load image';
                      return;
                    }
                    const objectUrl = URL.createObjectURL(response.data);
                    img.src = objectUrl;
                    placeholder.remove();
                    img.addEventListener(
                      'load',
                      () => {
                        URL.revokeObjectURL(objectUrl);
                      },
                      { once: true },
                    );
                    img.addEventListener(
                      'error',
                      () => {
                        URL.revokeObjectURL(objectUrl);
                      },
                      { once: true },
                    );
                  } catch (err) {
                    placeholder.textContent = `Failed to load image: ${
                      err instanceof Error ? err.message : String(err)
                    }`;
                  }
                })();
                continue;
              }
            }
            resultEl.classList.add('completed');
            resultEl.style.display = 'block';
          } else {
            const raw = String(event.content || '');
            resultEl.innerHTML = renderDomindsMarkdown(raw, {
              kind: 'chat',
              allowRelativeWorkspaceLinks: true,
            });
            resultEl.setAttribute('data-raw-md', raw);
            resultEl.classList.add('markdown-content');
            resultEl.classList.add('completed');
            resultEl.style.display = 'block';
          }
          this.setupFuncCallResultProgressiveExpand(funcCallSection);
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
      this.setupTellaskResponseProgressiveExpand(messageEl);
      this.scrollToBottom();
    }
  }

  // === TELLASK CALL RESULT HANDLER ===
  // Final response body is shown in a separate teammate bubble.
  // Call site only tracks lifecycle status/timing.
  //
  // Call Type Distinction:
  private handleToolCallResponse(
    event: Extract<TypedDialogEvent, { type: 'tellask_call_result_evt' }>,
  ): void {
    if (typeof this.currentCourse === 'number' && event.course !== this.currentCourse) {
      this.handleProtocolError(
        `tellask_call_result_evt course mismatch ${JSON.stringify({
          eventCourse: event.course,
          currentCourse: this.currentCourse,
          callId: event.callId,
        })}`,
      );
      return;
    }

    const callId = String(event.callId || '').trim();
    if (!callId) {
      const mentionListForLog =
        event.callName === 'tellask' || event.callName === 'tellaskSessionless'
          ? event.mentionList
          : undefined;
      this.handleProtocolError(
        `tellask_call_result_evt missing callId ${JSON.stringify({
          responderId: event.responderId,
          mentionList: mentionListForLog,
          tellaskContent: event.tellaskContent,
          calling_genseq: event.calling_genseq,
        })}`,
      );
      return;
    }

    const callingSection = this.callingSectionByCallId.get(callId);
    if (!callingSection) {
      this.handleProtocolError(
        `tellask_call_result_evt received before tellask_call_start_evt ${JSON.stringify({
          callId,
          course: event.course,
          calling_genseq: event.calling_genseq,
          responderId: event.responderId,
        })}`,
      );
      return;
    }

    const endedAtMs = this.parseEventTimestampMs(event.timestamp) ?? Date.now();
    this.markCallSiteSettled(callId, event.status, endedAtMs);
    if (event.status === 'failed') {
      const host = (this.getRootNode() as ShadowRoot)?.host as HTMLElement | null;
      const t = getUiStrings(this.uiLanguage);
      host?.dispatchEvent(
        new CustomEvent('ui-toast', {
          detail: {
            message: String(event.result || t.teammateCallFailedToast),
            kind: 'error',
          },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private handleTellaskCallCarryover(
    event: Extract<TypedDialogEvent, { type: 'tellask_call_carryover_evt' }>,
  ): void {
    if (typeof this.currentCourse === 'number' && event.course !== this.currentCourse) {
      this.handleProtocolError(
        `tellask_call_carryover_evt course mismatch ${JSON.stringify({
          eventCourse: event.course,
          currentCourse: this.currentCourse,
          callId: event.callId,
          carryoverCourse: event.carryoverCourse,
        })}`,
      );
      return;
    }

    const callId = String(event.callId || '').trim();
    if (!callId) {
      this.handleProtocolError(
        `tellask_call_carryover_evt missing callId ${JSON.stringify({
          responderId: event.responderId,
          course: event.course,
          carryoverCourse: event.carryoverCourse,
        })}`,
      );
      return;
    }

    const callingSection = this.callingSectionByCallId.get(callId);
    if (!callingSection) {
      this.handleProtocolError(
        `tellask_call_carryover_evt received before tellask_call_start_evt ${JSON.stringify({
          callId,
          course: event.course,
          responderId: event.responderId,
          carryoverCourse: event.carryoverCourse,
        })}`,
      );
      return;
    }

    const endedAtMs = this.parseEventTimestampMs(event.timestamp) ?? Date.now();
    this.markCallSiteCarriedOver(callId, event.status, event.carryoverCourse, endedAtMs);
  }

  private parseOptionalPositiveInt(value: unknown): number | undefined {
    if (typeof value !== 'number') {
      return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  private applyTellaskCallAnchorToBubble(bubble: HTMLElement, anchor: TellaskCallAnchorMeta): void {
    bubble.setAttribute('data-call-id', anchor.callId);
    bubble.setAttribute('data-teammate-call-anchor-role', anchor.anchorRole);

    const assignmentCourse =
      typeof anchor.assignmentCourse === 'number' && Number.isFinite(anchor.assignmentCourse)
        ? Math.floor(anchor.assignmentCourse)
        : undefined;
    const assignmentGenseq =
      typeof anchor.assignmentGenseq === 'number' && Number.isFinite(anchor.assignmentGenseq)
        ? Math.floor(anchor.assignmentGenseq)
        : undefined;
    if (assignmentCourse !== undefined) {
      bubble.setAttribute('data-assignment-course', String(assignmentCourse));
    } else {
      bubble.removeAttribute('data-assignment-course');
    }
    if (assignmentGenseq !== undefined) {
      bubble.setAttribute('data-assignment-genseq', String(assignmentGenseq));
    } else {
      bubble.removeAttribute('data-assignment-genseq');
    }

    const callerDialogId =
      typeof anchor.callerDialogId === 'string' ? anchor.callerDialogId.trim() : '';
    if (callerDialogId !== '') {
      bubble.setAttribute('data-caller-dialog-id', callerDialogId);
    } else {
      bubble.removeAttribute('data-caller-dialog-id');
    }
    const callerCourse =
      typeof anchor.callerCourse === 'number' && Number.isFinite(anchor.callerCourse)
        ? Math.floor(anchor.callerCourse)
        : undefined;
    if (callerCourse !== undefined) {
      bubble.setAttribute('data-caller-course', String(callerCourse));
    } else {
      bubble.removeAttribute('data-caller-course');
    }

    this.upsertGenerationBubbleAnchorActions(bubble);
  }

  private handleTellaskCallAnchor(
    event: Extract<TypedDialogEvent, { type: 'tellask_call_anchor_evt' }>,
  ): void {
    const rawCallId = typeof event.callId === 'string' ? event.callId.trim() : '';
    if (rawCallId === '') {
      this.handleProtocolError('tellask_call_anchor_evt missing callId');
      return;
    }
    if (!Number.isFinite(event.genseq) || event.genseq <= 0) {
      this.handleProtocolError(
        `tellask_call_anchor_evt invalid genseq ${JSON.stringify({
          genseq: event.genseq,
          callId: rawCallId,
        })}`,
      );
      return;
    }
    const rawAnchorRole =
      typeof (event as { anchorRole?: unknown }).anchorRole === 'string'
        ? (event as { anchorRole: string }).anchorRole.trim()
        : '';
    if (rawAnchorRole !== 'assignment' && rawAnchorRole !== 'response') {
      this.handleProtocolError(
        `tellask_call_anchor_evt invalid anchorRole ${JSON.stringify({
          anchorRole: rawAnchorRole,
          callId: rawCallId,
          genseq: event.genseq,
        })}`,
      );
      return;
    }

    const assignmentCourse = this.parseOptionalPositiveInt(event.assignmentCourse);
    const assignmentGenseq = this.parseOptionalPositiveInt(event.assignmentGenseq);
    const callerCourse = this.parseOptionalPositiveInt(event.callerCourse);
    const callerDialogId =
      typeof event.callerDialogId === 'string' ? event.callerDialogId.trim() : undefined;
    const anchorMeta: TellaskCallAnchorMeta = {
      callId: rawCallId,
      anchorRole: rawAnchorRole,
      assignmentCourse:
        assignmentCourse !== undefined ? toAssignmentCourseNumber(assignmentCourse) : undefined,
      assignmentGenseq:
        assignmentGenseq !== undefined
          ? toAssignmentGenerationSeqNumber(assignmentGenseq)
          : undefined,
      callerDialogId,
      callerCourse: callerCourse !== undefined ? toCallerCourseNumber(callerCourse) : undefined,
    };
    const genseq = Math.floor(event.genseq);
    const messages = this.shadowRoot?.querySelector('.messages') as HTMLElement | null;
    const bubble = messages
      ? (messages.querySelector(
          `.generation-bubble[data-seq="${String(genseq)}"]`,
        ) as HTMLElement | null)
      : null;
    if (bubble) {
      this.applyTellaskCallAnchorToBubble(bubble, anchorMeta);
      this.pendingTellaskCallAnchorByGenseq.delete(genseq);
      return;
    }
    this.pendingTellaskCallAnchorByGenseq.set(genseq, anchorMeta);
  }

  // === TEAMMATE RESPONSE HANDLER ===
  // Handles responses for @agentName calls - displays result in SEPARATE bubble
  // Now includes full response and agentId from subdialog completion
  //
  // Call Type Distinction:
  // - Teammate tellask function calls (tellask/tellaskSessionless)
  //   - Result displays in SEPARATE bubble (subdialog or supdialog response)
  //   - Uses calleeDialogId for correlation (event.calleeDialogId)
  //   - Uses this handler (handleTellaskResponse)
  //
  // - Parent Call: subdialog responding to @parentAgentId from within
  //   - Result displays INLINE in parent's bubble
  //   - Uses callId for correlation
  //   - Uses handleToolCallResponse() instead
  private handleTellaskResponse(
    event: Extract<TypedDialogEvent, { type: 'tellask_response_evt' }>,
  ): void {
    const normalizedCallId = String(event.callId || '').trim();
    if (normalizedCallId !== '') {
      const endedAtMs = this.parseEventTimestampMs(event.timestamp) ?? Date.now();
      const hasCallSite = this.callingSectionByCallId.has(normalizedCallId);
      if (!hasCallSite) {
        this.handleProtocolError(
          `tellask_response_evt received before tellask_call_start_evt ${JSON.stringify({
            callId: normalizedCallId,
            course: event.course,
            calling_genseq: event.calling_genseq,
            responderId: event.responderId,
            status: event.status,
          })}`,
        );
      } else {
        this.markCallSiteSettled(normalizedCallId, event.status, endedAtMs);
      }
    }
    // Validate calleeDialogId is present
    if (!event.calleeDialogId) {
      console.error('handleTellaskResponse: Missing calleeDialogId', {
        responderId: event.responderId,
        response: event.response?.substring(0, 100),
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
      throw new Error('handleTellaskResponse: Missing originMemberId (requesterId)');
    }
    if (typeof event.response !== 'string') {
      throw new Error('handleTellaskResponse: Missing response payload');
    }

    const responseNarr = event.response;
    const sessionSlug = (() => {
      switch (event.callName) {
        case 'tellask':
          return event.sessionSlug;
        case 'tellaskSessionless':
        case 'tellaskBack':
        case 'freshBootsReasoning':
          return undefined;
      }
    })();

    // callId is used for navigation between call site ↔ response bubble.

    // Create teammate bubble with the response
    const messageEl = this.createTellaskResponseBubble(
      event.calleeDialogId,
      agentId,
      responseNarr,
      event.calling_genseq,
      event.callId,
      event.originMemberId,
      event.callName,
      event.timestamp,
      sessionSlug,
      typeof event.calleeCourse === 'number' && Number.isFinite(event.calleeCourse)
        ? toCalleeCourseNumber(event.calleeCourse)
        : undefined,
    );

    const container = this.shadowRoot?.querySelector('.messages');
    if (container) {
      container.appendChild(messageEl);
      this.scrollToBottom();
    }
  }

  private handleTellaskCarryoverResult(
    event: Extract<TypedDialogEvent, { type: 'tellask_carryover_result_evt' }>,
  ): void {
    const container = this.shadowRoot?.querySelector('.messages');
    if (!container) {
      return;
    }
    const messageEl = this.createTellaskCarryoverBubble(event);
    container.appendChild(messageEl);
    this.setupTellaskResponseProgressiveExpand(messageEl);
    this.scrollToBottom();
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
  private createTellaskResponseBubble(
    calleeDialogId: string,
    agentId: string | undefined,
    responseNarr: string,
    callSiteId?: CallingGenerationSeqNumber,
    callId?: string,
    originMemberId?: string,
    callName?: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning',
    timestamp?: string,
    sessionSlug?: string,
    calleeCourse?: CalleeCourseNumber,
  ): HTMLElement {
    const t = getUiStrings(this.uiLanguage);
    const el = document.createElement('div');
    el.className = 'message teammate';
    el.setAttribute('data-callee-dialog-id', calleeDialogId);
    if (typeof callSiteId === 'number') {
      el.setAttribute('data-call-site-id', String(callSiteId));
    }
    if (callId) {
      el.setAttribute('data-call-id', callId);
    }
    const isFbr = callName === 'freshBootsReasoning';
    if (isFbr) {
      el.classList.add('fbr');
    }
    const responderLabel = (() => {
      if (isFbr) return 'FBR';
      if (agentId && agentId.trim() !== '') return this.formatAgentLabel(agentId);
      return 'Teammate';
    })();
    const requesterLabel = (() => {
      if (originMemberId && originMemberId.trim() !== '')
        return this.formatAgentLabel(originMemberId);
      if (this.currentDialog?.agentId && this.currentDialog.agentId.trim() !== '') {
        return this.formatAgentLabel(this.currentDialog.agentId);
      }
      return 'Assistant';
    })();
    const safeRequesterLabel = this.escapeHtml(requesterLabel);
    const safeResponderLabel = this.escapeHtml(responderLabel);
    const safeTimestamp = this.escapeHtml(timestamp ?? '');
    const normalizedSessionSlug =
      typeof sessionSlug === 'string' && sessionSlug.trim() !== '' ? sessionSlug.trim() : '';
    const sessionSlugHtml =
      normalizedSessionSlug === ''
        ? ''
        : `<span class="teammate-session-slug">· ${this.escapeHtml(normalizedSessionSlug)}</span>`;
    el.innerHTML = `
      <div class="bubble-content">
        <div class="bubble-header">
          <div class="bubble-title">
            <div class="title-row">
              <div class="title-left">
                <span class="requester-name">${safeRequesterLabel}</span>
                <span class="response-arrow" aria-hidden="true">←</span>
                <span class="author-name">${safeResponderLabel}</span>
                ${sessionSlugHtml}
              </div>
              <div class="title-right">
                ${
                  callId
                    ? `<div class="bubble-title-actions" data-call-id="${callId}">
                      <button type="button" class="callsite-icon-btn internal" aria-label="${this.escapeHtml(t.q4hGoToCallSiteTitle)}" title="${this.escapeHtml(t.q4hGoToCallSiteTitle)}">
                        <span class="icon-mask dc-icon-crosshair" aria-hidden="true"></span>
                      </button>
                      <button type="button" class="callsite-icon-btn external" aria-label="${this.escapeHtml(t.q4hOpenInNewTabTitle)}" title="${this.escapeHtml(t.q4hOpenInNewTabTitle)}">
                        <span class="icon-mask dc-icon-external" aria-hidden="true"></span>
                      </button>
                      <button type="button" class="callsite-icon-btn share" aria-label="${this.escapeHtml(t.q4hCopyLinkTitle)}" title="${this.escapeHtml(t.q4hCopyLinkTitle)}">
                        <span class="icon-mask dc-icon-link" aria-hidden="true"></span>
                      </button>
                    </div>`
                    : ''
                }
                <div class="timestamp">${safeTimestamp}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="bubble-body">
          <div class="teammate-content"></div>
          <div class="teammate-expand-footer progressive-expand-footer is-hidden">
            <button type="button" class="teammate-expand-btn progressive-expand-btn"></button>
          </div>
        </div>
      </div>
    `;
    const contentEl = el.querySelector('.teammate-content');
    if (contentEl) {
      const md = this.createMarkdownSection();
      md.setRawMarkdown(responseNarr);
      contentEl.appendChild(md);
    }
    const internalBtn = el.querySelector(
      'button.callsite-icon-btn.internal',
    ) as HTMLButtonElement | null;
    if (internalBtn && callId) {
      internalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.navigateToCallSiteInApp(callId);
      });
    }

    const externalBtn = el.querySelector(
      'button.callsite-icon-btn.external',
    ) as HTMLButtonElement | null;
    if (externalBtn && callId) {
      externalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openCallSiteDeepLinkInNewTab(callId, {
          selfId: calleeDialogId,
          course: calleeCourse,
        });
      });
    }

    const shareBtn = el.querySelector('button.callsite-icon-btn.share') as HTMLButtonElement | null;
    if (shareBtn && callId) {
      shareBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.copyCallSiteDeepLinkToClipboard(callId, {
          selfId: calleeDialogId,
          course: calleeCourse,
        });
      });
    }
    return el;
  }

  private createTellaskCarryoverBubble(
    event: Extract<TypedDialogEvent, { type: 'tellask_carryover_result_evt' }>,
  ): HTMLElement {
    const t = getUiStrings(this.uiLanguage);
    const el = document.createElement('div');
    el.className = 'message teammate tellask-carryover';
    el.setAttribute('data-call-id', event.callId);
    el.setAttribute('data-origin-course', String(Math.floor(event.originCourse)));
    const safeTimestamp = this.escapeHtml(event.timestamp ?? '');
    const originCourse = Math.floor(event.originCourse);
    const titleText =
      this.uiLanguage === 'zh'
        ? `旧程诉请结果补入 · C ${String(originCourse)}`
        : `Carry-over tellask result · C ${String(originCourse)}`;
    el.innerHTML = `
      <div class="bubble-content">
        <div class="bubble-header">
          <div class="bubble-title">
            <div class="title-row">
              <div class="title-left">
                <span class="author-name">${this.escapeHtml(titleText)}</span>
              </div>
              <div class="title-right">
                <div class="bubble-title-actions" data-call-id="${this.escapeHtml(event.callId)}">
                  <button type="button" class="callsite-icon-btn internal" aria-label="${this.escapeHtml(t.q4hGoToCallSiteTitle)}" title="${this.escapeHtml(t.q4hGoToCallSiteTitle)}">
                    <span class="icon-mask dc-icon-crosshair" aria-hidden="true"></span>
                  </button>
                  <button type="button" class="callsite-icon-btn external" aria-label="${this.escapeHtml(t.q4hOpenInNewTabTitle)}" title="${this.escapeHtml(t.q4hOpenInNewTabTitle)}">
                    <span class="icon-mask dc-icon-external" aria-hidden="true"></span>
                  </button>
                  <button type="button" class="callsite-icon-btn share" aria-label="${this.escapeHtml(t.q4hCopyLinkTitle)}" title="${this.escapeHtml(t.q4hCopyLinkTitle)}">
                    <span class="icon-mask dc-icon-link" aria-hidden="true"></span>
                  </button>
                </div>
                <div class="timestamp">${safeTimestamp}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="bubble-body">
          <div class="teammate-content"></div>
          <div class="teammate-expand-footer progressive-expand-footer is-hidden">
            <button type="button" class="teammate-expand-btn progressive-expand-btn"></button>
          </div>
        </div>
      </div>
    `;
    const contentEl = el.querySelector('.teammate-content');
    if (contentEl) {
      const md = this.createMarkdownSection();
      md.setRawMarkdown(event.content);
      contentEl.appendChild(md);
    }

    const internalBtn = el.querySelector(
      'button.callsite-icon-btn.internal',
    ) as HTMLButtonElement | null;
    if (internalBtn) {
      internalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.navigateToCallSiteInApp(event.callId, originCourse);
      });
    }

    const externalBtn = el.querySelector(
      'button.callsite-icon-btn.external',
    ) as HTMLButtonElement | null;
    if (externalBtn) {
      externalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openCallSiteDeepLinkInNewTab(event.callId, {
          course: toCallerCourseNumber(originCourse),
        });
      });
    }

    const shareBtn = el.querySelector('button.callsite-icon-btn.share') as HTMLButtonElement | null;
    if (shareBtn) {
      shareBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.copyCallSiteDeepLinkToClipboard(event.callId, {
          course: toCallerCourseNumber(originCourse),
        });
      });
    }

    return el;
  }

  private navigateToCallSiteInApp(callId: string, courseOverride?: number): void {
    const rawCallId = callId.trim();
    if (!rawCallId) return;

    const course =
      typeof courseOverride === 'number' && Number.isFinite(courseOverride)
        ? Math.floor(courseOverride)
        : this.currentCourse;
    if (typeof course === 'number') {
      if (this.currentCourse === course) {
        // Prefer local navigation: avoid re-selecting dialogs/courses in the parent app, which can
        // trigger a re-render/replay and create duplicate feedback bubbles.
        this.pendingScrollRequest = { kind: 'by_call_id', course, callId: rawCallId };
        this.maybeApplyPendingScrollRequest();
        return;
      }

      const dialog = this.currentDialog;
      if (!dialog) return;
      this.dispatchEvent(
        new CustomEvent('navigate-callsite', {
          detail: {
            rootId: dialog.rootId,
            selfId: dialog.selfId,
            course,
            callId: rawCallId,
          },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    // No course context: do nothing (best-effort only). External deeplink button exists for
    // navigation that requires dialog/course resolution.
  }

  private navigateToGenerationBubbleInApp(target: TellaskAssignmentTarget): void {
    const normalizedCourse = Math.floor(target.course);
    const normalizedGenseq = Math.floor(target.genseq);
    const dialog = this.currentDialog;
    if (!dialog) return;

    if (this.currentCourse === normalizedCourse) {
      this.pendingScrollRequest = {
        kind: 'by_genseq',
        course: normalizedCourse,
        genseq: normalizedGenseq,
      };
      this.maybeApplyPendingScrollRequest();
      return;
    }

    this.dispatchEvent(
      new CustomEvent('navigate-genseq', {
        detail: {
          rootId: dialog.rootId,
          selfId: dialog.selfId,
          course: normalizedCourse,
          genseq: normalizedGenseq,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private openCallSiteDeepLinkInNewTab(callId: string, target?: TellaskCallSiteTarget): void {
    const dialog = this.currentDialog;
    if (!dialog) return;
    const selfId = typeof target?.selfId === 'string' ? target.selfId.trim() : '';
    const resolvedSelfId = selfId !== '' ? selfId : dialog.selfId;
    const course = target?.course;
    const resolvedCourse =
      typeof course === 'number' && Number.isFinite(course) ? course : this.currentCourse;
    if (typeof resolvedCourse !== 'number' || !Number.isFinite(resolvedCourse)) return;

    const url = new URL(window.location.href);
    // Preserve auth and other non-deeplink params; override only deeplink keys.
    url.searchParams.delete('rootId');
    url.searchParams.delete('selfId');
    url.searchParams.delete('course');
    url.searchParams.delete('msg');
    url.searchParams.delete('callId');
    url.searchParams.delete('genseq');
    url.hash = '';
    url.pathname = `/dl/callsite`;
    url.searchParams.set('rootId', dialog.rootId);
    url.searchParams.set('selfId', resolvedSelfId);
    url.searchParams.set('course', String(Math.floor(resolvedCourse)));
    url.searchParams.set('callId', callId);
    const urlStr = url.toString();
    const w = window.open(urlStr, '_blank', 'noopener,noreferrer');
    if (w) w.opener = null;
  }

  private async copyCallSiteDeepLinkToClipboard(
    callId: string,
    target?: TellaskCallSiteTarget,
  ): Promise<void> {
    const dialog = this.currentDialog;
    if (!dialog) return;
    const selfId = typeof target?.selfId === 'string' ? target.selfId.trim() : '';
    const resolvedSelfId = selfId !== '' ? selfId : dialog.selfId;
    const course = target?.course;
    const resolvedCourse =
      typeof course === 'number' && Number.isFinite(course) ? course : this.currentCourse;
    if (typeof resolvedCourse !== 'number' || !Number.isFinite(resolvedCourse)) return;

    const url = new URL(window.location.href);
    url.searchParams.delete('rootId');
    url.searchParams.delete('selfId');
    url.searchParams.delete('course');
    url.searchParams.delete('msg');
    url.searchParams.delete('callId');
    url.searchParams.delete('genseq');
    url.hash = '';
    url.pathname = `/dl/callsite`;
    url.searchParams.set('rootId', dialog.rootId);
    url.searchParams.set('selfId', resolvedSelfId);
    url.searchParams.set('course', String(Math.floor(resolvedCourse)));
    url.searchParams.set('callId', callId);
    await this.copyLinkToClipboardWithToast(url.toString());
  }

  private async copyGenerationBubbleDeepLinkToClipboard(genseq: number): Promise<void> {
    const dialog = this.currentDialog;
    const course = this.currentCourse;
    if (!dialog || typeof course !== 'number') return;
    if (!Number.isFinite(genseq) || genseq <= 0) return;

    const url = new URL(window.location.href);
    url.searchParams.delete('rootId');
    url.searchParams.delete('selfId');
    url.searchParams.delete('course');
    url.searchParams.delete('msg');
    url.searchParams.delete('callId');
    url.searchParams.delete('genseq');
    url.hash = '';
    url.pathname = `/dl/genseq`;
    url.searchParams.set('rootId', dialog.rootId);
    url.searchParams.set('selfId', dialog.selfId);
    url.searchParams.set('course', String(Math.floor(course)));
    url.searchParams.set('genseq', String(Math.floor(genseq)));
    await this.copyLinkToClipboardWithToast(url.toString());
  }

  private emitToast(message: string, kind: 'error' | 'warning' | 'info' = 'info'): void {
    this.dispatchEvent(
      new CustomEvent('ui-toast', { detail: { message, kind }, bubbles: true, composed: true }),
    );
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok === true;
    } catch {
      return false;
    }
  }

  private async copyLinkToClipboardWithToast(urlStr: string): Promise<void> {
    const ok = await this.copyTextToClipboard(urlStr);
    const t = getUiStrings(this.uiLanguage);
    if (ok) {
      this.emitToast(t.linkCopiedToast, 'info');
      return;
    }
    this.emitToast(t.linkCopyFailedToast, 'warning');
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
    return agentId.startsWith('@') ? agentId : `@${agentId}`;
  }

  private formatCallerLabel(assignment: AssignmentFromSup): string {
    const originMemberId = assignment.originMemberId;
    if (originMemberId && originMemberId.trim() !== '') {
      return this.formatAgentLabel(originMemberId);
    }
    return 'Assistant';
  }

  private canForkCurrentDialog(): boolean {
    const dialog = this.currentDialog;
    if (!dialog) return false;
    return dialog.selfId === dialog.rootId;
  }

  private upsertGenerationBubbleAnchorActions(bubble: HTMLElement): void {
    const headerRight = bubble.querySelector('.bubble-header-right') as HTMLElement | null;
    if (!headerRight) {
      return;
    }
    const existingActions = headerRight.querySelector(
      '.bubble-anchor-actions',
    ) as HTMLElement | null;
    const anchorRole = bubble.getAttribute('data-teammate-call-anchor-role');
    if (anchorRole !== 'response') {
      existingActions?.remove();
      return;
    }

    const callId = (bubble.getAttribute('data-call-id') ?? '').trim();
    const assignmentCourseRaw = Number.parseInt(
      bubble.getAttribute('data-assignment-course') ?? '',
      10,
    );
    const assignmentGenseqRaw = Number.parseInt(
      bubble.getAttribute('data-assignment-genseq') ?? '',
      10,
    );
    const callerDialogId = (bubble.getAttribute('data-caller-dialog-id') ?? '').trim();
    const callerCourseRaw = Number.parseInt(bubble.getAttribute('data-caller-course') ?? '', 10);
    const hasAssignmentRef =
      Number.isFinite(assignmentCourseRaw) &&
      assignmentCourseRaw > 0 &&
      Number.isFinite(assignmentGenseqRaw) &&
      assignmentGenseqRaw > 0;
    const hasCallerRef =
      callId !== '' &&
      callerDialogId !== '' &&
      Number.isFinite(callerCourseRaw) &&
      callerCourseRaw > 0;
    if (!hasCallerRef) {
      this.handleProtocolError(
        `response anchor bubble missing caller link refs ${JSON.stringify({
          callId,
          assignmentCourse: bubble.getAttribute('data-assignment-course'),
          assignmentGenseq: bubble.getAttribute('data-assignment-genseq'),
          callerDialogId,
          callerCourse: bubble.getAttribute('data-caller-course'),
        })}`,
      );
      existingActions?.remove();
      return;
    }

    const t = getUiStrings(this.uiLanguage);
    const actions = existingActions ?? document.createElement('div');
    actions.className = 'bubble-anchor-actions';
    // A pending tellask can be satisfied before its queued assignment prompt is rendered inside
    // the callee dialog. In that case we still have a valid caller deep-link, but no local
    // assignment bubble to navigate to yet.
    actions.innerHTML = `
      ${
        hasAssignmentRef
          ? `<button type="button" class="bubble-anchor-assignment-btn" aria-label="${this.escapeHtml(t.teammateAssignmentBubbleTitle)}" title="${this.escapeHtml(t.teammateAssignmentBubbleTitle)}">
        <span class="icon-mask dc-icon-crosshair" aria-hidden="true"></span>
      </button>`
          : ''
      }
      <button type="button" class="bubble-anchor-caller-callsite-btn" aria-label="${this.escapeHtml(t.teammateRequesterCallSiteTitle)}" title="${this.escapeHtml(t.teammateRequesterCallSiteTitle)}">
        <span class="icon-mask dc-icon-external" aria-hidden="true"></span>
      </button>
    `;

    const shareBtn = headerRight.querySelector('.bubble-share-link-btn');
    if (shareBtn) {
      headerRight.insertBefore(actions, shareBtn);
    } else {
      headerRight.appendChild(actions);
    }
  }

  private buildGenerationBubbleHeaderHtml(timestamp: string): string {
    const t = getUiStrings(this.uiLanguage);
    const authorLabel = this.getAuthorLabel('assistant');
    const safeAuthorLabel = this.escapeHtml(authorLabel);
    const safeTimestamp = this.escapeHtml(timestamp);
    const forkButton = this.canForkCurrentDialog()
      ? `
          <button type="button" class="bubble-fork-btn" aria-label="${this.escapeHtml(t.forkDialogTitle)}" title="${this.escapeHtml(t.forkDialogTitle)}">
            <span class="icon-mask dc-icon-fork" aria-hidden="true"></span>
          </button>
        `
      : '';
    return `
      <div class="bubble-header">
        <div class="bubble-title">
          <div class="bubble-author">
            <span class="bubble-author-name">${safeAuthorLabel}</span>
            <span class="bubble-author-model"></span>
          </div>
        </div>
        <div class="bubble-header-right">
          <div class="bubble-anchor-actions"></div>
          ${forkButton}
          <button type="button" class="bubble-share-link-btn" aria-label="${this.escapeHtml(t.q4hCopyLinkTitle)}" title="${this.escapeHtml(t.q4hCopyLinkTitle)}">
            <span class="icon-mask dc-icon-link" aria-hidden="true"></span>
          </button>
          <div class="timestamp">${safeTimestamp}</div>
        </div>
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

  private normalizeQ4HAnswerCallIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      const callId = value.trim();
      if (callId === '' || seen.has(callId)) continue;
      seen.add(callId);
      normalized.push(callId);
    }
    return normalized;
  }

  private upsertUserAnswerCallSiteLinks(bubble: HTMLElement, callIds: readonly string[]): void {
    const headerRight = bubble.querySelector('.bubble-header-right') as HTMLElement | null;
    if (!headerRight) return;
    let actions = headerRight.querySelector('.bubble-anchor-actions') as HTMLElement | null;
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'bubble-anchor-actions';
      const shareBtn = headerRight.querySelector('.bubble-share-link-btn');
      if (shareBtn) {
        headerRight.insertBefore(actions, shareBtn);
      } else {
        headerRight.appendChild(actions);
      }
    }
    const existing = actions.querySelector('.user-answer-callsite-actions') as HTMLElement | null;
    if (callIds.length === 0) {
      existing?.remove();
      bubble.removeAttribute('data-q4h-answer-call-ids');
      return;
    }

    bubble.setAttribute('data-q4h-answer-call-ids', callIds.join(','));
    const t = getUiStrings(this.uiLanguage);
    const html = callIds
      .map((callId, index) => {
        const label = `#${String(index + 1)}`;
        const safeCallId = this.escapeHtml(callId);
        const safeLabel = this.escapeHtml(label);
        const safeTitle = this.escapeHtml(`${t.q4hGoToCallSiteTitle} ${label}`);
        return `<button type="button" class="user-answer-callsite-link-btn" data-call-id="${safeCallId}" aria-label="${safeTitle}" title="${safeTitle}">${safeLabel}</button>`;
      })
      .join('');
    if (existing) {
      existing.innerHTML = html;
      return;
    }

    const linksEl = document.createElement('div');
    linksEl.className = 'user-answer-callsite-actions';
    linksEl.innerHTML = html;
    actions.appendChild(linksEl);
  }

  private upsertUserPlainTextMessage(body: HTMLElement, rawContent: string): void {
    this.upsertUserMessageByOrigin(body, rawContent, 'user');
  }

  private upsertUserMessageByOrigin(
    body: HTMLElement,
    rawContent: string,
    origin: EndOfUserSayingEvent['origin'] | undefined,
  ): void {
    const renderAsPlainText = origin === 'user' || origin === undefined;
    let divider: HTMLElement | null = null;
    for (const child of Array.from(body.children)) {
      if (child instanceof HTMLElement && child.classList.contains('user-response-divider')) {
        divider = child;
        break;
      }
    }

    if (renderAsPlainText) {
      for (const child of Array.from(body.children)) {
        if (divider && child === divider) break;
        if (child instanceof HTMLElement && child.classList.contains('markdown-section')) {
          child.remove();
        }
      }

      let userMessageEl: HTMLElement | null = null;
      for (const child of Array.from(body.children)) {
        if (divider && child === divider) break;
        if (child instanceof HTMLElement && child.classList.contains('user-message')) {
          userMessageEl = child;
          break;
        }
      }

      if (!userMessageEl) {
        userMessageEl = document.createElement('div');
        userMessageEl.className = 'user-message';
      }
      userMessageEl.textContent = rawContent;

      if (divider) {
        if (userMessageEl.parentElement !== body || userMessageEl.nextSibling !== divider) {
          body.insertBefore(userMessageEl, divider);
        }
        return;
      }

      if (userMessageEl.parentElement !== body || userMessageEl !== body.firstElementChild) {
        body.insertBefore(userMessageEl, body.firstChild);
      }
      return;
    }

    let markdownSection: DomindsMarkdownSection | null = null;
    for (const child of Array.from(body.children)) {
      if (divider && child === divider) break;
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains('user-message')) {
        child.remove();
        continue;
      }
      if (child.classList.contains('markdown-section')) {
        if (!markdownSection) {
          if (child instanceof DomindsMarkdownSection) {
            markdownSection = child;
          } else {
            const replacement = this.createMarkdownSection();
            child.replaceWith(replacement);
            markdownSection = replacement;
          }
        } else {
          child.remove();
        }
      }
    }

    if (!markdownSection) {
      markdownSection = this.createMarkdownSection();
    }
    markdownSection.setRawMarkdown(rawContent);

    if (divider) {
      if (markdownSection.parentElement !== body || markdownSection.nextSibling !== divider) {
        body.insertBefore(markdownSection, divider);
      }
      return;
    }

    if (markdownSection.parentElement !== body || markdownSection !== body.firstElementChild) {
      body.insertBefore(markdownSection, body.firstChild);
    }
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

    const body = bubble.querySelector('.bubble-body') as HTMLElement | null;
    if (!body) {
      console.warn('handleEndOfUserSaying: no bubble-body found');
      return;
    }

    // Idempotency: end_of_user_saying_evt can be replayed during course navigation.
    if (body.querySelector('.user-response-divider')) {
      this.upsertUserMessageByOrigin(body, event.content, event.origin);
      bubble.setAttribute('data-user-msg-id', event.msgId);
      bubble.setAttribute('data-raw-user-msg', event.content);
      bubble.setAttribute('data-user-msg-origin', event.origin);
      const q4hAnswerCallIds = this.normalizeQ4HAnswerCallIds(event.q4hAnswerCallIds);
      this.upsertUserAnswerCallSiteLinks(bubble, q4hAnswerCallIds);
      if (typeof event.userLanguageCode === 'string' && event.userLanguageCode.trim() !== '') {
        bubble.setAttribute('data-user-language-code', event.userLanguageCode);
      } else {
        bubble.removeAttribute('data-user-language-code');
      }
      this.removeQueuedUserBubbleIfPresent(event.msgId);
      this.scrollToBottom();
      return;
    }

    // Protocol note:
    // - `end_of_user_saying_evt` is optional and only emitted when this generation has a user-side
    //   prompt payload to render in-bubble. Tool-only turns typically do not emit it.
    // - The UI must render sections in arrival order; do not reorder the DOM to "fix" ordering.
    // If assistant-only nodes already exist when this optional event arrives, report it loudly and
    // still append the divider at the current position (arrival order).
    const assistantOnlyAlreadyStarted = body.querySelector(
      '.thinking-section, .func-call-section, .web-search-section',
    );
    if (assistantOnlyAlreadyStarted) {
      this.handleProtocolError(
        `Protocol violation: end_of_user_saying_evt received after assistant output already started (genseq=${String(
          event.genseq,
        )})`,
      );
    }

    // Add divider to separate user content from AI response
    const divider = document.createElement('hr');
    divider.className = 'user-response-divider';
    body.appendChild(divider);
    this.upsertUserMessageByOrigin(body, event.content, event.origin);
    bubble.setAttribute('data-user-msg-id', event.msgId);
    bubble.setAttribute('data-raw-user-msg', event.content);
    bubble.setAttribute('data-user-msg-origin', event.origin);
    const q4hAnswerCallIds = this.normalizeQ4HAnswerCallIds(event.q4hAnswerCallIds);
    this.upsertUserAnswerCallSiteLinks(bubble, q4hAnswerCallIds);
    if (typeof event.userLanguageCode === 'string' && event.userLanguageCode.trim() !== '') {
      bubble.setAttribute('data-user-language-code', event.userLanguageCode);
    } else {
      bubble.removeAttribute('data-user-language-code');
    }
    this.removeQueuedUserBubbleIfPresent(event.msgId);
    this.scrollToBottom();
  }

  // Create thinking section (inside generation bubble)
  private createThinkingSection(): HTMLElement {
    const t = getUiStrings(this.uiLanguage);
    const el = document.createElement('div');
    el.className = 'thinking-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon icon-mask dc-icon-brain" aria-hidden="true"></span>
        <span class="section-title">${this.escapeHtml(t.thinkingSectionTitle)}</span>
      </div>
      <div class="thinking-content"></div>
    `;
    return el;
  }

  // Create markdown section (inside generation bubble)
  private createMarkdownSection(): DomindsMarkdownSection {
    return new DomindsMarkdownSection();
  }

  // Create calling section (inside markdown section) - streaming mode for tellask call blocks
  private createCallingSection(
    callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning',
    firstMention: string,
  ): HTMLElement {
    const isFbr = callName === 'freshBootsReasoning';
    const el = document.createElement('div');
    el.className = isFbr ? 'calling-section fbr' : 'calling-section';
    el.setAttribute('data-first-mention', firstMention);
    el.setAttribute('data-call-name', callName);
    el.innerHTML = `
      <div class="calling-header">
        ${
          isFbr
            ? `<span class="calling-icon fbr-icon icon-mask dc-icon-sparkles" aria-hidden="true"></span>`
            : `<span class="calling-icon tool-icon">
                 <img src="${mannedToolIcon}" class="calling-img" alt="calling">
               </span>`
        }
        <div class="calling-meta">
          <span class="calling-headline"></span>
          <span class="calling-timing"></span>
        </div>
      </div>
      <div class="calling-content">
        <div class="calling-body"></div>
      </div>
      <div class="calling-expand-footer progressive-expand-footer is-hidden">
        <button type="button" class="calling-expand-btn progressive-expand-btn"></button>
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

    const headerEl = document.createElement('div');
    headerEl.className = 'func-call-header';

    const iconEl = document.createElement('span');
    iconEl.className = 'func-call-icon icon-mask dc-icon-bolt';
    iconEl.setAttribute('aria-hidden', 'true');

    const titleEl = document.createElement('span');
    titleEl.className = 'func-call-title';
    titleEl.textContent = `Function: ${funcName}`;

    headerEl.append(iconEl, titleEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'func-call-content';

    const argsEl = document.createElement('pre');
    argsEl.className = 'func-call-arguments';
    // SECURITY: tool/function arguments can contain arbitrary strings (including `<dominds-app>`).
    // Use `textContent` to prevent HTML/custom element interpretation.
    argsEl.textContent = argsDisplay;

    const argsWrap = document.createElement('div');
    argsWrap.className = 'func-call-arguments-wrap';
    const argsExpandFooter = document.createElement('div');
    argsExpandFooter.className =
      'func-call-arguments-expand-footer progressive-expand-footer is-hidden';
    const argsExpandBtn = document.createElement('button');
    argsExpandBtn.type = 'button';
    argsExpandBtn.className = 'func-call-arguments-expand-btn progressive-expand-btn';
    argsExpandFooter.appendChild(argsExpandBtn);
    argsWrap.append(argsEl, argsExpandFooter);

    const resultEl = document.createElement('div');
    resultEl.className = 'func-call-result';
    resultEl.style.display = 'none';
    const resultWrap = document.createElement('div');
    resultWrap.className = 'func-call-result-wrap';
    const resultExpandFooter = document.createElement('div');
    resultExpandFooter.className =
      'func-call-result-expand-footer progressive-expand-footer is-hidden';
    const resultExpandBtn = document.createElement('button');
    resultExpandBtn.type = 'button';
    resultExpandBtn.className = 'func-call-result-expand-btn progressive-expand-btn';
    resultExpandFooter.appendChild(resultExpandBtn);
    resultWrap.append(resultEl, resultExpandFooter);

    contentEl.append(argsWrap, resultWrap);
    el.append(headerEl, contentEl);
    return el;
  }

  private createWebSearchSection(): HTMLElement {
    const t = getUiStrings(this.uiLanguage);
    const el = document.createElement('div');
    el.className = 'web-search-section';
    el.innerHTML = `
      <div class="web-search-header">
        <span class="web-search-icon icon-mask dc-icon-globe" aria-hidden="true"></span>
        <span class="web-search-title">${this.escapeHtml(t.webSearchTitle)}</span>
        <span class="web-search-state">${this.escapeHtml(
          `${t.webSearchProgressPrefix}${t.webSearchPhaseStarted}`,
        )}</span>
      </div>
      <div class="web-search-summary"></div>
      <div class="web-search-details"></div>
    `;
    return el;
  }

  private handleError(err: string): void {
    if (!this.generationBubble) return;
    const el = document.createElement('div');
    el.className = 'error-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon icon-mask dc-icon-warning" aria-hidden="true"></span>
        <span class="section-title">Stream Error</span>
      </div>
      <div class="error-content">${err}</div>
    `;
    const body = this.generationBubble.querySelector('.bubble-body');
    (body || this.generationBubble).appendChild(el);
    this.scrollToBottom();
  }

  private summarizeRetryError(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length <= 240) return trimmed;
    return `${trimmed.slice(0, 240)}...`;
  }

  private describeRetryFailure(event: LlmRetryEvent): string {
    if (typeof event.status === 'number') {
      return `HTTP ${event.status}`;
    }
    if (typeof event.code === 'string' && event.code.trim() !== '') {
      return event.code.trim();
    }
    if (event.failureKind === 'retriable') {
      return this.uiLanguage === 'zh' ? '可重试错误' : 'Retriable error';
    }
    if (event.failureKind === 'rejected') {
      return this.uiLanguage === 'zh' ? '请求被拒绝' : 'Request rejected';
    }
    return this.uiLanguage === 'zh' ? '致命错误' : 'Fatal error';
  }

  private handleLlmRetry(event: LlmRetryEvent): void {
    if (event.phase === 'exhausted') {
      this.clearRetryPanel();
      return;
    }

    const failureLabel = this.describeRetryFailure(event);
    const errorText = this.summarizeRetryError(event.error);
    if (event.phase === 'waiting') {
      const backoffMs = Math.max(0, Math.floor(event.backoffMs ?? 0));
      this.retryPanelState = {
        kind: 'retry-waiting',
        genseq: event.genseq,
        attempt: event.attempt,
        totalAttempts: event.totalAttempts,
        provider: event.provider,
        failureLabel,
        error: errorText,
        nextRetryAtMs: Date.now() + backoffMs,
      };
    } else {
      this.retryPanelState = {
        kind: 'retry-running',
        genseq: event.genseq,
        attempt: event.attempt,
        totalAttempts: event.totalAttempts,
        provider: event.provider,
        failureLabel,
        error: errorText,
      };
    }
    this.emitRetryPanelStateChanged();
  }

  private clearRetryPanel(): void {
    this.retryPanelState = { kind: 'hidden' };
    this.emitRetryPanelStateChanged();
  }

  private emitRetryPanelStateChanged(): void {
    this.dispatchEvent(
      new CustomEvent<{ state: DialogViewportRetryPanelState }>('dialog-retry-panel-state', {
        detail: { state: this.retryPanelState },
        bubbles: true,
        composed: true,
      }),
    );
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

    console.error('Protocol Error', errorMessage, errorDetails);
    const el = document.createElement('div');
    el.className = 'error-section';
    el.innerHTML = `
      <div class="section-header">
        <span class="section-icon icon-mask dc-icon-error" aria-hidden="true"></span>
        <span class="section-title">Protocol Error</span>
      </div>
      <div class="error-content">${errorMessage}</div>
    `;
    container.appendChild(el);
    this.scrollToBottom();
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
    const contentHost = el.querySelector('.content');
    if (contentHost) {
      if (role === 'user') {
        const userMessageEl = document.createElement('div');
        userMessageEl.className = 'user-message';
        userMessageEl.textContent = content;
        contentHost.appendChild(userMessageEl);
      } else {
        const md = this.createMarkdownSection();
        md.setRawMarkdown(content);
        contentHost.appendChild(md);
      }
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // addMessageToDOM was removed - use direct container.appendChild() instead

  private render(): void {
    if (!this.shadowRoot) return;

    const t = getUiStrings(this.uiLanguage);
    this.shadowRoot!.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="container">
        <div class="messages"></div>
        <div id="scroll-to-bottom-wrap" class="scroll-to-bottom-wrap hidden">
          <button
            id="scroll-to-bottom-btn"
            class="scroll-to-bottom-btn"
            type="button"
            title="${t.scrollToBottom}"
            aria-label="${t.scrollToBottom}"
          >
            <span class="icon-mask dc-icon-scroll-down" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    `;
    const scrollBtn = this.shadowRoot.querySelector(
      '#scroll-to-bottom-btn',
    ) as HTMLButtonElement | null;
    if (scrollBtn) {
      scrollBtn.onclick = () => {
        this.resetAutoScrollState(true);
        this.scrollToBottom({ force: true });
      };
    }
    this.updateScrollToBottomButton();
  }

  private updateScrollToBottomButton(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const wrap = root.querySelector('#scroll-to-bottom-wrap') as HTMLElement | null;
    if (!wrap) return;
    const shouldShow = this.scrollContainer !== null && !this.isAutoScrollFollowing();
    wrap.classList.toggle('hidden', !shouldShow);
  }

  public stabilizeAutoFollowAfterViewportChange(): void {
    if (!this.isAutoScrollFollowing()) return;
    this.scheduleAutoScrollRealign();
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

  private appendDisplayStateMarker(marker: {
    kind: 'interrupted' | 'resumed';
    reason?: string;
  }): void {
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
      ${ICON_MASK_BASE_CSS}
      :host {
        display: block;
        height: 100%;
        font-size: var(--dominds-font-size-base, 14px);
        line-height: var(--dominds-line-height-base, 1.5);
      }
      .container {
        height: 100%;
        background: var(--dominds-sidebar-bg, var(--dominds-bg, var(--color-bg-primary, #ffffff)));
      }
      .messages { box-sizing: border-box; padding: 12px; }

      .scroll-to-bottom-wrap {
        position: sticky;
        bottom: 10px;
        display: flex;
        justify-content: center;
        width: 100%;
        box-sizing: border-box;
        padding: 0 12px 10px 12px;
        pointer-events: none;
        z-index: var(--dominds-z-sticky, 50);
      }

      .scroll-to-bottom-wrap.hidden {
        display: none;
      }

      .scroll-to-bottom-btn {
        pointer-events: auto;
        width: 34px;
        height: 34px;
        border-radius: 999px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        background: var(
          --dominds-sidebar-bg,
          var(--dominds-bg, var(--color-bg-secondary, #ffffff))
        );
        color: var(--dominds-fg, var(--color-fg-primary, #0f172a));
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.12);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.08s ease, background 0.15s ease, border-color 0.15s ease;
      }

      .scroll-to-bottom-btn:hover {
        border-color: color-mix(
          in srgb,
          var(--dominds-border, var(--color-border-primary, #e2e8f0)) 75%,
          black
        );
        background: color-mix(
          in srgb,
          var(--dominds-sidebar-bg, var(--dominds-bg, #ffffff)) 92%,
          black
        );
      }

      .scroll-to-bottom-btn:active {
        transform: translateY(1px);
      }

      .scroll-to-bottom-btn:focus-visible {
        outline: 2px solid
          color-mix(in srgb, var(--dominds-border, var(--color-border-primary, #e2e8f0)) 65%, black);
        outline-offset: 2px;
      }

      .scroll-to-bottom-btn .icon-mask {
        width: 18px;
        height: 18px;
      }

      .run-marker {
        padding: 2px 3px;
      }

      .system-marker {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
      }
      
      /* Message styles for tool results and other content */
      .message {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        padding: 2px 3px;
        background: var(--dominds-sidebar-bg, var(--dominds-bg, var(--color-bg-secondary, white)));
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
        gap: 8px; 
        margin-bottom: 12px; 
        padding: 2px 3px; 
        background: var(--dominds-sidebar-bg, var(--dominds-bg, var(--color-bg-secondary, white)));
        border-radius: 10px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        box-shadow: var(--shadow-sm);
        transition: all 0.2s ease;
      }
      
      .bubble-content { flex: 1; min-width: 0; }
      
      .bubble-header { 
        display: flex; 
        align-items: center; 
        justify-content: space-between; 
        margin-bottom: 8px; 
      }

      .bubble-header-right {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        padding-right: 6px;
      }

      .bubble-anchor-actions {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .bubble-anchor-actions:empty {
        display: none;
      }

      .bubble-share-link-btn,
      .bubble-fork-btn {
        width: 22px;
        height: 22px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .bubble-share-link-btn:hover,
      .bubble-fork-btn:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #e2e8f0));
        border-color: var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      .bubble-share-link-btn:focus-visible,
      .bubble-fork-btn:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
        outline-offset: 2px;
      }

      .bubble-anchor-assignment-btn,
      .bubble-anchor-caller-callsite-btn {
        width: 22px;
        height: 22px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .bubble-anchor-assignment-btn:hover,
      .bubble-anchor-caller-callsite-btn:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #e2e8f0));
        border-color: var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      .bubble-anchor-assignment-btn:focus-visible,
      .bubble-anchor-caller-callsite-btn:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
        outline-offset: 2px;
      }
      
      .bubble-author { 
        font-weight: 600; 
        color: var(--dominds-fg, var(--color-fg-primary, #333)); 
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }

      .bubble-author-name {
        font-size: 10px;
      }

      .bubble-author-model {
        font-size: 8px;
        font-weight: 500;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
      }

      .bubble-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1 1 auto;
      }

      .title-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
        width: 100%;
      }

      .title-left {
        display: flex;
        align-items: baseline;
        gap: 5px;
        flex-wrap: wrap;
        min-width: 0;
      }

      .bubble-title-actions {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }

      .title-right {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .callsite-icon-btn {
        width: 22px;
        height: 22px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .callsite-icon-btn:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #e2e8f0));
        border-color: var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      .callsite-icon-btn:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
        outline-offset: 2px;
      }

      .bubble-share-link-btn .icon-mask,
      .bubble-fork-btn .icon-mask,
      .bubble-anchor-assignment-btn .icon-mask,
      .bubble-anchor-caller-callsite-btn .icon-mask,
      .callsite-icon-btn .icon-mask {
        width: 14px;
        height: 14px;
      }

      .call-context {
        font-size: var(--dominds-font-size-xs, 11px);
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
      }
      
      .bubble-header { 
        font-size: var(--dominds-font-size-sm, 12px); 
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); 
        margin-left: 8px;
      }
      
      .generation-bubble.completed {
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      /* Breathing glow animation for generation bubble */
      .generation-bubble.generating {
        animation: breath-glow 3s ease-in-out infinite;
        border: 2px solid transparent;
      }

	      .generation-bubble.highlighted {
	        animation: highlight-pulse 1s ease-in-out 0s 5;
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
        gap: 4px;
        line-height: 1.35;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        width: 100%;
        max-width: 100%;
        overflow: hidden;
      }

      /* User message and divider styles */
      .user-message {
        font-family: inherit;
        font-weight: 400;
        font-size: 12px;
        line-height: 1.35;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        margin: 0;
        padding: 2px 3px 2px 6px;
        width: 100%;
        height: auto;
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        overflow: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: anywhere;
        box-sizing: border-box;
        min-width: 0;
        display: block;
      }

      .user-response-divider {
        border: none;
        border-top: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        margin: 6px 0;
      }

      .user-answer-callsite-actions {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
      }

      .user-answer-callsite-link-btn {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #d1d5db));
        background: var(--color-bg-secondary, #ffffff);
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
        border-radius: 999px;
        min-width: 26px;
        height: 22px;
        padding: 0 8px;
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 20px;
        cursor: pointer;
      }

      .user-answer-callsite-link-btn:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
      }

      .user-answer-callsite-link-btn:focus-visible {
        outline: 2px solid var(--dominds-primary, var(--color-accent-primary, #007acc));
        outline-offset: 1px;
      }

      /* Section styles (thinking, markdown) */
      .thinking-section, .markdown-section {
        margin-bottom: 0; /* bubble-body gap provides spacing */
        padding: 2px 3px 2px 6px;
        border-radius: 6px; 
        background: var(--dominds-thinking-bg, var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9)));
        border-left: 3px solid var(--dominds-primary, var(--color-accent-primary, #007acc)); 
        display: block;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        overflow: hidden;
        font-size: var(--dominds-font-size-md, 11px);
      }
      
      .markdown-section {
        border-left-color: transparent;
        background: transparent;
      }

      .markdown-content {
        font-size: var(--dominds-font-size-md, 11px);
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
        word-wrap: break-word;
        line-height: var(--dominds-line-height-dense, 1.4);
      }

      .markdown-content p {
        margin-top: 0;
        margin-bottom: 0.4em;
      }

      .markdown-content p:last-child {
        margin-bottom: 0;
      }

      .markdown-content ul, .markdown-content ol {
        margin-top: 0;
        margin-bottom: 0.4em;
        padding-left: 1.35em;
      }

      .markdown-content li {
        margin-bottom: 0.25em;
      }

      .markdown-content h1, .markdown-content h2, .markdown-content h3, 
      .markdown-content h4, .markdown-content h5, .markdown-content h6 {
        margin-top: 0.5em;
        margin-bottom: 0.16em;
        font-weight: 600;
        line-height: var(--dominds-line-height-dense, 1.4);
        color: var(--dominds-fg-primary, var(--color-fg-primary, #1e293b));
      }

      .markdown-content h1 { font-size: calc(var(--dominds-font-size-base, 14px) + 1px); }
      .markdown-content h2 { font-size: var(--dominds-font-size-base, 14px); }
      .markdown-content h3 { font-size: var(--dominds-font-size-base, 14px); }
      .markdown-content h4 { font-size: var(--dominds-font-size-md, 13px); }
      .markdown-content h5 { font-size: var(--dominds-font-size-sm, 12px); }
      .markdown-content h6 { font-size: var(--dominds-font-size-xs, 11px); }

      .markdown-content h1:first-child, .markdown-content h2:first-child, .markdown-content h3:first-child {
        margin-top: 0;
      }

      .markdown-content blockquote {
        margin: 0 0 0.5em 0;
        padding: 0 0.45em;
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-fg-muted, var(--color-fg-muted, #64748b));
        border-left: 0.25em solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
      }

      .markdown-content code:not([class]) {
        background-color: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
        padding: 0.1em 0.25em;
        border-radius: 4px;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
        font-size: 90%;
      }

      .markdown-content table {
        border-collapse: collapse;
        width: 100%;
        margin-bottom: 0.5em;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        padding: 2px 4px;
      }

      .markdown-content tr:nth-child(2n) {
        background-color: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
      }

      .section-header { 
        display: flex; 
        align-items: center; 
        gap: 6px; 
        margin-bottom: 6px; 
      }
      
      .section-icon { 
        width: 13px;
        height: 13px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      
      .section-title { 
        font-weight: 600; 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        font-size: var(--dominds-font-size-md, 13px); 
      }
      
      .thinking-content, .markdown-text-block { 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        white-space: pre-wrap; 
        word-wrap: break-word;
        margin-bottom: 3px;
      }

      .thinking-content,
      .markdown-text-block,
      .markdown-content,
      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4,
      .markdown-content h5,
      .markdown-content h6 {
        transition: text-shadow 0.22s ease;
      }

      .generation-bubble.generating .section-title,
      .generation-bubble.generating .thinking-content,
      .generation-bubble.generating .markdown-text-block,
      .generation-bubble.generating .markdown-content,
      .generation-bubble.generating .markdown-content h1,
      .generation-bubble.generating .markdown-content h2,
      .generation-bubble.generating .markdown-content h3,
      .generation-bubble.generating .markdown-content h4,
      .generation-bubble.generating .markdown-content h5,
      .generation-bubble.generating .markdown-content h6 {
        text-shadow: 0 0 8px
          color-mix(
            in srgb,
            var(--dominds-fg, #ffffff) 35%,
            transparent
          );
      }

      .generation-bubble.completed .section-title,
      .generation-bubble.completed .thinking-content,
      .generation-bubble.completed .markdown-text-block,
      .generation-bubble.completed .markdown-content {
        text-shadow: none;
      }

      .generation-bubble.completed .markdown-content h1,
      .generation-bubble.completed .markdown-content h2,
      .generation-bubble.completed .markdown-content h3,
      .generation-bubble.completed .markdown-content h4,
      .generation-bubble.completed .markdown-content h5,
      .generation-bubble.completed .markdown-content h6 {
        text-shadow: none;
      }
      
      .markdown-text-block:last-child {
        margin-bottom: 0;
      }

      /* Calling section styles (nested inside markdown) */
	      .calling-section { 
	        margin: 4px 0; 
	        padding: 2px 3px 2px 6px;
	        border-radius: 6px; 
	        background: var(--color-bg-tertiary, #f1f5f9); 
	        border-left: 3px solid var(--color-info, #06b6d4);
	        box-sizing: border-box;
	        max-width: 100%;
	      }

        .calling-section.fbr {
          border-left-color: var(--dominds-primary, var(--color-accent-primary, #007acc));
          background: var(
            --dominds-calling-fbr-bg,
            color-mix(in srgb, var(--dominds-primary, #007acc) 8%, var(--color-bg-tertiary, #f1f5f9))
          );
        }
      
      .calling-header {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin-bottom: 3px;
      }

      .calling-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .calling-icon {
        display: flex;
        align-items: center;
      }

      .calling-icon.fbr-icon {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .calling-img {
        width: 22px;
        height: 22px;
        color: var(--color-info, #06b6d4);
      }

      .calling-icon.tool-icon .calling-img {
        width: 24px;
        height: 24px;
        color: var(--color-info, #06b6d4);
      }

      .calling-icon.teammate-icon .calling-img {
        width: 20px;
        height: 20px;
        color: var(--dominds-primary, #007acc);
      }

      .calling-headline {
        font-weight: 600;
        color: var(--color-info, #06b6d4);
        font-size: var(--dominds-font-size-sm, 12px);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .calling-section.fbr .calling-headline {
        color: var(--dominds-primary, var(--color-accent-primary, #007acc));
      }

      .calling-timing {
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1.35;
        white-space: pre-wrap;
      }

      .subdialog-arrow {
        color: var(--color-info, #06b6d4);
        font-size: var(--dominds-font-size-sm, 12px);
        font-weight: 500;
      }

      .calling-content {
        margin-left: 3px;
        max-height: none;
        overflow: visible;
      }

      .calling-body {
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.35;
      }

      .calling-section.fbr .calling-body {
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      .progressive-expand-footer {
        margin-top: 2px;
        padding-top: 2px;
        border-top: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        display: flex;
        justify-content: center;
      }

      .progressive-expand-footer.is-hidden {
        display: none;
      }

      .progressive-expand-btn {
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        background: var(--color-bg-secondary, #ffffff);
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
        border-radius: 999px;
        width: 26px;
        height: 22px;
        padding: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .progressive-expand-btn:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #f1f5f9));
      }

      .progressive-expand-btn:focus-visible {
        outline: 2px solid var(--dominds-primary, var(--color-accent-primary, #007acc));
        outline-offset: 1px;
      }

      .progressive-expand-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        animation: progressive-expand-flash 2.2s ease-in-out infinite;
        width: 14px;
        height: 14px;
        --icon-mask: ${ICON_MASK_URLS.chevronsDown};
      }

      .progressive-expand-btn:hover .progressive-expand-icon,
      .progressive-expand-btn:focus-visible .progressive-expand-icon {
        animation-play-state: paused;
      }

      .dc-icon-crosshair {
        --icon-mask: ${ICON_MASK_URLS.crosshair};
      }

      .dc-icon-brain {
        --icon-mask: ${ICON_MASK_URLS.brain};
      }

      .dc-icon-sparkles {
        --icon-mask: ${ICON_MASK_URLS.sparkles};
      }

      .dc-icon-bolt {
        --icon-mask: ${ICON_MASK_URLS.bolt};
      }

      .dc-icon-globe {
        --icon-mask: ${ICON_MASK_URLS.globe};
      }

      .dc-icon-warning {
        --icon-mask: ${ICON_MASK_URLS.warning};
      }

      .dc-icon-refresh {
        --icon-mask: ${ICON_MASK_URLS.refresh};
      }

      .dc-icon-error {
        --icon-mask: ${ICON_MASK_URLS.error};
      }

      .dc-icon-copy {
        --icon-mask: ${ICON_MASK_URLS.copy};
      }

      .dc-icon-fork {
        --icon-mask: ${ICON_MASK_URLS.fork};
      }

      .dc-icon-check-circle {
        --icon-mask: ${ICON_MASK_URLS.checkCircle};
      }

      .dc-icon-external {
        --icon-mask: ${ICON_MASK_URLS.external};
      }

      .dc-icon-link {
        --icon-mask: ${ICON_MASK_URLS.link};
      }

      .dc-icon-scroll-down {
        --icon-mask: ${ICON_MASK_URLS.scrollDown};
      }

      @keyframes progressive-expand-flash {
        0%,
        72%,
        100% {
          transform: translateY(0);
        }
        82% {
          transform: translateY(0.5px);
        }
      }

      .calling-expand-footer {
        margin-left: 3px;
      }

      .func-call-arguments-expand-footer,
      .func-call-result-expand-footer,
      .teammate-expand-footer {
        margin-left: 0;
      }

      .calling-section.failed {
        border-left-color: var(--color-danger, #ef4444);
        background: rgba(239, 68, 68, 0.08);
      }

      .calling-section.carried-over {
        border-left-color: var(--color-warning, #f59e0b);
        background: color-mix(
          in srgb,
          var(--color-warning, #f59e0b) 10%,
          var(--color-bg-tertiary, #f1f5f9)
        );
      }

      .calling-section.carried-over.failed {
        border-left-color: var(--color-danger, #ef4444);
        background: color-mix(
          in srgb,
          var(--color-danger, #ef4444) 10%,
          var(--color-bg-tertiary, #f1f5f9)
        );
      }

      /* Function call section styles (nested inside markdown) - non-streaming mode */
      .func-call-section {
        margin: 4px 0;
        padding: 2px 3px 2px 6px;
        border-radius: 6px;
        background: var(--color-bg-tertiary, #f1f5f9);
        border-left: 3px solid var(--color-func-call, var(--color-warning, #f59e0b));
      }

      .func-call-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
      }

      .func-call-icon {
        width: 14px;
        height: 14px;
      }

      .func-call-title {
        font-weight: 600;
        color: var(--color-func-call, var(--color-warning, #f59e0b));
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .func-call-content {
        margin-left: 0;
      }

      .func-call-arguments-wrap {
        margin: 0;
      }

      .func-call-arguments {
        margin: 0;
        padding: 2px 3px;
        border-radius: 4px;
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        font-size: var(--dominds-font-size-xs, 11px);
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
        overflow-x: auto;
        color: var(--dominds-fg, var(--color-fg-secondary, #475569));
      }

      .func-call-result-wrap {
        margin-top: 3px;
      }

      .func-call-result {
        margin-top: 0;
        padding: 2px 3px;
        border-radius: 6px;
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.4;
        white-space: normal;
        max-height: none;
        overflow: visible;
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

      .web-search-section {
        margin: 4px 0;
        padding: 2px 3px 2px 6px;
        border-radius: 6px;
        background: var(--color-bg-tertiary, #f1f5f9);
        border-left: 3px solid var(--color-info, #06b6d4);
      }

      .web-search-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
      }

      .web-search-icon {
        width: 14px;
        height: 14px;
      }

      .web-search-title {
        font-weight: 600;
        color: var(--color-info, #06b6d4);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .web-search-state {
        border-radius: 999px;
        padding: 1px 8px;
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1.4;
        margin-left: auto;
        background: color-mix(in srgb, var(--color-info, #06b6d4) 14%, transparent);
        color: var(--color-info, #06b6d4);
      }

      .web-search-state.is-completed {
        background: color-mix(in srgb, var(--color-success, #10b981) 14%, transparent);
        color: var(--color-success, #10b981);
      }

      .web-search-state.is-failed {
        background: color-mix(in srgb, var(--color-danger, #ef4444) 14%, transparent);
        color: var(--color-danger, #ef4444);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
      }

      .web-search-summary {
        padding: 2px 3px;
        border-radius: 6px;
        background: var(--color-bg-secondary, #ffffff);
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        font-size: var(--dominds-font-size-sm, 12px);
        font-weight: 600;
        line-height: 1.45;
        margin-bottom: 3px;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .web-search-summary.is-empty {
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        font-weight: 500;
        font-style: italic;
      }

      .web-search-details {
        margin: 0;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        font-size: var(--dominds-font-size-xs, 11px);
        line-height: 1.35;
        white-space: normal;
        word-break: break-word;
        overflow-wrap: anywhere;
        font-family: inherit;
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
        padding: 2px 3px; 
        background: var(--color-bg-tertiary, #f1f5f9); 
        border-bottom: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
      }
      
      .codeblock-icon { 
        font-size: var(--dominds-font-size-base, 14px); 
      }
      
      .codeblock-title { 
        font-weight: 500; 
        color: var(--dominds-fg, var(--color-fg-secondary, #475569)); 
        font-size: var(--dominds-font-size-md, 13px); 
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
        font-size: var(--dominds-font-size-sm, 12px);
        cursor: pointer;
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        transition: all 0.2s ease;
      }
      
      .codeblock-action:hover {
        background: var(--dominds-hover, var(--color-bg-tertiary, #e2e8f0));
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }

      .codeblock-action .icon-mask {
        width: 12px;
        height: 12px;
      }
      
      .codeblock-wrapper { background: transparent; }
      .codeblock-wrapper pre { margin: 0; background: var(--color-bg-primary, #ffffff); }
      .codeblock-wrapper pre > code.codeblock-content {
        display: block;
        padding: 2px 3px;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: var(--dominds-font-size-sm, 12px);
        line-height: 1.4;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        white-space: pre;
        overflow-x: auto;
        tab-size: 2;
        background: transparent;
      }

      /* Content area styles */
      .content-area { flex: 1; min-width: 0; }
      .content-area .bubble-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        padding-right: 6px;
      }
      .bubble-header .timestamp { margin-top: 0; }
      .content-area .author {
        font-weight: 600;
        font-size: var(--dominds-font-size-md, 13px);
        color: var(--dominds-fg, var(--color-fg-primary, #333));
      }
      .content-area .timestamp {
        font-size: var(--dominds-font-size-sm, 12px);
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b));
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
      }
      .content { 
        font-size: var(--dominds-font-size-base, 14px);
        line-height: var(--dominds-line-height-dense, 1.4); 
        color: var(--dominds-fg, var(--color-fg-primary, #333)); 
        white-space: pre-wrap; 
        word-wrap: break-word;
      }
      .status { font-size: var(--dominds-font-size-sm, 12px); color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); margin-top: 4px; font-style: italic; }
      .timestamp { 
        font-size: var(--dominds-font-size-sm, 12px); 
        color: var(--dominds-muted, var(--color-fg-tertiary, #64748b)); 
        margin-top: 4px; 
        font-family: var(
          --font-mono,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          "Liberation Mono",
          "Courier New",
          monospace
        );
      }
      /* Removed welcome placeholder to avoid initial blank height issues */
      
      /* Responsive design */
      @media (max-width: 768px) {
        .messages { padding: 10px; }
        .message { margin-bottom: 10px; padding: 2px 3px; }
        .generation-bubble { margin-bottom: 10px; padding: 2px 3px; }
        .avatar { width: 28px; height: 28px; }
        .bubble-avatar { width: 32px; height: 32px; }
        .author { font-size: var(--dominds-font-size-md, 13px); }
        .content { font-size: var(--dominds-font-size-base, 14px); }
        .status, .timestamp { font-size: var(--dominds-font-size-sm, 12px); }
        .section-title { font-size: var(--dominds-font-size-md, 13px); }
        .calling-headline, .calling-body { font-size: var(--dominds-font-size-sm, 12px); }
      }

      /* Teammate bubble styles */
      .message.teammate {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        padding: 2px 3px;
        background: var(--color-bg-secondary, #f7fafc);
        border-radius: 10px;
        border: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        border-left: 3px solid color-mix(in srgb, var(--dominds-primary, #007acc) 78%, transparent);
      }

      .author-name {
        font-weight: 600;
        color: var(--dominds-primary, #007acc);
      }

      .requester-name {
        color: var(--dominds-fg-secondary, var(--color-fg-secondary, #475569));
      }

      .response-arrow {
        color: var(--dominds-text-secondary, #64748b);
      }

      .teammate-session-slug {
        color: var(--dominds-text-secondary, #64748b);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .teammate-content {
        margin-top: 3px;
        color: var(--dominds-fg, var(--color-fg-primary, #333));
        line-height: 1.35;
      }

      .message.teammate.fbr .teammate-content,
      .message.teammate.fbr .markdown-content {
        color: var(--dominds-fg-secondary, var(--color-fg-secondary, #475569));
        font-size: var(--dominds-font-size-md, 11px);
      }

      .message.teammate.fbr .markdown-content h1,
      .message.teammate.fbr .markdown-content h2,
      .message.teammate.fbr .markdown-content h3,
      .message.teammate.fbr .markdown-content h4,
      .message.teammate.fbr .markdown-content h5,
      .message.teammate.fbr .markdown-content h6 {
        color: var(--dominds-fg-secondary, var(--color-fg-secondary, #475569));
        font-size: var(--dominds-font-size-md, 11px);
      }

      .message.teammate.fbr .teammate-headline {
        font-size: var(--dominds-font-size-md, 11px);
      }

      .teammate-headline {
        margin: 0 0 3px 0;
        padding-left: 4px;
        border-left: 3px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        color: var(--dominds-text-secondary, #475569);
        font-size: var(--dominds-font-size-sm, 12px);
      }

      .teammate-response-divider {
        border: 0;
        border-top: 1px solid var(--dominds-border, var(--color-border-primary, #e2e8f0));
        margin: 3px 0;
      }

	      /* Highlight animation for call site navigation */
	      .generation-bubble.highlighted,
	      .message.teammate.highlighted {
	        outline: 2px solid color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
	        outline-offset: 2px;
	      }

	      /* Call-site highlight should not be clipped by parent overflow; keep it inside the element. */
	      .calling-section.highlighted {
	        outline: none;
	        animation: highlight-inset-pulse 1s ease-in-out 0s 5;
	      }

	      .calling-section.highlighted {
	        /* defined above */
	      }

	      .message.teammate.highlighted {
	        animation: highlight-pulse 1s ease-in-out 0s 5;
	      }

	      @keyframes highlight-inset-pulse {
	        0%,
	        100% {
	          box-shadow: inset 0 0 0 2px
	            color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
	        }
	        50% {
	          box-shadow: inset 0 0 0 5px transparent;
	        }
	      }

	      @keyframes highlight-pulse {
	        0%, 100% {
	          box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-primary, #007acc) 55%, transparent);
	        }
	        50% {
	          box-shadow: 0 0 0 14px transparent;
	        }
	      }

    `;
  }

  private scrollToBottom(options?: { force?: boolean }): void {
    // Scroll the parent element (.conversation-scroll-area) which has overflow-y: auto
    this.ensureScrollContainerListener();
    const scrollContainer = this.scrollContainer;
    if (!scrollContainer) return;
    // Default behavior: do not "steal" scroll unless the user is already at the bottom.
    // When the user explicitly clicks the jump button, we force the scroll.
    const forceScroll = options !== undefined && options.force === true;
    if (!forceScroll) {
      if (!this.isAutoScrollFollowing()) return;
    }

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
