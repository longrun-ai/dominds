import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  NO_ACTIVE_REPLY_PREFIX_EN,
  REPLY_TOOL_REMINDER_PREFIX_EN,
  buildReplyObligationSuppressionGuideText,
} from '../../main/runtime/reply-prompt-copy';
import { setWorkLanguage } from '../../main/runtime/work-language';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function lastAssistantSayingContent(msgs: readonly ChatMessage[]): string | null {
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    const msg = msgs[index];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return msg.content;
    }
  }
  return null;
}

function assistantSayingContents(msgs: readonly ChatMessage[]): string[] {
  return msgs
    .filter(
      (msg): msg is Extract<ChatMessage, { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    )
    .map((msg) => msg.content);
}

function assertNoInjectedReplyGuidance(contents: readonly string[]): void {
  for (const content of contents) {
    assert.ok(
      !content.startsWith(ACTIVE_REPLY_TOOL_PREFIX_EN) &&
        !content.startsWith(NO_ACTIVE_REPLY_PREFIX_EN) &&
        !content.startsWith(REPLY_TOOL_REMINDER_PREFIX_EN),
      `unexpected injected reply guidance: ${content}`,
    );
  }
}

async function runMainDialogScenario(): Promise<void> {
  const interjectPrompt = 'Please handle this local interruption only.';
  const interjectResponse =
    'Handled the local interruption without touching the side dialog reply.';

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
    },
    {
      message: 'Reply delivered via `replyTellaskBack`.',
      role: 'tool',
      response: '',
      omitDefaultThinking: true,
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const activeCalleeDispatch = await root.createSideDialog(
    'pangu',
    ['@pangu'],
    'Background side dialog work remains active.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-active-callee-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      collectiveTargets: ['pangu'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(root.id, {
    calleeDialogId: activeCalleeDispatch.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'root-active-callee-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@pangu'],
    tellaskContent: 'Background side dialog work remains active.',
    targetAgentId: 'pangu',
    callId: 'root-active-callee-call',
    callSiteCourse: 1,
    callSiteGenseq: 1,
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back remains active.',
    'root-runtime-reply-directive',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target',
      targetDialogId: activeCalleeDispatch.id.selfId,
      tellaskContent: 'Please confirm the side dialog result.',
    },
  );

  await driveDialogStream(
    root,
    makeUserPrompt(interjectPrompt, 'root-user-interject-while-active-callee', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);

  assert.equal(lastAssistantSayingContent(root.msgs), interjectResponse);

  const events = await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status);
  const humanTextRecords = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
      event.type === 'human_text_record',
  );
  const interjectRecord = humanTextRecords.find(
    (event) => event.msgId === 'root-user-interject-while-active-callee',
  );
  assert.ok(interjectRecord, 'expected persisted user interjection record for main dialog');
  assert.equal(interjectRecord.content, interjectPrompt);
  assert.equal(
    interjectRecord.tellaskReplyDirective,
    undefined,
    'root interjection should not inherit the pending reply directive',
  );
  assertNoInjectedReplyGuidance(
    humanTextRecords.filter((event) => event.origin === 'user').map((event) => event.content),
  );

  const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
  assert.equal(pending.length, 1, 'root should retain the original active callee dispatch');
}

