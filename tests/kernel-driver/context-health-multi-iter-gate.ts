import assert from 'node:assert/strict';

import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';
import { messageProvider } from '../helpers/message-provider';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, makeUserPrompt, withTempRtws, writeStandardMinds } from './helpers';

const evidence = semanticEvidenceCollector('dominds-caution-loop-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-context-caution';
    const toolName = 'caution_lookup_probe';
    const lookups: unknown[] = [];
    const tool: FuncTool = {
      type: 'func',
      name: toolName,
      description: 'Controlled lookup of one record.',
      parameters: { type: 'object', properties: { record: { type: 'number' } } },
      argsValidation: 'passthrough',
      async call(_dialog, _caller, args) {
        lookups.push(args.record);
        return toolSuccess(`lookup-data-${String(args.record)}`);
      },
    };
    registerTool(tool);
    try {
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        for (const streaming of [true, false]) {
          lookups.length = 0;
          await writeStandardMinds(rtws, {
            providerApiType: apiType,
            streaming,
            memberTools: [toolName],
            modelContextLength: 272000,
            modelOptimalMaxTokens: 200000,
            modelCriticalMaxTokens: 244800,
          });
          const root = await createMainDialog();
          root.disableDiligencePush = true;
          const id = `caution-${language}-${streaming ? 'stream' : 'batch'}`;
          let requests = 0;
          const provider = messageProvider(
            apiType,
            ({ request, context, genseq, systemPrompt, tools, streaming: actualStreaming }) => {
              assert.equal(request.dialogSelfId, root.id.selfId);
              assert.equal(actualStreaming, streaming);
              requests += 1;
              assert.ok(requests <= 3);
              const inputs = context.filter((message) => message.type === 'prompting_msg');
              const originalInput = inputs.filter((message) => message.msgId === id);
              assert.equal(originalInput.length, 1);
              assert.equal(originalInput[0].content, 'lookup-input-data');
              const runtimeInputs = inputs.filter((message) => message.msgId !== id);
              const results = context.filter((message) => message.type === 'func_result_msg');
              assert.equal(results.length, requests - 1);
              if (requests < 3) {
                assert.equal(runtimeInputs.length, 0, 'healthy tool continuation adds no notice');
                if (requests === 2) assert.equal(results[0].content, 'lookup-data-1');
                const tokens = requests === 1 ? 150000 : 210000;
                return {
                  messages: [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: `${id}-${requests}`,
                      name: toolName,
                      arguments: JSON.stringify({ record: requests }),
                    },
                  ],
                  usage: {
                    kind: 'available',
                    promptTokens: tokens,
                    completionTokens: 10,
                    totalTokens: tokens + 10,
                  },
                };
              }
              assert.equal(runtimeInputs.length, 1);
              assert.deepEqual(
                results.map((result) => result.content),
                ['lookup-data-1', 'lookup-data-2'],
              );
              if (streaming)
                evidence.record({
                  id,
                  scenario:
                    'A real two-tool chain moves from 150000 healthy prompt tokens to 210000 caution tokens. Before the third request the runtime adds one preservation input.',
                  businessValue:
                    'Warn during a tool loop before context loss while retaining both real lookup results and the original user request.',
                  context: {
                    language,
                    actualPromptTokens: 210000,
                    optimalMaxTokens: 200000,
                    criticalMaxTokens: 244800,
                    scope: 'mainDialog',
                    availableTools: JSON.stringify(tools.map((tool) => tool.name)),
                  },
                  reviewQuestions: [
                    'Does the actual caution input correctly explain the pressure, preservation and continuation without replacing the user task?',
                    'Are its instructions compatible with the actual system prompt and granted capabilities?',
                  ],
                  actualText: JSON.stringify(
                    { preservationInput: runtimeInputs[0].content, systemPrompt },
                    null,
                    2,
                  ),
                });
              return {
                messages: [
                  {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq,
                    content: 'lookup-complete-data',
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
          try {
            await driveDialogStream(root, makeUserPrompt('lookup-input-data', id), true);
            provider.assertNoErrors();
            assert.equal(requests, 3);
            assert.deepEqual(lookups, [1, 2]);
            assert.equal(root.currentCourse, 1);
            const events = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
            const runtimeInputs = events.filter(
              (event) => event.type === 'human_text_record' && event.origin === 'runtime',
            );
            assert.equal(runtimeInputs.length, 1);
            assert.equal(events.filter((event) => event.type === 'func_result_record').length, 2);
            assert.equal(
              events.filter(
                (event) =>
                  event.type === 'agent_words_record' && event.content === 'lookup-complete-data',
              ).length,
              1,
            );
          } finally {
            unregisterLlmGenerator(apiType);
          }
        }
      }
    } finally {
      unregisterTool(toolName);
    }
  });
  await evidence.write();
  console.log('real tool-loop caution transition preserves both lookups and one notice: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
