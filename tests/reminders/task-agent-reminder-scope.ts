import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crc32 } from 'zlib';

import { DialogStore, MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { mutateSharedReminders } from '../../main/shared-reminders';
import type { Team } from '../../main/team';
import { materializeReminder, type ReminderOwner } from '../../main/tool';
import { addReminderTool, deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { withTempCwd } from './daemon-test-utils';

class MemoryDialogStore extends DialogStore {}

function createDialog(agentId: string, taskDocPath = 'task-agent-reminder-scope.tsk'): MainDialog {
  return new MainDialog(new MemoryDialogStore(), taskDocPath, undefined, agentId);
}

function taskStorageKey(taskDocPath: string): string {
  const normalized = taskDocPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return `crc32-${((crc32(normalized) >>> 0).toString(16) as string).padStart(8, '0')}`;
}

async function main(): Promise<void> {
  await withTempCwd('dominds-task-agent-reminder-', async (sandboxDir) => {
    const caller = {} as Team.Member;
    const taskDocPath = 'task-agent-reminder-scope.tsk';
    const otherTaskDocPath = 'other-task-agent-reminder-scope.tsk';
    const autoOwnerName = 'task-agent-reminder-scope-auto-owner';
    const registeredRuntimeDialogs: MainDialog[] = [];
    const registerRuntimeDialog = (dialog: MainDialog): void => {
      globalDialogRegistry.register(dialog);
      registeredRuntimeDialogs.push(dialog);
    };

    try {
      const dialogA = new MainDialog(new MemoryDialogStore(), taskDocPath, undefined, 'tester', {
        reminders: [
          materializeReminder({
            id: 'dialog001',
            content: 'Older dialog reminder',
            createdAt: '2026-03-30T00:00:00.000Z',
          }),
        ],
      });
      registerRuntimeDialog(dialogA);

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
      registerRuntimeDialog(dialogB);
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
      registerRuntimeDialog(dialogOtherTask);
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
      assert.match(
        updateOutput,
        /Dispatched notices to 1\/1 affected parallel dialog/,
        'Expected task-scoped update result to report dispatch to same-task peer dialog',
      );
      assert.ok(
        dialogA.peekQueuedPrompt()?.prompt.includes(`reminder_id=${taskReminder.id}`),
        'Expected same-task peer dialog to receive a runtime guide prompt for shared reminder update',
      );
      assert.equal(
        dialogOtherTask.peekQueuedPrompt(),
        undefined,
        'Expected different-task dialog not to receive task-scoped update impact prompt',
      );
      const manualUpdatePrompt = dialogA.takeQueuedPrompt();
      assert.ok(manualUpdatePrompt, 'Expected manual shared update prompt to be queued');

      const autoOwner: ReminderOwner = {
        name: autoOwnerName,
        async updateReminder(_dlg, reminder) {
          if (reminder.content === 'Owner refreshed shared state') {
            return { treatment: 'keep' };
          }
          return {
            treatment: 'update',
            updatedContent: 'Owner refreshed shared state',
            updatedMeta: { ownerUpdated: true },
          };
        },
        async renderReminder(_dlg, reminder) {
          return {
            type: 'transient_guide_msg',
            role: 'assistant',
            content: reminder.content,
          };
        },
      };
      registerReminderOwner(autoOwner);
      await mutateSharedReminders(
        { kind: 'task', agentId: 'tester', taskDocPath },
        (sharedReminders) => {
          sharedReminders.push(
            materializeReminder({
              id: 'owner001',
              content: 'Owner stale shared state',
              owner: autoOwner,
              scope: 'task',
              createdAt: '2026-03-30T00:00:01.000Z',
            }),
          );
        },
      );
      await dialogB.processReminderUpdates();
      assert.ok(
        dialogA.peekQueuedPrompt()?.prompt.includes('reminder_id=owner001'),
        'Expected owner-driven shared reminder update to notify same-task loaded peer dialog',
      );
      assert.equal(
        dialogOtherTask.peekQueuedPrompt(),
        undefined,
        'Expected owner-driven task reminder update not to notify different-task dialog',
      );
      const autoUpdatedReminder = (await dialogB.listVisibleReminders()).find(
        (reminder) => reminder.id === 'owner001',
      );
      assert.equal(autoUpdatedReminder?.content, 'Owner refreshed shared state');
      const updatedReminder = (await dialogB.listVisibleReminders()).find(
        (reminder) => reminder.id === taskReminder.id,
      );
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
      const ownerUpdatePrompt = dialogA.takeQueuedPrompt();
      assert.ok(ownerUpdatePrompt, 'Expected owner-driven shared update prompt to be queued');

      const updateAgentOutput = (
        await updateReminderTool.call(dialogOtherTask, caller, {
          reminder_id: agentReminder.id,
          content: 'Urgent: confirm twice before deleting external resources',
        })
      ).content;
      assert.match(updateAgentOutput, /Updated|已更新/);
      assert.match(
        updateAgentOutput,
        /Dispatched notices to 2\/2 affected parallel dialog/,
        'Expected agent-scoped update result to report dispatch to same-agent loaded dialogs',
      );
      assert.ok(
        dialogA.peekQueuedPrompt()?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected same-agent same-task dialog to receive agent-scope update impact prompt',
      );
      assert.ok(
        dialogB.peekQueuedPrompt()?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected same-agent different-loaded-dialog to receive agent-scope update impact prompt',
      );
      const agentUpdatePromptA = dialogA.takeQueuedPrompt();
      const agentUpdatePromptB = dialogB.takeQueuedPrompt();
      assert.ok(agentUpdatePromptA, 'Expected dialogA agent-scope prompt to be queued');
      assert.ok(agentUpdatePromptB, 'Expected dialogB agent-scope prompt to be queued');

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
      const visibleAfterTaskDelete = await dialogB.listVisibleReminders();
      assert.equal(
        visibleAfterTaskDelete.some((reminder) => reminder.id === taskReminder.id),
        false,
        'Expected the deleted task reminder to disappear',
      );
      assert.ok(
        visibleAfterTaskDelete.some((reminder) => reminder.id === 'owner001'),
        'Expected the owner-maintained task reminder to remain visible',
      );
      assert.ok(
        visibleAfterTaskDelete.some((reminder) => reminder.id === agentReminder.id),
        'Expected the agent-scoped reminder to remain visible',
      );

      const deleteAgentOutput = (
        await deleteReminderTool.call(dialogOtherTask, caller, {
          reminder_id: agentReminder.id,
        })
      ).content;
      assert.match(deleteAgentOutput, /Deleted|已删除/);
      assert.equal((await dialogOtherTask.listVisibleReminders()).length, 0);
    } finally {
      unregisterReminderOwner(autoOwnerName);
      for (const dialog of registeredRuntimeDialogs) {
        globalDialogRegistry.unregister(dialog.id.rootId);
      }
    }
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
