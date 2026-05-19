import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';

import { createMainDialog, lastAssistantSaying, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const queuedPrompt = formatNewCourseStartPrompt('en', {
      nextCourse: 2,
      source: 'clear_mind',
    });

    await root.startNewCourse(queuedPrompt);
    const queued = root.peekQueuedPrompt();
    assert.ok(queued, 'test precondition: startNewCourse should materialize a queued prompt');

    await DialogPersistence.clearPendingRuntimePrompt(root.id, queued.msgId, root.status);
    assert.equal(
      root.hasQueuedPrompt(),
      true,
      'test precondition: in-memory queue should still contain the stale runtime prompt',
    );

    await driveDialogStream(root, undefined, true);

    assert.equal(
      root.hasQueuedPrompt(),
      false,
      'driver should discard the stale in-memory pending runtime prompt claim',
    );
    assert.equal(
      lastAssistantSaying(root),
      null,
      'driver must not call the LLM for a queued runtime prompt without durable pending authority',
    );
    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(latest?.pendingRuntimePrompt, undefined);
    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      events.some((event) => event.type === 'gen_start_record'),
      false,
      'stale pending runtime prompt claim must not open a generation',
    );
  });

  console.log('kernel-driver stale-pending-runtime-prompt-queue-claim: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver stale-pending-runtime-prompt-queue-claim: FAIL\n${message}`);
  process.exit(1);
});
