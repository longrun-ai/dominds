import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { formatReminderMaintenanceReference } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import {
  materializeReminder,
  serializeReminderContentMeta,
  serializeReminderMaintenanceMeta,
  validateArgs,
} from '../../main/tool';
import { deleteReminderTool } from '../../main/tools/ctrl';
import {
  padDeleteTool,
  padEditTool,
  padLoadFileRangeTool,
  padWriteTool,
  wsModPadReminderOwner,
} from '../../main/tools/txt';

function getPadText(reminder: unknown): string {
  if (typeof reminder !== 'object' || reminder === null || Array.isArray(reminder)) {
    throw new Error('Reminder must be an object');
  }
  const meta = (reminder as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error('Reminder meta must be an object');
  }
  const text = (meta as { text?: unknown }).text;
  if (typeof text !== 'string') {
    throw new Error('Reminder meta.text must be a string');
  }
  return text;
}

async function main(): Promise<void> {
  setWorkLanguage('zh');
  const dlg = new MainDialog(
    {} as unknown as DialogStore,
    'reminders-ws-mod-pad.tsk',
    undefined,
    'tester',
  );
  const caller = {} as Team.Member;
  const secret = 'SECRET_BODY_FOR_WS_MOD_PAD_TEST';

  const emptyModeWriteArgs = validateArgs(padWriteTool.parameters, {
    pad_id: 'draft1',
    content: secret,
    mode: '',
  });
  assert.equal(emptyModeWriteArgs.ok, true, 'pad_write should accept empty-string default mode');

  const emptyModeLoadArgs = validateArgs(padLoadFileRangeTool.parameters, {
    pad_id: 'draft1',
    path: 'main/tool.ts',
    range: '1~1',
    mode: '',
  });
  assert.equal(
    emptyModeLoadArgs.ok,
    true,
    'pad_load_file_range should accept empty-string default mode',
  );

  const writeOutput = (
    await padWriteTool.call(dlg, caller, {
      pad_id: 'draft1',
      content: `${secret}\nline2\n`,
      mode: '',
    })
  ).content;
  assert.ok(writeOutput.includes('status: ok'));
  assert.ok(!writeOutput.includes(secret), 'pad_write result must not echo pad body');

  const reminder = dlg.reminders[0];
  assert.ok(reminder, 'pad_write should create a reminder-backed pad');
  assert.equal(
    serializeReminderContentMeta(reminder),
    undefined,
    'frontend reminder snapshots must not include pad private metadata',
  );

  const rendered = await wsModPadReminderOwner.renderReminder(dlg, reminder);
  assert.ok(!rendered.content.includes(secret), 'role=user pad projection must not include body');
  assert.ok(
    !rendered.content.includes('pad_delete('),
    'role=user pad projection must not include executable delete text',
  );

  const maintenanceReference = formatReminderMaintenanceReference('zh', [
    {
      id: reminder.id,
      meta: serializeReminderMaintenanceMeta(reminder),
    },
  ]);
  assert.ok(maintenanceReference, 'pad should have maintenance guidance');
  assert.ok(
    maintenanceReference.includes('pad_delete({ "pad_id": "draft1" })'),
    'role=assistant maintenance reference should expose pad_delete',
  );
  assert.ok(
    !maintenanceReference.includes(secret),
    'role=assistant maintenance reference must not include pad body',
  );

  const manualDeleteOutput = (
    await deleteReminderTool.call(dlg, caller, { reminder_id: reminder.id })
  ).content;
  assert.ok(
    manualDeleteOutput.includes('pad_delete({ "pad_id": "draft1" })'),
    'delete_reminder should refuse managed pad deletion and point to pad_delete',
  );
  assert.equal(dlg.reminders.length, 1, 'delete_reminder must not delete the pad');

  const editOutput = (
    await padEditTool.call(dlg, caller, {
      pad_id: 'draft1',
      range: '2~2',
      content: 'changed\n',
    })
  ).content;
  assert.ok(editOutput.includes('status: ok'));
  assert.ok(!editOutput.includes('changed'), 'pad_edit result must not echo edited body');
  assert.equal(getPadText(dlg.reminders[0]), `${secret}\nchanged\n`);

  const deleteOutput = (await padDeleteTool.call(dlg, caller, { pad_id: 'draft1' })).content;
  assert.ok(deleteOutput.includes('status: ok'));
  assert.equal(dlg.reminders.length, 0, 'pad_delete should remove the pad');

  dlg.reminders.push(
    materializeReminder({
      id: 'pad_broken1',
      content: 'broken pad',
      owner: wsModPadReminderOwner,
      meta: { kind: 'ws_mod_pad' },
      scope: 'dialog',
      renderMode: 'markdown',
    }),
  );
  const brokenDeleteOutput = (await padDeleteTool.call(dlg, caller, { pad_id: 'broken1' })).content;
  assert.ok(brokenDeleteOutput.includes('status: ok'));
  assert.equal(dlg.reminders.length, 0, 'pad_delete should clean unreadable pad metadata by id');

  console.log('✓ ws_mod pad reminder contract test passed');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
