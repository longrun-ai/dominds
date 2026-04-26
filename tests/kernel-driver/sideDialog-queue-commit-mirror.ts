import assert from 'node:assert/strict';

import { DialogID } from '../../main/dialog';
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
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Trigger root sideDialog and verify live mirror ordering.';
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
      tellaskerId: 'tester',
      mentionList,
      tellaskContent: tellaskBody,
      responseBody: sideDialogResponseText,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    const rootResumeResponse =
      'Ack: mirrored sideDialog response is live before follow-up generation.';

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
      { message: mirroredSideDialogResponse, role: 'tool', response: rootResumeResponse },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-commit-mirror'),
      true,
    );

    await waitFor(
      async () => lastAssistantSaying(dlg) === rootResumeResponse,
      3_000,
      'main dialog to generate after sideDialog response',
    );

    await waitForAllDialogsUnlocked(dlg, 3_000);

    const tellaskResultMsgs = dlg.msgs.filter(
      (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
        msg.type === 'tellask_result_msg',
    );
    const isCanonicalMirroredResult = (
      msg: Extract<ChatMessage, { type: 'tellask_result_msg' }>,
    ): boolean =>
      msg.role === 'tool' &&
      (msg.responder?.responderId ?? msg.responderId) === 'pangu' &&
      (msg.call?.tellaskContent ?? msg.tellaskContent) === tellaskBody &&
      msg.content === mirroredSideDialogResponse;
    assert.ok(tellaskResultMsgs.length > 0, 'expected mirrored tellask_result_msg after commit');
    assert.ok(
      tellaskResultMsgs.some(isCanonicalMirroredResult),
      'expected mirrored tellask_result_msg with canonical transfer payload and structured tellask fields',
    );
    const mirroredResult = tellaskResultMsgs.find(isCanonicalMirroredResult);
    assert.ok(mirroredResult, 'expected canonical mirrored teammate-response message');
    const responseRoute = mirroredResult.route;
    assert.ok(responseRoute, 'mirrored teammate-response should carry callee response route');
    assert.equal(responseRoute.calleeDialogId !== undefined, true);
    assert.equal(responseRoute.calleeCourse !== undefined, true);
    assert.equal(responseRoute.calleeGenseq !== undefined, true);
    const calleeDialogId = new DialogID(responseRoute.calleeDialogId!, dlg.id.rootId);
    const calleeEvents = await DialogPersistence.loadCourseEvents(
      calleeDialogId,
      responseRoute.calleeCourse!,
    );
    const assignmentAnchor = calleeEvents.find(
      (event) =>
        event.type === 'tellask_anchor_record' &&
        event.anchorRole === 'assignment' &&
        event.callId === 'root-call-pangu',
    );
    const responseAnchor = calleeEvents.find(
      (event) =>
        event.type === 'tellask_anchor_record' &&
        event.anchorRole === 'response' &&
        event.callId === 'root-call-pangu',
    );
    assert.ok(assignmentAnchor, 'expected callee assignment anchor');
    assert.ok(responseAnchor, 'expected callee response anchor');
    assert.equal(
      responseRoute.calleeGenseq,
      responseAnchor.genseq,
      'teammate-response route should deep-link to the callee reply bubble',
    );
    assert.notEqual(
      responseRoute.calleeGenseq,
      assignmentAnchor.genseq,
      'teammate-response route must not reuse the original callee assignment anchor',
    );

    const mirrorIndex = dlg.msgs.findIndex(
      (msg) => msg.type === 'tellask_result_msg' && isCanonicalMirroredResult(msg),
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

  console.log('kernel-driver sideDialog-live-mirror-order: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-live-mirror-order: FAIL\n${message}`);
  process.exit(1);
});
