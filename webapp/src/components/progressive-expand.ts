export const PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX = 120;
export const PROGRESSIVE_EXPAND_STEP_PARENT_RATIO = 1 / 3;
const progressiveExpandObserverByTarget = new WeakMap<HTMLElement, ResizeObserver>();

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
  // If the explicit parent is temporarily unavailable, keep a stable constant fallback instead of
  // guessing another container/viewport baseline.
  const referenceHeight =
    parentHeight > 0 ? parentHeight : PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX;
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

export function setupProgressiveExpandBehavior(
  options: Readonly<{
    target: HTMLElement;
    footer: HTMLElement;
    button: HTMLButtonElement;
    stepParent: HTMLElement | null;
    label: Readonly<{ text: string; title: string }>;
    observeTargetUntilOverflow?: boolean;
    onAfterExpandStep?: () => void;
  }>,
): () => void {
  const {
    target,
    footer,
    button,
    stepParent,
    label,
    observeTargetUntilOverflow,
    onAfterExpandStep,
  } = options;

  button.setAttribute('aria-label', label.text);
  button.title = label.title;

  const collapseToInitial = (): void => {
    target.style.maxHeight = `${PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX}px`;
    target.style.overflowY = 'hidden';
  };

  const disconnectOverflowObserver = (): void => {
    const existingObserver = progressiveExpandObserverByTarget.get(target);
    if (!existingObserver) return;
    existingObserver.disconnect();
    progressiveExpandObserverByTarget.delete(target);
  };

  const expandFully = (): void => {
    target.style.maxHeight = 'none';
    target.style.overflowY = 'visible';
    footer.classList.add('is-hidden');
    disconnectOverflowObserver();
  };

  const refreshExpandFooter = (): void => {
    if (!target.isConnected) return;
    const overflow = target.scrollHeight > target.clientHeight + 1;
    if (overflow) {
      footer.classList.remove('is-hidden');
      disconnectOverflowObserver();
      return;
    }
    footer.classList.add('is-hidden');
    if (observeTargetUntilOverflow === true) {
      // Keep the initial clamp in place while waiting for future target-content growth to cross
      // the first overflow threshold. We intentionally do not observe parent/container resize.
      collapseToInitial();
      return;
    }
    expandFully();
  };

  button.onclick = () => {
    const stepPx = computeProgressiveExpandStepPx(stepParent);
    const nextMaxHeightPx =
      Math.max(target.clientHeight, PROGRESSIVE_EXPAND_INITIAL_MAX_HEIGHT_PX) + stepPx;
    target.style.maxHeight = `${nextMaxHeightPx}px`;
    target.style.overflowY = 'hidden';
    requestAnimationFrame(() => {
      refreshExpandFooter();
      onAfterExpandStep?.();
    });
  };

  collapseToInitial();
  const previousObserver = progressiveExpandObserverByTarget.get(target);
  if (previousObserver) {
    disconnectOverflowObserver();
  }
  if (observeTargetUntilOverflow === true && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      refreshExpandFooter();
    });
    observer.observe(target);
    progressiveExpandObserverByTarget.set(target, observer);
  }
  requestAnimationFrame(() => {
    refreshExpandFooter();
  });
  return () => {
    disconnectOverflowObserver();
  };
}
