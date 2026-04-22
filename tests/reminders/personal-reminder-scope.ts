import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import { materializeReminder } from '../../main/tool';
import { addReminderTool, deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-personal-reminder-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    {} as unknown as DialogStore,
    'personal-reminder-scope.tsk',
    undefined,
    agentId,
  );
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    const caller = {} as Team.Member;
    const dialogA = new MainDialog(
      {} as unknown as DialogStore,
      'personal-reminder-scope.tsk',
      undefined,
      'tester',
      {
        reminders: [
          materializeReminder({
            id: 'dialog001',
            content: 'Older dialog reminder',
            createdAt: '2026-03-30T00:00:00.000Z',
          }),
        ],
      },
    );

    const addOutput = (
      await addReminderTool.call(dialogA, caller, {
        content: 'Remember the preferred deploy smoke-check command',
        scope: 'personal',
      })
    ).content;
    assert.match(addOutput, /Added|已添加/);
    assert.equal(
      dialogA.reminders.length,
      1,
      'Expected personal reminder not to live in dialog-local array',
    );

    const visibleA = await dialogA.listVisibleReminders();
    assert.equal(visibleA.length, 2, 'Expected dialog and personal reminders to both be visible');
    const personalReminder = visibleA[0];
    assert.equal(personalReminder?.scope, 'personal');
    assert.ok(personalReminder?.id, 'Expected personal reminder id to exist');
    assert.equal(
      visibleA[1]?.id,
      'dialog001',
      'Expected newer personal reminder to sort ahead of older dialog reminder',
    );

    const persistedPath = path.join(
      sandboxDir,
      '.dialogs',
      'reminders',
      'tester',
      `${personalReminder.id}.json`,
    );
    const persistedRaw = await fs.readFile(persistedPath, 'utf-8');
    assert.match(persistedRaw, /"scope": "personal"/);

    const dialogB = createDialog('tester');
    const visibleB = await dialogB.listVisibleReminders();
    assert.equal(
      visibleB[0]?.id,
      personalReminder.id,
      'Expected another dialog of the same agent to see the same personal reminder',
    );
    assert.equal(
      visibleB.length,
      1,
      'Expected only shared personal reminder to be visible in fresh dialog',
    );

    const updateOutput = (
      await updateReminderTool.call(dialogB, caller, {
        reminder_id: personalReminder.id,
        content: 'Remember the updated deploy smoke-check command',
      })
    ).content;
    assert.match(updateOutput, /Updated|已更新/);
    const updatedReminder = (await dialogB.listVisibleReminders())[0];
    assert.equal(updatedReminder?.content, 'Remember the updated deploy smoke-check command');
    assert.equal(updatedReminder?.scope, 'personal');

    const deleteOutput = (
      await deleteReminderTool.call(dialogB, caller, {
        reminder_id: personalReminder.id,
      })
    ).content;
    assert.match(deleteOutput, /Deleted|已删除/);
    assert.equal((await dialogB.listVisibleReminders()).length, 0);
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
