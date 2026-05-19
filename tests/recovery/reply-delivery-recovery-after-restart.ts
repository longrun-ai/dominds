import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import {
  toAskerCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { deliverTellaskBackReplyFromDirective } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import {
  recoverPendingReplyDeliveryAfterRestart,
  recoverPendingReplyDeliveryForDialog,
} from '../../main/recovery/reply-delivery-recovery';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

function requirePersistedContent(
  event: Awaited<ReturnType<typeof DialogPersistence.loadCourseEvents>>[number] | undefined,
): string {
  assert.ok(event, 'expected persisted record to exist');
  if (!event || !('content' in event) || typeof event.content !== 'string') {
    throw new Error('expected persisted record with string content');
  }
  return event.content;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const liveRoot = await createMainDialog('tester');
    await deliverTellaskBackReplyFromDirective({
      replyingDialog: liveRoot,
      directive: {
        expectedReplyCallName: 'replyTellaskBack',
        targetDialogId: liveRoot.id.selfId,
        targetCallId: 'live-reply-target',
        tellaskContent: 'Need an immediate tellasker answer.',
      },
      replyContent: 'Live reply delivered.',
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert(
      liveRoot.msgs.some(
        (msg) =>
          msg.type === 'tellask_result_msg' &&
          msg.callId === 'live-reply-target' &&
          msg.callName === 'tellaskBack',
      ),
      'expected live replyTellaskBack delivery to mirror tellask result into target dialog msgs',
    );

    const root = await createMainDialog('tester');
    const tellaskContent = 'Need a final tellasker answer.';
    const targetCallId = 'tellask-back-target';

    const directive: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: root.id.selfId,
      targetCallId,
      tellaskContent,
    };
    await DialogPersistence.pushTellaskReplyObligation(root.id, directive, root.status);
    await root.persistUserMessage(
      'Reply-tool recovery directive',
      'directive-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      directive,
    );

    await root.persistTellaskCall(
      'reply-call',
      'replyTellaskBack',
      '{"replyContent":"Final answer delivered."}',
      1,
    );

    await recoverPendingReplyDeliveryAfterRestart();

    const rootEvents = await DialogPersistence.loadCourseEvents(root.id, 1, 'running');
    const replyFuncResult = rootEvents.find(
      (event) => event.type === 'func_result_record' && event.id === 'reply-call',
    );
    assert(replyFuncResult, 'expected restart recovery to append reply func_result_record');
    assert.match(
      requirePersistedContent(replyFuncResult),
      /Reply delivered via `replyTellaskBack`|已通过 `replyTellaskBack` 送达回复/u,
    );

    const replyResolution = rootEvents.find(
      (event) => event.type === 'tellask_reply_resolution_record' && event.callId === 'reply-call',
    );
    assert(replyResolution, 'expected restart recovery to append tellask_reply_resolution_record');

    const deliveredResponse = rootEvents.find(
      (event) =>
        event.type === 'tellask_result_record' &&
        event.callId === targetCallId &&
        event.callName === 'tellaskBack',
    );
    assert(
      deliveredResponse,
      'expected restart recovery to deliver tellask result to the tellasker',
    );

    const sideRoot = await createMainDialog('tester');
    const sideTargetCallId = 'side-tellask-target';
    const sideDialog = await sideRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      'Need a side reply tool result after crash.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: sideRoot.id.selfId,
        callId: sideTargetCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'reply-delivery-recovery-side-recovery',
        collectiveTargets: ['pangu'],
      },
    );
    const sideReplyCallId = 'side-reply-call-after-delivery';
    const sideReplyTs = formatUnifiedTimestamp(new Date());
    await DialogPersistence.mutateDialogLatest(
      sideDialog.id,
      () => ({
        kind: 'patch',
        patch: {
          replyDelivery: {
            replyDeliveryId: `${sideDialog.id.selfId}:${sideReplyCallId}`,
            status: 'delivered',
            toolResultStatus: 'pending',
            expectedReplyCallName: 'replyTellask',
            targetDialogId: sideRoot.id.selfId,
            targetCallId: sideTargetCallId,
            replyCallId: sideReplyCallId,
            replyGenseq: toCallSiteGenseqNo(3),
            replyContent: 'Side reply already delivered before crash.',
            createdAt: sideReplyTs,
            deliveredAt: sideReplyTs,
          },
          sideDialogFinalResponse: {
            callId: sideTargetCallId,
            responseCourse: toDialogCourseNumber(1),
            responseGenseq: toCalleeGenerationSeqNumber(3),
            askerDialogId: sideRoot.id.selfId,
            askerCourse: toAskerCourseNumber(1),
          },
        },
      }),
      sideDialog.status,
    );
    const wakeQueuedSideDialogs = await DialogPersistence.loadWakeQueuedDialogIds(
      sideRoot.id,
      sideRoot.status,
    );
    assert(
      wakeQueuedSideDialogs.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'sideDialog with pending reply tool-result recovery must remain in root wake queue',
    );

    await recoverPendingReplyDeliveryAfterRestart();

    const sideEvents = await DialogPersistence.loadCourseEvents(sideDialog.id, 1, 'running');
    const sideReplyFuncResult = sideEvents.find(
      (event) => event.type === 'func_result_record' && event.id === sideReplyCallId,
    );
    assert(
      sideReplyFuncResult,
      'expected restart recovery to record pending sideDialog reply tool result via wake queue',
    );

    const resolutionOnlyRoot = await createMainDialog('tester');
    const resolutionDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: resolutionOnlyRoot.id.selfId,
      targetCallId: 'tellask-back-target',
      tellaskContent: 'Need a final tellasker answer.',
    };
    await DialogPersistence.pushTellaskReplyObligation(
      resolutionOnlyRoot.id,
      resolutionDirective,
      resolutionOnlyRoot.status,
    );
    await resolutionOnlyRoot.persistUserMessage(
      'Reply-tool recovery directive',
      'directive-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      resolutionDirective,
    );
    await resolutionOnlyRoot.persistTellaskCall(
      'reply-back-call',
      'replyTellaskBack',
      '{"replyContent":"Final answer delivered."}',
      1,
    );
    await resolutionOnlyRoot.appendTellaskReplyResolution({
      callId: 'reply-back-call',
      replyCallName: 'replyTellaskBack',
      targetCallId: 'tellask-back-target',
    });

    await recoverPendingReplyDeliveryAfterRestart();

    const resolutionEvents = await DialogPersistence.loadCourseEvents(
      resolutionOnlyRoot.id,
      1,
      'running',
    );
    const synthesizedSuccessResult = resolutionEvents.find(
      (event) => event.type === 'func_result_record' && event.id === 'reply-back-call',
    );
    assert(
      synthesizedSuccessResult,
      'expected restart recovery to synthesize success func_result_record when resolution already exists',
    );

    const concurrentRoot = await createMainDialog('tester');
    const concurrentDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: concurrentRoot.id.selfId,
      targetCallId: 'tellask-back-target-concurrent',
      tellaskContent: 'Need only one recovered reply.',
    };
    await DialogPersistence.pushTellaskReplyObligation(
      concurrentRoot.id,
      concurrentDirective,
      concurrentRoot.status,
    );
    await concurrentRoot.persistUserMessage(
      'Concurrent reply-tool recovery directive',
      'directive-msg-concurrent',
      'markdown',
      'runtime',
      'en',
      undefined,
      concurrentDirective,
    );
    await concurrentRoot.persistTellaskCall(
      'reply-back-call-concurrent',
      'replyTellaskBack',
      '{"replyContent":"Recovered exactly once."}',
      1,
    );

    await Promise.all([
      recoverPendingReplyDeliveryForDialog(concurrentRoot),
      recoverPendingReplyDeliveryForDialog(concurrentRoot),
    ]);

    const concurrentEvents = await DialogPersistence.loadCourseEvents(
      concurrentRoot.id,
      1,
      'running',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) => event.type === 'func_result_record' && event.id === 'reply-back-call-concurrent',
      ).length,
      1,
      'expected concurrent recovery to append exactly one func_result_record',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) =>
          event.type === 'tellask_reply_resolution_record' &&
          event.callId === 'reply-back-call-concurrent',
      ).length,
      1,
      'expected concurrent recovery to append exactly one tellask_reply_resolution_record',
    );
    assert.equal(
      concurrentEvents.filter(
        (event) =>
          event.type === 'tellask_result_record' &&
          event.callId === 'tellask-back-target-concurrent' &&
          event.callName === 'tellaskBack',
      ).length,
      1,
      'expected concurrent recovery to deliver exactly one tellask_result_record',
    );
  });

  console.log('recovery reply-delivery-recovery-after-restart: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`recovery reply-delivery-recovery-after-restart: FAIL\n${message}`);
  process.exit(1);
});
