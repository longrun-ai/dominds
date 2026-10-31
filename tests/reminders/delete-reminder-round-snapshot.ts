import assert from 'node:assert/strict';
import { DialogPersistence } from '../../main/persistence';
import { deleteReminderTool } from '../../main/tools/ctrl';
import {
  manualReminderSnapshot,
  reminderCaller,
  withManualReminderDialog,
} from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-reminder-stable-id-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const fixedBefore = await manualReminderSnapshot(dialog);
      const reminders = ['A', 'B', 'C'].map((content) =>
        dialog.addReminder(content, undefined, undefined, undefined, {
          scope: 'dialog',
          renderMode: 'markdown',
        }),
      );
      await dialog.processReminderUpdates();
      const [a, b, c] = reminders;
      assert.ok(a && b && c);
      const first = await deleteReminderTool.call(dialog, reminderCaller, { reminder_id: a.id });
      assert.equal(first.outcome, 'success');
      const third = await deleteReminderTool.call(dialog, reminderCaller, { reminder_id: c.id });
      assert.equal(third.outcome, 'success');
      const projection = await dialog.processReminderUpdates();
      assert.deepEqual(
        dialog.reminders
          .filter((row) => reminders.some((given) => given.id === row.id))
          .map((row) => ({ id: row.id, content: row.content })),
        [{ id: b.id, content: 'B' }],
      );
      assert.deepEqual(
        projection
          .filter((row) => reminders.some((given) => given.id === row.reminder_id))
          .map((row) => ({ id: row.reminder_id, content: row.content })),
        [{ id: b.id, content: 'B' }],
      );
      const disk = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
      assert.deepEqual(
        disk
          .filter((row) => reminders.some((given) => given.id === row.id))
          .map((row) => ({ id: row.id, content: row.content })),
        [{ id: b.id, content: 'B' }],
      );
      const after = await manualReminderSnapshot(dialog);
      assert.deepEqual(
        after.memory.filter((row) => row.id !== b.id),
        fixedBefore.memory,
      );
      assert.deepEqual(
        after.disk.filter((row) => row.id !== b.id),
        fixedBefore.disk,
      );
      const repeated = await deleteReminderTool.call(dialog, reminderCaller, { reminder_id: c.id });
      assert.equal(repeated.outcome, 'failure');
      assert.deepEqual(await manualReminderSnapshot(dialog), after);
      evidence.record({
        id: language + '-stable-id-deletions',
        scenario:
          'Deleting A changes array positions; deleting C by its original stable ID still preserves B and all fixed reminder data. Repeating deleted C is refused without changing state.',
        businessValue:
          'Allow multiple reminder edits from a previously observed ID list without deleting unrelated work.',
        context: {
          language,
          supplied: JSON.stringify(reminders.map(({ id, content }) => ({ id, content }))),
          remaining: b.id,
          scope:
            'Actual handlers, projection and disk after reconciliation; no concurrent process or restart is claimed.',
        },
        reviewQuestions: [
          'Do the two actual success receipts and final missing-ID refusal match the observed effects without presenting a positional range or a false successful repeat?',
        ],
        actualText: JSON.stringify({ first, third, repeated }, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Stable reminder IDs across sequential deletion and persistence: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Stable-ID reminder case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
