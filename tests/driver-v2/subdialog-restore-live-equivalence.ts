import assert from 'node:assert/strict';

import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { restoreDialogHierarchy } from '../../main/llm/driver';
import { driveDialogStream } from '../../main/llm/driver-entry';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
  listTellaskResultContents,
  parseSingleTellaskCall,
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
    const resumeResponse = 'Ack: restore/live comparison ready.';

    await writeMockDb(tmpRoot, [
      { message: trigger, role: 'user', response: rootFirstResponse },
      { message: expectedSubdialogPrompt, role: 'user', response: subdialogResponseText },
      { message: expectedInjected, role: 'user', response: resumeResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;
    await persistRootDialogMetadata(dlg);

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'driver-v2-restore-live-equivalence', grammar: 'markdown' },
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
      liveContents.includes(expectedInjected),
      'live dialog should contain mirrored tellask_result_msg',
    );

    await DialogPersistence.moveDialogStatus(dlg.id, 'running', 'completed');
    globalDialogRegistry.unregister(dlg.id.rootId);

    const restored = await restoreDialogHierarchy(dlg.id.rootId, 'completed');
    const restoredContents = listTellaskResultContents(restored.rootDialog.msgs);
    assert.ok(
      restoredContents.includes(expectedInjected),
      'restored dialog should contain teammate-response tellask_result_msg',
    );

    const uniqSorted = (items: string[]): string[] => Array.from(new Set(items)).sort();
    assert.deepEqual(
      uniqSorted(restoredContents),
      uniqSorted(liveContents),
      'restored and live tellask_result_msg content sets should be equivalent',
    );
  });

  console.log('driver-v2 subdialog-restore-live-equivalence: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 subdialog-restore-live-equivalence: FAIL\n${message}`);
  process.exit(1);
});
