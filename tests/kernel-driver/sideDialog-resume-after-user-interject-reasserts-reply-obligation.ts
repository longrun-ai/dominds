import assert from 'node:assert/strict';

import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import {
  getRunControlCountsSnapshot,
  refreshRunControlProjectionFromPersistenceFacts,
  setDialogDisplayState,
} from '../../main/dialog-display-state';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { buildReplyObligationReassertionPrompt } from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { isUserInterjectionPauseStopReason } from '../../main/runtime/interjection-pause-stop';
import { buildReplyToolReminderText } from '../../main/runtime/reply-prompt-copy';
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
    const followupInterjectPrompt = 'One more temporary question before we resume the main task.';
    const followupInterjectResponse = 'Handled the follow-up interruption locally as well.';
    const fallbackResponse = 'Nested work is back, and I am still sending a plain final answer.';

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
    const replyReminderPrompt = buildReplyToolReminderText({
      language: 'en',
      directive: assignmentDirective,
      replyTargetAgentId: 'tester',
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
        message: followupInterjectPrompt,
        role: 'user',
        response: followupInterjectResponse,
      },
      {
        message: reassertionPrompt,
        role: 'user',
        response: 'Nested work is back, so I can now finalize the parent side dialog.',
      },
      {
        message: replyReminderPrompt,
        role: 'user',
        response: fallbackResponse,
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
      makeUserPrompt(interjectPrompt, 'sideDialog-user-interject-before-resume', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    const deferredAfterInterjection = await DialogPersistence.getDeferredReplyReassertion(
      sideDialog.id,
      sideDialog.status,
    );
    assert.deepEqual(
      deferredAfterInterjection,
      {
        reason: 'user_interjection_with_parked_original_task',
        directive: assignmentDirective,
      },
      'user interjection while nested sideDialog is pending should arm deferred reply reassertion',
    );
    const latestAfterInterjection = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      latestAfterInterjection?.displayState?.kind,
      'stopped',
      'local interjection reply should stop the original task until the user explicitly continues',
    );
    assert.equal(
      latestAfterInterjection?.displayState?.continueEnabled,
      true,
      'interjection stop should expose Continue in the UI',
    );
    assert.ok(
      latestAfterInterjection?.displayState?.kind === 'stopped' &&
        isUserInterjectionPauseStopReason(latestAfterInterjection.displayState.reason),
      'interjection stop should use the dedicated paused-original-task stop reason',
    );
    const countsWhileInterjectionPaused = await getRunControlCountsSnapshot();
    assert.equal(
      countsWhileInterjectionPaused.resumable,
      2,
      'interjection-paused parent and pending-reply nested sideDialog should both count as resumable',
    );
    await setDialogDisplayState(sideDialog.id, { kind: 'idle_waiting_user' });
    const latestAfterAttemptedIdleWhileNestedPending = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.deepEqual(
      latestAfterAttemptedIdleWhileNestedPending?.displayState,
      { kind: 'stopped', reason: { kind: 'pending_reply_obligation' }, continueEnabled: true },
      'active reply obligation should pause the sideDialog while nested pending work remains background state',
    );
    const refreshedWhileNestedPending = await refreshRunControlProjectionFromPersistenceFacts(
      sideDialog.id,
      'pending_sideDialogs_changed',
    );
    assert.deepEqual(
      refreshedWhileNestedPending?.displayState,
      { kind: 'stopped', reason: { kind: 'pending_reply_obligation' }, continueEnabled: true },
      'run-control refresh should keep pending_reply_obligation ahead of background nested work',
    );

    await driveDialogStream(
      sideDialog,
      makeUserPrompt(followupInterjectPrompt, 'sideDialog-user-interject-while-stopped', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({
        suppressDiligencePush: true,
      }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);
    assert.deepEqual(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      {
        reason: 'user_interjection_with_parked_original_task',
        directive: assignmentDirective,
      },
      'new user messages while stopped should keep chatting locally instead of resuming the parent task',
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

    const latestAfterContinue = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    const eventsAfterContinue = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const consumedReassertionPrompts = eventsAfterContinue.filter(
      (
        event,
      ): event is Extract<(typeof eventsAfterContinue)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.origin === 'runtime' &&
        event.content === reassertionPrompt,
    );
    assert.equal(
      consumedReassertionPrompts.length,
      1,
      'Continue should consume one reassertion runtime prompt',
    );
    assert.deepEqual(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      undefined,
      'direct Continue should consume the deferred reply reassertion once it is delivered as a runtime prompt',
    );

    assert.equal(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      undefined,
      'deferred reply reassertion should be consumed on direct Continue',
    );

    const events = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const reassertionPromptsAfterContinue = events.filter(
      (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.msgId !== 'sideDialog-runtime-assignment' &&
        event.origin === 'runtime' &&
        event.content === reassertionPrompt,
    );
    assert.equal(
      reassertionPromptsAfterContinue.length,
      1,
      'later processing should not synthesize another reassertion prompt after Continue already consumed one',
    );
    const surfacedGuidesAfterResume = events.filter(
      (event): event is Extract<(typeof events)[number], { type: 'runtime_guide_record' }> =>
        event.type === 'runtime_guide_record' && event.content === reassertionPrompt,
    );
    assert.equal(
      surfacedGuidesAfterResume.length,
      0,
      'direct Continue should use runtime prompts rather than blocked-Continue guide surfacing',
    );

    const replyReminderEvent = events.find(
      (event) =>
        event.type === 'human_text_record' &&
        event.origin === 'runtime' &&
        event.content === replyReminderPrompt,
    );
    const replyReminderIndex =
      replyReminderEvent === undefined ? -1 : events.indexOf(replyReminderEvent);
    assert.ok(
      replyReminderIndex >= 0,
      'first plain answer after direct Continue should queue and consume one replyTellask reminder before fallback',
    );
    assert.deepEqual(
      replyReminderEvent?.tellaskReplyDirective,
      assignmentDirective,
      'replyTellask reminder prompt must persist the active reply directive for the reminder round',
    );
    const fallbackWordsRecord = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'agent_words_record' }> =>
        event.type === 'agent_words_record' && event.content === fallbackResponse,
    );
    assert.ok(fallbackWordsRecord, 'reminder round should receive the second plain fallback body');
    const fallbackResolutionIndex = events.findIndex(
      (event) =>
        event.type === 'tellask_reply_resolution_record' &&
        event.replyCallName === 'replyTellaskSessionless' &&
        event.targetCallId === assignmentDirective.targetCallId,
    );
    assert.ok(fallbackResolutionIndex >= 0, 'second plain answer should trigger direct fallback');
    assert.ok(
      replyReminderIndex < fallbackResolutionIndex,
      'replyTellask reminder must be persisted before the direct fallback response anchor',
    );

    const pendingAtRoot = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(
      pendingAtRoot.length,
      0,
      'resumed reply should clear the parent pending side dialog',
    );
    const pendingAtSideDialog = await DialogPersistence.loadPendingSideDialogs(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      pendingAtSideDialog.length,
      1,
      'direct Continue should not consume the still-background nested side dialog',
    );
  });

  console.log(
    'kernel-driver sideDialog-resume-after-user-interject-reasserts-reply-obligation: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver sideDialog-resume-after-user-interject-reasserts-reply-obligation: FAIL\n' +
      message,
  );
  process.exit(1);
});
