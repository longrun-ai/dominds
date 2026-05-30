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
        message: 'Please answer with answerHuman only.',
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        funcCalls: [
          {
            id: 'call-answer-human-a2h',
            name: 'answerHuman',
            arguments: {
              answerContent: 'This is the recorded answer for the human.',
            },
          },
        ],
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = false;
    root.diligencePushRemainingBudget = 1;

    await driveDialogStream(
      root,
      makeUserPrompt('Please answer with answerHuman only.', 'answer-human-a2h-deferred-msg'),
      true,
      makeDriveOptions(),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const answers = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
    assert.equal(answers.length, 1, 'answerHuman should append exactly one A2H record');
    assert.equal(
      answers[0]?.content,
      'This is the recorded answer for the human.',
      'A2H content should come from answerHuman.answerContent',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(answers[0] ?? {}, 'userInterjection'),
      false,
      'A2H should no longer persist a userInterjection coordinate',
    );

    const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
    assert.equal(questions.length, 0, 'answerHuman must not create Q4H questions');

    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      events.filter((event) => event.type === 'gen_start_record').length,
      2,
      'answerHuman-only tool rounds should consume one available diligence budget for one follow-up generation',
    );
    assert.equal(root.diligencePushRemainingBudget, 0, 'diligence follow-up should consume budget');
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tellask_call_record' &&
          event.name === 'answerHuman' &&
          event.deliveryMode === 'func_call_requested',
      ),
      'answerHuman should persist as a tellask-special function call request',
    );
    assert.ok(
      events.some((event) => event.type === 'func_result_record' && event.name === 'answerHuman'),
      'answerHuman should receive a paired function result',
    );
  });

  console.log('kernel-driver answerHuman A2H deferred: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver answerHuman A2H deferred: FAIL\n${message}`);
  process.exit(1);
});
