import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { setWorkLanguage } from '../../main/shared/runtime-language';

import {
  createRootDialog,
  lastAssistantSaying,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot);

    const trigger = 'Please clear mind and continue from next course.';
    const course2Prompt =
      'This is course #2 of the dialog. You just cleared your mind; please proceed with the task.';
    const finalAnswer = 'Continued successfully in course #2.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Clearing now.',
        funcCalls: [
          {
            name: 'clear_mind',
            arguments: {
              reminder_content: 'Continue from course #2 and finish validation.',
            },
          },
        ],
        // Force critical snapshot so genIterNo>1 passes through context-health gating.
        usage: { promptTokens: 260_000, completionTokens: 120 },
      },
      {
        message: course2Prompt,
        role: 'user',
        response: finalAnswer,
        usage: { promptTokens: 200, completionTokens: 80 },
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-clear-mind-critical-auto-course',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    assert.equal(dlg.currentCourse, 2, 'clear_mind should switch dialog to course #2');
    assert.equal(
      lastAssistantSaying(dlg),
      finalAnswer,
      'driver should auto-start the new course and continue generation',
    );
    assert.equal(
      dlg.reminders.length,
      1,
      'clear_mind reminder should be preserved into the new course',
    );
    assert.deepEqual(dlg.reminders[0]?.meta, {
      kind: 'continuation_package',
      createdBy: 'clear_mind',
    });

    const promptingContents = dlg.msgs
      .filter((msg) => msg.type === 'prompting_msg' && msg.role === 'user')
      .map((msg) => msg.content);
    assert.ok(
      promptingContents.includes(course2Prompt),
      `expected course-2 upNext prompt to be consumed, got: ${JSON.stringify(promptingContents)}`,
    );
  });

  console.log('kernel-driver clear-mind-critical-auto-course: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver clear-mind-critical-auto-course: FAIL\n${message}`);
  process.exit(1);
});
