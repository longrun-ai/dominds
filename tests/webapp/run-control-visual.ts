import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import assert from 'node:assert/strict';
import { displayStateClassSuffixFromDisplayState } from '../../webapp/src/utils/run-control-visual';

function expectSuffix(displayState: DialogDisplayState | undefined, expected: string): void {
  assert.equal(displayStateClassSuffixFromDisplayState(displayState), expected);
}

expectSuffix(undefined, '');
expectSuffix({ kind: 'idle_waiting_user' }, '');
expectSuffix({ kind: 'proceeding' }, 'state-proceeding');
expectSuffix({ kind: 'proceeding_stop_requested', reason: 'user_stop' }, 'state-proceeding-stop');
expectSuffix(
  { kind: 'stopped', reason: { kind: 'user_stop' }, continueEnabled: true },
  'state-stopped',
);
expectSuffix({ kind: 'blocked', reason: { kind: 'needs_human_input' } }, 'state-blocked-q4h');
expectSuffix(
  { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } },
  'state-blocked-sideDialogs',
);
expectSuffix(
  { kind: 'blocked', reason: { kind: 'needs_human_input_and_sideDialogs' } },
  'state-blocked-both',
);
