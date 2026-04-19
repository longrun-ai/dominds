import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { getTellaskKindLabel } from './tellask-labels';

export const ACTIVE_REPLY_TOOL_PREFIX_EN = '[Dominds active reply tool]';
export const ACTIVE_REPLY_TOOL_PREFIX_ZH = '[Dominds 当前回复工具]';
export const REPLY_REASSERTION_PREFIX_EN = '[Dominds long-line reminder]';
export const REPLY_REASSERTION_PREFIX_ZH = '[Dominds 长线提醒]';
export const REPLY_SUPPRESSION_PREFIX_EN = '[Dominds handle this interjection first]';
export const REPLY_SUPPRESSION_PREFIX_ZH = '[Dominds 先接住这轮]';

type ReplyObligationCopyArgs = {
  language: LanguageCode;
  directive: TellaskReplyDirective;
  replyTargetAgentId?: string;
};

function formatReplyTargetAgentId(agentId: string | undefined, language: LanguageCode): string {
  if (agentId && agentId.trim() !== '') {
    return `@${agentId}`;
  }
  return language === 'zh' ? '对方' : 'the other dialog';
}

function buildReplyObligationReassertionLine(args: ReplyObligationCopyArgs): string {
  const toolName = args.directive.expectedReplyCallName;
  const replyTarget = formatReplyTargetAgentId(args.replyTargetAgentId, args.language);
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.directive.expectedReplyCallName,
    bracketed: true,
  });
  return args.language === 'zh'
    ? `${replyTarget} 的${kindLabel}还在等你的回复。等你准备好回复内容后，调用 \`${toolName}\` 完成回复。这里不是催你立刻回复。`
    : `${replyTarget}'s ${kindLabel} is still waiting for your reply. Once your reply content is ready, call \`${toolName}\` to deliver it. This is not asking you to reply immediately.`;
}

function buildReplyToolReminderLine(args: ReplyObligationCopyArgs): string {
  const toolName = args.directive.expectedReplyCallName;
  const replyTarget = formatReplyTargetAgentId(args.replyTargetAgentId, args.language);
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.directive.expectedReplyCallName,
    bracketed: true,
  });
  return args.language === 'zh'
    ? `${replyTarget} 的${kindLabel}还在等你的回复。请现在调用 \`${toolName}({ replyContent })\` 完成回复。`
    : `${replyTarget}'s ${kindLabel} is still waiting for your reply. Call \`${toolName}({ replyContent })\` now to deliver it.`;
}

export function buildActiveReplyToolNote(args: {
  language: LanguageCode;
  toolName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
}): string {
  if (args.language === 'zh') {
    return [
      ACTIVE_REPLY_TOOL_PREFIX_ZH,
      '先专注处理眼前这轮任务，不要被 `reply*` 选择分心。',
      `若这轮最终需要对上游完成交付，精确调用 \`${args.toolName}\`；不要改选其他 \`reply*\`，也不要提前收口。`,
    ].join('\n');
  }
  return [
    ACTIVE_REPLY_TOOL_PREFIX_EN,
    'Stay focused on the task in front of you for this turn; do not get distracted by choosing among `reply*` variants.',
    `If this turn truly reaches final delivery back upstream, call \`${args.toolName}\` exactly; do not switch to another \`reply*\` variant or close early.`,
  ].join('\n');
}

export function buildSidelineCompletionRule(language: LanguageCode): string {
  return language === 'zh'
    ? '当前支线已完成并能给出最终交付时：先专注把当前任务做对；若运行时点名了精确 reply 函数，就只在最终交付收口时调用那个函数，不要改选其他 `reply*`，也不要再走 `tellaskBack`。'
    : 'If the current sideline is complete and can deliver the final result: stay focused on finishing the actual task first; if runtime names an exact reply function, call that function only at final upstream delivery, do not switch among `reply*` variants, and do not use `tellaskBack` for final delivery.';
}

