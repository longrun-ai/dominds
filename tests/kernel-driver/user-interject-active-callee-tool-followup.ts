import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';
import { messageProvider } from '../helpers/message-provider';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-background-interjection-');
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('background provider did not enter')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-background-interjection';
    const toolName = 'local_interjection_probe';
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const streaming of [true, false]) {
        const id = `${language}-${streaming ? 'stream' : 'batch'}`;
        await writeStandardMinds(rtws, {
          extraMembers: ['worker'],
          memberTools: [toolName],
          providerApiType: apiType,
          streaming,
        });
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        const entered = gate();
        const release = gate();
        let rootRequests = 0;
        let childRequests = 0;
        let toolCalls = 0;
        const actualRequests: unknown[] = [];
        const inputId = `local-user-${id}`;
        const input = `local-user-data-${id}`;
        const callId = `background-${id}`;
        const tool: FuncTool = {
          type: 'func',
          name: toolName,
          description: 'Controlled local lookup.',
          parameters: { type: 'object', properties: {} },
          argsValidation: 'passthrough',
          async call() {
            toolCalls += 1;
            return toolSuccess(`lookup-result-data-${id}`);
          },
        };
        registerTool(tool);
        const provider = messageProvider(
          apiType,
          async ({ request, context, systemPrompt, genseq, streaming: actualStreaming }) => {
            assert.equal(actualStreaming, streaming);
            if (request.dialogSelfId !== root.id.selfId) {
              childRequests += 1;
              assert.equal(childRequests, 1);
              entered.resolve();
              await release.promise;
              return {
                messages: [
                  {
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id: `reply-${id}`,
                    name: 'replyTellaskSessionless',
                    arguments: JSON.stringify({ replyContent: `background-result-data-${id}` }),
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            }
            rootRequests += 1;
            assert.ok(rootRequests <= 4);
            if (rootRequests === 1)
              return {
                messages: [
                  {
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id: callId,
                    name: 'tellaskSessionless',
                    arguments: JSON.stringify({
                      targetAgentId: 'worker',
                      tellaskContent: `background-task-data-${id}`,
                    }),
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            if (rootRequests === 2 || rootRequests === 3) {
              const user = context
                .filter((message) => message.type === 'prompting_msg')
                .filter((message) => message.msgId === inputId);
              assert.equal(user.length, 1);
              assert.equal(user[0].content, input);
              actualRequests.push({ systemPrompt, context });
              if (rootRequests === 2)
                return {
                  messages: [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: `lookup-${id}`,
                      name: toolName,
                      arguments: '{}',
                    },
                  ],
                  usage: { kind: 'unavailable' },
                };
              const results = context
                .filter((message) => message.type === 'func_result_msg')
                .filter((message) => message.id === `lookup-${id}`);
              assert.equal(results.length, 1);
              assert.equal(results[0].content, `lookup-result-data-${id}`);
              return {
                messages: [
                  {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq,
                    content: `local-answer-data-${id}`,
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            }
            const delivered = context
              .filter((message) => message.type === 'tellask_result_msg')
              .filter((message) => message.callId === callId);
            assert.equal(delivered.length, 1);
            assert.ok(delivered[0].content.includes(`background-result-data-${id}`));
            return {
              messages: [
                {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq,
                  content: `caller-consumed-data-${id}`,
                },
              ],
              usage: { kind: 'unavailable' },
            };
          },
        );
        registerLlmGenerator(provider);
        try {
          await driveDialogStream(root, makeUserPrompt(`start-data-${id}`, `start-${id}`), true);
          await bounded(entered.promise);
          assert.equal(
            (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
            1,
          );
          await driveDialogStream(
            root,
            makeUserPrompt(input, inputId, { userLanguageCode: language }),
            true,
          );
          provider.assertNoErrors();
          assert.equal(rootRequests, 3);
          assert.equal(toolCalls, 1);
          const before = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
          assert.equal(before.filter((event) => event.type === 'gen_start_record').length, 3);
          assert.equal(
            before.filter(
              (event) =>
                event.type === 'agent_words_record' && event.content === `local-answer-data-${id}`,
            ).length,
            1,
          );
          const persistedInput = before
            .filter((event) => event.type === 'human_text_record')
            .filter((event) => event.msgId === inputId);
          assert.equal(persistedInput.length, 1);
          assert.equal(persistedInput[0].content, input);
          assert.equal(persistedInput[0].tellaskReplyDirective, undefined);
          const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
          assert.equal(pending.length, 1);
          assert.equal(pending[0].callId, callId);
          assert.equal(
            before.filter(
              (event) => event.type === 'tellask_result_record' && event.callId === callId,
            ).length,
            0,
          );
          release.resolve();
          await waitFor(
            async () => {
              provider.assertNoErrors();
              return (await DialogPersistence.loadCourseEvents(root.id, 1, root.status)).some(
                (event) =>
                  event.type === 'agent_words_record' &&
                  event.content === `caller-consumed-data-${id}`,
              );
            },
            3000,
            'the actual background reply to be consumed after the local answer',
          );
          await waitForAllDialogsUnlocked(root, 3000);
          provider.assertNoErrors();
          assert.equal(rootRequests, 4);
          const after = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
          assert.equal(
            after.filter(
              (event) => event.type === 'tellask_result_record' && event.callId === callId,
            ).length,
            1,
          );
          assert.equal(
            (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
            0,
          );
          if (streaming)
            evidence.record({
              id,
              scenario:
                'A real background callee is held at its provider boundary while a new human input performs a local lookup and receives its answer; then the real background reply arrives.',
              businessValue:
                'Answer the current human through the immediate tool follow-up while retaining independent background work and its later result.',
              context: {
                language,
                activeBackgroundCallsDuringLocalAnswer: 1,
                localToolCalls: toolCalls,
                rootGenerationsBeforeBackgroundReply: 3,
              },
              reviewQuestions: [
                'Do both actual local requests prioritize the human input and its necessary tool result without prematurely finishing or abandoning background work?',
                'Are the current tool/answer channels consistent with the actual system and pending work?',
              ],
              actualText: JSON.stringify(actualRequests, null, 2),
            });
        } finally {
          release.resolve();
          await waitForAllDialogsUnlocked(root, 3000);
          globalDialogRegistry.unregister(root.id.rootId);
          unregisterLlmGenerator(apiType);
          unregisterTool(toolName);
        }
      }
    }
  });
  await evidence.write();
  console.log(
    'actual background work survives a local user tool-followup and delivers once afterward: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
