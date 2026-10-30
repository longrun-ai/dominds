import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LlmUsageStats } from '@longrun-ai/kernel/types/context-health';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmRequestContext } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { FuncTool, ToolCallOutput } from '../../main/tool';
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

const evidence = semanticEvidenceCollector('dominds-large-output-');
const toolName = 'context_output_probe';
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-context-output';
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const streaming of [true, false]) {
        for (const variant of [
          'large-text',
          'exact-byte-limit',
          'over-byte-limit',
          'previous-caution',
          'repeated-unknown',
          'recovered-current',
          'text-items',
          'image-item',
          'side-large',
        ] as const) {
          const id = `${variant}-${language}-${streaming ? 'stream' : 'batch'}`;
          const sideScope = variant === 'side-large';
          const seedPrevious = [
            'previous-caution',
            'recovered-current',
            'repeated-unknown',
          ].includes(variant);
          const hidden = variant !== 'exact-byte-limit' && variant !== 'recovered-current';
          const payload =
            variant === 'exact-byte-limit'
              ? `${'界'.repeat(666)}ab`
              : variant === 'over-byte-limit'
                ? '界'.repeat(667)
                : `opaque-large-data-${'x'.repeat(2300)}`;
          const top = 't'.repeat(500);
          const item = 'i'.repeat(1501);
          let expectedOutput: ToolCallOutput | undefined;
          let toolCalls = 0;
          const probe: FuncTool = {
            type: 'func',
            name: toolName,
            description: 'Controlled model-visible result data.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            argsValidation: 'passthrough',
            followupMode:
              variant === 'text-items' || variant === 'image-item' ? 'deferred' : 'immediate',
            async call(dialog) {
              toolCalls += 1;
              expectedOutput =
                variant === 'text-items'
                  ? toolSuccess(top, [{ type: 'input_text', text: item }])
                  : variant === 'image-item'
                    ? toolSuccess(top, [
                        {
                          type: 'input_image',
                          mimeType: 'image/png',
                          byteLength: 1501,
                          artifact: {
                            rootId: dialog.id.rootId,
                            selfId: dialog.id.selfId,
                            status: dialog.status,
                            relPath: 'tool-results/withheld-image.png',
                          },
                        },
                      ])
                    : toolSuccess(payload);
              return expectedOutput;
            },
          };
          registerTool(probe);
          await writeStandardMinds(rtws, {
            providerApiType: apiType,
            streaming,
            includePangu: sideScope,
            memberTools: [toolName],
            modelContextLength: 272000,
            modelOptimalMaxTokens: 200000,
            modelCriticalMaxTokens: 244800,
          });
          if (sideScope)
            await fs.appendFile(
              path.join(rtws, '.minds', 'team.yaml'),
              `    tools: [${toolName}]\n`,
            );
          let root = await createMainDialog();
          root.disableDiligencePush = true;
          let stage: 'seed' | 'probe' = seedPrevious ? 'seed' : 'probe';
          let rootRounds = 0;
          let probeRounds = 0;
          let callId = `output-${id}`;
          const taskId = `side-task-${id}`;
          let seenResult: Extract<ChatMessage, { type: 'func_result_msg' }> | undefined;
          let seenSystem = '';
          let availableTools: string[] = [];
          const generate = (
            request: LlmRequestContext,
            context: ChatMessage[],
            genseq: number,
            system: string,
            tools: readonly FuncTool[],
          ): { messages: ChatMessage[]; usage: LlmUsageStats } => {
            assert.equal(
              tools.filter((tool) => tool.name === 'set_dialog_goal').length,
              sideScope && request.dialogSelfId !== root.id.selfId ? 0 : 1,
              'the fixed main goal is executable only in its owning main dialog',
            );
            if (stage === 'seed') {
              assert.equal(request.dialogSelfId, root.id.selfId);
              return {
                messages: [
                  {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq,
                    content: 'caution-seed-output-data',
                  },
                ],
                usage: {
                  kind: 'available',
                  promptTokens: 210000,
                  completionTokens: 10,
                  totalTokens: 210010,
                },
              };
            }
            if (sideScope && request.dialogSelfId === root.id.selfId) {
              rootRounds += 1;
              assert.ok(rootRounds <= 2);
              if (rootRounds === 1)
                return {
                  messages: [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: taskId,
                      name: 'tellaskSessionless',
                      arguments: JSON.stringify({
                        targetAgentId: 'pangu',
                        tellaskContent: 'side-output-task-data',
                      }),
                    },
                  ],
                  usage: {
                    kind: 'available',
                    promptTokens: 1000,
                    completionTokens: 10,
                    totalTokens: 1010,
                  },
                };
              const delivered = context
                .filter((message) => message.type === 'tellask_result_msg')
                .filter((message) => message.callId === taskId);
              assert.equal(delivered.length, 1);
              assert.equal(delivered[0].status, 'completed');
              assert.ok(delivered[0].content.includes('side-output-status-data'));
              return {
                messages: [
                  {
                    type: 'saying_msg',
                    role: 'assistant',
                    genseq,
                    content: 'caller-consumed-output-data',
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            }
            if (!sideScope) assert.equal(request.dialogSelfId, root.id.selfId);
            probeRounds += 1;
            assert.ok(
              probeRounds <= (variant === 'repeated-unknown' ? 3 : 2),
              'each result resumes once',
            );
            if (probeRounds === 1)
              return {
                messages: [
                  ...(variant === 'large-text'
                    ? [
                        {
                          type: 'func_call_msg' as const,
                          role: 'assistant' as const,
                          genseq,
                          id: `goal-${id}`,
                          name: 'set_dialog_goal',
                          arguments: JSON.stringify({ mode: 'goal', goal: 'controlled-goal-data' }),
                        },
                      ]
                    : []),
                  {
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id: callId,
                    name: toolName,
                    arguments: '{}',
                  },
                ],
                usage:
                  variant === 'previous-caution' || variant === 'repeated-unknown'
                    ? { kind: 'unavailable' }
                    : {
                        kind: 'available',
                        promptTokens: variant === 'recovered-current' ? 1000 : 210000,
                        completionTokens: 10,
                        totalTokens: variant === 'recovered-current' ? 1010 : 210010,
                      },
              };
            const results = context
              .filter((message) => message.type === 'func_result_msg')
              .filter((message) => message.id === (probeRounds === 3 ? `${callId}-again` : callId));
            assert.equal(results.length, 1);
            seenResult = results[0];
            seenSystem = system;
            availableTools = tools.map((tool) => tool.name);
            assert.ok(expectedOutput);
            if (hidden) {
              assert.equal(seenResult.contentItems, undefined);
              assert.equal(
                seenResult.content.includes(payload),
                false,
                'known withheld data does not leak into the model-visible result',
              );
              if (variant === 'text-items') assert.equal(seenResult.content.includes(item), false);
              assert.notEqual(seenResult.content, expectedOutput.content);
            } else assert.equal(seenResult.content, payload);
            if (variant === 'repeated-unknown' && probeRounds === 2) {
              return {
                messages: [
                  {
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id: `${callId}-again`,
                    name: toolName,
                    arguments: '{}',
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            }
            return {
              messages: sideScope
                ? [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: `reply-${id}`,
                      name: 'replyTellaskSessionless',
                      arguments: JSON.stringify({ replyContent: 'side-output-status-data' }),
                    },
                  ]
                : [
                    {
                      type: 'saying_msg',
                      role: 'assistant',
                      genseq,
                      content: 'post-tool-output-data',
                    },
                  ],
              usage: { kind: 'unavailable' },
            };
          };
          const generator = messageProvider(
            apiType,
            ({ request, context, genseq, systemPrompt, tools, streaming: actualStreaming }) => {
              assert.equal(actualStreaming, streaming);
              return generate(request, [...context], genseq, systemPrompt, tools);
            },
          );
          registerLlmGenerator(generator);
          try {
            if (seedPrevious) {
              await driveDialogStream(
                root,
                makeUserPrompt('caution-seed-input-data', `seed-${id}`),
                true,
              );
              const previous = root.getLastContextHealth();
              assert.ok(previous?.kind === 'available');
              assert.equal(previous.level, 'caution');
              stage = 'probe';
            }
            await driveDialogStream(root, makeUserPrompt('output-probe-input-data', id), true);
            if (sideScope)
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
                      event.content === 'caller-consumed-output-data',
                  ),
                3000,
                'caller consume the explicit side result',
              );
            await waitForAllDialogsUnlocked(root, 3000);
            generator.assertNoErrors();
            assert.equal(toolCalls, variant === 'repeated-unknown' ? 2 : 1);
            assert.equal(probeRounds, variant === 'repeated-unknown' ? 3 : 2);
            assert.ok(seenResult);
            const testedDialog = sideScope
              ? root
                  .getLoadedDialogTreeSnapshot()
                  .find((dialog) => dialog.id.selfId !== root.id.selfId)
              : root;
            assert.ok(testedDialog);
            const events = await DialogPersistence.loadCourseEvents(
              testedDialog.id,
              testedDialog.currentCourse,
              testedDialog.status,
            );
            const durable = events
              .filter((event) => event.type === 'func_result_record')
              .filter(
                (event) =>
                  event.id === (variant === 'repeated-unknown' ? `${callId}-again` : callId),
              );
            assert.equal(durable.length, 1);
            assert.equal(durable[0].content, seenResult.content);
            assert.equal(durable[0].contentItems, undefined);
            if (variant === 'large-text') {
              const goals = events.filter(
                (event) => event.type === 'func_result_record' && event.id === `goal-${id}`,
              );
              assert.equal(goals.length, 1);
              const goal = root.reminders.find((reminder) => reminder.id === 'mainDialogGoal');
              assert.ok(goal);
              const meta = goal.meta;
              assert.ok(meta && typeof meta === 'object' && !Array.isArray(meta));
              assert.deepEqual(
                { mode: meta.mode, goal: meta.goal },
                { mode: 'specific_goal', goal: 'controlled-goal-data' },
              );
            }
            if (variant === 'exact-byte-limit') assert.equal(Buffer.byteLength(payload), 2000);
            if (variant === 'over-byte-limit') assert.equal(Buffer.byteLength(payload), 2001);
            if (variant === 'repeated-unknown') {
              const previousRoot = root;
              globalDialogRegistry.unregister(root.id.rootId);
              const restored = await getOrRestoreMainDialog(root.id.rootId, root.status);
              assert.ok(restored);
              assert.notEqual(restored, previousRoot);
              root = restored;
              root.disableDiligencePush = true;
              assert.equal(root.getLastContextHealth()?.kind, 'unavailable');
              assert.equal(root.getLastAvailableContextHealth()?.level, 'caution');
              probeRounds = 0;
              callId = `${callId}-restored`;
              await driveDialogStream(
                root,
                makeUserPrompt('restored-output-input-data', `${id}-restored`),
                true,
              );
              await waitForAllDialogsUnlocked(root, 3000);
              generator.assertNoErrors();
              assert.equal(toolCalls, 4);
              assert.equal(probeRounds, 3);
              await root.startNewCourse('new-course-input-data');
              assert.equal(root.getLastContextHealth()?.kind, 'unavailable');
              assert.equal(root.getLastAvailableContextHealth(), undefined);
              globalDialogRegistry.unregister(root.id.rootId);
            }
            // Meaning depends on scope and known/unknown pressure, not on the transport mode.
            // Byte/item variants above retain their full machine behavior checks.
            if (
              hidden &&
              streaming &&
              ['large-text', 'previous-caution', 'side-large'].includes(variant)
            )
              evidence.record({
                id,
                scenario: `A ${sideScope ? 'side' : 'main'} dialog receives ${variant} at the actual tool boundary while context is tight.`,
                businessValue:
                  'Bound model-visible output while preserving an executable, correctly scoped path to continue the task.',
                context: {
                  language,
                  streaming,
                  scope: sideScope ? 'sideDialog' : 'mainDialog',
                  originalBytes:
                    variant === 'text-items' || variant === 'image-item'
                      ? 2001
                      : Buffer.byteLength(payload),
                  currentUsage:
                    variant === 'previous-caution'
                      ? 'unavailable; previous real measurement was caution'
                      : 'available caution',
                  availableTools: JSON.stringify(availableTools),
                  currentHealthyUsageCanRestoreVisibility: true,
                },
                reviewQuestions: [
                  'Does the actual replacement accurately describe what was withheld and the conditions under which later output can become visible?',
                  'Does the guidance preserve needed facts and respect the actual scope/capabilities without inventing task completion or forcing an unsafe continuation?',
                ],
                actualText: JSON.stringify(
                  { replacement: seenResult.content, systemPrompt: seenSystem },
                  null,
                  2,
                ),
              });
          } finally {
            unregisterLlmGenerator(apiType);
            unregisterTool(toolName);
          }
        }
      }
    }
  });
  await evidence.write();
  console.log(
    'tight-context output limits, byte boundaries, usage recovery and real side delivery: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
