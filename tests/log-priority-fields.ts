import assert from 'node:assert/strict';

import { Logger } from '../main/log';

const captured: string[] = [];
const originalError = console.error;

const traceIdentity = {
  rootId: 'bd/86/0d197a16',
  selfId: '60/5f/17a5cbde',
  dialogId: 'bd/86/0d197a16/sideDialogs/60/5f/17a5cbde',
  callId: 'call_45f92658de4a44d398278b0e',
};

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
    _queuedPrompts: [],
    agentId: 'fullstack',
    askerStack: { askerStack: [] },
    ...traceIdentity,
    course: 1,
    genseq: 49,
  };
  for (let index = 0; index < 80; index += 1) {
    noisyDialogLike[`_internalNoise${String(index).padStart(2, '0')}`] = {
      value: `noise-${String(index)}`,
    };
  }

  new Logger('log-priority-test').error('priority field probe', new Error('probe'), {
    dialog: noisyDialogLike,
  });

  // In the complete record root/self IDs also occur inside dialogId. Probe each
  // field alone so losing its value cannot pass through that other field.
  const withoutIdentity = { ...noisyDialogLike };
  for (const field of Object.keys(traceIdentity)) delete withoutIdentity[field];
  for (const [field, value] of Object.entries(traceIdentity)) {
    new Logger('log-priority-test').error('priority field probe', new Error('probe'), {
      dialog: { ...withoutIdentity, [field]: value },
    });
  }
} finally {
  console.error = originalError;
}

assert.equal(captured.length, 1 + Object.keys(traceIdentity).length);
const line = captured[0]!;
for (const id of Object.values(traceIdentity))
  assert.ok(line.includes(id), 'Given tracing data must survive bounded diagnostic rendering');
for (const [index, [field, value]] of Object.entries(traceIdentity).entries()) {
  const standalone = captured[index + 1]!;
  assert.ok(
    standalone.includes(value),
    'The independently supplied ' + field + ' value must survive',
  );
}
for (const record of captured)
  assert.ok(record.length <= 3 * 1024, 'Each diagnostic must fit the existing log-line budget');

const rootIdIndex = line.indexOf('rootId');
const internalIndex = line.indexOf('_activeGenCourse');
assert.ok(rootIdIndex >= 0, 'expected rootId in log output');
assert.ok(internalIndex >= 0, 'expected internal field in log output');
assert.ok(rootIdIndex < internalIndex, 'rootId should be rendered before internal fields');

console.log('log-priority-fields: PASS');
