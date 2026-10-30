import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-repeated-call-guidance-');
type Scenario = 'correct' | 'stop' | 'same-round' | 'stale';
async function runScenario(
  scenario: Scenario,
  rtws: string,
  language: 'en' | 'zh' = 'en',
): Promise<void> {
  setWorkLanguage(language);
  const apiType = 'test-repeat-boundary';
  await writeStandardMinds(rtws, { memberTools: ['env_get'], providerApiType: apiType });
  const repeatedKey = `DOMINDS_TEST_REPEATED_${scenario.replaceAll('-', '_')}`;
  const callsByRound =
    scenario === 'same-round'
      ? [[repeatedKey, repeatedKey, repeatedKey]]
      : scenario === 'stale'
        ? [
            ...Array.from({ length: 3 }, () => [repeatedKey]),
            ...Array.from({ length: 6 }, (_, index) => [`${repeatedKey}_intervening_${index}`]),
            ...Array.from({ length: 3 }, () => [repeatedKey]),
          ]
        : Array.from({ length: scenario === 'stop' ? 6 : 3 }, () => [repeatedKey]);
  const previous = new Map(callsByRound.flat().map((key) => [key, process.env[key]]));
  const resultPayload = `observed-result-data-${scenario}`;
  for (const key of previous.keys()) process.env[key] = resultPayload;
  const contexts: ChatMessage[][] = [];
  const callIds: string[] = [];
  const answer = `correction-data-${scenario}`;
  let round = 0;
  const generator: LlmGenerator = {
    apiType,
    async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver) {
      contexts.push(structuredClone(context));
      if (round > callsByRound.length || (scenario === 'stop' && round === callsByRound.length))
        throw new Error('unexpected generation after the controlled scenario');
      const keys = callsByRound[round++];
      if (keys) {
        for (const key of keys) {
          const callId = `${scenario}-call-${callIds.length + 1}`;
          callIds.push(callId);
          await receiver.funcCall(callId, 'env_get', JSON.stringify({ key }));
        }
      } else {
        await receiver.funcCall(
          `${scenario}-answer`,
          'answerHuman',
          JSON.stringify({ answerContent: answer }),
        );
      }
      return {
        usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        llmGenModel: 'default',
      };
    },
    async genMoreMessages() {
      throw new Error('streaming fixture only');
    },
  };
  registerLlmGenerator(generator);
  try {
    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    await driveDialogStream(
      root,
      makeUserPrompt(`scenario-data-${scenario}`, `repeat-user-${scenario}`),
      true,
    );
    await waitForAllDialogsUnlocked(root, 3_000);
    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const guides = events.filter((event) => event.type === 'runtime_guide_record');
    const expectedGenerations =
      scenario === 'same-round' ? [1] : scenario === 'stale' ? [3, 12] : [3];
    assert.deepEqual(
      guides.map((guide) => guide.genseq),
      expectedGenerations,
    );
    assert.equal(
      root.msgs.filter((message) => message.type === 'func_call_msg' && message.name === 'env_get')
        .length,
      callsByRound.flat().length,
    );
    const results = root.msgs
      .filter((message) => message.type === 'func_result_msg')
      .filter((message) => message.name === 'env_get');
    assert.equal(results.length, callIds.length);
    assert.deepEqual(
      results.map((result) => result.id),
      callIds,
    );
    assert.ok(results.every((result) => result.content === resultPayload));
    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.ok(latest);
    const display = latest.displayState;
    assert.ok(display);
    const answers = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
    if (scenario === 'stop') {
      assert.equal(round, 6);
      assert.equal(answers.length, 0);
      assert.equal(display.kind, 'stopped');
      if (display.kind !== 'stopped' || display.reason.kind !== 'system_stop')
        throw new Error('expected a structured system stop');
      evidence.record({
        id: language === 'en' ? 'repeated-stop' : 'repeated-stop-zh',
        scenario:
          'Six identical calls return the same result; a correction guide was emitted after the first three, then automatic execution stopped after the second triple.',
        businessValue:
          'Stop a non-productive loop with an accurate explanation based on observed facts.',
        context: {
          language,
          observedCallIds: JSON.stringify(callIds),
          guideGenerations: JSON.stringify(expectedGenerations),
        },
        reviewQuestions: [
          'Does the stop reason explain the observed loop without an unsupported diagnosis of intent or personality?',
          'Can the agent or human understand what should be reviewed before resuming, without inventing a new human question?',
        ],
        actualText: display.reason.detail,
      });
    } else {
      assert.equal(round, callsByRound.length + 1);
      assert.notEqual(display.kind, 'stopped');
      assert.deepEqual(
        answers.map((item) => item.content),
        [answer],
      );
    }
    for (const [index, guide] of guides.entries()) {
      assert.ok(
        contexts.some((context) =>
          context.some(
            (message) =>
              message.type === 'transient_guide_msg' && message.content === guide.content,
          ),
        ),
        'persisted runtime guidance is actually delivered to the provider',
      );
      evidence.record({
        id: `${scenario}-guide-${index + 1}${language === 'zh' ? '-zh' : ''}`,
        scenario: `Controlled repeated-call scenario ${scenario}; real env_get calls and durable runtime guide records.`,
        businessValue:
          'Help the executor choose an action that can add value instead of repeating an unchanged result.',
        context: {
          language,
          generation: guide.genseq,
          callIds: JSON.stringify(callIds),
          argumentKeys: JSON.stringify(callsByRound),
        },
        reviewQuestions: [
          'Does the actual guide accurately describe the repeated call, evidence and correction choices without treating it as new user intent?',
          'Are the shown call identifiers, arguments and repeated result useful and consistent with the scenario?',
        ],
        actualText: guide.content,
      });
    }
  } finally {
    unregisterLlmGenerator(apiType);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    for (const scenario of ['correct', 'stop', 'same-round', 'stale'] as const)
      await runScenario(scenario, rtws);
    await runScenario('stop', rtws, 'zh');
  });
  await evidence.write();
  console.log('repeated-call correction, stop and stale-window behavior: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
