import { Dialog, SubDialog } from '../../dialog';
import { getWorkLanguage } from '../../runtime/work-language';
import { loadLatestActiveTellaskReplyDirective } from './tellask-special';
import type { KernelDriverHumanPrompt } from './types';

const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';
const REPLY_REASSERTION_PREFIX_EN = '[Dominds long-line reminder]';
const REPLY_REASSERTION_PREFIX_ZH = '[Dominds 长线提醒]';

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
    args.language === 'zh' ? '[Dominds 当前回复工具]' : '[Dominds active reply tool]';
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
  const note =
    args.language === 'zh'
      ? [
          activePrefix,
          `当前这轮若完成交付，精确应调用 \`${toolName}\`。`,
          '不要自己判断该选哪个 `reply*`；以上述函数名为准。',
        ].join('\n')
      : [
          activePrefix,
          `If this round is ready for final delivery, the exact reply tool is \`${toolName}\`.`,
          'Do not decide among `reply*` variants by yourself; follow that exact function name.',
        ].join('\n');
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
  if (args.language === 'zh') {
    return [
      '[Dominds 先接住这轮]',
      '先把用户刚插进来的这轮正常接住，按眼前的话题继续回答。',
      '原来那条长线先放一放，别急着顺着它往下收口。',
      '等相关支线结果回来后，运行时会再提醒你把那条线接回去。',
    ].join('\n');
  }
  return [
    '[Dominds handle this interjection first]',
    "First, handle the user's interjection normally and keep answering the topic in front of you.",
    'Set the earlier long-line thread aside for now; do not rush to close it yet.',
    'When the related sideline result comes back, runtime will remind you to pick that thread up again.',
  ].join('\n');
}

export function buildReplyObligationReassertionPrompt(args: {
  directive: NonNullable<KernelDriverHumanPrompt['tellaskReplyDirective']>;
  language: 'zh' | 'en';
}): string {
  const toolName = args.directive.expectedReplyCallName;
  if (args.language === 'zh') {
    return [
      REPLY_REASSERTION_PREFIX_ZH,
      '刚才为了接住用户插话，先把那条长线放在一边了。',
      '现在把它重新记回心里，后续继续推进时别把它丢了。',
      `等走到需要收口的时候，按 \`${toolName}\` 来处理就行；这条提醒不是在催你立刻回复。`,
    ].join('\n');
  }
  return [
    REPLY_REASSERTION_PREFIX_EN,
    'The user interjection was handled first, so that longer thread was set aside for a moment.',
    'Bring it back into mind now and do not lose it as you continue.',
    `When the time comes to close that thread, use \`${toolName}\`; this reminder is not telling you to reply immediately.`,
  ].join('\n');
}
