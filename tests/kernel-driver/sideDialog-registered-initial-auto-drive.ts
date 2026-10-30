import assert from 'node:assert/strict';

import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-registered-initial';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const callId = 'registered-initial-call-data';
    const session = 'registered-initial-session';
    const requestPayload = 'request-data-initial-726a';
    const replyPayload = 'reply-data-initial-837b';
    const finalPayload = 'root-data-initial-948c';
    let rootRounds = 0;
    let sideRounds = 0;
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        if (request.dialogSelfId === root.id.selfId) {
          if (++rootRounds === 1)
            await receiver.funcCall(
              callId,
              'tellask',
              JSON.stringify({
                targetAgentId: 'pangu',
                sessionSlug: session,
                tellaskContent: requestPayload,
              }),
            );
          else {
            assert.equal(rootRounds, 2);
            const delivered = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === callId);
            assert.equal(delivered.length, 1);
            assert.equal(delivered[0].status, 'completed');
            assert.ok(delivered[0].content.includes(replyPayload));
            await receiver.sayingStart();
            await receiver.sayingChunk(finalPayload);
            await receiver.sayingFinish();
          }
        } else {
          assert.equal(++sideRounds, 1);
          await receiver.funcCall(
            'registered-initial-reply-data',
            'replyTellask',
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
        makeUserPrompt('input-data-initial', 'registered-initial-user'),
        true,
      );
      await waitFor(
        async () => rootRounds === 2,
        3_000,
        'root to consume the automatically driven registered result',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      assert.equal(sideRounds, 1);
      const side = root.lookupSideDialog('pangu', session);
      assert.ok(side);
      const events = await DialogPersistence.loadCourseEvents(
        side.id,
        side.currentCourse,
        side.status,
      );
      assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 1);
      const response = events
        .filter((event) => event.type === 'tellask_anchor_record')
        .find((event) => event.anchorRole === 'response' && event.callId === callId);
      assert.ok(response);
      const rootEvents = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      const delivered = rootEvents
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === callId);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].status, 'completed');
      assert.ok(delivered[0].content.includes(replyPayload));
      assert.equal(delivered[0].route?.calleeDialogId, side.id.selfId);
      assert.equal(delivered[0].route?.calleeGenseq, response.genseq);
      const rootWords = rootEvents.filter((event) => event.type === 'agent_words_record');
      assert.equal(rootWords.at(-1)?.content, finalPayload);
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  console.log(
    'registered assignment automatically executes and returns the controlled result once: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
