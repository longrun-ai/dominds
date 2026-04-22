import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
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

    const trigger = 'Ask @pangu and let the tellaskee continue after clearing mind.';
    const rootFirstResponse = 'Starting tellask.';
    const mentionList = ['@pangu'];
    const tellaskContent = 'Please inspect the problem and come back with the answer.';
    const language = getWorkLanguage();
    const finalSideDialogReply = 'I cleared context, rebuilt the thread, and the answer is 42.';

    const sideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
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
    const sideDialogCourse2Prompt = `${sideDialogPrompt}\n---\n${formatNewCourseStartPrompt('en', {
      nextCourse: 2,
      source: 'clear_mind',
    })}`;
    const completedResponseContent = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: 'root-call-clear-mind-keeps-pending-round',
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList,
      tellaskContent,
      responseBody: finalSideDialogReply,
      status: 'completed',
      deliveryMode: 'reply_tool',
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
        message: sideDialogPrompt,
        role: 'user',
        response: 'Clearing mind now.',
        funcCalls: [
          {
            id: 'sideDialog-clear-mind',
            name: 'clear_mind',
            arguments: {
              reminder_content: 'Rebuild context from a fresh tellask only.',
            },
          },
        ],
      },
      {
        message: sideDialogCourse2Prompt,
        role: 'user',
        response: finalSideDialogReply,
      },
      {
        message: completedResponseContent,
        role: 'tool',
        response: rootAfterReply,
      },
    ]);

    const mainDialog = await createMainDialog('tester');
    mainDialog.disableDiligencePush = true;

    await driveDialogStream(
      mainDialog,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-clear-mind-keeps-pending-round'),
      true,
    );

    await waitFor(
      async () => lastAssistantSaying(mainDialog) === rootAfterReply,
      3_000,
      'main dialog to resume after the tellaskee replies from the new course',
    );
    await waitForAllDialogsUnlocked(mainDialog, 3_000);

    const pending = await DialogPersistence.loadPendingSideDialogs(
      mainDialog.id,
      mainDialog.status,
    );
    assert.equal(
      pending.length,
      0,
      'asker pending-sideDialogs should clear only after the continued reply arrives',
    );

    const tellaskResults = listTellaskResultContents(mainDialog.msgs);
    assert.ok(
      tellaskResults.includes(completedResponseContent),
      'asker should receive the final tellask_result_msg produced after the tellaskee switches course',
    );
    assert.ok(
      !tellaskResults.some((content) => content.includes('this tellask round is no longer valid')),
      'asker should not receive the old cleared-mind invalidation failure notice',
    );

    const allDialogs = mainDialog.getAllDialogs();
    const sideDialog = allDialogs.find((dialog) => dialog.id.selfId !== mainDialog.id.selfId);
    assert.ok(sideDialog, 'expected a sideDialog to exist');
    assert.equal(sideDialog.currentCourse, 2, 'tellaskee sideDialog should advance to course #2');
  });

  console.log('kernel-driver sideDialog-clear-mind-keeps-pending-round: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-clear-mind-keeps-pending-round: FAIL\n${message}`);
  process.exit(1);
});
