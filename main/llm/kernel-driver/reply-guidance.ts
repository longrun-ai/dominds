import { Dialog, SubDialog } from '../../dialog';
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
import type { KernelDriverHumanPrompt } from './types';

const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';

function buildPromptContentWithExactReplyToolName(args: {
  dlg: Dialog;
  prompt: KernelDriverHumanPrompt;
  activeReplyDirective: KernelDriverHumanPrompt['tellaskReplyDirective'];
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
  const toolName = directive.expectedReplyCallName;
  if (reminderPrefixes.some((prefix) => args.prompt.content.startsWith(prefix))) {
    return args.prompt.content;
  }
  const note = buildActiveReplyToolNote({
    language: args.language,
    toolName,
  });
  return `${note}\n\n${args.prompt.content}`;
}

async function shouldSuppressInterDialogReplyGuidanceForUserInterjection(args: {
  dlg: Dialog;
  prompt: KernelDriverHumanPrompt | undefined;
}): Promise<boolean> {
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
  return await args.dlg.hasPendingSubdialogs();
}

export async function resolvePromptReplyGuidance(args: {
  dlg: Dialog;
  prompt: KernelDriverHumanPrompt | undefined;
  language?: 'zh' | 'en';
}): Promise<{
  activeReplyDirective: KernelDriverHumanPrompt['tellaskReplyDirective'];
  deferredReplyReassertionDirective: KernelDriverHumanPrompt['tellaskReplyDirective'];
  promptContent: string | undefined;
  persistedTellaskReplyDirective: KernelDriverHumanPrompt['tellaskReplyDirective'];
  suppressInterDialogReplyGuidance: boolean;
  transientGuideContent: string | undefined;
}> {
  const prompt = args.prompt;
  const suppressInterDialogReplyGuidance =
    await shouldSuppressInterDialogReplyGuidanceForUserInterjection({
      dlg: args.dlg,
      prompt,
    });
  const availableReplyDirective =
    prompt?.tellaskReplyDirective ?? (await loadLatestActiveTellaskReplyDirective(args.dlg));
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
    promptContent,
    persistedTellaskReplyDirective: prompt?.tellaskReplyDirective ?? activeReplyDirective,
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

export function buildReplyObligationReassertionPrompt(args: {
  directive: NonNullable<KernelDriverHumanPrompt['tellaskReplyDirective']>;
  language: 'zh' | 'en';
}): string {
  return buildReplyObligationReassertionText({
    language: args.language,
    toolName: args.directive.expectedReplyCallName,
  });
}
