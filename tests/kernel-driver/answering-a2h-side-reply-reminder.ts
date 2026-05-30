import assert from 'node:assert/strict';

import type { SideDialog } from '../../main/dialog';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
  type KernelDriverRuntimeSideDialogPrompt,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { isReplyToolReminderPromptContent } from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  makeDriveOptions,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

type CapturedScheduledDrive = Readonly<{
  dialog: SideDialog;
  options: KernelDriverDriveCallOptions;
}>;

type AnsweringReminderVariant = 'structured_answering' | 'answer_human_tool';

async function runAnsweringReminderScenario(args: {
  variant: AnsweringReminderVariant;
  prompt: string;
  answeringContent: string;
}): Promise<void> {
  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const request = `Finish the side-dialog task and report back to the requester (${args.variant}).`;
  const callId = `${args.variant}-side-call`;
  const sideDialog = await root.createSideDialog('pangu', ['@pangu'], request, {
    callName: 'tellaskSessionless',
    originMemberId: 'tester',
    askerDialogId: root.id.selfId,
    callId,
    callSiteCourse: 1,
    callSiteGenseq: 1,
    collectiveTargets: ['pangu'],
  });

  const scheduledDrives: CapturedScheduledDrive[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      sideDialog,
      {
        content: args.prompt,
        msgId: `${args.variant}-side-runtime-prompt`,
        grammar: 'markdown',
        origin: 'runtime',
        tellaskReplyDirective: {
          expectedReplyCallName: 'replyTellaskSessionless',
          targetDialogId: root.id.selfId,
          targetCallId: callId,
          tellaskContent: request,
        },
        calleeDialogReplyTarget: {
          callerDialogId: root.id.selfId,
          callType: 'C',
          callId,
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      } satisfies KernelDriverRuntimeSideDialogPrompt,
      true,
      makeDriveOptions({
        suppressDiligencePush: true,
        source: 'kernel_driver_sideDialog_init',
        reason: `${args.variant}_side_reply_reminder`,
      }),
    ],
    scheduleDrive: (dialog, options) => {
      assert.equal(dialog.id.selfId, sideDialog.id.selfId);
      scheduledDrives.push({ dialog, options });
    },
    driveDialog: async () => {
      throw new Error('test does not use nested driveDialog invocations');
    },
  });

  const answers = await DialogPersistence.loadAnswersToHumanState(sideDialog.id, sideDialog.status);
  assert.equal(answers.length, 1, `${args.variant} should append one A2H record`);
  assert.equal(answers[0]?.content, args.answeringContent);

  assert.equal(
    scheduledDrives.length,
    1,
    `${args.variant} output should queue one reply reminder follow-up`,
  );
  assert.equal(scheduledDrives[0]?.options.driveOptions?.reason, 'follow_up_prompt');
  assert.equal(
    scheduledDrives[0]?.options.humanPrompt,
    undefined,
    'reply reminder follow-up should be queued onto the side dialog',
  );

  const queuedReplyReminder = sideDialog.peekQueuedPrompt();
  if (queuedReplyReminder?.kind !== 'new_course_runtime_sideDialog') {
    throw new Error('expected queued sideDialog runtime reply reminder');
  }
  assert.equal(
    queuedReplyReminder.tellaskReplyDirective.targetCallId,
    callId,
    'queued reminder should carry the active requester reply obligation',
  );
  assert.equal(
    queuedReplyReminder.calleeDialogReplyTarget.callId,
    callId,
    'queued reminder should target the original pending tellask call',
  );
  assert.equal(
    isReplyToolReminderPromptContent(queuedReplyReminder.prompt),
    true,
    'answering-only reminder should keep reply-reminder/direct-fallback semantics',
  );
  assert.match(
    queuedReplyReminder.prompt,
    /answering.*answerHuman|answerHuman.*answering/,
    'custom reminder should explicitly distinguish answering/answerHuman from requester reply',
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });
    const structuredPrompt = 'Runtime side prompt that will answer the human only.';
    const structuredContent = 'This is useful to the human, but it is not the requester reply.';
    const answerHumanPrompt = 'Runtime side prompt that will call answerHuman only.';
    const answerHumanContent =
      'This answerHuman content is useful to the human, but not delivered to the requester.';
    await writeMockDb(tmpRoot, [
      {
        message: structuredPrompt,
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        answeringResponse: structuredContent,
      },
      {
        message: answerHumanPrompt,
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        funcCalls: [
          {
            id: 'answer-human-side-tool-call',
            name: 'answerHuman',
            arguments: {
              answerContent: answerHumanContent,
            },
          },
        ],
      },
    ]);

    await runAnsweringReminderScenario({
      variant: 'structured_answering',
      prompt: structuredPrompt,
      answeringContent: structuredContent,
    });
    await runAnsweringReminderScenario({
      variant: 'answer_human_tool',
      prompt: answerHumanPrompt,
      answeringContent: answerHumanContent,
    });
  });

  console.log('kernel-driver answering A2H side reply reminder: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver answering A2H side reply reminder: FAIL\n${message}`);
  process.exit(1);
});
