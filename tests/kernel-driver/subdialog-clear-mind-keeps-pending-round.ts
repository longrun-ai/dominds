import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import {
  formatAssignmentFromSupdialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  lastAssistantSaying,
  listTellaskResultContents,
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
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const trigger = 'Ask @pangu and let the callee continue after clearing mind.';
    const rootFirstResponse = 'Starting tellask.';
    const mentionList = ['@pangu'];
    const tellaskContent = 'Please inspect the problem and come back with the answer.';
    const language = getWorkLanguage();
    const finalSubdialogReply = 'I cleared context, rebuilt the thread, and the answer is 42.';

    const subdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromSupdialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList,
        tellaskContent,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const subdialogCourse2Prompt = `${subdialogPrompt}\n---\n${formatNewCourseStartPrompt('en', {
      nextCourse: 2,
      source: 'clear_mind',
    })}`;
    const completedResponseContent = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList,
      tellaskContent,
      responseBody: finalSubdialogReply,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      language,
    });
    const rootAfterReply = 'Received the continued answer from @pangu.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: rootFirstResponse,
        funcCalls: [
          {
            id: 'root-call-clear-mind-keeps-pending-round',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent,
            },
          },
        ],
      },
      {
        message: subdialogPrompt,
        role: 'user',
        response: 'Clearing mind now.',
        funcCalls: [
          {
            id: 'subdialog-clear-mind',
            name: 'clear_mind',
            arguments: {
              reminder_content: 'Rebuild context from a fresh tellask only.',
            },
          },
        ],
      },
      {
        message: subdialogCourse2Prompt,
        role: 'user',
        response: finalSubdialogReply,
      },
      {
        message: completedResponseContent,
        role: 'tool',
        response: rootAfterReply,
      },
    ]);

    const rootDialog = await createRootDialog('tester');
    rootDialog.disableDiligencePush = true;

    await driveDialogStream(
      rootDialog,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-clear-mind-keeps-pending-round'),
      true,
    );

    await waitFor(
      async () => lastAssistantSaying(rootDialog) === rootAfterReply,
      3_000,
      'root dialog to resume after the callee replies from the new course',
    );
    await waitForAllDialogsUnlocked(rootDialog, 3_000);

    const pending = await DialogPersistence.loadPendingSubdialogs(rootDialog.id, rootDialog.status);
    assert.equal(
      pending.length,
      0,
      'caller pending-subdialogs should clear only after the continued reply arrives',
    );

    const tellaskResults = listTellaskResultContents(rootDialog.msgs);
    assert.ok(
      tellaskResults.includes(completedResponseContent),
      'caller should receive the final tellask_result_msg produced after the callee switches course',
    );
    assert.ok(
      !tellaskResults.some((content) => content.includes('this tellask round is no longer valid')),
      'caller should not receive the old cleared-mind invalidation failure notice',
    );

    const allDialogs = rootDialog.getAllDialogs();
    const subdialog = allDialogs.find((dialog) => dialog.id.selfId !== rootDialog.id.selfId);
    assert.ok(subdialog, 'expected a subdialog to exist');
    assert.equal(subdialog.currentCourse, 2, 'callee subdialog should advance to course #2');
  });

  console.log('kernel-driver subdialog-clear-mind-keeps-pending-round: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-clear-mind-keeps-pending-round: FAIL\n${message}`);
  process.exit(1);
});
