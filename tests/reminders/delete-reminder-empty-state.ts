import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { deleteReminderTool } from '../../main/tools/ctrl';

async function runCase(language: 'zh' | 'en', expectedSubstring: string): Promise<void> {
  setWorkLanguage(language);
  const dlg = new RootDialog(
    {} as unknown as DialogStore,
    'reminders-empty-state.tsk',
    undefined,
    'tester',
  );
  const output = await deleteReminderTool.call(dlg, {} as Team.Member, { reminder_no: 1 });

  assert.ok(
    output.includes(expectedSubstring),
    `Expected output to include "${expectedSubstring}", got: ${output}`,
  );
  assert.ok(!output.includes('1-0'), `Output should not include "1-0", got: ${output}`);
}

async function main(): Promise<void> {
  await runCase('zh', '当前没有提醒');
  await runCase('en', 'There are no reminders');
  console.log('✓ delete_reminder empty-state message test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
