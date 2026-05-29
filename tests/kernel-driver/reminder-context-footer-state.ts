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

function main(): void {
  const completedHandoffFollowup = resolveReminderContextFooterStateFromSignals({
    prompt: userPrompt,
    currentTurnDialogMsgsForContext: currentTurnUserMsgs,
    contextHealth: undefined,
    pendingUserInterjectionReply: false,
    hasCompletedHandoffWithoutPendingReply: true,
    hasDeferredReplyReassertion: false,
    hasActiveReplyObligation: false,
  });
  assert.deepEqual(completedHandoffFollowup.followingMessage, { kind: 'user_message' });
  assert.deepEqual(completedHandoffFollowup.business, {
    kind: 'user_followup_after_completed_handoff',
  });

  const missingCurrentTurnMessage = resolveReminderContextFooterStateFromSignals({
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

  const completedHandoffFollowupOnToolContinuation = resolveReminderContextFooterStateFromSignals({
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

  const humanAnswerContinuation = resolveReminderContextFooterStateFromSignals({
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

  const activeReplyWithPendingUserInterjection = resolveReminderContextFooterStateFromSignals({
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

  const parkedReplyWinsOverGenericInterjection = resolveReminderContextFooterStateFromSignals({
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

  const criticalHealth = resolveReminderContextFooterStateFromSignals({
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

  console.log('kernel-driver reminder-context-footer-state: PASS');
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver reminder-context-footer-state: FAIL\n${message}`);
  process.exit(1);
}
