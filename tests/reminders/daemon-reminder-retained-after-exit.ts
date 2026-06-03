import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { DialogStore, MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import {
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  shellCmdTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { daemonScriptShell, withTempCwd, writeDaemonScriptCommand } from './daemon-test-utils';

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'daemon-reminder-retained-after-exit.tsk',
    undefined,
    agentId,
  );
}

function requireReminder(dialog: MainDialog) {
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
  await withTempCwd('dominds-daemon-retained-after-exit-', async (sandboxDir) => {
    setWorkLanguage('zh');
    registerReminderOwner(shellCmdReminderOwner);
    try {
      const dialog = createDialog('tester');
      const caller = {} as Team.Member;

      const command = await writeDaemonScriptCommand(
        sandboxDir,
        'final-output-then-exit.js',
        `
console.log('final-stdout');
console.error('final-stderr');
setTimeout(() => process.exit(0), 1500);
`,
        `Write-Output 'final-stdout'; [Console]::Error.WriteLine('final-stderr'); Start-Sleep -Milliseconds 1500; exit 0`,
      );
      await shellCmdTool.call(dialog, caller, {
        command,
        shell: daemonScriptShell(),
        timeoutSeconds: 1,
      });

      await delay(2300);
      await dialog.processReminderUpdates();

      const finalizedReminder = await requireReminder(dialog);
      assert.match(
        finalizedReminder.content,
        /🟡 .* 已退出（退出事件提示）/,
        'Expected exited daemon reminder to expose explicit exited phase summary',
      );
      assert.doesNotMatch(
        finalizedReminder.content,
        /(手动删除|delete this reminder manually|get_daemon_output)/,
        'Expected exited daemon reminder content not to carry maintenance action instructions',
      );
      assert.match(
        finalizedReminder.content,
        /最后一次已知 stdout\/stderr 快照|last known stdout\/stderr snapshot/,
        'Expected exited daemon reminder to retain the final stdout/stderr snapshot as state',
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
