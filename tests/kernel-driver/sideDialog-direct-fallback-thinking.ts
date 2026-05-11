import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { buildReplyToolReminderText } from '../../main/runtime/reply-prompt-copy';
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

function findTellaskResult(
  msgs: readonly ChatMessage[],
  callId: string,
): Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined {
  return msgs.find(
    (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
      msg.type === 'tellask_result_msg' && msg.callId === callId,
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      extraMembers: ['coder'],
    });

    const language = getWorkLanguage();
    const triggerThinkingOnly = 'Start thinking-only direct fallback side dialog.';
    const thinkingOnlyCallId = 'root-call-pangu-thinking-only';
    const thinkingOnlyBody = 'Please answer 1+1. Do not call replyTellaskSessionless.';
    const thinkingOnlyMentionList = ['@pangu'];
    const thinkingOnlyPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: thinkingOnlyMentionList,
        tellaskContent: thinkingOnlyBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const thinkingOnlyReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: thinkingOnlyCallId,
        tellaskContent: thinkingOnlyBody,
      },
      replyTargetAgentId: 'tester',
    });
    const thinkingOnlyText = 'Reasoned answer: 2.';
    const expectedThinkingOnlyMirror = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: thinkingOnlyCallId,
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: thinkingOnlyMentionList,
      tellaskContent: thinkingOnlyBody,
      responseBody: thinkingOnlyText,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'thinking_only',
      language,
    });

    const triggerSayingWins = 'Start saying-wins direct fallback side dialog.';
    const sayingWinsCallId = 'root-call-coder-saying-wins';
    const sayingWinsBody = 'Please answer 2+2. Do not call replyTellaskSessionless.';
    const sayingWinsMentionList = ['@coder'];
    const sayingWinsPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'coder',
        mentionList: sayingWinsMentionList,
        tellaskContent: sayingWinsBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const sayingWinsReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: sayingWinsCallId,
        tellaskContent: sayingWinsBody,
      },
      replyTargetAgentId: 'tester',
    });
    const sayingWinsThinking = 'Hidden calculation says 999.';
    const sayingWinsSaying = 'Public answer: 4.';
    const expectedSayingWinsMirror = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: sayingWinsCallId,
      responderId: 'coder',
      tellaskerId: 'tester',
      mentionList: sayingWinsMentionList,
      tellaskContent: sayingWinsBody,
      responseBody: sayingWinsSaying,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'saying',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: triggerThinkingOnly,
        role: 'user',
        response: 'Starting thinking-only side dialog.',
        funcCalls: [
          {
            id: thinkingOnlyCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: thinkingOnlyBody,
            },
          },
        ],
      },
      {
        message: thinkingOnlyPrompt,
        role: 'user',
        response: 'I have the answer but forgot the reply tool.',
      },
      {
        message: thinkingOnlyReplyReminder,
        role: 'user',
        response: '',
        thinkingResponse: thinkingOnlyText,
        omitDefaultThinking: true,
        contextContains: [thinkingOnlyBody],
      },
      {
        message: expectedThinkingOnlyMirror,
        role: 'tool',
        response: 'Root received thinking-only fallback.',
      },
      {
        message: triggerSayingWins,
        role: 'user',
        response: 'Starting saying-wins side dialog.',
        funcCalls: [
          {
            id: sayingWinsCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: sayingWinsBody,
            },
          },
        ],
      },
      {
        message: sayingWinsPrompt,
        role: 'user',
        response: 'I have the answer but forgot the reply tool.',
      },
      {
        message: sayingWinsReplyReminder,
        role: 'user',
        response: sayingWinsSaying,
        thinkingResponse: sayingWinsThinking,
        omitDefaultThinking: true,
        contextContains: [sayingWinsBody],
      },
      {
        message: expectedSayingWinsMirror,
        role: 'tool',
        response: 'Root received saying fallback.',
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(triggerThinkingOnly, 'kernel-driver-sideDialog-thinking-only-fallback'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => findTellaskResult(root.msgs, thinkingOnlyCallId) !== undefined,
      3_000,
      'thinking-only direct fallback result',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const thinkingOnlyResult = findTellaskResult(root.msgs, thinkingOnlyCallId);
    assert.ok(thinkingOnlyResult, 'expected thinking-only direct fallback result');
    assert.equal(thinkingOnlyResult.content, expectedThinkingOnlyMirror);
    assert.match(thinkingOnlyResult.content, /only produced thinking/u);
    assert.match(thinkingOnlyResult.content, /Reasoned answer: 2/u);

    await driveDialogStream(
      root,
      makeUserPrompt(triggerSayingWins, 'kernel-driver-sideDialog-saying-wins-fallback'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => findTellaskResult(root.msgs, sayingWinsCallId) !== undefined,
      3_000,
      'saying direct fallback result',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const sayingWinsResult = findTellaskResult(root.msgs, sayingWinsCallId);
    assert.ok(sayingWinsResult, 'expected saying direct fallback result');
    assert.equal(sayingWinsResult.content, expectedSayingWinsMirror);
    assert.match(sayingWinsResult.content, /Public answer: 4/u);
    assert.doesNotMatch(sayingWinsResult.content, /Hidden calculation says 999/u);
  });

  console.log('kernel-driver sideDialog-direct-fallback-thinking: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-direct-fallback-thinking: FAIL\n${message}`);
  process.exit(1);
});
