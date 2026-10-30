import {
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import { DialogID, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeDriveOptions,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, {
      providerApiType: 'controlled-stale-runtime',
      includePangu: true,
    });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const tellaskContent = 'Clear stale pending runtime prompt after restore.';
    const callId = 'call-stale-pending-runtime-prompt';

    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'stale-pending-runtime-prompt',
      collectiveTargets: ['pangu'],
    });
    sideDialog.disableDiligencePush = true;
    await DialogPersistence.saveActiveCalleeDispatches(root.id, [
      {
        calleeDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        batchId: 'stale-pending-runtime-prompt-batch',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent,
        targetAgentId: 'pangu',
        callId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'B',
        sessionSlug: 'stale-pending-runtime-prompt',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );
    const queuedPrompt = sideDialog.peekQueuedPrompt();
    assert.ok(queuedPrompt?.kind === 'new_course_runtime_sideDialog');

    let workerRounds = 0;
    let callerRounds = 0;
    const generator: LlmGenerator = {
      apiType: 'controlled-stale-runtime',
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
      async genToReceiver(_provider, _agent, _system, _tools, request, _context, receiver) {
        if (request.dialogSelfId === sideDialog.id.selfId) {
          workerRounds += 1;
          assert.equal(workerRounds, 1);
          await receiver.funcCall(
            'explicit-stale-runtime-reply',
            'replyTellask',
            JSON.stringify({ replyContent: 'completed-task-data-c45a' }),
          );
        } else {
          assert.equal(request.dialogSelfId, root.id.selfId);
          callerRounds += 1;
          assert.equal(callerRounds, 1);
          await receiver.sayingStart();
          await receiver.sayingChunk('caller-consumed-data-d56b');
          await receiver.sayingFinish();
        }
        return { usage: { kind: 'unavailable' } };
      },
    };
    registerLlmGenerator(generator);
    try {
      await driveDialogStream(sideDialog, undefined, true, makeDriveOptions());
      await waitForAllDialogsUnlocked(root, 3_000);
      assert.equal(workerRounds, 1);
      assert.equal(callerRounds, 1);
      assert.equal(
        await DialogPersistence.loadActiveTellaskReplyObligation(sideDialog.id, sideDialog.status),
        undefined,
      );
    } finally {
      unregisterLlmGenerator(generator.apiType);
    }

    const persistedBeforeRestore = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    assert.equal(
      persistedBeforeRestore.filter(
        (event) => event.type === 'human_text_record' && event.msgId === queuedPrompt.msgId,
      ).length,
      1,
    );
    const generationsBeforeRestore = persistedBeforeRestore.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    await DialogPersistence.mutateDialogLatest(sideDialog.id, (previous) => ({
      kind: 'patch',
      patch: {
        nextStep: {
          nextSeq: 2,
          triggers: [
            {
              triggerId: `queued-prompt:${queuedPrompt.msgId}`,
              kind: 'queued_prompt',
              promptId: queuedPrompt.msgId,
              course: toDialogCourseNumber(sideDialog.currentCourse),
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
        pendingRuntimePrompt: {
          content: queuedPrompt.prompt,
          msgId: queuedPrompt.msgId,
          grammar: 'markdown',
          origin: 'runtime',
          userLanguageCode: queuedPrompt.userLanguageCode,
          tellaskReplyDirective: queuedPrompt.tellaskReplyDirective,
          skipTaskdoc: queuedPrompt.skipTaskdoc,
          calleeDialogReplyTarget: queuedPrompt.calleeDialogReplyTarget,
        },
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_runtime_prompt' },
          continueEnabled: true,
        },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_runtime_prompt' } },
        lastModified: previous.lastModified,
      },
    }));
    const latestBeforeRestore = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.ok(latestBeforeRestore, 'expected sideDialog latest before restore');
    assert.equal(latestBeforeRestore.executionMarker?.kind, 'interrupted');
    assert.equal(latestBeforeRestore.displayState?.kind, 'stopped');
    await DialogPersistence.syncWakeQueueForDialogLatest(
      sideDialog.id,
      latestBeforeRestore,
      sideDialog.status,
    );
    const wakeQueueTargetsBeforeRestore = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.ok(
      wakeQueueTargetsBeforeRestore.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      'test precondition: stale pending runtime prompt should be represented in root Wake Queue before restore',
    );

    globalDialogRegistry.unregister(root.id.rootId);
    const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, 'running');
    assert.ok(restoredRoot, 'expected main dialog restore to succeed');
    assert.notEqual(restoredRoot, root, 'restore must construct a new root from durable state');
    const restoredSideDialog = await ensureDialogLoaded(
      restoredRoot,
      new DialogID(sideDialog.id.selfId, sideDialog.id.rootId),
      'running',
    );
    assert.ok(restoredSideDialog instanceof SideDialog);
    assert.notEqual(
      restoredSideDialog,
      sideDialog,
      'restore must construct a new worker from durable state',
    );
    assert.equal(
      restoredSideDialog.peekQueuedPrompt(),
      undefined,
      'restore should not requeue a stale runtime prompt that is already persisted in course events',
    );

    const latestAfterRestore = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
    assert.equal(
      latestAfterRestore?.pendingRuntimePrompt,
      undefined,
      'restore should clear the stale pending runtime prompt from latest.yaml',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfterRestore),
      false,
      'restore should clear stale pending next-step triggers when the pending runtime prompt is already persisted',
    );
    assert.equal(
      latestAfterRestore?.executionMarker,
      undefined,
      'restore should clear the stale pending-runtime-prompt interruption marker as well',
    );
    assert.deepEqual(
      latestAfterRestore?.displayState,
      { kind: 'idle_waiting_user' },
      'restore should clear the stale stopped projection once the pending prompt is already persisted',
    );
    const eventsAfterRestore = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      'running',
    );
    assert.equal(
      eventsAfterRestore.filter(
        (event) => event.type === 'human_text_record' && event.msgId === queuedPrompt.msgId,
      ).length,
      1,
    );
    assert.equal(
      eventsAfterRestore.filter((event) => event.type === 'gen_start_record').length,
      generationsBeforeRestore,
    );
    const wakeQueueTargetsAfterRestore = await DialogPersistence.loadWakeQueueTargetDialogIds(
      root.id,
      root.status,
    );
    assert.equal(
      wakeQueueTargetsAfterRestore.some((dialogId) => dialogId.selfId === sideDialog.id.selfId),
      false,
      'restore should remove the stale pending runtime prompt from the root Wake Queue',
    );
  });

  console.log('kernel-driver sideDialog-stale-pending-runtime-prompt-clears-on-restore: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-stale-pending-runtime-prompt-clears-on-restore: FAIL\n${message}`,
  );
  process.exit(1);
});
