import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { reminderIsListed } from '../../main/tool';
import { deleteReminderTool } from '../../main/tools/ctrl';

function numberedContents(dlg: RootDialog): string[] {
  return dlg.reminders
    .filter((reminder) => reminderIsListed(reminder))
    .map((reminder) => reminder.content);
}

async function main(): Promise<void> {
  setWorkLanguage('en');

  const dlg = new RootDialog(
    {} as unknown as DialogStore,
    'reminders-round-snapshot.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('A');
  dlg.addReminder('B');
  dlg.addReminder('C');
  const reminderAId = dlg.reminders[0]?.id;
  const reminderCId = dlg.reminders[2]?.id;
  assert.equal(typeof reminderAId, 'string');
  assert.equal(typeof reminderCId, 'string');

  await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_id: reminderAId });
  await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_id: reminderCId });

  assert.deepEqual(
    numberedContents(dlg),
    ['B'],
    'Expected reminder-id deletes to remain stable even after earlier deletions reshuffle indices',
  );

  const secondRoundError = await deleteReminderTool.call(dlg, {} as Team.Member, {
    reminder_id: reminderCId,
  });

  assert.ok(
    secondRoundError.includes(`Reminder '${reminderCId}' does not exist`),
    `Expected deleted reminder id to stay invalid after removal; got: ${secondRoundError}`,
  );

  console.log('✓ delete_reminder reminder-id stability test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
