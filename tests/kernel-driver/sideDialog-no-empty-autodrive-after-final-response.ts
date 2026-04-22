import assert from 'node:assert/strict';

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
      requesterId: 'tester',
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
      lastEventBefore?.type === 'tellask_call_anchor_record' &&
        lastEventBefore.anchorRole === 'response',
      'expected sideDialog to end its finalized round at a response anchor',
    );

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
