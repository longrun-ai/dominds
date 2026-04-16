import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';

import {
  createRootDialog,
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

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);
    void runBackendDriver();

    await root.startNewCourse(queuedPrompt);
    globalDialogRegistry.markNeedsDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'root_pending_course_start_should_not_require_explicit_resume',
    });

    await waitFor(
      async () => lastAssistantSaying(root) === finalReply,
      3_000,
      'backend loop to drive the root pending-course-start prompt without an explicit resume request',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.pendingCourseStartPrompt,
      undefined,
      'backend loop should consume the durable pending root course-start prompt',
    );
    assert.equal(
      latest?.needsDrive,
      false,
      'backend loop should clear needsDrive after consuming the root pending course-start prompt',
    );
  });

  console.log(
    'kernel-driver root-pending-course-start-backend-loop-drives-without-explicit-resume: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver root-pending-course-start-backend-loop-drives-without-explicit-resume: FAIL\n${message}`,
  );
  process.exit(1);
});
