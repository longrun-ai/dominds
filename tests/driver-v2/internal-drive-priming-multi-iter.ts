import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/driver';
import { DialogPersistence } from '../../main/persistence';

import { createRootDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const internalPrompt = 'Priming internal multi-iter probe.';
    const answer = 'Priming context visible in this generation.';
    await writeMockDb(tmpRoot, [
      {
        message: internalPrompt,
        role: 'user',
        response: answer,
      },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = false;
    dlg.diligencePushRemainingBudget = 2;

    await driveDialogStream(
      dlg,
      {
        content: internalPrompt,
        msgId: 'driver-v2-internal-multi-iter',
        grammar: 'markdown',
        persistMode: 'internal',
      },
      true,
    );

    const assistantSayings = dlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    const answerCount = assistantSayings.filter((msg) => msg.content === answer).length;
    assert.ok(
      answerCount >= 2,
      `expected internal prompt to stay visible across >=2 iterations, got ${answerCount}`,
    );
    const fallbackCount = assistantSayings.filter((msg) =>
      msg.content.includes('Mock Response Not Found'),
    ).length;
    assert.equal(
      fallbackCount,
      0,
      'multi-iter run hit mock fallback, indicating the last user context drifted unexpectedly',
    );

    const events = await DialogPersistence.readCourseEvents(dlg.id, dlg.currentCourse, 'running');
    const internalPromptEvents = events.filter(
      (ev) => ev.type === 'human_text_record' && ev.content === internalPrompt,
    );
    assert.equal(internalPromptEvents.length, 0, 'internal prompt should never be persisted');
  });

  console.log('driver-v2 internal-drive-priming-multi-iter: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 internal-drive-priming-multi-iter: FAIL\n${message}`);
  process.exit(1);
});
