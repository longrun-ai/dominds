import { dispatchDomindsEvent } from './dom-events';

export const PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX = 120;
export const PROGRESSIVE_EXPAND_STEP_PARENT_RATIO = 1 / 3;
export const PROGRESSIVE_EXPAND_STEP_PARENT_ATTR = 'data-progressive-expand-step-parent';

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
  onAfterExpandStep?: () => void;
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
  private readonly onAfterExpandStep?: () => void;
  private currentState: ProgressiveExpandState;
  private overflowObserver: ResizeObserver | null = null;

  private readonly boundOnNestedGrowth = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    if (event.type !== 'progressive-expand-content-grown') return;
    if (event.target === this.target) return;
    if (this.currentState.kind === 'full') return;
    requestAnimationFrame(() => {
      this.refreshExpandFooter();
    });
  };

  private readonly boundOnClick = (): void => {
    const stepPx = computeProgressiveExpandStepPx(this.stepParent);
    const currentMaxHeightPx =
      this.currentState.kind === 'partial'
        ? Math.max(this.currentState.maxHeightPx, this.target.clientHeight)
        : Math.max(this.target.clientHeight, PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX);
    const nextMaxHeightPx = currentMaxHeightPx + stepPx;
    this.collapseToHeight(nextMaxHeightPx);
    this.updateState({ kind: 'partial', maxHeightPx: nextMaxHeightPx });
    requestAnimationFrame(() => {
      this.refreshExpandFooter();
      this.emitContentGrown('expand-step');
      this.onAfterExpandStep?.();
    });
  };

  constructor(options: ProgressiveExpandableComponentOptions) {
    this.target = options.target;
    this.footer = options.footer;
    this.button = options.button;
    this.stepParent = options.stepParent ?? null;
    this.label = options.label;
    this.observeTargetUntilOverflow = options.observeTargetUntilOverflow === true;
    this.onStateChange = options.onStateChange;
    this.onAfterExpandStep = options.onAfterExpandStep;
    this.currentState = options.state ?? { kind: 'initial' };

    this.button.setAttribute('aria-label', this.label.text);
    this.button.title = this.label.title;
    this.button.onclick = this.boundOnClick;
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
    this.disconnectOverflowObserver();
    this.button.onclick = null;
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

  private collapseToInitial(): void {
    this.collapseToHeight(PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX);
  }

  private showCurrentContentFully(): void {
    this.target.style.maxHeight = 'none';
    this.target.style.overflowY = 'visible';
  }

  private disconnectOverflowObserver(): void {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
  }

  private expandFully(): void {
    this.showCurrentContentFully();
    this.footer.classList.add('is-hidden');
    this.disconnectOverflowObserver();
    this.updateState({ kind: 'full' });
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
        this.expandFully();
        return;
    }
  }

  private attachOverflowObserverIfNeeded(): void {
    this.disconnectOverflowObserver();
    if (
      !this.observeTargetUntilOverflow ||
      this.currentState.kind !== 'initial' ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    this.overflowObserver = new ResizeObserver(() => {
      this.refreshExpandFooter();
      this.emitContentGrown('content-growth');
    });
    this.overflowObserver.observe(this.target);
  }

  private refreshExpandFooter(): void {
    if (!this.target.isConnected) return;
    if (this.currentState.kind === 'initial') {
      const exceedsInitialClamp =
        this.target.scrollHeight > PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX + 1;
      if (exceedsInitialClamp) {
        this.collapseToInitial();
        this.footer.classList.remove('is-hidden');
        this.disconnectOverflowObserver();
        return;
      }
      this.footer.classList.add('is-hidden');
      this.showCurrentContentFully();
      return;
    }
    const overflow = this.target.scrollHeight > this.target.clientHeight + 1;
    if (overflow) {
      this.footer.classList.remove('is-hidden');
      this.disconnectOverflowObserver();
      return;
    }
    this.footer.classList.add('is-hidden');
    this.expandFully();
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
