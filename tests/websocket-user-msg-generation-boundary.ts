import assert from 'node:assert/strict';

import { shouldQueueUserSupplementAtGenerationBoundary } from '../main/server/websocket-handler';

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

  console.log('websocket-user-msg-generation-boundary: PASS');
}

main();
