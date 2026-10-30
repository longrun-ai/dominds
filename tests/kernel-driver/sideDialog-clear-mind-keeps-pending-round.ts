import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { setMainDialogGoalReminder } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-side-renewal-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    const apiType = 'test-side-renewal';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    await setMainDialogGoalReminder(root, {
      mode: 'goal',
      goal: 'Receive the assigned result after the worker renews context.',
    });
    const callId = 'root-side-renew-data';
    const requestPayload = 'request-data-side-renew-765a';
    const continuation = 'continuation-data-side-renew-876b';
    const replyPayload = 'reply-data-side-renew-987c';
    const finalPayload = 'root-data-side-renew-098d';
    const rounds = new Map<string, number>();
    let renewedContext: ChatMessage[] | undefined;
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        const round = (rounds.get(request.dialogSelfId) ?? 0) + 1;
        rounds.set(request.dialogSelfId, round);
        if (request.dialogSelfId === root.id.selfId) {
          if (round === 1)
            await receiver.funcCall(
              callId,
              'tellaskSessionless',
              JSON.stringify({ targetAgentId: 'pangu', tellaskContent: requestPayload }),
            );
          else {
            assert.equal(round, 2);
            const results = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === callId);
            assert.equal(results.length, 1);
            assert.equal(results[0].status, 'completed');
            assert.ok(results[0].content.includes(replyPayload));
            await receiver.sayingStart();
            await receiver.sayingChunk(finalPayload);
            await receiver.sayingFinish();
          }
        } else if (round === 1) {
          await receiver.funcCall(
            'side-renew-clear',
            'clear_mind',
            JSON.stringify({ reminder_content: continuation }),
          );
        } else {
          assert.equal(round, 2);
          const side = root.lookupDialog(request.dialogSelfId);
          assert.ok(side);
          assert.equal(side.currentCourse, 2);
          assert.ok(
            context.some(
              (message) =>
                message.type === 'environment_msg' && message.content.includes(continuation),
            ),
          );
          renewedContext = structuredClone(context);
          await receiver.funcCall(
            'side-renew-reply',
            'replyTellaskSessionless',
            JSON.stringify({ replyContent: replyPayload }),
          );
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
        root,
        makeUserPrompt('input-data-side-renew', 'side-renew-user'),
        true,
      );
      await waitFor(
        async () => rounds.get(root.id.selfId) === 2,
        3_000,
        'root to receive the reply from course two',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      const side = root.getLoadedDialogTreeSnapshot().find((dialog) => dialog.agentId === 'pangu');
      assert.ok(side);
      assert.equal(side.currentCourse, 2);
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
      const results = (
        await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
      )
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === callId);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'completed');
      assert.ok(results[0].content.includes(replyPayload));
      assert.equal(results[0].route?.calleeDialogId, side.id.selfId);
      assert.equal(results[0].route?.calleeCourse, 2);
      assert.equal(
        side.reminders.filter((reminder) => reminder.content === continuation).length,
        1,
      );
      const words = (
        await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
      ).filter((event) => event.type === 'agent_words_record');
      assert.equal(words.at(-1)?.content, finalPayload);
      assert.ok(renewedContext);
      evidence.record({
        id: 'side-new-course-keeps-requester',
        scenario:
          'A real sessionless worker clears context, receives its continuation package in course 2 and formally replies to the same root request once.',
        businessValue:
          'Context renewal must preserve collaboration responsibility and delivery to the original requester.',
        context: {
          language: 'en',
          callId,
          requestPayload,
          continuationPayload: continuation,
          observedCourse: side.currentCourse,
          canonicalResultCount: results.length,
        },
        reviewQuestions: [
          'Does the actual resumed worker context preserve the assigned task and the correct reply path without treating renewal as assignment cancellation?',
          'Are continuation data, task state and requester responsibility coherent enough to resume work rather than restart completed work or ask the human unnecessarily?',
        ],
        actualText: JSON.stringify(renewedContext, null, 2),
      });
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log(
    'worker renewal preserves its pending caller and delivers from course two once: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
