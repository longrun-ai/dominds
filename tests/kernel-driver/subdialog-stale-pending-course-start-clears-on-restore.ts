import assert from 'node:assert/strict';

import { DialogID } from '../../main/dialog';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;
    const tellaskContent = 'Clear stale pending course-start prompt after restore.';
    const callId = 'call-stale-pending-course-start';

    const subdialog = await root.createSubDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId,
      sessionSlug: 'stale-pending-course-start',
      collectiveTargets: ['pangu'],
    });
    subdialog.disableDiligencePush = true;
    await DialogPersistence.savePendingSubdialogs(root.id, [
      {
        subdialogId: subdialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callingCourse: 1,
        callType: 'B',
        sessionSlug: 'stale-pending-course-start',
      },
    ]);

    await subdialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );
    const queuedPrompt = subdialog.peekUpNext();
    assert.ok(queuedPrompt, 'expected clear_mind to queue a pending course-start prompt');

    await writeMockDb(tmpRoot, [
      {
        message: queuedPrompt.prompt,
        role: 'user',
        response: 'Prompt persisted before simulated crash window.',
      },
    ]);
    await driveDialogStream(subdialog, undefined, true);
    await waitForAllDialogsUnlocked(root, 3_000);

    await DialogPersistence.mutateDialogLatest(subdialog.id, (previous) => ({
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
          ...(queuedPrompt.subdialogReplyTarget === undefined
            ? {}
            : { subdialogReplyTarget: queuedPrompt.subdialogReplyTarget }),
        },
        lastModified: previous.lastModified,
      },
    }));

    const restoredRoot = await getOrRestoreRootDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected root dialog restore to succeed');
    const restoredSubdialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(subdialog.id.selfId, subdialog.id.rootId),
      'running',
    );
    assert.ok(restoredSubdialog, 'expected subdialog restore to succeed');
    assert.equal(
      restoredSubdialog.peekUpNext(),
      undefined,
      'restore should not requeue a stale course-start prompt that is already persisted in course events',
    );

    const latestAfterRestore = await DialogPersistence.loadDialogLatest(subdialog.id, 'running');
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
  });

  console.log('kernel-driver subdialog-stale-pending-course-start-clears-on-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver subdialog-stale-pending-course-start-clears-on-restore: FAIL\n${message}`,
  );
  process.exit(1);
});
