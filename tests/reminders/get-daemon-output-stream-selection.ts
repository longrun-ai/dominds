import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import {
  getDaemonOutputTool,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

function createDialog(): MainDialog {
  return new MainDialog(
    {} as unknown as DialogStore,
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

async function main(): Promise<void> {
  setWorkLanguage('en');
  registerReminderOwner(shellCmdReminderOwner);
  try {
    const dialog = createDialog();
    const caller = {} as Team.Member;
    await shellCmdTool.call(dialog, caller, {
      command: `node -e "console.log('stdout-line'); console.error('stderr-line'); setInterval(() => {}, 10000)"`,
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
    } finally {
      await stopDaemonTool.call(dialog, caller, { pid });
    }
  } finally {
    unregisterReminderOwner(shellCmdReminderOwner.name);
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
