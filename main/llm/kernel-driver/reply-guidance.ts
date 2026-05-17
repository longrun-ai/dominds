import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { Dialog, DialogID, MainDialog, SideDialog } from '../../dialog';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { DialogPersistence } from '../../persistence';
import { isUserInterjectionPauseStopReason } from '../../runtime/interjection-pause-stop';
import {
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  ACTIVE_REPLY_TOOL_PREFIX_ZH,
  NO_ACTIVE_REPLY_PREFIX_EN,
  NO_ACTIVE_REPLY_PREFIX_ZH,
  REPLY_REASSERTION_PREFIX_EN,
  REPLY_REASSERTION_PREFIX_ZH,
  REPLY_TOOL_REMINDER_PREFIX_EN,
  REPLY_TOOL_REMINDER_PREFIX_ZH,
  buildActiveReplyToolNote,
  buildReplyObligationReassertionText,
  buildReplyObligationSuppressionGuideText,
} from '../../runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../runtime/work-language';
import { loadActiveTellaskReplyDirective } from './tellask-special';
import type { KernelDriverPrompt } from './types';

export async function resolveReplyTargetAgentId(args: {
  dlg: Dialog;
  directive: TellaskReplyDirective;
}): Promise<string | undefined> {
  const mainDialog =
    args.dlg instanceof MainDialog
      ? args.dlg
      : args.dlg instanceof SideDialog
        ? args.dlg.mainDialog
        : undefined;
  if (!mainDialog) {
    return undefined;
  }
  const targetDialogId = new DialogID(args.directive.targetDialogId, mainDialog.id.rootId);
  const targetDialog =
    mainDialog.lookupDialog(targetDialogId.selfId) ??
    (await ensureDialogLoaded(mainDialog, targetDialogId, mainDialog.status));
  return targetDialog?.agentId;
}

function buildPromptContentWithExactReplyToolName(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt;
  activeReplyDirective: KernelDriverPrompt['tellaskReplyDirective'];
  language: 'zh' | 'en';
}): string {
  const isFbrSideDialog =
    args.dlg instanceof SideDialog &&
    args.dlg.assignmentFromAsker.callName === 'freshBootsReasoning';
  const noActivePrefix =
    args.language === 'zh' ? NO_ACTIVE_REPLY_PREFIX_ZH : NO_ACTIVE_REPLY_PREFIX_EN;
  const activePrefix =
    args.language === 'zh' ? ACTIVE_REPLY_TOOL_PREFIX_ZH : ACTIVE_REPLY_TOOL_PREFIX_EN;
  const reminderPrefixes = [
    REPLY_TOOL_REMINDER_PREFIX_EN,
    REPLY_TOOL_REMINDER_PREFIX_ZH,
    REPLY_REASSERTION_PREFIX_EN,
    REPLY_REASSERTION_PREFIX_ZH,
  ];
  const directive = args.activeReplyDirective;
  if (!directive) {
    if (isFbrSideDialog) {
      return args.prompt.content;
    }
    if (!(args.dlg instanceof SideDialog)) {
      return args.prompt.content;
    }
    if (args.prompt.content.startsWith(noActivePrefix)) {
      return args.prompt.content;
    }
    const note =
      args.language === 'zh'
        ? [
            noActivePrefix,
            '当前没有待完成的跨对话回复义务。',
            '这轮不要调用任何 `reply*`；直接按当前本地对话继续即可。',
          ].join('\n')
        : [
            noActivePrefix,
            'There is no active inter-dialog reply obligation right now.',
            'Do not call any `reply*` tool in this turn; just continue the current local conversation.',
          ].join('\n');
    return `${note}\n\n${args.prompt.content}`;
  }
  if (args.prompt.content.startsWith(activePrefix)) {
    return args.prompt.content;
  }
  if (reminderPrefixes.some((prefix) => args.prompt.content.startsWith(prefix))) {
    return args.prompt.content;
  }
  const note = buildActiveReplyToolNote({
    language: args.language,
    toolName: directive.expectedReplyCallName,
  });
  return `${note}\n\n${args.prompt.content}`;
}

