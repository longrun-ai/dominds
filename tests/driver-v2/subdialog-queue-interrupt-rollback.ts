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
  parseSingleTellaskCall,
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
      'Trigger subdialog and ensure response is supplied before nested suspension resolves.';
    const rootFirstResponse = [
      'Start.',
      '!?@pangu Please solve 1+1 and continue if needed.',
      '!?Return your current best result.',
      'separator',
    ].join('\n');
    const parsedRootCall = await parseSingleTellaskCall(rootFirstResponse);
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      tellaskHead: parsedRootCall.tellaskHead,
      tellaskBody: parsedRootCall.body,
      language,
      collectiveTargets: ['pangu'],
    });

    const panguFirstResponse = [
      'Current best result is 2.',
      '!?@coder Please verify that 1+1 equals 2.',
      '!?Reply with exactly `2` if correct.',
      'separator',
    ].join('\n');
    const parsedPanguCall = await parseSingleTellaskCall(panguFirstResponse);
    const expectedCoderPrompt = formatAssignmentFromSupdialog({
      fromAgentId: 'pangu',
      toAgentId: 'coder',
      tellaskHead: parsedPanguCall.tellaskHead,
      tellaskBody: parsedPanguCall.body,
      language,
      collectiveTargets: ['coder'],
    });
    const coderReply = '2';
    const expectedCoderInjected = formatTeammateResponseContent({
      responderId: 'coder',
      requesterId: 'pangu',
      originalCallHeadLine: parsedPanguCall.tellaskHead,
      responseBody: coderReply,
      language,
    });
    const panguFinalResponse = 'Verified. Final answer remains 2.';

    const expectedInjectedToRoot = formatTeammateResponseContent({
      responderId: 'pangu',
      requesterId: 'tester',
      originalCallHeadLine: parsedRootCall.tellaskHead,
      responseBody: panguFirstResponse,
      language,
    });
    const rootResumeResponse = 'Ack: got subdialog result before nested verification completed.';

    await writeMockDb(tmpRoot, [
      { message: trigger, role: 'user', response: rootFirstResponse },
      { message: expectedSubdialogPrompt, role: 'user', response: panguFirstResponse },
      { message: expectedInjectedToRoot, role: 'tool', response: rootResumeResponse },
      { message: expectedInjectedToRoot, role: 'user', response: rootResumeResponse },
      { message: expectedCoderPrompt, role: 'user', response: coderReply, delayMs: 1800 },
      { message: expectedCoderInjected, role: 'tool', response: panguFinalResponse },
      { message: expectedCoderInjected, role: 'user', response: panguFinalResponse },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    const startedAt = Date.now();
    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'driver-v2-subdialog-supply-before-suspension',
        grammar: 'markdown',
      },
      true,
      { suppressDiligencePush: true },
    );

    await waitFor(
      async () => lastAssistantSaying(dlg) === rootResumeResponse,
      1_200,
      'root dialog to resume before nested subdialog suspension resolves',
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 1_600,
      `root follow-up should not wait nested coder reply delay (elapsed=${elapsedMs}ms)`,
    );

    await waitForAllDialogsUnlocked(dlg, 6_000);

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) =>
        msg.type === 'tellask_result_msg' &&
        msg.role === 'tool' &&
        msg.content === expectedInjectedToRoot,
    );
    const sayingIndex = dlg.msgs.findIndex(
      (msg: ChatMessage) =>
        msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === rootResumeResponse,
    );
    assert.ok(mirrorIndex >= 0, 'expected mirrored subdialog response in root messages');
    assert.ok(sayingIndex >= 0, 'expected root follow-up response');
    assert.ok(
      mirrorIndex < sayingIndex,
      'mirrored subdialog response must appear before root follow-up generation',
    );
  });

  console.log('driver-v2 subdialog-supply-before-suspension: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 subdialog-supply-before-suspension: FAIL\n${message}`);
  process.exit(1);
});
