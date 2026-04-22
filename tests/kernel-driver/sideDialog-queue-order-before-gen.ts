import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTeammateResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  lastAssistantSaying,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
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

    const trigger = 'Trigger sideDialog and verify response ordering without queue injection.';
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
    const resumeResponse = 'Ack: sideDialog response was visible before follow-up generation.';

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
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-order-before-gen'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(dlg) === resumeResponse,
      3_000,
      'root dialog to generate follow-up from sideDialog response',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const queueAfter = await DialogPersistence.loadSideDialogResponsesQueue(dlg.id);
    assert.equal(
      queueAfter.length,
      0,
      'kernel-driver should not rely on persisted sideDialog response queue',
    );

    const isCanonicalMirroredResult = (
      msg: Extract<ChatMessage, { type: 'tellask_result_msg' }>,
    ): boolean =>
      msg.role === 'tool' &&
      (msg.responder?.responderId ?? msg.responderId) === 'pangu' &&
      (msg.call?.tellaskContent ?? msg.tellaskContent) === tellaskBody &&
      msg.content === mirroredSideDialogResponse;
    const mirrorIndex = dlg.msgs.findIndex(
      (msg) => msg.type === 'tellask_result_msg' && isCanonicalMirroredResult(msg),
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored teammate-response bubble before generation');

    const sayingIndex = findAssistantSayingIndex(dlg.msgs, resumeResponse);
    assert.ok(sayingIndex >= 0, 'expected assistant saying generated from mirrored response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'teammate-response bubble must appear before assistant saying that uses it',
    );
  });

  console.log('kernel-driver sideDialog-order-before-gen: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-order-before-gen: FAIL\n${message}`);
  process.exit(1);
});
