import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { formatResolvedTellaskFuncResultContent } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { formatAskerDialogCallPrompt } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
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
      'I have the answer from the tellasker and can continue the registered practitioner loop now.';

    const root = await createMainDialog('tester');
    const pangu = await root.createSideDialog('pangu', ['@pangu'], parentTellaskBody, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-call-pangu-main',
      sessionSlug: 'main-longline',
      collectiveTargets: ['pangu'],
    });
    root.disableDiligencePush = true;
    pangu.disableDiligencePush = true;

    await DialogPersistence.appendPendingSideDialog(root.id, {
      sideDialogId: pangu.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: parentTellaskBody,
      targetAgentId: 'pangu',
      callId: 'root-call-pangu-main',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'B',
      sessionSlug: 'main-longline',
    });

    await pangu.persistUserMessage(
      'Initial parent side dialog assignment.',
      'pangu-runtime-assignment',
      'markdown',
      'runtime',
      language,
      undefined,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: root.id.selfId,
        targetCallId: 'root-call-pangu-main',
        tellaskContent: parentTellaskBody,
      },
    );

    const nested = await pangu.createSideDialog('nuwa', ['@nuwa'], nestedTellaskBody, {
      callName: 'tellask',
      originMemberId: 'pangu',
      askerDialogId: pangu.id.selfId,
      callId: 'pangu-call-nuwa-registered',
      sessionSlug: 'nested-live-dom',
      collectiveTargets: ['nuwa'],
    });
    nested.disableDiligencePush = true;
    await DialogPersistence.appendPendingSideDialog(pangu.id, {
      sideDialogId: nested.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellask',
      mentionList: ['@nuwa'],
      tellaskContent: nestedTellaskBody,
      targetAgentId: 'nuwa',
      callId: 'pangu-call-nuwa-registered',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'B',
      sessionSlug: 'nested-live-dom',
    });

    const expectedAskerDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAskerDialogCallPrompt({
        fromAgentId: 'pangu',
        toAgentId: 'tester',
        sideDialogRequest: {
          callName: 'tellaskBack',
          tellaskContent: askBackBody,
        },
        askerDialogAssignment: {
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

    const tellaskBackToolResult = formatResolvedTellaskFuncResultContent({
      name: 'tellaskBack',
      callId: 'pangu-ask-back-for-loop-resume',
      status: 'completed',
    });

    await writeMockDb(tmpRoot, [
      {
        message: 'Use ask-back before continuing the registered practitioner loop.',
        role: 'user',
        response: 'I need one tellasker answer before I can continue the practitioner loop.',
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
        message: expectedAskerDialogPrompt,
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
        message: tellaskBackToolResult,
        role: 'tool',
        response: resumedResponse,
      },
    ]);

    await driveDialogStream(
      pangu,
      {
        content: 'Use ask-back before continuing the registered practitioner loop.',
        msgId: 'sideDialog-askback-auto-resume-while-pending-registered-sideDialog',
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
      'ask-back asker sideDialog to auto-resume even while the registered nested side dialog remains pending',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const pending = await DialogPersistence.loadPendingSideDialogs(pangu.id, pangu.status);
    assert.equal(
      pending.length,
      1,
      'auto-resume should not consume the still-pending registered nested side dialog',
    );
    assert.equal(
      pending[0]?.sideDialogId,
      nested.id.selfId,
      'the still-pending registered side dialog should remain the nested practitioner dialog',
    );

    const latest = await DialogPersistence.loadDialogLatest(pangu.id, pangu.status);
    assert.deepEqual(
      latest?.displayState,
      {
        kind: 'blocked',
        reason: { kind: 'waiting_for_sideDialogs' },
      },
      'after the auto-resume round, the tellasker should return to waiting on the nested registered side dialog',
    );

    const events = await DialogPersistence.loadCourseEvents(
      pangu.id,
      pangu.currentCourse,
      pangu.status,
    );
    assert.equal(
      events.filter((event) => event.type === 'gen_start_record').length,
      2,
      'the tellasker sideDialog should run a second generation round after replyTellaskBack lands',
    );
  });

  console.log(
    'kernel-driver sideDialog-askback-auto-resume-while-pending-registered-sideDialog: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-askback-auto-resume-while-pending-registered-sideDialog: FAIL\n${message}`,
  );
  process.exit(1);
});
