import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeDriveOptions,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const prompt = 'Consume the previously queued wake now.';
    const response = 'The pending wake has already been handled in this foreground round.';

    await writeMockDb(tmpRoot, [
      {
        message: prompt,
        role: 'user',
        response,
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    await DialogPersistence.upsertRootRuntimeWake(
      root.id,
      'seed_root_queue_before_foreground_consumption_without_blocked_drive_marker',
      root.status,
    );
    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'seed_root_queue_before_foreground_consumption_without_blocked_drive_marker',
    });
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId),
      false,
      'test precondition: queued root should not already carry an active-run-cleared drive marker',
    );

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        {
          content: prompt,
          msgId: 'root-manual-round-clears-consumed-root-runtime-wake',
          grammar: 'markdown',
          origin: 'runtime',
        },
        true,
        makeDriveOptions({
          source: 'ws_resume_dialog',
          reason: 'test_foreground_consumes_root_runtime_wake',
          suppressDiligencePush: true,
        }),
      ],
      scheduleDrive: () => {},
      driveDialog: async () => {},
    });

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      hasPendingNextStepTriggers(latest),
      false,
      'idle foreground root round should clear the consumed root runtime wake from persistence',
    );
    assert.equal(
      await DialogPersistence.hasRootRuntimeWake(root.id, root.status),
      false,
      'idle foreground root round should remove the consumed root runtime wake queue entry',
    );
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId),
      false,
      'idle foreground root round should not leave a deferred drive marker behind',
    );
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedDrive(root.id.rootId),
      false,
      'idle foreground root round should not leave a deferred drive marker behind after durable root runtime wake cleanup',
    );
  });

  console.log('kernel-driver root-manual-round-clears-consumed-root-runtime-wake: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver root-manual-round-clears-consumed-root-runtime-wake: FAIL\n${message}`,
  );
  process.exit(1);
});
