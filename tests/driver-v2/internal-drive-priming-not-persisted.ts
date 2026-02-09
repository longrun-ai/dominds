import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/driver';
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

    const internalPrompt = 'Priming internal: summarize runtime environment in one line.';
    const primingAnswer = 'Priming summary is ready.';
    await writeMockDb(tmpRoot, [
      {
        message: internalPrompt,
        role: 'user',
        response: primingAnswer,
      },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: internalPrompt,
        msgId: 'driver-v2-internal-not-persisted',
        grammar: 'markdown',
        persistMode: 'internal',
      },
      true,
    );

    assert.equal(lastAssistantSaying(dlg), primingAnswer, 'unexpected assistant response');

    const persistedAsPrompting = dlg.msgs.some(
      (msg) =>
        msg.type === 'prompting_msg' && msg.role === 'user' && msg.content === internalPrompt,
    );
    assert.equal(
      persistedAsPrompting,
      false,
      'internal prompt should not be persisted in dlg.msgs',
    );

    const events = await DialogPersistence.readCourseEvents(dlg.id, dlg.currentCourse, 'running');
    const persistedAsHumanText = events.some(
      (ev) => ev.type === 'human_text_record' && ev.content === internalPrompt,
    );
    assert.equal(
      persistedAsHumanText,
      false,
      'internal prompt should not be persisted as human_text_record',
    );
  });

  console.log('driver-v2 internal-drive-priming-not-persisted: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 internal-drive-priming-not-persisted: FAIL\n${message}`);
  process.exit(1);
});
