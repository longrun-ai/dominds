import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { crc32 } from 'zlib';

import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import { materializeReminder } from '../../main/tool';
import { addReminderTool, deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-task-agent-reminder-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string, taskDocPath = 'task-agent-reminder-scope.tsk'): MainDialog {
  return new MainDialog({} as unknown as DialogStore, taskDocPath, undefined, agentId);
}

function taskStorageKey(taskDocPath: string): string {
  const normalized = taskDocPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return `crc32-${((crc32(normalized) >>> 0).toString(16) as string).padStart(8, '0')}`;
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    const caller = {} as Team.Member;
    const taskDocPath = 'task-agent-reminder-scope.tsk';
    const otherTaskDocPath = 'other-task-agent-reminder-scope.tsk';
    const dialogA = new MainDialog({} as unknown as DialogStore, taskDocPath, undefined, 'tester', {
      reminders: [
        materializeReminder({
          id: 'dialog001',
          content: 'Older dialog reminder',
          createdAt: '2026-03-30T00:00:00.000Z',
        }),
      ],
    });

    const addOutput = (
      await addReminderTool.call(dialogA, caller, {
        content: 'Remember the preferred deploy smoke-check command for this task',
      })
    ).content;
    assert.match(addOutput, /Added|已添加/);
    assert.equal(
      dialogA.reminders.length,
      1,
      'Expected default task reminder not to live in dialog-local array',
    );

    const visibleA = await dialogA.listVisibleReminders();
    assert.equal(visibleA.length, 2, 'Expected dialog and task reminders to both be visible');
    const taskReminder = visibleA.find((reminder) => reminder.scope === 'task');
    assert.ok(taskReminder, 'Expected task reminder to exist');
    assert.ok(taskReminder.id, 'Expected task reminder id to exist');
    assert.equal(
      visibleA[1]?.id,
      'dialog001',
      'Expected newer task reminder to sort ahead of older dialog reminder',
    );

    const taskPersistedPath = path.join(
      sandboxDir,
      '.dialogs',
      'reminders',
      'agent_tasks',
      'tester',
      taskStorageKey(taskDocPath),
      `${taskReminder.id}.json`,
    );
    const taskPersistedRaw = await fs.readFile(taskPersistedPath, 'utf-8');
    assert.match(taskPersistedRaw, /"scope": "task"/);

    const dialogB = createDialog('tester', taskDocPath);
    const visibleB = await dialogB.listVisibleReminders();
    assert.equal(
      visibleB[0]?.id,
      taskReminder.id,
      'Expected another dialog of the same agent and Taskdoc to see the same task reminder',
    );
    assert.equal(
      visibleB.length,
      1,
      'Expected only task-scoped reminder to be visible in fresh dialog for the same Taskdoc',
    );

    const dialogOtherTask = createDialog('tester', otherTaskDocPath);
    assert.equal(
      (await dialogOtherTask.listVisibleReminders()).length,
      0,
      'Expected same agent with a different Taskdoc not to see task-scoped reminder',
    );

    const updateOutput = (
      await updateReminderTool.call(dialogB, caller, {
        reminder_id: taskReminder.id,
        content: 'Remember the updated deploy smoke-check command',
      })
    ).content;
    assert.match(updateOutput, /Updated|已更新/);
    const updatedReminder = (await dialogB.listVisibleReminders())[0];
    assert.equal(updatedReminder?.content, 'Remember the updated deploy smoke-check command');
    assert.equal(updatedReminder?.scope, 'task');

    const addAgentOutput = (
      await addReminderTool.call(dialogA, caller, {
        content: 'Urgent: confirm before deleting external resources',
        scope: 'agent',
      })
    ).content;
    assert.match(addAgentOutput, /Added|已添加/);
    const agentReminder = (await dialogOtherTask.listVisibleReminders()).find(
      (reminder) => reminder.scope === 'agent',
    );
    assert.ok(
      agentReminder,
      'Expected same agent with a different Taskdoc to see agent-scoped reminder',
    );
    const agentPersistedPath = path.join(
      sandboxDir,
      '.dialogs',
      'reminders',
      'agents',
      'tester',
      `${agentReminder.id}.json`,
    );
    const agentPersistedRaw = await fs.readFile(agentPersistedPath, 'utf-8');
    assert.match(agentPersistedRaw, /"scope": "agent"/);

    assert.equal(
      (await createDialog('other-agent', taskDocPath).listVisibleReminders()).length,
      0,
      'Expected another agent not to see tester task/agent reminders',
    );

    const deleteOutput = (
      await deleteReminderTool.call(dialogB, caller, {
        reminder_id: taskReminder.id,
      })
    ).content;
    assert.match(deleteOutput, /Deleted|已删除/);
    assert.equal((await dialogB.listVisibleReminders()).length, 1);

    const deleteAgentOutput = (
      await deleteReminderTool.call(dialogOtherTask, caller, {
        reminder_id: agentReminder.id,
      })
    ).content;
    assert.match(deleteAgentOutput, /Deleted|已删除/);
    assert.equal((await dialogOtherTask.listVisibleReminders()).length, 0);
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
