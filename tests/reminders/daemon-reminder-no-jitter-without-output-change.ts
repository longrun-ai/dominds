import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DialogStore, MainDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import {
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-daemon-no-jitter-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'daemon-reminder-no-jitter-without-output-change.tsk',
    undefined,
    agentId,
  );
}

function requireReminder<T>(value: T | undefined, label: string): T {
  assert.notEqual(value, undefined, `Expected ${label} to exist`);
  if (value === undefined) {
    throw new Error(`Expected ${label} to exist`);
  }
  return value;
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    registerReminderOwner(shellCmdReminderOwner);
    try {
      const dialog = createDialog('tester');
      const caller = {} as Team.Member;

      await shellCmdTool.call(dialog, caller, {
        command:
          'node -e "setTimeout(() => console.log(\'daemon-output\'), 3000); setInterval(() => {}, 10000)"',
        timeoutSeconds: 1,
      });

      const reminder = requireReminder(
        (await dialog.listVisibleReminders()).find(
          (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
        ),
        'daemon reminder',
      );
      const beforeUpdatedAt = dialog.updatedAt;
      const beforeContent = reminder.content;
      const pid = reminder.meta?.pid;
      assert.equal(typeof pid, 'number', 'Expected daemon reminder pid to be present');
      if (typeof pid !== 'number') {
        throw new Error('Expected daemon reminder pid to be present');
      }

      await delay(500);
      await dialog.processReminderUpdates();

      assert.equal(
        dialog.updatedAt,
        beforeUpdatedAt,
        'Daemon reminder should not touch dialog updatedAt when stdout/stderr did not change',
      );
      const reminderAfterNoOutput = requireReminder(
        (await dialog.listVisibleReminders()).find(
          (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
        ),
        'daemon reminder after no-output refresh',
      );
      assert.equal(
        reminderAfterNoOutput.content,
        beforeContent,
        'Daemon reminder content should stay stable without stdout/stderr rollover',
      );

      await delay(2800);
      await dialog.processReminderUpdates();

      assert.notEqual(
        dialog.updatedAt,
        beforeUpdatedAt,
        'Daemon reminder should touch dialog updatedAt after new stdout/stderr arrives',
      );
      const reminderAfterOutput = requireReminder(
        (await dialog.listVisibleReminders()).find(
          (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
        ),
        'daemon reminder after output refresh',
      );
      assert.match(
        reminderAfterOutput.content,
        /daemon-output/,
        'Daemon reminder should refresh when stdout/stderr changed',
      );

      await stopDaemonTool.call(dialog, caller, { pid });
    } finally {
      resetTrackedDaemonsForTests();
      unregisterReminderOwner(shellCmdReminderOwner.name);
    }
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
