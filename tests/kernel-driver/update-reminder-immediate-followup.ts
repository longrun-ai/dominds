import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    const dlg = await createMainDialog('tester');
    const reminder = dlg.addReminder('Initial bridge note.', undefined, undefined, undefined, {
      scope: 'dialog',
      renderMode: 'markdown',
    });
    const reminderId = reminder.id;

    await writeMockDb(tmpRoot, [
      {
        message: 'Please update the reminder and keep going.',
        role: 'user',
        response: 'Updating the reminder now.',
        funcCalls: [
          {
            id: 'update-reminder-call',
            name: 'update_reminder',
            arguments: {
              reminder_id: reminderId,
              content: 'Refined continuation note.',
            },
          },
        ],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: 'Continuing after the reminder update.',
      },
    ]);

    await driveDialogStream(
      dlg,
      makeUserPrompt(
        'Please update the reminder and keep going.',
        'update-reminder-immediate-followup',
      ),
      true,
    );

    await waitForAllDialogsUnlocked(dlg, 3_000);

    const events = await DialogPersistence.loadCourseEvents(dlg.id, dlg.currentCourse, dlg.status);
    const genStartCount = events.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount >= 2,
      true,
      'update_reminder should trigger an immediate follow-up generation',
    );
    assert.ok(
      dlg.msgs.some(
        (msg) =>
          msg.type === 'saying_msg' &&
          msg.role === 'assistant' &&
          msg.content === 'Continuing after the reminder update.',
      ),
      'expected the follow-up generation to run after update_reminder',
    );
    assert.ok(
      dlg.msgs.some(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.name === 'update_reminder' &&
          (msg.content.includes('已更新') || msg.content.includes('Updated')),
      ),
      'expected update_reminder result to be persisted before the follow-up',
    );

    const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.ok(latest, 'expected latest dialog state to exist');
    assert.equal(
      hasPendingNextStepTriggers(latest),
      false,
      'immediate follow-up should be consumed once the next generation starts',
    );
  });

  console.log('kernel-driver update-reminder-immediate-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver update-reminder-immediate-followup: FAIL\n${message}`);
  process.exit(1);
});
