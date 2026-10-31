import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator, LlmRequestContext } from '../../main/llm/gen';
import {
  getLlmGenerator,
  registerLlmGenerator,
  unregisterLlmGenerator,
} from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
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

const evidence = semanticEvidenceCollector('dominds-local-interjections-');
const apiType = 'observed-user-interjection';
const invalidAnswerRecovery = 'invalid-answer-continuation-data';
function isInvalidAnswerContinuation(context: readonly ChatMessage[]): boolean {
  return context.some(
    (message) =>
      message.type === 'func_call_msg' &&
      message.id === 'invalid-answer-human-after-visible-answer',
  );
}
let fixtureFailure: unknown;
let fixtureFailed = false;
let requestNo = 0;
function assertProviderSucceeded() {
  if (fixtureFailed) throw fixtureFailure;
}
async function captureRequest(
  request: LlmRequestContext,
  systemPrompt: string,
  context: ChatMessage[],
  streaming: boolean,
) {
  if (!streaming) return;
  requestNo += 1;
  const id = new DialogID(request.dialogSelfId, request.dialogRootId);
  const obligation = await DialogPersistence.loadActiveTellaskReplyObligation(id);
  const pending = await DialogPersistence.loadActiveCalleeDispatches(id);
  evidence.record({
    id: `request-${requestNo}`,
    scenario:
      'A real user input receives a local response while background work or an earlier requester reply obligation is still active.',
    businessValue:
      'Respond to the current human without losing the existing task, duplicating its reply or letting old guidance choose the current action.',
    context: {
      language: getWorkLanguage(),
      streaming,
      dialogScope: request.dialogSelfId === request.dialogRootId ? 'mainDialog' : 'sideDialog',
      activeReply: JSON.stringify(obligation ?? null),
      pendingCalleeCount: pending.length,
      scope:
        'Controlled MockGen boundary; component rounds separately capture scheduling decisions. This material does not establish real model compliance.',
    },
    reviewQuestions: [
      'Does the actual request prioritize the latest user input while keeping earlier work and requester replies distinct?',
      'Are tool use and answer/ask/requester channels consistent with the actual system, context and outstanding obligations?',
    ],
    actualText: JSON.stringify({ systemPrompt, context }, null, 2),
  });
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
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const activeCalleeDispatch = await root.createSideDialog(
    'worker',
    ['@worker'],
    'Background side dialog work remains active.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-active-callee-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['worker'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(root.id, {
    calleeDialogId: activeCalleeDispatch.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'root-active-callee-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@worker'],
    tellaskContent: 'Background side dialog work remains active.',
    targetAgentId: 'worker',
    callId: 'root-active-callee-call',
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back remains active.',
    'root-runtime-reply-directive',
    'markdown',
    'runtime',
    getWorkLanguage(),
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
      userLanguageCode: getWorkLanguage(),
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

  const sideDialog = await root.createSideDialog(
    'worker',
    ['@worker'],
    'Finish the assigned task.',
    {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-to-worker-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'parent-session',
      collectiveTargets: ['worker'],
    },
  );
  sideDialog.disableDiligencePush = true;

  const nestedSideDialog = await sideDialog.createSideDialog(
    'helper',
    ['@helper'],
    'Investigate a nested side dialog.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'worker',
      askerDialogId: sideDialog.id.selfId,
      callId: 'worker-to-helper-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['helper'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(sideDialog.id, {
    calleeDialogId: nestedSideDialog.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'worker-to-helper-call-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@helper'],
    tellaskContent: 'Investigate a nested side dialog.',
    targetAgentId: 'helper',
    callId: 'worker-to-helper-call',
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    callType: 'C',
  });

  await sideDialog.persistUserMessage(
    'Initial side dialog assignment from the tellasker.',
    'sideDialog-runtime-assignment',
    'markdown',
    'runtime',
    getWorkLanguage(),
    undefined,
    {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: 'root-to-worker-call',
      tellaskContent: 'Finish the assigned task.',
    },
  );

  await driveDialogStream(
    sideDialog,
    makeUserPrompt(interjectPrompt, 'sideDialog-user-interject-while-active-callee', {
      userLanguageCode: getWorkLanguage(),
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
    'worker',
    ['@worker'],
    'Background side dialog work remains active.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: 'root-active-callee-call-repeated',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['worker'],
    },
  );
  await DialogPersistence.appendActiveCalleeDispatch(root.id, {
    calleeDialogId: activeCalleeDispatch.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: 'root-active-callee-repeated-batch',
    callName: 'tellaskSessionless',
    mentionList: ['@worker'],
    tellaskContent: 'Background side dialog work remains active.',
    targetAgentId: 'worker',
    callId: 'root-active-callee-call-repeated',
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back remains active.',
    'root-runtime-reply-directive-repeated',
    'markdown',
    'runtime',
    getWorkLanguage(),
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
      userLanguageCode: getWorkLanguage(),
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);
  assert.equal(lastAssistantSayingContent(root.msgs), firstResponse);

  await driveDialogStream(
    root,
    makeUserPrompt(secondPrompt, 'root-user-interject-active-callee-second', {
      userLanguageCode: getWorkLanguage(),
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
    getWorkLanguage(),
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
        userLanguageCode: getWorkLanguage(),
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
    getWorkLanguage(),
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
        userLanguageCode: getWorkLanguage(),
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
    getWorkLanguage(),
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
        userLanguageCode: getWorkLanguage(),
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
    getWorkLanguage(),
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
        userLanguageCode: getWorkLanguage(),
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
  assert.equal(answersToHuman.length, 1);
  assert.ok(assistantSayingContents(root.msgs).includes(invalidAnswerRecovery));
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
    getWorkLanguage(),
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
        userLanguageCode: getWorkLanguage(),
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

async function runQ4HAnswerNeverCountsAsInterjectionScenario(): Promise<void> {
  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  await root.persistUserMessage(
    'A tellasker reply remains active after this askHuman round.',
    'root-runtime-reply-directive-q4h',
    'markdown',
    'runtime',
    getWorkLanguage(),
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
      userLanguageCode: getWorkLanguage(),
      q4hAnswerCallId: 'ask-human-root-call',
    }),
    language: getWorkLanguage(),
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
  const body = 'Here is the formal askHuman answer.';
  assert.ok(
    guidance.promptContent?.endsWith(body),
    'the supplied human answer body survives wrapping',
  );
  evidence.record({
    id: `q4h-classification-${getWorkLanguage()}`,
    scenario:
      'An explicit askHuman-answer continuation coexists with an outstanding requester reply obligation.',
    businessValue:
      'Resume the asked question rather than misclassifying its answer as a separate local interruption.',
    context: {
      language: getWorkLanguage(),
      activeReply: JSON.stringify(guidance.activeReplyDirective),
      scope: 'Direct reply-guidance classification API; not actual human-answer delivery.',
    },
    reviewQuestions: [
      'Does the actual continuation guidance preserve the supplied human answer and correctly address the active requester obligation?',
    ],
    actualText: JSON.stringify(guidance, null, 2),
  });
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
    const mock = getLlmGenerator('mock');
    assert.ok(mock);
    const observed: LlmGenerator = {
      apiType,
      classifyFailure(error) {
        fixtureFailure = error;
        fixtureFailed = true;
        return {
          kind: 'fatal',
          code: 'test_provider_failure',
          message: error instanceof Error ? error.message : String(error),
        };
      },
      async genToReceiver(
        provider,
        agent,
        system,
        tools,
        request,
        context,
        receiver,
        genseq,
        signal,
      ) {
        await captureRequest(request, system, context, true);
        if (isInvalidAnswerContinuation(context)) {
          await receiver.sayingStart();
          await receiver.sayingChunk(invalidAnswerRecovery);
          await receiver.sayingFinish();
          return { usage: { kind: 'unavailable' } };
        }
        return mock.genToReceiver(
          provider,
          agent,
          system,
          tools,
          request,
          context,
          receiver,
          genseq,
          signal,
        );
      },
      async genMoreMessages(provider, agent, system, tools, request, context, genseq, signal) {
        await captureRequest(request, system, context, false);
        if (isInvalidAnswerContinuation(context))
          return {
            messages: [
              { type: 'saying_msg', role: 'assistant', content: invalidAnswerRecovery, genseq },
            ],
            usage: { kind: 'unavailable' },
          };
        return mock.genMoreMessages(
          provider,
          agent,
          system,
          tools,
          request,
          context,
          genseq,
          signal,
        );
      },
    };
    registerLlmGenerator(observed);
    try {
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        for (const streaming of [true, false]) {
          await writeStandardMinds(process.cwd(), {
            extraMembers: ['worker', 'helper'],
            memberTools: ['env_get'],
            providerApiType: apiType,
            streaming,
          });
          for (const run of [
            runMainDialogScenario,
            runSideDialogScenario,
            runRepeatedRootInterjectionScenario,
            runProceedingReplyObligationScenario,
            runProceedingReplyObligationStructuredAnsweringScenario,
            runStructuredAnsweringWithVisibleSayingDoesNotDuplicateA2HScenario,
            runInvalidAnswerHumanStillAllowsVisibleInterjectionAnswerScenario,
            runToolOnlyInterjectionDoesNotAutoContinueLongLineScenario,
          ]) {
            await run();
            assertProviderSucceeded();
          }
        }
        await runQ4HAnswerNeverCountsAsInterjectionScenario();
      }
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });

  await evidence.write();
  console.log('local human response, native answering and pending requester obligations: passed');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver user-interject-while-active-callee-suppresses-reply-guidance: FAIL\n' + message,
  );
  process.exit(1);
});
