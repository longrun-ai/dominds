import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';

export type RunControlVisualState =
  | { kind: 'none' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested' }
  | { kind: 'stopped' }
  | { kind: 'blocked_q4h' }
  | { kind: 'waiting_side_dialog' };

export type DisplayStateClassSuffix =
  | ''
  | 'state-proceeding'
  | 'state-proceeding-stop'
  | 'state-stopped'
  | 'state-blocked-q4h'
  | 'state-waiting-side-dialog';

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
      return { kind: 'waiting_side_dialog' };
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
    case 'waiting_side_dialog':
      return 'state-waiting-side-dialog';
    default: {
      const _exhaustive: never = visual;
      return _exhaustive;
    }
  }
}