async function runSideDialogScenario(): Promise<void> {
  const interjectPrompt = 'Pause the nested side dialog and handle this local note first.';
  const interjectResponse = 'Handled the local note without replying to the tellasker.';

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const sideDialog = await root.createSideDialog('pangu', ['@pangu'], 'Finish the assigned task.', {
    callName: 'tellask',
    originMemberId: 'tester',
    askerDialogId: root.id.selfId,
    callId: 'root-to-pangu-call',
    callSiteCourse: 1,
    callSiteGenseq: 1,
    sessionSlug: 'parent-session',
    collectiveTargets: ['pangu'],
  });
  sideDialog.disableDiligencePush = true;

  const nestedSideDialog = await sideDialog.createSideDialog(
    'nuwa',
    ['@nuwa'],
    'Investigate a nested side dialog.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'pangu',
      askerDialogId: sideDialog.id.selfId,
      callId: 'pangu-to-nuwa-call',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      collectiveTargets: ['nuwa'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(sideDialog.id, {
    calleeDialogId: nestedSideDialog.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'pangu-to-nuwa-call-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@nuwa'],
    tellaskContent: 'Investigate a nested side dialog.',
    targetAgentId: 'nuwa',
    callId: 'pangu-to-nuwa-call',
    callSiteCourse: 1,
    callSiteGenseq: 1,
    callType: 'C',
  });

  await sideDialog.persistUserMessage(
    'Initial side dialog assignment from the tellasker.',
    'sideDialog-runtime-assignment',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: 'root-to-pangu-call',
      tellaskContent: 'Finish the assigned task.',
    },
  );

  await driveDialogStream(
    sideDialog,
    makeUserPrompt(interjectPrompt, 'sideDialog-user-interject-while-active-callee', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);

  assert.ok(
    assistantSayingContents(sideDialog.msgs).includes(interjectResponse),
    'expected visible answer to the sideDialog user interjection even if later follow-up runs append more messages',
  );

  const events = await DialogPersistence.loadCourseEvents(
    sideDialog.id,
    sideDialog.currentCourse,
    sideDialog.status,
  );
  const humanTextRecords = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
      event.type === 'human_text_record',
  );
  const interjectRecord = humanTextRecords.find(
    (event) => event.msgId === 'sideDialog-user-interject-while-active-callee',
  );
  assert.ok(interjectRecord, 'expected persisted user interjection record for sideDialog');
  assert.equal(interjectRecord.content, interjectPrompt);
  assert.equal(
    interjectRecord.tellaskReplyDirective,
    undefined,
    'sideDialog interjection should not inherit the tellasker reply directive',
  );
  assertNoInjectedReplyGuidance(
    humanTextRecords.filter((event) => event.origin === 'user').map((event) => event.content),
  );

  const pending = await DialogPersistence.loadActiveCalleeDispatches(
    sideDialog.id,
    sideDialog.status,
  );
  assert.equal(pending.length, 1, 'sideDialog should retain its nested active callee dispatch');
}

async function runRepeatedRootInterjectionScenario(): Promise<void> {
  const firstPrompt = 'First interruption while the side dialog remains active.';
  const secondPrompt = 'Second interruption while the same side dialog remains active.';
  const firstResponse = 'Handled the first interruption.';
  const secondResponse =
    'Handled the second interruption while keeping the previously recorded long-line suppression notice in context.';

  await writeMockDb(process.cwd(), [
    {
      message: firstPrompt,
      role: 'user',
      response: firstResponse,
    },
    {
      message: secondPrompt,
      role: 'user',
      response: secondResponse,
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const activeCalleeDispatch = await root.createSideDialog(
    'pangu',
    ['@pangu'],
    'Background side dialog work remains active.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-active-callee-call-repeated',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      collectiveTargets: ['pangu'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(root.id, {
    calleeDialogId: activeCalleeDispatch.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'root-active-callee-repeated-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@pangu'],
    tellaskContent: 'Background side dialog work remains active.',
    targetAgentId: 'pangu',
    callId: 'root-active-callee-call-repeated',
    callSiteCourse: 1,
    callSiteGenseq: 1,
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back remains active.',
    'root-runtime-reply-directive-repeated',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-repeated',
      targetDialogId: activeCalleeDispatch.id.selfId,
      tellaskContent: 'Please confirm the side dialog result.',
    },
  );

  await driveDialogStream(
    root,
    makeUserPrompt(firstPrompt, 'root-user-interject-active-callee-first', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);
  assert.equal(lastAssistantSayingContent(root.msgs), firstResponse);

  await driveDialogStream(
    root,
    makeUserPrompt(secondPrompt, 'root-user-interject-active-callee-second', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);
  assert.equal(lastAssistantSayingContent(root.msgs), secondResponse);

  const events = await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status);
  const runtimeGuideRecords = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'runtime_guide_record' }> =>
      event.type === 'runtime_guide_record',
  );
  assert.equal(
    runtimeGuideRecords.length,
    2,
    'root interjections while blocked on side dialogs should append one reply suppression runtime-guide record per interjection',
  );

  const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
  assert.equal(
    latest?.pendingUserInterjectionReply,
    undefined,
    'visible user-interjection answers should clear the pending reply marker',
  );
}

async function runProceedingReplyObligationScenario(): Promise<void> {
  const interjectPrompt = 'Answer this local question first before replying to the tellasker.';
  const interjectResponse = 'Handled the local question first.';
  const replyDirective = {
    expectedReplyCallName: 'replyTellaskBack' as const,
    targetCallId: 'reply-back-target-proceeding',
    targetDialogId: '',
    tellaskContent: 'Please deliver the tellasker reply once ready.',
  };

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;
  const boundReplyDirective = {
    ...replyDirective,
    targetDialogId: root.id.selfId,
  };
  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
    },
  ]);

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-proceeding',
    'markdown',
    'runtime',
    'en',
    undefined,
    boundReplyDirective,
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    boundReplyDirective,
    root.status,
  );

  const scheduled: KernelDriverDriveCallOptions[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      root,
      makeUserPrompt(interjectPrompt, 'root-user-interject-while-proceeding-reply-obligation', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    ],
    scheduleDrive: (scheduledDialog, options) => {
      assert.equal(scheduledDialog, root);
      scheduled.push(options);
    },
    driveDialog: async () => {},
  });

  assert.ok(
    assistantSayingContents(root.msgs).includes(interjectResponse),
    'expected visible answer to the user interjection before ordinary long-line reply handling resumes',
  );

  const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
  assert.equal(
    latest?.pendingUserInterjectionReply,
    undefined,
    'visible user-interjection answer should clear the pending reply marker',
  );
  const answersToHuman = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
  assert.equal(
    answersToHuman.some((answer) => answer.content === interjectResponse),
    false,
    'direct visible user-interjection answer should not persist A2H when no automatic follow-up drive runs',
  );
  assert.equal(
    scheduled.length,
    0,
    'direct visible answer should not synthesize a special follow-up; normal drive rules own continuation',
  );
  assert.deepEqual(
    await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
    boundReplyDirective,
    'direct visible answer should leave the active reply obligation for the ordinary state machine',
  );
  const deliveredEvents = await DialogPersistence.loadCourseEvents(
    root.id,
    root.currentCourse,
    root.status,
  );

  const humanTextRecords = deliveredEvents.filter(
    (event): event is Extract<(typeof deliveredEvents)[number], { type: 'human_text_record' }> =>
      event.type === 'human_text_record',
  );
  assertNoInjectedReplyGuidance(
    humanTextRecords.filter((event) => event.origin === 'user').map((event) => event.content),
  );
}

