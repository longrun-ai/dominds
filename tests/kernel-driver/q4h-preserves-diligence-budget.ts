import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { diligencePushMax: 1 });
    await writeMockDb(tmpRoot, [
      {
        message: 'Please pause for human confirmation.',
        role: 'user',
        response: 'I need a human confirmation before proceeding.',
        funcCalls: [
          {
            id: 'askhuman-preserve-diligence-budget',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm whether to continue.',
            },
          },
        ],
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = false;
    root.diligencePushRemainingBudget = 7;

    await driveDialogStream(
      root,
      makeUserPrompt('Please pause for human confirmation.', 'q4h-preserve-diligence-budget-msg'),
      true,
      makeDriveOptions(),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
    assert.equal(questions.length, 1, 'expected askHuman to suspend the dialog with one Q4H');
    assert.equal(
      root.diligencePushRemainingBudget,
      7,
      'Q4H suspension must preserve the dialog remaining budget instead of resetting to member default',
    );

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.diligencePushRemainingBudget,
      7,
      'persisted remaining budget should also survive Q4H suspension',
    );
  });

  console.log('kernel-driver q4h preserves diligence budget: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver q4h preserves diligence budget: FAIL\n${message}`);
  process.exit(1);
});
