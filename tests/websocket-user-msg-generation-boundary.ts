import assert from 'node:assert/strict';

import type WebSocket from 'ws';
import { DialogID, MainDialog } from '../main/dialog';
import { DiskFileDialogStore } from '../main/persistence';
import {
  resolveUserMessageLanguageCodeForTest,
  shouldQueueUserSupplementAtGenerationBoundary,
} from '../main/server/websocket-handler';
import { generateDialogID } from '../main/utils/id';

function main(): void {
  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: false,
      inMemoryGenerating: false,
      isLocked: true,
    }),
    false,
    'should not queue when neither persisted nor in-memory generating state is active',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: true,
      inMemoryGenerating: false,
      isLocked: true,
    }),
    true,
    'should queue when persisted latest says generating',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: false,
      inMemoryGenerating: true,
      isLocked: true,
    }),
    true,
    'should queue during the live generating-start race window before latest.yaml flips',
  );

  assert.equal(
    shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: true,
      inMemoryGenerating: true,
      isLocked: false,
    }),
    false,
    'should not queue once the dialog lock is gone even if stale generating flags remain',
  );
}

function mainAsync(): void {
  main();

  const dialogId = new DialogID(generateDialogID());
  const dialog = new MainDialog(new DiskFileDialogStore(dialogId), 'task.md', dialogId, 'tester');
  dialog.setLastUserLanguageCode('en');
  assert.equal(
    resolveUserMessageLanguageCodeForTest({
      ws: {} as WebSocket,
      raw: undefined,
      fallbackDialog: dialog,
    }),
    'en',
    'user message language resolution should fall back to the target dialog after it is known',
  );
}

try {
  mainAsync();
  console.log('WebSocket generation-boundary eligibility and language fallback: passed');
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`websocket-user-msg-generation-boundary: FAIL\n${message}`);
  process.exit(1);
}
