import assert from 'node:assert/strict';

import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { buildReplyObligationReassertionPrompt } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { isUserInterjectionPauseStopReason } from '../../main/runtime/interjection-pause-stop';
import { setWorkLanguage } from '../../main/runtime/work-language';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async () => {
    setWorkLanguage('en');
    await writeStandardMinds(process.cwd(), {
      includePangu: true,
      extraMembers: ['nuwa'],
    });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    const assignmentDirective = {
      expectedReplyCallName: 'replyTellaskSessionless' as const,
      targetDialogId: root.id.selfId,
      targetCallId: 'root-to-pangu-call',
      tellaskContent: 'Finish the parent side dialog after the nested work returns.',
    };
    const interjectPrompt = 'Handle this local interruption first while nuwa is still pending.';
    const interjectResponse = 'Handled the local interruption only.';
    const finalResponse = 'Nested work is back, and I am now replying to the tellasker.';

    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      assignmentDirective.tellaskContent,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: assignmentDirective.targetCallId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    sideDialog.disableDiligencePush = true;

    const reassertionPrompt = await buildReplyObligationReassertionPrompt({
      dlg: sideDialog,
      directive: assignmentDirective,
      language: 'en',
    });
    await writeMockDb(process.cwd(), [
      {
        message: interjectPrompt,
        role: 'user',
        response: interjectResponse,
      },
      {
        message: reassertionPrompt,
        role: 'user',
        response: 'Replying to the tellasker now.',
        funcCalls: [
          {
            id: 'call-sideDialog-reply-sessionless-after-continue',
            name: 'replyTellaskSessionless',
            arguments: {
              replyContent: finalResponse,
            },
          },
        ],
      },
      {
        message: 'Reply delivered via `replyTellaskSessionless`.',
        role: 'tool',
        response: 'The tellasker reply has now been delivered.',
      },
    ]);

    await DialogPersistence.appendPendingSideDialog(root.id, {
      sideDialogId: sideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: assignmentDirective.tellaskContent,
      targetAgentId: 'pangu',
      callId: assignmentDirective.targetCallId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: 1,
      callType: 'C',
    });

    const nestedSideDialog = await sideDialog.createSideDialog(
      'nuwa',
      ['@nuwa'],
      'Wait for nested side dialog work to return.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'pangu',
        askerDialogId: sideDialog.id.selfId,
        callId: 'pangu-to-nuwa-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['nuwa'],
      },
    );
    await DialogPersistence.appendPendingSideDialog(sideDialog.id, {
      sideDialogId: nestedSideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@nuwa'],
      tellaskContent: 'Wait for nested side dialog work to return.',
      targetAgentId: 'nuwa',
      callId: 'pangu-to-nuwa-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    });

    await sideDialog.persistUserMessage(
      'Initial parent side dialog assignment.',
      'sideDialog-runtime-assignment',
      'markdown',
      'runtime',
      'en',
      undefined,
      assignmentDirective,
    );

    await driveDialogStream(
      sideDialog,
      makeUserPrompt(interjectPrompt, 'sideDialog-user-interject-before-direct-continue', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    const latestAfterInterjection = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(latestAfterInterjection?.displayState?.kind, 'stopped');
    assert.ok(
      latestAfterInterjection?.displayState?.kind === 'stopped' &&
        isUserInterjectionPauseStopReason(latestAfterInterjection.displayState.reason),
      'interjection should park the original task in the dedicated stopped state',
    );

    await DialogPersistence.removePendingSideDialog(
      sideDialog.id,
      nestedSideDialog.id.selfId,
      undefined,
      sideDialog.status,
    );

    await driveDialogStream(
      sideDialog,
      undefined,
      true,
      makeDriveOptions({
        allowResumeFromInterrupted: true,
        source: 'ws_resume_dialog',
        reason: 'resume_dialog',
        suppressDiligencePush: true,
      }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    assert.equal(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      undefined,
      'manual Continue should consume the deferred reply reassertion when the dialog is unblocked',
    );

    const latestAfterContinue = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.deepEqual(
      latestAfterContinue?.displayState,
      { kind: 'idle_waiting_user' },
      'manual Continue should drive through immediately instead of falling back to a blocked placeholder state',
    );
    assert.equal(
      latestAfterContinue?.executionMarker,
      undefined,
      'successful resumed drive should clear the interrupted marker',
    );

    const events = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const reassertionRecord = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.msgId !== 'sideDialog-runtime-assignment' &&
        event.origin === 'runtime' &&
        event.content === reassertionPrompt,
    );
    assert.ok(reassertionRecord, 'expected runtime reply reassertion prompt during resumed drive');

    const pendingAtRoot = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(
      pendingAtRoot.length,
      0,
      'manual Continue should let the sideDialog finish the tellasker reply immediately once unblocked',
    );
  });

  console.log('kernel-driver sideDialog-continue-after-user-interject-drives-when-unblocked: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver sideDialog-continue-after-user-interject-drives-when-unblocked: FAIL\n' +
      message,
  );
  process.exit(1);
});
