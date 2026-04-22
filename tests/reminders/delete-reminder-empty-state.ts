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
    'reminders-empty-state.tsk',
    undefined,
    'tester',
  );
  const output = (
    await deleteReminderTool.call(dlg, {} as Team.Member, {
      reminder_id: 'missing-id',
    })
  ).content;

  assert.ok(
    output.includes(expectedSubstring),
    `Expected output to include "${expectedSubstring}", got: ${output}`,
  );
  assert.ok(!output.includes('1-0'), `Output should not include "1-0", got: ${output}`);
}

async function main(): Promise<void> {
  await runCase('zh', "提醒项 'missing-id' 不存在");
  await runCase('en', "Reminder 'missing-id' does not exist");
  console.log('✓ delete_reminder empty-state message test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
