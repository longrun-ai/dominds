import assert from 'node:assert/strict';

import { Logger } from '../main/log';

const captured: string[] = [];
const originalError = console.error;

try {
  console.error = (message?: unknown, ...optionalParams: unknown[]): void => {
    captured.push([message, ...optionalParams].map((part) => String(part)).join(' '));
  };

  const noisyDialogLike: Record<string, unknown> = {
    _activeGenCourse: 1,
    _activeGenSeq: 49,
    _coursePrefixMsgs: [],
    _courseRuntimeNoticeMsgs: ['notice'],
    _currentCallId: null,
    _driveIntents: [],
    _lastContextHealth: {
      kind: 'available',
      promptTokens: 141253,
      completionTokens: 131,
      totalTokens: 141384,
    },
    _mutex: { locked: true, waiters: [] },
    _activeCalleeDialogIds: [],
    _upNextQueue: [],
    agentId: 'fullstack',
    askerStack: { askerStack: [] },
    rootId: 'bd/86/0d197a16',
    selfId: '60/5f/17a5cbde',
    dialogId: 'bd/86/0d197a16/sideDialogs/60/5f/17a5cbde',
    course: 1,
    genseq: 49,
    callId: 'call_45f92658de4a44d398278b0e',
  };
  for (let index = 0; index < 80; index += 1) {
    noisyDialogLike[`_internalNoise${String(index).padStart(2, '0')}`] = {
      value: `noise-${String(index)}`,
    };
  }

  new Logger('log-priority-test').error('priority field probe', new Error('probe'), {
    dialog: noisyDialogLike,
  });
} finally {
  console.error = originalError;
}

const line = captured.join('\n');
assert.match(line, /rootId: 'bd\/86\/0d197a16'/u);
assert.match(line, /selfId: '60\/5f\/17a5cbde'/u);
assert.match(line, /dialogId: 'bd\/86\/0d197a16\/sideDialogs\/60\/5f\/17a5cbde'/u);
assert.match(line, /callId: 'call_45f92658de4a44d398278b0e'/u);

const rootIdIndex = line.indexOf('rootId');
const internalIndex = line.indexOf('_activeGenCourse');
assert.ok(rootIdIndex >= 0, 'expected rootId in log output');
assert.ok(internalIndex >= 0, 'expected internal field in log output');
assert.ok(rootIdIndex < internalIndex, 'rootId should be rendered before internal fields');

console.log('log-priority-fields: PASS');
