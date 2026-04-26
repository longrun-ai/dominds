import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RuntimeGuideRecord } from '@longrun-ai/kernel/types/storage';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID } from '../../main/dialog';
import { forkMainDialogTreeAtGeneration } from '../../main/dialog-fork';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-runtime-guide-anchor-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function markProceeding(dialogId: DialogID): Promise<void> {
  await DialogPersistence.mutateDialogLatest(dialogId, () => ({
    kind: 'patch',
    patch: { displayState: { kind: 'proceeding' } },
  }));
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    installRecordingGlobalDialogEventBroadcaster({
      label: 'tests/runtime-guide-fork-anchor',
    });
    try {
      const root = await createMainDialog();

      await markProceeding(root.id);
      await root.notifyGeneratingStart('root-g1');
      const sideDialog = await root.createSideDialog(
        'tester',
        ['@tester'],
        'persist a runtime guide in the side dialog',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: root.id.selfId,
          callId: 'call-runtime-guide-anchor',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );
      await markProceeding(sideDialog.id);
      await sideDialog.notifyGeneratingStart('side-g1');
      await DialogPersistence.persistRuntimeGuide(
        sideDialog,
        'runtime guide that must stay forkable',
        sideDialog.activeGenSeq,
      );

      const sideEvents = await DialogPersistence.readCourseEvents(sideDialog.id, 1, 'running');
      const runtimeGuide = sideEvents.find(
        (event): event is RuntimeGuideRecord => event.type === 'runtime_guide_record',
      );
      assert.ok(runtimeGuide, 'side dialog runtime guide record must be persisted');
      assert.equal(runtimeGuide.rootCourse, 1);
      assert.equal(runtimeGuide.rootGenseq, 1);

      await root.notifyGeneratingFinish();
      await root.notifyGeneratingStart('root-g2');

      const forked = await forkMainDialogTreeAtGeneration({
        sourceRootId: root.id.selfId,
        sourceStatus: 'running',
        course: 1,
        genseq: 2,
      });
      const forkedSideId = new DialogID(sideDialog.id.selfId, forked.rootId);
      const forkedSideEvents = await DialogPersistence.readCourseEvents(forkedSideId, 1, 'running');
      assert.equal(
        forkedSideEvents.some(
          (event) =>
            event.type === 'runtime_guide_record' &&
            event.content === 'runtime guide that must stay forkable',
        ),
        true,
        'fresh side dialog runtime guide records must survive fork filtering',
      );
    } finally {
      clearInstalledGlobalDialogEventBroadcaster();
    }
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
