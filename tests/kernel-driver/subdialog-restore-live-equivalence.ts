import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream } from '../../main/llm/driver-entry';
import { restoreDialogHierarchy } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import { formatAssignmentFromSupdialog } from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  listTellaskResultContents,
  persistRootDialogMetadata,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger subdialog and then verify restore/live equivalence.';
    const rootFirstResponse = 'Start.';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please compute 1+1.\nReturn only the number.';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      callName: 'tellaskSessionless',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList,
      tellaskContent: tellaskBody,
      language,
      collectiveTargets: ['pangu'],
    });
    const subdialogResponseText = '2';
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
      { message: expectedSubdialogPrompt, role: 'user', response: subdialogResponseText },
      { message: subdialogResponseText, role: 'tool', response: resumeResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;
    await persistRootDialogMetadata(dlg);

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'kernel-driver-restore-live-equivalence', grammar: 'markdown' },
      true,
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === resumeResponse,
      3_000,
      'root dialog to generate after subdialog response',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const liveContents = listTellaskResultContents(dlg.msgs);
    assert.ok(
      liveContents.includes(subdialogResponseText),
      'live dialog should contain mirrored tellask_result_msg content with raw response text',
    );

    await DialogPersistence.moveDialogStatus(dlg.id, 'running', 'completed');
    globalDialogRegistry.unregister(dlg.id.rootId);

    const restored = await restoreDialogHierarchy(dlg.id.rootId, 'completed');
    const restoredContents = listTellaskResultContents(restored.rootDialog.msgs);
    assert.ok(
      restoredContents.includes(subdialogResponseText),
      'restored dialog should contain teammate-response tellask_result_msg content with raw response text',
    );

    const uniqSorted = (items: string[]): string[] => Array.from(new Set(items)).sort();
    assert.deepEqual(
      uniqSorted(restoredContents),
      uniqSorted(liveContents),
      'restored and live tellask_result_msg content sets should be equivalent',
    );
  });

  console.log('kernel-driver subdialog-restore-live-equivalence: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-restore-live-equivalence: FAIL\n${message}`);
  process.exit(1);
});
