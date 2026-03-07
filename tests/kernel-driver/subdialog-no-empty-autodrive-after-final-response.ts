import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger a registered sideline and let it finish cleanly.';
    const rootFirstResponse = 'Start.';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please answer 1+1 with exactly `2`.';
    const sessionSlug = 'sticky-session';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      callName: 'tellask',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList,
      tellaskContent: tellaskBody,
      language,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });
    const subdialogFinalResponse = '2';
    const mirroredSubdialogResponse = formatTeammateResponseContent({
      callName: 'tellask',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: subdialogFinalResponse,
      status: 'completed',
      language,
      sessionSlug,
    });
    const rootFinalResponse = 'Ack: final registered sideline result received.';

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
        message: expectedSubdialogPrompt,
        role: 'user',
        response: subdialogFinalResponse,
      },
      {
        message: mirroredSubdialogResponse,
        role: 'tool',
        response: rootFinalResponse,
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-subdialog-no-empty-autodrive-after-final-response',
        grammar: 'markdown',
      },
      true,
      { suppressDiligencePush: true },
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === rootFinalResponse,
      3_000,
      'root dialog to receive final registered sideline result',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const subdialog = dlg.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected registered subdialog to exist after tellask completion');

    const eventsBefore = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    const genStartCountBefore = eventsBefore.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventBefore = eventsBefore[eventsBefore.length - 1];
    assert.ok(
      lastEventBefore?.type === 'teammate_call_anchor_record' &&
        lastEventBefore.anchorRole === 'response',
      'expected subdialog to end its finalized round at a response anchor',
    );

    await driveDialogStream(subdialog, undefined, true, {
      suppressDiligencePush: true,
      source: 'unspecified',
      reason: 'stale_auto_drive_probe',
    });
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const eventsAfter = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    const genStartCountAfter = eventsAfter.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventAfter = eventsAfter[eventsAfter.length - 1];

    assert.equal(
      genStartCountAfter,
      genStartCountBefore,
      'stale queued auto-drive must not open a new generation after final response anchor',
    );
    assert.deepEqual(
      lastEventAfter,
      lastEventBefore,
      'stale queued auto-drive must leave the finalized subdialog tail untouched',
    );
  });

  console.log('kernel-driver subdialog-no-empty-autodrive-after-final-response: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver subdialog-no-empty-autodrive-after-final-response: FAIL\n${message}`,
  );
  process.exit(1);
});