export function buildSubdialogRoleHeaderCopy(args: {
  language: LanguageCode;
  requesterId: string;
  expectedReplyTool?: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack' | undefined;
}): string {
  const requester = `@${args.requesterId}`;
  if (args.expectedReplyTool === undefined) {
    return args.language === 'zh'
      ? `${requester} 已通过诉请安排你处理下述诉请内容。只有确实需要向上游回问、且现有规程无法直接判责时，才调用 \`tellaskBack\`。`
      : `${requester} has assigned you to handle the request content below. Call \`tellaskBack\` only when you truly need to ask upstream back and existing SOP cannot directly identify another owner.`;
  }
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.expectedReplyTool,
    bracketed: true,
  });
  return args.language === 'zh'
    ? `${requester} 已通过${kindLabel}安排你处理下述诉请内容。等你准备好回复内容后，调用 \`${args.expectedReplyTool}\` 完成回复。只有确实需要向上游回问、且现有规程无法直接判责时，才调用 \`tellaskBack\`。`
    : `${requester} has assigned you, via this ${kindLabel}, to handle the request content below. Once your reply content is ready, call \`${args.expectedReplyTool}\` to deliver it. Call \`tellaskBack\` only when you truly need to ask upstream back and existing SOP cannot directly identify another owner.`;
}

export function buildReplyObligationSuppressionGuideText(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      REPLY_SUPPRESSION_PREFIX_ZH,
      '先把用户刚插进来的这轮正常接住，按眼前的话题继续回答。',
      '原来那条长线先放一放，别急着顺着它往下收口。',
      '等原任务允许恢复时，运行时会再提醒你把那条线接回去。',
    ].join('\n');
  }
  return [
    REPLY_SUPPRESSION_PREFIX_EN,
    "First, handle the user's interjection normally and keep answering the topic in front of you.",
    'Set the earlier long-line thread aside for now; do not rush to close it yet.',
    'When the original task becomes resumable again, runtime will remind you to pick that thread up again.',
  ].join('\n');
}

export function buildReplyObligationReassertionText(args: ReplyObligationCopyArgs): string {
  return args.language === 'zh'
    ? [
        REPLY_REASSERTION_PREFIX_ZH,
        '',
        '刚才那轮插话已经处理完了，现在继续原来的长线任务。',
        '',
        buildReplyObligationReassertionLine(args),
      ].join('\n')
    : [
        REPLY_REASSERTION_PREFIX_EN,
        '',
        'The interjection has been handled. Now continue the original longer-running task.',
        '',
        buildReplyObligationReassertionLine(args),
      ].join('\n');
}

export function buildReplyToolReminderText(args: {
  language: LanguageCode;
  directive: TellaskReplyDirective;
  prefix: string;
  replyTargetAgentId?: string;
}): string {
  return args.language === 'zh'
    ? [
        args.prefix,
        '',
        `你刚才已经写了正文，但还没调用 \`${args.directive.expectedReplyCallName}\`。`,
        '',
        buildReplyToolReminderLine(args),
        '如果你再次直接输出最终消息而仍不调用该工具，运行时当前会暂按 direct-reply fallback 投递，并在 UI/传递正文中明确标注。',
      ].join('\n')
    : [
        args.prefix,
        '',
        `You already wrote the reply body, but you still have not called \`${args.directive.expectedReplyCallName}\`.`,
        '',
        buildReplyToolReminderLine(args),
        'If you still emit a plain final message without the tool, runtime will currently deliver it via direct-reply fallback and label that path explicitly in UI and transfer text.',
      ].join('\n');
}

export function isStandaloneRuntimeGuidePromptContent(content: string): boolean {
  return (
    content.startsWith(REPLY_REASSERTION_PREFIX_ZH) ||
    content.startsWith(REPLY_REASSERTION_PREFIX_EN) ||
    content.startsWith(REPLY_SUPPRESSION_PREFIX_ZH) ||
    content.startsWith(REPLY_SUPPRESSION_PREFIX_EN)
  );
}
