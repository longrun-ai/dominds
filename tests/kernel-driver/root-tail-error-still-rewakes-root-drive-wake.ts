import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { REPLY_TOOL_REMINDER_PREFIX_EN } from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
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
        callSiteCourse: 1,
        callSiteGenseq: 1,
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
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    });

    await DialogPersistence.upsertRootDriveWakeTrigger(
      root.id,
      'seed_preexisting_root_queue_before_tail_failure',
      root.status,
    );
    globalDialogRegistry.wakeDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'seed_preexisting_root_queue_before_tail_failure',
    });
    globalDialogRegistry.noteActiveRunBlockedQueuedDrive(root.id.rootId);

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
        if (options.driveOptions.reason === 'reply_tellask_back_delivered') {
          throw new Error('synthetic tail scheduleDrive failure');
        }
      },
      driveDialog: async () => {},
    });

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.displayState?.kind,
      'stopped',
      'tail scheduleDrive failure should stop the dialog rather than silently continuing',
    );
    assert.match(
      latest?.displayState?.kind === 'stopped' ? latest.displayState.reason.detail : '',
      /synthetic tail scheduleDrive failure/u,
      'stopped state should retain the surfaced tail failure detail',
    );
    assert.equal(
      hasPendingNextStepTriggers(latest),
      true,
      'deferred queued root wake should remain persisted after tail failure',
    );

    const lastTrigger = globalDialogRegistry.getLastDriveTrigger(root.id.rootId);
    assert.equal(
      lastTrigger?.action,
      'wake_drive',
      'tail failure should requeue and wake the deferred root drive',
    );
    assert.match(
      lastTrigger?.reason ?? '',
      /^core_stopped_requeue:/u,
      'wake event should describe the drive-failure requeue',
    );
    assert.equal(
      lastTrigger?.nextWakeQueued,
      true,
      'wake event should keep the queued registry state intact',
    );
  });

  console.log('kernel-driver root-tail-error-still-rewakes-root-drive-wake: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-tail-error-still-rewakes-root-drive-wake: FAIL\n${message}`);
  process.exit(1);
});
