import assert from 'node:assert/strict';
import { hasDurableDriveWork } from '../../main/dialog-drive-work';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { Team } from '../../main/team';
import { setDialogGoalTool } from '../../main/tools/ctrl';
import { createMainDialog, makeDriveOptions, withTempRtws, writeStandardMinds } from './helpers';

async function main() {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-backend-preflight-consumed';
    await writeStandardMinds(rtws, {
      providerApiType: apiType,
      streaming: true,
      diligencePushMax: 0,
    });
    const root = await createMainDialog();
    root.disableDiligencePush = true;
    await DialogPersistence.mutateDialogLatest(
      root.id,
      () => ({ kind: 'patch', patch: { disableDiligencePush: true } }),
      root.status,
    );
    globalDialogRegistry.register(root);
    const goal = await setDialogGoalTool.call(
      root,
      new Team.Member({ id: 'tester', name: 'Tester' }),
      { mode: 'goal', goal: 'Consume only the supplied queued work and preserve its result.' },
    );
    assert.equal(goal.outcome, 'success');
    const requests: string[][] = [];
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver) {
        // Capture the actual public request data without throwing inside the provider
        // boundary, where real retry policy would otherwise hide an assertion failure.
        requests.push(
          context.flatMap((message) =>
            'content' in message && typeof message.content === 'string' ? [message.content] : [],
          ),
        );
        await receiver.sayingStart();
        await receiver.sayingChunk('response-data-' + requests.length);
        await receiver.sayingFinish();
        return {
          usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          llmGenModel: 'default',
        };
      },
      async genMoreMessages() {
        throw new Error('Streaming boundary fixture only');
      },
    };
    registerLlmGenerator(generator);
    const originalCanDrive = root.canDrive;
    let releasePreflight: () => void = () => {};
    const preflightReleased = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let notePreflight: () => void = () => {};
    const preflightEntered = new Promise<void>((resolve) => {
      notePreflight = resolve;
    });
    let observedCanDrive: boolean | undefined;
    let backend: Promise<void> | undefined;
    try {
      const firstInput = 'queued-data:preflight-race-first:4e2c';
      await root.queueRuntimeGuidePrompt({
        prompt: firstInput,
        msgId: 'preflight-first-input',
        grammar: 'markdown',
        skipTaskdoc: true,
      });
      root.canDrive = async function () {
        root.canDrive = originalCanDrive;
        observedCanDrive = await originalCanDrive.call(this);
        notePreflight();
        await preflightReleased;
        return observedCanDrive;
      };
      backend = driveQueuedDialogsOnce();
      await preflightEntered;
      assert.equal(observedCanDrive, true);
      // The backend has checked the real pending source and drive eligibility but
      // has not acquired the dialog mutex. Another real drive now consumes it.
      await driveDialogStream(
        root,
        undefined,
        true,
        makeDriveOptions({ suppressDiligencePush: true }),
      );
      assert.equal(requests.length, 1);
      assert.ok(requests[0]!.some((content) => content.includes(firstInput))); // Entire supplied opaque payload, not generated meaning.
      assert.equal(root.hasQueuedPrompt(), false);
      const consumed = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.ok(consumed);
      assert.equal(hasDurableDriveWork(consumed), false);
      assert.equal(await DialogPersistence.hasRootRuntimeWake(root.id, root.status), false);
      releasePreflight();
      await backend;
      assert.equal(
        requests.length,
        1,
        'A stale backend preflight must not start a second provider request with no remaining work',
      );
      const firstEvents = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(firstEvents.filter((event) => event.type === 'gen_start_record').length, 1);
      const laterInput = 'queued-data:preflight-race-later:8f6a';
      await root.queueRuntimeGuidePrompt({
        prompt: laterInput,
        msgId: 'preflight-later-input',
        grammar: 'markdown',
        skipTaskdoc: true,
      });
      await driveQueuedDialogsOnce();
      assert.equal(
        requests.length,
        2,
        'A genuinely new pending source must still be driven by the backend',
      );
      assert.ok(requests[1]!.some((content) => content.includes(laterInput)));
      const events = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 2);
      assert.deepEqual(
        events.filter((event) => event.type === 'agent_words_record').map((event) => event.content),
        ['response-data-1', 'response-data-2'],
      );
      const final = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(hasDurableDriveWork(final), false);
      assert.equal(root.hasQueuedPrompt(), false);
    } finally {
      root.canDrive = originalCanDrive;
      releasePreflight();
      if (backend) await backend;
      unregisterLlmGenerator(apiType);
      globalDialogRegistry.unregister(root.id.rootId);
    }
  });
  console.log(
    'Backend revalidates consumed work after its awaited preflight and drives fresh work: PASS',
  );
}
const watchdog = setTimeout(() => {
  throw new Error('Backend preflight case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
