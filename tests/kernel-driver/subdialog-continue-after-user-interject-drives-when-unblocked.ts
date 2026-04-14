import assert from 'node:assert/strict';

import { toCallingCourseNumber } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { buildReplyObligationReassertionPrompt } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { isUserInterjectionPauseStopReason } from '../../main/runtime/interjection-pause-stop';
import { setWorkLanguage } from '../../main/runtime/work-language';
import {
  createRootDialog,
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

    const assignmentDirective = {
      expectedReplyCallName: 'replyTellaskSessionless' as const,
      targetCallId: 'root-to-pangu-call',
      tellaskContent: 'Finish the parent sideline after the nested work returns.',
    };
    const interjectPrompt = 'Handle this local interruption first while nuwa is still pending.';
    const interjectResponse = 'Handled the local interruption only.';
    const finalResponse = 'Nested work is back, and I am now replying upstream.';

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    const subdialog = await root.createSubDialog(
      'pangu',
      ['@pangu'],
      assignmentDirective.tellaskContent,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        callerDialogId: root.id.selfId,
        callId: assignmentDirective.targetCallId,
        collectiveTargets: ['pangu'],
      },
    );
    subdialog.disableDiligencePush = true;

    const reassertionPrompt = await buildReplyObligationReassertionPrompt({
      dlg: subdialog,
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
        response: 'Replying upstream now.',
        funcCalls: [
          {
            id: 'call-subdialog-reply-sessionless-after-continue',
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
        response: 'The upstream reply has now been delivered.',
      },
    ]);

    await DialogPersistence.appendPendingSubdialog(root.id, {
      subdialogId: subdialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: assignmentDirective.tellaskContent,
      targetAgentId: 'pangu',
      callId: assignmentDirective.targetCallId,
      callingCourse: toCallingCourseNumber(1),
      callType: 'C',
    });

    const nestedSubdialog = await subdialog.createSubDialog(
      'nuwa',
      ['@nuwa'],
      'Wait for nested sideline work to return.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'pangu',
        callerDialogId: subdialog.id.selfId,
        callId: 'pangu-to-nuwa-call',
        collectiveTargets: ['nuwa'],
      },
    );
    await DialogPersistence.appendPendingSubdialog(subdialog.id, {
      subdialogId: nestedSubdialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@nuwa'],
      tellaskContent: 'Wait for nested sideline work to return.',
      targetAgentId: 'nuwa',
      callId: 'pangu-to-nuwa-call',
      callType: 'C',
    });

    await subdialog.persistUserMessage(
      'Initial parent sideline assignment.',
      'subdialog-runtime-assignment',
      'markdown',
      'runtime',
      'en',
      undefined,
      assignmentDirective,
    );

    await driveDialogStream(
      subdialog,
      makeUserPrompt(interjectPrompt, 'subdialog-user-interject-before-direct-continue', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    const latestAfterInterjection = await DialogPersistence.loadDialogLatest(
      subdialog.id,
      subdialog.status,
    );
    assert.equal(latestAfterInterjection?.displayState?.kind, 'stopped');
    assert.ok(
      latestAfterInterjection?.displayState?.kind === 'stopped' &&
        isUserInterjectionPauseStopReason(latestAfterInterjection.displayState.reason),
      'interjection should park the original task in the dedicated stopped state',
    );

    await DialogPersistence.removePendingSubdialog(
      subdialog.id,
      nestedSubdialog.id.selfId,
      undefined,
      subdialog.status,
    );

    await driveDialogStream(
      subdialog,
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
      await DialogPersistence.getDeferredReplyReassertion(subdialog.id, subdialog.status),
      undefined,
      'manual Continue should consume the deferred reply reassertion when the dialog is unblocked',
    );

    const latestAfterContinue = await DialogPersistence.loadDialogLatest(
      subdialog.id,
      subdialog.status,
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
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    const reassertionRecord = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.msgId !== 'subdialog-runtime-assignment' &&
        event.origin === 'runtime' &&
        event.content === reassertionPrompt,
    );
    assert.ok(reassertionRecord, 'expected runtime reply reassertion prompt during resumed drive');

    const pendingAtRoot = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(
      pendingAtRoot.length,
      0,
      'manual Continue should let the subdialog finish the upstream reply immediately once unblocked',
    );
  });

  console.log('kernel-driver subdialog-continue-after-user-interject-drives-when-unblocked: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver subdialog-continue-after-user-interject-drives-when-unblocked: FAIL\n' + message,
  );
  process.exit(1);
});
