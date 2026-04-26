import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAskerDialogCallPrompt,
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
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
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Start a side dialog that must ask back before finishing.';
    const sessionSlug = 'askback-auto-resume';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please answer 1+1, but first ask me back for confirmation.';
    const askBackBody = 'Before I finish, please confirm the exact final answer.';
    const askBackReply = 'Use exactly `2`.';
    const sideDialogFinalResponse = '2';
    const rootAskBackNarration = 'Replying to the side dialog ask-back now.';
    const language = getWorkLanguage();

    const expectedSideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList,
        tellaskContent: tellaskBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
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
          mentionList,
          tellaskContent: tellaskBody,
        },
        language,
      }),
      expectedReplyToolName: 'replyTellaskBack',
      language,
    });

    const tellaskBackResponse = formatTellaskResponseContent({
      callName: 'tellaskBack',
      callId: 'sideDialog-ask-back',
      responderId: 'tester',
      tellaskerId: 'pangu',
      tellaskContent: askBackBody,
      responseBody: askBackReply,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Starting the side dialog.',
        funcCalls: [
          {
            id: 'root-call-pangu-askback',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      {
        message: expectedSideDialogPrompt,
        role: 'user',
        response: 'I need one clarification before I can finish.',
        funcCalls: [
          {
            id: 'sideDialog-ask-back',
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
            id: 'root-reply-ask-back',
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
        response: sideDialogFinalResponse,
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-askback-auto-resume'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
        return pending.length === 0;
      },
      3_000,
      'ask-back side dialog to auto-resume and clear the root pending list',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(pending.length, 0, 'expected ask-back side dialog to clear the root pending list');

    const sideDialog = root.lookupSideDialog('pangu', sessionSlug);
    assert.ok(sideDialog, 'expected registered sideDialog to exist after ask-back completion');

    const events = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tellask_anchor_record' &&
          event.anchorRole === 'response' &&
          event.callId === 'root-call-pangu-askback',
      ),
      'expected sideDialog to emit the original tellask response anchor after ask-back resolution',
    );
  });

  console.log('kernel-driver sideDialog-askback-auto-resume: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-askback-auto-resume: FAIL\n${message}`);
  process.exit(1);
});
