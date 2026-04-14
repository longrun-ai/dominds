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
    const sessionSlug = 'askback-no-double-delivery';
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

    const canonicalAskBackReply = formatTellaskResponseContent({
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
            id: 'root-call-pangu-askback-once',
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
            id: 'subdialog-ask-back-once',
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
            id: 'root-reply-ask-back-once',
            name: 'replyTellaskBack',
            arguments: {
              replyContent: askBackReply,
            },
          },
        ],
      },
      {
        message: canonicalAskBackReply,
        role: 'tool',
        response: subdialogFinalResponse,
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-askback-reply-tool-no-double-delivery'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
        return pending.length === 0;
      },
      3_000,
      'ask-back sideline to resolve exactly once',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const subdialog = root.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected ask-back subdialog to exist');

    const events = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    const tellaskResults = events.filter(
      (event) =>
        event.type === 'tellask_result_record' && event.callId === 'subdialog-ask-back-once',
    );
    assert.equal(
      tellaskResults.length,
      1,
      'expected replyTellaskBack to deliver exactly one tellask_result_record to ask-back requester',
    );
    assert.equal(
      tellaskResults[0]?.content,
      canonicalAskBackReply,
      'expected ask-back requester to keep the canonical reply-tool result content',
    );

    const funcResults = events.filter(
      (event) => event.type === 'func_result_record' && event.id === 'subdialog-ask-back-once',
    );
    assert.equal(
      funcResults.length,
      1,
      'expected ask-back requester to persist exactly one func_result_record for tellaskBack',
    );
    assert.equal(
      funcResults[0]?.content,
      canonicalAskBackReply,
      'expected tellaskBack func_result_record to mirror the canonical reply-tool delivery',
    );
  });

  console.log('kernel-driver subdialog-askback-reply-tool-no-double-delivery: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver subdialog-askback-reply-tool-no-double-delivery: FAIL\n${message}`);
  process.exit(1);
});
