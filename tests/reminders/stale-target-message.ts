import assert from 'node:assert/strict';
import { MainDialog, type DialogStore, type VisibleReminderTarget } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { materializeReminder, type Reminder } from '../../main/tool';
import { deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';

type StaleTargetCase = Readonly<{
  language: 'zh' | 'en';
  expectedSubstring: string;
}>;

function createDialog(): MainDialog {
  return new MainDialog(
    {} as unknown as DialogStore,
    'reminders-stale-target-message.tsk',
    undefined,
    'tester',
  );
}

function forceDialogTargetIndex(dlg: MainDialog, reminder: Reminder, index: number): void {
  const staleTarget: VisibleReminderTarget = {
    source: 'dialog',
    index,
    reminder,
  };
  dlg.resolveReminderTargetById = async () => staleTarget;
}

function assertFriendlyStaleTargetMessage(output: string, expectedSubstring: string): void {
  assert.ok(
    output.includes(expectedSubstring),
    `Expected output to include "${expectedSubstring}", got: ${output}`,
  );
  assert.ok(
    !output.includes('Reminder index'),
    `Output should not expose raw index, got: ${output}`,
  );
  assert.ok(
    !output.includes('Available reminders'),
    `Output should not expose raw index range, got: ${output}`,
  );
}

async function runDeleteCase(testCase: StaleTargetCase): Promise<void> {
  setWorkLanguage(testCase.language);
  const dlg = createDialog();
  const reminder = dlg.addReminder('stale delete target');
  forceDialogTargetIndex(dlg, reminder, 4);
  dlg.deleteReminder(0);

  const result = await deleteReminderTool.call(dlg, {} as Team.Member, {
    reminder_id: reminder.id,
  });
  const output = result.content;

  assert.equal(result.outcome, 'failure');
  assertFriendlyStaleTargetMessage(output, testCase.expectedSubstring);
  assert.equal(dlg.reminders.length, 0);
}

async function runUpdateCase(testCase: StaleTargetCase): Promise<void> {
  setWorkLanguage(testCase.language);
  const dlg = createDialog();
  const reminder = dlg.addReminder('stale update target');
  forceDialogTargetIndex(dlg, reminder, 4);
  dlg.deleteReminder(0);

  const result = await updateReminderTool.call(dlg, {} as Team.Member, {
    reminder_id: reminder.id,
    content: 'new content',
  });
  const output = result.content;

  assert.equal(result.outcome, 'failure');
  assertFriendlyStaleTargetMessage(output, testCase.expectedSubstring);
  assert.equal(dlg.reminders.length, 0);
}

async function runStaleIndexStillResolvesByIdCase(): Promise<void> {
  setWorkLanguage('en');
  const deleteDialog = createDialog();
  const deleteReminder = deleteDialog.addReminder('delete by id despite stale index');
  forceDialogTargetIndex(deleteDialog, deleteReminder, 4);
  const deleteResult = await deleteReminderTool.call(deleteDialog, {} as Team.Member, {
    reminder_id: deleteReminder.id,
  });
  assert.equal(deleteResult.outcome, 'success');
  assert.equal(deleteDialog.reminders.length, 0);

  const updateDialog = createDialog();
  const updateReminder = updateDialog.addReminder('update by id despite stale index');
  forceDialogTargetIndex(updateDialog, updateReminder, 4);
  const updateResult = await updateReminderTool.call(updateDialog, {} as Team.Member, {
    reminder_id: updateReminder.id,
    content: 'updated through id',
  });
  assert.equal(updateResult.outcome, 'success');
  assert.equal(updateDialog.reminders[0]?.content, 'updated through id');
}

async function runDuplicateDialogReminderIdCase(): Promise<void> {
  setWorkLanguage('en');
  const dlg = createDialog();
  const duplicateId = 'duplicate-reminder-id';
  const firstReminder = materializeReminder({
    id: duplicateId,
    content: 'first duplicate reminder',
  });
  dlg.reminders.push(
    firstReminder,
    materializeReminder({
      id: duplicateId,
      content: 'second duplicate reminder',
    }),
  );
  forceDialogTargetIndex(dlg, firstReminder, 0);

  await assert.rejects(
    deleteReminderTool.call(dlg, {} as Team.Member, {
      reminder_id: duplicateId,
    }),
    /Duplicate dialog reminder_id detected: duplicate-reminder-id/,
  );
  assert.equal(dlg.reminders.length, 2);
}

async function main(): Promise<void> {
  const testCases: StaleTargetCase[] = [
    { language: 'zh', expectedSubstring: '提醒项列表已变化' },
    { language: 'en', expectedSubstring: 'The reminder list changed' },
  ];
  for (const testCase of testCases) {
    await runDeleteCase(testCase);
    await runUpdateCase(testCase);
  }
  await runStaleIndexStillResolvesByIdCase();
  await runDuplicateDialogReminderIdCase();
  console.log('✓ reminder stale-target message test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
