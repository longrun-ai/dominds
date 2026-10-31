import assert from 'node:assert/strict';
import { materializeReminder } from '../../main/tool';
import { updateReminderTool } from '../../main/tools/ctrl';
import {
  manualReminderSnapshot,
  reminderCaller,
  withManualReminderDialog,
} from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-reminder-guard-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const reminder = materializeReminder({
        content: 'auto reminder',
        meta: {
          update: {
            altInstruction:
              language === 'zh'
                ? '等待系统自动刷新'
                : 'Wait for the system to refresh it automatically.',
          },
        },
        scope: 'dialog',
        renderMode: 'markdown',
        createdAt: '2001-01-01 00:00:00',
        priority: 'medium',
      });
      dialog.reminders.push(reminder);
      dialog.touchReminders();
      await dialog.processReminderUpdates();
      const input = { reminder_id: reminder.id, content: 'manually edited content' };
      const before = await manualReminderSnapshot(dialog);
      const output = await updateReminderTool.call(dialog, reminderCaller, input);
      assert.equal(output.outcome, 'failure');
      assert.deepEqual(await manualReminderSnapshot(dialog), before);
      const ordinary = dialog.addReminder(
        'ordinary editable data',
        undefined,
        undefined,
        undefined,
        { scope: 'dialog', renderMode: 'plain' },
      );
      const control = await updateReminderTool.call(dialog, reminderCaller, {
        reminder_id: ordinary.id,
        content: 'ordinary updated data',
      });
      assert.equal(control.outcome, 'success');
      await dialog.processReminderUpdates();
      const afterControl = await manualReminderSnapshot(dialog);
      assert.deepEqual(
        afterControl.memory.find((row) => row.id === reminder.id),
        before.memory.find((row) => row.id === reminder.id),
      );
      assert.deepEqual(
        afterControl.disk.find((row) => row.id === reminder.id),
        before.disk.find((row) => row.id === reminder.id),
      );
      assert.equal(
        afterControl.memory.find((row) => row.id === ordinary.id)?.content,
        'ordinary updated data',
      );
      assert.equal(
        afterControl.disk.find((row) => row.id === ordinary.id)?.content,
        'ordinary updated data',
      );
      assert.equal(afterControl.memory.find((row) => row.id === ordinary.id)?.renderMode, 'plain');
      evidence.record({
        id: language + '-update-reminder-meta-guard',
        scenario:
          'The supplied reminder metadata declares an alternative update channel; the manual tool refuses and preserves all public reminder data and disk state.',
        businessValue:
          'Refuse an inapplicable manual mutation without losing work state, and explain an accurate repair or maintenance path.',
        context: {
          input: JSON.stringify(input),
          givenManagedReminder: JSON.stringify(before.memory.find((row) => row.id === reminder.id)),
          ordinaryControl: JSON.stringify({
            id: ordinary.id,
            given: 'ordinary editable data',
            expected: 'ordinary updated data',
          }),
          language,
          scope:
            'Real Dialog, tool handler and disk. The declared daemon command/refresh instruction is fixture metadata, not an executed daemon or owner capability.',
        },
        reviewQuestions: [
          'Does the actual refusal describe this missing or managed target accurately, with a useful remedy and no false claim that the managed mutation or maintenance action succeeded, while the ordinary control receipt agrees with the observed successful edit?',
        ],
        actualText: JSON.stringify({ refused: output, ordinaryControl: control }, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Manual reminder refusal and state preservation: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Reminder guard did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
