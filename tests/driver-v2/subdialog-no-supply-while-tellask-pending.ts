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
  persistRootDialogMetadata,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      extraMembers: ['coder'],
    });

    const trigger =
      'Trigger nested sideline tellask and ensure no premature supply to caller before finalization.';
    const rootFirstResponse = 'Starting nested verification.';
    const rootMentionList = ['@pangu'];
    const rootTellaskBody =
      'Please solve 1+1, then verify with another teammate before sending the final conclusion.';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      callName: 'tellaskSessionless',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList: rootMentionList,
      tellaskContent: rootTellaskBody,
      language,
      collectiveTargets: ['pangu'],
    });

    const panguFirstResponse = 'Current best guess is 2; I will verify it first.';
    const panguMentionList = ['@coder'];
    const panguTellaskBody = 'Please verify 1+1 equals 2. Reply with exactly `2`.';
    const expectedCoderPrompt = formatAssignmentFromSupdialog({
      callName: 'tellaskSessionless',
      fromAgentId: 'pangu',
      toAgentId: 'coder',
      mentionList: panguMentionList,
      tellaskContent: panguTellaskBody,
      language,
      collectiveTargets: ['coder'],
    });

    const coderReply = '2';
    const expectedCoderInjected = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'coder',
      requesterId: 'pangu',
      mentionList: panguMentionList,
      tellaskContent: panguTellaskBody,
      responseBody: coderReply,
      language,
    });

    const panguFinalResponse = 'Verified: 1+1=2. Final conclusion is 2.';
    const expectedEarlyInjectedToRoot = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: rootMentionList,
      tellaskContent: rootTellaskBody,
      responseBody: panguFirstResponse,
      language,
    });
    const expectedFinalInjectedToRoot = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: rootMentionList,
      tellaskContent: rootTellaskBody,
      responseBody: panguFinalResponse,
      language,
    });

    const rootResumeResponse =
      'Ack: got final verified result only after nested tellask completed.';

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
              tellaskContent: rootTellaskBody,
            },
          },
        ],
      },
      {
        message: expectedSubdialogPrompt,
        role: 'user',
        response: panguFirstResponse,
        funcCalls: [
          {
            id: 'pangu-call-coder',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: panguTellaskBody,
            },
          },
        ],
      },
      { message: expectedCoderPrompt, role: 'user', response: coderReply, delayMs: 1200 },
      { message: expectedCoderInjected, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'user', response: panguFinalResponse },
      { message: expectedFinalInjectedToRoot, role: 'tool', response: rootResumeResponse },
      { message: expectedFinalInjectedToRoot, role: 'user', response: rootResumeResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;
    await persistRootDialogMetadata(dlg);

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'driver-v2-no-premature-subdialog-supply',
        grammar: 'markdown',
      },
      true,
      { suppressDiligencePush: true },
    );

    await waitFor(
      async () => lastAssistantSaying(dlg) === rootResumeResponse,
      8_000,
      'root dialog to resume only after nested tellask final response is supplied',
    );

    await waitForAllDialogsUnlocked(dlg, 8_000);

    const tellaskResultContents = dlg.msgs
      .filter(
        (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
          msg.type === 'tellask_result_msg' && msg.role === 'tool',
      )
      .map((msg) => msg.content);

    assert.ok(
      tellaskResultContents.includes(expectedFinalInjectedToRoot),
      'expected final nested response to be supplied to root',
    );
    assert.ok(
      !tellaskResultContents.includes(expectedEarlyInjectedToRoot),
      'must not supply early pre-nested-call saying to root',
    );
  });

  console.log('driver-v2 subdialog-no-supply-while-tellask-pending: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`driver-v2 subdialog-no-supply-while-tellask-pending: FAIL\n${message}`);
  process.exit(1);
});
