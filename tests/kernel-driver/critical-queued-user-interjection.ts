import assert from 'node:assert/strict';
import type WebSocket from 'ws';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { dialogEventRegistry } from '../../main/evt-registry';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { resolveCriticalCountdownRemaining } from '../../main/llm/kernel-driver/context-health';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { handleWebSocketMessage } from '../../main/server/websocket-handler';
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

const evidence = semanticEvidenceCollector('dominds-critical-ingress-');
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('seed provider did not start')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-critical-ingress';
    const toolName = 'critical_interjection_probe';
    const tool: FuncTool = {
      type: 'func',
      name: toolName,
      description: 'Controlled interjection lookup.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      argsValidation: 'passthrough',
      async call() {
        return toolSuccess('critical-tool-result-data');
      },
    };
    registerTool(tool);
    try {
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        for (const streaming of [true, false]) {
          for (const knownBeforeIngress of [false, true]) {
            const id = `${knownBeforeIngress ? 'known-pressure' : 'new-pressure'}-${language}-${streaming ? 'stream' : 'batch'}`;
            const previousUserLanguage = language === 'en' ? 'zh' : 'en';
            await writeStandardMinds(rtws, {
              providerApiType: apiType,
              streaming,
              memberTools: [toolName],
              modelContextLength: 200000,
              modelOptimalMaxTokens: 180000,
              modelCriticalMaxTokens: 180000,
            });
            const root = await createMainDialog();
            globalDialogRegistry.register(root);
            root.disableDiligencePush = true;
            const entered = gate();
            const release = gate();
            let requests = 0;
            const userRequest = knownBeforeIngress ? 3 : 2;
            const expectedRemaining = knownBeforeIngress ? 3 : 4;
            const userId = `interjection-${id}`;
            const payload = `incoming-user-payload-${id}`;
            const provider = messageProvider(
              apiType,
              async ({ request, context, genseq, systemPrompt, streaming: actualStreaming }) => {
                assert.equal(actualStreaming, streaming);
                assert.equal(request.dialogSelfId, root.id.selfId);
                requests += 1;
                assert.ok(requests <= userRequest + 1);
                if (requests < userRequest) {
                  if (requests === userRequest - 1) {
                    entered.resolve();
                    await release.promise;
                  }
                  return {
                    messages: [
                      {
                        type: 'saying_msg',
                        role: 'assistant',
                        genseq,
                        content: 'critical-seed-output-data',
                      },
                    ],
                    usage: {
                      kind: 'available',
                      promptTokens: 190000,
                      completionTokens: 10,
                      totalTokens: 190010,
                    },
                  };
                }
                const input = context
                  .filter((message) => message.type === 'prompting_msg')
                  .filter((message) => message.msgId === userId);
                assert.equal(input.length, 1);
                assert.equal(
                  input[0].content.split(payload).length,
                  2,
                  'the complete supplied user payload survives exactly once',
                );
                assert.equal(
                  resolveCriticalCountdownRemaining(root.id.key(), root.getLastContextHealth()),
                  expectedRemaining,
                  'the user turn is charged once before the request and its tool continuation',
                );
                if (requests === userRequest) {
                  if (streaming)
                    evidence.record({
                      id,
                      scenario: knownBeforeIngress
                        ? 'Raw user input arrives during a held preservation generation, after a real critical measurement and one normal preservation notice; ingress must charge the user once.'
                        : 'Raw user input arrives while the first generation is held; that generation then reports critical usage before the queued input executes.',
                      businessValue:
                        'Give the user an effective input/tool/reply turn under pressure while charging the bounded grace window once.',
                      context: {
                        language,
                        previousUserLanguage,
                        knownBeforeIngress,
                        actualCriticalPromptTokens: 190000,
                        expectedRemainingGraceTurns: expectedRemaining,
                      },
                      reviewQuestions: [
                        'Does the actual input guidance explain the current critical state and remaining opportunity to preserve or complete work without swallowing the user request?',
                        'Is its scope and capability guidance compatible with the actual request system prompt?',
                      ],
                      actualText: JSON.stringify(
                        { userPrompt: input[0].content, systemPrompt },
                        null,
                        2,
                      ),
                    });
                  return {
                    messages: [
                      {
                        type: 'func_call_msg',
                        role: 'assistant',
                        genseq,
                        id: `probe-${id}`,
                        name: toolName,
                        arguments: '{}',
                      },
                    ],
                    usage: {
                      kind: 'available',
                      promptTokens: 190050,
                      completionTokens: 10,
                      totalTokens: 190060,
                    },
                  };
                }
                const result = context
                  .filter((message) => message.type === 'func_result_msg')
                  .filter((message) => message.id === `probe-${id}`);
                assert.equal(result.length, 1);
                assert.equal(result[0].content, 'critical-tool-result-data');
                return {
                  messages: [
                    {
                      type: 'saying_msg',
                      role: 'assistant',
                      genseq,
                      content: 'interjection-final-output-data',
                    },
                  ],
                  usage: {
                    kind: 'available',
                    promptTokens: 1000,
                    completionTokens: 10,
                    totalTokens: 1010,
                  },
                };
              },
            );
            registerLlmGenerator(provider);
            const packets: unknown[] = [];
            const socketState = {
              readyState: 1,
              send(data: string) {
                packets.push(JSON.parse(data));
              },
            };
            const socket = socketState as unknown as WebSocket;
            let seed: ReturnType<typeof driveDialogStream> | undefined;
            try {
              seed = driveDialogStream(
                root,
                makeUserPrompt('critical-seed-input-data', `seed-${id}`, {
                  userLanguageCode: previousUserLanguage,
                }),
                true,
              );
              await bounded(entered.promise);
              assert.equal(root.getLastUserLanguageCode(), previousUserLanguage);
              if (!knownBeforeIngress) {
                const measured = root.getLastContextHealth();
                assert.ok(measured?.kind !== 'available' || measured.level !== 'critical');
              } else {
                const measured = root.getLastContextHealth();
                assert.ok(measured?.kind === 'available');
                assert.equal(measured.level, 'critical');
              }
              await handleWebSocketMessage(socket, {
                type: 'drive_dlg_by_user_msg',
                dialog: { rootId: root.id.rootId, selfId: root.id.selfId, status: 'running' },
                content: payload,
                msgId: userId,
                userLanguageCode: language,
              });
              const waiting = root.peekQueuedPrompt();
              assert.ok(waiting?.kind === 'user_generation_boundary');
              assert.equal(waiting.prompt.split(payload).length, 2);
              release.resolve();
              await seed;
              provider.assertNoErrors();
              await waitFor(
                async () =>
                  (
                    await DialogPersistence.loadCourseEvents(
                      root.id,
                      root.currentCourse,
                      root.status,
                    )
                  ).some(
                    (event) =>
                      event.type === 'agent_words_record' &&
                      event.content === 'interjection-final-output-data',
                  ),
                3000,
                'real queued/user tool-followup answer',
              );
              await waitForAllDialogsUnlocked(root, 3000);
              provider.assertNoErrors();
              const measured = root.getLastContextHealth();
              assert.ok(measured?.kind === 'available');
              assert.equal(measured.level, 'healthy');
              assert.equal(requests, userRequest + 1);
              assert.equal(root.currentCourse, 1);
              assert.equal(root.hasQueuedPrompt(), false);
              assert.equal(root.getLastUserLanguageCode(), language);
              const events = await DialogPersistence.loadCourseEvents(
                root.id,
                root.currentCourse,
                root.status,
              );
              const persistedInput = events
                .filter((event) => event.type === 'human_text_record')
                .filter((event) => event.msgId === userId);
              assert.equal(persistedInput.length, 1);
              assert.equal(persistedInput[0].origin, 'user');
              assert.equal(persistedInput[0].userLanguageCode, language);
              assert.equal(persistedInput[0].content.split(payload).length, 2);
              assert.equal(
                events.filter((event) => event.type === 'runtime_guide_record').length,
                0,
              );
              assert.equal(
                events.filter(
                  (event) => event.type === 'func_result_record' && event.id === `probe-${id}`,
                ).length,
                1,
              );
              assert.equal(
                packets.filter(
                  (packet) =>
                    packet &&
                    typeof packet === 'object' &&
                    'type' in packet &&
                    packet.type === 'error',
                ).length,
                0,
              );
            } finally {
              release.resolve();
              await seed;
              await waitForAllDialogsUnlocked(root, 3000);
              socketState.readyState = 3;
              dialogEventRegistry.endStream(root.id);
              globalDialogRegistry.unregister(root.id.rootId);
              unregisterLlmGenerator(apiType);
            }
          }
        }
      }
    } finally {
      unregisterTool(toolName);
    }
  });
  await evidence.write();
  console.log(
    'critical ingress and queued inputs preserve the user turn, tool continuation and bounded grace: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
