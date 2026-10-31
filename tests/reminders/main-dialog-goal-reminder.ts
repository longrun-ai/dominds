import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import type { MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { MAIN_DIALOG_GOAL_REMINDER_ID } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { Reminder, ToolCallOutput } from '../../main/tool';
import { setDialogGoalTool } from '../../main/tools/ctrl';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-reminder-goal-');
function goalReminder(dialog: MainDialog): Reminder {
  const reminder = dialog.reminders.find(
    (reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID,
  );
  assert.ok(reminder);
  return reminder;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function goalMeta(reminder: Reminder) {
  assert.ok(isRecord(reminder.meta));
  return reminder.meta;
}
async function capture(
  id: string,
  scenario: string,
  dialog: MainDialog,
  mode: 'requires_human_confirmation' | 'follow_taskdoc' | 'specific_goal',
  running: number,
  receipt?: ToolCallOutput,
  givenGoal?: string,
) {
  const visible = await dialog.listVisibleReminders();
  assert.equal(
    visible.filter((reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID).length,
    1,
  );
  await dialog.processReminderUpdates();
  const reminder = goalReminder(dialog),
    meta = goalMeta(reminder);
  assert.equal(reminder.scope, 'dialog');
  assert.equal(meta.kind, 'main_dialog_goal');
  assert.equal(meta.mode, mode);
  assert.deepEqual(
    Object.keys(meta).sort(),
    (mode === 'specific_goal'
      ? ['delete', 'goal', 'kind', 'mode', 'update', 'updatedAt']
      : ['delete', 'kind', 'mode', 'update', 'updatedAt']
    ).sort(),
  );
  assert.equal(meta.goal, givenGoal);
  assert.equal(globalDialogRegistry.getRunningDialogsByAgent(dialog.agentId).length, running);
  const stored = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
  const disk = stored.find((reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID);
  assert.ok(disk);
  assert.equal(disk.scope, 'dialog');
  assert.equal(disk.content, reminder.content);
  assert.deepEqual(disk.meta, reminder.meta);
  evidence.record({
    id,
    scenario,
    businessValue:
      'Keep an executing Main Dialog directed by an explicit, correctly scoped goal without silently following a shared Taskdoc when its agent has parallel work.',
    context: {
      mode,
      givenGoal: givenGoal ?? '',
      runningSameAgentDialogs: running,
      scope:
        'Real Dialog, registry, tool handler and physical store read-back. No LLM drive, browser or restart/recovery is established.',
    },
    reviewQuestions: [
      'Do the actual reminder, maintenance hints and tool receipt fit the observed role/parallel state while preserving the supplied explicit goal and avoiding invented permission or a false successful mutation?',
    ],
    actualText: JSON.stringify(
      {
        reminder: {
          id: reminder.id,
          content: reminder.content,
          scope: reminder.scope,
          meta: reminder.meta,
        },
        receipt,
      },
      null,
      2,
    ),
  });
}
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['other-agent'] });
    setWorkLanguage('zh');
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    const registered: MainDialog[] = [];
    const register = async (agentId = 'tester') => {
      const dialog = await createMainDialog(agentId);
      dialog.setLastUserLanguageCode('zh');
      globalDialogRegistry.register(dialog);
      registered.push(dialog);
      return dialog;
    };
    try {
      const a = await register();
      await capture(
        'default-main-goal',
        'A newly created Main Dialog has no explicit goal and requires human confirmation.',
        a,
        'requires_human_confirmation',
        1,
      );
      const follow = await setDialogGoalTool.call(a, caller, { mode: 'follow_taskdoc' });
      assert.equal(follow.outcome, 'success');
      await capture(
        'single-follow-taskdoc',
        'Only one dialog runs for this agent, so explicitly following its Taskdoc is accepted.',
        a,
        'follow_taskdoc',
        1,
        follow,
      );
      const b = await register();
      await capture(
        'parallel-original-goal',
        'A second same-agent root appears. The original follow mode remains stored, but its guidance must request a concrete Main Dialog goal.',
        a,
        'follow_taskdoc',
        2,
      );
      await capture(
        'parallel-new-goal',
        'The second same-agent root begins without an explicit goal.',
        b,
        'requires_human_confirmation',
        2,
      );
      const refused = await setDialogGoalTool.call(a, caller, { mode: 'follow_taskdoc' });
      assert.equal(refused.outcome, 'failure');
      await capture(
        'parallel-follow-refused',
        'Following a shared Taskdoc alone is refused while another same-agent dialog runs; the previous stored mode is not falsely replaced by a specific goal.',
        a,
        'follow_taskdoc',
        2,
        refused,
      );
      globalDialogRegistry.unregister(b.id.rootId);
      await capture(
        'single-again',
        'After the parallel root is unregistered, the original follow mode is again sufficient for the single running dialog.',
        a,
        'follow_taskdoc',
        1,
      );
      const side = await a.createSideDialog(
        'tester',
        ['@tester'],
        'supplied-assignment-data:goal-side-boundary',
        {
          callName: 'tellask',
          originMemberId: 'tester',
          askerDialogId: a.id.selfId,
          callId: 'goal-side-call',
          callSiteCourse: toCallSiteCourseNo(a.currentCourse),
          callSiteGenseq: toCallSiteGenseqNo(1),
        },
      );
      side.setLastUserLanguageCode('zh');
      await capture(
        'same-agent-side-parallel',
        'A same-agent Side Dialog also constitutes parallel work for the Main Dialog goal decision.',
        a,
        'follow_taskdoc',
        2,
      );
      const givenGoal = '补齐主线目标提醒机制并跑回归测试';
      const specific = await setDialogGoalTool.call(a, caller, { mode: 'goal', goal: givenGoal });
      assert.equal(specific.outcome, 'success');
      await capture(
        'explicit-specific-goal',
        'An explicit specific Main Dialog goal is accepted even with same-agent parallel work.',
        a,
        'specific_goal',
        2,
        specific,
        givenGoal,
      );
      const sideVisible = await side.listVisibleReminders();
      assert.equal(
        sideVisible.some((reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID),
        false,
      );
      await side.processReminderUpdates();
      const sideBefore = await DialogPersistence.loadReminderState(side.id, side.status);
      const sideOutput = await setDialogGoalTool.call(side, caller, {
        mode: 'goal',
        goal: 'must-not-become-a-main-goal',
      });
      assert.equal(sideOutput.outcome, 'failure');
      assert.equal(
        side.reminders.some((reminder) => reminder.id === MAIN_DIALOG_GOAL_REMINDER_ID),
        false,
      );
      assert.deepEqual(await DialogPersistence.loadReminderState(side.id, side.status), sideBefore);
      evidence.record({
        id: 'side-main-goal-refused',
        scenario:
          'An actual Side Dialog has no fixed Main Dialog goal reminder and is refused when trying to set one; its physical reminder state is unchanged.',
        businessValue:
          'Preserve the Main Dialog goal boundary while leaving side assignments under their requester.',
        context: {
          role: 'side_dialog',
          givenGoal: 'must-not-become-a-main-goal',
          scope: 'Real Side Dialog/store and tool handler; no actual assignment execution.',
        },
        reviewQuestions: [
          'Does the actual refusal accurately explain this role boundary without claiming a Main Dialog goal was set?',
        ],
        actualText: sideOutput.content,
      });
      const other = await register('other-agent');
      const otherOutput = await setDialogGoalTool.call(
        other,
        new Team.Member({ id: 'other-agent', name: 'Other' }),
        { mode: 'follow_taskdoc' },
      );
      assert.equal(otherOutput.outcome, 'success');
      await capture(
        'different-agent-independent',
        'Running dialogs of another agent do not block this single-dialog agent from following its Taskdoc.',
        other,
        'follow_taskdoc',
        1,
        otherOutput,
      );
      await evidence.write();
    } finally {
      for (const dialog of registered) globalDialogRegistry.unregister(dialog.id.rootId);
    }
  });
  console.log('Main Dialog goal, parallel scope, side refusal and disk data: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Main goal case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
