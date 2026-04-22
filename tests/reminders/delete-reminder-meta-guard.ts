import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { deleteReminderTool } from '../../main/tools/ctrl';

async function runCase(language: 'zh' | 'en', expectedSubstring: string): Promise<void> {
  setWorkLanguage(language);
  const dlg = new MainDialog(
    {} as unknown as DialogStore,
    'reminders-delete-meta-guard.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('daemon reminder', undefined, {
    delete: {
      altInstruction: 'stop_daemon({ "pid": 123 })',
    },
  });
  const reminderId = dlg.reminders[0]?.id;
  assert.equal(typeof reminderId, 'string');

  const output = (
    await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_id: reminderId })
  ).content;

  assert.ok(
    output.includes(expectedSubstring),
    `Expected output to include "${expectedSubstring}", got: ${output}`,
  );
  assert.equal(dlg.reminders.length, 1, 'Expected delete_reminder guard to preserve the reminder');
}

async function main(): Promise<void> {
  await runCase('zh', 'stop_daemon({ "pid": 123 })');
  await runCase('en', 'stop_daemon({ "pid": 123 })');
  console.log('✓ delete_reminder meta guard test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
