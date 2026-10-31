import assert from 'node:assert/strict';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { recordDialogEvents } from '../helpers/dialog-events';
import { messageProvider } from '../helpers/message-provider';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-budget-consumption-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-budget-consumption';
    for (const streaming of [true, false]) {
      await writeStandardMinds(rtws, { providerApiType: apiType, streaming, diligencePushMax: 2 });
      const dialog = await createMainDialog('tester');
      dialog.diligencePushRemainingBudget = 2;
      await DialogPersistence.mutateDialogLatest(dialog.id, () => ({
        kind: 'patch',
        patch: { diligencePushRemainingBudget: 2 },
      }));
      const trace = recordDialogEvents(dialog);
      let requests = 0;
      const generator = messageProvider(
        apiType,
        ({ request, genseq, streaming: actualStreaming }) => {
          assert.equal(request.dialogSelfId, dialog.id.selfId);
          assert.equal(actualStreaming, streaming);
          requests += 1;
          assert.ok(
            requests <= 4,
            'two automatic nudges and a later human turn cannot overrun the allowance',
          );
          return {
            messages: [
              {
                type: 'saying_msg',
                role: 'assistant',
                genseq,
                content: `response-data-${requests}`,
              },
            ],
            usage: { kind: 'unavailable' },
          };
        },
      );
      registerLlmGenerator(generator);
      try {
        await driveDialogStream(
          dialog,
          {
            content: 'initial-input-data',
            msgId: 'budget-initial',
            grammar: 'markdown',
            origin: 'user',
            userLanguageCode: 'en',
          },
          true,
        );
        await waitForAllDialogsUnlocked(dialog, 2000);
        generator.assertNoErrors();
        assert.equal(requests, 3);
        let stored = await DialogPersistence.loadCourseEvents(dialog.id, 1, dialog.status);
        assert.equal(stored.filter((event) => event.type === 'gen_start_record').length, 3);
        assert.equal(
          stored.filter(
            (event) => event.type === 'human_text_record' && event.origin === 'diligence_push',
          ).length,
          2,
        );
        assert.deepEqual(
          stored
            .filter((event) => event.type === 'agent_words_record')
            .map((event) => event.content),
          ['response-data-1', 'response-data-2', 'response-data-3'],
        );
        const notices = stored.filter((event) => event.type === 'ui_only_markdown_record');
        assert.equal(notices.length, 1);
        assert.equal(
          (await DialogPersistence.loadDialogLatest(dialog.id, dialog.status))
            ?.diligencePushRemainingBudget,
          0,
        );
        assert.deepEqual(
          await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status),
          [],
        );
        assert.equal((await dialog.getSuspensionStatus()).canDrive, true);
        const notice = notices[0];
        assert.ok(notice?.type === 'ui_only_markdown_record');
        evidence.record({
          id: `consumed-${streaming ? 'streaming' : 'batch'}`,
          scenario:
            'A real initial drive consumes two authorized automatic nudges, reaches zero remaining budget and emits its informational notice.',
          businessValue:
            'Stop automatic continuation at its actual allowance while keeping later human work possible.',
          context: {
            language: 'en',
            streaming,
            configuredDefault: 2,
            initialBudget: 2,
            automaticPromptCount: 2,
            providerRequestsBeforeHumanContinuation: requests,
            remainingBudget: 0,
            humanQuestionCount: 0,
            canDrive: true,
            scope:
              'Real driver, persistence and dialog events; controlled message-only provider. Does not establish task completion or live-provider behavior.',
          },
          reviewQuestions: [
            'Does the actual notice accurately explain exhaustion without implying a human question, blocked manual continuation or an unsupported assessment of agent effort?',
          ],
          actualText: notice.content,
        });
        await driveDialogStream(
          dialog,
          {
            content: 'later-human-input-data',
            msgId: 'budget-human',
            grammar: 'markdown',
            origin: 'user',
            userLanguageCode: 'en',
          },
          true,
        );
        await waitForAllDialogsUnlocked(dialog, 2000);
        generator.assertNoErrors();
        assert.equal(
          requests,
          4,
          'manual continuation works without refilling the automatic allowance',
        );
        stored = await DialogPersistence.loadCourseEvents(dialog.id, 1, dialog.status);
        assert.equal(stored.filter((event) => event.type === 'gen_start_record').length, 4);
        assert.deepEqual(
          stored
            .filter((event) => event.type === 'agent_words_record')
            .map((event) => event.content),
          ['response-data-1', 'response-data-2', 'response-data-3', 'response-data-4'],
        );
        assert.equal(
          stored.filter(
            (event) => event.type === 'human_text_record' && event.origin === 'diligence_push',
          ).length,
          2,
        );
        assert.equal(
          (await DialogPersistence.loadDialogLatest(dialog.id, dialog.status))
            ?.diligencePushRemainingBudget,
          0,
        );
        const events = await trace.finish();
        assert.deepEqual(
          events.filter((event) => event.type === 'stream_error_evt'),
          [],
        );
        const budgets = events.filter((event) => event.type === 'diligence_budget_evt');
        const remaining = budgets.map((event) => event.remainingCount);
        assert.ok(
          remaining.includes(1) && remaining.includes(0),
          'UI observes consumption and exhaustion',
        );
        assert.equal(remaining.at(-1), 0);
        assert.ok(
          remaining.every(
            (count, index) =>
              Number.isInteger(count) && count >= 0 && count <= (remaining[index - 1] ?? 2),
          ),
          'state snapshots never increase or overdraw the remaining budget',
        );
        assert.ok(budgets.every((event) => event.injectedCount === 2 - event.remainingCount));
        assert.ok(
          budgets.every((event) => event.maxInjectCount === 2 && !event.disableDiligencePush),
        );
        assert.ok(
          budgets.every(
            (event) =>
              event.dialog.selfId === dialog.id.selfId && event.dialog.rootId === dialog.id.rootId,
          ),
        );
      } finally {
        unregisterLlmGenerator(apiType);
      }
    }
    await evidence.write();
  });
  console.log('budget events, durable consumption and manual continuation: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
