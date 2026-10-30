import assert from 'node:assert/strict';

import { requireRecordingGlobalDialogEventRecorder } from '../../main/bootstrap/global-dialog-event-broadcaster';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { recordDialogEvents } from '../helpers/dialog-events';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    for (const streaming of [true, false]) {
      await writeStandardMinds(rtws, { streaming, diligencePushMax: 1 });
      const callId = `human-call-data-${streaming}`;
      const input = 'human-confirmation-input-data';
      const question = 'human-question-payload-data';
      await writeMockDb(rtws, [
        {
          message: input,
          role: 'user',
          response: '',
          omitDefaultThinking: true,
          funcCalls: [{ id: callId, name: 'askHuman', arguments: { tellaskContent: question } }],
        },
      ]);
      const root = await createMainDialog();
      root.disableDiligencePush = false;
      root.diligencePushRemainingBudget = 7;
      const recorder = requireRecordingGlobalDialogEventRecorder('q4h-delivery-and-budget');
      recorder.clear();
      const scoped = recordDialogEvents(root);
      await driveDialogStream(root, makeUserPrompt(input, `human-input-${streaming}`), true);
      const events = await scoped.finish();
      assert.equal(events.filter((event) => event.type === 'stream_error_evt').length, 0);
      assert.equal(
        events.filter((event) => event.type === 'new_q4h_asked').length,
        0,
        'global-only Q4H delivery must not duplicate through the scoped stream',
      );
      const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
      assert.equal(questions.length, 1);
      assert.equal(questions[0].callId, callId);
      assert.equal(questions[0].tellaskContent, question);
      const broadcasts = recorder
        .snapshot()
        .filter((event) => event.type === 'new_q4h_asked')
        .filter((event) => event.dialog.selfId === root.id.selfId);
      assert.equal(broadcasts.length, 1);
      assert.deepEqual(broadcasts[0].question, {
        ...questions[0],
        rootId: root.id.rootId,
        selfId: root.id.selfId,
        agentId: root.agentId,
        taskDocPath: root.taskDocPath,
      });
      assert.equal(root.diligencePushRemainingBudget, 7);
      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(latest?.diligencePushRemainingBudget, 7);
      assert.equal(latest?.displayState?.kind, 'blocked');
      const before = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(before.filter((event) => event.type === 'gen_start_record').length, 1);
      globalDialogRegistry.queueRootDrive(root.id.rootId, {
        source: 'kernel_driver_test',
        reason: 'q4h-queued-wake-data',
      });
      await driveQueuedDialogsOnce();
      const after = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      assert.equal(
        after.filter((event) => event.type === 'gen_start_record').length,
        1,
        'waiting for a human must block an automatically queued provider generation',
      );
      globalDialogRegistry.unregister(root.id.rootId);
      const restored = await getOrRestoreMainDialog(root.id.rootId, root.status);
      assert.ok(restored);
      assert.notEqual(restored, root);
      assert.equal(
        restored.diligencePushRemainingBudget,
        7,
        'operator-added budget survives reconstruction above the configured default',
      );
      assert.deepEqual(
        await DialogPersistence.loadQuestions4HumanState(restored.id, restored.status),
        questions,
      );
      assert.deepEqual(await restored.getSuspensionStatus(), {
        q4h: true,
        backgroundCalleeDialogs: false,
        canDrive: false,
      });
      globalDialogRegistry.unregister(restored.id.rootId);
    }
  });
  console.log(
    'Q4H broadcasts once, blocks automatic generation and preserves budget through restore: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
