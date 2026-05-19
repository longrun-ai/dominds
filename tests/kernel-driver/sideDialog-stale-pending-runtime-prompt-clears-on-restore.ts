import assert from 'node:assert/strict';

import { DialogID } from '../../main/dialog';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const tellaskContent = 'Clear stale pending runtime prompt after restore.';
    const callId = 'call-stale-pending-runtime-prompt';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      sessionSlug: 'stale-pending-runtime-prompt',
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;
    await DialogPersistence.saveActiveCalleeDispatches(root.id, [
      {
        calleeDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        batchId: 'stale-pending-runtime-prompt-batch',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'B',
        sessionSlug: 'stale-pending-runtime-prompt',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );
    const queuedPrompt = sideDialog.peekUpNext();
    assert.ok(queuedPrompt, 'expected clear_mind to queue a pending runtime prompt');

    await writeMockDb(tmpRoot, [
      {
        message: queuedPrompt.prompt,
        role: 'user',
        response: 'Prompt persisted before simulated crash window.',
      },
    ]);
    await driveDialogStream(sideDialog, undefined, true);
    await waitForAllDialogsUnlocked(root, 3_000);

    await DialogPersistence.mutateDialogLatest(sideDialog.id, (previous) => ({
      kind: 'patch',
      patch: {
        nextStep: {
          nextSeq: 2,
          triggers: [
            {
              triggerId: `queued-prompt:${queuedPrompt.msgId}`,
              kind: 'queued_prompt',
              promptId: queuedPrompt.msgId,
              course: sideDialog.currentCourse,
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
        pendingRuntimePrompt: {
          content: queuedPrompt.prompt,
          msgId: queuedPrompt.msgId,
          grammar: 'markdown',
          origin: 'runtime',
          ...(queuedPrompt.userLanguageCode === undefined
            ? {}
            : { userLanguageCode: queuedPrompt.userLanguageCode }),
          ...(queuedPrompt.tellaskReplyDirective === undefined
            ? {}
            : { tellaskReplyDirective: queuedPrompt.tellaskReplyDirective }),
          ...(queuedPrompt.skipTaskdoc === undefined
            ? {}
            : { skipTaskdoc: queuedPrompt.skipTaskdoc }),
          ...(queuedPrompt.calleeDialogReplyTarget === undefined
            ? {}
            : { calleeDialogReplyTarget: queuedPrompt.calleeDialogReplyTarget }),
        },
        lastModified: previous.lastModified,
      },
    }));
    const latestBeforeRestore = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.ok(latestBeforeRestore, 'expected sideDialog latest before restore');
    await DialogPersistence.syncWakeQueueForDialogLatest(
      sideDialog.id,
      latestBeforeRestore,
      sideDialog.status,
    );
    const wakeQueueTargetsBeforeRestore = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.ok(
      wakeQueueTargetsBeforeRestore.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'test precondition: stale pending runtime prompt should be represented in root Wake Queue before restore',
    );

    const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected main dialog restore to succeed');
    const restoredSideDialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(sideDialog.id.selfId, sideDialog.id.rootId),
      'running',
    );
    assert.ok(restoredSideDialog, 'expected sideDialog restore to succeed');
    assert.equal(
      restoredSideDialog.peekUpNext(),
      undefined,
      'restore should not requeue a stale runtime prompt that is already persisted in course events',
    );

    const latestAfterRestore = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.equal(
      latestAfterRestore?.pendingRuntimePrompt,
      undefined,
      'restore should clear the stale pending runtime prompt from latest.yaml',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfterRestore),
      false,
      'restore should clear stale pending next-step triggers when the pending runtime prompt is already persisted',
    );
    assert.equal(
      latestAfterRestore?.executionMarker,
      undefined,
      'restore should clear the stale pending-runtime-prompt interruption marker as well',
    );
    assert.deepEqual(
      latestAfterRestore?.displayState,
      { kind: 'idle_waiting_user' },
      'restore should clear the stale stopped projection once the pending prompt is already persisted',
    );
    const wakeQueueTargetsAfterRestore = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.equal(
      wakeQueueTargetsAfterRestore.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      false,
      'restore should remove the stale pending runtime prompt from the root Wake Queue',
    );
  });

  console.log('kernel-driver sideDialog-stale-pending-runtime-prompt-clears-on-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-stale-pending-runtime-prompt-clears-on-restore: FAIL\n${message}`,
  );
  process.exit(1);
});
