import assert from 'node:assert/strict';

import type { ActiveCalleeDispatchRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
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
      {
        message: 'Please record that we are waiting for the active callee.',
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        funcCalls: [
          {
            id: 'call-answer-human-active-callee-wait',
            name: 'answerHuman',
            arguments: {
              answerContent: 'Waiting for the active callee reply.',
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
    const diligencePromptCountBeforeWait = events.filter(
      (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
    ).length;

    root.diligencePushRemainingBudget = 1;
    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: {
        diligencePushRemainingBudget: 1,
      },
    }));
    const pendingActiveCallee: ActiveCalleeDispatchRecord = {
      calleeDialogId: 'synthetic/active/callee',
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'synthetic-active-callee-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: 'Synthetic pending callee used to test wait-boundary behavior.',
      targetAgentId: 'pangu',
      callId: 'synthetic-active-callee-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    };
    await DialogPersistence.appendActiveCalleeDispatch(root.id, pendingActiveCallee);

    await driveDialogStream(
      root,
      makeUserPrompt(
        'Please record that we are waiting for the active callee.',
        'answer-human-active-callee-wait-msg',
      ),
      true,
      makeDriveOptions(),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const answersAfterWait = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
    assert.equal(
      answersAfterWait.some((answer) => answer.content === 'Waiting for the active callee reply.'),
      true,
      'answerHuman should record active-callee wait status as A2H',
    );
    const eventsAfterWait = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      eventsAfterWait.filter((event) => event.type === 'gen_start_record').length,
      3,
      'answerHuman while an active callee is pending must not start a post-tool or Diligence Push generation',
    );
    assert.equal(
      root.diligencePushRemainingBudget,
      1,
      'answerHuman while an active callee is pending must not consume Diligence Push budget',
    );
    assert.equal(
      eventsAfterWait.filter(
        (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
      ).length,
      diligencePromptCountBeforeWait,
      'answerHuman while an active callee is pending must not add a Diligence Push prompt',
    );
    const activeCalleesAfterWait = await DialogPersistence.loadActiveCallees(root.id, root.status);
    assert.equal(
      activeCalleesAfterWait.batches.length,
      1,
      'answerHuman wait status must not clear the pending active callee batch',
    );
    assert.equal(
      activeCalleesAfterWait.batches[0]?.callees[0]?.callId,
      'synthetic-active-callee-call',
      'answerHuman wait status must leave the pending callee call id intact',
    );
  });

  console.log('kernel-driver answerHuman A2H deferred: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver answerHuman A2H deferred: FAIL\n${message}`);
  process.exit(1);
});