async function runProceedingReplyObligationStructuredAnsweringScenario(): Promise<void> {
  const interjectPrompt =
    'Answer this local question through structured answering before replying to the tellasker.';
  const answeringContent = 'Handled the local question through structured answering.';
  const replyDirective = {
    expectedReplyCallName: 'replyTellaskBack' as const,
    targetCallId: 'reply-back-target-structured-answering',
    targetDialogId: '',
    tellaskContent: 'Please deliver the tellasker reply once ready.',
  };

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;
  const boundReplyDirective = {
    ...replyDirective,
    targetDialogId: root.id.selfId,
  };
  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: '',
      omitDefaultThinking: true,
      answeringResponse: answeringContent,
    },
  ]);

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-structured-answering',
    'markdown',
    'runtime',
    'en',
    undefined,
    boundReplyDirective,
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    boundReplyDirective,
    root.status,
  );

  const scheduled: KernelDriverDriveCallOptions[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      root,
      makeUserPrompt(interjectPrompt, 'root-user-interject-structured-answering', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    ],
    scheduleDrive: (scheduledDialog, options) => {
      assert.equal(scheduledDialog, root);
      scheduled.push(options);
    },
    driveDialog: async () => {},
  });

  const answersToHuman = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
  assert.ok(
    answersToHuman.some((answer) => answer.content === answeringContent),
    'structured answering should persist an A2H record for the user interjection',
  );
  assert.equal(
    scheduled.length,
    0,
    'structured A2H should not synthesize a special follow-up; normal drive rules own continuation',
  );
}

