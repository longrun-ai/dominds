import assert from 'node:assert/strict';

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
      label: 'reply-delivery-live-continuation',
    });
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    globalDialogRegistry.register(root);
    const targetCallId = 'live-reply-target-call';
    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Need a side reply tool result recovered by live backend wake.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: targetCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'reply-delivery-live-continuation',
        collectiveTargets: ['pangu'],
      },
    );

    const replyCallId = 'live-reply-tool-call-after-delivery';
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
            replyContent: 'Side reply was already delivered before live recovery.',
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

    const wakeQueueTargetSideDialogs = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert(
      wakeQueueTargetSideDialogs.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'sideDialog with pending reply delivery recovery must enter wake queue',
    );

    globalDialogRegistry.wakeDrive(root.id.rootId, {
      source: 'test_reply_delivery_live_continuation',
      reason: 'reply_delivery_recovery',
    });
    await driveQueuedDialogsOnce();

    const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(latest?.replyDelivery?.status, 'delivered');
    assert.equal(latest?.replyDelivery?.toolResultStatus, 'recorded');
    assert(
      !latest.nextStep.triggers.some((trigger) => trigger.kind === 'reply_delivery_recovery'),
      'completed reply delivery recovery trigger should be consumed locally',
    );

    const sideEvents = await DialogPersistence.loadCourseEvents(sideDialog.id, 1, 'running');
    assert(
      sideEvents.some((event) => event.type === 'func_result_record' && event.id === replyCallId),
      'live backend continuation should record the pending reply tool result',
    );
    assert(
      !recorder.snapshot().some((event) => event.type === 'stream_error_evt'),
      'valid live reply delivery recovery should not emit stream_error_evt',
    );

    const wakeQueueTargetsAfterRecovery = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert(
      !wakeQueueTargetsAfterRecovery.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'sideDialog should leave wake queue after live reply delivery recovery is complete',
    );
  });

  console.log('recovery reply-delivery-live-continuation: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`recovery reply-delivery-live-continuation: FAIL\n${message}`);
  process.exit(1);
});
