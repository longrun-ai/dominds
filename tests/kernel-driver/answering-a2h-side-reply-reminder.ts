import assert from 'node:assert/strict';

import type { SideDialog } from '../../main/dialog';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
  type KernelDriverRuntimeSideDialogPrompt,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { buildUserInterjectionPauseStopReason } from '../../main/runtime/interjection-pause-stop';
import { isReplyToolReminderPromptContent } from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
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

async function runUserInterjectionAnswerHumanResumesSuppressedReplyObligation(): Promise<void> {
  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const request = 'Finish the side-dialog task after handling local human interjections.';
  const callId = 'suppressed-user-interjection-side-call';
  const sideDialog = await root.createSideDialog('pangu', ['@pangu'], request, {
    callName: 'tellask',
    originMemberId: 'tester',
    askerDialogId: root.id.selfId,
    callId,
    callSiteCourse: 1,
    callSiteGenseq: 1,
    sessionSlug: 'suppressed-user-interjection-session',
    collectiveTargets: ['pangu'],
  });
  sideDialog.disableDiligencePush = true;

  const interjectionPauseReason = buildUserInterjectionPauseStopReason();
  await DialogPersistence.mutateDialogLatest(
    sideDialog.id,
    () => ({
      kind: 'patch',
      patch: {
        displayState: {
          kind: 'stopped',
          reason: interjectionPauseReason,
          continueEnabled: true,
        },
        executionMarker: {
          kind: 'interrupted',
          reason: interjectionPauseReason,
        },
      },
    }),
    sideDialog.status,
  );

  const interjectionPrompt = 'Please acknowledge this local interruption before resuming.';
  const answerHumanContent = 'Acknowledged the local interruption; now resume the requester work.';
  await writeMockDb(process.cwd(), [
    {
      message: interjectionPrompt,
      role: 'user',
      response: '',
      omitDefaultThinking: true,
      funcCalls: [
        {
          id: 'answer-human-suppressed-side-interjection',
          name: 'answerHuman',
          arguments: {
            answerContent: answerHumanContent,
          },
        },
      ],
    },
  ]);

  const scheduledDrives: CapturedScheduledDrive[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      sideDialog,
      makeUserPrompt(interjectionPrompt, 'suppressed-side-user-interjection', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
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
  assert.equal(answers.length, 1, 'answerHuman should append one A2H record');
  assert.equal(answers[0]?.content, answerHumanContent);
  assert.equal(
    scheduledDrives.length,
    1,
    'answerHuman after a suppressed user interjection should resume the requester reply obligation',
  );
  const scheduledContinuation = scheduledDrives[0]?.options.driveOptions?.businessContinuation;
  if (scheduledContinuation?.kind !== 'inter_dialog_reply') {
    throw new Error(
      'expected scheduled drive to carry the resumed inter-dialog reply continuation',
    );
  }
  assert.equal(
    scheduledContinuation.tellaskReplyDirective.targetCallId,
    callId,
    'scheduled continuation should preserve the requester reply directive',
  );
  assert.equal(
    scheduledContinuation.calleeDialogReplyTarget?.callerDialogId,
    root.id.selfId,
    'scheduled continuation should preserve the requester dialog target',
  );
  assert.equal(
    scheduledContinuation.calleeDialogReplyTarget?.callType,
    'B',
    'scheduled continuation should preserve the tellask call type',
  );
  assert.equal(
    scheduledContinuation.calleeDialogReplyTarget?.callId,
    callId,
    'scheduled continuation should preserve the requester reply target',
  );

  const queuedReplyReminder = sideDialog.peekQueuedPrompt();
  if (queuedReplyReminder?.kind !== 'new_course_runtime_sideDialog') {
    throw new Error(
      'expected queued sideDialog runtime reply reminder after suppressed user interjection',
    );
  }
  assert.equal(queuedReplyReminder.tellaskReplyDirective.targetCallId, callId);
  assert.equal(queuedReplyReminder.tellaskReplyDirective.expectedReplyCallName, 'replyTellask');
  assert.equal(
    queuedReplyReminder.calleeDialogReplyTarget.callerDialogId,
    root.id.selfId,
    'suppressed-interjection continuation should preserve the requester dialog target',
  );
  assert.equal(
    queuedReplyReminder.calleeDialogReplyTarget.callType,
    'B',
    'suppressed-interjection continuation should preserve the tellask call type',
  );
  assert.equal(
    queuedReplyReminder.calleeDialogReplyTarget.callId,
    callId,
    'suppressed-interjection continuation should preserve the requester reply target',
  );
  assert.equal(
    isReplyToolReminderPromptContent(queuedReplyReminder.prompt),
    true,
    'suppressed-interjection continuation should use the reply reminder prompt',
  );

  const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
  assert.equal(
    latest?.pendingRuntimePrompt?.tellaskReplyDirective?.targetCallId,
    callId,
    'suppressed-interjection reply reminder must be durable for backend/restart recovery',
  );
  assert.equal(
    latest?.pendingRuntimePrompt?.calleeDialogReplyTarget?.callerDialogId,
    root.id.selfId,
    'suppressed-interjection reply target dialog must be durable for backend/restart recovery',
  );
  assert.equal(
    latest?.pendingRuntimePrompt?.calleeDialogReplyTarget?.callType,
    'B',
    'suppressed-interjection reply target call type must be durable for backend/restart recovery',
  );
  assert.equal(
    latest?.pendingRuntimePrompt?.calleeDialogReplyTarget?.callId,
    callId,
    'suppressed-interjection reply target must be durable for backend/restart recovery',
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
    await runUserInterjectionAnswerHumanResumesSuppressedReplyObligation();
  });

  console.log('kernel-driver answering A2H side reply reminder: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver answering A2H side reply reminder: FAIL\n${message}`);
  process.exit(1);
});
