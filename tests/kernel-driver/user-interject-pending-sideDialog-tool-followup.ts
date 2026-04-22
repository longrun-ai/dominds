import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
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
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      memberTools: ['env_get'],
    });

    const language = getWorkLanguage();
    const initialPrompt = 'Start a background tellask and wait for @pangu.';
    const tellaskBody = 'Please investigate in the background and report back later.';
    const pendingSideDialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: tellaskBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const interjectPrompt = 'While waiting for @pangu, inspect one local env value.';
    const interjectFollowUp = 'I finished the local env check while @pangu is still pending.';
    const delayedSideDialogResponse = 'Background investigation is complete.';
    const mirroredSideDialogResponse = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: 'call-root-background-tellask',
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent: tellaskBody,
      responseBody: delayedSideDialogResponse,
      status: 'completed',
      deliveryMode: 'reply_tool',
      language,
    });
    await writeMockDb(tmpRoot, [
      {
        message: initialPrompt,
        role: 'user',
        response: 'Starting the background tellask now.',
        funcCalls: [
          {
            id: 'call-root-background-tellask',
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: tellaskBody,
            },
          },
        ],
      },
      {
        message: interjectPrompt,
        role: 'user',
        response: 'I will inspect one env value before we keep waiting.',
        funcCalls: [
          {
            id: 'call-root-interject-env-get',
            name: 'env_get',
            arguments: {
              key: 'DOMINDS_TEST_PENDING_SUBDIALOG_INTERJECTION',
            },
          },
        ],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: interjectFollowUp,
        contextContains: ['I will inspect one env value before we keep waiting.'],
      },
      {
        message: pendingSideDialogPrompt,
        role: 'user',
        response: delayedSideDialogResponse,
        delayMs: 2_000,
      },
      {
        message: mirroredSideDialogResponse,
        role: 'tool',
        response: 'Acknowledged. I have the background result now.',
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(initialPrompt, 'kernel-driver-user-interject-pending-sideDialog-initial'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
        return pending.length === 1;
      },
      3_000,
      'main dialog to enter pending-sideDialog wait state',
    );

    await driveDialogStream(
      root,
      makeUserPrompt(interjectPrompt, 'kernel-driver-user-interject-pending-sideDialog-followup'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = rootEvents.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      3,
      'user interjection should get one tool round plus one post-tool follow-up generation while the sideDialog is still pending',
    );

    const assistantSayings = root.msgs.filter(
      (
        msg,
      ): msg is Extract<(typeof root.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      interjectFollowUp,
      'interjection drive should finish its post-tool follow-up before suspending again on the pending sideDialog',
    );

    const pendingAfterInterjection = await DialogPersistence.loadPendingSideDialogs(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterInterjection.length,
      1,
      'the original tellask sideDialog should still be pending after the interjection follow-up completes',
    );

    await waitForAllDialogsUnlocked(root, 6_000);
  });

  console.log('kernel-driver user-interject-pending-sideDialog-tool-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver user-interject-pending-sideDialog-tool-followup: FAIL\n${message}`);
  process.exit(1);
});
