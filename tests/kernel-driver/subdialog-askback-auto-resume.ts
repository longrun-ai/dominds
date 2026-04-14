import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromSupdialog,
  formatSupdialogCallPrompt,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
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

    const trigger = 'Start a sideline that must ask back before finishing.';
    const sessionSlug = 'askback-auto-resume';
    const mentionList = ['@pangu'];
    const tellaskBody = 'Please answer 1+1, but first ask me back for confirmation.';
    const askBackBody = 'Before I finish, please confirm the exact final answer.';
    const askBackReply = 'Use exactly `2`.';
    const subdialogFinalResponse = '2';
    const rootAskBackNarration = 'Replying to the sideline ask-back now.';
    const language = getWorkLanguage();

    const expectedSubdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromSupdialog({
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
        message: trigger,
        role: 'user',
        response: 'Starting the sideline.',
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
        message: expectedSubdialogPrompt,
        role: 'user',
        response: 'I need one clarification before I can finish.',
        funcCalls: [
          {
            id: 'subdialog-ask-back',
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
        response: subdialogFinalResponse,
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-askback-auto-resume'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
        return pending.length === 0;
      },
      3_000,
      'ask-back sideline to auto-resume and clear the root pending list',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const pending = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(pending.length, 0, 'expected ask-back sideline to clear the root pending list');

    const subdialog = root.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected registered subdialog to exist after ask-back completion');

    const events = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'tellask_call_anchor_record' &&
          event.anchorRole === 'response' &&
          event.callId === 'root-call-pangu-askback',
      ),
      'expected subdialog to emit the original tellask response anchor after ask-back resolution',
    );
  });

  console.log('kernel-driver subdialog-askback-auto-resume: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-askback-auto-resume: FAIL\n${message}`);
  process.exit(1);
});
