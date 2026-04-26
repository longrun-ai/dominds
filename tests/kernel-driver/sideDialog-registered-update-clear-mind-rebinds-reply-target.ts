import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  listTellaskResultContents,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const language = getWorkLanguage();
    const sessionSlug = 'sticky-session';
    const oldCallId = 'call-old-round';
    const newCallId = 'call-new-round';
    const oldBody = 'Old assignment';
    const newBody = 'Updated assignment after clear mind';
    const finalReply = 'Final answer delivered from the rebound clear-mind course.';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], oldBody, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: oldCallId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;

    await sideDialog.persistUserMessage(
      wrapPromptWithExpectedReplyTool({
        prompt: formatAssignmentFromAskerDialog({
          callName: 'tellask',
          fromAgentId: 'tester',
          toAgentId: 'pangu',
          mentionList: ['@pangu'],
          sessionSlug,
          tellaskContent: oldBody,
          language,
          collectiveTargets: ['pangu'],
        }),
        expectedReplyToolName: 'replyTellask',
        language,
      }),
      'old-assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: root.id.selfId,
        targetCallId: oldCallId,
        tellaskContent: oldBody,
      },
    );

    const updatedAssignment = {
      ...sideDialog.assignmentFromAsker,
      tellaskContent: newBody,
      callId: newCallId,
    };
    sideDialog.assignmentFromAsker = updatedAssignment;
    await DialogPersistence.updateSideDialogAssignment(sideDialog.id, updatedAssignment);
    await DialogPersistence.savePendingSideDialogs(root.id, [
      {
        sideDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent: newBody,
        targetAgentId: 'pangu',
        callId: newCallId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'B',
        sessionSlug,
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );
    const queuedPrompt = sideDialog.peekUpNext();
    assert.ok(queuedPrompt, 'expected clear_mind to queue the rebound new-course prompt');
    const newCoursePrompt = queuedPrompt?.prompt;

    await writeMockDb(tmpRoot, [
      {
        message: newCoursePrompt,
        role: 'user',
        response: 'Delivering the updated assignment now.',
        funcCalls: [
          {
            id: 'reply-updated-round',
            name: 'replyTellask',
            arguments: {
              replyContent: finalReply,
            },
          },
        ],
      },
    ]);

    await driveDialogStream(sideDialog, undefined, true);
    await waitForAllDialogsUnlocked(root, 3_000);

    const expectedDeliveredContent = formatTellaskResponseContent({
      callName: 'tellask',
      callId: newCallId,
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent: newBody,
      responseBody: finalReply,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
      sessionSlug,
    });
    await waitFor(
      async () => listTellaskResultContents(root.msgs).includes(expectedDeliveredContent),
      3_000,
      'updated registered clear-mind reply to land on the tellasker',
    );

    const pendingAfterReply = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(
      pendingAfterReply.length,
      0,
      'asker pending-sideDialogs should clear after the rebound clear-mind reply lands',
    );

    const courseTwoEvents = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const latestAfterDrive = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      latestAfterDrive?.needsDrive,
      false,
      'sideDialog latest.yaml should clear needsDrive after the rebound clear-mind prompt is consumed',
    );
    const latestPromptRecord = courseTwoEvents.find(
      (event): event is Extract<(typeof courseTwoEvents)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.tellaskReplyDirective?.targetCallId === newCallId,
    );
    assert.ok(
      latestPromptRecord,
      'new course should persist a human_text_record bound to the updated reply target callId',
    );
    assert.ok(
      courseTwoEvents.some(
        (event) =>
          event.type === 'tellask_anchor_record' &&
          event.anchorRole === 'assignment' &&
          event.callId === newCallId,
      ),
      'new course should persist an assignment anchor for the updated callId before reply delivery',
    );
  });

  console.log('kernel-driver sideDialog-registered-update-clear-mind-rebinds-reply-target: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-registered-update-clear-mind-rebinds-reply-target: FAIL\n${message}`,
  );
  process.exit(1);
});
