import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
        generating: true,
        generationRunState: {
          kind: 'open',
          course: 1,
          genseq: 1,
          phase: 'streaming',
          acceptedTriggerIds: [],
          openedAt: new Date().toISOString(),
        },
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
    const liveLatest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.ok(liveLatest, 'expected live open-generation latest');
    await DialogPersistence.syncWakeQueueForDialogLatest(root.id, liveLatest, root.status);

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
    const staleWakeQueuePath = path.join(
      tmpRoot,
      '.dialogs',
      'run',
      root.id.selfId,
      'wake-queue.jsonl',
    );
    await fs.mkdir(path.dirname(staleWakeQueuePath), { recursive: true });
    await fs.writeFile(
      staleWakeQueuePath,
      `${JSON.stringify({
        entryId: `open-generation-recovery:${root.id.selfId}:1:1`,
        kind: 'open_generation_recovery',
        targetDialogId: root.id.selfId,
        course: 1,
        genseq: 1,
      })}\n`,
      'utf-8',
    );

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_open_generation_recovery_stale',
      reason: 'open_generation_recovery',
    });
    const wakeQueueTargetsBeforeDrive = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.ok(
      wakeQueueTargetsBeforeDrive.some((dialogId) => dialogId.selfId === root.id.selfId),
      'test precondition: stale open generation recovery should be represented in Wake Queue before backend loop cleanup',
    );
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
    const wakeQueueTargetsAfterDrive = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.equal(
      wakeQueueTargetsAfterDrive.some((dialogId) => dialogId.selfId === root.id.selfId),
      false,
      'stale open generation recovery cleanup should remove the root Wake Queue entry',
    );
  });

  console.log('recovery open-generation-recovery-stale-clears-on-backend-loop: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`recovery open-generation-recovery-stale-clears-on-backend-loop: FAIL\n${message}`);
  process.exit(1);
});
