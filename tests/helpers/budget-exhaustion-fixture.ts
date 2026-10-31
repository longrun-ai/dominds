import type { UiOnlyMarkdownRecord } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import { recordDialogEvents } from './dialog-events';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  waitForAllDialogsUnlocked,
  writeMockDb,
  writeStandardMinds,
} from '../kernel-driver/helpers';

// Both the state regression and subjective UI review use this real runtime path.
export async function collectBudgetExhaustion(language: 'zh' | 'en') {
  if (process.env.DOMINDS_TEST_RTWS_MANAGED !== '1') {
    throw new Error('Budget exhaustion fixtures require the isolated rtws runner');
  }
  const configuredDefault = 3;
  await writeStandardMinds(process.cwd(), { diligencePushMax: configuredDefault });
  const input = `budget-fixture-${language}`;
  const answer = `budget-answer-${language}`;
  const manualInput = `manual-continuation-${language}`;
  const manualAnswer = `manual-answer-${language}`;
  await writeMockDb(process.cwd(), [
    {
      message: input,
      role: 'user',
      response: '',
      omitDefaultThinking: true,
      funcCalls: [
        {
          id: `budget-answer-call-${language}`,
          name: 'answerHuman',
          arguments: { answerContent: answer },
        },
      ],
    },
    {
      message: manualInput,
      role: 'user',
      response: '',
      omitDefaultThinking: true,
      funcCalls: [
        {
          id: `manual-answer-call-${language}`,
          name: 'answerHuman',
          arguments: { answerContent: manualAnswer },
        },
      ],
    },
  ]);
  const dialog = await createMainDialog('tester');
  dialog.disableDiligencePush = false;
  dialog.diligencePushRemainingBudget = 0;
  const trace = recordDialogEvents(dialog);
  await driveDialogStream(
    dialog,
    {
      content: input,
      msgId: input,
      grammar: 'markdown',
      origin: 'user',
      userLanguageCode: language,
    },
    true,
  );
  await waitForAllDialogsUnlocked(dialog, 2_000);
  const streamEvents = await trace.finish();
  assert.deepEqual(
    streamEvents.filter((event) => event.type === 'stream_error_evt'),
    [],
  );
  const events = await DialogPersistence.loadCourseEvents(
    dialog.id,
    dialog.currentCourse,
    dialog.status,
  );
  return {
    configuredDefault,
    streamEvents,
    language: dialog.getLastUserLanguageCode(),
    notices: events.filter(
      (event): event is UiOnlyMarkdownRecord => event.type === 'ui_only_markdown_record',
    ),
    automaticPromptCount: events.filter(
      (event) => event.type === 'human_text_record' && event.origin === 'diligence_push',
    ).length,
    generationCount: events.filter((event) => event.type === 'gen_start_record').length,
    questions: await DialogPersistence.loadQuestions4HumanState(dialog.id, dialog.status),
    answers: await DialogPersistence.loadAnswersToHumanState(dialog.id, dialog.status),
    latest: await DialogPersistence.loadDialogLatest(dialog.id, dialog.status),
    suspension: await dialog.getSuspensionStatus(),
    answer,
    dialog,
    manualInput,
    manualAnswer,
  };
}
