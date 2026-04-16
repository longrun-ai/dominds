import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DialogStore, RootDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import {
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  shellCmdTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-daemon-retained-after-exit-'),
  );
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string): RootDialog {
  return new RootDialog(
    new DialogStore(),
    'daemon-reminder-retained-after-exit.tsk',
    undefined,
    agentId,
  );
}

function requireReminder(dialog: RootDialog) {
  return dialog
    .listVisibleReminders()
    .then((reminders) =>
      reminders.find((candidate) => candidate.owner?.name === shellCmdReminderOwner.name),
    )
    .then((reminder) => {
      assert.notEqual(reminder, undefined, 'Expected daemon reminder to still exist');
      if (reminder === undefined) {
        throw new Error('Expected daemon reminder to still exist');
      }
      return reminder;
    });
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    registerReminderOwner(shellCmdReminderOwner);
    try {
      const dialog = createDialog('tester');
      const caller = {} as Team.Member;

      await shellCmdTool.call(dialog, caller, {
        command:
          "node -e \"console.log('final-stdout'); console.error('final-stderr'); setTimeout(() => process.exit(0), 1500)\"",
        timeoutSeconds: 1,
      });

      await delay(2300);
      await dialog.processReminderUpdates();

      const finalizedReminder = await requireReminder(dialog);
      assert.match(
        finalizedReminder.content,
        /(手动删除|delete this reminder manually)/,
        'Expected exited daemon reminder to require manual deletion',
      );
      assert.match(
        finalizedReminder.content,
        /get_daemon_output/,
        'Expected exited daemon reminder to mention optional final stdout/stderr inspection',
      );
      const finalizedMeta =
        finalizedReminder.meta && typeof finalizedReminder.meta === 'object'
          ? (finalizedReminder.meta as Record<string, unknown>)
          : null;
      assert.notEqual(finalizedMeta, null, 'Expected finalized daemon reminder meta');
      if (finalizedMeta === null) {
        throw new Error('Expected finalized daemon reminder meta');
      }
      const deleteMeta =
        finalizedMeta['delete'] && typeof finalizedMeta['delete'] === 'object'
          ? (finalizedMeta['delete'] as Record<string, unknown>)
          : null;
      assert.equal(
        deleteMeta?.['altInstruction'],
        undefined,
        'Expected exited daemon reminder to allow manual delete_reminder instead of stop_daemon',
      );

      await delay(500);
      await dialog.processReminderUpdates();
      const retainedReminder = await requireReminder(dialog);
      assert.equal(
        retainedReminder.id,
        finalizedReminder.id,
        'Expected exited daemon reminder to remain until the agent deletes it manually',
      );
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
