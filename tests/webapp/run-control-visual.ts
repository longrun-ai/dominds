import assert from 'node:assert/strict';
import type { DialogRunState } from '../../webapp/src/shared/types/run-state';
import { runStateClassSuffixFromRunState } from '../../webapp/src/utils/run-control-visual';

function expectSuffix(runState: DialogRunState | undefined, expected: string): void {
  assert.equal(runStateClassSuffixFromRunState(runState), expected);
}

expectSuffix(undefined, '');
expectSuffix({ kind: 'idle_waiting_user' }, '');
expectSuffix({ kind: 'proceeding' }, 'state-proceeding');
expectSuffix({ kind: 'proceeding_stop_requested', reason: 'user_stop' }, 'state-proceeding-stop');
expectSuffix({ kind: 'interrupted', reason: { kind: 'user_stop' } }, 'state-interrupted');
expectSuffix({ kind: 'blocked', reason: { kind: 'needs_human_input' } }, 'state-blocked-q4h');
expectSuffix(
  { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } },
  'state-blocked-subdialogs',
);
expectSuffix(
  { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } },
  'state-blocked-both',
);
expectSuffix({ kind: 'terminal', status: 'completed' }, '');
