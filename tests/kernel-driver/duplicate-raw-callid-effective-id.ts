import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const ENV_KEY = 'DOMINDS_DUP_RAW_CALL_ID_EFFECTIVE_ID';
async function main(): Promise<void> {
  const originalValue = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'controlled-env-value-data';
  try {
    await withTempRtws(async (rtws) => {
      const apiType = 'controlled-duplicate-ids';
      for (const streaming of [true, false]) {
        await writeStandardMinds(rtws, {
          providerApiType: apiType,
          streaming,
          memberTools: ['env_get'],
        });
        let root = await createMainDialog();
        root.disableDiligencePush = true;
        let targetId = root.id.selfId;
        let rounds = 0;
        let rawId = 'reused-raw-data';
        let answer = 'first-output-data';
        let mixed = false;
        const generate = (context: ChatMessage[], genseq: number): ChatMessage[] => {
          rounds += 1;
          assert.ok(rounds <= (mixed ? 1 : 2));
          if (rounds === 1)
            return [
              {
                type: 'func_call_msg',
                role: 'assistant',
                genseq,
                id: rawId,
                name: 'env_get',
                arguments: JSON.stringify({ key: ENV_KEY }),
              },
              ...(mixed
                ? [
                    {
                      type: 'func_call_msg' as const,
                      role: 'assistant' as const,
                      genseq,
                      id: rawId,
                      name: 'askHuman',
                      arguments: JSON.stringify({ tellaskContent: 'human-question-payload-data' }),
                    },
                  ]
                : []),
            ];
          const results = context.filter((message) => message.type === 'func_result_msg');
          const result = results.at(-1);
          assert.ok(result);
          assert.equal(result.content, process.env[ENV_KEY]);
          const paired = context.find(
            (message) => message.type === 'func_call_msg' && message.id === result.id,
          );
          assert.ok(paired?.type === 'func_call_msg');
          assert.equal(paired.rawId, rawId);
          return [{ type: 'saying_msg', role: 'assistant', genseq, content: answer }];
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
          const effectiveIds: string[] = [];
          for (const phase of ['first', 'second']) {
            rounds = 0;
            answer = `${phase}-output-data`;
            await driveDialogStream(
              root,
              makeUserPrompt(`${phase}-input-data`, `${phase}-${streaming}`),
              true,
            );
            assert.equal(rounds, 2);
            const events = await DialogPersistence.loadCourseEvents(
              root.id,
              root.currentCourse,
              root.status,
            );
            assert.equal(
              events.filter((event) => event.type === 'agent_words_record').at(-1)?.content,
              answer,
            );
            const calls = events.filter((event) => event.type === 'func_call_record');
            const current = calls.at(-1);
            assert.ok(current);
            assert.equal(current.rawId, rawId);
            if (phase === 'first') assert.equal(current.id, rawId);
            else assert.notEqual(current.id, rawId);
            effectiveIds.push(current.id);
            assert.equal(new Set(effectiveIds).size, effectiveIds.length);
            const results = events.filter((event) => event.type === 'func_result_record');
            assert.deepEqual(
              results.map((result) => result.id),
              calls.map((call) => call.id),
            );
            assert.ok(
              results.every(
                (result) => result.rawId === rawId && result.content === process.env[ENV_KEY],
              ),
            );
          }
          rawId = 'manual-raw-data';
          rounds = 0;
          answer = 'manual-output-data';
          await root.persistFunctionCall('manual-effective-data', 'env_get', '{}', 9, rawId);
          await DialogPersistence.appendEvent(
            root.id,
            root.currentCourse,
            {
              type: 'func_result_record',
              ts: '2026-10-30T00:00:00.000Z',
              genseq: 9,
              id: 'manual-effective-data',
              rawId,
              effectiveId: 'manual-effective-data',
              name: 'env_get',
              content: 'manual-history-result-data',
            },
            root.status,
          );
          const previousRoot = root;
          globalDialogRegistry.unregister(root.id.rootId);
          const restored = await getOrRestoreMainDialog(root.id.rootId, root.status);
          assert.ok(restored);
          assert.notEqual(restored, previousRoot);
          root = restored;
          root.disableDiligencePush = true;
          await driveDialogStream(
            root,
            makeUserPrompt('manual-input-data', `manual-${streaming}`),
            true,
          );
          assert.equal(rounds, 2);
          const manualEvents = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          const manualCalls = manualEvents
            .filter((event) => event.type === 'func_call_record')
            .filter((event) => event.rawId === rawId);
          assert.equal(manualCalls.length, 2);
          assert.notEqual(manualCalls[1].id, rawId);
          assert.notEqual(manualCalls[1].id, 'manual-effective-data');
          const restoredManual = await DialogPersistence.restoreDialog(root.id, root.status);
          assert.ok(restoredManual);
          assert.deepEqual(
            restoredManual.messages
              .filter((message) => message.type === 'func_call_msg')
              .map((message) => message.id),
            manualEvents
              .filter((event) => event.type === 'func_call_record')
              .map((event) => event.id),
          );

          rawId = 'reused-raw-data';
          rounds = 0;
          answer = 'new-course-output-data';
          await root.startNewCourse('new-course-input-data');
          await driveDialogStream(root, undefined, true, makeDriveOptions());
          assert.equal(rounds, 2);
          const newCourse = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          const newCalls = newCourse.filter((event) => event.type === 'func_call_record');
          assert.equal(newCalls.length, 1);
          assert.equal(newCalls[0].id, rawId);
          assert.equal(newCalls[0].rawId, rawId);
          assert.equal(newCourse.filter((event) => event.type === 'func_result_record').length, 1);

          const mixedRoot = await createMainDialog();
          mixedRoot.disableDiligencePush = true;
          targetId = mixedRoot.id.selfId;
          rounds = 0;
          mixed = true;
          rawId = 'shared-normal-human-id-data';
          await driveDialogStream(
            mixedRoot,
            makeUserPrompt('mixed-input-data', `mixed-${streaming}`),
            true,
          );
          assert.equal(rounds, 1);
          const events = await DialogPersistence.loadCourseEvents(
            mixedRoot.id,
            mixedRoot.currentCourse,
            mixedRoot.status,
          );
          const ordinary = events.filter((event) => event.type === 'func_call_record');
          const special = events.filter((event) => event.type === 'tellask_call_record');
          assert.equal(ordinary.length, 1);
          assert.equal(special.length, 1);
          assert.equal(ordinary[0].rawId, rawId);
          assert.notEqual(ordinary[0].id, rawId);
          assert.equal(special[0].id, rawId);
          assert.equal(special[0].name, 'askHuman');
          const paired = events.filter(
            (event) => event.type === 'func_result_record' && event.id === ordinary[0].id,
          );
          assert.equal(paired.length, 1);
          const questions = await DialogPersistence.loadQuestions4HumanState(
            mixedRoot.id,
            mixedRoot.status,
          );
          assert.equal(questions.length, 1);
          assert.equal(questions[0].callId, rawId);
          assert.equal(questions[0].tellaskContent, 'human-question-payload-data');
        } finally {
          unregisterLlmGenerator(apiType);
        }
      }
    });
  } finally {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  }
  console.log(
    'duplicate raw IDs keep unique course-scoped correlations and human-question ownership: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
