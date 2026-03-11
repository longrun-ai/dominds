import assert from 'node:assert/strict';

import { buildClearedMindInvalidationNotice } from '../../main/course-transition';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage, setWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  listTellaskResultContents,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Ask @pangu and let the callee clear mind mid-flight.';
    const rootFirstResponse = 'Starting tellask.';
    const mentionList = ['@pangu'];
    const tellaskContent = 'Please inspect the problem and come back with the answer.';
    const language = getWorkLanguage();

    const subdialogPrompt = formatAssignmentFromSupdialog({
      callName: 'tellaskSessionless',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList,
      tellaskContent,
      language,
      collectiveTargets: ['pangu'],
    });
    const failedResponseContent = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent,
      responseBody: buildClearedMindInvalidationNotice(language),
      status: 'failed',
      language,
    });
    const subdialogCourse2Prompt = `${subdialogPrompt}\n---\nThis is course #2 of the dialog. You just cleared your mind; please proceed with the task.`;
    const rootAfterFailure = 'Acknowledged. I will re-tellask with fresh context.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: rootFirstResponse,
        funcCalls: [
          {
            id: 'root-call-clear-mind-invalidates-waiters',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent,
            },
          },
        ],
      },
      {
        message: subdialogPrompt,
        role: 'user',
        response: 'Clearing mind now.',
        funcCalls: [
          {
            id: 'subdialog-clear-mind',
            name: 'clear_mind',
            arguments: {
              reminder_content: 'Rebuild context from a fresh tellask only.',
            },
          },
        ],
      },
      {
        message: failedResponseContent,
        role: 'tool',
        response: rootAfterFailure,
      },
      {
        message: subdialogCourse2Prompt,
        role: 'user',
        response: 'Fresh course started; waiting for a brand-new tellask.',
      },
    ]);

    const rootDialog = await createRootDialog('tester');
    rootDialog.disableDiligencePush = true;

    await driveDialogStream(
      rootDialog,
      {
        content: trigger,
        msgId: 'kernel-driver-subdialog-clear-mind-invalidates-waiters',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    await waitFor(
      async () => lastAssistantSaying(rootDialog) === rootAfterFailure,
      3_000,
      'root dialog to resume after cleared-mind failure reply',
    );
    await waitForAllDialogsUnlocked(rootDialog, 3_000);

    const pending = await DialogPersistence.loadPendingSubdialogs(rootDialog.id, rootDialog.status);
    assert.equal(
      pending.length,
      0,
      'caller pending-subdialogs should be cleared after callee clear_mind',
    );

    const tellaskResults = listTellaskResultContents(rootDialog.msgs);
    assert.ok(
      tellaskResults.includes(failedResponseContent),
      'caller should receive a failed tellask_result_msg explaining the callee cleared mind',
    );

    const allDialogs = rootDialog.getAllDialogs();
    const subdialog = allDialogs.find((dialog) => dialog.id.selfId !== rootDialog.id.selfId);
    assert.ok(subdialog, 'expected a subdialog to exist');
    assert.equal(subdialog.currentCourse, 2, 'callee subdialog should advance to course #2');
  });

  console.log('kernel-driver subdialog-clear-mind-invalidates-waiters: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-clear-mind-invalidates-waiters: FAIL\n${message}`);
  process.exit(1);
});
