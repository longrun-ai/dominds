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
      'Trigger subdialog and ensure response is NOT supplied before nested suspension resolves.';
    const rootFirstResponse = 'Start.';
    const rootMentionList = ['@pangu'];
    const rootTellaskBody =
      'Please solve 1+1 and continue if needed.\nReturn your current best result.';
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

    const panguFirstResponse = 'Current best result is 2.';
    const panguMentionList = ['@coder'];
    const panguTellaskBody = 'Please verify that 1+1 equals 2.\nReply with exactly `2` if correct.';
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
    const panguFinalResponse = 'Verified. Final answer remains 2.';

    const rootFinalResponse = 'Ack: received final verified result from subdialog.';

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
      { message: expectedCoderPrompt, role: 'user', response: coderReply, delayMs: 1800 },
      { message: coderReply, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'user', response: panguFinalResponse },
      { message: panguFinalResponse, role: 'tool', response: rootFinalResponse },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-subdialog-supply-before-suspension',
        grammar: 'markdown',
      },
      true,
      { suppressDiligencePush: true },
    );

    await new Promise((resolve) => setTimeout(resolve, 900));
    const interimMirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.responderId === 'pangu' &&
        msg.tellaskContent === rootTellaskBody &&
        msg.content === panguFirstResponse,
    );
    assert.equal(
      interimMirrorIndex,
      -1,
      'intermediate subdialog result must not be mirrored to root before nested tellask settles',
    );

    await waitFor(
      async () => {
        const finalMirrorIndex = dlg.msgs.findIndex(
          (msg) =>
            msg.type === 'tellask_result_msg' &&
            msg.role === 'tool' &&
            msg.responderId === 'pangu' &&
            msg.tellaskContent === rootTellaskBody &&
            msg.content === panguFinalResponse,
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
      'root dialog to resume only after nested subdialog chain is finalized',
    );

    await waitForAllDialogsUnlocked(dlg, 6_000);

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.responderId === 'pangu' &&
        msg.tellaskContent === rootTellaskBody &&
        msg.content === panguFinalResponse,
    );
    const sayingIndex = dlg.msgs.findIndex(
      (msg: ChatMessage, index: number) =>
        index > mirrorIndex && msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored subdialog response in root messages');
    assert.ok(sayingIndex >= 0, 'expected root follow-up response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'mirrored subdialog response must appear before root follow-up generation',
    );
  });

  console.log('kernel-driver subdialog-no-early-supply-before-nested-completion: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver subdialog-no-early-supply-before-nested-completion: FAIL\n${message}`,
  );
  process.exit(1);
});
