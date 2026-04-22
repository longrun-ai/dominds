import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  formatAssignmentFromAskerDialog,
  formatTeammateResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  makeDriveOptions,
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
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      extraMembers: ['coder'],
    });

    const trigger =
      'Trigger sideDialog and ensure response is NOT supplied before nested suspension resolves.';
    const rootFirstResponse = 'Start.';
    const rootMentionList = ['@pangu'];
    const rootTellaskBody =
      'Please solve 1+1 and continue if needed.\nReturn your current best result.';
    const language = getWorkLanguage();

    const expectedSideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: rootMentionList,
        tellaskContent: rootTellaskBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });

    const panguFirstResponse = 'Current best result is 2.';
    const panguMentionList = ['@coder'];
    const panguTellaskBody = 'Please verify that 1+1 equals 2.\nReply with exactly `2` if correct.';
    const expectedCoderPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'pangu',
        toAgentId: 'coder',
        mentionList: panguMentionList,
        tellaskContent: panguTellaskBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const coderReply = '2';
    const expectedCoderInjected = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      callId: 'pangu-call-coder',
      responderId: 'coder',
      tellaskerId: 'pangu',
      mentionList: panguMentionList,
      tellaskContent: panguTellaskBody,
      responseBody: coderReply,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    const panguFinalResponse = 'Verified. Final answer remains 2.';
    const expectedPanguInjected = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      callId: 'root-call-pangu',
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: rootMentionList,
      tellaskContent: rootTellaskBody,
      responseBody: panguFinalResponse,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      language,
    });

    const rootFinalResponse = 'Ack: received final verified result from sideDialog.';

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
        message: expectedSideDialogPrompt,
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
      { message: expectedCoderPrompt, role: 'user', response: coderReply, delayMs: 1800 },
      { message: coderReply, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'user', response: panguFinalResponse },
      { message: expectedPanguInjected, role: 'tool', response: rootFinalResponse },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-supply-before-suspension'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    const isCanonicalRootMirror = (
      msg: Extract<ChatMessage, { type: 'tellask_result_msg' }>,
      expectedContent: string,
    ): boolean =>
      msg.role === 'tool' &&
      (msg.responder?.responderId ?? msg.responderId) === 'pangu' &&
      (msg.call?.tellaskContent ?? msg.tellaskContent) === rootTellaskBody &&
      msg.content === expectedContent;

    await new Promise((resolve) => setTimeout(resolve, 900));
    const interimMirrorIndex = dlg.msgs.findIndex(
      (msg) => msg.type === 'tellask_result_msg' && isCanonicalRootMirror(msg, panguFirstResponse),
    );
    assert.equal(
      interimMirrorIndex,
      -1,
      'intermediate sideDialog result must not be mirrored to root before nested tellask settles',
    );

    await waitFor(
      async () => {
        const finalMirrorIndex = dlg.msgs.findIndex(
          (msg) =>
            msg.type === 'tellask_result_msg' && isCanonicalRootMirror(msg, expectedPanguInjected),
        );
        if (finalMirrorIndex < 0) return false;
        for (let i = finalMirrorIndex + 1; i < dlg.msgs.length; i += 1) {
          const msg = dlg.msgs[i];
          if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
            return true;
          }
        }
        return false;
      },
      8_000,
      'main dialog to resume only after nested sideDialog chain is finalized',
    );

    await waitForAllDialogsUnlocked(dlg, 6_000);

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' && isCanonicalRootMirror(msg, expectedPanguInjected),
    );
    const sayingIndex = dlg.msgs.findIndex(
      (msg: ChatMessage, index: number) =>
        index > mirrorIndex && msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored sideDialog response in root messages');
    assert.ok(sayingIndex >= 0, 'expected root follow-up response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'mirrored sideDialog response must appear before root follow-up generation',
    );
  });

  console.log('kernel-driver sideDialog-no-early-supply-before-nested-completion: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-no-early-supply-before-nested-completion: FAIL\n${message}`,
  );
  process.exit(1);
});
