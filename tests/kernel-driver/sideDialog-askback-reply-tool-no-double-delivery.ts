import assert from 'node:assert/strict';

import type { FuncResultRecord, TellaskResultRecord } from '@longrun-ai/kernel/types/storage';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-askback-once-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-askback-delivery';
    await writeStandardMinds(rtws, { providerApiType: apiType, includePangu: true });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const taskId = 'task-call-data-1';
    const askId = 'askback-call-data-2';
    const sessionSlug = 'askback-once';
    const task = 'task-input-data-3';
    const question = 'clarification-input-data-4';
    const clarification = 'clarification-answer-data-5';
    const answer = 'final-answer-data-6';
    const rounds = new Map<string, number>();
    const generator: LlmGenerator = {
      apiType,
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        const round = (rounds.get(request.dialogSelfId) ?? 0) + 1;
        rounds.set(request.dialogSelfId, round);
        if (request.dialogSelfId === root.id.selfId) {
          assert.ok(round <= 3);
          if (round === 1)
            await receiver.funcCall(
              taskId,
              'tellask',
              JSON.stringify({ targetAgentId: 'pangu', sessionSlug, tellaskContent: task }),
            );
          else if (round === 2)
            await receiver.funcCall(
              'reply-back-data-7',
              'replyTellaskBack',
              JSON.stringify({ replyContent: clarification }),
            );
          else {
            const results = context.filter(
              (message): message is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
                message.type === 'tellask_result_msg' && message.callId === taskId,
            );
            assert.equal(results.length, 1);
            assert.equal(results[0].status, 'completed');
            assert.ok(
              results[0].content.includes(answer),
              'supplied opaque answer is carried to the caller',
            );
            await receiver.sayingStart();
            await receiver.sayingChunk('caller-consumed-data-8');
            await receiver.sayingFinish();
          }
        } else {
          const side = root.lookupSideDialog('pangu', sessionSlug);
          assert.ok(side);
          assert.equal(request.dialogSelfId, side.id.selfId);
          assert.ok(round <= 2);
          if (round === 1)
            await receiver.funcCall(
              askId,
              'tellaskBack',
              JSON.stringify({ tellaskContent: question }),
            );
          else {
            const results = context.filter(
              (message): message is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
                message.type === 'tellask_result_msg' && message.callId === askId,
            );
            assert.equal(results.length, 1);
            assert.equal(results[0].status, 'completed');
            assert.ok(results[0].content.includes(clarification));
            await receiver.funcCall(
              'final-reply-data-9',
              'replyTellask',
              JSON.stringify({ replyContent: answer }),
            );
          }
        }
        return { usage: { kind: 'unavailable' } };
      },
    };
    registerLlmGenerator(generator);
    try {
      await driveDialogStream(
        root,
        makeUserPrompt('start-input-data-0', 'askback-once-input'),
        true,
      );
      await waitFor(
        async () =>
          (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length === 0,
        3000,
        'ask-back task completion',
      );
      await waitForAllDialogsUnlocked(root, 3000);
      const side = root.lookupSideDialog('pangu', sessionSlug);
      assert.ok(side);
      assert.equal(rounds.get(root.id.selfId), 3);
      assert.equal(rounds.get(side.id.selfId), 2);
      for (const [dialog, callId, payload, responder] of [
        [side, askId, clarification, 'tester'],
        [root, taskId, answer, 'pangu'],
      ] as const) {
        const events = await DialogPersistence.loadCourseEvents(
          dialog.id,
          dialog.currentCourse,
          dialog.status,
        );
        const results = events.filter(
          (event): event is TellaskResultRecord =>
            event.type === 'tellask_result_record' && event.callId === callId,
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].status, 'completed');
        assert.equal(results[0].responder.responderId, responder);
        assert.ok(results[0].content.includes(payload));
        const funcResults = events.filter(
          (event): event is FuncResultRecord =>
            event.type === 'func_result_record' && event.id === callId,
        );
        assert.equal(funcResults.length, 1);
        if (callId === askId)
          assert.equal(
            funcResults[0].content,
            results[0].content,
            'ask-back function result transports canonical reply bytes',
          );
        else
          evidence.record({
            id: 'pending-ack-and-final-result',
            scenario:
              'A registered background task produces an initial function receipt and later a formal result after ask-back resolution.',
            businessValue:
              'Keep pending acknowledgement distinct from the delivered result while the executor waits and resumes.',
            context: {
              callId,
              finalPayload: answer,
              formalResults: results.length,
              functionReceipts: funcResults.length,
            },
            reviewQuestions: [
              'Does the actual receipt clearly represent pending work, and does the later result accurately present the formal reply without claiming a duplicate new request?',
            ],
            actualText: JSON.stringify(
              { receipt: funcResults[0].content, finalResult: results[0].content },
              null,
              2,
            ),
          });
      }
      const events = await DialogPersistence.loadCourseEvents(
        side.id,
        side.currentCourse,
        side.status,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.type === 'tellask_anchor_record' &&
            event.anchorRole === 'response' &&
            event.callId === taskId,
        ).length,
        1,
      );
      assert.equal(
        await DialogPersistence.loadActiveTellaskReplyObligation(side.id, side.status),
        undefined,
      );
      const restored = await DialogPersistence.restoreDialog(side.id, side.status);
      assert.ok(restored);
      const restoredResults = restored.messages.filter(
        (message): message is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
          message.type === 'tellask_result_msg' && message.callId === askId,
      );
      assert.equal(restoredResults.length, 1);
      assert.ok(restoredResults[0].content.includes(clarification));
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log('ask-back resumes and delivers each canonical result exactly once: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