function hasSameReplyDirective(
  left: TellaskReplyDirective | undefined,
  right: TellaskReplyDirective | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.expectedReplyCallName !== right.expectedReplyCallName) {
    return false;
  }
  if (
    left.targetDialogId !== right.targetDialogId ||
    left.targetCallId !== right.targetCallId ||
    left.tellaskContent !== right.tellaskContent
  ) {
    return false;
  }
  return true;
}

function buildCurrentSideDialogAssignmentDirective(
  dlg: SideDialog,
): NonNullable<KernelDriverPrompt['tellaskReplyDirective']> {
  switch (dlg.assignmentFromAsker.callName) {
    case 'tellask':
      return {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.assignmentFromAsker.askerDialogId,
        targetCallId: dlg.assignmentFromAsker.callId,
        tellaskContent: dlg.assignmentFromAsker.tellaskContent,
      };
    case 'tellaskSessionless':
    case 'freshBootsReasoning':
      return {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: dlg.assignmentFromAsker.askerDialogId,
        targetCallId: dlg.assignmentFromAsker.callId,
        tellaskContent: dlg.assignmentFromAsker.tellaskContent,
      };
    default: {
      const _exhaustive: never = dlg.assignmentFromAsker.callName;
      throw new Error(`Unsupported sideDialog assignment callName: ${_exhaustive}`);
    }
  }
}

async function resolveFreshCurrentSideDialogAssignmentDirective(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt | undefined;
}): Promise<KernelDriverPrompt['tellaskReplyDirective']> {
  if (!(args.dlg instanceof SideDialog) || args.prompt?.origin !== 'runtime') {
    return undefined;
  }
  const promptDirective = args.prompt.tellaskReplyDirective;
  if (!promptDirective) {
    return undefined;
  }
  const currentAssignmentDirective = buildCurrentSideDialogAssignmentDirective(args.dlg);
  if (!hasSameReplyDirective(promptDirective, currentAssignmentDirective)) {
    return undefined;
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  if (!latest) {
    return undefined;
  }
  if (latest.pendingRuntimePrompt?.msgId !== args.prompt.msgId) {
    return undefined;
  }
  if (latest.sideDialogFinalResponse?.callId === currentAssignmentDirective.targetCallId.trim()) {
    return undefined;
  }
  const targetCallId = currentAssignmentDirective.targetCallId.trim();
  if (latest.tellaskResults.results.some((entry) => entry.callId.trim() === targetCallId)) {
    return undefined;
  }
  return currentAssignmentDirective;
}

async function resolveFreshPendingAskBackReplyDirective(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt | undefined;
}): Promise<KernelDriverPrompt['tellaskReplyDirective']> {
  const prompt = args.prompt;
  if (
    prompt?.origin !== 'runtime' ||
    prompt.tellaskReplyDirective?.expectedReplyCallName !== 'replyTellaskBack'
  ) {
    return undefined;
  }
  const promptLatest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  if (promptLatest?.pendingRuntimePrompt?.msgId !== prompt.msgId) {
    return undefined;
  }
  const mainDialog =
    args.dlg instanceof MainDialog
      ? args.dlg
      : args.dlg instanceof SideDialog
        ? args.dlg.mainDialog
        : undefined;
  if (!mainDialog) {
    return undefined;
  }
  const askBackAskerDialogId = new DialogID(
    prompt.tellaskReplyDirective.targetDialogId,
    mainDialog.id.rootId,
  );
  const latest = await DialogPersistence.loadDialogLatest(askBackAskerDialogId, mainDialog.status);
  if (!latest) {
    return undefined;
  }
  const targetCallId = prompt.tellaskReplyDirective.targetCallId.trim();
  if (latest.tellaskResults.results.some((entry) => entry.callId.trim() === targetCallId)) {
    return undefined;
  }
  const activeObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    args.dlg.id,
    args.dlg.status,
  );
  return activeObligation !== undefined &&
    activeObligation.expectedReplyCallName === 'replyTellaskBack' &&
    activeObligation.targetDialogId === prompt.tellaskReplyDirective.targetDialogId &&
    activeObligation.targetCallId === targetCallId &&
    activeObligation.tellaskContent === prompt.tellaskReplyDirective.tellaskContent
    ? prompt.tellaskReplyDirective
    : undefined;
}

