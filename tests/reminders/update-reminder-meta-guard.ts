import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import { updateReminderTool } from '../../main/tools/ctrl';

async function runCase(language: 'zh' | 'en', expectedSubstring: string): Promise<void> {
  setWorkLanguage(language);
  const dlg = new RootDialog(
    {} as unknown as DialogStore,
    'reminders-update-meta-guard.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('auto reminder', undefined, {
    update: {
      altInstruction: expectedSubstring,
    },
  });
  const reminderId = dlg.reminders[0]?.id;
  assert.equal(typeof reminderId, 'string');

  const output = await updateReminderTool.call(dlg, {} as Team.Member, {
    reminder_id: reminderId,
    content: 'manually edited content',
  });

  assert.ok(
    output.includes(expectedSubstring),
    `Expected output to include "${expectedSubstring}", got: ${output}`,
  );
  assert.equal(
    dlg.reminders[0]?.content,
    'auto reminder',
    'Expected update_reminder guard to preserve the reminder content',
  );
}

async function main(): Promise<void> {
  await runCase('zh', '等待系统自动刷新');
  await runCase('en', 'Wait for the system to refresh it automatically.');
  console.log('✓ update_reminder meta guard test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
