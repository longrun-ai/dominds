import assert from 'node:assert/strict';

import { toDialogCourseNumber } from '@longrun-ai/kernel/types/storage';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';

import { createMainDialog, lastAssistantSaying, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    await DialogPersistence.upsertNextStepTrigger(root.id, {
      triggerId: 'root-next-step-without-durable-work',
      kind: 'mainline_diligence',
      diligenceId: 'root-next-step-without-runtime-wake',
      pendingTellaskCount: 0,
    });
    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: {
        sideDialogFinalResponse: {
          callId: 'root-final-response-projection',
          responseCourse: toDialogCourseNumber(1),
          responseGenseq: 1,
          askerDialogId: root.id.selfId,
          askerCourse: toDialogCourseNumber(1),
        },
      },
    }));
    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.ok(latest, 'expected root latest after test setup');
    await DialogPersistence.syncWakeQueueForDialogLatest(root.id, latest, root.status);
    assert.equal(
      await DialogPersistence.hasRootRuntimeWake(root.id, root.status),
      false,
      'test precondition: root must not have a root_runtime_wake entry',
    );

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'root_regular_wake_queue_entry_is_not_runtime_wake',
    });

    await driveQueuedDialogsOnce();

    assert.equal(
      lastAssistantSaying(root),
      null,
      'backend loop must not treat a regular root Wake Queue entry as root_runtime_wake',
    );
  });

  console.log('kernel-driver root-wake-queue-entry-is-not-runtime-wake: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver root-wake-queue-entry-is-not-runtime-wake: FAIL\n${message}`);
  process.exit(1);
});
