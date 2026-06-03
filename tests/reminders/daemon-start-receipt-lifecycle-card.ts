import assert from 'node:assert/strict';

import { DialogStore, MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { shellCmdTool, stopDaemonTool } from '../../main/tools/os';
import { daemonScriptShell, withTempCwd, writeDaemonScriptCommand } from './daemon-test-utils';

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'daemon-start-receipt-lifecycle-card.tsk',
    undefined,
    agentId,
  );
}

function requirePidFromOutput(output: string): number {
  const match = output.match(/PID: (\d+)/);
  assert.notEqual(match, null, 'Expected daemon start receipt to include PID');
  const pidText = match?.[1];
  assert.equal(typeof pidText, 'string', 'Expected daemon start receipt PID capture');
  if (typeof pidText !== 'string') {
    throw new Error('Expected daemon start receipt PID capture');
  }
  return Number(pidText);
}

async function main(): Promise<void> {
  await withTempCwd('dominds-daemon-start-receipt-lifecycle-card-', async (sandboxDir) => {
    setWorkLanguage('zh');
    const dialog = createDialog('tester');
    const caller = {} as Team.Member;

    const command = await writeDaemonScriptCommand(
      sandboxDir,
      'long-running-daemon.js',
      `
setInterval(() => {}, 10000);
`,
      `while ($true) { Start-Sleep -Seconds 10 }`,
    );
    const output = (
      await shellCmdTool.call(dialog, caller, {
        command,
        shell: daemonScriptShell(),
        timeoutSeconds: 1,
      })
    ).content;

    assert.match(
      output,
      /🟢 .* 已转入后台持续运行（PID: \d+）/,
      'Expected daemon start receipt to expose lifecycle-reminder style running summary',
    );
    assert.match(
      output,
      /生命周期提醒持续刷新：系统维护 \/ 实时真源/,
      'Expected daemon start receipt to describe the lifecycle reminder semantics directly',
    );
    assert.match(
      output,
      /禁止把它抄进、改写进、或同步维护到你手工创建的提醒项里/,
      'Expected daemon start receipt to forbid mirroring lifecycle state into manual reminders',
    );
    assert.doesNotMatch(
      output,
      /已添加提醒以跟踪其进度/,
      'Expected daemon start receipt not to use the generic reminder phrasing anymore',
    );

    const pid = requirePidFromOutput(output);
    await stopDaemonTool.call(dialog, caller, { pid });
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
