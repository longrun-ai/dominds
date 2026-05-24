import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';

export type RunControlVisualState =
  | { kind: 'none' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested' }
  | { kind: 'stopped' }
  | { kind: 'blocked_q4h' };

export type BackgroundCalleeBadgeCounts = Readonly<{
  backgroundCalleeDialogCount: number | undefined;
  backgroundFreshBootsReasoningCalleeCount: number | undefined;
}>;

function positiveInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

export function runControlVisualStateFromDisplayState(
  displayState: DialogDisplayState | undefined,
): RunControlVisualState {
  if (!displayState) return { kind: 'none' };
  switch (displayState.kind) {
    case 'idle_waiting_user':
    case 'dead':
      return { kind: 'none' };
    case 'proceeding':
      return { kind: 'proceeding' };
    case 'proceeding_stop_requested':
      return { kind: 'proceeding_stop_requested' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'blocked':
      return { kind: 'blocked_q4h' };
    case 'waiting_side_dialog':
      // waiting_side_dialog is an idle projection: no row badge is rendered for it.
      // Active callees are represented independently by the handset badge counts below.
      return { kind: 'none' };
    default: {
      const _exhaustive: never = displayState;
      return { kind: 'none' };
    }
  }
}

export function visibleNonFbrBackgroundCalleeBadgeCount(
  counts: BackgroundCalleeBadgeCounts,
): number {
  // Handset badges follow active callee counts only, independent from displayState.
  const backgroundCalleeDialogCount = positiveInteger(counts.backgroundCalleeDialogCount);
  const backgroundFreshBootsReasoningCalleeCount = positiveInteger(
    counts.backgroundFreshBootsReasoningCalleeCount,
  );
  return Math.max(0, backgroundCalleeDialogCount - backgroundFreshBootsReasoningCalleeCount);
}
