import assert from 'node:assert/strict';

import { DialogID } from '../../main/dialog';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
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
    const tellaskContent = 'Clear stale pending course-start prompt after restore.';
    const callId = 'call-stale-pending-course-start';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId,
      sessionSlug: 'stale-pending-course-start',
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;
    await DialogPersistence.savePendingSideDialogs(root.id, [
      {
        sideDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callingCourse: 1,
        callingGenseq: 1,
        callType: 'B',
        sessionSlug: 'stale-pending-course-start',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );
    const queuedPrompt = sideDialog.peekUpNext();
    assert.ok(queuedPrompt, 'expected clear_mind to queue a pending course-start prompt');

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
        needsDrive: true,
        pendingCourseStartPrompt: {
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
          ...(queuedPrompt.sideDialogReplyTarget === undefined
            ? {}
            : { sideDialogReplyTarget: queuedPrompt.sideDialogReplyTarget }),
        },
        lastModified: previous.lastModified,
      },
    }));

    const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected root dialog restore to succeed');
    const restoredSideDialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(sideDialog.id.selfId, sideDialog.id.rootId),
      'running',
    );
    assert.ok(restoredSideDialog, 'expected sideDialog restore to succeed');
    assert.equal(
      restoredSideDialog.peekUpNext(),
      undefined,
      'restore should not requeue a stale course-start prompt that is already persisted in course events',
    );

    const latestAfterRestore = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.equal(
      latestAfterRestore?.pendingCourseStartPrompt,
      undefined,
      'restore should clear the stale pending course-start prompt from latest.yaml',
    );
    assert.equal(
      latestAfterRestore?.needsDrive,
      false,
      'restore should clear stale needsDrive when the pending course-start prompt is already persisted',
    );
    assert.equal(
      latestAfterRestore?.executionMarker,
      undefined,
      'restore should clear the stale pending-course-start interruption marker as well',
    );
    assert.deepEqual(
      latestAfterRestore?.displayState,
      { kind: 'idle_waiting_user' },
      'restore should clear the stale stopped projection once the pending prompt is already persisted',
    );
  });

  console.log('kernel-driver sideDialog-stale-pending-course-start-clears-on-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-stale-pending-course-start-clears-on-restore: FAIL\n${message}`,
  );
  process.exit(1);
});
