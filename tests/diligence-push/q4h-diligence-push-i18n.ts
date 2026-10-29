import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { collectBudgetExhaustion } from '../helpers/budget-exhaustion-fixture';
import { waitForAllDialogsUnlocked } from '../kernel-driver/helpers';

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
  }
  console.log('budget exhaustion remains informational and preserves the user answer: PASS');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
