import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';

import {
  createMainDialog,
  lastAssistantSaying,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const queuedPrompt = formatNewCourseStartPrompt('en', {
      nextCourse: 2,
      source: 'clear_mind',
    });
    const finalReply = 'Backend loop drove only after an explicit root wake.';

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
    await root.startNewCourse(queuedPrompt);
    globalDialogRegistry.clearRootDriveQueue(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'remove_start_new_course_wake_for_scan_guard',
    });

    await driveQueuedDialogsOnce();
    assert.equal(
      lastAssistantSaying(root),
      null,
      'backend loop must not discover durable work by enumerating all registered roots',
    );

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'explicit_wake_after_unwoken_root_scan_guard',
    });
    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);
    assert.equal(
      lastAssistantSaying(root),
      finalReply,
      'backend loop should drive the same durable work after an explicit root wake',
    );
  });

  console.log('kernel-driver backend-loop-does-not-scan-unwoken-roots: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver backend-loop-does-not-scan-unwoken-roots: FAIL\n${message}`);
  process.exit(1);
});
