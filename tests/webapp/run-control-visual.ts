import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import assert from 'node:assert/strict';
import {
  runControlVisualStateFromDisplayState,
  visibleNonFbrBackgroundCalleeBadgeCount,
} from '../../webapp/src/utils/run-control-visual';

function expectVisualKind(
  displayState: DialogDisplayState | undefined,
  expected: ReturnType<typeof runControlVisualStateFromDisplayState>['kind'],
): void {
  assert.equal(runControlVisualStateFromDisplayState(displayState).kind, expected);
}

expectVisualKind(undefined, 'none');
expectVisualKind({ kind: 'idle_waiting_user' }, 'none');
expectVisualKind({ kind: 'proceeding' }, 'proceeding');
expectVisualKind(
  { kind: 'proceeding_stop_requested', reason: 'user_stop' },
  'proceeding_stop_requested',
);
expectVisualKind(
  { kind: 'stopped', reason: { kind: 'user_stop' }, continueEnabled: true },
  'stopped',
);
expectVisualKind({ kind: 'blocked', reason: { kind: 'needs_human_input' } }, 'blocked_q4h');
expectVisualKind({ kind: 'waiting_side_dialog' }, 'none');

assert.equal(
  visibleNonFbrBackgroundCalleeBadgeCount({
    backgroundCalleeDialogCount: 1,
    backgroundFreshBootsReasoningCalleeCount: 0,
  }),
  1,
  'background callee handset visibility should come from counts instead of display state',
);

assert.equal(
  visibleNonFbrBackgroundCalleeBadgeCount({
    backgroundCalleeDialogCount: 2,
    backgroundFreshBootsReasoningCalleeCount: 1,
  }),
  1,
  'non-FBR handset count should subtract FBR callees from total active callees',
);

assert.equal(
  visibleNonFbrBackgroundCalleeBadgeCount({
    backgroundCalleeDialogCount: 1,
    backgroundFreshBootsReasoningCalleeCount: 2,
  }),
  0,
  'non-FBR handset count should clamp at zero when FBR count is higher',
);

assert.equal(
  visibleNonFbrBackgroundCalleeBadgeCount({
    backgroundCalleeDialogCount: undefined,
    backgroundFreshBootsReasoningCalleeCount: undefined,
  }),
  0,
  'missing background callee counts should not render a handset badge',
);