async function runStructuredAnsweringWithVisibleSayingDoesNotDuplicateA2HScenario(): Promise<void> {
  const interjectPrompt =
    'Answer visibly and also provide structured answering before replying to the tellasker.';
  const visibleAnswer = 'Visible transcript answer for the local question.';
  const answeringContent = 'Structured A2H answer for the local question.';
  const replyDirective = {
    expectedReplyCallName: 'replyTellaskBack' as const,
    targetCallId: 'reply-back-target-answering-and-saying',
    targetDialogId: '',
    tellaskContent: 'Please deliver the tellasker reply once ready.',
  };

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;
  const boundReplyDirective = {
    ...replyDirective,
    targetDialogId: root.id.selfId,
  };
  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: visibleAnswer,
      omitDefaultThinking: true,
      answeringResponse: answeringContent,
    },
  ]);

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-answering-and-saying',
    'markdown',
    'runtime',
    'en',
    undefined,
    boundReplyDirective,
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    boundReplyDirective,
    root.status,
  );

  const scheduled: KernelDriverDriveCallOptions[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      root,
      makeUserPrompt(interjectPrompt, 'root-user-interject-answering-and-saying', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    ],
    scheduleDrive: (scheduledDialog, options) => {
      assert.equal(scheduledDialog, root);
      scheduled.push(options);
    },
    driveDialog: async () => {},
  });

  assert.ok(
    assistantSayingContents(root.msgs).includes(visibleAnswer),
    'visible saying should still remain in the transcript',
  );
  const answersToHuman = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
  assert.deepEqual(
    answersToHuman.map((answer) => answer.content),
    [answeringContent],
    'same-round structured answering should suppress duplicate A2H recovery from visible saying',
  );
  assert.equal(
    scheduled.length,
    0,
    'structured A2H should not synthesize a special long-line follow-up',
  );
}

async function runInvalidAnswerHumanStillAllowsVisibleInterjectionAnswerScenario(): Promise<void> {
  const interjectPrompt =
    'Answer this local question visibly, then accidentally call answerHuman incorrectly.';
  const visibleAnswer = 'Visible answer should still settle the local user interjection.';
  const replyDirective = {
    expectedReplyCallName: 'replyTellaskBack' as const,
    targetCallId: 'reply-back-target-invalid-answer-human',
    targetDialogId: '',
    tellaskContent: 'Please deliver the tellasker reply once ready.',
  };

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;
  const boundReplyDirective = {
    ...replyDirective,
    targetDialogId: root.id.selfId,
  };
  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: visibleAnswer,
      omitDefaultThinking: true,
      funcCalls: [
        {
          id: 'invalid-answer-human-after-visible-answer',
          name: 'answerHuman',
          arguments: {},
        },
      ],
    },
  ]);

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-invalid-answer-human',
    'markdown',
    'runtime',
    'en',
    undefined,
    boundReplyDirective,
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    boundReplyDirective,
    root.status,
  );

  const scheduled: KernelDriverDriveCallOptions[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      root,
      makeUserPrompt(interjectPrompt, 'root-user-interject-invalid-answer-human', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    ],
    scheduleDrive: (scheduledDialog, options) => {
      assert.equal(scheduledDialog, root);
      scheduled.push(options);
    },
    driveDialog: async () => {},
  });

  const answersToHuman = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
  assert.equal(
    answersToHuman.filter((answer) => answer.content === visibleAnswer).length,
    1,
    'invalid answerHuman should not prevent the same-round visible answer from becoming A2H',
  );
  assert.equal(
    scheduled.length,
    0,
    'visible A2H should not synthesize a special long-line follow-up after invalid answerHuman',
  );
}

async function runToolOnlyInterjectionDoesNotAutoContinueLongLineScenario(): Promise<void> {
  const interjectPrompt = 'Discuss the blocker before resuming the tellasker reply.';

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: '',
      omitDefaultThinking: true,
      funcCalls: [
        {
          id: 'tool-only-interjection-ask-human',
          name: 'askHuman',
          arguments: { tellaskContent: 'Please clarify the blocker before we resume.' },
        },
      ],
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-tool-only',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-tool-only',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the tellasker reply once ready.',
    },
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-tool-only',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the tellasker reply once ready.',
    },
    root.status,
  );

  const scheduled: KernelDriverDriveCallOptions[] = [];
  await executeDriveRound({
    runtime: createKernelDriverRuntimeState(),
    driveArgs: [
      root,
      makeUserPrompt(interjectPrompt, 'root-user-interject-tool-only', {
        userLanguageCode: 'en',
      }),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    ],
    scheduleDrive: (scheduledDialog, options) => {
      assert.equal(scheduledDialog, root);
      scheduled.push(options);
    },
    driveDialog: async () => {},
  });

  assert.equal(
    lastAssistantSayingContent(root.msgs),
    null,
    'tool-only interjection test setup should not produce a visible assistant answer',
  );

  const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
  assert.equal(
    latest?.pendingRuntimePrompt,
    undefined,
    'a tool-only interjection must not queue automatic long-line continuation before a visible user answer',
  );
  assert.equal(
    root.peekQueuedPrompt(),
    undefined,
    'a tool-only interjection must not enqueue an in-memory long-line continuation prompt',
  );
  assert.equal(
    latest?.pendingUserInterjectionReply?.msgId,
    'root-user-interject-tool-only',
    'the user interjection remains pending until a visible assistant answer settles it',
  );
  assert.equal(
    scheduled.length,
    0,
    'a tool-only interjection must not schedule an automatic long-line follow-up',
  );
  assert.deepEqual(
    await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-tool-only',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the tellasker reply once ready.',
    },
    'the ordinary active reply obligation should remain durable while the user answer is pending',
  );
}

