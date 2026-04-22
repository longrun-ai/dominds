import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const prompt = [
      '[Dominds replyTellask required]',
      '',
      'Please now call `replyTellaskBack({ replyContent })` to deliver the reply.',
    ].join('\n');
    const response = 'Foreground round completed before any queued retry was needed.';

    await writeMockDb(tmpRoot, [
      {
        message: prompt,
        role: 'user',
        response,
        funcCalls: [
          {
            id: 'root-cross-trigger-explicit-reply',
            name: 'replyTellaskBack',
            arguments: {
              replyContent: response,
            },
          },
        ],
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);
    void runBackendDriver();

    const pendingSideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Background sideline work is still pending.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        callerDialogId: root.id.selfId,
        callId: 'root-cross-trigger-pending-sideDialog',
        collectiveTargets: ['pangu'],
      },
    );

    await DialogPersistence.setNeedsDrive(root.id, true, root.status);
    globalDialogRegistry.markNeedsDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'seed_deferred_root_queue_before_cross_trigger_tail_test',
    });
    globalDialogRegistry.noteActiveRunBlockedQueuedDrive(root.id.rootId);

    let injectedUnrelatedTrigger = false;
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        {
          content: prompt,
          msgId: 'root-cross-trigger-does-not-reenter-during-tail',
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: {
            expectedReplyCallName: 'replyTellaskBack',
            targetCallId: 'reply-back-target',
            targetDialogId: pendingSideDialog.id.selfId,
            tellaskContent: 'Please confirm the sideline result.',
          },
        },
        true,
        {
          source: 'ws_resume_dialog',
          reason: 'cross_trigger_during_tail',
          suppressDiligencePush: true,
        },
      ],
      scheduleDrive: () => {
        if (injectedUnrelatedTrigger) {
          return;
        }
        injectedUnrelatedTrigger = true;
        globalDialogRegistry.markNeedsDrive('synthetic-unrelated-root-trigger', {
          source: 'kernel_driver_test',
          reason: 'unrelated_root_trigger_while_root_tail_is_still_running',
        });
      },
      driveDialog: async () => {},
    });

    await waitFor(
      async () => injectedUnrelatedTrigger,
      3_000,
      'tail callback to inject an unrelated root trigger while the foreground root round is still unwinding',
    );
    await waitForAllDialogsUnlocked(root, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = events.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      1,
      'unrelated root trigger must not cause a second no-prompt root generation while tail is still running',
    );

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latest?.needsDrive,
      false,
      'foreground round should clear the stale queued revive',
    );
  });

  console.log('kernel-driver root-cross-trigger-does-not-reenter-during-tail: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-cross-trigger-does-not-reenter-during-tail: FAIL\n${message}`);
  process.exit(1);
});
