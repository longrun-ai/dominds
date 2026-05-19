import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { MainDialog, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import { formatTellaskResponseContent } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';
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

function lastMainAssistantSaying(dlg: MainDialog): string | null {
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
    const language = getWorkLanguage();
    const wakeQueueResultMessage = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: 'caller-to-callee',
      responderId: 'mentor',
      tellaskerId: 'fullstack',
      mentionList: ['@mentor'],
      tellaskContent: 'Please finish the nested task.',
      responseBody: 'mentor finished the nested task',
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    await writeMockDb(tmpRoot, [
      {
        role: 'tool',
        message: wakeQueueResultMessage,
        response: 'Caller resumed from Wake Queue side-dialog result arrival.',
      },
      {
        role: 'tool',
        message: formatTellaskResponseContent({
          callName: 'tellaskSessionless',
          callId: 'caller-without-final-to-callee',
          responderId: 'mentor',
          tellaskerId: 'fullstack',
          mentionList: ['@mentor'],
          tellaskContent: 'Please finish the other nested task.',
          responseBody: 'mentor finished the other nested task',
          status: 'completed',
          deliveryMode: 'reply_tool',
          language,
        }),
        response: 'Caller without final response resumed from active-callees result arrival.',
      },
      {
        role: 'tool',
        message: formatTellaskResponseContent({
          callName: 'tellaskSessionless',
          callId: 'root-to-main-callee',
          responderId: 'mentor',
          tellaskerId: 'tester',
          mentionList: ['@mentor'],
          tellaskContent: 'Please finish the mainline task.',
          responseBody: 'mentor finished the mainline task',
          status: 'completed',
          deliveryMode: 'reply_tool',
          language,
        }),
        response: 'Mainline resumed from Wake Queue result arrival.',
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
        sessionSlug: 'wake-queue-caller',
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

    const wakeQueueTargets = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.ok(
      wakeQueueTargets.some((dialogId) => dialogId.selfId === caller.id.selfId),
      'side-dialog caller with durable result_arrival must stay in Wake Queue even after a final response anchor',
    );

    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);

    assert.equal(
      lastSideDialogAssistantSaying(caller),
      'Caller resumed from Wake Queue side-dialog result arrival.',
    );
    const callerLatestAfterDrive = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      hasPendingNextStepTriggers(callerLatestAfterDrive),
      false,
      'backend wake queue should consume side-dialog caller result_arrival trigger',
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
      source: 'kernel_driver_business_continuation',
      reason: 'late_direct_continuation_after_backend_wake_queue_consumed_result_arrival',
      suppressDiligencePush: true,
      businessContinuation: {
        kind: 'requested_work_reply',
        callerDialogId: caller.id.selfId,
        batchId: 'dispatch:test:caller:c1:g2',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
        sideDialogId: callee.id.selfId,
        callType: 'C',
        callId: 'caller-to-callee',
        resolvedCallIds: ['caller-to-callee'],
        triggerCallId: 'caller-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const callerEventsAfterLateDirectContinuation = await DialogPersistence.loadCourseEvents(
      caller.id,
      caller.currentCourse,
      caller.status,
    );
    const genStartCountAfterLateDirectContinuation = callerEventsAfterLateDirectContinuation.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    assert.equal(
      genStartCountAfterLateDirectContinuation,
      genStartCountAfterDrive,
      'late direct requested-work reply after consumed result_arrival must not open an empty generation',
    );

    await DialogPersistence.upsertNextStepTrigger(
      caller.id,
      {
        triggerId: 'result-arrival:dispatch:test:caller:c1:g2',
        kind: 'result_arrival',
        batchId: 'dispatch:test:caller:c1:g2',
      },
      caller.status,
    );
    await driveDialogStream(caller, undefined, true, {
      source: 'kernel_driver_business_continuation',
      reason: 'late_direct_continuation_after_consumed_result_arrival_with_stale_trigger_residue',
      suppressDiligencePush: true,
      businessContinuation: {
        kind: 'requested_work_reply',
        callerDialogId: caller.id.selfId,
        batchId: 'dispatch:test:caller:c1:g2',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
        sideDialogId: callee.id.selfId,
        callType: 'C',
        callId: 'caller-to-callee',
        resolvedCallIds: ['caller-to-callee'],
        triggerCallId: 'caller-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);
    const callerEventsAfterLateDirectContinuationWithResidue =
      await DialogPersistence.loadCourseEvents(caller.id, caller.currentCourse, caller.status);
    const genStartCountAfterLateDirectContinuationWithResidue =
      callerEventsAfterLateDirectContinuationWithResidue.filter(
        (event) => event.type === 'gen_start_record',
      ).length;
    assert.equal(
      genStartCountAfterLateDirectContinuationWithResidue,
      genStartCountAfterDrive,
      'late direct requested-work reply must stay stale when active-callees says the result_arrival batch was consumed',
    );
    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);
    const callerEventsAfterStaleBackendResidue = await DialogPersistence.loadCourseEvents(
      caller.id,
      caller.currentCourse,
      caller.status,
    );
    const genStartCountAfterStaleBackendResidue = callerEventsAfterStaleBackendResidue.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    assert.equal(
      genStartCountAfterStaleBackendResidue,
      genStartCountAfterDrive,
      'backend-loop stale result_arrival trigger must not open a generation after active-callees consumption',
    );
    const callerLatestAfterStaleBackendResidue = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      callerLatestAfterStaleBackendResidue?.nextStep.triggers.some(
        (trigger) => trigger.kind === 'result_arrival',
      ),
      false,
      'backend-loop stale side-dialog result_arrival trigger should be cleared by requested-work claim',
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
        sessionSlug: 'wake-queue-caller-without-final',
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

    const callerWithoutFinalEventsBeforeLateContinuation = await DialogPersistence.loadCourseEvents(
      callerWithoutFinalResponse.id,
      callerWithoutFinalResponse.currentCourse,
      callerWithoutFinalResponse.status,
    );
    const genStartCountBeforeLateContinuation =
      callerWithoutFinalEventsBeforeLateContinuation.filter(
        (event) => event.type === 'gen_start_record',
      ).length;

    await driveDialogStream(callerWithoutFinalResponse, undefined, true, {
      source: 'kernel_driver_business_continuation',
      reason: 'direct_continuation_after_result_arrival_trigger_was_lost_without_final_response',
      suppressDiligencePush: true,
      businessContinuation: {
        kind: 'requested_work_reply',
        callerDialogId: callerWithoutFinalResponse.id.selfId,
        batchId: 'dispatch:test:caller-without-final:c1:g4',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(4),
        sideDialogId: calleeWithoutFinalResponse.id.selfId,
        callType: 'C',
        callId: 'caller-without-final-to-callee',
        resolvedCallIds: ['caller-without-final-to-callee'],
        triggerCallId: 'caller-without-final-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const callerWithoutFinalEventsAfterLateContinuation = await DialogPersistence.loadCourseEvents(
      callerWithoutFinalResponse.id,
      callerWithoutFinalResponse.currentCourse,
      callerWithoutFinalResponse.status,
    );
    const genStartCountAfterLateContinuationWithoutFinal =
      callerWithoutFinalEventsAfterLateContinuation.filter(
        (event) => event.type === 'gen_start_record',
      ).length;
    assert.ok(
      genStartCountAfterLateContinuationWithoutFinal > genStartCountBeforeLateContinuation,
      'direct requested-work reply should recover when active-callees still has a resolved result_arrival batch even if its trigger was lost',
    );
    const activeCalleesAfterLostTriggerContinuation = await DialogPersistence.loadActiveCallees(
      callerWithoutFinalResponse.id,
      callerWithoutFinalResponse.status,
    );
    assert.equal(
      activeCalleesAfterLostTriggerContinuation.batches.some(
        (batch) => batch.batchId === 'dispatch:test:caller-without-final:c1:g4',
      ),
      false,
      'active-callees-backed direct continuation should consume the resolved result_arrival batch',
    );

    await driveDialogStream(callerWithoutFinalResponse, undefined, true, {
      source: 'kernel_driver_business_continuation',
      reason: 'late_direct_continuation_after_active_callees_consumed_without_final_response',
      suppressDiligencePush: true,
      businessContinuation: {
        kind: 'requested_work_reply',
        callerDialogId: callerWithoutFinalResponse.id.selfId,
        batchId: 'dispatch:test:caller-without-final:c1:g4',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(4),
        sideDialogId: calleeWithoutFinalResponse.id.selfId,
        callType: 'C',
        callId: 'caller-without-final-to-callee',
        resolvedCallIds: ['caller-without-final-to-callee'],
        triggerCallId: 'caller-without-final-to-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const callerWithoutFinalEventsAfterConsumedContinuation =
      await DialogPersistence.loadCourseEvents(
        callerWithoutFinalResponse.id,
        callerWithoutFinalResponse.currentCourse,
        callerWithoutFinalResponse.status,
      );
    const genStartCountAfterConsumedContinuation =
      callerWithoutFinalEventsAfterConsumedContinuation.filter(
        (event) => event.type === 'gen_start_record',
      ).length;
    assert.equal(
      genStartCountAfterConsumedContinuation,
      genStartCountAfterLateContinuationWithoutFinal,
      'late direct requested-work reply after active-callees consumption and no final response must not open an empty generation',
    );

    const mainlineCallee = await root.createSideDialog(
      'mentor',
      ['@mentor'],
      'Please finish the mainline task.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-to-main-callee',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(5),
        collectiveTargets: ['mentor'],
      },
    );
    await DialogPersistence.appendActiveCalleeDispatch(root.id, {
      batchId: 'dispatch:test:root:c1:g5',
      calleeDialogId: mainlineCallee.id.selfId,
      callId: 'root-to-main-callee',
      callName: 'tellaskSessionless',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(5),
      callType: 'C',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@mentor'],
      targetAgentId: 'mentor',
      tellaskContent: 'Please finish the mainline task.',
    });
    await supplyResponseToAskerDialog({
      callerDialog: root,
      sideDialogId: mainlineCallee.id,
      responseText: 'mentor finished the mainline task',
      callType: 'C',
      callId: 'root-to-main-callee',
      calleeResponseRef: { course: 1, genseq: 1 },
      scheduleDrive: () => {},
    });

    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);

    assert.equal(
      lastMainAssistantSaying(root),
      'Mainline resumed from Wake Queue result arrival.',
      'main dialog caller should process the Wake Queue result_arrival once',
    );
    const rootEventsAfterMainlineDrive = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const rootGenStartCountAfterMainlineDrive = rootEventsAfterMainlineDrive.filter(
      (event) => event.type === 'gen_start_record',
    ).length;

    await driveDialogStream(root, undefined, true, {
      source: 'kernel_driver_business_continuation',
      reason: 'late_direct_mainline_continuation_after_consumed_result_arrival',
      suppressDiligencePush: true,
      businessContinuation: {
        kind: 'requested_work_reply',
        callerDialogId: root.id.selfId,
        batchId: 'dispatch:test:root:c1:g5',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(5),
        sideDialogId: mainlineCallee.id.selfId,
        callType: 'C',
        callId: 'root-to-main-callee',
        resolvedCallIds: ['root-to-main-callee'],
        triggerCallId: 'root-to-main-callee',
      },
    });
    await waitForAllDialogsUnlocked(root, 3_000);

    const rootEventsAfterLateMainlineContinuation = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const rootGenStartCountAfterLateMainlineContinuation =
      rootEventsAfterLateMainlineContinuation.filter(
        (event) => event.type === 'gen_start_record',
      ).length;
    assert.equal(
      rootGenStartCountAfterLateMainlineContinuation,
      rootGenStartCountAfterMainlineDrive,
      'late direct main-dialog continuation after consumed result_arrival must not open an empty generation',
    );

    await DialogPersistence.upsertNextStepTrigger(
      root.id,
      {
        triggerId: 'result-arrival:dispatch:test:root:c1:g5',
        kind: 'result_arrival',
        batchId: 'dispatch:test:root:c1:g5',
      },
      root.status,
    );
    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);

    const rootEventsAfterStaleMainlineBackendResidue = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const rootGenStartCountAfterStaleMainlineBackendResidue =
      rootEventsAfterStaleMainlineBackendResidue.filter(
        (event) => event.type === 'gen_start_record',
      ).length;
    assert.equal(
      rootGenStartCountAfterStaleMainlineBackendResidue,
      rootGenStartCountAfterMainlineDrive,
      'backend-loop stale main-dialog result_arrival trigger must not open a generation after active-callees consumption',
    );
    const rootLatestAfterStaleMainlineBackendResidue = await DialogPersistence.loadDialogLatest(
      root.id,
      root.status,
    );
    assert.equal(
      rootLatestAfterStaleMainlineBackendResidue?.nextStep.triggers.some(
        (trigger) => trigger.kind === 'result_arrival',
      ),
      false,
      'backend-loop stale main-dialog result_arrival trigger should be cleared by requested-work claim',
    );
  });

  console.log('kernel-driver sideDialog-caller-result-arrival-backend-wake-queue: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-caller-result-arrival-backend-wake-queue: FAIL\n${message}`,
  );
  process.exit(1);
});
