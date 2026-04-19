import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatSupdialogCallPrompt,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  makeDriveOptions,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true, extraMembers: ['nuwa'] });

    const language = getWorkLanguage();
    const parentTellaskBody = 'Own the main slice and reply only after the live DOM loop settles.';
    const nestedTellaskBody =
      'Please keep gathering live DOM evidence until I send the next refinement request.';
    const askBackBody = 'The MCP path is back. Should I resume the same live-DOM loop now?';
    const askBackReply = 'Yes. Continue the same live-DOM loop immediately.';
    const rootAskBackNarration = 'Resume the practitioner loop now.';
    const resumedResponse =
      'I have the answer from upstream and can continue the registered practitioner loop now.';

    const root = await createRootDialog('tester');
    const pangu = await root.createSubDialog('pangu', ['@pangu'], parentTellaskBody, {
      callName: 'tellask',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId: 'root-call-pangu-main',
      sessionSlug: 'main-longline',
      collectiveTargets: ['pangu'],
    });
    root.disableDiligencePush = true;
    pangu.disableDiligencePush = true;

    await DialogPersistence.appendPendingSubdialog(root.id, {
      subdialogId: pangu.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: parentTellaskBody,
      targetAgentId: 'pangu',
      callId: 'root-call-pangu-main',
      callType: 'B',
      sessionSlug: 'main-longline',
    });

    await pangu.persistUserMessage(
      'Initial parent sideline assignment.',
      'pangu-runtime-assignment',
      'markdown',
      'runtime',
      language,
      undefined,
      {
        expectedReplyCallName: 'replyTellask',
        targetCallId: 'root-call-pangu-main',
        tellaskContent: parentTellaskBody,
      },
    );

    const nested = await pangu.createSubDialog('nuwa', ['@nuwa'], nestedTellaskBody, {
      callName: 'tellask',
      originMemberId: 'pangu',
      callerDialogId: pangu.id.selfId,
      callId: 'pangu-call-nuwa-registered',
      sessionSlug: 'nested-live-dom',
      collectiveTargets: ['nuwa'],
    });
    nested.disableDiligencePush = true;
    await DialogPersistence.appendPendingSubdialog(pangu.id, {
      subdialogId: nested.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellask',
      mentionList: ['@nuwa'],
      tellaskContent: nestedTellaskBody,
      targetAgentId: 'nuwa',
      callId: 'pangu-call-nuwa-registered',
      callType: 'B',
      sessionSlug: 'nested-live-dom',
    });

    const expectedSupdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatSupdialogCallPrompt({
        fromAgentId: 'pangu',
        toAgentId: 'tester',
        subdialogRequest: {
          callName: 'tellaskBack',
          tellaskContent: askBackBody,
        },
        supdialogAssignment: {
          callName: 'tellask',
          mentionList: ['@pangu'],
          tellaskContent: parentTellaskBody,
          sessionSlug: 'main-longline',
        },
        language,
      }),
      expectedReplyToolName: 'replyTellaskBack',
      language,
    });

    const tellaskBackResponse = formatTellaskResponseContent({
      callName: 'tellaskBack',
      responderId: 'tester',
      requesterId: 'pangu',
      tellaskContent: askBackBody,
      responseBody: askBackReply,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: 'Use ask-back before continuing the registered practitioner loop.',
        role: 'user',
        response: 'I need one upstream answer before I can continue the practitioner loop.',
        funcCalls: [
          {
            id: 'pangu-ask-back-for-loop-resume',
            name: 'tellaskBack',
            arguments: {
              tellaskContent: askBackBody,
            },
          },
        ],
      },
      {
        message: expectedSupdialogPrompt,
        role: 'user',
        response: rootAskBackNarration,
        funcCalls: [
          {
            id: 'root-reply-loop-resume',
            name: 'replyTellaskBack',
            arguments: {
              replyContent: askBackReply,
            },
          },
        ],
      },
      {
        message: tellaskBackResponse,
        role: 'tool',
        response: resumedResponse,
      },
    ]);

    await driveDialogStream(
      pangu,
      {
        content: 'Use ask-back before continuing the registered practitioner loop.',
        msgId: 'subdialog-askback-auto-resume-while-pending-registered-subdialog',
        grammar: 'markdown',
        origin: 'runtime',
      },
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () =>
        pangu.msgs.some(
          (msg) =>
            msg.type === 'saying_msg' &&
            msg.role === 'assistant' &&
            msg.content === resumedResponse,
        ),
      3_000,
      'ask-back requester subdialog to auto-resume even while the registered nested sideline remains pending',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const pending = await DialogPersistence.loadPendingSubdialogs(pangu.id, pangu.status);
    assert.equal(
      pending.length,
      1,
      'auto-resume should not consume the still-pending registered nested sideline',
    );
    assert.equal(
      pending[0]?.subdialogId,
      nested.id.selfId,
      'the still-pending registered sideline should remain the nested practitioner dialog',
    );

    const latest = await DialogPersistence.loadDialogLatest(pangu.id, pangu.status);
    assert.deepEqual(
      latest?.displayState,
      {
        kind: 'blocked',
        reason: { kind: 'waiting_for_subdialogs' },
      },
      'after the auto-resume round, the requester should return to waiting on the nested registered sideline',
    );

    const events = await DialogPersistence.loadCourseEvents(
      pangu.id,
      pangu.currentCourse,
      pangu.status,
    );
    assert.equal(
      events.filter((event) => event.type === 'gen_start_record').length,
      2,
      'the requester subdialog should run a second generation round after replyTellaskBack lands',
    );
  });

  console.log(
    'kernel-driver subdialog-askback-auto-resume-while-pending-registered-subdialog: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver subdialog-askback-auto-resume-while-pending-registered-subdialog: FAIL\n${message}`,
  );
  process.exit(1);
});
