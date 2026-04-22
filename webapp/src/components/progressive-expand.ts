import { dispatchDomindsEvent } from './dom-events';

export const PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX = 120;
export const PROGRESSIVE_EXPAND_STEP_PARENT_RATIO = 1 / 3;
export const PROGRESSIVE_EXPAND_STEP_PARENT_ATTR = 'data-progressive-expand-step-parent';
const PROGRESSIVE_EXPAND_CLICK_COMMIT_DELAY_MS = 220;
const PROGRESSIVE_EXPAND_OVERFLOW_OBSERVER_SLACK_PX = 1;

export type ProgressiveExpandState =
  | { kind: 'initial' }
  | { kind: 'partial'; maxHeightPx: number }
  | { kind: 'full' };

type ProgressiveExpandableComponentOptions = Readonly<{
  target: HTMLElement;
  footer: HTMLElement;
  button: HTMLButtonElement;
  stepParent?: HTMLElement | null;
  label: Readonly<{ text: string; title: string }>;
  state?: ProgressiveExpandState;
  observeTargetUntilOverflow?: boolean;
  onStateChange?: (state: ProgressiveExpandState) => void;
  onAfterExpand?: () => void;
}>;

function sameProgressiveExpandState(
  left: ProgressiveExpandState,
  right: ProgressiveExpandState,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== 'partial' || right.kind !== 'partial') return true;
  return left.maxHeightPx === right.maxHeightPx;
}

export function resolveProgressiveExpandStepParent(target: HTMLElement): HTMLElement | null {
  // UI sizing principle:
  // Expansion step sizing must come from an explicitly designated parent, never from whichever
  // scroll container happens to be closest today. Containers opt into this contract by marking
  // themselves with PROGRESSIVE_EXPAND_STEP_PARENT_ATTR.
  return target.closest(`[${PROGRESSIVE_EXPAND_STEP_PARENT_ATTR}="true"]`);
}

export function computeProgressiveExpandStepPx(parent: HTMLElement | null): number {
  // UI sizing principle:
  // Use the height of the explicit parent whose size the human intentionally controls.
  // We do not infer "nearest scroll container" here because that can create accidental UX rules.
  // Examples:
  // - Main dialog content uses the dialog scroll container, whose height changes with browser
  //   window resizing.
  // - Reminder content uses the reminders widget content area, whose height is set by directly
  //   dragging the widget size.
  const parentHeight = parent?.clientHeight ?? 0;
  // If no explicit step parent is provided, fall back to viewport height. This keeps the default
  // rule explicit and global, rather than guessing whichever ancestor currently scrolls.
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  const referenceHeight =
    parentHeight > 0
      ? parentHeight
      : viewportHeight > 0
        ? viewportHeight
        : PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX;
  return Math.max(1, Math.floor(referenceHeight * PROGRESSIVE_EXPAND_STEP_PARENT_RATIO));
}

export function getProgressiveExpandLabel(language: string): Readonly<{
  text: string;
  title: string;
}> {
  return language === 'zh'
    ? { text: '展开更多', title: '展开更多' }
    : { text: 'Show more', title: 'Show more' };
}

export class ProgressiveExpandableComponent {
  private readonly target: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly stepParent: HTMLElement | null;
  private readonly label: Readonly<{ text: string; title: string }>;
  private readonly observeTargetUntilOverflow: boolean;
  private readonly onStateChange?: (state: ProgressiveExpandState) => void;
  private readonly onAfterExpand?: () => void;
  private currentState: ProgressiveExpandState;
  private overflowObserver: ResizeObserver | null = null;
  private pendingClickCommitTimeout: number | null = null;

