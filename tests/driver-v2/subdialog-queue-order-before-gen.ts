import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
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
  parseSingleTellaskCall,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function findMirroredTeammateResultIndex(
  msgs: readonly ChatMessage[],
  expectedContent: string,
): number {
  return msgs.findIndex(
    (msg) =>
      msg.type === 'tellask_result_msg' && msg.role === 'tool' && msg.content === expectedContent,
  );
}

function findAssistantSayingIndex(msgs: readonly ChatMessage[], content: string): number {
  return msgs.findIndex(
    (msg) => msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === content,
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger subdialog and verify response ordering without queue injection.';
    const rootFirstResponse = [
      'Start.',
      '!?@pangu Please compute 1+1.',
      '!?Return only the number.',
      'separator',
    ].join('\n');
    const parsed = await parseSingleTellaskCall(rootFirstResponse);
    const tellaskHead = parsed.tellaskHead;
    const tellaskBody = parsed.body;
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      tellaskHead,
      tellaskBody,
      language,
      collectiveTargets: ['pangu'],
    });
    const subdialogResponseText = '2';
    const expectedInjected = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      originalCallHeadLine: tellaskHead,
      responseBody: subdialogResponseText,
      language,
    });
    const resumeResponse = 'Ack: subdialog response was visible before follow-up generation.';

    await writeMockDb(tmpRoot, [
      { message: trigger, role: 'user', response: rootFirstResponse },
      { message: expectedSubdialogPrompt, role: 'user', response: subdialogResponseText },
      { message: expectedInjected, role: 'tool', response: resumeResponse },
      { message: expectedInjected, role: 'user', response: resumeResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'driver-v2-subdialog-order-before-gen', grammar: 'markdown' },
      true,
      { suppressDiligencePush: true },
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === resumeResponse,
      3_000,
      'root dialog to generate follow-up from subdialog response',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const queueAfter = await DialogPersistence.loadSubdialogResponsesQueue(dlg.id);
    assert.equal(
      queueAfter.length,
      0,
      'driver-v2 should not rely on persisted subdialog response queue',
    );

    const mirrorIndex = findMirroredTeammateResultIndex(dlg.msgs, expectedInjected);
    assert.ok(mirrorIndex >= 0, 'expected mirrored teammate-response bubble before generation');

    const sayingIndex = findAssistantSayingIndex(dlg.msgs, resumeResponse);
    assert.ok(sayingIndex >= 0, 'expected assistant saying generated from mirrored response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'teammate-response bubble must appear before assistant saying that uses it',
    );
  });

  console.log('driver-v2 subdialog-order-before-gen: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 subdialog-order-before-gen: FAIL\n${message}`);
  process.exit(1);
});
