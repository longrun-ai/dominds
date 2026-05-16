import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  buildReplyObligationSuppressionGuide,
  resolvePromptReplyGuidance,
} from '../../main/llm/kernel-driver/reply-guidance';
import { DialogPersistence } from '../../main/persistence';
import { isUserInterjectionPauseStopReason } from '../../main/runtime/interjection-pause-stop';
import {
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  NO_ACTIVE_REPLY_PREFIX_EN,
  REPLY_TOOL_REMINDER_PREFIX_EN,
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
  assert.equal(interjectRecord?.content, interjectPrompt);
  assert.equal(
    interjectRecord?.tellaskReplyDirective,
    undefined,
    'root interjection should not inherit the pending reply directive',
  );
  assertNoInjectedReplyGuidance(humanTextRecords.map((event) => event.content));

  const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
  assert.equal(pending.length, 1, 'root should retain the original active callee dispatch');
}

async function runSideDialogScenario(): Promise<void> {
  const interjectPrompt = 'Pause the nested side dialog and handle this local note first.';
  const interjectResponse = 'Handled the local note without replying to the tellasker.';
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

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

  assert.equal(lastAssistantSayingContent(sideDialog.msgs), interjectResponse);

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
  assert.equal(interjectRecord?.content, interjectPrompt);
  assert.equal(
    interjectRecord?.tellaskReplyDirective,
    undefined,
    'sideDialog interjection should not inherit the tellasker reply directive',
  );
  assertNoInjectedReplyGuidance(humanTextRecords.map((event) => event.content));

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
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

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
    0,
    'root interjections while blocked on side dialogs should not append reply suppression runtime-guide records',
  );

  const deferred = await DialogPersistence.getDeferredReplyReassertion(root.id, root.status);
  assert.equal(
    deferred,
    undefined,
    'root interjections while blocked on side dialogs should not arm deferred reply reassertion',
  );
}

async function runProceedingReplyObligationScenario(): Promise<void> {
  const interjectPrompt = 'Answer this local question first before replying to the tellasker.';
  const interjectResponse = 'Handled the local question first.';

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  await root.persistUserMessage(
    'There is still a tellasker reply obligation to deliver.',
    'root-runtime-reply-directive-proceeding',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-proceeding',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the tellasker reply once ready.',
    },
  );
  await DialogPersistence.setActiveTellaskReplyObligation(
    root.id,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-proceeding',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the tellasker reply once ready.',
    },
    root.status,
  );

  await driveDialogStream(
    root,
    makeUserPrompt(interjectPrompt, 'root-user-interject-while-proceeding-reply-obligation', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);

  assert.equal(lastAssistantSayingContent(root.msgs), interjectResponse);

  const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
  assert.equal(
    latest?.displayState?.kind,
    'stopped',
    'a proceeding dialog with an active reply obligation should still park after a user interjection',
  );
  assert.ok(
    latest?.displayState?.kind === 'stopped' &&
      isUserInterjectionPauseStopReason(latest.displayState.reason),
    'proceeding user interjection should use the dedicated paused-original-task stop reason',
  );

  const deferred = await DialogPersistence.getDeferredReplyReassertion(root.id, root.status);
  assert.deepEqual(
    deferred,
    {
      reason: 'user_interjection_with_parked_original_task',
      directive: {
        expectedReplyCallName: 'replyTellaskBack',
        targetCallId: 'reply-back-target-proceeding',
        targetDialogId: root.id.selfId,
        tellaskContent: 'Please deliver the tellasker reply once ready.',
      },
    },
    'a proceeding interjection should arm deferred reply reassertion instead of queueing replyTellask reminder',
  );

  const events = await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status);
  const humanTextRecords = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'human_text_record' }> =>
      event.type === 'human_text_record',
  );
  assertNoInjectedReplyGuidance(humanTextRecords.map((event) => event.content));
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
  assert.equal(
    guidance.deferredReplyReassertionDirective,
    undefined,
    'askHuman answers should not arm deferred reply reassertion',
  );
  assert.deepEqual(guidance.activeReplyDirective, {
    expectedReplyCallName: 'replyTellaskBack',
    targetCallId: 'reply-back-target-q4h',
    targetDialogId: root.id.selfId,
    tellaskContent: 'Deliver the tellasker reply once the askHuman answer is in.',
  });
  assert.equal(
    guidance.promptContent?.startsWith(ACTIVE_REPLY_TOOL_PREFIX_EN),
    true,
    'askHuman answers should continue the active reply-obligation path instead of being downgraded into interjection suppression',
  );
  assert.ok(
    guidance.promptContent?.includes('Here is the formal askHuman answer.'),
    'the formal askHuman answer content itself should still be preserved inside the continued prompt',
  );
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
    setWorkLanguage('en');
    await writeStandardMinds(process.cwd(), {
      includePangu: true,
      extraMembers: ['nuwa'],
    });
    await runMainDialogScenario();
    await runSideDialogScenario();
    await runRepeatedRootInterjectionScenario();
    await runProceedingReplyObligationScenario();
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