function resolveFreshReplyDirective(args: {
  promptDirective: KernelDriverPrompt['tellaskReplyDirective'];
  persistedDirective: TellaskReplyDirective | undefined;
}): KernelDriverPrompt['tellaskReplyDirective'] {
  const promptDirective = args.promptDirective;
  const persistedDirective = args.persistedDirective;
  if (!promptDirective) {
    return persistedDirective;
  }
  if (!persistedDirective) {
    return undefined;
  }
  return hasSameReplyDirective(promptDirective, persistedDirective)
    ? promptDirective
    : persistedDirective;
}

function resolvePromptPersistedReplyDirective(args: {
  promptDirective: KernelDriverPrompt['tellaskReplyDirective'];
  persistedDirective: TellaskReplyDirective | undefined;
}): KernelDriverPrompt['tellaskReplyDirective'] {
  const promptDirective = args.promptDirective;
  const persistedDirective = args.persistedDirective;
  if (!promptDirective || !persistedDirective) {
    return undefined;
  }
  return hasSameReplyDirective(promptDirective, persistedDirective) ? promptDirective : undefined;
}

async function shouldSuppressInterDialogReplyGuidanceForUserInterjection(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt | undefined;
}): Promise<boolean> {
  // WARNING:
  // This suppression decision is not a cosmetic prompt tweak. It is one leg of the full
  // interjection-pause state machine:
  // 1. user interjection suppresses the live reply obligation here;
  // 2. `flow.ts` answers locally and parks the original task in a resumable stopped state;
  // 3. manual Continue later decides from fresh persistence facts whether the dialog should stay
  //    blocked or resume real driving.
  //
  // Do not "simplify" this into a pure display-state check or a pure active-callee check.
  // Proceeding dialogs with a still-active reply obligation are part of the same rule: a fresh
  // user interjection should still suppress the live reply obligation and answer locally first.
  // The business anchor is the deferred reply reassertion, while the paused execution marker keeps
  // repeated interjection turns behaving as local side conversation until explicit Continue.
  const prompt = args.prompt;
  if (!prompt) {
    return false;
  }
  if (prompt.origin !== 'user') {
    return false;
  }
  if (prompt.tellaskReplyDirective !== undefined) {
    return false;
  }
  const latest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  if (latest?.deferredReplyReassertion?.reason === 'user_interjection_with_parked_original_task') {
    return true;
  }
  if (
    latest?.executionMarker?.kind === 'interrupted' &&
    isUserInterjectionPauseStopReason(latest.executionMarker.reason)
  ) {
    return true;
  }
  const activeReplyDirective = await loadActiveTellaskReplyDirective(args.dlg);
  if (activeReplyDirective) {
    return true;
  }
  // Use strict persistence reads here. This branch changes business behavior, so a read failure
  // must loud-fail the round instead of being silently treated as "pending callees exist".
  const activeCallees = await DialogPersistence.loadActiveCallees(args.dlg.id, args.dlg.status);
  return activeCallees.batches.some((batch) =>
    batch.callees.some((callee) => callee.status === 'pending'),
  );
}

