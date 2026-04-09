import assert from 'node:assert/strict';

import { toCallingCourseNumber } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { buildReplyObligationReassertionPrompt } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
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
    const finalResponse = 'Nested work is back, so I can now finalize the parent sideline.';

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
    assert.match(reassertionPrompt, /@tester's 【Fresh Tellask】 is still waiting for your reply/u);
    assert.match(reassertionPrompt, /call `replyTellaskSessionless` to deliver it/u);
    assert.match(reassertionPrompt, /not asking you to reply immediately/u);

    await writeMockDb(process.cwd(), [
      {
        message: interjectPrompt,
        role: 'user',
        response: interjectResponse,
      },
      {
        message: reassertionPrompt,
        role: 'user',
        response: finalResponse,
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
      makeUserPrompt(interjectPrompt, 'subdialog-user-interject-before-resume', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    const deferredAfterInterjection = await DialogPersistence.getDeferredReplyReassertion(
      subdialog.id,
      subdialog.status,
    );
    assert.deepEqual(
      deferredAfterInterjection,
      {
        reason: 'user_interjection_while_pending_subdialog',
        directive: assignmentDirective,
      },
      'user interjection while nested subdialog is pending should arm deferred reply reassertion',
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
        source: 'kernel_driver_supply_response_parent_revive',
        reason: 'nested_subdialog_resolved',
        suppressDiligencePush: true,
        noPromptSubdialogResumeEntitlement: {
          ownerDialogId: subdialog.id.selfId,
          reason: 'resolved_pending_subdialog_reply',
          subdialogId: nestedSubdialog.id.selfId,
          callType: 'C',
          callId: 'pangu-to-nuwa-call',
        },
      }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    assert.equal(
      await DialogPersistence.getDeferredReplyReassertion(subdialog.id, subdialog.status),
      undefined,
      'deferred reply reassertion should be consumed on resume',
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
    assert.ok(reassertionRecord, 'expected runtime reassertion prompt before resumed reply');
    assert.deepEqual(reassertionRecord?.tellaskReplyDirective, assignmentDirective);

    const pendingAtRoot = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(pendingAtRoot.length, 0, 'resumed reply should clear the parent pending sideline');
  });

  console.log(
    'kernel-driver subdialog-resume-after-user-interject-reasserts-reply-obligation: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver subdialog-resume-after-user-interject-reasserts-reply-obligation: FAIL\n' +
      message,
  );
  process.exit(1);
});
