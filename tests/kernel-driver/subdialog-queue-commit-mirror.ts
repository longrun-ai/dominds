import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
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

    const trigger = 'Trigger root subdialog and verify live mirror ordering.';
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
    const mirroredSubdialogResponse = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: subdialogResponseText,
      status: 'completed',
      language,
    });
    const rootResumeResponse =
      'Ack: mirrored subdialog response is live before follow-up generation.';

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
      { message: mirroredSubdialogResponse, role: 'tool', response: rootResumeResponse },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'kernel-driver-subdialog-commit-mirror', grammar: 'markdown' },
      true,
    );

    await waitFor(
      async () => lastAssistantSaying(dlg) === rootResumeResponse,
      3_000,
      'root dialog to generate after subdialog response',
    );

    await waitForAllDialogsUnlocked(dlg, 3_000);

    const tellaskResultMsgs = dlg.msgs.filter(
      (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
        msg.type === 'tellask_result_msg',
    );
    assert.ok(tellaskResultMsgs.length > 0, 'expected mirrored tellask_result_msg after commit');
    assert.ok(
      tellaskResultMsgs.some(
        (msg) =>
          msg.role === 'tool' &&
          msg.responderId === 'pangu' &&
          msg.tellaskContent === tellaskBody &&
          msg.content === mirroredSubdialogResponse,
      ),
      'expected mirrored tellask_result_msg with canonical transfer payload and structured tellask fields',
    );

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.responderId === 'pangu' &&
        msg.tellaskContent === tellaskBody &&
        msg.content === mirroredSubdialogResponse,
    );
    const sayingIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === rootResumeResponse,
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored teammate-response bubble');
    assert.ok(sayingIndex >= 0, 'expected root assistant follow-up response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'mirrored teammate-response must be visible before assistant follow-up generation',
    );
  });

  console.log('kernel-driver subdialog-live-mirror-order: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-live-mirror-order: FAIL\n${message}`);
  process.exit(1);
});
