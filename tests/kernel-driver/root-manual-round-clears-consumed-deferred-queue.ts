import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeDriveOptions,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const prompt = 'Consume the previously queued revive now.';
    const response = 'The pending revive has already been handled in this foreground round.';

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

    await DialogPersistence.setNeedsDrive(root.id, true, root.status);
    globalDialogRegistry.markNeedsDrive(root.id.rootId, {
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
          msgId: 'root-manual-round-clears-consumed-deferred-queue',
          grammar: 'markdown',
          origin: 'runtime',
        },
        true,
        makeDriveOptions({
          source: 'ws_resume_dialog',
          reason: 'test_foreground_consumes_deferred_queue',
          suppressDiligencePush: true,
        }),
      ],
      scheduleDrive: () => {},
      driveDialog: async () => {},
    });

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.needsDrive,
      false,
      'idle foreground root round should clear the consumed deferred queue from persistence',
    );
    assert.equal(
      globalDialogRegistry.hasPendingActiveRunClearedWake(root.id.rootId),
      false,
      'idle foreground root round should not leave a deferred wake marker behind',
    );
    const lastTrigger = globalDialogRegistry.getLastDriveTrigger(root.id.rootId);
    assert.equal(
      lastTrigger?.action,
      'mark_not_needing_drive',
      'idle foreground root round should clear the stale queue instead of emitting active_run_cleared',
    );
  });

  console.log('kernel-driver root-manual-round-clears-consumed-deferred-queue: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-manual-round-clears-consumed-deferred-queue: FAIL\n${message}`);
  process.exit(1);
});
