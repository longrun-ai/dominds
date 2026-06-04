import assert from 'node:assert/strict';

import { DialogStore, MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import type { Team } from '../../main/team';
import { addReminderTool, migrateReminderTool } from '../../main/tools/ctrl';
import { withTempCwd } from './daemon-test-utils';

class MemoryDialogStore extends DialogStore {}

function createDialog(agentId: string, taskDocPath = 'migrate-reminder-scope.tsk'): MainDialog {
  return new MainDialog(new MemoryDialogStore(), taskDocPath, undefined, agentId);
}

function promptDescribesMigration(prompt: string | undefined, reminderId: string): boolean {
  return (
    prompt?.includes(`reminder_id=${reminderId} 原本是任务范围提醒项`) === true ||
    prompt?.includes(`reminder_id=${reminderId} was task-scope`) === true
  );
}

async function main(): Promise<void> {
  await withTempCwd('dominds-migrate-reminder-', async () => {
    const caller = {} as Team.Member;
    const taskDocPath = 'migrate-reminder-scope.tsk';
    const otherTaskDocPath = 'other-migrate-reminder-scope.tsk';
    const registeredRuntimeDialogs: MainDialog[] = [];
    let releaseActiveMainPeer: (() => void) | undefined;
    const registerRuntimeDialog = (dialog: MainDialog): void => {
      globalDialogRegistry.register(dialog);
      registeredRuntimeDialogs.push(dialog);
    };

    try {
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
          callId: 'call-migrate-side-a',
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
          callId: 'call-migrate-side-b',
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
          callId: 'call-migrate-same-task-other-root',
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
          callId: 'call-migrate-other-task-other-root',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      activeRootOtherTaskOtherRoot.addActiveCalleeDialogs([activeSideOtherTaskOtherRoot.id]);

      const activeMainPeer = createDialog('tester', taskDocPath);
      registerRuntimeDialog(activeMainPeer);
      releaseActiveMainPeer = await activeMainPeer.acquire();

      const addOutput = (
        await addReminderTool.call(activeSideA, caller, {
          content: 'This shared task reminder turns out to belong only to side A',
        })
      ).content;
      assert.match(addOutput, /Added|已添加/);
      const sharedReminder = (await activeSideA.listVisibleReminders()).find(
        (reminder) => reminder.scope === 'task',
      );
      assert.ok(sharedReminder, 'Expected default add_reminder to create task-scoped reminder');

      const migrateOutput = (
        await migrateReminderTool.call(activeSideA, caller, {
          reminder_id: sharedReminder.id,
          scope: 'dialog',
        })
      ).content;
      assert.match(migrateOutput, /Migrated|已迁移/);
      assert.match(
        migrateOutput,
        /withdrawal notices to 3\/3|已向 3\/3 个受影响的并行对话派发撤下提醒/,
        'Expected migration result to report withdrawal dispatch to same-task active peers across roots',
      );

      const migratedReminder = activeSideA.reminders.find(
        (reminder) => reminder.id === sharedReminder.id,
      );
      assert.equal(migratedReminder?.scope, 'dialog');
      assert.equal(
        (await activeSideB.listVisibleReminders()).some(
          (reminder) => reminder.id === sharedReminder.id,
        ),
        false,
        'Expected same-root peer to stop seeing migrated task reminder',
      );
      assert.equal(
        (await activeSideSameTaskOtherRoot.listVisibleReminders()).some(
          (reminder) => reminder.id === sharedReminder.id,
        ),
        false,
        'Expected cross-root same-task peer to stop seeing migrated task reminder',
      );
      assert.ok(
        promptDescribesMigration(activeSideB.peekQueuedPrompt()?.prompt, sharedReminder.id),
        'Expected same-root peer to receive migration withdrawal prompt',
      );
      assert.ok(
        promptDescribesMigration(
          activeSideSameTaskOtherRoot.peekQueuedPrompt()?.prompt,
          sharedReminder.id,
        ),
        'Expected cross-root same-task peer to receive migration withdrawal prompt',
      );
      assert.ok(
        promptDescribesMigration(activeMainPeer.peekQueuedPrompt()?.prompt, sharedReminder.id),
        'Expected active main peer to receive migration withdrawal prompt',
      );
      assert.equal(
        activeSideOtherTaskOtherRoot.peekQueuedPrompt(),
        undefined,
        'Expected different-task same-agent peer not to receive task migration prompt',
      );
    } finally {
      if (releaseActiveMainPeer) {
        releaseActiveMainPeer();
      }
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
