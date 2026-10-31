import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { DialogFbrState } from '@longrun-ai/kernel/types/storage';
import { SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
  FBR_UNREASONABLE_SITUATION_TOOL_NAME,
} from '../../main/llm/kernel-driver/fbr';
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

const evidence = semanticEvidenceCollector('dominds-fbr-closure-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-fbr-closure';
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const streaming of [true, false]) {
        for (const variant of [
          'low-noise',
          'unreasonable',
          'exhausted',
          'caution',
          'critical',
          'caution-exhausted',
          'forbidden-tools',
        ] as const) {
          const caution = variant === 'caution' || variant === 'caution-exhausted';
          const programmatic =
            variant === 'exhausted' || variant === 'critical' || variant === 'caution-exhausted';
          const effort = caution || variant === 'critical' ? 3 : 2;
          const id = `${variant}-${language}-${streaming ? 'stream' : 'batch'}`;
          const forbiddenName = 'fbr_forbidden_effect_probe';
          let forbiddenEffects = 0;
          let forbiddenAttempts = 0;
          const effectPath = path.join(rtws, `forbidden-effect-${id}`);
          const effect: FuncTool = {
            type: 'func',
            name: forbiddenName,
            description: 'Controlled workspace write.',
            parameters: { type: 'object', properties: {} },
            argsValidation: 'passthrough',
            async call() {
              forbiddenEffects += 1;
              await fs.writeFile(effectPath, 'forbidden-effect-data');
              return toolSuccess('forbidden-effect-data');
            },
          };
          registerTool(effect);
          await writeStandardMinds(rtws, {
            providerApiType: apiType,
            memberTools: [forbiddenName],
            streaming,
            modelContextLength: 1000,
            modelOptimalMaxTokens: 500,
            modelCriticalMaxTokens: 900,
          });
          await fs.appendFile(
            path.join(rtws, '.minds', 'team.yaml'),
            [
              '    fbr-effort: 2',
              '    model_params:',
              '      json_response: false',
              '      openai: {temperature: 0.2, top_p: 0.8}',
              '    fbr_model_params:',
              '      json_response: true',
              '      openai: {temperature: 0.6}',
              '',
            ].join('\n'),
          );
          let root = await createMainDialog();
          root.disableDiligencePush = true;
          const callId = `fbr-call-${id}`;
          const body =
            language === 'zh'
              ? '目标：建议下一步排查。事实：两个请求使用同一条写入路径，其中一个失败；尚未采集存储侧 trace。仅根据这些事实分析，说明仍缺的证据。'
              : 'Goal: recommend the next diagnostic step. Facts: two requests used the same write path; one failed. No storage-side trace has been collected. Work only from these facts and state the missing evidence.';
          const conclusion = `fbr-conclusion-data-${id}`;
          const callerPrivate = `caller-private-data-${id}`;
          const workspacePrivate = `workspace-private-data-${id}`;
          const memoryPrivate = `memory-private-data-${id}`;
          await fs.appendFile(
            path.join(rtws, root.taskDocPath, 'goals.md'),
            `\n${workspacePrivate}\n`,
          );
          await fs.mkdir(path.join(rtws, '.minds', 'memory', 'team_shared'), { recursive: true });
          await fs.writeFile(
            path.join(rtws, '.minds', 'memory', 'team_shared', 'fixture.md'),
            memoryPrivate,
          );
          const childPrivate: string[] = [];
          const phases: Array<{ phase: DialogFbrState['phase']; iteration: number }> = [];
          const actualRequests: unknown[] = [];
          let rootRequests = 0;
          let delivered: Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined;
          const provider = messageProvider(
            apiType,
            async ({
              request,
              context,
              genseq,
              tools,
              systemPrompt,
              agent,
              streaming: actualStreaming,
            }) => {
              assert.equal(actualStreaming, streaming);
              const usage = (promptTokens: number) => ({
                kind: 'available' as const,
                promptTokens,
                completionTokens: 10,
                totalTokens: promptTokens + 10,
              });
              if (request.dialogSelfId === root.id.selfId) {
                assert.equal(tools.filter((tool) => tool.name === forbiddenName).length, 1);
                rootRequests += 1;
                assert.ok(rootRequests <= 2);
                for (const data of [workspacePrivate, memoryPrivate])
                  assert.ok(
                    context.some(
                      (message) => 'content' in message && message.content.includes(data),
                    ),
                    'ordinary caller context still receives its own workspace and memory data',
                  );
                assert.deepEqual(
                  {
                    json_response: agent.model_params?.json_response,
                    openai: agent.model_params?.openai,
                  },
                  {
                    json_response: false,
                    openai: { temperature: 0.2, top_p: 0.8 },
                  },
                );
                if (rootRequests === 1)
                  return {
                    messages: [
                      { type: 'thinking_msg', role: 'assistant', genseq, content: callerPrivate },
                      {
                        type: 'func_call_msg',
                        role: 'assistant',
                        genseq,
                        id: callId,
                        name: 'freshBootsReasoning',
                        arguments: JSON.stringify({ tellaskContent: body, effort }),
                      },
                    ],
                    usage: usage(100),
                  };
                const results = context
                  .filter((message) => message.type === 'tellask_result_msg')
                  .filter((message) => message.callId === callId);
                assert.equal(results.length, 1);
                delivered = results[0];
                assert.equal(delivered.status, 'completed');
                if (!programmatic)
                  assert.ok(
                    delivered.content.includes(conclusion),
                    'the provider-supplied conclusion body reaches its caller unchanged',
                  );
                for (const privateData of childPrivate)
                  assert.equal(
                    delivered.content.includes(privateData),
                    false,
                    'private round data is not the delivered conclusion',
                  );
                return {
                  messages: [
                    {
                      type: 'saying_msg',
                      role: 'assistant',
                      genseq,
                      content: `caller-consumed-data-${id}`,
                    },
                  ],
                  usage: usage(100),
                };
              }
              const side = root.lookupDialog(request.dialogSelfId);
              assert.ok(side instanceof SideDialog);
              assert.equal(side.assignmentFromAsker.callName, 'freshBootsReasoning');
              assert.equal(side.assignmentFromAsker.effectiveFbrEffort, effort);
              assert.equal(side.assignmentFromAsker.tellaskContent, body);
              assert.deepEqual(
                {
                  json_response: agent.model_params?.json_response,
                  openai: agent.model_params?.openai,
                },
                {
                  json_response: true,
                  openai: { temperature: 0.6, top_p: 0.8 },
                },
              );
              for (const message of context.filter((message) => 'content' in message))
                for (const data of [callerPrivate, workspacePrivate, memoryPrivate])
                  assert.equal(
                    message.content.includes(data),
                    false,
                    'FBR receives the supplied body rather than unrelated caller/workspace/memory data',
                  );
              assert.ok(
                context.some(
                  (message) => message.type === 'prompting_msg' && message.content.includes(body),
                ),
                'the exact supplied task body remains available throughout the reasoning rounds',
              );
              const state = (await DialogPersistence.loadDialogLatest(side.id, side.status))
                ?.fbrState;
              assert.ok(state);
              assert.equal(state.effort, effort);
              phases.push({ phase: state.phase, iteration: state.iteration });
              assert.ok(
                phases.length <= (variant === 'caution-exhausted' ? 4 : 6),
                'configured finalization attempts must remain bounded under caution',
              );
              assert.deepEqual(
                tools.map((tool) => tool.name).sort(),
                state.phase === 'finalization'
                  ? [
                      FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
                      FBR_UNREASONABLE_SITUATION_TOOL_NAME,
                    ].sort()
                  : [],
              );
              for (const tool of tools) assert.equal(tool.followupMode, 'deferred');
              const prompt = context.filter((message) => message.type === 'prompting_msg').at(-1);
              assert.ok(prompt);
              actualRequests.push({
                state,
                systemPrompt,
                currentPrompt: prompt.content,
                environment: context.filter((message) => message.type === 'environment_msg'),
                resultsAndResponses: context.filter(
                  (message) =>
                    message.type === 'func_result_msg' ||
                    message.type === 'saying_msg' ||
                    message.type === 'transient_guide_msg',
                ),
                tools: tools.map(({ name, description, parameters, followupMode }) => ({
                  name,
                  description,
                  parameters,
                  followupMode,
                })),
              });
              if (
                variant === 'forbidden-tools' &&
                state.iteration === 1 &&
                (state.phase === 'divergence' || state.phase === 'finalization')
              ) {
                forbiddenAttempts += 1;
                return {
                  messages: [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: `forbidden-${state.phase}-${id}`,
                      name: forbiddenName,
                      arguments: '{}',
                    },
                  ],
                  usage: usage(100),
                };
              }
              if (
                state.phase === 'finalization' &&
                !programmatic &&
                (variant !== 'caution' || state.iteration === 2)
              ) {
                const name =
                  variant === 'unreasonable'
                    ? FBR_UNREASONABLE_SITUATION_TOOL_NAME
                    : FBR_LOW_NOISE_CONCLUSION_TOOL_NAME;
                return {
                  messages: [
                    {
                      type: 'func_call_msg',
                      role: 'assistant',
                      genseq,
                      id: `conclusion-${id}`,
                      name,
                      arguments: JSON.stringify({ content: conclusion }),
                    },
                  ],
                  usage: usage(caution ? 620 : 100),
                };
              }
              const privateData = `fbr-private-round-data-${id}-${phases.length}`;
              childPrivate.push(privateData);
              return {
                messages: [{ type: 'saying_msg', role: 'assistant', genseq, content: privateData }],
                usage: usage(variant === 'critical' ? 950 : caution ? 600 : 100),
              };
            },
          );
          registerLlmGenerator(provider);
          try {
            await driveDialogStream(root, makeUserPrompt(`caller-input-data-${id}`, id), true);
            await waitFor(
              async () => {
                provider.assertNoErrors();
                return (await DialogPersistence.loadCourseEvents(root.id, 1, root.status)).some(
                  (event) =>
                    event.type === 'agent_words_record' &&
                    event.content === `caller-consumed-data-${id}`,
                );
              },
              5000,
              'the caller consumes one final FBR conclusion',
            );
            await waitForAllDialogsUnlocked(root, 5000);
            provider.assertNoErrors();
            assert.equal(rootRequests, 2);
            assert.ok(delivered);
            const expectedPhases =
              variant === 'critical'
                ? [['divergence', 1]]
                : variant === 'caution-exhausted'
                  ? [
                      ['divergence', 1],
                      ['finalization', 1],
                      ['finalization', 2],
                      ['finalization', 3],
                    ]
                  : variant === 'caution'
                    ? [
                        ['divergence', 1],
                        ['finalization', 1],
                        ['finalization', 2],
                      ]
                    : [
                        ['divergence', 1],
                        ['divergence', 2],
                        ['convergence', 1],
                        ['convergence', 2],
                        ['finalization', 1],
                        ...(['exhausted', 'forbidden-tools'].includes(variant)
                          ? [['finalization', 2]]
                          : []),
                      ];
            assert.deepEqual(
              phases.map(({ phase, iteration }) => [phase, iteration]),
              expectedPhases,
            );
            const side = root
              .getLoadedDialogTreeSnapshot()
              .find((dialog) => dialog instanceof SideDialog);
            assert.ok(side instanceof SideDialog);
            const sideEvents = await DialogPersistence.loadCourseEvents(side.id, 1, side.status);
            const calls = sideEvents
              .filter((event) => event.type === 'func_call_record')
              .filter(
                (event) =>
                  event.name === FBR_LOW_NOISE_CONCLUSION_TOOL_NAME ||
                  event.name === FBR_UNREASONABLE_SITUATION_TOOL_NAME,
              );
            assert.equal(forbiddenAttempts, variant === 'forbidden-tools' ? 2 : 0);
            assert.equal(forbiddenEffects, 0);
            await assert.rejects(fs.stat(effectPath), { code: 'ENOENT' });
            assert.equal(calls.length, programmatic ? 0 : 1);
            const resolutions = sideEvents.filter(
              (event) => event.type === 'tellask_reply_resolution_record',
            );
            assert.equal(resolutions.length, 1);
            assert.equal(resolutions[0].targetCallId, callId);
            assert.equal(resolutions[0].replyCallName, 'replyTellaskSessionless');
            assert.equal(
              await DialogPersistence.loadActiveTellaskReplyObligation(side.id, side.status),
              undefined,
            );
            const latest = await DialogPersistence.loadDialogLatest(side.id, side.status);
            assert.equal(latest?.fbrState, undefined);
            assert.equal(latest?.executionMarker, undefined);
            assert.deepEqual(latest?.displayState, { kind: 'idle_waiting_user' });
            const rootEvents = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
            const results = rootEvents
              .filter((event) => event.type === 'tellask_result_record')
              .filter((event) => event.callId === callId);
            assert.equal(results.length, 1);
            assert.equal(results[0].content, delivered.content);
            const previousRoot = root;
            globalDialogRegistry.unregister(root.id.rootId);
            const restored = await getOrRestoreMainDialog(root.id.rootId, root.status);
            assert.ok(restored);
            assert.notEqual(restored, previousRoot);
            root = restored;
            const restoredSide = await ensureDialogLoaded(root, side.id, side.status);
            assert.ok(restoredSide instanceof SideDialog);
            assert.notEqual(restoredSide, side);
            assert.equal(restoredSide.assignmentFromAsker.effectiveFbrEffort, effort);
            assert.equal(
              await DialogPersistence.loadActiveTellaskReplyObligation(
                restoredSide.id,
                restoredSide.status,
              ),
              undefined,
            );
            if (streaming)
              evidence.record({
                id,
                scenario: `A real FBR self-dialog closes through ${variant}; provider usage controls the actual runtime health decisions.`,
                businessValue:
                  'Keep independent reasoning isolated, close with one truthful conclusion and preserve caller work and durable delivery.',
                context: {
                  language,
                  variant,
                  configuredEffort: effort,
                  contextLength: 1000,
                  optimalMaxTokens: 500,
                  criticalMaxTokens: 900,
                  providerConclusionIsOpaqueFixtureData: true,
                  nativeConclusionCallCount: calls.length,
                  actualChildRequests: phases.length,
                },
                reviewQuestions: [
                  'Are the actual stage, body-context and capability instructions internally consistent, including early finalization under caution?',
                  'Does the actual delivered result truthfully distinguish model-supplied conclusions from runtime inability to obtain one, without unsupported claims about the task or reasoning quality?',
                  'Does the caller receive only the final conclusion and enough honest context to decide its next step?',
                ],
                actualText: JSON.stringify(
                  { requests: actualRequests, callerResult: delivered.content },
                  null,
                  2,
                ),
              });
          } finally {
            await waitForAllDialogsUnlocked(root, 5000);
            globalDialogRegistry.unregister(root.id.rootId);
            unregisterLlmGenerator(apiType);
            unregisterTool(forbiddenName);
          }
        }
      }
    }
  });
  await evidence.write();
  console.log(
    'real FBR phases, capability isolation, native/fallback conclusions and durable one-result delivery: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
