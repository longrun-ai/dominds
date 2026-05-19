import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { DomindsPersistenceFileError } from '../../main/persistence-errors';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

type DialogPersistencePrivate = typeof DialogPersistence & {
  getLatestWriteBackKey(dialogId: { selfId: string; rootId: string }, status: 'running'): string;
  flushLatestWriteBack(key: string): Promise<void>;
};

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    await writeMockDb(tmpRoot, [
      {
        message: 'This turn must not reach the provider after latest.yaml is malformed.',
        role: 'user',
        response: 'Provider should not be reached.',
      },
    ]);

    const dialog = await createMainDialog('tester');
    dialog.disableDiligencePush = true;

    const persistenceInternals = DialogPersistence as DialogPersistencePrivate;
    const latestKey = persistenceInternals.getLatestWriteBackKey(dialog.id, 'running');
    await persistenceInternals.flushLatestWriteBack(latestKey);

    const latestPath = path.join(tmpRoot, '.dialogs', 'run', dialog.id.selfId, 'latest.yaml');
    await fs.writeFile(latestPath, 'currentCourse: nope\n', 'utf-8');

    await assert.rejects(
      driveDialogStream(
        dialog,
        makeUserPrompt(
          'This turn must not reach the provider after latest.yaml is malformed.',
          'kernel-driver-pre-drive-latest-load-failure-stops',
        ),
        true,
      ),
      (error: unknown) => error instanceof DomindsPersistenceFileError,
      'pre-drive latest.yaml load failure must stop instead of best-effort driving',
    );

    const malformedRoot = path.join(tmpRoot, '.dialogs', 'malformed', dialog.id.selfId);
    await fs.access(malformedRoot);
    assert.equal(
      dialog.msgs.some(
        (msg) => msg.type === 'saying_msg' && msg.content === 'Provider should not be reached.',
      ),
      false,
      'driver must not continue into LLM core after latest.yaml load failure',
    );
  });

  console.log('kernel-driver pre-drive-latest-load-failure-stops: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver pre-drive-latest-load-failure-stops: FAIL\n${message}`);
  process.exit(1);
});
