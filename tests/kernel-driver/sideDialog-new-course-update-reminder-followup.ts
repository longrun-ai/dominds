import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeDriveOptions,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    const tellaskContent = 'Fix the route after a new-course reminder update.';
    const callId = 'call-new-course-update-reminder';
    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      sessionSlug: 'new-course-update-reminder',
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;
    const reminder = sideDialog.addReminder(
      'Initial continuation package.',
      undefined,
      undefined,
      undefined,
      {
        scope: 'dialog',
      },
    );

    await DialogPersistence.saveActiveCalleeDispatches(root.id, [
      {
        calleeDialogId: sideDialog.id.selfId,
        createdAt: '2026-05-20 00:00:00',
        batchId: 'new-course-update-reminder-batch',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'B',
        sessionSlug: 'new-course-update-reminder',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt(getWorkLanguage(), {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );

    const queuedPrompt = sideDialog.peekQueuedPrompt();
    assert.ok(queuedPrompt, 'expected new-course runtime prompt to be queued');
    assert.equal(
      queuedPrompt.tellaskReplyDirective?.targetCallId,
      callId,
      'new-course prompt should keep the current reply obligation',
    );

    await writeMockDb(tmpRoot, [
      {
        message: queuedPrompt.prompt,
        role: 'user',
        response: 'Updating reminder before continuing.',
        funcCalls: [
          {
            id: 'update-reminder-after-new-course',
            name: 'update_reminder',
            arguments: {
              reminder_id: reminder.id,
              content: 'Refined continuation package.',
            },
          },
        ],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: 'Continuing the original task after the reminder update.',
      },
    ]);

    await driveDialogStream(
      sideDialog,
      undefined,
      true,
      makeDriveOptions({
        suppressDiligencePush: true,
        source: 'kernel_driver_sideDialog_resume',
        reason: 'type_b_registered_sideDialog_resume',
      }),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const events = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const genStartCount = events.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount >= 2,
      true,
      'new-course sideDialog update_reminder should immediately open a post-tool generation',
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'agent_words_record' &&
          event.genseq === 2 &&
          event.content === 'Continuing the original task after the reminder update.',
      ),
      'expected post-tool generation to continue the original task',
    );

    const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.ok(latest, 'expected latest dialog state to exist');
    assert.equal(
      hasPendingNextStepTriggers(latest),
      false,
      'immediate follow-up should be consumed by the post-tool generation',
    );
  });

  console.log('kernel-driver sideDialog-new-course-update-reminder-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-new-course-update-reminder-followup: FAIL\n${message}`);
  process.exit(1);
});
