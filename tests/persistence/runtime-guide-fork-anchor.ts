import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import type { RuntimeGuideRecord } from '@longrun-ai/kernel/types/storage';
import { DialogID } from '../../main/dialog';
import { forkMainDialogTreeAtGeneration } from '../../main/dialog-fork';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws } from '../kernel-driver/helpers';

async function markProceeding(dialogId: DialogID): Promise<void> {
  await DialogPersistence.mutateDialogLatest(dialogId, () => ({
    kind: 'patch',
    patch: { displayState: { kind: 'proceeding' } },
  }));
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
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
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
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

    await root.notifyGeneratingFinish();
    await root.notifyGeneratingStart('root-g3');
    await DialogPersistence.persistRuntimeGuide(
      sideDialog,
      'future-guide-data',
      sideDialog.activeGenSeq,
    );
    const beforeFork = await DialogPersistence.readCourseEvents(sideDialog.id, 1, 'running');
    assert.equal(beforeFork.filter((event) => event.type === 'runtime_guide_record').length, 2);
    const forked = await forkMainDialogTreeAtGeneration({
      sourceRootId: root.id.selfId,
      sourceStatus: 'running',
      course: 1,
      genseq: 2,
    });
    const forkedSideId = new DialogID(sideDialog.id.selfId, forked.rootId);
    const forkedSideEvents = await DialogPersistence.readCourseEvents(forkedSideId, 1, 'running');
    assert.equal(
      forkedSideEvents.filter((event) => event.type === 'runtime_guide_record').length,
      1,
    );
    assert.equal(
      forkedSideEvents.some(
        (event) =>
          event.type === 'runtime_guide_record' &&
          event.content === 'runtime guide that must stay forkable',
      ),
      true,
      'fresh side dialog runtime guide records must survive fork filtering',
    );
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
