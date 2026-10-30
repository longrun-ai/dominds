import assert from 'node:assert/strict';

import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  MAIN_DIALOG_GOAL_REMINDER_ID,
  setMainDialogGoalReminder,
} from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { type FuncTool, toolPartialFailure } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-clear-mind-siblings-');
const partialToolName = 'clear_mind_partial_probe';
const partialPayload = 'partial-data-c23a';
const continuationPayload = 'continuation-data-94ad';
type Scenario =
  | 'failed-update'
  | 'clear-first'
  | 'invalid-special'
  | 'partial-failure'
  | 'successful-update';
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-clear-mind-siblings';
    let partialCalls = 0;
    const partialTool: FuncTool = {
      type: 'func',
      name: partialToolName,
      description: 'Controlled partial-failure boundary.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      argsValidation: 'passthrough',
      async call() {
        partialCalls += 1;
        return toolPartialFailure(partialPayload);
      },
    };
    registerTool(partialTool);
    try {
      // The provider follows a controlled call schedule; tool-result prose never selects its response.
      await writeStandardMinds(rtws, { memberTools: [partialToolName], providerApiType: apiType });
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        for (const scenario of [
          'failed-update',
          'clear-first',
          'invalid-special',
          'partial-failure',
          'successful-update',
        ] as const) {
          const root = await createMainDialog();
          root.disableDiligencePush = true;
          await setMainDialogGoalReminder(root, {
            mode: 'goal',
            goal: 'Preserve failed tool work before starting a new course.',
          });
          const existing =
            scenario === 'successful-update'
              ? root.addReminder('reminder-original-data', undefined, undefined, undefined, {
                  scope: 'dialog',
                  renderMode: 'markdown',
                })
              : undefined;
          const clearId = `${scenario}-clear`;
          const siblingId = `${scenario}-sibling`;
          const siblingName =
            scenario === 'invalid-special'
              ? 'askHuman'
              : scenario === 'partial-failure'
                ? partialToolName
                : 'update_reminder';
          const siblingArgs =
            scenario === 'invalid-special' || scenario === 'partial-failure'
              ? {}
              : {
                  reminder_id: existing?.id ?? 'missing-reminder-data',
                  content: 'reminder-updated-data',
                };
          let round = 0;
          const finalPayload = `finished-data-${scenario}-${language}`;
          const generator: LlmGenerator = {
            apiType,
            async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver) {
              if (++round === 1) {
                const clear = () =>
                  receiver.funcCall(
                    clearId,
                    'clear_mind',
                    JSON.stringify({ reminder_content: continuationPayload }),
                  );
                const sibling = () =>
                  receiver.funcCall(siblingId, siblingName, JSON.stringify(siblingArgs));
                if (scenario === 'clear-first') {
                  await clear();
                  await sibling();
                } else {
                  await sibling();
                  await clear();
                }
              } else {
                assert.equal(
                  round,
                  2,
                  'the controlled scenario finishes in one post-tool generation',
                );
                const received = context.filter((message) => message.type === 'func_result_msg');
                if (scenario !== 'successful-update') {
                  assert.ok(
                    received.some(
                      (result) => result.id === clearId && result.name === 'clear_mind',
                    ),
                  );
                  assert.ok(
                    received.some(
                      (result) => result.id === siblingId && result.name === siblingName,
                    ),
                  );
                }
                await receiver.sayingStart();
                await receiver.sayingChunk(finalPayload);
                await receiver.sayingFinish();
              }
              return {
                usage: {
                  kind: 'available',
                  promptTokens: 100,
                  completionTokens: 10,
                  totalTokens: 110,
                },
                llmGenModel: 'default',
              };
            },
            async genMoreMessages() {
              throw new Error('streaming fixture only');
            },
          };
          registerLlmGenerator(generator);
          try {
            await driveDialogStream(
              root,
              makeUserPrompt(`input-data-${scenario}`, `${scenario}-${language}`),
              true,
            );
            await waitForAllDialogsUnlocked(root, 3_000);
            assert.equal(round, 2);
            assert.equal(root.currentCourse, scenario === 'successful-update' ? 2 : 1);
            const firstCourse = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
            const results = firstCourse.filter((event) => event.type === 'func_result_record');
            assert.equal(
              results.filter((result) => result.id === siblingId && result.name === siblingName)
                .length,
              1,
            );
            const clearResults = results.filter(
              (result) => result.id === clearId && result.name === 'clear_mind',
            );
            assert.equal(clearResults.length, 1);
            const currentEvents = await DialogPersistence.loadCourseEvents(
              root.id,
              root.currentCourse,
              root.status,
            );
            const words = currentEvents.filter((event) => event.type === 'agent_words_record');
            assert.equal(words.at(-1)?.content, finalPayload);
            const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
            assert.ok(latest);
            assert.equal(latest.pendingRuntimePrompt, undefined);
            assert.equal(
              latest.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
              false,
            );
            if (scenario === 'successful-update') {
              assert.ok(
                root.reminders.some((reminder) => reminder.content === continuationPayload),
              );
              assert.equal(
                root.reminders.find((reminder) => reminder.id === existing?.id)?.content,
                'reminder-updated-data',
              );
            } else {
              assert.equal(
                root.reminders.filter((reminder) => reminder.id !== MAIN_DIALOG_GOAL_REMINDER_ID)
                  .length,
                0,
              );
              assert.equal(latest.currentCourse, 1);
            }
            const siblingResult = results.find((result) => result.id === siblingId);
            assert.ok(siblingResult);
            if (scenario === 'partial-failure') assert.equal(siblingResult.content, partialPayload);
            evidence.record({
              id: `${scenario}-${language}`,
              scenario: `Real same-round ${siblingName} and clear_mind in ${scenario}; observed course ${root.currentCourse}.`,
              businessValue:
                'Do not discard unresolved failed work during context renewal; successful sibling work must still allow renewal.',
              context: {
                language,
                scenario,
                siblingId,
                clearId,
                siblingName,
                siblingArguments: JSON.stringify(siblingArgs),
                observedCourse: root.currentCourse,
                continuationPayload,
              },
              reviewQuestions: [
                'Does the actual result explain the observed acceptance or refusal with the correct sibling and outcome?',
                'Can the executor recover without treating a failed or partial sibling as successful, or being instructed to repeat an invalid operation unchanged?',
              ],
              actualText: JSON.stringify(
                { sibling: siblingResult, clearMind: clearResults[0] },
                null,
                2,
              ),
            });
          } finally {
            unregisterLlmGenerator(apiType);
          }
        }
      }
      assert.equal(
        partialCalls,
        2,
        'the partial-failure sibling actually executes in both languages',
      );
    } finally {
      unregisterTool(partialToolName);
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log('clear_mind preserves failed siblings and accepts completed siblings: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
