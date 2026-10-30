import assert from 'node:assert/strict';

import { clearActiveRun, createActiveRun } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-backend-blocked-wake';
    await writeStandardMinds(rtws, { includePangu: true, providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);
    const callId = 'blocked-wake-call-data';
    const session = 'blocked-wake-session';
    const replyPayload = 'reply-data-blocked-wake-625a';
    const finalPayload = 'root-data-blocked-wake-736b';
    let rootRounds = 0;
    let sideRounds = 0;
    let releaseSide: () => void = () => {};
    const sideRelease = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    let noteSideEntered: () => void = () => {};
    const sideEntered = new Promise<void>((resolve) => {
      noteSideEntered = resolve;
    });
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
                tellaskContent: 'request-data-blocked-wake-514f',
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
          noteSideEntered();
          await sideRelease;
          await receiver.funcCall(
            'blocked-wake-reply-data',
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
    const abort = new AbortController();
    const backend = runBackendDriver({ abortSignal: abort.signal });
    try {
      await driveDialogStream(
        root,
        makeUserPrompt('input-data-blocked-wake', 'blocked-wake-user'),
        true,
        makeDriveOptions({ suppressDiligencePush: true }),
      );
      await sideEntered;
      assert.equal(root.isLocked(), false);
      createActiveRun(root.id);
      releaseSide();
      await waitFor(
        async () => {
          const events = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          return events.some(
            (event) => event.type === 'tellask_result_record' && event.callId === callId,
          );
        },
        3_000,
        'formal reply to queue a root wake while the active-run blocker is present',
      );
      await waitFor(
        async () => globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId),
        3_000,
        'backend to observe the actual active-run blocker',
      );
      assert.equal(
        rootRounds,
        1,
        'the backend does not enter another root generation while it is blocked',
      );
      const blockedLatest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(hasPendingNextStepTriggers(blockedLatest), true);
      clearActiveRun(root.id);
      const wake = globalDialogRegistry.getLastDriveTrigger(root.id.rootId);
      assert.equal(wake?.action, 'active_run_cleared');
      assert.equal(wake?.nextDriveQueued, true);
      await waitFor(
        async () => rootRounds === 2,
        3_000,
        'backend to retry after the real blocker-cleared event',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(hasPendingNextStepTriggers(latest), false);
      const events = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      const words = events.filter((event) => event.type === 'agent_words_record');
      assert.equal(words.at(-1)?.content, finalPayload);
      const results = events
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === callId);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'completed');
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
    } finally {
      releaseSide();
      clearActiveRun(root.id);
      abort.abort();
      await backend;
      unregisterLlmGenerator(apiType);
    }
  });
  console.log(
    'backend retries the preserved collaboration wake after its active-run blocker clears: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
