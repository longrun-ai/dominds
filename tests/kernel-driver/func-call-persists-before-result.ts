import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Dialog } from '../../main/dialog';
import { requestInterruptDialog } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-tool-durability-');
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function probe(name: string, call: FuncTool['call']): FuncTool {
  return {
    type: 'func',
    name,
    description: 'Controlled external effect boundary.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    argsValidation: 'passthrough',
    call,
  };
}
function call(id: string, name: string, genseq: number): ChatMessage {
  return { type: 'func_call_msg', role: 'assistant', genseq, id, name, arguments: '{}' };
}
function saying(content: string, genseq: number): ChatMessage {
  return { type: 'saying_msg', role: 'assistant', genseq, content };
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-tool-durability';
    for (const streaming of [true, false]) {
      const mode = streaming ? 'stream' : 'batch';
      await writeStandardMinds(rtws, {
        providerApiType: apiType,
        streaming,
        memberTools: ['durability_slow', 'durability_fast'],
      });
      let targetId = '';
      let rounds = 0;
      let generate: (context: ChatMessage[], genseq: number) => ChatMessage[] = () => {
        throw new Error('scenario not configured');
      };
      const generator: LlmGenerator = {
        apiType,
        classifyFailure(error) {
          return {
            kind: 'fatal',
            code: 'test_provider_failure',
            message: error instanceof Error ? error.message : String(error),
          };
        },
        async genMoreMessages(_provider, _agent, _system, _tools, request, context, genseq) {
          assert.equal(streaming, false);
          assert.equal(request.dialogSelfId, targetId);
          rounds += 1;
          return { messages: generate(context, genseq), usage: { kind: 'unavailable' } };
        },
        async genToReceiver(
          _provider,
          _agent,
          _system,
          _tools,
          request,
          context,
          receiver,
          genseq,
        ) {
          assert.equal(streaming, true);
          assert.equal(request.dialogSelfId, targetId);
          rounds += 1;
          for (const message of generate(context, genseq)) {
            if (message.type === 'func_call_msg')
              await receiver.funcCall(message.id, message.name, message.arguments);
            else if (message.type === 'saying_msg') {
              await receiver.sayingStart();
              await receiver.sayingChunk(message.content);
              await receiver.sayingFinish();
            } else assert.fail('unexpected controlled output');
          }
          return { usage: { kind: 'unavailable' } };
        },
      };
      registerLlmGenerator(generator);
      try {
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        targetId = root.id.selfId;
        const slowStarted = gate();
        const fastStarted = gate();
        const release = gate();
        const ids = [`slow-${mode}`, `fast-${mode}`];
        const assertCallsDurable = async (dialog: Dialog) => {
          const events = await DialogPersistence.loadCourseEvents(
            dialog.id,
            dialog.currentCourse,
            dialog.status,
          );
          assert.deepEqual(
            events.filter((event) => event.type === 'func_call_record').map((event) => event.id),
            ids,
            'all calls are durable at each external execution boundary',
          );
        };
        registerTool(
          probe('durability_slow', async (dialog) => {
            await assertCallsDurable(dialog);
            slowStarted.resolve();
            await release.promise;
            return toolSuccess('slow-result-data');
          }),
        );
        registerTool(
          probe('durability_fast', async (dialog) => {
            await assertCallsDurable(dialog);
            fastStarted.resolve();
            return toolSuccess('fast-result-data');
          }),
        );
        generate = (context, genseq) => {
          assert.ok(rounds <= 2);
          if (rounds === 1)
            return [
              call(ids[0], 'durability_slow', genseq),
              call(ids[1], 'durability_fast', genseq),
            ];
          const results = context.filter((message) => message.type === 'func_result_msg');
          assert.equal(results.length, 2);
          for (const [id, payload] of [
            [ids[0], 'slow-result-data'],
            [ids[1], 'fast-result-data'],
          ])
            assert.equal(results.find((result) => result.id === id)?.content, payload);
          return [saying('parallel-finished-data', genseq)];
        };
        const live = recordDialogEvents(root);
        const drive = driveDialogStream(
          root,
          makeUserPrompt('parallel-input-data', `parallel-${mode}`),
          true,
        );
        try {
          await bounded(
            Promise.all([slowStarted.promise, fastStarted.promise]),
            'both tools started',
          );
          const during = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.equal(
            during.filter((event) => event.type === 'func_result_record' && event.id === ids[0])
              .length,
            0,
          );
          release.resolve();
          await drive;
          assert.equal(rounds, 2);
          const events = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.equal(events.filter((event) => event.type === 'func_call_record').length, 2);
          assert.equal(events.filter((event) => event.type === 'func_result_record').length, 2);
          const firstResult = events.findIndex((event) => event.type === 'func_result_record');
          for (const id of ids)
            assert.ok(
              events.findIndex((event) => event.type === 'func_call_record' && event.id === id) <
                firstResult,
            );
          const packets = await live.finish();
          assert.deepEqual(
            packets
              .filter((event) => event.type === 'func_call_requested_evt')
              .map((event) => event.funcId),
            ids,
          );
        } finally {
          release.resolve();
          await drive;
          unregisterTool('durability_slow');
          unregisterTool('durability_fast');
        }

        await writeStandardMinds(rtws, {
          providerApiType: apiType,
          streaming,
          memberTools: ['durability_effect', 'durability_inspect'],
        });
        const uncertain = await createMainDialog();
        uncertain.disableDiligencePush = true;
        targetId = uncertain.id.selfId;
        rounds = 0;
        const receiptFile = path.join(rtws, `external-receipt-${mode}.txt`);
        let effects = 0;
        let inspections = 0;
        registerTool(
          probe('durability_effect', async () => {
            effects += 1;
            await fs.appendFile(receiptFile, 'committed-effect-data\n');
            return toolSuccess('effect-completed-data');
          }),
        );
        registerTool(
          probe('durability_inspect', async () => {
            inspections += 1;
            return toolSuccess(await fs.readFile(receiptFile, 'utf8'));
          }),
        );
        try {
          const uncertainId = `uncertain-effect-${mode}`;
          generate = (_context, genseq) => {
            assert.equal(rounds, 1);
            return [call(uncertainId, 'durability_effect', genseq)];
          };
          const append = DialogPersistence.appendEvent;
          let failedWrites = 0;
          DialogPersistence.appendEvent = async (dialogId, course, event, status) => {
            if (
              dialogId.selfId === uncertain.id.selfId &&
              event.type === 'func_result_record' &&
              event.id === uncertainId
            ) {
              failedWrites += 1;
              throw Object.assign(new Error('controlled-result-write-failure-data'), {
                code: 'EIO',
              });
            }
            return append.call(DialogPersistence, dialogId, course, event, status);
          };
          try {
            await driveDialogStream(
              uncertain,
              makeUserPrompt('commit-effect-input-data', `effect-${mode}`),
              true,
            );
          } finally {
            DialogPersistence.appendEvent = append;
          }
          assert.ok(failedWrites > 0);
          assert.equal(effects, 1);
          assert.equal(await fs.readFile(receiptFile, 'utf8'), 'committed-effect-data\n');
          const before = await DialogPersistence.loadCourseEvents(
            uncertain.id,
            uncertain.currentCourse,
            uncertain.status,
          );
          assert.equal(
            before.filter((event) => event.type === 'func_call_record' && event.id === uncertainId)
              .length,
            1,
          );
          assert.equal(
            before.filter(
              (event) => event.type === 'func_result_record' && event.id === uncertainId,
            ).length,
            0,
          );
          globalDialogRegistry.unregister(uncertain.id.rootId);
          const restored = await getOrRestoreMainDialog(uncertain.id.rootId, uncertain.status);
          assert.ok(restored);
          assert.notEqual(restored, uncertain);
          restored.disableDiligencePush = true;
          rounds = 0;
          generate = (context, genseq) => {
            assert.ok(rounds <= 2);
            if (rounds === 1) {
              const recovered = context
                .filter((message) => message.type === 'func_result_msg')
                .filter((message) => message.id === uncertainId);
              assert.equal(recovered.length, 1);
              evidence.record({
                id: `unpaired-after-effect-${mode}`,
                scenario:
                  'The external tool committed its effect, then writing its result failed; a new dialog object is restored from the durable call without its result.',
                businessValue:
                  'Recover a complete call/result protocol without claiming that the effect failed or inviting an unsafe duplicate operation.',
                context: {
                  streaming,
                  durableCallId: uncertainId,
                  committedExternalEffects: effects,
                  durableOriginalResults: 0,
                },
                reviewQuestions: [
                  'Does the actual recovery text accurately distinguish an unknown/unrecorded outcome from an invocation known to have failed?',
                  'Does it direct the executor to verify effects or safe retry/idempotency before repeating a potentially non-idempotent operation?',
                ],
                actualText: recovered[0].content,
              });
              return [call(`inspect-${mode}`, 'durability_inspect', genseq)];
            }
            const receipt = context.find(
              (message) => message.type === 'func_result_msg' && message.id === `inspect-${mode}`,
            );
            assert.ok(receipt?.type === 'func_result_msg');
            assert.equal(receipt.content, 'committed-effect-data\n');
            return [saying('verified-effect-output-data', genseq)];
          };
          await driveDialogStream(
            restored,
            makeUserPrompt('verify-effect-input-data', `recover-${mode}`),
            true,
            makeDriveOptions({ allowResumeFromInterrupted: true }),
          );
          assert.equal(rounds, 2);
          assert.equal(effects, 1);
          assert.equal(inspections, 1);
          const after = await DialogPersistence.loadCourseEvents(
            restored.id,
            restored.currentCourse,
            restored.status,
          );
          assert.equal(
            after.filter((event) => event.type === 'func_result_record' && event.id === uncertainId)
              .length,
            1,
          );
          generate = (_context, genseq) => [saying('later-output-data', genseq)];
          await driveDialogStream(
            restored,
            makeUserPrompt('later-input-data', `later-${mode}`),
            true,
          );
          assert.equal(rounds, 3);
          const reread = await DialogPersistence.loadCourseEvents(
            restored.id,
            restored.currentCourse,
            restored.status,
          );
          assert.equal(
            reread.filter(
              (event) => event.type === 'func_result_record' && event.id === uncertainId,
            ).length,
            1,
          );
          assert.equal(effects, 1);
        } finally {
          unregisterTool('durability_effect');
          unregisterTool('durability_inspect');
        }

        await writeStandardMinds(rtws, {
          providerApiType: apiType,
          streaming,
          memberTools: ['durability_effect'],
        });
        const interrupted = await createMainDialog();
        interrupted.disableDiligencePush = true;
        targetId = interrupted.id.selfId;
        rounds = 0;
        const entered = gate();
        const releaseInterrupt = gate();
        let interruptedEffects = 0;
        const interruptedReceipt = path.join(rtws, `interrupted-receipt-${mode}.txt`);
        registerTool(
          probe('durability_effect', async () => {
            interruptedEffects += 1;
            await fs.writeFile(interruptedReceipt, 'committed-before-stop-data');
            entered.resolve();
            await releaseInterrupt.promise;
            return toolSuccess('late-success-data');
          }),
        );
        generate = (_context, genseq) => {
          assert.equal(rounds, 1);
          return [call(`interrupted-${mode}`, 'durability_effect', genseq)];
        };
        const stoppedDrive = driveDialogStream(
          interrupted,
          makeUserPrompt('interrupt-effect-input-data', `interrupt-${mode}`),
          true,
        );
        try {
          await bounded(entered.promise, 'external effect before stop');
          await requestInterruptDialog(interrupted.id, 'user_stop');
          releaseInterrupt.resolve();
          await stoppedDrive;
          assert.equal(interruptedEffects, 1);
          assert.equal(await fs.readFile(interruptedReceipt, 'utf8'), 'committed-before-stop-data');
          const events = await DialogPersistence.loadCourseEvents(
            interrupted.id,
            interrupted.currentCourse,
            interrupted.status,
          );
          const results = events
            .filter((event) => event.type === 'func_result_record')
            .filter((event) => event.id === `interrupted-${mode}`);
          assert.equal(results.length, 1);
          assert.equal(results[0].content.includes('late-success-data'), false);
          assert.equal(events.filter((event) => event.type === 'agent_words_record').length, 0);
          const latest = await DialogPersistence.loadDialogLatest(
            interrupted.id,
            interrupted.status,
          );
          assert.ok(latest?.displayState?.kind === 'stopped');
          assert.equal(latest.displayState.reason.kind, 'user_stop');
          assert.ok(latest.executionMarker?.kind === 'interrupted');
          assert.equal(latest.executionMarker.reason.kind, 'user_stop');
          evidence.record({
            id: `interrupted-after-effect-${mode}`,
            scenario:
              'A user stops a tool while its externally committed effect is already present; the handler later returns a success that the stopped driver cannot use.',
            businessValue:
              'Respect the stop, pair the durable call and preserve uncertainty about external effects for safe recovery.',
            context: { streaming, externalEffects: interruptedEffects, providerRounds: rounds },
            reviewQuestions: [
              'Does the actual interrupted result avoid implying that interruption undid or prevented an external effect?',
              'Does it advise effect verification before an unsafe retry?',
            ],
            actualText: results[0].content,
          });
        } finally {
          releaseInterrupt.resolve();
          await stoppedDrive;
          unregisterTool('durability_effect');
        }
      } finally {
        unregisterLlmGenerator(apiType);
      }
    }
  });
  await evidence.write();
  console.log(
    'durable tool calls, lost-result recovery and interruption preserve observed external effects: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
