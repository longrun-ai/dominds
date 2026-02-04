import type { DialogBlockedReason, DialogRunState } from '../shared/types/run-state';

export type RunControlVisualState =
  | { kind: 'none' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested' }
  | { kind: 'interrupted' }
  | { kind: 'blocked_q4h' }
  | { kind: 'blocked_subdialogs' }
  | { kind: 'blocked_both' };

export type RunStateClassSuffix =
  | ''
  | 'state-proceeding'
  | 'state-proceeding-stop'
  | 'state-interrupted'
  | 'state-blocked-q4h'
  | 'state-blocked-subdialogs'
  | 'state-blocked-both';

function blockedReasonToVisualState(reason: DialogBlockedReason): RunControlVisualState {
  switch (reason.kind) {
    case 'needs_human_input':
      return { kind: 'blocked_q4h' };
    case 'waiting_for_subdialogs':
      return { kind: 'blocked_subdialogs' };
    case 'needs_human_input_and_subdialogs':
      return { kind: 'blocked_both' };
    default: {
      const _exhaustive: never = reason;
      return { kind: 'none' };
    }
  }
}

export function runControlVisualStateFromRunState(
  runState: DialogRunState | undefined,
): RunControlVisualState {
  if (!runState) return { kind: 'none' };
  switch (runState.kind) {
    case 'idle_waiting_user':
    case 'terminal':
    case 'dead':
      return { kind: 'none' };
    case 'proceeding':
      return { kind: 'proceeding' };
    case 'proceeding_stop_requested':
      return { kind: 'proceeding_stop_requested' };
    case 'interrupted':
      return { kind: 'interrupted' };
    case 'blocked':
      return blockedReasonToVisualState(runState.reason);
    default: {
      const _exhaustive: never = runState;
      return { kind: 'none' };
    }
  }
}

export function runStateClassSuffixFromRunState(
  runState: DialogRunState | undefined,
): RunStateClassSuffix {
  const visual = runControlVisualStateFromRunState(runState);
  switch (visual.kind) {
    case 'none':
      return '';
    case 'proceeding':
      return 'state-proceeding';
    case 'proceeding_stop_requested':
      return 'state-proceeding-stop';
    case 'interrupted':
      return 'state-interrupted';
    case 'blocked_q4h':
      return 'state-blocked-q4h';
    case 'blocked_subdialogs':
      return 'state-blocked-subdialogs';
    case 'blocked_both':
      return 'state-blocked-both';
    default: {
      const _exhaustive: never = visual;
      return _exhaustive;
    }
  }
}
