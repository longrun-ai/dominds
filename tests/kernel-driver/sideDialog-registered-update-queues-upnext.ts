import assert from 'node:assert/strict';

import type { TellaskResultRecord } from '@longrun-ai/kernel/types/storage';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
  formatUpdatedAssignmentFromAskerDialog,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  listTellaskResultContents,
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

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const language = getWorkLanguage();
    const sessionSlug = 'sticky-session';
    const initialTrigger = 'Start the registered side dialog.';
    const initialBody = 'Initial assignment';
    const updatedTrigger = 'Update the registered side dialog while it is still running.';
    const updatedBody = 'Updated assignment';

    const initialAssignmentPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: initialBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    const updatedAssignmentPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatUpdatedAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: updatedBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    const expectedUpdatedResult = formatTellaskResponseContent({
      callName: 'tellask',
      callId: 'call-updated-round',
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent: updatedBody,
      responseBody: 'Updated assignment adopted.',
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
      sessionSlug,
    });

    await writeMockDb(tmpRoot, [
      {
        message: initialTrigger,
        role: 'user',
        response: 'Starting the side dialog.',
        funcCalls: [
          {
            id: 'call-initial-round',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: initialBody,
            },
          },
        ],
      },
      {
        message: initialAssignmentPrompt,
        role: 'user',
        response: 'Still working through the initial assignment.',
        delayMs: 1_500,
      },
      {
        message: updatedTrigger,
        role: 'user',
        response: 'Updating the side dialog now.',
        funcCalls: [
          {
            id: 'call-updated-round',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: updatedBody,
            },
          },
        ],
      },
      {
        message: updatedAssignmentPrompt,
        role: 'user',
        response: 'Updated assignment adopted.',
      },
      {
        message: expectedUpdatedResult,
        role: 'tool',
        response: 'Ack: updated result received.',
      },
    ]);

    await driveDialogStream(
      root,
      {
        content: initialTrigger,
        msgId: 'kernel-driver-registered-update-upnext-initial',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    await waitFor(
      async () => {
        const sideDialog = root.lookupSideDialog('pangu', sessionSlug);
        return sideDialog !== undefined && sideDialog.isLocked();
      },
      3_000,
      'registered sideDialog to start running the initial assignment',
    );

    const sideDialog = root.lookupSideDialog('pangu', sessionSlug);
    assert.ok(sideDialog, 'expected registered sideDialog after the first tellask');

    await driveDialogStream(
      root,
      {
        content: updatedTrigger,
        msgId: 'kernel-driver-registered-update-upnext-second',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    const pendingAfterUpdate = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(pendingAfterUpdate.length, 1, 'expected updated tellask to replace pending');
    assert.deepEqual(
      pendingAfterUpdate.map((record) => record.callId),
      ['call-updated-round'],
    );

    await waitFor(
      async () => {
        const sideDialogEvents = await DialogPersistence.loadCourseEvents(
          sideDialog.id,
          sideDialog.currentCourse,
          sideDialog.status,
        );
        return sideDialogEvents.some(
          (event) =>
            event.type === 'human_text_record' &&
            event.content.trim() === updatedAssignmentPrompt.trim(),
        );
      },
      4_000,
      'updated assignment to be rendered after the active turn boundary',
    );
    await waitFor(
      async () => listTellaskResultContents(root.msgs).includes(expectedUpdatedResult),
      4_000,
      'updated assignment result to flow back to tellasker',
    );
    await waitForAllDialogsUnlocked(root, 6_000);

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundResponse = rootEvents.find(
      (event): event is TellaskResultRecord =>
        event.type === 'tellask_result_record' && event.callId === 'call-updated-round',
    );
    assert.ok(updatedRoundResponse, 'expected updated round to receive the completed result');
    const pendingAfterUpdatedReply = await DialogPersistence.loadPendingSideDialogs(
      root.id,
      root.status,
    );
    assert.deepEqual(
      pendingAfterUpdatedReply.map((record) => record.callId),
      [],
      'after replying to the replacement round, no earlier pending round should be restored',
    );
    assert.equal(
      sideDialog.assignmentFromAsker.callId,
      'call-updated-round',
      'after replacement delivery, the sideDialog should keep the latest assignment frame',
    );
  });

  console.log('kernel-driver sideDialog-registered-update-queues-upnext: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-registered-update-queues-upnext: FAIL\n${message}`);
  process.exit(1);
});
