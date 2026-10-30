import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeDriveOptions,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-renewed-reminder-update-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    const apiType = 'test-new-course-reminder-update';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const callId = 'new-course-update-call';
    const requestPayload = 'request-data-reminder-update-76ab';
    const updatedPayload = 'reminder-data-updated-87bc';
    const replyPayload = 'reply-data-after-update-98cd';
    const side = await root.createSideDialog('pangu', ['@pangu'], requestPayload, {
      callName: 'tellask',
      originMemberId: root.agentId,
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'new-course-reminder-update',
      collectiveTargets: ['pangu'],
    });
    side.disableDiligencePush = true;
    const reminder = side.addReminder(
      'reminder-data-before-65fa',
      undefined,
      undefined,
      undefined,
      { scope: 'dialog', renderMode: 'markdown' },
    );
    await DialogPersistence.appendActiveCalleeDispatch(root.id, {
      calleeDialogId: side.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'new-course-reminder-batch',
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: requestPayload,
      targetAgentId: side.agentId,
      callId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'B',
      sessionSlug: 'new-course-reminder-update',
    });
    await side.startNewCourse(
      formatNewCourseStartPrompt('en', { nextCourse: 2, source: 'clear_mind' }),
    );
    const queued = side.peekQueuedPrompt();
    assert.ok(queued?.kind === 'new_course_runtime_sideDialog');
    assert.equal(queued.tellaskReplyDirective.targetCallId, callId);
    let sideRounds = 0;
    let rootRounds = 0;
    let postToolContext: ChatMessage[] | undefined;
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        if (request.dialogSelfId === side.id.selfId) {
          if (++sideRounds === 1)
            await receiver.funcCall(
              'new-course-update-reminder',
              'update_reminder',
              JSON.stringify({ reminder_id: reminder.id, content: updatedPayload }),
            );
          else {
            assert.equal(sideRounds, 2);
            const results = context
              .filter((message) => message.type === 'func_result_msg')
              .filter((message) => message.id === 'new-course-update-reminder');
            assert.equal(results.length, 1);
            assert.equal(results[0].name, 'update_reminder');
            assert.equal(
              side.reminders.find((item) => item.id === reminder.id)?.content,
              updatedPayload,
            );
            postToolContext = structuredClone(context);
            await receiver.funcCall(
              'new-course-update-reply',
              'replyTellask',
              JSON.stringify({ replyContent: replyPayload }),
            );
          }
        } else {
          assert.equal(request.dialogSelfId, root.id.selfId);
          assert.equal(++rootRounds, 1);
          await receiver.sayingStart();
          await receiver.sayingChunk('root-finished-data-reminder-update');
          await receiver.sayingFinish();
        }
        return {
          usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          llmGenModel: 'default',
        };
      },
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
    };
    registerLlmGenerator(generator);
    try {
      await driveDialogStream(
        side,
        undefined,
        true,
        makeDriveOptions({
          source: 'kernel_driver_sideDialog_resume',
          reason: 'type_b_registered_sideDialog_resume',
          suppressDiligencePush: true,
        }),
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      assert.equal(sideRounds, 2);
      assert.equal(rootRounds, 1);
      const events = await DialogPersistence.loadCourseEvents(side.id, 2, side.status);
      assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 2);
      const results = (
        await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
      )
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === callId);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'completed');
      assert.ok(results[0].content.includes(replyPayload));
      const latest = await DialogPersistence.loadDialogLatest(side.id, side.status);
      assert.ok(latest);
      assert.equal(latest.nextStep.triggers.length, 0);
      assert.equal(latest.pendingRuntimePrompt, undefined);
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
      assert.ok(postToolContext);
      evidence.record({
        id: 'new-course-reminder-update-continues-task',
        scenario:
          'The worker resumed course 2, successfully updated a real reminder and immediately received a post-tool generation with its original reply obligation.',
        businessValue:
          'Reminder maintenance must not stall work after context renewal or lose the requester reply path.',
        context: {
          language: 'en',
          callId,
          reminderId: reminder.id,
          updatedReminderPayload: updatedPayload,
          expectedReplyTool: 'replyTellask',
        },
        reviewQuestions: [
          'Does the actual post-tool context preserve the current task and reply responsibility while presenting the updated reminder as state?',
          'Can the worker continue toward the requester result without mistaking maintenance for a new human task or asking for redundant Continue?',
        ],
        actualText: JSON.stringify(postToolContext, null, 2),
      });
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log(
    'reminder update after worker renewal immediately continues and delivers the result: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
