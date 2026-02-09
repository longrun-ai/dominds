import assert from 'node:assert/strict';

import { requestInterruptDialog } from '../../main/dialog-run-state';
import { driveDialogStream } from '../../main/llm/driver';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  parseSingleTellaskCall,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger subdialog then interrupt auto-revive drive.';
    const rootFirstResponse = [
      'Start.',
      '!?@pangu Please compute 1+1.',
      '!?Return only the number.',
      'separator',
    ].join('\n');
    const parsed = await parseSingleTellaskCall(rootFirstResponse);
    const language = getWorkLanguage();
    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      tellaskHead: parsed.tellaskHead,
      tellaskBody: parsed.body,
      language,
      collectiveTargets: ['pangu'],
    });
    const subdialogResponseText = '2';
    const expectedInjected = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      originalCallHeadLine: parsed.tellaskHead,
      responseBody: subdialogResponseText,
      language,
    });
    const resumeResponse = 'Ack: rollback path consumed queued response.';

    await writeMockDb(tmpRoot, [
      { message: trigger, role: 'user', response: rootFirstResponse },
      { message: expectedSubdialogPrompt, role: 'user', response: subdialogResponseText },
      // Delay this response so the test can interrupt while auto-revive drive is in-flight.
      { message: expectedInjected, role: 'user', response: resumeResponse, delayMs: 1800 },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'driver-v2-subdialog-rollback-trigger', grammar: 'markdown' },
      true,
    );

    await waitFor(async () => dlg.isLocked(), 4_000, 'root auto-revive drive to start');

    const interruptResult = await requestInterruptDialog(dlg.id, 'user_stop');
    assert.equal(
      interruptResult.applied,
      true,
      'interrupt should be applied to in-flight auto-revive',
    );

    await waitFor(async () => !dlg.isLocked(), 4_000, 'root unlock after interruption');

    const queuedAfterInterrupt = await DialogPersistence.loadSubdialogResponsesQueue(dlg.id);
    assert.equal(
      queuedAfterInterrupt.length,
      1,
      'queued subdialog response should be rolled back after interrupted drive',
    );

    await driveDialogStream(dlg, undefined, true, { suppressDiligencePush: true });
    await waitFor(
      async () => lastAssistantSaying(dlg) === resumeResponse,
      4_000,
      'manual retry drive to consume rolled-back response',
    );
    await waitForAllDialogsUnlocked(dlg, 4_000);

    const queueAfterRetry = await DialogPersistence.loadSubdialogResponsesQueue(dlg.id);
    assert.equal(queueAfterRetry.length, 0, 'queue should be empty after successful retry drive');
  });

  console.log('driver-v2 subdialog-queue-interrupt-rollback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 subdialog-queue-interrupt-rollback: FAIL\n${message}`);
  process.exit(1);
});
