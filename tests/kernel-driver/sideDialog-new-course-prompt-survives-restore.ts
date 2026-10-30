import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import { DialogID, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeDriveOptions,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector(
  'dominds-sideDialog-new-course-prompt-survives-restore-',
);
async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const tellaskContent = 'Restore-safe assignment after clear mind.';
    const callId = 'call-restore-safe-clear-mind';
    const replyContent = 'Recovered reply after restore.';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'restore-safe-session',
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;
    await DialogPersistence.saveActiveCalleeDispatches(root.id, [
      {
        calleeDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        batchId: 'restore-safe-call-batch',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'B',
        sessionSlug: 'restore-safe-session',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );

    const latestBeforeRestore = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.ok(latestBeforeRestore, 'sideDialog latest.yaml should exist before restore');
    assert.equal(
      latestBeforeRestore.pendingRuntimePrompt?.tellaskReplyDirective?.targetCallId,
      callId,
      'latest.yaml should durably remember the rebound reply target before restore',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestBeforeRestore),
      true,
      'startNewCourse should keep pending next-step triggers true while the new-course prompt is pending',
    );
    assert.deepEqual(
      latestBeforeRestore.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_runtime_prompt' },
        continueEnabled: true,
      },
      'startNewCourse should persist a stopped/resumable state for the durable pending prompt',
    );
    assert.deepEqual(
      latestBeforeRestore.executionMarker,
      {
        kind: 'interrupted',
        reason: { kind: 'pending_runtime_prompt' },
      },
      'startNewCourse should persist an interrupted marker for the durable pending prompt',
    );

    globalDialogRegistry.unregister(root.id.rootId);
    const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected main dialog restore to succeed');
    assert.notEqual(restoredRoot, root, 'restore must construct a new root from durable state');
    const restoredSideDialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(sideDialog.id.selfId, sideDialog.id.rootId),
      'running',
    );
    assert.ok(restoredSideDialog instanceof SideDialog);
    assert.notEqual(
      restoredSideDialog,
      sideDialog,
      'restore must construct a new worker from durable state',
    );

    const restoredQueuedPrompt = restoredSideDialog.peekQueuedPrompt();
    assert.ok(restoredQueuedPrompt?.kind === 'new_course_runtime_sideDialog');
    assert.equal(
      restoredQueuedPrompt.msgId,
      latestBeforeRestore.pendingRuntimePrompt?.msgId,
      'restored queue should reuse the durable msgId so the round stays idempotent across restart',
    );
    assert.equal(
      restoredQueuedPrompt.tellaskReplyDirective.targetCallId,
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

    await driveDialogStream(restoredSideDialog, undefined, true, makeDriveOptions());
    await waitForAllDialogsUnlocked(restoredRoot, 3_000);

    const delivered = (
      await DialogPersistence.loadCourseEvents(
        restoredRoot.id,
        restoredRoot.currentCourse,
        restoredRoot.status,
      )
    )
      .filter((event) => event.type === 'tellask_result_record')
      .filter((event) => event.callId === callId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, 'completed');
    assert.ok(
      delivered[0].content.includes(replyContent),
      'canonical delivery preserves the controlled reply payload',
    );

    const latestAfterDrive = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.ok(latestAfterDrive, 'sideDialog latest.yaml should still exist after restored drive');
    assert.equal(
      latestAfterDrive.pendingRuntimePrompt,
      undefined,
      'pending new-course prompt should clear once the restored round is persisted',
    );
    assert.equal(
      latestAfterDrive.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
      false,
      'sideDialog latest.yaml should clear the queued prompt trigger once the restored pending runtime prompt is consumed',
    );
    assert.equal(
      latestAfterDrive.executionMarker,
      undefined,
      'sideDialog latest.yaml should clear the pending-runtime-prompt interruption marker after drive resumes',
    );

    evidence.record({
      id: 'restored-worker-new-course',
      scenario:
        'A new worker and root are reconstructed from disk with one durable unconsumed course-2 runtime prompt. The restored worker formally replies to the original call exactly once.',
      businessValue:
        'Restart must preserve the current task, continuation input identity and correct requester reply path.',
      context: {
        language: 'en',
        targetCallId: callId,
        requesterDialogId: restoredRoot.id.selfId,
        runtimePromptId: restoredQueuedPrompt.msgId,
        restoredCourse: restoredSideDialog.currentCourse,
      },
      reviewQuestions: [
        'Does the actual restored queued prompt explain continuation in the existing task rather than a fresh independent request?',
        'Is the requester reply responsibility clear and consistent with the preserved target and call?',
      ],
      actualText: restoredQueuedPrompt.prompt,
    });
    const courseTwoEvents = await DialogPersistence.loadCourseEvents(sideDialog.id, 2, 'running');
    assert.equal(
      courseTwoEvents.filter(
        (event) =>
          event.type === 'human_text_record' &&
          event.msgId === restoredQueuedPrompt.msgId &&
          event.tellaskReplyDirective?.targetCallId === callId,
      ).length,
      1,
      'restored drive should persist the durable new-course prompt exactly once into course two',
    );
  });

  await evidence.write();
  console.log('kernel-driver sideDialog-new-course-prompt-survives-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-new-course-prompt-survives-restore: FAIL\n${message}`);
  process.exit(1);
});
