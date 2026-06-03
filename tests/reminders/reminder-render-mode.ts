import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

import { DialogStore, MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import type { Team } from '../../main/team';
import { addReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import { withTempCwd } from './daemon-test-utils';

function createDialog(agentId: string): MainDialog {
  return new MainDialog(new DialogStore(), 'reminder-render-mode.tsk', undefined, agentId);
}

async function main(): Promise<void> {
  await withTempCwd('dominds-reminder-render-mode-', async () => {
    const dlg = createDialog('tester');
    const caller = {} as Team.Member;

    await addReminderTool.call(dlg, caller, {
      content: '**Keep** this as markdown',
      scope: 'dialog',
    });
    const markdownReminder = dlg.reminders[0];
    assert.equal(markdownReminder?.renderMode, 'markdown');

    await updateReminderTool.call(dlg, caller, {
      reminder_id: markdownReminder?.id,
      content: '**Still** markdown after update',
    });
    assert.equal(dlg.reminders[0]?.renderMode, 'markdown');

    await addReminderTool.call(dlg, caller, {
      content: '**Literal asterisks wanted**',
      scope: 'dialog',
      render_mode: 'plain',
    });
    const plainReminder = dlg.reminders[1];
    assert.equal(plainReminder?.renderMode, 'plain');

    const reminders = await dlg.processReminderUpdates();
    const markdownContent = reminders.find((item) => item.reminder_id === markdownReminder?.id);
    const plainContent = reminders.find((item) => item.reminder_id === plainReminder?.id);
    assert.equal(markdownContent?.renderMode, 'markdown');
    assert.equal(plainContent?.renderMode, 'plain');

    // This test constructs an in-memory dialog without the normal persistence bootstrap, so we
    // create the fixture directory explicitly here. Production reminder persistence must not
    // backfill missing dialog directories, because that would mask stale-path/status bugs.
    await fs.mkdir(DialogPersistence.getDialogEventsPath(dlg.id, dlg.status), { recursive: true });
    await DialogPersistence._saveReminderState(dlg.id, dlg.reminders, dlg.status);
    const persisted = await DialogPersistence.loadReminderState(dlg.id, dlg.status);
    const persistedMarkdown = persisted.find((item) => item.id === markdownReminder?.id);
    const persistedPlain = persisted.find((item) => item.id === plainReminder?.id);
    assert.equal(persistedMarkdown?.renderMode, 'markdown');
    assert.equal(persistedPlain?.renderMode, 'plain');
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
