import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce, runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeDriveOptions,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-root-wakes';
    for (const streaming of [true, false]) {
      await writeStandardMinds(rtws, { providerApiType: apiType, streaming });
      for (const scenario of [
        'explicit-wake',
        'foreground-consumption',
        'running-backend',
        'backend-backlog',
      ] as const) {
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        const input = `wake-input-data-${scenario}-${streaming}`;
        const output = `wake-output-data-${scenario}-${streaming}`;
        let requests = 0;
        const generator: LlmGenerator = {
          apiType,
          classifyFailure(error) {
            return {
              kind: 'fatal',
              code: 'test_provider_failure',
              message: error instanceof Error ? error.message : String(error),
            };
          },
          async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
            assert.equal(streaming, true);
            assert.equal(request.dialogSelfId, root.id.selfId);
            requests += 1;
            assert.equal(requests, 1);
            const prompts = context
              .filter((message) => message.type === 'prompting_msg')
              .filter((message) => message.content === input);
            assert.equal(prompts.length, 1);
            await receiver.sayingStart();
            await receiver.sayingChunk(output);
            await receiver.sayingFinish();
            return { usage: { kind: 'unavailable' } };
          },
          async genMoreMessages(_provider, _agent, _system, _tools, request, context, genseq) {
            assert.equal(streaming, false);
            assert.equal(request.dialogSelfId, root.id.selfId);
            requests += 1;
            assert.equal(requests, 1);
            const prompts = context
              .filter((message) => message.type === 'prompting_msg')
              .filter((message) => message.content === input);
            assert.equal(prompts.length, 1);
            return {
              messages: [{ type: 'saying_msg', role: 'assistant', genseq, content: output }],
              usage: { kind: 'unavailable' },
            };
          },
        };
        registerLlmGenerator(generator);
        try {
          if (scenario === 'foreground-consumption') {
            globalDialogRegistry.register(root);
            await DialogPersistence.upsertRootRuntimeWake(
              root.id,
              'foreground-wake-data',
              root.status,
            );
            globalDialogRegistry.queueRootDrive(root.id.rootId, {
              source: 'kernel_driver_test',
              reason: 'foreground-wake-data',
            });
            assert.equal(
              globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId),
              false,
            );
            await driveDialogStream(
              root,
              {
                content: input,
                msgId: `foreground-${streaming}`,
                grammar: 'markdown',
                origin: 'runtime',
              },
              true,
              makeDriveOptions({
                source: 'ws_resume_dialog',
                reason: 'consume-wake-data',
                suppressDiligencePush: true,
              }),
            );
            await driveQueuedDialogsOnce();
          } else if (scenario === 'running-backend') {
            globalDialogRegistry.register(root);
            const controller = new AbortController();
            const backend = runBackendDriver({ abortSignal: controller.signal });
            try {
              await root.startNewCourse(input);
              await waitFor(
                async () =>
                  (
                    await DialogPersistence.loadCourseEvents(
                      root.id,
                      root.currentCourse,
                      root.status,
                    )
                  ).some(
                    (event) => event.type === 'agent_words_record' && event.content === output,
                  ),
                3000,
                'the already running backend consume new work without Continue',
              );
              await waitForAllDialogsUnlocked(root, 3000);
            } finally {
              controller.abort();
              await backend;
            }
          } else {
            await root.startNewCourse(input);
            const queued = root.peekQueuedPrompt();
            assert.ok(queued);
            const ordinaryEntries = (
              await DialogPersistence.loadWakeQueueEntries(root.id, root.status)
            ).filter((entry) => entry.kind !== 'root_runtime_wake');
            assert.ok(
              ordinaryEntries.length > 0,
              'capture real persisted route projections for stale-route recovery',
            );
            globalDialogRegistry.register(root);
            await waitFor(
              async () =>
                globalDialogRegistry.getLastDriveTrigger(root.id.rootId)?.source ===
                'dialog_registry_hydration',
              3000,
              'registry hydrate the actual durable work',
            );
            if (scenario === 'explicit-wake') {
              globalDialogRegistry.clearRootDriveQueue(root.id.rootId, {
                source: 'kernel_driver_test',
                reason: 'park-known-work-data',
              });
              await driveQueuedDialogsOnce();
              assert.equal(
                requests,
                0,
                'unwoken durable work must not generate a provider request',
              );
              const before = await DialogPersistence.loadCourseEvents(
                root.id,
                root.currentCourse,
                root.status,
              );
              assert.equal(before.filter((event) => event.type === 'gen_start_record').length, 0);
              globalDialogRegistry.queueRootDrive(root.id.rootId, {
                source: 'kernel_driver_test',
                reason: 'resume-known-work-data',
              });
              await driveQueuedDialogsOnce();
              await waitForAllDialogsUnlocked(root, 3000);
              assert.equal(requests, 1);
              assert.equal(await DialogPersistence.hasRootRuntimeWake(root.id, root.status), false);
              // Reproduce an older derived route surviving after its authoritative prompt was consumed.
              await fs.writeFile(
                path.join(rtws, '.dialogs', 'run', root.id.rootId, 'wake-queue.jsonl'),
                ordinaryEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
              );
              assert.equal(
                (await DialogPersistence.loadWakeQueueEntries(root.id, root.status)).length,
                ordinaryEntries.length,
              );
              globalDialogRegistry.queueRootDrive(root.id.rootId, {
                source: 'kernel_driver_test',
                reason: 'stale-route-data',
              });
              await driveQueuedDialogsOnce();
              assert.equal(
                requests,
                1,
                'a stale route projection must not repeat the completed work',
              );
              assert.deepEqual(
                await DialogPersistence.loadWakeQueueEntries(root.id, root.status),
                [],
              );
            } else {
              const controller = new AbortController();
              const backend = runBackendDriver({ abortSignal: controller.signal });
              try {
                await waitFor(
                  async () => {
                    const events = await DialogPersistence.loadCourseEvents(
                      root.id,
                      root.currentCourse,
                      root.status,
                    );
                    return events.some(
                      (event) => event.type === 'agent_words_record' && event.content === output,
                    );
                  },
                  3000,
                  'the real backend consume the queued prompt without a human Continue',
                );
                await waitForAllDialogsUnlocked(root, 3000);
              } finally {
                controller.abort();
                await backend;
              }
            }
            const events = await DialogPersistence.loadCourseEvents(
              root.id,
              root.currentCourse,
              root.status,
            );
            assert.equal(
              events.filter(
                (event) => event.type === 'human_text_record' && event.msgId === queued.msgId,
              ).length,
              1,
            );
          }
          assert.equal(requests, 1);
          const events = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 1);
          assert.equal(
            events.filter((event) => event.type === 'human_text_record' && event.content === input)
              .length,
            1,
          );
          assert.deepEqual(
            events
              .filter((event) => event.type === 'agent_words_record')
              .map((event) => event.content),
            [output],
          );
          const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
          assert.ok(latest);
          assert.equal(latest.pendingRuntimePrompt, undefined);
          assert.deepEqual(latest.nextStep.triggers, []);
          assert.equal(await DialogPersistence.hasRootRuntimeWake(root.id, root.status), false);
          assert.equal(globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId), false);
          assert.equal(root.hasQueuedPrompt(), false);
          await driveQueuedDialogsOnce();
          assert.equal(requests, 1);
        } finally {
          unregisterLlmGenerator(apiType);
          globalDialogRegistry.unregister(root.id.rootId);
        }
      }
    }
  });
  console.log(
    'root wake lifecycle consumes each prompt once and ignores unwoken or stale routing work: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
