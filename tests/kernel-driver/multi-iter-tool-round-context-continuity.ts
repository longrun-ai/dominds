import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmBatchResult, LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, makeUserPrompt, withTempRtws, writeStandardMinds } from './helpers';

const ENV_KEY = 'DOMINDS_TEST_CTX_CONTINUITY';
async function main(): Promise<void> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'tool-result-data-c8d4';
  try {
    await withTempRtws(async (rtws) => {
      const apiType = 'test-tool-round-continuity';
      for (const streaming of [true, false]) {
        for (const intro of [false, true]) {
          await writeStandardMinds(rtws, {
            providerApiType: apiType,
            streaming,
            memberTools: ['env_get'],
          });
          const dlg = await createMainDialog();
          dlg.disableDiligencePush = true;
          const msgId = `continuity-${streaming}-${intro}`;
          const input = 'user-input-data-d9e5';
          const answer = 'final-output-data-eaf6';
          const callId = `probe-${streaming}-${intro}`;
          const contexts: ChatMessage[][] = [];
          const generate = (context: ChatMessage[], genseq: number): LlmBatchResult => {
            contexts.push(structuredClone(context));
            assert.ok(
              contexts.length <= 2,
              'tool-only output must not cause an empty-response retry',
            );
            const prompts = context.filter(
              (message): message is Extract<ChatMessage, { type: 'prompting_msg' }> =>
                message.type === 'prompting_msg' && message.msgId === msgId,
            );
            assert.equal(prompts.length, 1);
            assert.equal(prompts[0].content, input);
            const messages: ChatMessage[] =
              contexts.length === 1
                ? [
                    ...(intro
                      ? [
                          {
                            type: 'saying_msg' as const,
                            role: 'assistant' as const,
                            genseq,
                            content: 'intro-output-data-fb07',
                          },
                        ]
                      : []),
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: callId,
                      name: 'env_get',
                      arguments: JSON.stringify({ key: ENV_KEY }),
                    },
                  ]
                : [{ type: 'saying_msg', role: 'assistant', genseq, content: answer }];
            if (contexts.length === 2) {
              const calls = context.filter((message) => message.type === 'func_call_msg');
              const results = context.filter((message) => message.type === 'func_result_msg');
              assert.equal(calls.length, 1);
              assert.equal(results.length, 1);
              assert.equal(calls[0].id, callId);
              assert.equal(results[0].id, callId);
              assert.equal(results[0].content, process.env[ENV_KEY]);
              assert.ok(context.indexOf(prompts[0]) < context.indexOf(calls[0]));
              assert.ok(context.indexOf(calls[0]) < context.indexOf(results[0]));
            }
            return { messages, usage: { kind: 'unavailable' }, llmGenModel: 'default' };
          };
          const provider: LlmGenerator = {
            apiType,
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
              assert.equal(request.dialogSelfId, dlg.id.selfId);
              assert.equal(streaming, true);
              const output = generate(context, genseq);
              for (const message of output.messages) {
                if (message.type === 'func_call_msg')
                  await receiver.funcCall(message.id, message.name, message.arguments);
                else if (message.type === 'saying_msg') {
                  await receiver.sayingStart();
                  await receiver.sayingChunk(message.content);
                  await receiver.sayingFinish();
                } else assert.fail('unexpected controlled fixture output');
              }
              return { usage: output.usage, llmGenModel: output.llmGenModel };
            },
            async genMoreMessages(_provider, _agent, _system, _tools, request, context, genseq) {
              assert.equal(request.dialogSelfId, dlg.id.selfId);
              assert.equal(streaming, false);
              return generate(context, genseq);
            },
          };
          registerLlmGenerator(provider);
          try {
            await driveDialogStream(dlg, makeUserPrompt(input, msgId), true);
            assert.equal(contexts.length, 2);
            const events = await DialogPersistence.loadCourseEvents(
              dlg.id,
              dlg.currentCourse,
              dlg.status,
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === 'func_call_record')
                .map((event) => ({ id: event.id, name: event.name })),
              [{ id: callId, name: 'env_get' }],
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === 'func_result_record')
                .map((event) => ({ id: event.id, content: event.content })),
              [{ id: callId, content: process.env[ENV_KEY] }],
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === 'agent_words_record')
                .map((event) => event.content),
              intro ? ['intro-output-data-fb07', answer] : [answer],
            );
            assert.equal(
              events.filter((event) => event.type === 'human_text_record' && event.msgId === msgId)
                .length,
              1,
            );
          } finally {
            unregisterLlmGenerator(apiType);
          }
        }
      }
    });
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
  console.log(
    'tool-only and narrated tool rounds preserve input, call/result and final output in streaming and batch modes: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
