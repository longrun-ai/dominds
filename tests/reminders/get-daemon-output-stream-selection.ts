import assert from 'node:assert/strict';
import { DialogStore, MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import {
  getDaemonOutputTool,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { daemonScriptShell, withTempCwd, writeDaemonScriptCommand } from './daemon-test-utils';

function createDialog(): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'get-daemon-output-stream-selection.tsk',
    undefined,
    'tester',
  );
}

function requireDaemonPid(reminderMeta: unknown): number {
  assert.equal(typeof reminderMeta, 'object');
  assert.notEqual(reminderMeta, null);
  assert.equal(Array.isArray(reminderMeta), false);
  const meta = reminderMeta as Record<string, unknown>;
  assert.equal(meta['kind'], 'daemon');
  assert.equal(typeof meta['pid'], 'number');
  return meta['pid'] as number;
}

async function listShellDaemonPids(dialog: MainDialog): Promise<Set<number>> {
  const reminders = await dialog.listVisibleReminders();
  return new Set(
    reminders
      .filter((candidate) => candidate.owner?.name === shellCmdReminderOwner.name)
      .map((candidate) => requireDaemonPid(candidate.meta)),
  );
}

async function startDaemonAndGetNewPid(
  dialog: MainDialog,
  caller: Team.Member,
  command: string,
): Promise<number> {
  const before = await listShellDaemonPids(dialog);
  await shellCmdTool.call(dialog, caller, {
    command,
    shell: daemonScriptShell(),
    timeoutSeconds: 1,
  });
  const after = await listShellDaemonPids(dialog);
  const newPids = [...after].filter((pid) => !before.has(pid));
  assert.equal(newPids.length, 1, 'Expected exactly one new daemon reminder to exist');
  const newPid = newPids[0];
  assert.equal(typeof newPid, 'number');
  return newPid;
}

function buildDelayedOutputDaemonCommand(): { nodeSource: string; powershellSource: string } {
  return {
    nodeSource: `
console.log('stdout-initial');
setTimeout(() => {
  console.log('stdout-delayed');
}, 2500);
setInterval(() => {}, 10000);
`,
    powershellSource: `
Write-Output 'stdout-initial'
Start-Sleep -Milliseconds 2500
Write-Output 'stdout-delayed'
while ($true) { Start-Sleep -Seconds 10 }
`,
  };
}

function buildStdoutDuringStderrWaitDaemonCommand(): {
  nodeSource: string;
  powershellSource: string;
} {
  return {
    nodeSource: `
setTimeout(() => {
  console.log('stdout-during-stderr-wait');
}, 1500);
setInterval(() => {}, 10000);
`,
    powershellSource: `
Start-Sleep -Milliseconds 1500
Write-Output 'stdout-during-stderr-wait'
while ($true) { Start-Sleep -Seconds 10 }
`,
  };
}

