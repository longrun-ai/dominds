import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
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

const ENV_KEY = 'DOMINDS_TEST_MIXED_TOOL_ROUND';
async function main(): Promise<void> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'mixed-tool-value-data';
  try {
    await withTempRtws(async (rtws) => {
      const apiType = 'controlled-mixed-round';
      for (const streaming of [true, false]) {
        await writeStandardMinds(rtws, {
          providerApiType: apiType,
          streaming,
          includePangu: true,
          memberTools: ['env_get'],
        });
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        let rootRounds = 0;
        let childRounds = 0;
        const sessionSlug = 'mixed-suspension';
        const taskId = 'mixed-task-id-data';
        const generate = (
          dialogId: string,
          context: ChatMessage[],
          genseq: number,
        ): ChatMessage[] => {
          if (dialogId === root.id.selfId) {
            rootRounds += 1;
            assert.ok(rootRounds <= 3);
            if (rootRounds === 1)
              return [
                { type: 'saying_msg', role: 'assistant', genseq, content: 'mixed-intro-data' },
                {
                  type: 'func_call_msg',
                  role: 'assistant',
                  genseq,
                  id: taskId,
                  name: 'tellask',
                  arguments: JSON.stringify({
                    targetAgentId: 'pangu',
                    sessionSlug,
                    tellaskContent: 'mixed-task-payload-data',
                  }),
                },
                {
                  type: 'func_call_msg',
                  role: 'assistant',
                  genseq,
                  id: 'mixed-env-id-data',
                  name: 'env_get',
                  arguments: JSON.stringify({ key: ENV_KEY }),
                },
              ];
            if (rootRounds === 2) {
              const result = context.find(
                (message) =>
                  message.type === 'func_result_msg' && message.id === 'mixed-env-id-data',
              );
              assert.ok(result?.type === 'func_result_msg');
              assert.equal(result.content, process.env[ENV_KEY]);
            } else
              assert.equal(
                context.filter(
                  (message) =>
                    message.type === 'prompting_msg' && message.msgId === 'caller-next-input',
                ).length,
                1,
              );
            return [
              {
                type: 'saying_msg',
                role: 'assistant',
                genseq,
                content: rootRounds === 2 ? 'mixed-followup-data' : 'caller-next-output-data',
              },
            ];
          }
          const side = root.lookupSideDialog('pangu', sessionSlug);
          assert.ok(side);
          assert.equal(dialogId, side.id.selfId);
          childRounds += 1;
          assert.equal(childRounds, 1);
          return [
            {
              type: 'func_call_msg',
              role: 'assistant',
              genseq,
              id: 'child-human-id-data',
              name: 'askHuman',
              arguments: JSON.stringify({ tellaskContent: 'child-question-payload-data' }),
            },
          ];
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
            return {
              messages: generate(request.dialogSelfId, context, genseq),
              usage: { kind: 'unavailable' },
            };
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
            for (const message of generate(request.dialogSelfId, context, genseq)) {
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
          await driveDialogStream(
            root,
            makeUserPrompt('mixed-round-input-data', `mixed-${streaming}`),
            true,
          );
          await waitFor(
            async () => {
              const side = root.lookupSideDialog('pangu', sessionSlug);
              return (
                side !== undefined &&
                (await DialogPersistence.loadQuestions4HumanState(side.id, side.status)).length ===
                  1
              );
            },
            3000,
            'the child actually reach its own human-question boundary',
          );
          await waitForAllDialogsUnlocked(root, 3000);
          assert.equal(rootRounds, 2);
          assert.equal(childRounds, 1);
          const side = root.lookupSideDialog('pangu', sessionSlug);
          assert.ok(side);
          const questions = await DialogPersistence.loadQuestions4HumanState(side.id, side.status);
          assert.equal(questions.length, 1);
          assert.equal(questions[0].callId, 'child-human-id-data');
          assert.equal(questions[0].tellaskContent, 'child-question-payload-data');
          assert.deepEqual(await root.getSuspensionStatus(), {
            q4h: false,
            backgroundCalleeDialogs: true,
            canDrive: true,
          });
          assert.deepEqual(await side.getSuspensionStatus(), {
            q4h: true,
            backgroundCalleeDialogs: false,
            canDrive: false,
          });
          const before = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.equal(before.filter((event) => event.type === 'gen_start_record').length, 2);
          assert.equal(
            before.filter(
              (event) => event.type === 'func_call_record' && event.id === 'mixed-env-id-data',
            ).length,
            1,
          );
          assert.equal(
            before.filter(
              (event) => event.type === 'func_result_record' && event.id === 'mixed-env-id-data',
            ).length,
            1,
          );
          assert.deepEqual(
            before
              .filter((event) => event.type === 'agent_words_record')
              .map((event) => event.content),
            ['mixed-intro-data', 'mixed-followup-data'],
          );
          assert.equal(
            (await DialogPersistence.loadDialogLatest(root.id, root.status))?.displayState?.kind,
            'idle_waiting_user',
          );
          await driveDialogStream(
            root,
            makeUserPrompt('caller-next-input-data', 'caller-next-input'),
            true,
          );
          await waitForAllDialogsUnlocked(root, 3000);
          assert.equal(rootRounds, 3);
          assert.equal(childRounds, 1);
          assert.deepEqual(
            await DialogPersistence.loadQuestions4HumanState(side.id, side.status),
            questions,
          );
          const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
          assert.equal(pending.length, 1);
          assert.equal(pending[0].callId, taskId);
          const final = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.equal(
            final.filter(
              (event) =>
                event.type === 'tellask_result_record' &&
                event.callId === taskId &&
                event.status !== 'pending',
            ).length,
            0,
          );
          assert.equal(
            final.filter((event) => event.type === 'agent_words_record').at(-1)?.content,
            'caller-next-output-data',
          );
        } finally {
          unregisterLlmGenerator(apiType);
        }
      }
    });
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
  console.log(
    'local tool continuation and later caller work proceed while the child waits for its own human answer: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
