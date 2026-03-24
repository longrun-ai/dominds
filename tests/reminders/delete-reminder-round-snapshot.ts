import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { reminderIsNumbered } from '../../main/tool';
import { deleteReminderTool } from '../../main/tools/ctrl';

function numberedContents(dlg: RootDialog): string[] {
  return dlg.reminders
    .filter((reminder) => reminderIsNumbered(reminder))
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

  // Simulate one generation (same genseq) so lookups share a stable snapshot.
  (dlg as unknown as { _activeGenSeq?: number })._activeGenSeq = 1;
  await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_no: 1 });
  await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_no: 3 });

  assert.deepEqual(
    numberedContents(dlg),
    ['B'],
    'Expected same-genseq deletes (#1 and #3) to resolve against the same snapshot',
  );

  // Next generation (new genseq) must rebuild snapshot from current reminders.
  (dlg as unknown as { _activeGenSeq?: number })._activeGenSeq = 2;
  const secondRoundError = await deleteReminderTool.call(dlg, {} as Team.Member, {
    reminder_no: 2,
  });

  assert.ok(
    secondRoundError.includes('Available reminders: 1-1'),
    `Expected genseq-local snapshot reset; got: ${secondRoundError}`,
  );

  console.log('✓ delete_reminder genseq-snapshot test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
