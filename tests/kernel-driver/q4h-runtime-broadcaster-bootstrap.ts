import assert from 'node:assert/strict';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { requireRecordingGlobalDialogEventRecorder } from '../../main/bootstrap/global-dialog-event-broadcaster';
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
    await writeStandardMinds(tmpRoot);
    await writeMockDb(tmpRoot, [
      {
        message: 'Please ask the human to confirm the deployment window.',
        role: 'user',
        response: 'I need a human confirmation before proceeding.',
        funcCalls: [
          {
            id: 'askhuman-runtime-bootstrap',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm the deployment window.',
            },
          },
        ],
      },
    ]);

    const recorder = requireRecordingGlobalDialogEventRecorder(
      'kernel-driver/q4h-runtime-broadcaster-bootstrap',
    );
    recorder.clear();

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(
        'Please ask the human to confirm the deployment window.',
        'q4h-runtime-bootstrap-user-msg',
      ),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
    assert.equal(
      questions.length,
      1,
      'Q4H should persist successfully when runtime bootstrap installs broadcaster',
    );

    const courseEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const failedAskHuman = courseEvents.find(
      (event) =>
        event.type === 'func_result_record' &&
        event.id === 'askhuman-runtime-bootstrap' &&
        event.name === 'askHuman' &&
        event.content.includes('Global dialog event broadcaster missing'),
    );
    assert.equal(
      failedAskHuman,
      undefined,
      'askHuman should not be downgraded into a Q4H failure when runtime bootstrap installed broadcaster',
    );
    const broadcastEvents = recorder.snapshot();
    const broadcasterFailure = broadcastEvents.find(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt' &&
        event.error.includes('Global dialog event broadcaster missing'),
    );
    assert.equal(
      broadcasterFailure,
      undefined,
      'runtime bootstrap should prevent broadcaster-missing stream errors',
    );
    const q4hAskedEvent = broadcastEvents.find(
      (event): event is Extract<TypedDialogEvent, { type: 'new_q4h_asked' }> =>
        event.type === 'new_q4h_asked' && event.dialog.selfId === root.id.selfId,
    );
    assert.ok(q4hAskedEvent, 'runtime recording broadcaster should capture new_q4h_asked');
    assert.equal(
      q4hAskedEvent?.question.callId,
      'askhuman-runtime-bootstrap',
      'captured Q4H broadcast should preserve the originating callId',
    );
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver q4h runtime broadcaster bootstrap: FAIL\n${message}`);
  process.exit(1);
});
