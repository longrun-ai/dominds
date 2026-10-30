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

const evidence = semanticEvidenceCollector('dominds-nested-delivery-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    const apiType = 'test-nested-delivery';
    await writeStandardMinds(rtws, {
      includePangu: true,
      extraMembers: ['coder'],
      providerApiType: apiType,
    });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    await setMainDialogGoalReminder(root, {
      mode: 'goal',
      goal: 'Return one final result after the nested verification completes.',
    });
    const rootCall = 'root-pangu-nested-data';
    const nestedCall = 'pangu-coder-nested-data';
    const intermediatePayload = 'intermediate-data-37bd';
    const verifiedPayload = 'verified-data-48cf';
    const finalPayload = 'final-data-59de';
    const rootPayload = 'root-finished-data-60ef';
    let releaseCoder: () => void = () => {};
    const coderRelease = new Promise<void>((resolve) => {
      releaseCoder = resolve;
    });
    let noteCoderEntered: () => void = () => {};
    const coderEntered = new Promise<void>((resolve) => {
      noteCoderEntered = resolve;
    });
    const rounds = new Map<string, number>();
    let panguContext: ChatMessage[] | undefined;
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, agent, _system, _tools, request, context, receiver) {
        const round = (rounds.get(request.dialogSelfId) ?? 0) + 1;
        rounds.set(request.dialogSelfId, round);
        if (request.dialogSelfId === root.id.selfId) {
          if (round === 1)
            await receiver.funcCall(
              rootCall,
              'tellaskSessionless',
              JSON.stringify({
                targetAgentId: 'pangu',
                tellaskContent: 'request-data-nested-184a',
              }),
            );
          else {
            assert.equal(round, 2);
            const result = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === rootCall);
            assert.equal(result.length, 1);
            assert.equal(result[0].status, 'completed');
            assert.ok(result[0].content.includes(finalPayload));
            await receiver.sayingStart();
            await receiver.sayingChunk(rootPayload);
            await receiver.sayingFinish();
          }
        } else if (agent.id === 'pangu') {
          if (round === 1) {
            await receiver.sayingStart();
            await receiver.sayingChunk(intermediatePayload);
            await receiver.sayingFinish();
            await receiver.funcCall(
              nestedCall,
              'tellaskSessionless',
              JSON.stringify({ targetAgentId: 'coder', tellaskContent: 'verify-data-nested-295b' }),
            );
          } else {
            assert.equal(round, 2);
            const result = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === nestedCall);
            assert.equal(result.length, 1);
            assert.equal(result[0].status, 'completed');
            assert.ok(result[0].content.includes(verifiedPayload));
            panguContext = structuredClone(context);
            await receiver.funcCall(
              'pangu-final-data',
              'replyTellaskSessionless',
              JSON.stringify({ replyContent: finalPayload }),
            );
          }
        } else {
          assert.equal(agent.id, 'coder');
          assert.equal(round, 1);
          noteCoderEntered();
          await coderRelease;
          await receiver.funcCall(
            'coder-final-data',
            'replyTellaskSessionless',
            JSON.stringify({ replyContent: verifiedPayload }),
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
      await driveDialogStream(root, makeUserPrompt('input-data-nested', 'nested-user-data'), true);
      await coderEntered;
      const pangu = root.getLoadedDialogTreeSnapshot().find((dialog) => dialog.agentId === 'pangu');
      assert.ok(pangu);
      const before = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(
        before.filter(
          (event) => event.type === 'tellask_result_record' && event.callId === rootCall,
        ).length,
        0,
        'no formal root result is delivered while nested verification is blocked',
      );
      assert.equal(
        root.msgs.filter(
          (message) => message.type === 'tellask_result_msg' && message.callId === rootCall,
        ).length,
        0,
      );
      assert.deepEqual(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).map(
          (record) => record.callId,
        ),
        [rootCall],
      );
      assert.deepEqual(
        (await DialogPersistence.loadActiveCalleeDispatches(pangu.id, pangu.status)).map(
          (record) => record.callId,
        ),
        [nestedCall],
      );
      const panguWords = (
        await DialogPersistence.loadCourseEvents(pangu.id, pangu.currentCourse, pangu.status)
      ).filter((event) => event.type === 'agent_words_record');
      assert.equal(
        panguWords.at(-1)?.content,
        intermediatePayload,
        'the intermediate candidate genuinely exists before the no-delivery check',
      );
      releaseCoder();
      await waitFor(
        async () => rounds.get(root.id.selfId) === 2,
        3_000,
        'root to receive the finalized nested result',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      const after = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      const delivered = after
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === rootCall);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].status, 'completed');
      assert.ok(delivered[0].content.includes(finalPayload));
      const nestedDelivered = (
        await DialogPersistence.loadCourseEvents(pangu.id, pangu.currentCourse, pangu.status)
      )
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === nestedCall);
      assert.equal(nestedDelivered.length, 1);
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(pangu.id, pangu.status)).length,
        0,
      );
      const mirrorIndex = root.msgs.findIndex(
        (message) => message.type === 'tellask_result_msg' && message.callId === rootCall,
      );
      const sayingIndex = root.msgs.findIndex(
        (message) => message.type === 'saying_msg' && message.content === rootPayload,
      );
      assert.ok(mirrorIndex >= 0 && sayingIndex > mirrorIndex);
      assert.ok(panguContext);
      evidence.record({
        id: 'nested-result-resumes-owner',
        scenario:
          'Pangu produced a preliminary local candidate then waited for coder verification. The root received no result until coder replied; this is the actual context of the resumed Pangu generation.',
        businessValue:
          'Keep preliminary work local while nested dependencies are unresolved, then deliver the final result to the correct requester once.',
        context: {
          language: 'en',
          rootCallId: rootCall,
          nestedCallId: nestedCall,
          initialCandidatePayload: intermediatePayload,
          verifierPayload: verifiedPayload,
          eventualFinalPayload: finalPayload,
        },
        reviewQuestions: [
          'Does the context distinguish the nested verifier result from a new human task and preserve Pangu’s original requester obligation?',
          'Can the executor use the verifier’s evidence and then deliver its own final reply without forwarding a preliminary candidate or answering the wrong dialog?',
        ],
        actualText: JSON.stringify(panguContext, null, 2),
      });
    } finally {
      releaseCoder();
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log('preliminary candidate stays local until nested verification settles: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
