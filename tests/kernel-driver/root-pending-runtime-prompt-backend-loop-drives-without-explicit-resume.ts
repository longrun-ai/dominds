import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  lastAssistantSaying,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const queuedPrompt = formatNewCourseStartPrompt('en', {
      nextCourse: 2,
      source: 'clear_mind',
    });
    const finalReply = 'Root backend loop continued the pending new-course prompt.';

    await writeMockDb(tmpRoot, [
      {
        message: queuedPrompt,
        role: 'user',
        response: finalReply,
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);
    const abortController = new AbortController();
    const backendDriver = runBackendDriver({ abortSignal: abortController.signal });

    try {
      await root.startNewCourse(queuedPrompt);

      await waitFor(
        async () => lastAssistantSaying(root) === finalReply,
        3_000,
        'backend loop to drive the durable root pending runtime prompt without registry pending next-step triggers',
      );
      await waitForAllDialogsUnlocked(root, 3_000);

      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(
        latest?.pendingRuntimePrompt,
        undefined,
        'backend loop should consume the durable pending root runtime prompt',
      );
      assert.equal(
        hasPendingNextStepTriggers(latest),
        false,
        'backend loop should clear pending next-step triggers after consuming the root pending runtime prompt',
      );
    } finally {
      abortController.abort();
      await backendDriver;
    }
  });

  console.log(
    'kernel-driver root-pending-runtime-prompt-backend-loop-drives-without-explicit-resume: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver root-pending-runtime-prompt-backend-loop-drives-without-explicit-resume: FAIL\n${message}`,
  );
  process.exit(1);
});
