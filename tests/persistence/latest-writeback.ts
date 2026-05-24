/**
 * latest.yaml write-back regression script
 *
 * Purpose: protect invariants of DialogPersistence.mutateDialogLatest():
 * - concurrent patches merge (no lost fields)
 * - mutator callbacks are linearized (no lost increments)
 * - write-back eventually flushes a correct snapshot to disk
 *
 * This script is intentionally small and self-contained; it runs against a temp rtws.
 */

import type {
  ActiveCalleeDispatchRecord,
  MainDialogMetadataFile,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import * as fsNode from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID, MainDialog } from '../../main/dialog';
import { setDialogDisplayState, setDialogExecutionMarker } from '../../main/dialog-display-state';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../../main/dialog-latest-state';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
import { DomindsPersistenceFileError } from '../../main/persistence-errors';

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for file: ${filePath}`);
      }
      await sleep(50);
    }
  }
}

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-latest-writeback-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    const dialogId = new DialogID('61/5a/da8d0169');
    const metadata: MainDialogMetadataFile = {
      id: dialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:00:00.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(dialogId, metadata, 'running');
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:00:01.000Z')),
        status: 'active',
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
      },
    }));

    // Invariant 1: concurrent patch mutations must merge (no lost fields).
    await Promise.all([
      DialogPersistence.mutateDialogLatest(dialogId, () => ({
        kind: 'patch',
        patch: { messageCount: 1, status: 'active' },
      })),
      DialogPersistence.mutateDialogLatest(dialogId, () => ({
        kind: 'patch',
        patch: { functionCallCount: 2, status: 'active' },
      })),
    ]);

    const merged = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(merged, 'Expected staged latest after mutation');
    assert.equal(merged.status, 'active');
    assert.equal(merged.messageCount, 1);
    assert.equal(merged.functionCallCount, 2);

    // Invariant 2: mutator callbacks observe a linearized previous state.
    // If this regresses, concurrent increments may collapse.
    const increments = 50;
    await Promise.all(
      Array.from({ length: increments }, () =>
        DialogPersistence.mutateDialogLatest(dialogId, (prev) => ({
          kind: 'patch',
          patch: { messageCount: (prev.messageCount ?? 0) + 1 },
        })),
      ),
    );

    const afterIncrements = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(afterIncrements, 'Expected staged latest after increments');
    assert.equal(afterIncrements.messageCount, 1 + increments);

    // Invariant 3: write-back eventually flushes a correct snapshot to disk.
    // Wait long enough for at least one write-back cycle to complete.
    const latestPath = path.join(sandboxDir, '.dialogs', 'run', dialogId.selfId, 'latest.yaml');
    await waitForFile(latestPath, 2000);

    const content = await fs.readFile(latestPath, 'utf-8');
    const parsed: unknown = yaml.parse(content);
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed !== null);

    const record = parsed as Record<string, unknown>;
    assert.equal(record['status'], 'active');
    assert.equal(record['messageCount'], 1 + increments);
    assert.equal(record['functionCallCount'], 2);

    // Invariant 4: generating dialogs must not persist a non-running displayState snapshot.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 3,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:01:00.000Z')),
        status: 'active',
        generating: true,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'idle_waiting_user' },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_runtime_prompt' } },
      },
    }));
    const healedGenerating = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(healedGenerating, 'Expected latest after generating/displayState healing');
    assert.equal(healedGenerating.generating, true);
    assert.deepEqual(healedGenerating.displayState, { kind: 'proceeding' });
    assert.equal(healedGenerating.executionMarker, undefined);

    // Invariant 5: dead state must remain louder than the generic generating/proceeding healing.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 4,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:02:00.000Z')),
        status: 'active',
        generating: true,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'dead', reason: { kind: 'declared_by_user' } },
        executionMarker: { kind: 'dead', reason: { kind: 'declared_by_user' } },
      },
    }));
    const preservedDead = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(preservedDead, 'Expected latest after dead/generating mismatch write');
    assert.equal(preservedDead.generating, true);
    assert.deepEqual(preservedDead.displayState, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });
    assert.deepEqual(preservedDead.executionMarker, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });

    // Invariant 6: waiting_side_dialog is a first-class persisted display state.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 4,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:02:30.000Z')),
        status: 'active',
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'waiting_side_dialog' },
      },
    }));
    const preservedWaitingSideDialog = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(
      preservedWaitingSideDialog,
      'Expected latest after waiting_side_dialog displayState write',
    );
    assert.deepEqual(preservedWaitingSideDialog.displayState, { kind: 'waiting_side_dialog' });
    assert.equal(preservedWaitingSideDialog.executionMarker, undefined);

    // Invariant 7: any dialog with an active reply obligation must not persist idle_waiting_user.
    await DialogPersistence.setActiveTellaskReplyObligation(dialogId, {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: 'aa/bb/ask-back-requester',
      targetCallId: 'root-owes-reply-call',
      tellaskContent: 'Please answer the ask-back before idling.',
    });
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 4,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:02:45.000Z')),
        status: 'active',
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'idle_waiting_user' },
      },
    }));
    const rootPendingReplyObligation = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(
      rootPendingReplyObligation,
      'Expected latest after root pending reply obligation healing',
    );
    assert.deepEqual(rootPendingReplyObligation.displayState, { kind: 'proceeding' });
    assert.equal(rootPendingReplyObligation.executionMarker, undefined);
    const debugDir = path.join(sandboxDir, '.dislogs', 'debug');
    const debugFilesAfterPendingReply = await fs.readdir(debugDir);
    const pendingReplyDebugFiles = debugFilesAfterPendingReply.filter((file) =>
      file.startsWith('dialog-latest-idle-with-active-reply-obligation-'),
    );
    assert.equal(
      pendingReplyDebugFiles.length,
      1,
      'expected idle-with-active-reply-obligation debug dump',
    );
    const pendingReplyDebugRaw = await fs.readFile(
      path.join(debugDir, pendingReplyDebugFiles[0] ?? ''),
      'utf-8',
    );
    const pendingReplyDebug: unknown = JSON.parse(pendingReplyDebugRaw);
    assertRecord(pendingReplyDebug, 'pending reply debug payload');
    assert.equal(pendingReplyDebug.kind, 'dialog_latest_idle_with_active_reply_obligation');
    assertRecord(pendingReplyDebug.details, 'pending reply debug details');
    assert.equal(pendingReplyDebug.details.targetCallId, 'root-owes-reply-call');
    assertRecord(pendingReplyDebug.details.healedTo, 'pending reply debug healedTo');

    const rootPendingSideDialog: ActiveCalleeDispatchRecord = {
      calleeDialogId: 'aa/bb/root-waits-side-dialog',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:02:50.000Z')),
      batchId: 'root-waits-side-dialog-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@helper'],
      tellaskContent: 'Finish the side work before the root can answer.',
      targetAgentId: 'helper',
      callId: 'root-waits-side-dialog-call',
      callSiteCourse: 4,
      callSiteGenseq: 1,
      callType: 'C',
    };
    await DialogPersistence.appendActiveCalleeDispatch(dialogId, rootPendingSideDialog);
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'patch',
      patch: {
        displayState: { kind: 'idle_waiting_user' },
        executionMarker: {
          kind: 'interrupted',
          reason: { kind: 'pending_reply_obligation' },
        },
      },
    }));
    const rootWaitingSideDialog = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(rootWaitingSideDialog, 'Expected latest after root waiting-side-dialog healing');
    assert.deepEqual(rootWaitingSideDialog.displayState, { kind: 'waiting_side_dialog' });
    assert.equal(rootWaitingSideDialog.executionMarker, undefined);
    const debugFilesAfterWaitingSideDialog = await fs.readdir(debugDir);
    const allReplyDebugFiles = debugFilesAfterWaitingSideDialog.filter((file) =>
      file.startsWith('dialog-latest-idle-with-active-reply-obligation-'),
    );
    assert.equal(
      allReplyDebugFiles.length,
      2,
      'expected second idle-with-active-reply-obligation debug dump',
    );

    await DialogPersistence.setActiveTellaskReplyObligation(dialogId, undefined);

    // Invariant 8: clearing a pending runtime prompt must not regress a live generating round
    // back to idle if a newer write has already reasserted proceeding.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 5,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:03:00.000Z')),
        status: 'active',
        generating: true,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_runtime_prompt' },
          continueEnabled: true,
        },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_runtime_prompt' } },
        pendingRuntimePrompt: {
          content: 'resume current round',
          msgId: 'pending-runtime-prompt-msg',
          grammar: 'markdown',
          origin: 'runtime',
        },
      },
    }));
    await DialogPersistence.clearPendingRuntimePrompt(dialogId, 'pending-runtime-prompt-msg');
    const clearedPendingRuntimePrompt = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(clearedPendingRuntimePrompt, 'Expected latest after clearing pending runtime-prompt');
    assert.equal(clearedPendingRuntimePrompt.generating, true);
    assert.deepEqual(clearedPendingRuntimePrompt.displayState, { kind: 'proceeding' });
    assert.equal(clearedPendingRuntimePrompt.pendingRuntimePrompt, undefined);
    assert.equal(clearedPendingRuntimePrompt.executionMarker, undefined);

    // Invariant 9: startNewCourse during an active generation must only queue the pending prompt;
    // it must not regress the live round into pending_runtime_prompt before the generation finishes.
    const activeDialogId = new DialogID('71/6b/eb9d1270');
    const activeMetadata: MainDialogMetadataFile = {
      id: activeDialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback-active-course.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:04:00.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(activeDialogId, activeMetadata, 'running');
    await DialogPersistence.mutateDialogLatest(activeDialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:04:01.000Z')),
        status: 'active',
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'proceeding' },
        messageCount: 0,
        functionCallCount: 0,
        sideDialogCount: 0,
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));
    const activeStore = new DiskFileDialogStore(activeDialogId);
    const activeDialog = new MainDialog(
      activeStore,
      'plans/latest-writeback-active-course.tsk',
      activeDialogId,
      'tester',
    );
    await activeDialog.notifyGeneratingStart('active-course-msg');
    await activeStore.startNewCourse(activeDialog, {
      content: 'continue in course two after current generation',
      msgId: 'pending-active-runtime-prompt-msg',
      grammar: 'markdown',
      origin: 'runtime',
      userLanguageCode: 'en',
    });
    const latestDuringActiveGeneration = await DialogPersistence.loadDialogLatest(activeDialogId);
    assert.ok(
      latestDuringActiveGeneration,
      'Expected latest after queueing a new course during active generation',
    );
    assert.equal(latestDuringActiveGeneration.generating, true);
    assert.deepEqual(latestDuringActiveGeneration.displayState, { kind: 'proceeding' });
    assert.equal(latestDuringActiveGeneration.executionMarker, undefined);
    assert.equal(
      latestDuringActiveGeneration.pendingRuntimePrompt?.msgId,
      'pending-active-runtime-prompt-msg',
    );

    // Invariant 10: a finished generation must not keep poisoning later startNewCourse writes.
    // activeGenSeq is monotonic across generations and remains defined after finish, so the
    // runtime must key "currently generating" off live generation state instead.
    const settledDialogId = new DialogID('72/6c/fc0a2381');
    const settledMetadata: MainDialogMetadataFile = {
      id: settledDialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback-settled-course.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:05:00.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(settledDialogId, settledMetadata, 'running');
    await DialogPersistence.mutateDialogLatest(settledDialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:05:01.000Z')),
        status: 'active',
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'proceeding' },
        messageCount: 0,
        functionCallCount: 0,
        sideDialogCount: 0,
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));
    const settledStore = new DiskFileDialogStore(settledDialogId);
    const settledDialog = new MainDialog(
      settledStore,
      'plans/latest-writeback-settled-course.tsk',
      settledDialogId,
      'tester',
    );
    await settledDialog.notifyGeneratingStart('settled-course-msg');
    await settledDialog.notifyGeneratingFinish();
    await settledStore.startNewCourse(settledDialog, {
      content: 'continue in course two after the previous generation already finished',
      msgId: 'pending-settled-runtime-prompt-msg',
      grammar: 'markdown',
      origin: 'runtime',
      userLanguageCode: 'en',
    });
    const latestAfterSettledGeneration = await DialogPersistence.loadDialogLatest(settledDialogId);
    assert.ok(
      latestAfterSettledGeneration,
      'Expected latest after queueing a new course on a settled dialog',
    );
    assert.equal(latestAfterSettledGeneration.generating, false);
    assert.deepEqual(latestAfterSettledGeneration.displayState, {
      kind: 'stopped',
      reason: { kind: 'pending_runtime_prompt' },
      continueEnabled: true,
    });
    assert.deepEqual(latestAfterSettledGeneration.executionMarker, {
      kind: 'interrupted',
      reason: { kind: 'pending_runtime_prompt' },
    });
    assert.equal(
      latestAfterSettledGeneration.pendingRuntimePrompt?.msgId,
      'pending-settled-runtime-prompt-msg',
    );

    // Invariant 10: run-control helpers must update the requested persistence status bucket.
    const completedRunControlDialogId = new DialogID('74/6e/completedctl');
    const completedRunControlMetadata: MainDialogMetadataFile = {
      id: completedRunControlDialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback-completed-run-control.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:05:20.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(
      completedRunControlDialogId,
      completedRunControlMetadata,
      'completed',
    );
    await DialogPersistence.mutateDialogLatest(
      completedRunControlDialogId,
      () => ({
        kind: 'replace',
        next: {
          currentCourse: 1,
          lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:05:21.000Z')),
          status: 'completed',
          generating: false,
          nextStep: createEmptyDialogNextStepState(),
          tellaskCalls: createEmptyDialogTellaskCallState(),
          tellaskResults: createEmptyDialogTellaskResultState(),
          displayState: { kind: 'idle_waiting_user' },
          messageCount: 0,
          functionCallCount: 0,
          sideDialogCount: 0,
          disableDiligencePush: false,
          diligencePushRemainingBudget: 0,
        },
      }),
      'completed',
    );
    await setDialogExecutionMarker(
      completedRunControlDialogId,
      { kind: 'interrupted', reason: { kind: 'user_stop' } },
      'completed',
    );
    await setDialogDisplayState(
      completedRunControlDialogId,
      { kind: 'idle_waiting_user' },
      'completed',
    );
    const completedRunControlLatest = await DialogPersistence.loadDialogLatest(
      completedRunControlDialogId,
      'completed',
    );
    assert.ok(completedRunControlLatest, 'Expected completed latest after run-control updates');
    assert.deepEqual(completedRunControlLatest.displayState, { kind: 'idle_waiting_user' });
    assert.equal(completedRunControlLatest.executionMarker, undefined);
    assert.equal(
      await DialogPersistence.loadDialogLatest(completedRunControlDialogId, 'running'),
      null,
      'completed run-control updates must not create a running latest.yaml',
    );

    // Invariant 11: a new-course runtime prompt should be able to supersede a stale prior-course
    // followup without losing the live generation path.
    const supersedeDialogId = new DialogID('74/6e/da2d0178');
    const supersedeMetadata: MainDialogMetadataFile = {
      id: supersedeDialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback-supersede-course.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:05:30.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(supersedeDialogId, supersedeMetadata, 'running');
    await DialogPersistence.mutateDialogLatest(supersedeDialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 2,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:05:31.000Z')),
        status: 'active',
        generating: false,
        nextStep: {
          nextSeq: 3,
          triggers: [
            {
              triggerId: 'followup:c1:g1',
              kind: 'followup',
              sourceGeneration: {
                course: 1,
                genseq: 1,
              },
              reasons: [{ kind: 'reply_delivery_result', replyDeliveryId: 'reply-delivery:old' }],
              continuation: { kind: 'none' },
              createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:05:31.000Z')),
              seq: 1,
            },
          ],
        },
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
        displayState: { kind: 'proceeding' },
        messageCount: 0,
        functionCallCount: 0,
        sideDialogCount: 0,
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));
    const supersedeStore = new DiskFileDialogStore(supersedeDialogId);
    const supersedeDialog = new MainDialog(
      supersedeStore,
      'plans/latest-writeback-supersede-course.tsk',
      supersedeDialogId,
      'tester',
    );
    await supersedeDialog.notifyGeneratingStart('supersede-new-course-msg');
    await supersedeStore.startNewCourse(supersedeDialog, {
      content: 'continue with the new course and ignore stale prior followup',
      msgId: 'pending-supersede-runtime-prompt-msg',
      grammar: 'markdown',
      origin: 'runtime',
      userLanguageCode: 'en',
    });
    const latestAfterSupersede = await DialogPersistence.loadDialogLatest(supersedeDialogId);
    assert.ok(latestAfterSupersede, 'Expected latest after superseding stale followup');
    assert.equal(latestAfterSupersede.generating, true);
    assert.equal(
      latestAfterSupersede.pendingRuntimePrompt?.msgId,
      'pending-supersede-runtime-prompt-msg',
    );
    assert.equal(
      latestAfterSupersede.nextStep.triggers.some(
        (trigger) => trigger.kind === 'followup' && trigger.triggerId === 'followup:c1:g1',
      ),
      false,
      'stale prior-course followup should be removed when the new runtime prompt takes precedence',
    );
    assert.equal(
      latestAfterSupersede.nextStep.triggers.some(
        (trigger) =>
          trigger.kind === 'queued_prompt' &&
          trigger.promptId === 'pending-supersede-runtime-prompt-msg',
      ),
      true,
      'queued runtime prompt should remain as the live continuation for the new course',
    );

    // Invariant 12: transient Windows-style filesystem failures must be retried for wake queue.
    const driveRootId = new DialogID('73/6d/da1d0177');
    const driveSideId = new DialogID('74/6d/da1d0177', driveRootId.selfId);
    const driveLatest = {
      currentCourse: 1,
      lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:06:00.000Z')),
      status: 'active',
      nextStep: {
        nextSeq: 1,
        triggers: [
          {
            triggerId: 'wake-queue-trigger',
            kind: 'result_arrival',
            batchId: 'wake-queue-batch',
            createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:06:00.000Z')),
            seq: 1,
          },
        ],
      },
      tellaskCalls: createEmptyDialogTellaskCallState(),
      tellaskResults: createEmptyDialogTellaskResultState(),
      displayState: { kind: 'proceeding' },
      messageCount: 0,
      functionCallCount: 0,
      sideDialogCount: 0,
      disableDiligencePush: false,
      diligencePushRemainingBudget: 0,
    } satisfies Parameters<typeof DialogPersistence.syncWakeQueueForDialogLatest>[1];
    const noDriveLatest = {
      ...driveLatest,
      nextStep: createEmptyDialogNextStepState(),
    } satisfies Parameters<typeof DialogPersistence.syncWakeQueueForDialogLatest>[1];
    const fsForPatch = fsNode.promises as unknown as {
      rename: typeof fsNode.promises.rename;
      rm: typeof fsNode.promises.rm;
    };
    const originalRename = fsForPatch.rename;
    const originalRm = fsForPatch.rm;
    let wakeQueueRenameAttempts = 0;
    let wakeQueueRmAttempts = 0;
    try {
      fsForPatch.rename = async (source, destination) => {
        if (path.basename(destination) === 'wake-queue.jsonl') {
          wakeQueueRenameAttempts += 1;
          if (wakeQueueRenameAttempts === 1) {
            const error = new Error('simulated transient EPERM for wake queue');
            (error as NodeJS.ErrnoException).code = 'EPERM';
            throw error;
          }
        }
        return originalRename(source, destination);
      };

      await DialogPersistence.syncWakeQueueForDialogLatest(driveSideId, driveLatest, 'running');
      const wakeQueueTargetIds = await DialogPersistence.loadWakeQueueTargetDialogIds(
        driveRootId,
        'running',
      );
      assert.deepEqual(
        wakeQueueTargetIds.map((dialogId) => dialogId.selfId),
        [driveSideId.selfId],
      );
      assert.equal(wakeQueueRenameAttempts, 2);

      fsForPatch.rm = async (target) => {
        if (path.basename(target) === 'wake-queue.jsonl') {
          wakeQueueRmAttempts += 1;
          if (wakeQueueRmAttempts === 1) {
            const error = new Error('simulated transient EPERM for wake queue removal');
            (error as NodeJS.ErrnoException).code = 'EPERM';
            throw error;
          }
        }
        return originalRm(target);
      };

      await DialogPersistence.syncWakeQueueForDialogLatest(driveSideId, noDriveLatest, 'running');
      const clearedWakeQueueTargetIds = await DialogPersistence.loadWakeQueueTargetDialogIds(
        driveRootId,
        'running',
      );
      assert.deepEqual(clearedWakeQueueTargetIds, []);
      assert.equal(wakeQueueRmAttempts, 2);
    } finally {
      fsForPatch.rename = originalRename;
      fsForPatch.rm = originalRm;
    }

    // Invariant 13: root runtime wake is a Wake Queue fact independent from root latest sync.
    await DialogPersistence.upsertRootRuntimeWake(
      driveRootId,
      'latest_writeback_preserve_root_runtime_wake',
      'running',
    );
    await DialogPersistence.syncWakeQueueForDialogLatest(driveRootId, noDriveLatest, 'running');
    assert.equal(
      await DialogPersistence.hasRootRuntimeWake(driveRootId, 'running'),
      true,
      'root latest sync must not erase the independent root runtime wake entry',
    );
    await DialogPersistence.removeWakeQueueEntriesForDialog(driveRootId, 'running');
    assert.equal(
      await DialogPersistence.hasRootRuntimeWake(driveRootId, 'running'),
      false,
      'explicit root wake queue removal should remove the root runtime wake entry',
    );

    // Invariant 14: malformed Wake Queue JSONL records fail loudly with line diagnostics.
    const invalidWakeQueueRootId = new DialogID('73/6d/da1d0178');
    const invalidWakeQueuePath = path.join(
      sandboxDir,
      '.dialogs',
      'run',
      invalidWakeQueueRootId.selfId,
      'wake-queue.jsonl',
    );
    await fs.mkdir(path.dirname(invalidWakeQueuePath), { recursive: true });
    await fs.writeFile(
      invalidWakeQueuePath,
      [
        JSON.stringify({
          entryId: `root-runtime-wake:${invalidWakeQueueRootId.selfId}:latest_writeback_valid_before_invalid_trigger_kind`,
          kind: 'root_runtime_wake',
          targetDialogId: invalidWakeQueueRootId.selfId,
          reason: 'latest_writeback_valid_before_invalid_trigger_kind',
        }),
        JSON.stringify({
          entryId: `next-step-trigger:${invalidWakeQueueRootId.selfId}:bad-trigger-kind`,
          kind: 'next_step_trigger',
          targetDialogId: invalidWakeQueueRootId.selfId,
          triggerId: 'bad-trigger-kind',
          triggerKind: 'not_a_real_trigger_kind',
        }),
        '',
      ].join('\n'),
      'utf-8',
    );
    await assert.rejects(
      DialogPersistence.loadWakeQueueEntries(invalidWakeQueueRootId, 'running'),
      (error: unknown) => {
        assert.ok(error instanceof DomindsPersistenceFileError);
        assert.equal(error.source, 'wake_queue');
        assert.equal(error.format, 'jsonl');
        assert.equal(error.operation, 'parse');
        assert.equal(error.lineNumber, 2);
        return true;
      },
    );

    const wakeQueuePath = path.join(
      sandboxDir,
      '.dialogs',
      'run',
      driveRootId.selfId,
      'wake-queue.jsonl',
    );
    await fs.mkdir(path.dirname(wakeQueuePath), { recursive: true });
    await fs.writeFile(
      wakeQueuePath,
      [
        JSON.stringify({
          entryId: `root-runtime-wake:${driveRootId.selfId}:latest_writeback_jsonl_line_failure`,
          kind: 'root_runtime_wake',
          targetDialogId: driveRootId.selfId,
          reason: 'latest_writeback_jsonl_line_failure',
        }),
        '{not-json',
        '',
      ].join('\n'),
      'utf-8',
    );
    await assert.rejects(
      DialogPersistence.loadWakeQueueEntries(driveRootId, 'running'),
      (error: unknown) => {
        assert.ok(error instanceof DomindsPersistenceFileError);
        assert.equal(error.source, 'wake_queue');
        assert.equal(error.format, 'jsonl');
        assert.equal(error.operation, 'parse');
        assert.equal(error.lineNumber, 2);
        return true;
      },
    );
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
