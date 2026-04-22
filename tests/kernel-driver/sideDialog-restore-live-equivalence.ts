import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream, restoreDialogHierarchy } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTeammateResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  lastAssistantSaying,
  listTellaskResultContents,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger sideDialog and then verify restore/live equivalence.';
    const rootFirstResponse = 'Start.';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please compute 1+1.\nReturn only the number.';
    const language = getWorkLanguage();

    const expectedSideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList,
        tellaskContent: tellaskBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const sideDialogResponseText = '2';
    const mirroredSideDialogResponse = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      callId: 'root-call-pangu',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: sideDialogResponseText,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    const resumeResponse = 'Ack: restore/live comparison ready.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: rootFirstResponse,
        funcCalls: [
          {
            id: 'root-call-pangu',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      { message: expectedSideDialogPrompt, role: 'user', response: sideDialogResponseText },
      { message: mirroredSideDialogResponse, role: 'tool', response: resumeResponse },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-restore-live-equivalence'),
      true,
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === resumeResponse,
      3_000,
      'root dialog to generate after sideDialog response',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const liveContents = listTellaskResultContents(dlg.msgs);
    assert.ok(
      liveContents.includes(mirroredSideDialogResponse),
      'live dialog should contain mirrored tellask_result_msg content with canonical transfer payload',
    );

    await DialogPersistence.moveDialogStatus(dlg.id, 'running', 'completed');
    globalDialogRegistry.unregister(dlg.id.rootId);

    const restored = await restoreDialogHierarchy(dlg.id.rootId, 'completed');
    const restoredContents = listTellaskResultContents(restored.mainDialog.msgs);
    assert.ok(
      restoredContents.includes(mirroredSideDialogResponse),
      'restored dialog should contain teammate-response tellask_result_msg content with canonical transfer payload',
    );

    const uniqSorted = (items: string[]): string[] => Array.from(new Set(items)).sort();
    assert.deepEqual(
      uniqSorted(restoredContents),
      uniqSorted(liveContents),
      'restored and live tellask_result_msg content sets should be equivalent',
    );
  });

  console.log('kernel-driver sideDialog-restore-live-equivalence: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-restore-live-equivalence: FAIL\n${message}`);
  process.exit(1);
});
