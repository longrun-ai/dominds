import type { LanguageCode } from '@longrun-ai/kernel/types/language';

export const ACTIVE_REPLY_TOOL_PREFIX_EN = '[Dominds active reply tool]';
export const ACTIVE_REPLY_TOOL_PREFIX_ZH = '[Dominds 当前回复工具]';
export const REPLY_REASSERTION_PREFIX_EN = '[Dominds long-line reminder]';
export const REPLY_REASSERTION_PREFIX_ZH = '[Dominds 长线提醒]';
export const REPLY_SUPPRESSION_PREFIX_EN = '[Dominds handle this interjection first]';
export const REPLY_SUPPRESSION_PREFIX_ZH = '[Dominds 先接住这轮]';

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
  if (args.expectedReplyTool === undefined) {
    return args.language === 'zh'
      ? `你是当前被诉请者对话（tellaskee dialog）的主理人；诉请者对话（tellasker dialog）为 @${args.requesterId}（当前发起本次诉请）。只有在需要回问上游时才调用 \`tellaskBack\`。`
      : `You are the responder (tellaskee dialog) for this dialog; the tellasker dialog is @${args.requesterId} (the current caller). Call \`tellaskBack\` only when you need to ask back upstream.`;
  }
  return args.language === 'zh'
    ? `你是当前被诉请者对话（tellaskee dialog）的主理人；诉请者对话（tellasker dialog）为 @${args.requesterId}（当前发起本次诉请）。先把当前任务做对；若本轮最终需要对上游完成交付，必须精确调用 \`${args.expectedReplyTool}\` 收口，不要改选其他 \`reply*\`。只有在需要回问上游时才调用 \`tellaskBack\`。`
    : `You are the responder (tellaskee dialog) for this dialog; the tellasker dialog is @${args.requesterId} (the current caller). First, do the current task correctly; if this round ultimately needs final delivery back upstream, you must close with \`${args.expectedReplyTool}\` exactly and must not switch to another \`reply*\` variant. Call \`tellaskBack\` only when you need to ask back upstream.`;
}

export function buildReplyObligationSuppressionGuideText(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      REPLY_SUPPRESSION_PREFIX_ZH,
      '先把用户刚插进来的这轮正常接住，按眼前的话题继续回答。',
      '原来那条长线先放一放，别急着顺着它往下收口。',
      '等相关支线结果回来后，运行时会再提醒你把那条线接回去。',
    ].join('\n');
  }
  return [
    REPLY_SUPPRESSION_PREFIX_EN,
    "First, handle the user's interjection normally and keep answering the topic in front of you.",
    'Set the earlier long-line thread aside for now; do not rush to close it yet.',
    'When the related sideline result comes back, runtime will remind you to pick that thread up again.',
  ].join('\n');
}

export function buildReplyObligationReassertionText(args: {
  language: LanguageCode;
  toolName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
}): string {
  if (args.language === 'zh') {
    return [
      REPLY_REASSERTION_PREFIX_ZH,
      '刚才那轮用户插话已经先接住了，现在继续原来那条长线任务本身。',
      '继续做该做的事，别只盯着 `reply*` 工具名。',
      `真走到需要对上游完成交付的时候，再精确调用 \`${args.toolName}\`；这条提醒不是在催你立刻收口。`,
    ].join('\n');
  }
  return [
    REPLY_REASSERTION_PREFIX_EN,
    'The user interjection has already been handled first; now continue the original longer-running task itself.',
    'Keep doing the actual work instead of fixating on the `reply*` tool name.',
    `Only when that work truly reaches final delivery upstream should you call \`${args.toolName}\`; this reminder is not asking you to close immediately.`,
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
