import assert from 'node:assert/strict';

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { setMainDialogGoalReminder } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-critical-renewal-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-critical-renewal';
    await writeStandardMinds(rtws, { providerApiType: apiType, modelContextLength: 272_000 });
    let measuredOldHealth: ContextHealthSnapshot | undefined;
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const root = await createMainDialog();
      root.disableDiligencePush = true;
      await setMainDialogGoalReminder(root, {
        mode: 'goal',
        goal: 'Complete the current scenario after context renewal.',
      });
      const continuation = 'continuation-data-critical-f73b';
      const finalPayload = 'finished-data-critical-98ae';
      const contexts: ChatMessage[][] = [];
      const systemPrompts: string[] = [];
      const healthAtRequest: Array<ContextHealthSnapshot | undefined> = [];
      const eventRecorder = recordDialogEvents(root);
      const generator: LlmGenerator = {
        apiType,
        async genToReceiver(_provider, _agent, system, _tools, _request, context, receiver) {
          contexts.push(structuredClone(context));
          systemPrompts.push(system);
          healthAtRequest.push(structuredClone(root.getLastContextHealth()));
          if (contexts.length === 1) {
            await receiver.funcCall(
              'critical-clear',
              'clear_mind',
              JSON.stringify({ reminder_content: continuation }),
            );
          } else {
            assert.equal(contexts.length, 2);
            await receiver.sayingStart();
            await receiver.sayingChunk(finalPayload);
            await receiver.sayingFinish();
          }
          const promptTokens = contexts.length === 1 ? 260_000 : 200;
          return {
            usage: {
              kind: 'available',
              promptTokens,
              completionTokens: 10,
              totalTokens: promptTokens + 10,
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
          makeUserPrompt('user-data-critical-07cf', `critical-user-${language}`),
          true,
        );
        await waitForAllDialogsUnlocked(root, 3_000);
        const actualEvents = await eventRecorder.finish();
        assert.deepEqual(
          healthAtRequest[1],
          { kind: 'unavailable', reason: 'usage_unavailable' },
          'a renewed course has no measured usage yet; old critical data must not control it',
        );
        const currentHealth = root.getLastContextHealth();
        assert.ok(currentHealth?.kind === 'available');
        assert.equal(currentHealth.promptTokens, 200);
        assert.equal(currentHealth.level, 'healthy');
        const courseTransition = actualEvents.findIndex(
          (event) => event.type === 'course_update' && event.course === 2,
        );
        assert.ok(courseTransition >= 0);
        const courseHealth = actualEvents
          .filter((event) => event.type === 'context_health_evt')
          .filter((event) => event.course === 2);
        assert.equal(courseHealth[0]?.genseq, 0);
        assert.deepEqual(courseHealth[0]?.contextHealth, {
          kind: 'unavailable',
          reason: 'usage_unavailable',
        });
        assert.equal(
          actualEvents
            .slice(courseTransition + 1)
            .some((event) => event.type === 'context_health_evt' && event.course === 1),
          false,
          'late completion of the old generation cannot overwrite current toolbar health',
        );
        assert.equal(root.currentCourse, 2);
        assert.equal(
          contexts.length,
          2,
          'new course actually reaches the provider without another human turn',
        );
        const reminder = root.reminders.find((item) => item.content === continuation);
        assert.ok(reminder);
        assert.deepEqual(reminder.meta, {
          kind: 'continuation_package',
          createdBy: 'clear_mind',
          contextHealthLevel: 'critical',
        });
        assert.equal(reminder.scope, 'dialog');
        assert.equal(reminder.renderMode, 'markdown');
        assert.ok(
          contexts[1].some(
            (message) =>
              message.type === 'environment_msg' && message.content.includes(continuation),
          ),
          'the supplied continuation payload reaches the new course',
        );
        const firstEvents = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
        const firstFinish = firstEvents.find((event) => event.type === 'gen_finish_record');
        assert.ok(firstFinish?.contextHealth?.kind === 'available');
        assert.equal(firstFinish.contextHealth.promptTokens, 260_000);
        assert.equal(firstFinish.contextHealth.level, 'critical');
        measuredOldHealth = firstFinish.contextHealth;
        const events = await DialogPersistence.loadCourseEvents(root.id, 2, root.status);
        const runtimeInputs = events
          .filter((event) => event.type === 'human_text_record')
          .filter((event) => event.origin === 'runtime');
        assert.equal(runtimeInputs.length, 1);
        const actualPrompt = contexts[1].find(
          (message) => message.type === 'prompting_msg' && message.msgId === runtimeInputs[0].msgId,
        );
        assert.ok(actualPrompt && 'content' in actualPrompt);
        assert.equal(
          actualPrompt.content,
          runtimeInputs[0].content,
          'the queued runtime input is delivered and persisted under one identity',
        );
        const words = events.filter((event) => event.type === 'agent_words_record');
        assert.equal(words.at(-1)?.content, finalPayload);
        const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
        assert.ok(latest);
        assert.deepEqual(latest.displayState, { kind: 'idle_waiting_user' });
        assert.equal(latest.pendingRuntimePrompt, undefined);
        assert.equal(
          latest.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
          false,
        );
        evidence.record({
          id: `critical-new-course-${language}`,
          scenario:
            'Provider reports 260000 input tokens on the same generation that calls clear_mind; the real driver immediately continues in course 2 with the supplied continuation package.',
          businessValue:
            'Renew context without discarding current work or asking for a redundant human Continue.',
          context: {
            language,
            reportedInputTokensBeforeClear: 260_000,
            configuredContextLength: 272_000,
            observedCourse: root.currentCourse,
            providerGenerations: contexts.length,
            continuationPayload: continuation,
            runtimeInputId: runtimeInputs[0].msgId,
          },
          reviewQuestions: [
            'Does the actual new-course context explain how to resume from preserved state without inventing new user intent or repeating completed work?',
            'Are the continuation package, task state and runtime instructions coherent about the main-dialog goal and what work remains?',
          ],
          actualText: JSON.stringify(
            { systemPrompt: systemPrompts[1], context: contexts[1] },
            null,
            2,
          ),
        });
      } finally {
        unregisterLlmGenerator(apiType);
      }
    }
    assert.ok(measuredOldHealth?.kind === 'available');
    const late = await createMainDialog();
    await late.notifyGeneratingStart('late-old-generation-data');
    late.setLastContextHealth(measuredOldHealth);
    await late.startNewCourse(
      formatNewCourseStartPrompt('en', { nextCourse: 2, source: 'clear_mind' }),
    );
    const unknownHealth = { kind: 'unavailable', reason: 'usage_unavailable' } as const;
    assert.deepEqual(late.getLastContextHealth(), unknownHealth);
    assert.equal(late.getLastContextHealthGenseq(), undefined);
    late.setLastContextHealth(measuredOldHealth);
    assert.deepEqual(
      late.getLastContextHealth(),
      unknownHealth,
      'a direct late provider update from the active old course is rejected',
    );
    await late.notifyGeneratingFinish(measuredOldHealth);
    assert.deepEqual(
      late.getLastContextHealth(),
      unknownHealth,
      'late finish keeps historical usage out of the new live cache',
    );
    const history = (await DialogPersistence.loadCourseEvents(late.id, 1, late.status)).filter(
      (event) => event.type === 'gen_finish_record',
    );
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].contextHealth, measuredOldHealth);
  });
  await evidence.write();
  console.log('critical clear_mind automatically continues its durable new course: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
