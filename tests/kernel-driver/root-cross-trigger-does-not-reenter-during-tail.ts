import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { REPLY_TOOL_REMINDER_PREFIX_EN } from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const prompt = [
      REPLY_TOOL_REMINDER_PREFIX_EN,
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
    const backendAbort = new AbortController();
    let backendDriver: ReturnType<typeof runBackendDriver> | undefined;
    let resolveBackendCycle: (() => void) | undefined;
    const observedBackendCycle = new Promise<void>((resolve) => {
      resolveBackendCycle = resolve;
    });
    const originalWait = globalDialogRegistry.waitForDriveTrigger;
    let unrelatedTriggerConsumed = false;
    // Pass through real trigger consumption; observe the next idle boundary after its loop pass.
    globalDialogRegistry.waitForDriveTrigger = async function () {
      if (unrelatedTriggerConsumed) {
        assert.ok(resolveBackendCycle);
        resolveBackendCycle();
      }
      const trigger = await originalWait.call(globalDialogRegistry);
      if (trigger.rootId === 'synthetic-unrelated-root-trigger') unrelatedTriggerConsumed = true;
      return trigger;
    };
    try {
      const activeCalleeDispatch = await root.createSideDialog(
        'pangu',
        ['@pangu'],
        'Background side dialog work remains active.',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: root.id.selfId,
          callId: 'root-cross-trigger-active-callee',
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
          collectiveTargets: ['pangu'],
        },
      );

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
        'seed_deferred_root_queue_before_cross_trigger_tail_test',
        root.status,
      );
      globalDialogRegistry.queueRootDrive(root.id.rootId, {
        source: 'kernel_driver_test',
        reason: 'seed_deferred_root_queue_before_cross_trigger_tail_test',
      });
      globalDialogRegistry.noteActiveRunBlockedQueuedDrive(root.id.rootId);

      let injectedUnrelatedTrigger = false;
      let tailSchedules = 0;
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
              targetDialogId: activeCalleeDispatch.id.selfId,
              tellaskContent: 'Please confirm the side dialog result.',
            },
          },
          true,
          {
            source: 'ws_resume_dialog',
            reason: 'cross_trigger_during_tail',
            suppressDiligencePush: true,
          },
        ],
        scheduleDrive: (_dialog, options) => {
          tailSchedules += 1;
          assert.equal(options.driveOptions?.reason, 'reply_tellask_back_delivered');
          if (injectedUnrelatedTrigger) {
            return;
          }
          assert.equal(
            root.isLocked(),
            true,
            'the foreground round still owns the dialog during this tail callback',
          );
          injectedUnrelatedTrigger = true;
          backendDriver = runBackendDriver({ abortSignal: backendAbort.signal });
          globalDialogRegistry.queueRootDrive('synthetic-unrelated-root-trigger', {
            source: 'kernel_driver_test',
            reason: 'unrelated_root_trigger_while_root_tail_is_still_running',
          });
        },
        driveDialog: async () => {},
      });

      assert.equal(injectedUnrelatedTrigger, true);
      assert.equal(tailSchedules, 1);
      await observedBackendCycle;
      await waitForAllDialogsUnlocked(root, 3_000);

      const events = await DialogPersistence.loadCourseEvents(
        root.id,
        root.currentCourse,
        root.status,
      );
      const genStartCount = events.filter((event) => event.type === 'gen_start_record').length;
      assert.equal(
        genStartCount,
        1,
        'unrelated root trigger must not cause a second business-continuation root generation while tail is still running',
      );

      assert.equal(unrelatedTriggerConsumed, true);
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
      assert.ok(canonical[0].content.includes(response));
      const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
      assert.equal(
        hasPendingNextStepTriggers(latest),
        false,
        'foreground round should clear the stale queued wake',
      );
    } finally {
      backendAbort.abort();
      if (backendDriver) await backendDriver;
      globalDialogRegistry.waitForDriveTrigger = originalWait;
    }
  });

  console.log('kernel-driver root-cross-trigger-does-not-reenter-during-tail: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver root-cross-trigger-does-not-reenter-during-tail: FAIL\n${message}`);
  process.exit(1);
});
