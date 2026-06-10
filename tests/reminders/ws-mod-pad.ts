import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { formatReminderMaintenanceReference } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import {
  materializeReminder,
  serializeReminderContentMeta,
  serializeReminderMaintenanceMeta,
  validateArgs,
} from '../../main/tool';
import { deleteReminderTool } from '../../main/tools/ctrl';
import {
  applyFileModificationTool,
  padCopyTool,
  padDeleteRangeTool,
  padDeleteTool,
  padEditTool,
  padInsertTool,
  padLoadFileRangeTool,
  padMoveTool,
  padPrepareFileRangeEditTool,
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
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-ws-mod-pad-'));
  process.chdir(tmpRoot);
  setWorkLanguage('zh');
  try {
    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'reminders-ws-mod-pad.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });
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
    const fullFileLoadArgs = validateArgs(padLoadFileRangeTool.parameters, {
      pad_id: 'whole_file',
      path: 'whole.txt',
    });
    assert.equal(
      fullFileLoadArgs.ok,
      true,
      'pad_load_file_range should allow omitted range for full-file load',
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

    const insertOutput = (
      await padInsertTool.call(dlg, caller, {
        pad_id: 'draft1',
        line: 2,
        content: 'INSERTED_BODY_TOKEN\n',
      })
    ).content;
    assert.ok(insertOutput.includes('status: ok'));
    assert.ok(
      !insertOutput.includes('INSERTED_BODY_TOKEN'),
      'pad_insert result must not echo inserted body',
    );
    assert.equal(getPadText(dlg.reminders[0]), `${secret}\nINSERTED_BODY_TOKEN\nchanged\n`);

    const copyOutput = (
      await padCopyTool.call(dlg, caller, {
        from_pad_id: 'draft1',
        from_range: '1~1',
        to_pad_id: 'draft2',
      })
    ).content;
    assert.ok(copyOutput.includes('status: ok'));
    assert.ok(!copyOutput.includes(secret), 'pad_copy result must not echo copied body');
    assert.equal(getPadText(dlg.reminders[1]), `${secret}\n`);

    const moveOutput = (
      await padMoveTool.call(dlg, caller, {
        from_pad_id: 'draft1',
        from_range: '3~3',
        to_pad_id: 'draft2',
        to_range: '2~',
      })
    ).content;
    assert.ok(moveOutput.includes('status: ok'));
    assert.ok(!moveOutput.includes('changed'), 'pad_move result must not echo moved body');
    assert.equal(getPadText(dlg.reminders[0]), `${secret}\nINSERTED_BODY_TOKEN\n`);
    assert.equal(getPadText(dlg.reminders[1]), `${secret}\nchanged\n`);

    const deleteRangeOutput = (
      await padDeleteRangeTool.call(dlg, caller, {
        pad_id: 'draft2',
        range: '1~1',
      })
    ).content;
    assert.ok(deleteRangeOutput.includes('status: ok'));
    assert.ok(
      !deleteRangeOutput.includes(secret),
      'pad_delete_range result must not echo remaining body',
    );
    assert.equal(getPadText(dlg.reminders[1]), 'changed\n');

    const fullFileToken = 'FULL_FILE_LOAD_TOKEN';
    await fs.writeFile(path.join(tmpRoot, 'whole.txt'), `alpha\n${fullFileToken}\nomega\n`, 'utf8');
    const fullFileLoadOutput = (
      await padLoadFileRangeTool.call(dlg, caller, {
        pad_id: 'whole_file',
        path: 'whole.txt',
        mode: 'create',
      })
    ).content;
    assert.ok(fullFileLoadOutput.includes('status: ok'));
    assert.ok(
      !fullFileLoadOutput.includes(fullFileToken),
      'pad_load_file_range full-file result must not echo file body',
    );
    assert.equal(getPadText(dlg.reminders[2]), `alpha\n${fullFileToken}\nomega\n`);
    await padDeleteTool.call(dlg, caller, { pad_id: 'whole_file' });

    await fs.writeFile(path.join(tmpRoot, 'target.txt'), 'old1\nold2\n', 'utf8');
    const padPrepareOutput = (
      await padPrepareFileRangeEditTool.call(dlg, caller, {
        pad_id: 'draft2',
        pad_range: '1~1',
        path: 'target.txt',
        range: '2~2',
      })
    ).content;
    assert.ok(padPrepareOutput.includes('mode: pad_prepare_file_range_edit'));
    assert.ok(
      !padPrepareOutput.includes('changed'),
      'pad_prepare_file_range_edit result must not echo selected pad body',
    );
    assert.ok(
      !padPrepareOutput.includes('```diff'),
      'pad_prepare_file_range_edit result must not echo a diff containing pad body',
    );
    const hunkIdMatch = padPrepareOutput.match(/hunk_id: '([^']+)'/);
    const hunkId = hunkIdMatch === null ? undefined : hunkIdMatch[1];
    assert.equal(typeof hunkId, 'string', 'pad_prepare_file_range_edit should return hunk_id');
    const applyOutput = (await applyFileModificationTool.call(dlg, caller, { hunk_id: hunkId }))
      .content;
    assert.ok(applyOutput.includes('status: ok'));
    assert.ok(!applyOutput.includes('changed'), 'apply_file_modification should not echo pad body');
    assert.equal(await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'), 'old1\nchanged\n');

    await fs.writeFile(path.join(tmpRoot, 'target-append.txt'), 'head1\nhead2\n', 'utf8');
    const appendPrepareOutput = (
      await padPrepareFileRangeEditTool.call(dlg, caller, {
        pad_id: 'draft2',
        pad_range: '1~1',
        path: 'target-append.txt',
        range: '3~',
      })
    ).content;
    assert.ok(
      !appendPrepareOutput.includes('changed'),
      'pad_prepare_file_range_edit append result must not echo selected pad body',
    );
    const appendHunkIdMatch = appendPrepareOutput.match(/hunk_id: '([^']+)'/);
    const appendHunkId = appendHunkIdMatch === null ? undefined : appendHunkIdMatch[1];
    assert.equal(
      typeof appendHunkId,
      'string',
      'pad_prepare_file_range_edit append should return hunk_id',
    );
    const appendApplyOutput = (
      await applyFileModificationTool.call(dlg, caller, { hunk_id: appendHunkId })
    ).content;
    assert.ok(appendApplyOutput.includes('status: ok'));
    assert.ok(
      !appendApplyOutput.includes('changed'),
      'apply_file_modification append should not echo pad body',
    );
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target-append.txt'), 'utf8'),
      'head1\nhead2\nchanged\n',
    );

    await padDeleteTool.call(dlg, caller, { pad_id: 'draft2' });
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
    const brokenDeleteOutput = (await padDeleteTool.call(dlg, caller, { pad_id: 'broken1' }))
      .content;
    assert.ok(brokenDeleteOutput.includes('status: ok'));
    assert.equal(dlg.reminders.length, 0, 'pad_delete should clean unreadable pad metadata by id');

    console.log('✓ ws_mod pad reminder contract test passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
