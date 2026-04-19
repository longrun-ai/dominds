import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { Dialog, DialogID, RootDialog, SubDialog } from '../../dialog';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { DialogPersistence } from '../../persistence';
import { isUserInterjectionPauseStopReason } from '../../runtime/interjection-pause-stop';
import {
  ACTIVE_REPLY_TOOL_PREFIX_EN,
  ACTIVE_REPLY_TOOL_PREFIX_ZH,
  REPLY_REASSERTION_PREFIX_EN,
  REPLY_REASSERTION_PREFIX_ZH,
  buildActiveReplyToolNote,
  buildReplyObligationReassertionText,
  buildReplyObligationSuppressionGuideText,
} from '../../runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../runtime/work-language';
import { loadLatestActiveTellaskReplyDirective } from './tellask-special';
import type { KernelDriverPrompt } from './types';

const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';

export async function resolveReplyTargetAgentId(args: {
  dlg: Dialog;
  directive: TellaskReplyDirective;
}): Promise<string | undefined> {
  switch (args.directive.expectedReplyCallName) {
    case 'replyTellaskBack': {
      const rootDialog =
        args.dlg instanceof RootDialog
          ? args.dlg
          : args.dlg instanceof SubDialog
            ? args.dlg.rootDialog
            : undefined;
      if (!rootDialog) {
        return undefined;
      }
      const targetDialogId = new DialogID(args.directive.targetDialogId, rootDialog.id.rootId);
      const targetDialog =
        rootDialog.lookupDialog(targetDialogId.selfId) ??
        (await ensureDialogLoaded(rootDialog, targetDialogId, rootDialog.status));
      return targetDialog?.agentId;
    }
    case 'replyTellask':
    case 'replyTellaskSessionless':
      return args.dlg instanceof SubDialog ? args.dlg.assignmentFromSup.originMemberId : undefined;
  }
}

function buildPromptContentWithExactReplyToolName(args: {
  dlg: Dialog;
  prompt: KernelDriverPrompt;
  activeReplyDirective: KernelDriverPrompt['tellaskReplyDirective'];
  language: 'zh' | 'en';
}): string {
  const isFbrSubdialog =
    args.dlg instanceof SubDialog && args.dlg.assignmentFromSup.callName === 'freshBootsReasoning';
  const noActivePrefix =
    args.language === 'zh'
      ? '[Dominds 当前无跨对话回复义务]'
      : '[Dominds no active inter-dialog reply]';
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
    if (isFbrSubdialog) {
      return args.prompt.content;
    }
    if (!(args.dlg instanceof SubDialog)) {
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
  if (left.targetCallId !== right.targetCallId || left.tellaskContent !== right.tellaskContent) {
    return false;
  }
  if (left.expectedReplyCallName === 'replyTellaskBack') {
    return (
      right.expectedReplyCallName === 'replyTellaskBack' &&
      left.targetDialogId === right.targetDialogId
    );
  }
  return true;
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
  // Do not "simplify" this into a pure display-state check or a pure pending-subdialog check.
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
  const activeReplyDirective = await loadLatestActiveTellaskReplyDirective(args.dlg);
  if (activeReplyDirective) {
    return true;
  }
  // Use strict persistence reads here. This branch changes business behavior, so a read failure
  // must loud-fail the round instead of being silently treated as "pending subdialogs exist".
  const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(
    args.dlg.id,
    args.dlg.status,
  );
  return pendingSubdialogs.length > 0;
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
  const persistedPendingCourseStartDirective =
    prompt !== undefined &&
    latest?.pendingCourseStartPrompt?.msgId === prompt.msgId &&
    latest.pendingCourseStartPrompt.origin === 'runtime'
      ? latest.pendingCourseStartPrompt.tellaskReplyDirective
      : undefined;
  const persistedActiveReplyDirective =
    persistedPendingCourseStartDirective ?? (await loadLatestActiveTellaskReplyDirective(args.dlg));
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
    persistedTellaskReplyDirective:
      persistedPendingCourseStartDirective ?? prompt?.tellaskReplyDirective ?? activeReplyDirective,
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
