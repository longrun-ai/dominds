import assert from 'node:assert/strict';
import { parseCmdRunnerRequestLine } from '../main/tools/cmd-runner-protocol';
import { bestEffortKillPid, buildWindowsTaskkillArgs } from '../main/tools/process-kill';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-shell-stop-protocol-');
  const invalidRequests = [
    ['stop-missing-entire-pg', { type: 'stop' }],
    [
      'output-no-stream',
      { type: 'get_output', stdout: false, stderr: false, waitForNewOutput: true },
    ],
    [
      'output-timeout-without-wait',
      { type: 'get_output', stdout: true, stderr: false, waitForNewOutput: false, timeoutMs: 100 },
    ],
    [
      'output-timeout-over-bound',
      {
        type: 'get_output',
        stdout: true,
        stderr: false,
        waitForNewOutput: true,
        timeoutMs: 86_400_001,
      },
    ],
  ] as const;
  for (const [id, request] of invalidRequests) {
    let caught: unknown;
    try {
      parseCmdRunnerRequestLine(JSON.stringify(request));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    evidence.record({
      id,
      scenario: 'The runner rejects an invalid supplied wire request.',
      businessValue:
        'Callers can repair a stop/output request without accidentally changing process scope or wait policy.',
      context: {
        wireRequest: JSON.stringify(request),
        scope: 'Real parser only; no runner IPC or OS stop.',
      },
      reviewQuestions: [
        'Does the full actual diagnostic accurately identify the invalid field and useful constraint?',
      ],
      actualText: caught.message,
    });
  }
  for (const entirePg of [true, false])
    assert.deepEqual(parseCmdRunnerRequestLine(JSON.stringify({ type: 'stop', entirePg })), {
      type: 'stop',
      entirePg,
    });
  for (const timeoutMs of [0, 86_400_000]) {
    const request = {
      type: 'get_output',
      stdout: true,
      stderr: false,
      waitForNewOutput: true,
      timeoutMs,
    };
    assert.deepEqual(parseCmdRunnerRequestLine(JSON.stringify(request)), request);
  }
  assert.deepEqual(buildWindowsTaskkillArgs(1234, false), ['/PID', '1234', '/T']);
  assert.deepEqual(buildWindowsTaskkillArgs(1234, true), ['/PID', '1234', '/T', '/F']);
  for (const [id, action] of [
    ['taskkill-invalid-pid', () => buildWindowsTaskkillArgs(0, false)],
    ['best-effort-invalid-pid', () => bestEffortKillPid(0)],
  ] as const) {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    evidence.record({
      id,
      scenario: 'A zero PID is rejected before any process kill.',
      businessValue: 'An invalid stop target cannot become an unsafe process operation.',
      context: {
        pid: 0,
        scope: 'Argument validation only; no native taskkill or process-tree termination.',
      },
      reviewQuestions: ['Does the actual diagnostic explain the invalid process identifier?'],
      actualText: caught.message,
    });
  }
  await evidence.write();
  console.log(
    'Runner stop/output parsing and Windows taskkill argv: PASS; native taskkill unexecuted.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
