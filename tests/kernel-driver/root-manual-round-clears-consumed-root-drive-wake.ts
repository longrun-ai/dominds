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

    await DialogPersistence.upsertRootDriveWakeTrigger(
      root.id,
      'seed_root_queue_before_foreground_consumption_without_blocked_wake_marker',
      root.status,
    );
    globalDialogRegistry.wakeDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'seed_root_queue_before_foreground_consumption_without_blocked_wake_marker',
    });
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedWake(root.id.rootId),
      false,
      'test precondition: queued root should not already carry an active-run-cleared wake marker',
    );

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        {
          content: prompt,
          msgId: 'root-manual-round-clears-consumed-root-drive-wake',
          grammar: 'markdown',
          origin: 'runtime',
        },
        true,
        makeDriveOptions({
          source: 'ws_resume_dialog',
          reason: 'test_foreground_consumes_root_drive_wake',
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
      'idle foreground root round should clear the consumed root drive wake from persistence',
    );
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedWake(root.id.rootId),
      false,
      'idle foreground root round should not leave a deferred wake marker behind',
    );
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedWake(root.id.rootId),
      false,
      'idle foreground root round should not leave a deferred wake marker behind after durable root drive wake cleanup',
    );
  });

  console.log('kernel-driver root-manual-round-clears-consumed-root-drive-wake: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver root-manual-round-clears-consumed-root-drive-wake: FAIL\n${message}`,
  );
  process.exit(1);
});
