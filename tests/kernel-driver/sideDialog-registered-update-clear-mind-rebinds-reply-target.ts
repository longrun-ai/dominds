import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { formatAssignmentFromAskerDialog } from '../../main/runtime/inter-dialog-format';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  makeDriveOptions,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector(
  'dominds-sideDialog-registered-update-clear-mind-rebinds-reply-target-',
);
async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    const language = 'en' as const;
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const sessionSlug = 'sticky-session';
    const oldCallId = 'call-old-round';
    const newCallId = 'call-new-round';
    const oldBody = 'assignment-data-old-51de';
    const newBody = 'assignment-data-current-62ef';
    const finalReply = 'reply-data-rebound-73fa';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], oldBody, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: oldCallId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
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
    await DialogPersistence.saveActiveCalleeDispatches(root.id, [
      {
        calleeDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        batchId: 'registered-clear-mind-rebind-batch',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent: newBody,
        targetAgentId: 'pangu',
        callId: newCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
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
    const queuedPrompt = sideDialog.peekQueuedPrompt();
    assert.ok(queuedPrompt?.kind === 'new_course_runtime_sideDialog');
    assert.equal(queuedPrompt.tellaskReplyDirective.targetCallId, newCallId);
    assert.equal(queuedPrompt.tellaskReplyDirective.tellaskContent, newBody);
    assert.equal(queuedPrompt.calleeDialogReplyTarget.callType, 'B');
    assert.equal(queuedPrompt.calleeDialogReplyTarget.callId, newCallId);
    const guidance = await resolvePromptReplyGuidance({
      dlg: sideDialog,
      language: 'en',
      prompt: {
        content: queuedPrompt.prompt,
        msgId: queuedPrompt.msgId,
        grammar: 'markdown',
        origin: 'runtime',
        tellaskReplyDirective: queuedPrompt.tellaskReplyDirective,
        calleeDialogReplyTarget: queuedPrompt.calleeDialogReplyTarget,
      },
    });
    assert.equal(guidance.persistedTellaskReplyDirective?.targetCallId, newCallId);
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

    await driveDialogStream(sideDialog, undefined, true, makeDriveOptions());
    await waitForAllDialogsUnlocked(root, 3_000);

    const delivered = (
      await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
    )
      .filter((event) => event.type === 'tellask_result_record')
      .filter((event) => event.callId === newCallId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, 'completed');
    assert.ok(
      delivered[0].content.includes(finalReply),
      'canonical delivery preserves the controlled reply payload',
    );

    const pendingAfterReply = await DialogPersistence.loadActiveCalleeDispatches(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterReply.length,
      0,
      'asker active-callees should clear after the rebound clear-mind reply lands',
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
      (latestAfterDrive?.nextStep.triggers ?? []).some(
        (trigger) => trigger.kind === 'queued_prompt',
      ),
      false,
      'sideDialog latest.yaml should clear the queued prompt trigger after the rebound clear-mind prompt is consumed',
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
    assert.ok(latestPromptRecord.content.includes(newBody));
    const oldDeliveries = (
      await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
    ).filter((event) => event.type === 'tellask_result_record' && event.callId === oldCallId);
    assert.equal(
      oldDeliveries.length,
      0,
      'the new-course reply must not be delivered to the historical call',
    );
    evidence.record({
      id: 'new-course-adopts-current-assignment',
      scenario:
        'A registered worker has old assignment history, then its durable assignment is replaced before context renewal. The new course queues and delivers using the current call rather than the historical one.',
      businessValue:
        'Renew context without reverting to a superseded task or sending its result to the old call.',
      context: {
        language: 'en',
        oldCallId,
        newCallId,
        oldAssignmentPayload: oldBody,
        currentAssignmentPayload: newBody,
        replyTargetCallId: queuedPrompt.tellaskReplyDirective.targetCallId,
      },
      reviewQuestions: [
        'Does the actual new-course assignment clearly convey the current requirement and requester responsibility without reviving the historical assignment?',
        'Is the continuation guidance coherent about preserving current work and returning through the appropriate reply tool?',
      ],
      actualText: latestPromptRecord.content,
    });
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

  await evidence.write();
  console.log('kernel-driver sideDialog-registered-update-clear-mind-rebinds-reply-target: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-registered-update-clear-mind-rebinds-reply-target: FAIL\n${message}`,
  );
  process.exit(1);
});