export async function resolvePromptReplyGuidance(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt | undefined;
  language?: 'zh' | 'en';
}): Promise<{
  activeReplyDirective: KernelDriverPrompt['tellaskReplyDirective'];
  deferredReplyReassertionDirective: KernelDriverPrompt['tellaskReplyDirective'];
  isQ4HAnswerPrompt: boolean;
  promptContent: string | undefined;
  persistedTellaskReplyDirective: KernelDriverPrompt['tellaskReplyDirective'];
  suppressInterDialogReplyGuidance: boolean;
  transientGuideContent: string | undefined;
}> {
  const prompt = args.prompt;
  const isQ4HAnswerPrompt =
    typeof prompt?.q4hAnswerCallId === 'string' && prompt.q4hAnswerCallId.trim() !== '';
  const latest = await DialogPersistence.loadDialogLatest(args.dlg.id, args.dlg.status);
  const persistedCurrentSideDialogAssignmentDirective =
    await resolveFreshCurrentSideDialogAssignmentDirective({
      dlg: args.dlg,
      prompt,
    });
  const persistedPendingAskBackReplyDirective = await resolveFreshPendingAskBackReplyDirective({
    dlg: args.dlg,
    prompt,
  });
  const persistedPendingRuntimePromptDirective =
    prompt !== undefined &&
    latest?.pendingRuntimePrompt?.msgId === prompt.msgId &&
    latest.pendingRuntimePrompt.origin === 'runtime'
      ? latest.pendingRuntimePrompt.tellaskReplyDirective
      : undefined;
  const persistedActiveReplyObligation = await loadActiveTellaskReplyDirective(args.dlg);
  const persistedActiveReplyDirective =
    persistedCurrentSideDialogAssignmentDirective ??
    persistedPendingAskBackReplyDirective ??
    persistedPendingRuntimePromptDirective ??
    persistedActiveReplyObligation;
  const suppressInterDialogReplyGuidance = isQ4HAnswerPrompt
    ? false
    : await shouldSuppressInterDialogReplyGuidanceForUserInterjection({
        dlg: args.dlg,
        prompt,
      });
  const availableReplyDirective = resolveFreshReplyDirective({
    promptDirective: prompt?.tellaskReplyDirective,
    persistedDirective: persistedActiveReplyDirective,
  });
  const activeReplyDirective = suppressInterDialogReplyGuidance
    ? undefined
    : availableReplyDirective;
  const promptContent =
    prompt === undefined
      ? undefined
      : suppressInterDialogReplyGuidance
        ? prompt.content
        : buildPromptContentWithExactReplyToolName({
            dlg: args.dlg,
            prompt,
            activeReplyDirective,
            language: args.language ?? getWorkLanguage(),
          });
  return {
    activeReplyDirective,
    deferredReplyReassertionDirective: suppressInterDialogReplyGuidance
      ? availableReplyDirective
      : undefined,
    isQ4HAnswerPrompt,
    promptContent,
    persistedTellaskReplyDirective: resolvePromptPersistedReplyDirective({
      promptDirective: prompt?.tellaskReplyDirective,
      persistedDirective: persistedActiveReplyDirective,
    }),
    suppressInterDialogReplyGuidance,
    transientGuideContent:
      suppressInterDialogReplyGuidance && prompt !== undefined
        ? buildReplyObligationSuppressionGuide({
            language: args.language ?? getWorkLanguage(),
          })
        : undefined,
  };
}

export function buildReplyObligationSuppressionGuide(args: { language: 'zh' | 'en' }): string {
  return buildReplyObligationSuppressionGuideText(args.language);
}

export async function buildReplyObligationReassertionPrompt(args: {
  dlg: Dialog;
  directive: NonNullable<KernelDriverPrompt['tellaskReplyDirective']>;
  language: 'zh' | 'en';
}): Promise<string> {
  return buildReplyObligationReassertionText({
    language: args.language,
    directive: args.directive,
    replyTargetAgentId: await resolveReplyTargetAgentId({
      dlg: args.dlg,
      directive: args.directive,
    }),
  });
}