  private readonly boundOnNestedGrowth = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    if (event.type !== 'progressive-expand-content-grown') return;
    if (event.target === this.target) return;
    if (this.currentState.kind === 'full') return;
    requestAnimationFrame(() => {
      this.refreshExpandFooter();
    });
  };

  private readonly boundOnClick = (event: MouseEvent): void => {
    this.cancelPendingClickCommit();
    if (event.detail >= 3) {
      this.autoExpandFromNowOn();
      this.queueAfterExpansionEffects();
      return;
    }

    const clickAction =
      event.detail <= 1 ? () => this.expandOneStep() : () => this.expandToCurrentMaximum();
    this.pendingClickCommitTimeout = window.setTimeout(() => {
      this.pendingClickCommitTimeout = null;
      clickAction();
    }, PROGRESSIVE_EXPAND_CLICK_COMMIT_DELAY_MS);
  };

  private expandOneStep(): void {
    if (this.currentState.kind === 'full') {
      return;
    }
    const stepPx = computeProgressiveExpandStepPx(this.stepParent);
    const currentMaxHeightPx =
      this.currentState.kind === 'partial'
        ? Math.max(this.currentState.maxHeightPx, this.target.clientHeight)
        : Math.max(this.target.clientHeight, PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX);
    const nextMaxHeightPx = currentMaxHeightPx + stepPx;
    this.collapseToHeight(nextMaxHeightPx);
    this.updateState({ kind: 'partial', maxHeightPx: nextMaxHeightPx });
    this.queueAfterExpansionEffects();
  }

  constructor(options: ProgressiveExpandableComponentOptions) {
    this.target = options.target;
    this.footer = options.footer;
    this.button = options.button;
    this.stepParent = options.stepParent ?? null;
    this.label = options.label;
    this.observeTargetUntilOverflow = options.observeTargetUntilOverflow === true;
    this.onStateChange = options.onStateChange;
    this.onAfterExpand = options.onAfterExpand;
    this.currentState = options.state ?? { kind: 'initial' };

    this.button.setAttribute('aria-label', this.label.text);
    this.button.title = this.label.title;
    this.button.addEventListener('click', this.boundOnClick);
    this.target.addEventListener(
      'progressive-expand-content-grown',
      this.boundOnNestedGrowth as EventListener,
    );

    this.applyCurrentState();
    this.attachOverflowObserverIfNeeded();
    this.refreshExpandFooter();
    requestAnimationFrame(() => {
      this.refreshExpandFooter();
    });
  }

  public cleanup(): void {
    this.cancelPendingClickCommit();
    this.disconnectOverflowObserver();
    this.button.removeEventListener('click', this.boundOnClick);
    this.target.removeEventListener(
      'progressive-expand-content-grown',
      this.boundOnNestedGrowth as EventListener,
    );
  }

  private emitContentGrown(reason: 'expand-step' | 'content-growth'): void {
    dispatchDomindsEvent(
      this.target,
      'progressive-expand-content-grown',
      { reason },
      { bubbles: true, composed: true },
    );
  }

  private updateState(nextState: ProgressiveExpandState): void {
    if (sameProgressiveExpandState(this.currentState, nextState)) return;
    this.currentState = nextState;
    this.onStateChange?.(nextState);
  }

  private collapseToHeight(heightPx: number): void {
    this.target.style.maxHeight = `${Math.max(PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX, heightPx)}px`;
    this.target.style.overflowY = 'hidden';
  }

  private cancelPendingClickCommit(): void {
    if (this.pendingClickCommitTimeout === null) return;
    window.clearTimeout(this.pendingClickCommitTimeout);
    this.pendingClickCommitTimeout = null;
  }

  private collapseToInitial(): void {
    this.collapseToHeight(PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX);
  }

  private showCurrentContentFully(): void {
    this.target.style.maxHeight = 'none';
    this.target.style.overflowY = 'visible';
  }

  private measureFooterLayoutHeightPx(): number {
    const wasHidden = this.footer.classList.contains('is-hidden');
    const previousVisibility = this.footer.style.visibility;
    const previousPointerEvents = this.footer.style.pointerEvents;
    if (wasHidden) {
      this.footer.style.visibility = 'hidden';
      this.footer.style.pointerEvents = 'none';
      this.footer.classList.remove('is-hidden');
    }
    const heightPx = Math.max(0, Math.ceil(this.footer.offsetHeight));
    if (wasHidden) {
      this.footer.classList.add('is-hidden');
      this.footer.style.visibility = previousVisibility;
      this.footer.style.pointerEvents = previousPointerEvents;
    }
    return heightPx;
  }

  private shouldShowExpandFooter(visibleTargetHeightPx: number): boolean {
    const hiddenContentHeightPx = this.target.scrollHeight - visibleTargetHeightPx;
    if (hiddenContentHeightPx <= PROGRESSIVE_EXPAND_OVERFLOW_OBSERVER_SLACK_PX) return false;
    return (
      hiddenContentHeightPx >
      this.measureFooterLayoutHeightPx() + PROGRESSIVE_EXPAND_OVERFLOW_OBSERVER_SLACK_PX
    );
  }

  private disconnectOverflowObserver(): void {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
  }

  private autoExpandFromNowOn(): void {
    this.showCurrentContentFully();
    this.footer.classList.add('is-hidden');
    this.disconnectOverflowObserver();
    this.updateState({ kind: 'full' });
  }

  private expandToCurrentMaximum(): void {
    if (this.currentState.kind === 'full') {
      return;
    }
    const currentMaxHeightPx = Math.max(
      this.target.scrollHeight + PROGRESSIVE_EXPAND_OVERFLOW_OBSERVER_SLACK_PX,
      this.target.clientHeight,
      PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX,
    );
    this.collapseToHeight(currentMaxHeightPx);
    this.updateState({ kind: 'partial', maxHeightPx: currentMaxHeightPx });
    this.queueAfterExpansionEffects();
  }

  private queueAfterExpansionEffects(): void {
    requestAnimationFrame(() => {
      if (!this.target.isConnected) return;
      this.refreshExpandFooter();
      this.emitContentGrown('expand-step');
      this.onAfterExpand?.();
    });
  }

  private applyCurrentState(): void {
    switch (this.currentState.kind) {
      case 'initial':
        this.collapseToInitial();
        return;
      case 'partial':
        this.collapseToHeight(this.currentState.maxHeightPx);
        return;
      case 'full':
        this.autoExpandFromNowOn();
        return;
    }
  }

  private attachOverflowObserverIfNeeded(): void {
    if (
      !this.observeTargetUntilOverflow ||
      this.currentState.kind === 'full' ||
      typeof ResizeObserver === 'undefined'
    ) {
      this.disconnectOverflowObserver();
      return;
    }
    if (this.overflowObserver !== null) return;
    this.overflowObserver = new ResizeObserver(() => {
      this.refreshExpandFooter();
      this.emitContentGrown('content-growth');
    });
    this.overflowObserver.observe(this.target);
  }

  private refreshExpandFooter(): void {
    if (!this.target.isConnected) return;
    if (this.currentState.kind === 'initial') {
      if (this.shouldShowExpandFooter(PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX)) {
        this.collapseToInitial();
        this.footer.classList.remove('is-hidden');
        this.disconnectOverflowObserver();
        return;
      }
      this.footer.classList.add('is-hidden');
      this.showCurrentContentFully();
      this.attachOverflowObserverIfNeeded();
      return;
    }
    if (this.currentState.kind === 'full') {
      this.showCurrentContentFully();
      this.footer.classList.add('is-hidden');
      return;
    }
    if (this.shouldShowExpandFooter(this.target.clientHeight)) {
      this.footer.classList.remove('is-hidden');
      this.disconnectOverflowObserver();
      return;
    }
    this.footer.classList.add('is-hidden');
    this.ensurePartialOverflowObserverSlack();
    this.attachOverflowObserverIfNeeded();
  }

  private ensurePartialOverflowObserverSlack(): void {
    if (this.currentState.kind !== 'partial') return;
    const nextMaxHeightPx = Math.max(
      this.currentState.maxHeightPx,
      this.target.scrollHeight + PROGRESSIVE_EXPAND_OVERFLOW_OBSERVER_SLACK_PX,
    );
    if (nextMaxHeightPx === this.currentState.maxHeightPx) return;
    this.collapseToHeight(nextMaxHeightPx);
    this.updateState({ kind: 'partial', maxHeightPx: nextMaxHeightPx });
  }
}

export function setupProgressiveExpandBehavior(
  options: ProgressiveExpandableComponentOptions,
): () => void {
  const component = new ProgressiveExpandableComponent(options);
  return () => {
    component.cleanup();
  };
}
