import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
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
      '[Dominds replyTellask required]',
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

    const pendingSideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Background side dialog work is still pending.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-pending-sideDialog-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.appendPendingSideDialog(root.id, {
      sideDialogId: pendingSideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: 'Background side dialog work is still pending.',
      targetAgentId: 'pangu',
      callId: 'root-pending-sideDialog-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    });

    await DialogPersistence.setNeedsDrive(root.id, true, root.status);
    globalDialogRegistry.markNeedsDrive(root.id.rootId, {
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
            targetDialogId: pendingSideDialog.id.selfId,
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
      latest?.needsDrive,
      true,
      'deferred queued root revive should remain persisted after tail failure',
    );

    const lastTrigger = globalDialogRegistry.getLastDriveTrigger(root.id.rootId);
    assert.equal(
      lastTrigger?.action,
      'active_run_cleared',
      'tail failure should still emit an active_run_cleared wake event for the deferred queued root',
    );
    assert.equal(
      lastTrigger?.previousNeedsDrive,
      true,
      'wake event should preserve the already-queued registry state',
    );
    assert.equal(
      lastTrigger?.nextNeedsDrive,
      true,
      'wake event should keep the queued registry state intact',
    );
  });

  console.log('kernel-driver root-tail-error-still-rewakes-queued-needsdrive: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-tail-error-still-rewakes-queued-needsdrive: FAIL\n${message}`);
  process.exit(1);
});
