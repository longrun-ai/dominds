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

const ACTIVE_REPLY_PREFIX = '[Dominds active reply tool]';
const NO_ACTIVE_REPLY_PREFIX = '[Dominds no active inter-dialog reply]';
const REPLY_REMINDER_PREFIX = '[Dominds replyTellask required]';

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
      !content.startsWith(ACTIVE_REPLY_PREFIX) &&
        !content.startsWith(NO_ACTIVE_REPLY_PREFIX) &&
        !content.startsWith(REPLY_REMINDER_PREFIX),
      `unexpected injected reply guidance: ${content}`,
    );
  }
}

async function runMainDialogScenario(): Promise<void> {
  const interjectPrompt = 'Please handle this local interruption only.';
  const interjectResponse = 'Handled the local interruption without touching the sideline reply.';
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
      contextContains: [suppressionGuide],
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const pendingSideDialog = await root.createSideDialog(
    'pangu',
    ['@pangu'],
    'Background sideline work is still pending.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId: 'root-pending-sideDialog-call',
      collectiveTargets: ['pangu'],
    },
  );
  await DialogPersistence.appendPendingSideDialog(root.id, {
    sideDialogId: pendingSideDialog.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    callName: 'tellaskSessionless',
    mentionList: ['@pangu'],
    tellaskContent: 'Background sideline work is still pending.',
    targetAgentId: 'pangu',
    callId: 'root-pending-sideDialog-call',
    callingCourse: 1,
    callingGenseq: 1,
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back is still pending.',
    'root-runtime-reply-directive',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target',
      targetDialogId: pendingSideDialog.id.selfId,
      tellaskContent: 'Please confirm the sideline result.',
    },
  );

  await driveDialogStream(
    root,
    makeUserPrompt(interjectPrompt, 'root-user-interject-while-pending-sideDialog', {
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
    (event) => event.msgId === 'root-user-interject-while-pending-sideDialog',
  );
  assert.ok(interjectRecord, 'expected persisted user interjection record for root dialog');
  assert.equal(interjectRecord?.content, interjectPrompt);
  assert.equal(
    interjectRecord?.tellaskReplyDirective,
    undefined,
    'root interjection should not inherit the pending reply directive',
  );
  assertNoInjectedReplyGuidance(humanTextRecords.map((event) => event.content));

  const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
  assert.equal(pending.length, 1, 'root should keep waiting on the original pending sideDialog');
}

async function runSideDialogScenario(): Promise<void> {
  const interjectPrompt = 'Pause the nested sideline and handle this local note first.';
  const interjectResponse = 'Handled the local note without replying upstream.';
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
      contextContains: [suppressionGuide],
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const sideDialog = await root.createSideDialog('pangu', ['@pangu'], 'Finish the assigned task.', {
    callName: 'tellask',
    originMemberId: 'tester',
    callerDialogId: root.id.selfId,
    callId: 'root-to-pangu-call',
    sessionSlug: 'parent-session',
    collectiveTargets: ['pangu'],
  });
  sideDialog.disableDiligencePush = true;

  const nestedSideDialog = await sideDialog.createSideDialog(
    'nuwa',
    ['@nuwa'],
    'Investigate a nested sideline.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'pangu',
      callerDialogId: sideDialog.id.selfId,
      callId: 'pangu-to-nuwa-call',
      collectiveTargets: ['nuwa'],
    },
  );
  await DialogPersistence.appendPendingSideDialog(sideDialog.id, {
    sideDialogId: nestedSideDialog.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    callName: 'tellaskSessionless',
    mentionList: ['@nuwa'],
    tellaskContent: 'Investigate a nested sideline.',
    targetAgentId: 'nuwa',
    callId: 'pangu-to-nuwa-call',
    callingCourse: 1,
    callingGenseq: 1,
    callType: 'C',
  });

  await sideDialog.persistUserMessage(
    'Initial sideline assignment from upstream.',
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
    makeUserPrompt(interjectPrompt, 'sideDialog-user-interject-while-pending-sideDialog', {
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
    (event) => event.msgId === 'sideDialog-user-interject-while-pending-sideDialog',
  );
  assert.ok(interjectRecord, 'expected persisted user interjection record for sideDialog');
  assert.equal(interjectRecord?.content, interjectPrompt);
  assert.equal(
    interjectRecord?.tellaskReplyDirective,
    undefined,
    'sideDialog interjection should not inherit the upstream reply directive',
  );
  assertNoInjectedReplyGuidance(humanTextRecords.map((event) => event.content));

  const pending = await DialogPersistence.loadPendingSideDialogs(sideDialog.id, sideDialog.status);
  assert.equal(
    pending.length,
    1,
    'sideDialog should keep waiting on its nested pending sideDialog',
  );
}

async function runRepeatedRootInterjectionScenario(): Promise<void> {
  const firstPrompt = 'First interruption while the sideline is still pending.';
  const secondPrompt = 'Second interruption while the same sideline is still pending.';
  const firstResponse = 'Handled the first interruption.';
  const secondResponse =
    'Handled the second interruption while keeping the previously recorded long-line suppression notice in context.';
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

  await writeMockDb(process.cwd(), [
    {
      message: firstPrompt,
      role: 'user',
      response: firstResponse,
      contextContains: [suppressionGuide],
    },
    {
      message: secondPrompt,
      role: 'user',
      response: secondResponse,
      contextContains: [suppressionGuide],
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  const pendingSideDialog = await root.createSideDialog(
    'pangu',
    ['@pangu'],
    'Background sideline work is still pending.',
    {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      callerDialogId: root.id.selfId,
      callId: 'root-pending-sideDialog-call-repeated',
      collectiveTargets: ['pangu'],
    },
  );
  await DialogPersistence.appendPendingSideDialog(root.id, {
    sideDialogId: pendingSideDialog.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    callName: 'tellaskSessionless',
    mentionList: ['@pangu'],
    tellaskContent: 'Background sideline work is still pending.',
    targetAgentId: 'pangu',
    callId: 'root-pending-sideDialog-call-repeated',
    callingCourse: 1,
    callingGenseq: 1,
    callType: 'C',
  });

  await root.persistUserMessage(
    'Runtime ask-back is still pending.',
    'root-runtime-reply-directive-repeated',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-repeated',
      targetDialogId: pendingSideDialog.id.selfId,
      tellaskContent: 'Please confirm the sideline result.',
    },
  );

  await driveDialogStream(
    root,
    makeUserPrompt(firstPrompt, 'root-user-interject-pending-sideDialog-first', {
      userLanguageCode: 'en',
    }),
    true,
    makeDriveOptions({ suppressDiligencePush: true }),
  );
  await waitForAllDialogsUnlocked(root, 2_000);
  assert.equal(lastAssistantSayingContent(root.msgs), firstResponse);

  await driveDialogStream(
    root,
    makeUserPrompt(secondPrompt, 'root-user-interject-pending-sideDialog-second', {
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
    1,
    'repeated interjections should not append duplicate suppression runtime-guide records',
  );
  assert.equal(runtimeGuideRecords[0]?.content, suppressionGuide);

  const deferred = await DialogPersistence.getDeferredReplyReassertion(root.id, root.status);
  assert.ok(deferred, 'repeated interjections should keep the deferred long-line state armed');
}

async function runProceedingReplyObligationScenario(): Promise<void> {
  const interjectPrompt = 'Answer this local question first before replying upstream.';
  const interjectResponse = 'Handled the local question first.';
  const suppressionGuide = buildReplyObligationSuppressionGuide({ language: 'en' });

  await writeMockDb(process.cwd(), [
    {
      message: interjectPrompt,
      role: 'user',
      response: interjectResponse,
      contextContains: [suppressionGuide],
    },
  ]);

  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;

  await root.persistUserMessage(
    'There is still an upstream reply obligation to deliver.',
    'root-runtime-reply-directive-proceeding',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-proceeding',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Please deliver the upstream reply once ready.',
    },
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
        tellaskContent: 'Please deliver the upstream reply once ready.',
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
    'An upstream reply is still pending after this askHuman round.',
    'root-runtime-reply-directive-q4h',
    'markdown',
    'runtime',
    'en',
    undefined,
    {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'reply-back-target-q4h',
      targetDialogId: root.id.selfId,
      tellaskContent: 'Deliver the upstream reply once the askHuman answer is in.',
    },
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
    tellaskContent: 'Deliver the upstream reply once the askHuman answer is in.',
  });
  assert.equal(
    guidance.promptContent?.startsWith(ACTIVE_REPLY_PREFIX),
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

  console.log(
    'kernel-driver user-interject-while-pending-sideDialog-suppresses-reply-guidance: PASS',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    'kernel-driver user-interject-while-pending-sideDialog-suppresses-reply-guidance: FAIL\n' +
      message,
  );
  process.exit(1);
});
