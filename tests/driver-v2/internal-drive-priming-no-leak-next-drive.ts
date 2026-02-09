import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/driver-entry';
import { DialogPersistence } from '../../main/persistence';

import {
  createRootDialog,
  lastAssistantSaying,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const internalPrompt = 'Priming internal: keep this only for current drive.';
    const internalAnswer = 'Internal priming applied.';
    const normalUserPrompt = 'User asks in next drive: continue with task status.';
    const normalAnswer = 'Task status updated.';

    await writeMockDb(tmpRoot, [
      {
        message: internalPrompt,
        role: 'user',
        response: internalAnswer,
      },
      {
        message: normalUserPrompt,
        role: 'user',
        response: normalAnswer,
      },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: internalPrompt,
        msgId: 'driver-v2-internal-no-leak-1',
        grammar: 'markdown',
        persistMode: 'internal',
      },
      true,
    );
    assert.equal(
      lastAssistantSaying(dlg),
      internalAnswer,
      'unexpected response for internal drive',
    );

    await driveDialogStream(
      dlg,
      {
        content: normalUserPrompt,
        msgId: 'driver-v2-internal-no-leak-2',
        grammar: 'markdown',
      },
      true,
    );
    assert.equal(lastAssistantSaying(dlg), normalAnswer, 'internal prompt leaked into next drive');

    const events = await DialogPersistence.readCourseEvents(dlg.id, dlg.currentCourse, 'running');
    const internalPromptEvents = events.filter(
      (ev) => ev.type === 'human_text_record' && ev.content === internalPrompt,
    );
    assert.equal(internalPromptEvents.length, 0, 'internal prompt should not be persisted');

    const normalPromptEvents = events.filter(
      (ev) => ev.type === 'human_text_record' && ev.content === normalUserPrompt,
    );
    assert.equal(normalPromptEvents.length, 1, 'normal user prompt should be persisted once');
  });

  console.log('driver-v2 internal-drive-priming-no-leak-next-drive: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 internal-drive-priming-no-leak-next-drive: FAIL\n${message}`);
  process.exit(1);
});
