import assert from 'node:assert/strict';

import { refreshRunControlProjectionFromPersistenceFacts } from '../../main/dialog-display-state';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
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
        needsDrive: true,
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
      latestAfter?.needsDrive,
      false,
      'stale queued auto-drive should clear stale sideDialog needsDrive after final response anchor',
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
      {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      'mismatched active reply obligation should keep the sideDialog resumable',
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
