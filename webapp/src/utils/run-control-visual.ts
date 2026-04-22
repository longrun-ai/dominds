import type {
  DialogBlockedReason,
  DialogDisplayState,
} from '@longrun-ai/kernel/types/display-state';

export type RunControlVisualState =
  | { kind: 'none' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested' }
  | { kind: 'stopped' }
  | { kind: 'blocked_q4h' }
  | { kind: 'blocked_sideDialogs' }
  | { kind: 'blocked_both' };

export type DisplayStateClassSuffix =
  | ''
  | 'state-proceeding'
  | 'state-proceeding-stop'
  | 'state-stopped'
  | 'state-blocked-q4h'
  | 'state-blocked-sideDialogs'
  | 'state-blocked-both';

function blockedReasonToVisualState(reason: DialogBlockedReason): RunControlVisualState {
  switch (reason.kind) {
    case 'needs_human_input':
      return { kind: 'blocked_q4h' };
    case 'waiting_for_sideDialogs':
      return { kind: 'blocked_sideDialogs' };
    case 'needs_human_input_and_sideDialogs':
      return { kind: 'blocked_both' };
    default: {
      const _exhaustive: never = reason;
      return { kind: 'none' };
    }
  }
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
      return blockedReasonToVisualState(displayState.reason);
    default: {
      const _exhaustive: never = displayState;
      return { kind: 'none' };
    }
  }
}

export function displayStateClassSuffixFromDisplayState(
  displayState: DialogDisplayState | undefined,
): DisplayStateClassSuffix {
  const visual = runControlVisualStateFromDisplayState(displayState);
  switch (visual.kind) {
    case 'none':
      return '';
    case 'proceeding':
      return 'state-proceeding';
    case 'proceeding_stop_requested':
      return 'state-proceeding-stop';
    case 'stopped':
      return 'state-stopped';
    case 'blocked_q4h':
      return 'state-blocked-q4h';
    case 'blocked_sideDialogs':
      return 'state-blocked-sideDialogs';
    case 'blocked_both':
      return 'state-blocked-both';
    default: {
      const _exhaustive: never = visual;
      return _exhaustive;
    }
  }
}
