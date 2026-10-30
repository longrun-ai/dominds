import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
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

const evidence = semanticEvidenceCollector('dominds-running-assignment-update-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    const apiType = 'test-running-assignment-update';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const session = 'registered-update-data';
    const oldCall = 'assignment-old-data';
    const newCall = 'assignment-new-data';
    const oldBody = 'request-data-old-726a';
    const newBody = 'request-data-new-837b';
    const replyPayload = 'reply-data-new-948c';
    let releaseOld: () => void = () => {};
    const oldRelease = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let noteOldEntered: () => void = () => {};
    const oldEntered = new Promise<void>((resolve) => {
      noteOldEntered = resolve;
    });
    let rootRounds = 0;
    let sideRounds = 0;
    let updatedContext: ChatMessage[] | undefined;
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        if (request.dialogSelfId === root.id.selfId) {
          rootRounds += 1;
          if (rootRounds <= 2) {
            const initial = rootRounds === 1;
            await receiver.funcCall(
              initial ? oldCall : newCall,
              'tellask',
              JSON.stringify({
                targetAgentId: 'pangu',
                sessionSlug: session,
                tellaskContent: initial ? oldBody : newBody,
              }),
            );
          } else {
            assert.equal(rootRounds, 3);
            const results = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === newCall);
            assert.equal(results.length, 1);
            assert.equal(results[0].status, 'completed');
            assert.ok(results[0].content.includes(replyPayload));
            await receiver.sayingStart();
            await receiver.sayingChunk('root-finished-data-update');
            await receiver.sayingFinish();
          }
        } else if (++sideRounds === 1) {
          noteOldEntered();
          await oldRelease;
          await receiver.sayingStart();
          await receiver.sayingChunk('old-local-candidate-data');
          await receiver.sayingFinish();
        } else {
          assert.equal(sideRounds, 2);
          updatedContext = structuredClone(context);
          await receiver.funcCall(
            'reply-new-assignment-data',
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
        makeUserPrompt('initial-input-data', 'registered-user-old'),
        true,
      );
      await oldEntered;
      const side = root.lookupSideDialog('pangu', session);
      assert.ok(side);
      assert.equal(side.isLocked(), true);
      await driveDialogStream(
        root,
        makeUserPrompt('updated-input-data', 'registered-user-new'),
        true,
      );
      assert.equal(
        sideRounds,
        1,
        'the new assignment waits at the actual running generation boundary',
      );
      const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
      assert.deepEqual(
        pending.map((record) => record.callId),
        [newCall],
      );
      const queued = side.peekQueuedPrompt();
      assert.ok(queued?.kind === 'registered_assignment_update');
      assert.equal(queued.tellaskReplyDirective.targetCallId, newCall);
      assert.equal(queued.tellaskReplyDirective.tellaskContent, newBody);
      releaseOld();
      await waitFor(async () => rootRounds === 3, 3_000, 'root to consume the replacement result');
      await waitForAllDialogsUnlocked(root, 3_000);
      assert.equal(sideRounds, 2);
      const sideEvents = await DialogPersistence.loadCourseEvents(
        side.id,
        side.currentCourse,
        side.status,
      );
      const updatedInputs = sideEvents
        .filter((event) => event.type === 'human_text_record')
        .filter((event) => event.tellaskReplyDirective?.targetCallId === newCall);
      assert.equal(updatedInputs.length, 1);
      assert.ok(updatedInputs[0].content.includes(newBody));
      assert.equal(
        sideEvents.filter(
          (event) =>
            event.type === 'tellask_anchor_record' &&
            event.anchorRole === 'assignment' &&
            event.callId === newCall,
        ).length,
        1,
      );
      const rootEvents = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      const results = rootEvents.filter((event) => event.type === 'tellask_result_record');
      const replaced = results.filter((event) => event.callId === oldCall);
      const completed = results.filter((event) => event.callId === newCall);
      assert.equal(replaced.length, 1);
      assert.equal(replaced[0].status, 'failed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].status, 'completed');
      assert.ok(completed[0].content.includes(replyPayload));
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
      assert.equal(side.assignmentFromAsker.callId, newCall);
      assert.equal(side.hasQueuedPrompt(), false);
      assert.ok(updatedContext);
      evidence.record({
        id: 'running-assignment-replacement-notice',
        scenario:
          'A registered request is replaced while its worker is inside generation. The old call receives this canonical failed result; the new call later completes.',
        businessValue:
          'Make the old call’s disposition understandable without treating the replacement as a second independent task or a successful old delivery.',
        context: {
          language: 'en',
          oldCallId: oldCall,
          newCallId: newCall,
          oldRequestPayload: oldBody,
          newRequestPayload: newBody,
        },
        reviewQuestions: [
          'Does the actual notice explain supersession and where the current work continues, without inviting a duplicate old reply?',
        ],
        actualText: replaced[0].content,
      });
      evidence.record({
        id: 'running-assignment-updated-context',
        scenario:
          'After the controlled old generation finishes locally, the reused worker receives its queued replacement. This is its actual provider context.',
        businessValue:
          'Adopt the current requirement at the generation boundary while preserving the correct requester and avoiding stale work delivery.',
        context: {
          language: 'en',
          oldCallId: oldCall,
          newCallId: newCall,
          oldRequestPayload: oldBody,
          newRequestPayload: newBody,
        },
        reviewQuestions: [
          'Does the context clearly distinguish historical assignment/candidate text from the current replacement requirement?',
          'Can the worker deliver the new result with the correct reply tool without redoing or delivering the superseded task?',
        ],
        actualText: JSON.stringify(updatedContext, null, 2),
      });
    } finally {
      releaseOld();
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log(
    'running registered assignment adopts the queued replacement at the generation boundary: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
