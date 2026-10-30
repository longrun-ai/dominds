import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { REPLY_TOOL_REMINDER_PREFIX_EN } from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  makeDriveOptions,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const replyReminderPrompt = [
      REPLY_TOOL_REMINDER_PREFIX_EN,
      '',
      'Please now call `replyTellaskBack({ replyContent })` to deliver the reply.',
    ].join('\n');
    const plainReply = 'Plain reply content that stays local unless replyTellaskBack is called.';

    await writeMockDb(tmpRoot, [
      {
        message: replyReminderPrompt,
        role: 'user',
        response: plainReply,
        funcCalls: [
          {
            id: 'root-tail-explicit-reply',
            name: 'replyTellaskBack',
            arguments: {
              replyContent: plainReply,
            },
          },
        ],
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    const activeCalleeDispatch = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Background side dialog work remains active.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-active-callee-call',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.appendActiveCalleeDispatch(root.id, {
      calleeDialogId: activeCalleeDispatch.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'root-active-callee-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: 'Background side dialog work remains active.',
      targetAgentId: 'pangu',
      callId: 'root-active-callee-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'C',
    });

    await activeCalleeDispatch.persistTellaskCall(
      'reply-back-target',
      'tellaskBack',
      JSON.stringify({ tellaskContent: 'Please confirm the side dialog result.' }),
      1,
    );
    await DialogPersistence.setActiveTellaskReplyObligation(root.id, {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target',
      targetDialogId: activeCalleeDispatch.id.selfId,
      tellaskContent: 'Please confirm the side dialog result.',
    });
    await DialogPersistence.upsertRootRuntimeWake(
      root.id,
      'seed_preexisting_root_queue_before_tail_failure',
      root.status,
    );
    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'seed_preexisting_root_queue_before_tail_failure',
    });
    globalDialogRegistry.noteActiveRunBlockedQueuedDrive(root.id.rootId);

    let injectedFailures = 0;
    const injectedError = new Error('synthetic tail scheduleDrive failure');
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        {
          content: replyReminderPrompt,
          msgId: 'root-tail-failure-prompt',
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: {
            expectedReplyCallName: 'replyTellaskBack',
            targetCallId: 'reply-back-target',
            targetDialogId: activeCalleeDispatch.id.selfId,
            tellaskContent: 'Please confirm the side dialog result.',
          },
        },
        true,
        makeDriveOptions({
          source: 'kernel_driver_follow_up',
          reason: 'reply_tool_reminder',
          suppressDiligencePush: true,
        }),
      ],
      scheduleDrive: (_dialog, options) => {
        if (options.driveOptions?.reason === 'reply_tellask_back_delivered') {
          injectedFailures += 1;
          throw injectedError;
        }
      },
      driveDialog: async () => {},
    });

    assert.equal(
      injectedFailures,
      1,
      'the intended reply-delivery tail fault was actually reached',
    );
    const canonical = (
      await DialogPersistence.loadCourseEvents(
        activeCalleeDispatch.id,
        activeCalleeDispatch.currentCourse,
        activeCalleeDispatch.status,
      )
    )
      .filter((event) => event.type === 'tellask_result_record')
      .filter((event) => event.callId === 'reply-back-target');
    assert.equal(canonical.length, 1);
    assert.ok(
      canonical[0].content.includes(plainReply),
      'the controlled reply payload reached the requester before the injected failure',
    );
    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.displayState?.kind,
      'stopped',
      'tail scheduleDrive failure should stop the dialog rather than silently continuing',
    );
    assert.ok(latest?.displayState?.kind === 'stopped');
    const stopReason = latest.displayState.reason;
    assert.ok('detail' in stopReason);
    assert.ok(
      stopReason.detail.includes(injectedError.message),
      'stopped state retains the controlled injected error payload',
    );
    assert.equal(
      await DialogPersistence.hasRootRuntimeWake(root.id, root.status),
      true,
      'deferred queued root runtime wake should remain persisted after tail failure',
    );

    const lastTrigger = globalDialogRegistry.getLastDriveTrigger(root.id.rootId);
    assert.equal(
      lastTrigger?.action,
      'queue_root_drive',
      'tail failure should requeue the deferred root drive',
    );
    assert.equal(lastTrigger?.source, 'kernel_driver_flow_tail');
    assert.equal(lastTrigger?.reason, 'core_stopped_requeue:reply_tool_reminder');
    assert.equal(
      lastTrigger?.nextDriveQueued,
      true,
      'drive event should keep the queued registry state intact',
    );
  });

  console.log('kernel-driver root-tail-error-still-rewakes-root-runtime-wake: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-tail-error-still-rewakes-root-runtime-wake: FAIL\n${message}`);
  process.exit(1);
});
