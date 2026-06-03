import assert from 'node:assert/strict';

import { parseCmdRunnerRequestLine } from '../main/tools/cmd-runner-protocol';
import { bestEffortKillPid, buildWindowsTaskkillArgs } from '../main/tools/process-kill';

function main(): void {
  assert.throws(
    () => parseCmdRunnerRequestLine('{"type":"stop"}'),
    /Invalid cmd_runner stop request: entirePg must be boolean/,
  );

  const processTreeStopRequest = parseCmdRunnerRequestLine('{"type":"stop","entirePg":true}');
  assert.deepEqual(processTreeStopRequest, { type: 'stop', entirePg: true });

  const pidOnlyStopRequest = parseCmdRunnerRequestLine('{"type":"stop","entirePg":false}');
  assert.deepEqual(pidOnlyStopRequest, { type: 'stop', entirePg: false });

  assert.throws(
    () =>
      parseCmdRunnerRequestLine(
        '{"type":"get_output","stdout":false,"stderr":false,"waitForNewOutput":true}',
      ),
    /Invalid cmd_runner get_output request: at least one stream is required/,
  );
  assert.throws(
    () =>
      parseCmdRunnerRequestLine(
        '{"type":"get_output","stdout":true,"stderr":false,"waitForNewOutput":false,"timeoutMs":100}',
      ),
    /Invalid cmd_runner get_output request: timeoutMs requires waitForNewOutput=true/,
  );
  assert.throws(
    () =>
      parseCmdRunnerRequestLine(
        '{"type":"get_output","stdout":true,"stderr":false,"waitForNewOutput":true,"timeoutMs":86400001}',
      ),
    /Invalid cmd_runner get_output.timeoutMs: expected non-negative integer <= 86400000/,
  );

  assert.deepEqual(buildWindowsTaskkillArgs(1234, false), ['/PID', '1234', '/T']);
  assert.deepEqual(buildWindowsTaskkillArgs(1234, true), ['/PID', '1234', '/T', '/F']);
  assert.throws(() => buildWindowsTaskkillArgs(0, false), /Invalid process pid/);
  assert.throws(() => bestEffortKillPid(0), /Invalid process pid/);

  console.log('✅ stop-daemon-windows-process-tree tests passed');
}

main();
