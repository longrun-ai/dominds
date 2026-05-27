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

  assert.deepEqual(buildWindowsTaskkillArgs(1234, false), ['/PID', '1234', '/T']);
  assert.deepEqual(buildWindowsTaskkillArgs(1234, true), ['/PID', '1234', '/T', '/F']);
  assert.throws(() => buildWindowsTaskkillArgs(0, false), /Invalid process pid/);
  assert.throws(() => bestEffortKillPid(0), /Invalid process pid/);

  console.log('✅ stop-daemon-windows-process-tree tests passed');
}

main();
