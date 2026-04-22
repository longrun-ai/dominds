import assert from 'node:assert/strict';

import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { getRunControlCountsSnapshot } from '../../main/dialog-display-state';
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
    const followupInterjectPrompt = 'One more temporary question before we resume the main task.';
    const followupInterjectResponse = 'Handled the follow-up interruption locally as well.';
    const secondCycleInterjectPrompt =
      'Pause again after Continue; I still want one more temporary local answer.';
    const secondCycleInterjectResponse = 'Handled the second-cycle interruption locally too.';
    const finalResponse = 'Nested work is back, so I can now finalize the parent side dialog.';

    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      assignmentDirective.tellaskContent,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: assignmentDirective.targetCallId,
        collectiveTargets: ['pangu'],
      },
    );
    sideDialog.disableDiligencePush = true;

    const reassertionPrompt = await buildReplyObligationReassertionPrompt({
      dlg: sideDialog,
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
        message: followupInterjectPrompt,
        role: 'user',
        response: followupInterjectResponse,
      },
      {
        message: reassertionPrompt,
        role: 'user',
        response: finalResponse,
      },
      {
        message: secondCycleInterjectPrompt,
        role: 'user',
        response: secondCycleInterjectResponse,
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
      1,
      'interjection-paused dialogs should count as resumable even while blocker facts still remain',
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

    const latestAfterContinueWhileBlocked = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.deepEqual(
      latestAfterContinueWhileBlocked?.displayState,
      { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } },
      'Continue should exit the temporary interjection stop and restore the true blocked state when nested work is still pending',
    );
    const eventsAfterContinueWhileBlocked = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const surfacedRuntimeGuides = eventsAfterContinueWhileBlocked.filter(
      (
        event,
      ): event is Extract<
        (typeof eventsAfterContinueWhileBlocked)[number],
        { type: 'runtime_guide_record' }
      > => event.type === 'runtime_guide_record' && event.content === reassertionPrompt,
    );
    assert.equal(
      surfacedRuntimeGuides.length,
      1,
      'Continue while still blocked should immediately surface the reply reassertion guide exactly once',
    );
    assert.deepEqual(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      {
        reason: 'user_interjection_with_parked_original_task',
        directive: assignmentDirective,
        resumeGuideSurfaced: true,
      },
      'blocked Continue should mark the deferred reply reassertion as already surfaced',
    );
    const countsAfterContinueWhileBlocked = await getRunControlCountsSnapshot();
    assert.equal(
      countsAfterContinueWhileBlocked.resumable,
      0,
      'once Continue exits the temporary interjection pause, the dialog should no longer count as resumable while truly blocked',
    );

    await driveDialogStream(
      sideDialog,
      makeUserPrompt(secondCycleInterjectPrompt, 'sideDialog-user-interject-second-cycle', {
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
      'a new interjection after blocked Continue should suppress the restored reply obligation again instead of staying latched in surfaced state',
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

    const eventsAfterSecondContinueWhileBlocked = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const surfacedRuntimeGuidesAfterSecondContinue = eventsAfterSecondContinueWhileBlocked.filter(
      (
        event,
      ): event is Extract<
        (typeof eventsAfterSecondContinueWhileBlocked)[number],
        { type: 'runtime_guide_record' }
      > => event.type === 'runtime_guide_record' && event.content === reassertionPrompt,
    );
    assert.equal(
      surfacedRuntimeGuidesAfterSecondContinue.length,
      2,
      'each blocked Continue after a fresh interjection should surface a fresh reply reassertion guide',
    );
    assert.deepEqual(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      {
        reason: 'user_interjection_with_parked_original_task',
        directive: assignmentDirective,
        resumeGuideSurfaced: true,
      },
      'the second blocked Continue should mark the reassertion as surfaced again',
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
        source: 'kernel_driver_supply_response_parent_revive',
        reason: 'nested_sideDialog_resolved',
        suppressDiligencePush: true,
        noPromptSideDialogResumeEntitlement: {
          ownerDialogId: sideDialog.id.selfId,
          reason: 'resolved_pending_sideDialog_reply',
          sideDialogId: nestedSideDialog.id.selfId,
          callType: 'C',
          callId: 'pangu-to-nuwa-call',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      }),
    );
    await waitForAllDialogsUnlocked(root, 2_000);

    assert.equal(
      await DialogPersistence.getDeferredReplyReassertion(sideDialog.id, sideDialog.status),
      undefined,
      'deferred reply reassertion should be consumed on resume',
    );

    const events = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const repeatedReassertionPrompt = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
        event.type === 'human_text_record' &&
        event.msgId !== 'sideDialog-runtime-assignment' &&
        event.origin === 'runtime' &&
        event.content === reassertionPrompt,
    );
    assert.equal(
      repeatedReassertionPrompt,
      undefined,
      'actual resume should not synthesize a second runtime human prompt once blocked Continue already injected the guide into dialog history',
    );
    const surfacedGuidesAfterResume = events.filter(
      (event): event is Extract<(typeof events)[number], { type: 'runtime_guide_record' }> =>
        event.type === 'runtime_guide_record' && event.content === reassertionPrompt,
    );
    assert.equal(
      surfacedGuidesAfterResume.length,
      2,
      'actual resume should not emit any duplicate reassertion guide beyond the two blocked-Continue surfacings',
    );

    const pendingAtRoot = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(
      pendingAtRoot.length,
      0,
      'resumed reply should clear the parent pending side dialog',
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
