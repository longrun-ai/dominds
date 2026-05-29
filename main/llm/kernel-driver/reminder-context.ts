import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type {
  ReminderContextBusiness,
  ReminderContextFollowingMessage,
  ReminderContextFooterState,
  ReminderContextHealth,
} from '../../runtime/driver-messages';
import type { ChatMessage } from '../client';
import { getContextHealthRemediationLevel } from './context-health';
import type { KernelDriverPrompt } from './types';

export function resolveReminderContextFollowingMessage(args: {
  prompt: KernelDriverPrompt | undefined;
  currentTurnDialogMsgsForContext: readonly ChatMessage[];
}): ReminderContextFollowingMessage {
  if (args.prompt === undefined || args.currentTurnDialogMsgsForContext.length === 0) {
    return { kind: 'none' };
  }
  if (args.prompt.origin !== 'user') {
    return { kind: 'runtime_notice' };
  }
  return typeof args.prompt.q4hAnswerCallId === 'string' &&
    args.prompt.q4hAnswerCallId.trim() !== ''
    ? { kind: 'human_answer' }
    : { kind: 'user_message' };
}

export function resolveReminderContextHealth(
  snapshot: ContextHealthSnapshot | undefined,
): ReminderContextHealth {
  const remediationLevel = getContextHealthRemediationLevel(snapshot);
  return remediationLevel === undefined ? { kind: 'normal' } : { kind: remediationLevel };
}

export function resolveReminderContextBusinessState(args: {
  followingMessage: ReminderContextFollowingMessage;
  pendingUserInterjectionReply: boolean;
  hasCompletedHandoffWithoutPendingReply: boolean;
  hasDeferredReplyReassertion: boolean;
  hasActiveReplyObligation: boolean;
}): ReminderContextBusiness {
  if (args.followingMessage.kind === 'human_answer') {
    // askHuman answers resume a waiting task. They are not fresh user follow-ups and should not
    // inherit interjection or completed-handoff wording from adjacent durable state.
    return { kind: 'none' };
  }
  if (
    args.followingMessage.kind === 'user_message' &&
    args.hasCompletedHandoffWithoutPendingReply
  ) {
    // Completed handoff + new user message means the runtime already knows this is a follow-up.
    // The model should hear that directly instead of guessing from older task context or
    // reminder-maintenance references.
    return { kind: 'user_followup_after_completed_handoff' };
  }
  if (args.pendingUserInterjectionReply) {
    // User-visible reply gaps take priority over handoff continuation state. The completed
    // handoff case is most specific: runtime already knows the old delegated task is done.
    // The footer should say there is no old handoff to advance and the model should handle the
    // current user message normally. Do not narrow this to "only answer" or "do not organize
    // reminders": a user may explicitly ask for reminder cleanup/correction as the current
    // conversation topic.
    //
    // This branch may run on a later tool-followup turn where no user message immediately
    // follows the reminder block anymore. That is still the same pending user follow-up; do not
    // demote it to generic auto-continuation wording just because the prompt itself is absent
    // on this retry/continuation round.
    if (args.hasCompletedHandoffWithoutPendingReply) {
      return { kind: 'user_followup_after_completed_handoff' };
    }
    if (args.hasDeferredReplyReassertion) {
      return { kind: 'pending_user_interjection_with_parked_reply' };
    }
    if (args.hasActiveReplyObligation) {
      return { kind: 'pending_user_interjection_with_active_reply' };
    }
    return { kind: 'pending_user_interjection' };
  }
  if (args.hasActiveReplyObligation) {
    return { kind: 'active_reply_obligation' };
  }
  return { kind: 'none' };
}

export function resolveReminderContextFooterStateFromSignals(args: {
  prompt: KernelDriverPrompt | undefined;
  currentTurnDialogMsgsForContext: readonly ChatMessage[];
  contextHealth: ContextHealthSnapshot | undefined;
  pendingUserInterjectionReply: boolean;
  hasCompletedHandoffWithoutPendingReply: boolean;
  hasDeferredReplyReassertion: boolean;
  hasActiveReplyObligation: boolean;
}): ReminderContextFooterState {
  const followingMessage = resolveReminderContextFollowingMessage({
    prompt: args.prompt,
    currentTurnDialogMsgsForContext: args.currentTurnDialogMsgsForContext,
  });
  return {
    followingMessage,
    contextHealth: resolveReminderContextHealth(args.contextHealth),
    business: resolveReminderContextBusinessState({
      followingMessage,
      pendingUserInterjectionReply: args.pendingUserInterjectionReply,
      hasCompletedHandoffWithoutPendingReply: args.hasCompletedHandoffWithoutPendingReply,
      hasDeferredReplyReassertion: args.hasDeferredReplyReassertion,
      hasActiveReplyObligation: args.hasActiveReplyObligation,
    }),
  };
}
