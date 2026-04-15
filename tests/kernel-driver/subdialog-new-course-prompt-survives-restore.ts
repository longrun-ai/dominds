import assert from 'node:assert/strict';

import { DialogID } from '../../main/dialog';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { formatTellaskResponseContent } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  listTellaskResultContents,
  waitFor,
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
    const language = getWorkLanguage();
    const tellaskContent = 'Restore-safe assignment after clear mind.';
    const callId = 'call-restore-safe-clear-mind';
    const replyContent = 'Recovered reply after restore.';

    const subdialog = await root.createSubDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId,
      sessionSlug: 'restore-safe-session',
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
        sessionSlug: 'restore-safe-session',
      },
    ]);

    await subdialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );

    const latestBeforeRestore = await DialogPersistence.loadDialogLatest(subdialog.id, 'running');
    assert.ok(latestBeforeRestore, 'subdialog latest.yaml should exist before restore');
    assert.equal(
      latestBeforeRestore.pendingCourseStartPrompt?.tellaskReplyDirective?.targetCallId,
      callId,
      'latest.yaml should durably remember the rebound reply target before restore',
    );
    assert.equal(
      latestBeforeRestore.needsDrive,
      true,
      'startNewCourse should keep needsDrive true while the new-course prompt is pending',
    );
    assert.deepEqual(
      latestBeforeRestore.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_course_start' },
        continueEnabled: true,
      },
      'startNewCourse should persist a stopped/resumable state for the durable pending prompt',
    );
    assert.deepEqual(
      latestBeforeRestore.executionMarker,
      {
        kind: 'interrupted',
        reason: { kind: 'pending_course_start' },
      },
      'startNewCourse should persist an interrupted marker for the durable pending prompt',
    );

    const restoredRoot = await getOrRestoreRootDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected root dialog restore to succeed');
    const restoredSubdialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(subdialog.id.selfId, subdialog.id.rootId),
      'running',
    );
    assert.ok(restoredSubdialog, 'expected subdialog restore to succeed');

    const restoredQueuedPrompt = restoredSubdialog.peekUpNext();
    assert.ok(restoredQueuedPrompt, 'restore should rehydrate the pending new-course prompt');
    assert.equal(
      restoredQueuedPrompt.msgId,
      latestBeforeRestore.pendingCourseStartPrompt?.msgId,
      'restored queue should reuse the durable msgId so the round stays idempotent across restart',
    );
    assert.equal(
      restoredQueuedPrompt.tellaskReplyDirective?.targetCallId,
      callId,
      'restore should preserve the rebound reply directive on the queued prompt',
    );

    await writeMockDb(tmpRoot, [
      {
        message: restoredQueuedPrompt.prompt,
        role: 'user',
        response: 'Proceeding after restore.',
        funcCalls: [
          {
            id: 'reply-after-restore',
            name: 'replyTellask',
            arguments: {
              replyContent,
            },
          },
        ],
      },
    ]);

    await driveDialogStream(restoredSubdialog, undefined, true);
    await waitForAllDialogsUnlocked(restoredRoot, 3_000);

    const expectedDeliveredContent = formatTellaskResponseContent({
      callName: 'tellask',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent,
      responseBody: replyContent,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
      sessionSlug: 'restore-safe-session',
    });
    await waitFor(
      async () => listTellaskResultContents(restoredRoot.msgs).includes(expectedDeliveredContent),
      3_000,
      'restored rebound prompt reply to land on the caller dialog',
    );

    const latestAfterDrive = await DialogPersistence.loadDialogLatest(subdialog.id, 'running');
    assert.ok(latestAfterDrive, 'subdialog latest.yaml should still exist after restored drive');
    assert.equal(
      latestAfterDrive.pendingCourseStartPrompt,
      undefined,
      'pending new-course prompt should clear once the restored round is persisted',
    );
    assert.equal(
      latestAfterDrive.needsDrive,
      false,
      'subdialog latest.yaml should clear needsDrive once the restored pending course-start prompt is consumed',
    );
    assert.equal(
      latestAfterDrive.executionMarker,
      undefined,
      'subdialog latest.yaml should clear the pending-course-start interruption marker after drive resumes',
    );

    const courseTwoEvents = await DialogPersistence.loadCourseEvents(subdialog.id, 2, 'running');
    assert.ok(
      courseTwoEvents.some(
        (event) =>
          event.type === 'human_text_record' &&
          event.msgId === restoredQueuedPrompt.msgId &&
          event.tellaskReplyDirective?.targetCallId === callId,
      ),
      'restored drive should persist the durable new-course prompt exactly once into course two',
    );
  });

  console.log('kernel-driver subdialog-new-course-prompt-survives-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver subdialog-new-course-prompt-survives-restore: FAIL\n${message}`);
  process.exit(1);
});
