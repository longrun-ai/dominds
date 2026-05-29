import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { resolveReminderContextFooterStateFromSignals } from '../../main/llm/kernel-driver/reminder-context';
import type { KernelDriverUserPrompt } from '../../main/llm/kernel-driver/types';

const userPrompt: KernelDriverUserPrompt = {
  origin: 'user',
  msgId: 'u-followup',
  content: '继续追问',
  grammar: 'markdown',
};

const humanAnswerPrompt: KernelDriverUserPrompt = {
  origin: 'user',
  msgId: 'u-human-answer',
  content: '这是人类回答',
  grammar: 'markdown',
  q4hAnswerCallId: 'ask-human-call-1',
};

const currentTurnUserMsgs: ChatMessage[] = [
  {
    type: 'prompting_msg',
    role: 'user',
    genseq: 34,
    msgId: userPrompt.msgId,
    grammar: 'markdown',
    content: userPrompt.content,
  },
];

type FooterSignalArgs = Parameters<typeof resolveReminderContextFooterStateFromSignals>[0];
type FooterSignalArgsWithoutScope = Omit<FooterSignalArgs, 'dialogScope'>;

function resolveSideReminderContextFooterStateFromSignals(args: FooterSignalArgsWithoutScope) {
  return resolveReminderContextFooterStateFromSignals({
    dialogScope: { kind: 'side_dialog' },
    ...args,
  });
}

function main(): void {
  const completedHandoffFollowup = resolveSideReminderContextFooterStateFromSignals({
    prompt: userPrompt,
    currentTurnDialogMsgsForContext: currentTurnUserMsgs,
    contextHealth: undefined,
    pendingUserInterjectionReply: false,
    hasCompletedHandoffWithoutPendingReply: true,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(completedHandoffFollowup.followingMessage, { kind: 'user_message' });
  assert.deepEqual(completedHandoffFollowup.dialogScope, { kind: 'side_dialog' });
  assert.deepEqual(completedHandoffFollowup.business, {
    kind: 'user_followup_after_completed_handoff',
  });

  const missingCurrentTurnMessage = resolveSideReminderContextFooterStateFromSignals({
    prompt: userPrompt,
    currentTurnDialogMsgsForContext: [],
    contextHealth: undefined,
    pendingUserInterjectionReply: false,
    hasCompletedHandoffWithoutPendingReply: true,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(missingCurrentTurnMessage.followingMessage, { kind: 'none' });
  assert.deepEqual(missingCurrentTurnMessage.business, { kind: 'none' });

  const completedHandoffFollowupOnToolContinuation =
    resolveSideReminderContextFooterStateFromSignals({
      prompt: undefined,
      currentTurnDialogMsgsForContext: [],
      contextHealth: undefined,
      pendingUserInterjectionReply: true,
      hasCompletedHandoffWithoutPendingReply: true,
      hasDeferredReplyReassertion: false,
      hasActiveReplyObligation: false,
    });
  assert.deepEqual(completedHandoffFollowupOnToolContinuation.followingMessage, { kind: 'none' });
  assert.deepEqual(completedHandoffFollowupOnToolContinuation.business, {
    kind: 'user_followup_after_completed_handoff',
  });

  const humanAnswerContinuation = resolveSideReminderContextFooterStateFromSignals({
    prompt: humanAnswerPrompt,
    currentTurnDialogMsgsForContext: [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 35,
        msgId: humanAnswerPrompt.msgId,
        grammar: 'markdown',
        content: humanAnswerPrompt.content,
      },
    ],
    contextHealth: undefined,
    pendingUserInterjectionReply: true,
    hasCompletedHandoffWithoutPendingReply: true,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(humanAnswerContinuation.followingMessage, { kind: 'human_answer' });
  assert.deepEqual(humanAnswerContinuation.business, { kind: 'none' });

  const activeReplyWithPendingUserInterjection = resolveSideReminderContextFooterStateFromSignals({
    prompt: userPrompt,
    currentTurnDialogMsgsForContext: currentTurnUserMsgs,
    contextHealth: undefined,
    pendingUserInterjectionReply: true,
    hasCompletedHandoffWithoutPendingReply: false,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: true,
  });
  assert.deepEqual(activeReplyWithPendingUserInterjection.business, {
    kind: 'pending_user_interjection_with_active_reply',
  });

  const parkedReplyWinsOverGenericInterjection = resolveSideReminderContextFooterStateFromSignals({
    prompt: undefined,
    currentTurnDialogMsgsForContext: [],
    contextHealth: undefined,
    pendingUserInterjectionReply: true,
    hasCompletedHandoffWithoutPendingReply: false,
    hasDeferredReplyReassertion: true,
    hasActiveReplyObligation: true,
  });
  assert.deepEqual(parkedReplyWinsOverGenericInterjection.followingMessage, { kind: 'none' });
  assert.deepEqual(parkedReplyWinsOverGenericInterjection.business, {
    kind: 'pending_user_interjection_with_parked_reply',
  });

  const criticalHealth = resolveSideReminderContextFooterStateFromSignals({
    prompt: undefined,
    currentTurnDialogMsgsForContext: [],
    contextHealth: { kind: 'available', level: 'critical', usage: { promptTokens: 1 } },
    pendingUserInterjectionReply: false,
    hasCompletedHandoffWithoutPendingReply: false,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(criticalHealth.contextHealth, { kind: 'critical' });
  assert.deepEqual(criticalHealth.business, { kind: 'none' });

  const mainDialogScope = resolveReminderContextFooterStateFromSignals({
    dialogScope: { kind: 'main_dialog' },
    prompt: undefined,
    currentTurnDialogMsgsForContext: [],
    contextHealth: undefined,
    pendingUserInterjectionReply: false,
    hasCompletedHandoffWithoutPendingReply: false,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(mainDialogScope.dialogScope, { kind: 'main_dialog' });

  console.log('kernel-driver reminder-context-footer-state: PASS');
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver reminder-context-footer-state: FAIL\n${message}`);
  process.exit(1);
}
