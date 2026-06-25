import assert from 'node:assert/strict';

import { DialogStore, MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { MAIN_DIALOG_GOAL_REMINDER_ID } from '../../main/main-dialog-goal-reminder';
import type { Team } from '../../main/team';
import type { Reminder } from '../../main/tool';
import { setDialogGoalTool } from '../../main/tools/ctrl';
import { withTempCwd } from './daemon-test-utils';

class MemoryDialogStore extends DialogStore {}

function createDialog(agentId: string, taskDocPath = 'main-dialog-goal-reminder.tsk'): MainDialog {
  return new MainDialog(new MemoryDialogStore(), taskDocPath, undefined, agentId);
}

function requireGoalReminder(dialog: MainDialog): Reminder {
  const reminder = dialog.reminders.find(
    (candidate) => candidate.id === MAIN_DIALOG_GOAL_REMINDER_ID,
  );
  assert.ok(reminder, 'Expected fixed Main Dialog goal reminder to exist');
  return reminder;
}

function requireMetaRecord(reminder: Reminder): Record<string, unknown> {
  const meta = reminder.meta;
  assert.equal(typeof meta, 'object', 'Expected fixed goal reminder meta to be an object');
  assert.notEqual(meta, null, 'Expected fixed goal reminder meta to be non-null');
  assert.equal(Array.isArray(meta), false, 'Expected fixed goal reminder meta to be a record');
  return meta as Record<string, unknown>;
}

function assertGoalMetaKeys(meta: Record<string, unknown>, includesGoal: boolean): void {
  assert.deepEqual(
    Object.keys(meta).sort(),
    (includesGoal
      ? ['delete', 'goal', 'kind', 'mode', 'update', 'updatedAt']
      : ['delete', 'kind', 'mode', 'update', 'updatedAt']
    ).sort(),
  );
}

async function main(): Promise<void> {
  await withTempCwd('dominds-main-dialog-goal-reminder-', async () => {
    const caller = {} as Team.Member;
    const registeredDialogs: MainDialog[] = [];
    const registerDialog = (dialog: MainDialog): void => {
      globalDialogRegistry.register(dialog);
      registeredDialogs.push(dialog);
    };

    try {
      const dialogA = createDialog('tester');
      registerDialog(dialogA);

      const visibleA = await dialogA.listVisibleReminders();
      const defaultGoal = visibleA.find(
        (candidate) => candidate.id === MAIN_DIALOG_GOAL_REMINDER_ID,
      );
      assert.ok(defaultGoal, 'Expected fixed goal reminder to be visible in Main Dialog');
      assert.equal(defaultGoal.scope, 'dialog');
      assert.match(defaultGoal.content, /未设置|not set/);
      assert.match(defaultGoal.content, /立即问人类|Ask the human immediately/);
      const defaultMeta = requireMetaRecord(defaultGoal);
      assert.equal(defaultMeta['mode'], 'requires_human_confirmation');
      assertGoalMetaKeys(defaultMeta, false);

      const followOutput = await setDialogGoalTool.call(dialogA, caller, {
        mode: 'follow_taskdoc',
      });
      assert.equal(followOutput.outcome, 'success');
      const followGoal = requireGoalReminder(dialogA);
      assert.match(followGoal.content, /依差遣牒推进|proceed from the Taskdoc/);
      assert.equal(requireMetaRecord(followGoal)['mode'], 'follow_taskdoc');

      const dialogB = createDialog('tester');
      registerDialog(dialogB);

      const parallelGoal = requireGoalReminder(dialogA);
      assert.match(parallelGoal.content, /依差遣牒推进|proceed from the Taskdoc/);
      assert.match(parallelGoal.content, /立即问人类|Ask the human immediately/);
      assert.match(parallelGoal.content, /Dominds 已确认|Dominds has confirmed/);
      const parallelMeta = requireMetaRecord(parallelGoal);
      assert.equal(parallelMeta['mode'], 'follow_taskdoc');
      assertGoalMetaKeys(parallelMeta, false);
      const secondDialogGoal = (await dialogB.listVisibleReminders()).find(
        (candidate) => candidate.id === MAIN_DIALOG_GOAL_REMINDER_ID,
      );
      assert.ok(secondDialogGoal, 'Second Main Dialog should display the fixed goal reminder');
      const secondDialogMeta = requireMetaRecord(secondDialogGoal);
      assert.equal(secondDialogMeta['mode'], 'requires_human_confirmation');
      assertGoalMetaKeys(secondDialogMeta, false);

      const rejectedOutput = await setDialogGoalTool.call(dialogA, caller, {
        mode: 'follow_taskdoc',
      });
      assert.equal(rejectedOutput.outcome, 'failure');
      assert.match(rejectedOutput.content, /并行对话|parallel dialog/);
      assert.equal(requireMetaRecord(requireGoalReminder(dialogA))['mode'], 'follow_taskdoc');
      assert.match(requireGoalReminder(dialogA).content, /立即问人类|Ask the human immediately/);

      globalDialogRegistry.unregister(dialogB.id.rootId);
      await dialogA.processReminderUpdates();
      const singleAgainGoal = requireGoalReminder(dialogA);
      const singleAgainMeta = requireMetaRecord(singleAgainGoal);
      assert.equal(singleAgainMeta['mode'], 'follow_taskdoc');
      assertGoalMetaKeys(singleAgainMeta, false);
      assert.match(singleAgainGoal.content, /只有这一条对话|only one dialog/);

      const sideDialog = await dialogA.createSideDialog(
        'tester',
        ['@tester'],
        'Verify that Side Dialogs cannot set Main Dialog goals.',
        {
          callName: 'tellask',
          originMemberId: 'tester',
          askerDialogId: dialogA.id.selfId,
          callId: 'call-side-dialog-goal-main-only',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      await dialogA.processReminderUpdates();
      const sameAgentSideParallelGoal = requireGoalReminder(dialogA);
      assert.match(sameAgentSideParallelGoal.content, /并行对话|parallel dialog/);
      assert.match(sameAgentSideParallelGoal.content, /立即问人类|Ask the human immediately/);
      const sameAgentSideParallelMeta = requireMetaRecord(sameAgentSideParallelGoal);
      assert.equal(sameAgentSideParallelMeta['mode'], 'follow_taskdoc');
      assertGoalMetaKeys(sameAgentSideParallelMeta, false);

      const goalOutput = await setDialogGoalTool.call(dialogA, caller, {
        mode: 'goal',
        goal: '补齐主线目标提醒机制并跑回归测试',
      });
      assert.equal(goalOutput.outcome, 'success');
      const concreteGoal = requireGoalReminder(dialogA);
      assert.match(concreteGoal.content, /补齐主线目标提醒机制并跑回归测试/);
      const concreteGoalMeta = requireMetaRecord(concreteGoal);
      assert.equal(concreteGoalMeta['mode'], 'specific_goal');
      assertGoalMetaKeys(concreteGoalMeta, true);

      assert.equal(
        (await sideDialog.listVisibleReminders()).some(
          (reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID,
        ),
        false,
        'Side Dialogs must not show the fixed Main Dialog goal reminder',
      );
      const sideOutput = await setDialogGoalTool.call(sideDialog, caller, {
        mode: 'goal',
        goal: 'This should not be accepted from a Side Dialog.',
      });
      assert.equal(sideOutput.outcome, 'failure');
      assert.match(sideOutput.content, /只用于主线对话|only for Main Dialogs/);

      const otherAgentDialog = createDialog('other-agent');
      registerDialog(otherAgentDialog);
      const otherFollowOutput = await setDialogGoalTool.call(otherAgentDialog, caller, {
        mode: 'follow_taskdoc',
      });
      assert.equal(otherFollowOutput.outcome, 'success');
      assert.match(
        requireGoalReminder(otherAgentDialog).content,
        /依差遣牒推进|proceed from the Taskdoc/,
      );
    } finally {
      for (const dialog of registeredDialogs) {
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
