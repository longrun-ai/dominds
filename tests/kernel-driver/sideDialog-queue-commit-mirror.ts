import assert from 'node:assert/strict';

import { DialogID, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream, restoreDialogHierarchy } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

function resultProjection(messages: readonly ChatMessage[]) {
  return messages
    .filter((message) => message.type === 'tellask_result_msg')
    .map((message) => ({
      callId: message.callId,
      callName: message.callName,
      status: message.status,
      role: message.role,
      content: message.content,
      responder: message.responder,
      call: message.call,
      route: message.route,
    }));
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-mirror-commit';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    const callIds = ['mirror-call-one-data', 'mirror-call-two-data'];
    const requestPayloads = ['request-data-one-c37a', 'request-data-two-d48b'];
    const replyPayloads = ['reply-data-one-49ae', 'reply-data-two-5abf'];
    const finalPayload = 'root-data-mirror-f43b';
    const contexts = new Map<string, ChatMessage[][]>();
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        const rounds = contexts.get(request.dialogSelfId) ?? [];
        rounds.push(structuredClone(context));
        contexts.set(request.dialogSelfId, rounds);
        if (request.dialogSelfId === root.id.selfId) {
          assert.ok(rounds.length <= 3);
          if (rounds.length > 1) {
            const previous = rounds.length - 2;
            const delivered = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === callIds[previous]);
            assert.equal(
              delivered.length,
              1,
              'each new reply reaches the provider before its follow-up action',
            );
            assert.equal(delivered[0].status, 'completed');
            assert.ok(delivered[0].content.includes(replyPayloads[previous]));
          }
          if (rounds.length < 3) {
            const next = rounds.length - 1;
            await receiver.funcCall(
              callIds[next],
              'tellaskSessionless',
              JSON.stringify({ targetAgentId: 'pangu', tellaskContent: requestPayloads[next] }),
            );
          } else {
            await receiver.sayingStart();
            await receiver.sayingChunk(finalPayload);
            await receiver.sayingFinish();
          }
        } else {
          const side = root.lookupDialog(request.dialogSelfId);
          assert.ok(side instanceof SideDialog);
          const slot = callIds.indexOf(side.assignmentFromAsker.callId);
          assert.ok(slot >= 0);
          if (rounds.length === 1) {
            await receiver.sayingStart();
            await receiver.sayingChunk(replyPayloads[slot]);
            await receiver.sayingFinish();
          } else {
            assert.equal(rounds.length, 2, 'plain output receives one requester-reply follow-up');
            await receiver.funcCall(
              `mirror-reply-tool-${slot}`,
              'replyTellaskSessionless',
              JSON.stringify({ replyContent: replyPayloads[slot] }),
            );
          }
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
      await driveDialogStream(root, makeUserPrompt('input-data-mirror', 'user-mirror-data'), true);
      await waitFor(
        async () => contexts.get(root.id.selfId)?.length === 3,
        3_000,
        'root to consume the canonical reply',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      const live = resultProjection(root.msgs);
      assert.equal(live.length, 2, 'two distinct results make restored order observable');
      assert.deepEqual(
        live.map((result) => result.callId),
        callIds,
      );
      assert.equal(new Set(live.map((result) => result.route?.calleeDialogId)).size, 2);
      const rootEvents = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      let previousMirrorIndex = -1;
      for (const [index, result] of live.entries()) {
        const callId = callIds[index];
        assert.equal(result.call?.tellaskContent, requestPayloads[index]);
        assert.equal(result.responder?.responderId, 'pangu');
        assert.equal(result.status, 'completed');
        assert.ok(result.content.includes(replyPayloads[index]));
        const route = result.route;
        assert.ok(
          route?.calleeDialogId &&
            route.calleeCourse !== undefined &&
            route.calleeGenseq !== undefined,
        );
        const callee = new DialogID(route.calleeDialogId, root.id.rootId);
        const events = await DialogPersistence.loadCourseEvents(
          callee,
          route.calleeCourse,
          root.status,
        );
        const anchors = events
          .filter((event) => event.type === 'tellask_anchor_record')
          .filter((event) => event.callId === callId);
        const assignment = anchors.find((event) => event.anchorRole === 'assignment');
        const response = anchors.find((event) => event.anchorRole === 'response');
        assert.ok(assignment && response);
        assert.equal(route.calleeGenseq, response.genseq);
        assert.notEqual(
          route.calleeGenseq,
          assignment.genseq,
          'UI deep link points to delivery rather than assignment',
        );
        const mirrorIndex = root.msgs.findIndex(
          (message) => message.type === 'tellask_result_msg' && message.callId === callId,
        );
        assert.ok(mirrorIndex > previousMirrorIndex);
        previousMirrorIndex = mirrorIndex;
        assert.equal(
          rootEvents.filter(
            (event) => event.type === 'tellask_result_record' && event.callId === callId,
          ).length,
          1,
        );
      }
      const finalIndex = root.msgs.findIndex(
        (message) => message.type === 'saying_msg' && message.content === finalPayload,
      );
      assert.ok(finalIndex > previousMirrorIndex);
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );

      await DialogPersistence.moveDialogStatus(root.id, 'running', 'completed');
      globalDialogRegistry.unregister(root.id.rootId);
      const restored = await restoreDialogHierarchy(root.id.rootId, 'completed');
      assert.deepEqual(
        resultProjection(restored.mainDialog.msgs),
        live,
        'restart preserves payload, route, multiplicity and order, without deduplicating the evidence',
      );
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  console.log(
    'requester mirror precedes provider/UI follow-up and survives restore exactly once: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
