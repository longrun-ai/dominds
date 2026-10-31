import assert from 'node:assert/strict';
import { deleteReminderTool } from '../../main/tools/ctrl';
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
      const input = { reminder_id: 'missing-id' };
      const before = await manualReminderSnapshot(dialog);
      const output = await deleteReminderTool.call(dialog, reminderCaller, input);
      assert.equal(output.outcome, 'failure');
      assert.deepEqual(await manualReminderSnapshot(dialog), before);
      evidence.record({
        id: language + '-delete-reminder-empty-state',
        scenario:
          'The manual reminder collection is empty; deleting an absent stable ID is refused without changing the fixed Goal or persisted reminder state.',
        businessValue:
          'Refuse an inapplicable manual mutation without losing work state, and explain an accurate repair or maintenance path.',
        context: {
          input: JSON.stringify(input),
          language,
          scope:
            'Real Dialog, tool handler and disk. The declared daemon command/refresh instruction is fixture metadata, not an executed daemon or owner capability.',
        },
        reviewQuestions: [
          'Does the actual refusal describe this missing or managed target accurately, with a useful remedy and no claim that a mutation or maintenance action succeeded?',
        ],
        actualText: output.content,
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
