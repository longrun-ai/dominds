import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crc32 } from 'zlib';

import { DialogStore, MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { MAIN_DIALOG_GOAL_REMINDER_ID } from '../../main/main-dialog-goal-reminder';
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

function withoutMainDialogGoal<T extends Readonly<{ id: string }>>(reminders: readonly T[]): T[] {
  return reminders.filter((reminder) => reminder.id !== MAIN_DIALOG_GOAL_REMINDER_ID);
}

async function main(): Promise<void> {
  await withTempCwd('dominds-task-agent-reminder-', async (sandboxDir) => {
    const caller = {} as Team.Member;
    const taskDocPath = 'task-agent-reminder-scope.tsk';
    const otherTaskDocPath = 'other-task-agent-reminder-scope.tsk';
    const autoOwnerName = 'task-agent-reminder-scope-auto-owner';
    const registeredRuntimeDialogs: MainDialog[] = [];
    let releaseActiveMainPeer: (() => void) | undefined;
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
            scope: 'dialog',
            renderMode: 'markdown',
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

      const visibleA = withoutMainDialogGoal(await dialogA.listVisibleReminders());
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
      const visibleB = withoutMainDialogGoal(await dialogB.listVisibleReminders());
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
        withoutMainDialogGoal(await dialogOtherTask.listVisibleReminders()).length,
        0,
        'Expected same agent with a different Taskdoc not to see task-scoped reminder',
      );

      const updateOutput = (
        await updateReminderTool.call(dialogB, caller, {
          reminder_id: taskReminder.id,
          content: 'Remember the loaded-only deploy smoke-check command',
        })
      ).content;
      assert.match(updateOutput, /Updated|已更新/);
      assert.doesNotMatch(
        updateOutput,
        /Dispatched notices|已向/,
        'Expected no dispatch when the current runtime has no active same-agent peer dialogs',
      );
      assert.equal(
        dialogA.peekQueuedPrompt(),
        undefined,
        'Expected loaded historical same-agent dialog not to receive task update impact prompt',
      );

      const singleActiveRoot = createDialog('mentor-single-active', taskDocPath);
      registerRuntimeDialog(singleActiveRoot);
      const onlyActiveSide = await singleActiveRoot.createSideDialog(
        'tester',
        ['@tester'],
        'Only active same-agent side dialog in this root',
        {
          callName: 'tellask',
          originMemberId: 'mentor-single-active',
          askerDialogId: singleActiveRoot.id.selfId,
          callId: 'call-only-active-side',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      singleActiveRoot.addActiveCalleeDialogs([onlyActiveSide.id]);
      const singleActiveUpdateOutput = (
        await updateReminderTool.call(onlyActiveSide, caller, {
          reminder_id: taskReminder.id,
          content: 'Remember the single-active deploy smoke-check command',
        })
      ).content;
      assert.match(singleActiveUpdateOutput, /Updated|已更新/);
      assert.doesNotMatch(
        singleActiveUpdateOutput,
        /Dispatched notices|已向/,
        'Expected no dispatch when the only active same-agent dialog is the updater itself',
      );
      globalDialogRegistry.unregister(singleActiveRoot.id.rootId);

      const activeRoot = createDialog('mentor', taskDocPath);
      registerRuntimeDialog(activeRoot);
      const activeSideA = await activeRoot.createSideDialog(
        'tester',
        ['@tester'],
        'Active same-agent side dialog A',
        {
          callName: 'tellask',
          originMemberId: 'mentor',
          askerDialogId: activeRoot.id.selfId,
          callId: 'call-active-side-a',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      const activeSideB = await activeRoot.createSideDialog(
        'tester',
        ['@tester'],
        'Active same-agent side dialog B',
        {
          callName: 'tellask',
          originMemberId: 'mentor',
          askerDialogId: activeRoot.id.selfId,
          callId: 'call-active-side-b',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      activeRoot.addActiveCalleeDialogs([activeSideA.id, activeSideB.id]);
      const activeRootSameTaskOtherRoot = createDialog('mentor-other-root', taskDocPath);
      registerRuntimeDialog(activeRootSameTaskOtherRoot);
      const activeSideSameTaskOtherRoot = await activeRootSameTaskOtherRoot.createSideDialog(
        'tester',
        ['@tester'],
        'Active same-agent same-task side dialog in another root',
        {
          callName: 'tellask',
          originMemberId: 'mentor-other-root',
          askerDialogId: activeRootSameTaskOtherRoot.id.selfId,
          callId: 'call-active-side-same-task-other-root',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      activeRootSameTaskOtherRoot.addActiveCalleeDialogs([activeSideSameTaskOtherRoot.id]);
      const activeRootOtherTaskOtherRoot = createDialog('mentor-other-task', otherTaskDocPath);
      registerRuntimeDialog(activeRootOtherTaskOtherRoot);
      const activeSideOtherTaskOtherRoot = await activeRootOtherTaskOtherRoot.createSideDialog(
        'tester',
        ['@tester'],
        'Active same-agent different-task side dialog in another root',
        {
          callName: 'tellask',
          originMemberId: 'mentor-other-task',
          askerDialogId: activeRootOtherTaskOtherRoot.id.selfId,
          callId: 'call-active-side-other-task-other-root',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      activeRootOtherTaskOtherRoot.addActiveCalleeDialogs([activeSideOtherTaskOtherRoot.id]);
      const activeMainPeer = createDialog('tester', taskDocPath);
      registerRuntimeDialog(activeMainPeer);
      releaseActiveMainPeer = await activeMainPeer.acquire();

      const activeUpdateOutput = (
        await updateReminderTool.call(activeSideA, caller, {
          reminder_id: taskReminder.id,
          content: 'Remember the active peer deploy smoke-check command',
        })
      ).content;
      assert.match(activeUpdateOutput, /Updated|已更新/);
      assert.match(
        activeUpdateOutput,
        /Dispatched notices to 3\/3 affected parallel dialog/,
        'Expected task-scoped update result to report dispatch to same-task active peers across roots',
      );
      assert.ok(
        activeSideB.peekQueuedPrompt()?.prompt.includes(`reminder_id=${taskReminder.id}`),
        'Expected active same-root peer dialog to receive shared reminder update prompt',
      );
      assert.ok(
        activeSideSameTaskOtherRoot
          .peekQueuedPrompt()
          ?.prompt.includes(`reminder_id=${taskReminder.id}`),
        'Expected active same-agent same-task peer in another root to receive shared reminder update prompt',
      );
      assert.ok(
        activeMainPeer.peekQueuedPrompt()?.prompt.includes(`reminder_id=${taskReminder.id}`),
        'Expected active same-agent same-task main dialog in another root to receive shared reminder update prompt',
      );
      assert.equal(
        activeSideOtherTaskOtherRoot.peekQueuedPrompt(),
        undefined,
        'Expected active same-agent different-task peer not to receive task-scope update prompt',
      );
      assert.equal(
        dialogA.peekQueuedPrompt(),
        undefined,
        'Expected loaded historical same-agent dialog outside active-callees not to receive prompt',
      );
      assert.equal(
        dialogOtherTask.peekQueuedPrompt(),
        undefined,
        'Expected different-task dialog not to receive task-scoped update impact prompt',
      );
      const manualUpdatePrompt = activeSideB.takeQueuedPrompt();
      const crossRootTaskUpdatePrompt = activeSideSameTaskOtherRoot.takeQueuedPrompt();
      const activeMainTaskUpdatePrompt = activeMainPeer.takeQueuedPrompt();
      assert.ok(manualUpdatePrompt, 'Expected manual shared update prompt to be queued');
      assert.ok(
        crossRootTaskUpdatePrompt,
        'Expected cross-root task shared update prompt to be queued',
      );
      assert.ok(
        activeMainTaskUpdatePrompt,
        'Expected active main task shared update prompt to be queued',
      );

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
              renderMode: 'markdown',
            }),
          );
        },
      );
      await activeSideB.processReminderUpdates();
      assert.ok(
        activeSideA.peekQueuedPrompt()?.prompt.includes('reminder_id=owner001'),
        'Expected owner-driven shared reminder update to notify active same-root peer dialog',
      );
      assert.ok(
        activeSideSameTaskOtherRoot.peekQueuedPrompt()?.prompt.includes('reminder_id=owner001'),
        'Expected owner-driven shared reminder update to notify active cross-root same-task peer dialog',
      );
      assert.ok(
        activeMainPeer.peekQueuedPrompt()?.prompt.includes('reminder_id=owner001'),
        'Expected owner-driven shared reminder update to notify active cross-root same-task main dialog',
      );
      assert.equal(
        activeSideOtherTaskOtherRoot.peekQueuedPrompt(),
        undefined,
        'Expected owner-driven task reminder update not to notify active cross-root different-task peer dialog',
      );
      assert.equal(
        dialogA.peekQueuedPrompt(),
        undefined,
        'Expected owner-driven task reminder update not to notify loaded historical same-agent dialog',
      );
      assert.equal(
        dialogOtherTask.peekQueuedPrompt(),
        undefined,
        'Expected owner-driven task reminder update not to notify different-task dialog',
      );
      const autoUpdatedReminder = (await activeSideB.listVisibleReminders()).find(
        (reminder) => reminder.id === 'owner001',
      );
      assert.equal(autoUpdatedReminder?.content, 'Owner refreshed shared state');
      const updatedReminder = (await activeSideB.listVisibleReminders()).find(
        (reminder) => reminder.id === taskReminder.id,
      );
      assert.equal(updatedReminder?.content, 'Remember the active peer deploy smoke-check command');
      assert.equal(updatedReminder?.scope, 'task');

      const addAgentOutput = (
        await addReminderTool.call(activeSideA, caller, {
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
      const ownerUpdatePrompt = activeSideA.takeQueuedPrompt();
      const ownerCrossRootUpdatePrompt = activeSideSameTaskOtherRoot.takeQueuedPrompt();
      const ownerActiveMainUpdatePrompt = activeMainPeer.takeQueuedPrompt();
      assert.ok(ownerUpdatePrompt, 'Expected owner-driven shared update prompt to be queued');
      assert.ok(
        ownerCrossRootUpdatePrompt,
        'Expected owner-driven cross-root shared update prompt to be queued',
      );
      assert.ok(
        ownerActiveMainUpdatePrompt,
        'Expected owner-driven active main shared update prompt to be queued',
      );

      const updateAgentOutput = (
        await updateReminderTool.call(activeSideB, caller, {
          reminder_id: agentReminder.id,
          content: 'Urgent: confirm twice before deleting external resources',
        })
      ).content;
      assert.match(updateAgentOutput, /Updated|已更新/);
      assert.match(
        updateAgentOutput,
        /Dispatched notices to 4\/4 affected parallel dialog/,
        'Expected agent-scoped update result to report dispatch to same-agent active peers across roots',
      );
      assert.ok(
        activeSideA.peekQueuedPrompt()?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected active same-root peer dialog to receive agent-scope update impact prompt',
      );
      assert.ok(
        activeSideSameTaskOtherRoot
          .peekQueuedPrompt()
          ?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected active same-agent same-task cross-root peer to receive agent-scope update impact prompt',
      );
      assert.ok(
        activeSideOtherTaskOtherRoot
          .peekQueuedPrompt()
          ?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected active same-agent different-task cross-root peer to receive agent-scope update impact prompt',
      );
      assert.ok(
        activeMainPeer.peekQueuedPrompt()?.prompt.includes(`reminder_id=${agentReminder.id}`),
        'Expected active same-agent main dialog in another root to receive agent-scope update impact prompt',
      );
      assert.equal(
        dialogA.peekQueuedPrompt(),
        undefined,
        'Expected loaded historical same-agent dialog not to receive agent-scope update impact prompt',
      );
      const agentUpdatePromptA = activeSideA.takeQueuedPrompt();
      const agentUpdatePromptSameTaskCrossRoot = activeSideSameTaskOtherRoot.takeQueuedPrompt();
      const agentUpdatePromptOtherTaskCrossRoot = activeSideOtherTaskOtherRoot.takeQueuedPrompt();
      const agentUpdatePromptActiveMain = activeMainPeer.takeQueuedPrompt();
      assert.ok(agentUpdatePromptA, 'Expected dialogA agent-scope prompt to be queued');
      assert.ok(
        agentUpdatePromptSameTaskCrossRoot,
        'Expected same-task cross-root agent-scope prompt to be queued',
      );
      assert.ok(
        agentUpdatePromptOtherTaskCrossRoot,
        'Expected other-task cross-root agent-scope prompt to be queued',
      );
      assert.ok(
        agentUpdatePromptActiveMain,
        'Expected active main cross-root agent-scope prompt to be queued',
      );

      assert.equal(
        withoutMainDialogGoal(await createDialog('other-agent', taskDocPath).listVisibleReminders())
          .length,
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
      assert.equal(withoutMainDialogGoal(await dialogOtherTask.listVisibleReminders()).length, 0);
    } finally {
      if (releaseActiveMainPeer) {
        releaseActiveMainPeer();
      }
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
