import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { collectBudgetExhaustion } from '../helpers/budget-exhaustion-fixture';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { waitForAllDialogsUnlocked } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-empty-budget-notice-');
async function main(): Promise<void> {
  for (const language of ['zh', 'en'] as const) {
    const actual = await collectBudgetExhaustion(language);
    assert.equal(actual.language, language);
    assert.equal(actual.notices.length, 1, 'exhaustion should persist one informational UI record');
    assert.equal(
      actual.automaticPromptCount,
      0,
      'an exhausted allowance cannot inject another automatic prompt',
    );
    assert.equal(
      actual.generationCount,
      1,
      'the initial user round completes without another generation',
    );
    assert.equal(actual.latest?.diligencePushRemainingBudget, 0);
    assert.equal(
      actual.questions.length,
      0,
      'an allowance notice must not create a human question',
    );
    assert.equal(
      actual.suspension.canDrive,
      true,
      'the notice must not block later human continuation',
    );
    assert.equal(
      actual.answers.length,
      1,
      'the initial user request must still receive its answer',
    );
    assert.equal(actual.answers[0]?.content, actual.answer);
    const trace = recordDialogEvents(actual.dialog);
    await driveDialogStream(
      actual.dialog,
      {
        content: actual.manualInput,
        msgId: actual.manualInput,
        grammar: 'markdown',
        origin: 'user',
        userLanguageCode: language,
      },
      true,
    );
    await waitForAllDialogsUnlocked(actual.dialog, 2_000);
    const answers = await DialogPersistence.loadAnswersToHumanState(
      actual.dialog.id,
      actual.dialog.status,
    );
    assert.equal(
      answers.length,
      2,
      'a new human request must still run after the allowance notice',
    );
    assert.equal(answers[1]?.content, actual.manualAnswer);
    assert.equal((await actual.dialog.getSuspensionStatus()).canDrive, true);
    assert.deepEqual(
      (await trace.finish()).filter((event) => event.type === 'stream_error_evt'),
      [],
    );
    assert.equal(
      (await DialogPersistence.loadDialogLatest(actual.dialog.id, actual.dialog.status))
        ?.diligencePushRemainingBudget,
      0,
    );
    const notice = actual.notices[0];
    assert.ok(notice);
    evidence.record({
      id: `empty-budget-${language}`,
      scenario:
        'An initial human request starts with zero automatic allowance, receives its real answer and a budget notice; a later human request also receives its answer without refilling the allowance.',
      businessValue:
        'Explain automatic continuation limits without blocking human work or inventing an unanswered human question.',
      context: {
        language,
        configuredDefault: actual.configuredDefault,
        initialBudget: 0,
        automaticPromptsBeforeNotice: actual.automaticPromptCount,
        answersAfterManualContinuation: answers.length,
        remainingBudget: 0,
        canDrive: true,
        scope:
          'Actual runtime UI-only notice and durable answers through a controlled provider fixture; no WebSocket/UI or live-model claim.',
      },
      reviewQuestions: [
        'Does this actual notice explain the empty allowance without claiming that the configured default counts previous attempts, requiring a new question or preventing later human continuation?',
      ],
      actualText: notice.content,
    });
  }
  await evidence.write();
  console.log('budget exhaustion remains informational and preserves the user answer: PASS');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
