import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/driver-entry';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import { formatAssignmentFromSupdialog } from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  lastAssistantSaying,
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
    const resumeResponse = 'Ack: subdialog response was visible before follow-up generation.';

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

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'kernel-driver-subdialog-order-before-gen', grammar: 'markdown' },
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
      'kernel-driver should not rely on persisted subdialog response queue',
    );

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.responderId === 'pangu' &&
        msg.tellaskContent === tellaskBody &&
        msg.content === subdialogResponseText,
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored teammate-response bubble before generation');

    const sayingIndex = findAssistantSayingIndex(dlg.msgs, resumeResponse);
    assert.ok(sayingIndex >= 0, 'expected assistant saying generated from mirrored response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'teammate-response bubble must appear before assistant saying that uses it',
    );
  });

  console.log('kernel-driver subdialog-order-before-gen: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-order-before-gen: FAIL\n${message}`);
  process.exit(1);
});
