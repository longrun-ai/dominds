import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/driver-entry';
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
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList,
      tellaskContent: tellaskBody,
      language,
      collectiveTargets: ['pangu'],
    });

    const subdialogResponseText = '2';
    const expectedInjected = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: subdialogResponseText,
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
      { message: expectedInjected, role: 'tool', response: rootResumeResponse },
      { message: expectedInjected, role: 'user', response: rootResumeResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      { content: trigger, msgId: 'driver-v2-subdialog-commit-mirror', grammar: 'markdown' },
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
      tellaskResultMsgs.some((msg) => msg.content === expectedInjected),
      'expected mirrored tellask_result_msg content to include formatted teammate response',
    );

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.content === expectedInjected,
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

  console.log('driver-v2 subdialog-live-mirror-order: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 subdialog-live-mirror-order: FAIL\n${message}`);
  process.exit(1);
});