async function main(): Promise<void> {
  await withTempCwd('dominds-get-daemon-output-stream-selection-', async (sandboxDir) => {
    setWorkLanguage('en');
    registerReminderOwner(shellCmdReminderOwner);
    try {
      const dialog = createDialog();
      const caller = {} as Team.Member;
      const command = await writeDaemonScriptCommand(
        sandboxDir,
        'stdout-stderr-daemon.js',
        `
console.log('stdout-line');
console.error('stderr-line');
setInterval(() => {}, 10000);
`,
        `Write-Output 'stdout-line'; [Console]::Error.WriteLine('stderr-line'); while ($true) { Start-Sleep -Seconds 10 }`,
      );
      await shellCmdTool.call(dialog, caller, {
        command,
        shell: daemonScriptShell(),
        timeoutSeconds: 1,
      });

      const reminder = (await dialog.listVisibleReminders()).find(
        (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
      );
      assert.ok(reminder, 'Expected daemon reminder to exist');
      const pid = requireDaemonPid(reminder.meta);

      try {
        const both = (await getDaemonOutputTool.call(dialog, caller, { pid })).content;
        assert.match(both, /stdout/);
        assert.match(both, /stderr/);
        assert.match(both, /stdout-line/);
        assert.match(both, /stderr-line/);

        const onlyStdout = (
          await getDaemonOutputTool.call(dialog, caller, {
            pid,
            stdout: true,
            stderr: false,
          })
        ).content;
        assert.match(onlyStdout, /stdout/);
        assert.doesNotMatch(onlyStdout, /stderr-line/);
        assert.match(onlyStdout, /stdout-line/);

        const onlyStderr = (
          await getDaemonOutputTool.call(dialog, caller, {
            pid,
            stdout: false,
            stderr: true,
          })
        ).content;
        assert.match(onlyStderr, /stderr/);
        assert.doesNotMatch(onlyStderr, /stdout-line/);
        assert.match(onlyStderr, /stderr-line/);

        await assert.rejects(
          async () =>
            await getDaemonOutputTool.call(dialog, caller, {
              pid,
              stdout: false,
              stderr: false,
            }),
          /at least one of stdout\/stderr to be true/,
        );
        await assert.rejects(
          async () =>
            await getDaemonOutputTool.call(dialog, caller, {
              pid,
              wait_for_new_output: false,
              timeout_ms: 100,
            }),
          /timeout_ms cannot be provided when wait_for_new_output is false/,
        );
        await assert.rejects(
          async () =>
            await getDaemonOutputTool.call(dialog, caller, {
              pid,
              timeout_ms: 86_400_001,
            }),
          /timeout_ms must be a non-negative integer <= 86400000/,
        );

        const delayed = buildDelayedOutputDaemonCommand();
        const delayedCommand = await writeDaemonScriptCommand(
          sandboxDir,
          'delayed-stdout-daemon.js',
          delayed.nodeSource,
          delayed.powershellSource,
        );
        const delayedPid = await startDaemonAndGetNewPid(dialog, caller, delayedCommand);

        try {
          const waitedStdout = (
            await getDaemonOutputTool.call(dialog, caller, {
              pid: delayedPid,
              stdout: true,
              stderr: false,
              wait_for_new_output: true,
              timeout_ms: 8000,
            })
          ).content;
          assert.match(waitedStdout, /stdout-delayed/);

          const stderrTimeout = (
            await getDaemonOutputTool.call(dialog, caller, {
              pid: delayedPid,
              stdout: false,
              stderr: true,
              wait_for_new_output: true,
              timeout_ms: 100,
            })
          ).content;
          assert.match(stderrTimeout, /Timed out waiting for new stderr output/);
          assert.doesNotMatch(stderrTimeout, /stdout-delayed/);
        } finally {
          await stopDaemonTool.call(dialog, caller, { pid: delayedPid });
        }

        const stdoutDuringStderrWait = buildStdoutDuringStderrWaitDaemonCommand();
        const stdoutDuringStderrWaitCommand = await writeDaemonScriptCommand(
          sandboxDir,
          'stdout-during-stderr-wait-daemon.js',
          stdoutDuringStderrWait.nodeSource,
          stdoutDuringStderrWait.powershellSource,
        );
        const stdoutDuringStderrWaitPid = await startDaemonAndGetNewPid(
          dialog,
          caller,
          stdoutDuringStderrWaitCommand,
        );

        try {
          const startedAt = Date.now();
          const stderrWait = (
            await getDaemonOutputTool.call(dialog, caller, {
              pid: stdoutDuringStderrWaitPid,
              stdout: false,
              stderr: true,
              wait_for_new_output: true,
              timeout_ms: 1200,
            })
          ).content;
          const elapsedMs = Date.now() - startedAt;
          assert.ok(elapsedMs >= 1000, `stderr wait returned too early after ${elapsedMs}ms`);
          assert.match(stderrWait, /Timed out waiting for new stderr output/);
          assert.doesNotMatch(stderrWait, /stdout-during-stderr-wait/);
        } finally {
          await stopDaemonTool.call(dialog, caller, { pid: stdoutDuringStderrWaitPid });
        }
      } finally {
        await stopDaemonTool.call(dialog, caller, { pid });
      }
    } finally {
      unregisterReminderOwner(shellCmdReminderOwner.name);
    }
  });
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
