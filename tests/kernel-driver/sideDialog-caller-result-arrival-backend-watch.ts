import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function lastSideDialogAssistantSaying(dlg: SideDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i -= 1) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      extraMembers: ['fullstack', 'mentor'],
    });
    await writeMockDb(tmpRoot, [
      {
        role: 'tool',
        message:
          'Error: there is no longer a pending inter-dialog reply obligation for this dialog (it may already be resolved or no longer valid).\n\nDo not call `replyTellask` again; continue the current local conversation instead.',
        contextContains: ['mentor finished the nested task'],
        response: 'Caller resumed from watched side-dialog result arrival.',
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    const caller = await root.createSideDialog(
      'fullstack',
      ['@fullstack'],
      'Please coordinate the nested work.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-to-caller',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'watched-caller',
        collectiveTargets: ['fullstack'],
      },
    );
    const callee = await caller.createSideDialog(
      'mentor',
      ['@mentor'],
      'Please finish the nested task.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'fullstack',
        askerDialogId: caller.id.selfId,
        callId: 'caller-to-callee',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
        collectiveTargets: ['mentor'],
      },
    );

    await DialogPersistence.appendActiveCalleeDispatch(caller.id, {
      batchId: 'dispatch:test:caller:c1:g2',
      calleeDialogId: callee.id.selfId,
      callId: 'caller-to-callee',
      callName: 'tellaskSessionless',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(2),
      callType: 'C',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@mentor'],
      targetAgentId: 'mentor',
      tellaskContent: 'Please finish the nested task.',
    });
    await DialogPersistence.mutateDialogLatest(caller.id, () => ({
      kind: 'patch',
      patch: {
        sideDialogFinalResponse: {
          callId: 'root-to-caller',
          responseCourse: 1,
          responseGenseq: 1,
          askerDialogId: root.id.selfId,
          askerCourse: 1,
        },
      },
    }));

    await supplyResponseToAskerDialog({
      callerDialog: caller,
      sideDialogId: callee.id,
      responseText: 'mentor finished the nested task',
      callType: 'C',
      callId: 'caller-to-callee',
      calleeResponseRef: { course: 1, genseq: 1 },
      scheduleDrive: () => {},
    });

    const callerLatestAfterReply = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      hasPendingNextStepTriggers(callerLatestAfterReply),
      true,
      'side-dialog caller should retain durable result_arrival trigger when direct schedule is lost',
    );

    const watched = await DialogPersistence.loadDriveWatchedDialogIds(root.id, root.status);
    assert.ok(
      watched.some((dialogId) => dialogId.selfId === caller.id.selfId),
      'side-dialog caller with durable result_arrival must stay watched even after a final response anchor',
    );

    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);

    assert.equal(
      lastSideDialogAssistantSaying(caller),
      'Caller resumed from watched side-dialog result arrival.',
    );
    const callerLatestAfterDrive = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      hasPendingNextStepTriggers(callerLatestAfterDrive),
      false,
      'backend watch revive should consume side-dialog caller result_arrival trigger',
    );

    const callerEventsAfterDrive = await DialogPersistence.loadCourseEvents(
      caller.id,
      caller.currentCourse,
      caller.status,
    );
    const genStartCountAfterDrive = callerEventsAfterDrive.filter(
      (event) => event.type === 'gen_start_record',
    ).length;

    await driveDialogStream(caller, undefined, true, {
      source: 'kernel_driver_supply_response_caller_revive',
      reason: 'late_direct_revive_after_backend_watch_consumed_result_arrival',
      suppressDiligencePush: true,
      noPromptSideDialogResumeEntitlement: {
        callerDialogId: caller.id.selfId,
        reason: 'resolved_pending_sideDialog_reply',
        sideDialogId: callee.id.selfId,
        callType: 'C',
        callId: 'caller-to-callee',
        callSiteCourse: 1,
        callSiteGenseq: 2,
        batchId: 'dispatch:test:caller:c1:g2',
        resolvedCallIds: ['caller-to-callee'],
        triggerCallId: 'caller-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const callerEventsAfterLateDirectRevive = await DialogPersistence.loadCourseEvents(
      caller.id,
      caller.currentCourse,
      caller.status,
    );
    const genStartCountAfterLateDirectRevive = callerEventsAfterLateDirectRevive.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    assert.equal(
      genStartCountAfterLateDirectRevive,
      genStartCountAfterDrive,
      'late direct caller revive after consumed result_arrival must not open an empty generation',
    );

    const callerWithoutFinalResponse = await root.createSideDialog(
      'fullstack',
      ['@fullstack'],
      'Please coordinate another nested work item.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-to-caller-without-final',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(3),
        sessionSlug: 'watched-caller-without-final',
        collectiveTargets: ['fullstack'],
      },
    );
    const calleeWithoutFinalResponse = await callerWithoutFinalResponse.createSideDialog(
      'mentor',
      ['@mentor'],
      'Please finish the other nested task.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'fullstack',
        askerDialogId: callerWithoutFinalResponse.id.selfId,
        callId: 'caller-without-final-to-callee',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(4),
        collectiveTargets: ['mentor'],
      },
    );

    await DialogPersistence.appendActiveCalleeDispatch(callerWithoutFinalResponse.id, {
      batchId: 'dispatch:test:caller-without-final:c1:g4',
      calleeDialogId: calleeWithoutFinalResponse.id.selfId,
      callId: 'caller-without-final-to-callee',
      callName: 'tellaskSessionless',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(4),
      callType: 'C',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@mentor'],
      targetAgentId: 'mentor',
      tellaskContent: 'Please finish the other nested task.',
    });
    await supplyResponseToAskerDialog({
      callerDialog: callerWithoutFinalResponse,
      sideDialogId: calleeWithoutFinalResponse.id,
      responseText: 'mentor finished the other nested task',
      callType: 'C',
      callId: 'caller-without-final-to-callee',
      calleeResponseRef: { course: 1, genseq: 1 },
      scheduleDrive: () => {},
    });
    await DialogPersistence.removeNextStepTriggers(
      callerWithoutFinalResponse.id,
      (trigger) => trigger.kind === 'result_arrival',
      callerWithoutFinalResponse.status,
    );

    const callerWithoutFinalEventsBeforeLateRevive = await DialogPersistence.loadCourseEvents(
      callerWithoutFinalResponse.id,
      callerWithoutFinalResponse.currentCourse,
      callerWithoutFinalResponse.status,
    );
    const genStartCountBeforeLateRevive = callerWithoutFinalEventsBeforeLateRevive.filter(
      (event) => event.type === 'gen_start_record',
    ).length;

    await driveDialogStream(callerWithoutFinalResponse, undefined, true, {
      source: 'kernel_driver_supply_response_caller_revive',
      reason: 'late_direct_revive_after_consumed_result_arrival_without_final_response',
      suppressDiligencePush: true,
      noPromptSideDialogResumeEntitlement: {
        callerDialogId: callerWithoutFinalResponse.id.selfId,
        reason: 'resolved_pending_sideDialog_reply',
        sideDialogId: calleeWithoutFinalResponse.id.selfId,
        callType: 'C',
        callId: 'caller-without-final-to-callee',
        callSiteCourse: 1,
        callSiteGenseq: 4,
        batchId: 'dispatch:test:caller-without-final:c1:g4',
        resolvedCallIds: ['caller-without-final-to-callee'],
        triggerCallId: 'caller-without-final-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const callerWithoutFinalEventsAfterLateRevive = await DialogPersistence.loadCourseEvents(
      callerWithoutFinalResponse.id,
      callerWithoutFinalResponse.currentCourse,
      callerWithoutFinalResponse.status,
    );
    const genStartCountAfterLateReviveWithoutFinal = callerWithoutFinalEventsAfterLateRevive.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    assert.equal(
      genStartCountAfterLateReviveWithoutFinal,
      genStartCountBeforeLateRevive,
      'late direct caller revive after consumed result_arrival and no final response must not open an empty generation',
    );
  });

  console.log('kernel-driver sideDialog-caller-result-arrival-backend-watch: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-caller-result-arrival-backend-watch: FAIL\n${message}`);
  process.exit(1);
});
