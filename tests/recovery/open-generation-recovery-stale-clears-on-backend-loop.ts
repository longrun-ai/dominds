import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    globalDialogRegistry.register(root);

    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: {
        generating: false,
        generationRunState: undefined,
        nextStep: {
          nextSeq: 2,
          triggers: [
            {
              triggerId: `open-generation-recovery:${root.id.selfId}:1:1`,
              kind: 'open_generation_recovery',
              course: 1,
              genseq: 1,
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
      },
    }));

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_open_generation_recovery_stale',
      reason: 'open_generation_recovery',
    });
    await driveQueuedDialogsOnce();

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.nextStep.triggers.some((trigger) => trigger.kind === 'open_generation_recovery'),
      false,
      'stale open generation recovery trigger should be cleared by backend loop',
    );
    assert.equal(
      latest?.generating,
      false,
      'backend loop should not resurrect generating state for a stale open generation cue',
    );
  });

  console.log('recovery open-generation-recovery-stale-clears-on-backend-loop: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`recovery open-generation-recovery-stale-clears-on-backend-loop: FAIL\n${message}`);
  process.exit(1);
});
