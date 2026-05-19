import assert from 'node:assert/strict';

import type { HumanQuestion } from '@longrun-ai/kernel/types/storage';
import {
  toAskerCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { installRecordingGlobalDialogEventBroadcaster } from '../../main/bootstrap/global-dialog-event-broadcaster';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const recorder = installRecordingGlobalDialogEventBroadcaster({
      label: 'reply-delivery-recovery-waits-for-q4h',
    });
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    globalDialogRegistry.register(root);
    const targetCallId = 'q4h-blocked-reply-target-call';
    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Need a side reply tool result recovered after Q4H clears.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: targetCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'reply-delivery-recovery-waits-for-q4h',
        collectiveTargets: ['pangu'],
      },
    );

    const replyCallId = 'q4h-blocked-reply-tool-call';
    const replyTs = formatUnifiedTimestamp(new Date());
    const replyDeliveryId = `reply-delivery:${sideDialog.id.rootId}:${sideDialog.id.selfId}:${replyCallId}`;
    await DialogPersistence.mutateDialogLatest(
      sideDialog.id,
      (previous) => ({
        kind: 'patch',
        patch: {
          replyDelivery: {
            replyDeliveryId,
            status: 'delivered',
            toolResultStatus: 'pending',
            expectedReplyCallName: 'replyTellask',
            targetDialogId: root.id.selfId,
            targetCallId,
            replyCallId,
            replyGenseq: toCallSiteGenseqNo(3),
            replyContent: 'Side reply must wait while a human answer is pending.',
            createdAt: replyTs,
            deliveredAt: replyTs,
          },
          sideDialogFinalResponse: {
            callId: targetCallId,
            responseCourse: toDialogCourseNumber(1),
            responseGenseq: toCalleeGenerationSeqNumber(3),
            askerDialogId: root.id.selfId,
            askerCourse: toAskerCourseNumber(1),
          },
          displayState: { kind: 'blocked', reason: { kind: 'needs_human_input' } },
          nextStep: {
            nextSeq: previous.nextStep.nextSeq + 1,
            triggers: [
              ...previous.nextStep.triggers,
              {
                triggerId: `reply-delivery-recovery:${replyDeliveryId}`,
                kind: 'reply_delivery_recovery',
                replyDeliveryId,
                targetDialogId: root.id.selfId,
                createdAt: replyTs,
                seq: previous.nextStep.nextSeq,
              },
            ],
          },
        },
      }),
      sideDialog.status,
    );

    const question: HumanQuestion = {
      id: 'q4h-side-question',
      tellaskContent: 'Need a human answer before any backend continuation runs.',
      askedAt: replyTs,
      callId: 'ask-human-side-call',
      callSiteRef: { course: 1, messageIndex: 0, callSiteGenseq: 2 },
    };
    await DialogPersistence.appendQuestion4HumanState(sideDialog.id, question, sideDialog.status);

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_recovery_waits_for_q4h',
      reason: 'reply_delivery_recovery',
    });
    await driveQueuedDialogsOnce();

    const parkedLatest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(
      parkedLatest?.replyDelivery?.toolResultStatus,
      'pending',
      'reply delivery recovery must remain pending while Q4H is waiting',
    );
    assert(
      parkedLatest.nextStep.triggers.some((trigger) => trigger.kind === 'reply_delivery_recovery'),
      'blocked reply delivery recovery trigger should remain durable',
    );
    assert.equal(
      parkedLatest.userWait?.kind,
      'awaiting_user_answer',
      'Q4H user wait should remain intact while recovery is parked',
    );

    const eventsWhileParked = await DialogPersistence.loadCourseEvents(sideDialog.id, 1, 'running');
    assert(
      !eventsWhileParked.some(
        (event) => event.type === 'func_result_record' && event.id === replyCallId,
      ),
      'blocked reply delivery recovery must not record a tool result before Q4H clears',
    );

    const wakeQueueTargetsWhileParked = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert(
      wakeQueueTargetsWhileParked.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'blocked reply delivery recovery should stay in wake queue',
    );

    const removal = await DialogPersistence.removeQuestion4HumanState(
      sideDialog.id,
      question.id,
      sideDialog.status,
    );
    assert.equal(removal.found, true, 'test Q4H question should be removed before recovery retry');

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_recovery_waits_for_q4h',
      reason: 'q4h_cleared',
    });
    await driveQueuedDialogsOnce();

    const recoveredLatest = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(recoveredLatest?.replyDelivery?.status, 'delivered');
    assert.equal(recoveredLatest?.replyDelivery?.toolResultStatus, 'recorded');
    assert(
      !recoveredLatest.nextStep.triggers.some(
        (trigger) => trigger.kind === 'reply_delivery_recovery',
      ),
      'reply delivery recovery trigger should be consumed after Q4H clears',
    );

    const eventsAfterRecovery = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      1,
      'running',
    );
    assert(
      eventsAfterRecovery.some(
        (event) => event.type === 'func_result_record' && event.id === replyCallId,
      ),
      'reply delivery recovery should record the tool result after Q4H clears',
    );
    assert(
      !recorder.snapshot().some((event) => event.type === 'stream_error_evt'),
      'parking and later recovering reply delivery should not emit stream_error_evt',
    );
  });

  console.log('recovery reply-delivery-recovery-waits-for-q4h: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`recovery reply-delivery-recovery-waits-for-q4h: FAIL\n${message}`);
  process.exit(1);
});
