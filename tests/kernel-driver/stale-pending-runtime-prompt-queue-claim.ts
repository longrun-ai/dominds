import assert from 'node:assert/strict';

import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { createMainDialog, makeDriveOptions, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-prompt-authority';
    await writeStandardMinds(rtws, { providerApiType: apiType });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    await root.startNewCourse(
      formatNewCourseStartPrompt('en', { nextCourse: 2, source: 'clear_mind' }),
    );
    const queued = root.peekQueuedPrompt();
    assert.ok(queued);
    await DialogPersistence.clearPendingRuntimePrompt(root.id, queued.msgId, root.status);
    assert.equal(root.hasQueuedPrompt(), true);
    let requests = 0;
    const requestedDialogIds: string[] = [];
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, _context, receiver) {
        requests += 1;
        requestedDialogIds.push(request.dialogSelfId);
        await receiver.sayingStart();
        await receiver.sayingChunk('fresh-prompt-result-data-75bc');
        await receiver.sayingFinish();
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
      await driveDialogStream(root, undefined, true, makeDriveOptions());
      assert.equal(root.hasQueuedPrompt(), false);
      assert.equal(requests, 0, 'stale memory-only input never reaches the provider');
      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.ok(latest);
      assert.equal(latest.pendingRuntimePrompt, undefined);
      assert.equal(
        latest.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
        false,
      );
      const events = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 0);
      assert.equal(
        events.filter((event) => event.type === 'human_text_record' && event.msgId === queued.msgId)
          .length,
        0,
      );

      const freshRoot = await createMainDialog();
      freshRoot.disableDiligencePush = true;
      await freshRoot.startNewCourse(
        formatNewCourseStartPrompt('en', { nextCourse: 2, source: 'clear_mind' }),
      );
      const fresh = freshRoot.peekQueuedPrompt();
      assert.ok(fresh);
      await driveDialogStream(freshRoot, undefined, true, makeDriveOptions());
      assert.equal(requests, 1, 'the same runtime actually accepts a fresh durable pending input');
      assert.deepEqual(requestedDialogIds, [freshRoot.id.selfId]);
      const freshEvents = await DialogPersistence.loadCourseEvents(
        freshRoot.id,
        freshRoot.currentCourse,
        freshRoot.status,
      );
      assert.equal(
        freshEvents.filter(
          (event) => event.type === 'human_text_record' && event.msgId === fresh.msgId,
        ).length,
        1,
      );
      assert.equal(
        freshEvents.filter(
          (event) =>
            event.type === 'agent_words_record' &&
            event.content === 'fresh-prompt-result-data-75bc',
        ).length,
        1,
      );
      assert.equal(freshRoot.hasQueuedPrompt(), false);
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  console.log(
    'pending input requires durable authority; a fresh durable input executes once: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
