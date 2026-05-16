import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { refreshRunControlProjectionFromPersistenceFacts } from '../../main/dialog-display-state';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import type { KernelDriverRuntimeSideDialogPrompt } from '../../main/llm/kernel-driver/types';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { isReplyToolReminderPromptContent } from '../../main/runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  lastAssistantSaying,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

type CapturedScheduledDrive = Readonly<{
  dialogSelfId: string;
  hasHumanPrompt: boolean;
  reason: string;
}>;

function findLastMeaningfulTailEvent(
  events: Awaited<ReturnType<typeof DialogPersistence.loadCourseEvents>>,
): (typeof events)[number] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === 'tellask_reply_resolution_record' ||
      event.type === 'gen_finish_record' ||
      event.type === 'func_result_record'
    ) {
      continue;
    }
    return event;
  }
  return events[events.length - 1];
}

async function waitForCapturedDrive(
  captured: CapturedScheduledDrive[],
  timeoutMs: number,
): Promise<CapturedScheduledDrive> {
  await waitFor(
    async () => captured.length > 0,
    timeoutMs,
    'sideDialog reply-obligation follow-up to be scheduled',
  );
  const first = captured[0];
  if (!first) {
    throw new Error('captured scheduled drive disappeared after wait');
  }
  return first;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger a registered side dialog and let it finish cleanly.';
    const rootFirstResponse = 'Start.';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please answer 1+1 with exactly `2`.';
    const sessionSlug = 'sticky-session';
    const language = getWorkLanguage();

    const expectedSideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList,
        tellaskContent: tellaskBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    const sideDialogFinalResponse = '2';
    const mirroredSideDialogResponse = formatTellaskResponseContent({
      callName: 'tellask',
      callId: 'root-call-pangu-sticky',
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: sideDialogFinalResponse,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
      sessionSlug,
    });
    const rootFinalResponse = 'Ack: final registered side dialog result received.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: rootFirstResponse,
        funcCalls: [
          {
            id: 'root-call-pangu-sticky',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      {
        message: expectedSideDialogPrompt,
        role: 'user',
        response: sideDialogFinalResponse,
      },
      {
        message: mirroredSideDialogResponse,
        role: 'tool',
        response: rootFinalResponse,
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-no-empty-autodrive-after-final-response'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === rootFinalResponse,
      3_000,
      'main dialog to receive final registered side dialog result',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const sideDialog = dlg.lookupSideDialog('pangu', sessionSlug);
    assert.ok(sideDialog, 'expected registered sideDialog to exist after tellask completion');

    const eventsBefore = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const genStartCountBefore = eventsBefore.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventBefore = findLastMeaningfulTailEvent(eventsBefore);
    assert.ok(
      lastEventBefore?.type === 'tellask_anchor_record' &&
        lastEventBefore.anchorRole === 'response',
      'expected sideDialog to end its finalized round at a response anchor',
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        nextStep: {
          nextSeq: 2,
          triggers: [
            {
              triggerId: `backend-queue:${sideDialog.id.selfId}`,
              kind: 'backend_queue',
              reason: 'stale_final_response_autodrive_test',
              course: sideDialog.currentCourse,
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
        displayState: { kind: 'proceeding' },
        executionMarker: undefined,
      },
    }));

    await driveDialogStream(
      sideDialog,
      undefined,
      true,
      makeDriveOptions({
        suppressDiligencePush: true,
        source: 'unspecified',
        reason: 'stale_auto_drive_probe',
      }),
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const eventsAfter = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const genStartCountAfter = eventsAfter.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventAfter = findLastMeaningfulTailEvent(eventsAfter);

    assert.equal(
      genStartCountAfter,
      genStartCountBefore,
      'stale queued auto-drive must not open a new generation after final response anchor',
    );
    assert.deepEqual(
      lastEventAfter,
      lastEventBefore,
      'stale queued auto-drive must leave the finalized sideDialog tail untouched',
    );
    const latestAfter = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(
      latestAfter?.generating,
      false,
      'stale queued auto-drive should clear stale sideDialog generating after final response anchor',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfter),
      false,
      'stale queued auto-drive should clear stale sideDialog pending next-step triggers after final response anchor',
    );
    assert.deepEqual(
      latestAfter?.displayState,
      { kind: 'idle_waiting_user' },
      'stale queued auto-drive should clear stale final-response interruption projection',
    );
    assert.equal(latestAfter?.executionMarker, undefined);

    await DialogPersistence.setActiveTellaskReplyObligation(
      sideDialog.id,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.id.selfId,
        targetCallId: 'root-call-pangu-sticky',
        tellaskContent: tellaskBody,
      },
      sideDialog.status,
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_reply_obligation' },
          continueEnabled: true,
        },
        executionMarker: {
          kind: 'interrupted',
          reason: { kind: 'pending_reply_obligation' },
        },
      },
    }));

    const healedAfterRestart = await refreshRunControlProjectionFromPersistenceFacts(
      sideDialog.id,
      'run_control_snapshot',
    );
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(sideDialog.id, sideDialog.status),
      undefined,
      'final-response heal should clear stale active reply obligation matching the response anchor callId',
    );
    assert.deepEqual(
      healedAfterRestart?.displayState,
      { kind: 'idle_waiting_user' },
      'final-response heal should not leave a stale Continue button after clearing reply obligation',
    );
    assert.equal(
      healedAfterRestart?.executionMarker,
      undefined,
      'final-response heal should clear stale pending-reply execution marker',
    );

    await DialogPersistence.setActiveTellaskReplyObligation(
      sideDialog.id,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.id.selfId,
        targetCallId: 'different-active-reply-call',
        tellaskContent: 'A distinct active reply must not be cleared by final-response healing.',
      },
      sideDialog.status,
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_reply_obligation' },
          continueEnabled: true,
        },
        executionMarker: {
          kind: 'interrupted',
          reason: { kind: 'pending_reply_obligation' },
        },
      },
    }));

    const preservedAfterMismatchedHeal = await refreshRunControlProjectionFromPersistenceFacts(
      sideDialog.id,
      'run_control_snapshot',
    );
    const preservedObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      preservedObligation?.targetCallId,
      'different-active-reply-call',
      'final-response heal must not clear an active reply obligation for another callId',
    );
    assert.deepEqual(
      preservedAfterMismatchedHeal?.displayState,
      { kind: 'idle_waiting_user' },
      'mismatched active reply obligation should remain completion state without keeping the sideDialog resumable',
    );

    const sessionlessRoot = await createMainDialog('tester');
    sessionlessRoot.disableDiligencePush = true;
    const sessionlessRequest = 'Clean up duplicate source files and continue validation.';
    const sessionlessSideDialog = await sessionlessRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      sessionlessRequest,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: sessionlessRoot.id.selfId,
        callId: 'sessionless-cleanup-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.saveActiveCalleeDispatches(sessionlessRoot.id, [
      {
        calleeDialogId: sessionlessSideDialog.id.selfId,
        createdAt: formatUnifiedTimestamp(new Date()),
        batchId: 'sessionless-cleanup-call-batch',
        callName: 'tellaskSessionless',
        mentionList: ['@pangu'],
        tellaskContent: sessionlessRequest,
        targetAgentId: 'pangu',
        callId: 'sessionless-cleanup-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'C',
      },
    ]);
    const sessionlessPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: sessionlessRequest,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    await writeMockDb(tmpRoot, [
      {
        message: sessionlessPrompt,
        role: 'user',
        response: 'Still trying selectors.',
        funcCalls: [
          {
            id: 'sessionless-invalid-env-get',
            name: 'env_get',
            arguments: { key: 'not-valid-key' },
          },
        ],
      },
      {
        message:
          'Invalid arguments: Error: env_get.key must be a valid environment variable name matching /^[A-Za-z_][A-Za-z0-9_]*$/',
        role: 'tool',
        response: '',
        thinkingResponse: 'I tried several selectors and still have work to do before replying.',
      },
    ]);

    const capturedScheduledDrives: CapturedScheduledDrive[] = [];
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        sessionlessSideDialog,
        {
          content: sessionlessPrompt,
          msgId: 'side-dialog-sessionless-reply-assignment',
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: {
            expectedReplyCallName: 'replyTellaskSessionless',
            targetDialogId: sessionlessRoot.id.selfId,
            targetCallId: 'sessionless-cleanup-call',
            tellaskContent: sessionlessRequest,
          },
          calleeDialogReplyTarget: {
            callerDialogId: sessionlessRoot.id.selfId,
            callType: 'C',
            callId: 'sessionless-cleanup-call',
            callSiteCourse: 1,
            callSiteGenseq: 1,
          },
        } satisfies KernelDriverRuntimeSideDialogPrompt,
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
          source: 'kernel_driver_sideDialog_init',
          reason: 'sessionless_reply_tail_probe',
        }),
      ],
      scheduleDrive: (scheduledDialog, options) => {
        capturedScheduledDrives.push({
          dialogSelfId: scheduledDialog.id.selfId,
          hasHumanPrompt: options.humanPrompt !== undefined,
          reason: options.driveOptions?.reason ?? '',
        });
      },
      driveDialog: async () => {
        throw new Error('test does not use nested driveDialog invocations');
      },
    });

    const scheduled = await waitForCapturedDrive(capturedScheduledDrives, 3_000);
    assert.equal(
      scheduled.dialogSelfId,
      sessionlessSideDialog.id.selfId,
      'sideDialog reply obligation should schedule the same dialog',
    );
    assert.equal(
      scheduled.hasHumanPrompt,
      false,
      'reply-obligation follow-up should be queued onto the dialog instead of passed as a fresh user prompt',
    );
    assert.equal(scheduled.reason, 'follow_up_prompt');
    const queuedReplyReminder = sessionlessSideDialog.peekUpNext();
    assert.equal(
      queuedReplyReminder?.kind,
      'new_course_runtime_sideDialog',
      'reply-obligation tail resolution should persist a sideDialog runtime prompt',
    );
    assert.equal(
      queuedReplyReminder?.tellaskReplyDirective.targetCallId,
      'sessionless-cleanup-call',
      'queued reply reminder should carry the active reply obligation',
    );
    assert.equal(
      queuedReplyReminder?.calleeDialogReplyTarget.callId,
      'sessionless-cleanup-call',
      'queued reply reminder should target the pending tellask call',
    );
    assert.equal(
      isReplyToolReminderPromptContent(queuedReplyReminder?.prompt ?? ''),
      true,
      'post-tool thinking-only reply candidate should use the normal reply reminder path',
    );
    assert.equal(
      sessionlessSideDialog.hasUpNext(),
      true,
      'reply-obligation follow-up should continue the normal business state machine without manual Continue',
    );
  });

  console.log('kernel-driver sideDialog-no-empty-autodrive-after-final-response: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-no-empty-autodrive-after-final-response: FAIL\n${message}`,
  );
  process.exit(1);
});