function runSuppressionGuidePriorityScenario(): void {
  const zhGuide = buildReplyObligationSuppressionGuideText('zh');
  assert.ok(
    zhGuide.includes('本轮最新用户消息是真实用户插话'),
    'zh suppression guide should explicitly identify the latest user message as the active topic',
  );
  assert.ok(
    zhGuide.includes('不要在回答当前用户消息前切回旧任务、旧工具流程或旧收口'),
    'zh suppression guide should keep old task/tool/closure instructions behind the visible answer',
  );
  assert.ok(
    zhGuide.includes('不要因为旧长线任务、旧技能提示或旧提醒项去调用工具'),
    'zh suppression guide should prevent old skill/reminder hints from driving tool calls',
  );
}

async function runQ4HAnswerNeverCountsAsInterjectionScenario(): Promise<void> {
  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  await root.persistUserMessage(
    'A tellasker reply remains active after this askHuman round.',
    'root-runtime-reply-directive-q4h',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-q4h',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Deliver the tellasker reply once the askHuman answer is in.',
    },
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-q4h',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Deliver the tellasker reply once the askHuman answer is in.',
    },
    root.status,
  );
  await DialogPersistence.appendQuestion4HumanState(
    root.id,
    {
      id: 'q4h-root-question',
      tellaskContent: 'Need a formal human answer before continuing.',
      askedAt: formatUnifiedTimestamp(new Date()),
      callId: 'ask-human-root-call',
      callSiteRef: { course: 1, messageIndex: 0 },
    },
    root.status,
  );

  const guidance = await resolvePromptReplyGuidance({
    dlg: root,
    prompt: makeUserPrompt('Here is the formal askHuman answer.', 'root-q4h-answer-msg', {
      userLanguageCode: 'en',
      q4hAnswerCallId: 'ask-human-root-call',
    }),
    language: 'en',
  });

  assert.equal(
    guidance.isQ4HAnswerPrompt,
    true,
    'q4hAnswerCallId should explicitly classify the prompt as askHuman answer continuation',
  );
  assert.equal(
    guidance.suppressInterDialogReplyGuidance,
    false,
    'formal askHuman answers must never be downgraded into user-interjection suppression',
  );
  assert.deepEqual(guidance.activeReplyDirective, {
    expectedReplyCallName: 'replyTellaskBack',
    targetCallId: 'reply-back-target-q4h',
    targetDialogId: root.id.selfId,
    tellaskContent: 'Deliver the tellasker reply once the askHuman answer is in.',
  });
  assert.equal(
    guidance.promptContent !== undefined &&
      guidance.promptContent.startsWith(ACTIVE_REPLY_TOOL_PREFIX_EN),
    true,
    'askHuman answers should continue the active reply-obligation path instead of being downgraded into interjection suppression',
  );
  assert.ok(
    guidance.promptContent !== undefined &&
      guidance.promptContent.includes('Here is the formal askHuman answer.'),
    'the formal askHuman answer content itself should still be preserved inside the continued prompt',
  );
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
    setWorkLanguage('en');
    await writeStandardMinds(process.cwd(), {
      includePangu: true,
      extraMembers: ['nuwa'],
      memberTools: ['env_get'],
    });
    await runMainDialogScenario();
    await runSideDialogScenario();
    await runRepeatedRootInterjectionScenario();
    await runProceedingReplyObligationScenario();
    await runProceedingReplyObligationStructuredAnsweringScenario();
    await runStructuredAnsweringWithVisibleSayingDoesNotDuplicateA2HScenario();
    await runInvalidAnswerHumanStillAllowsVisibleInterjectionAnswerScenario();
    await runToolOnlyInterjectionDoesNotAutoContinueLongLineScenario();
    runSuppressionGuidePriorityScenario();
    await runQ4HAnswerNeverCountsAsInterjectionScenario();
  });

  console.log('kernel-driver user-interject-while-active-callee-suppresses-reply-guidance: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver user-interject-while-active-callee-suppresses-reply-guidance: FAIL\n' + message,
  );
  process.exit(1);
});
