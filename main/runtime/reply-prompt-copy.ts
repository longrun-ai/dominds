import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { getTellaskKindLabel } from './tellask-labels';

export const ACTIVE_REPLY_TOOL_PREFIX_EN = '[Dominds active reply tool]';
export const ACTIVE_REPLY_TOOL_PREFIX_ZH = '[Dominds 当前回复工具]';
export const NO_ACTIVE_REPLY_PREFIX_EN = '[Dominds no active inter-dialog reply]';
export const NO_ACTIVE_REPLY_PREFIX_ZH = '[Dominds 当前无跨对话回复义务]';
export const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds replyTellask required]';
export const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 必须调用回复工具]';
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
      `若这轮最终需要对诉请者完成交付，精确调用 \`${args.toolName}\`；不要改选其他 \`reply*\`，也不要提前收口。`,
    ].join('\n');
  }
  return [
    ACTIVE_REPLY_TOOL_PREFIX_EN,
    'Stay focused on the task in front of you for this turn; do not get distracted by choosing among `reply*` variants.',
    `If this turn truly reaches final delivery back to the tellasker, call \`${args.toolName}\` exactly; do not switch to another \`reply*\` variant or close early.`,
  ].join('\n');
}

export function buildActiveReplyObligationContextText(args: {
  language: LanguageCode;
  directive: TellaskReplyDirective;
}): string {
  if (args.language === 'zh') {
    return [
      '[Dominds 当前跨对话回复义务]',
      '这是运行时状态，不是新的用户请求。',
      `必须回复的目标对话：${args.directive.targetDialogId}`,
      `必须结清的调用：${args.directive.targetCallId}`,
      `最终交付时精确调用：\`${args.directive.expectedReplyCallName}({ replyContent })\``,
      '',
      '原始诉请内容：',
      args.directive.tellaskContent,
    ].join('\n');
  }
  return [
    '[Dominds active inter-dialog reply obligation]',
    'This is runtime state, not a new user request.',
    `Target dialog to reply to: ${args.directive.targetDialogId}`,
    `Call to settle: ${args.directive.targetCallId}`,
    `At final delivery, call exactly: \`${args.directive.expectedReplyCallName}({ replyContent })\``,
    '',
    'Original request content:',
    args.directive.tellaskContent,
  ].join('\n');
}

export function buildSideDialogCompletionRule(language: LanguageCode): string {
  return language === 'zh'
    ? '当前支线已完成并能给出最终交付时：先专注把当前任务做对；若运行时点名了精确 reply 函数，就只在最终交付收口时调用那个函数，不要改选其他 `reply*`，也不要再走 `tellaskBack`。'
    : 'If the current Side Dialog is complete and can deliver the final result: stay focused on finishing the actual task first; if runtime names an exact reply function, call that function only at final tellasker delivery, do not switch among `reply*` variants, and do not use `tellaskBack` for final delivery.';
}

export function buildSideDialogRoleHeaderCopy(args: {
  language: LanguageCode;
  tellaskerId: string;
  expectedReplyTool?: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack' | undefined;
}): string {
  const tellaskerTag = `@${args.tellaskerId}`;
  if (args.expectedReplyTool === undefined) {
    return args.language === 'zh'
      ? `${tellaskerTag} 已通过诉请安排你处理下述诉请内容。只有确实需要向诉请者回问、且现有规程无法直接判责时，才调用 \`tellaskBack\`。`
      : `${tellaskerTag} has assigned you to handle the request content below. Call \`tellaskBack\` only when you truly need to ask the tellasker back and existing SOP cannot directly identify another owner.`;
  }
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.expectedReplyTool,
    bracketed: true,
  });
  return args.language === 'zh'
    ? `${tellaskerTag} 已通过${kindLabel}安排你处理下述诉请内容。等你准备好回复内容后，调用 \`${args.expectedReplyTool}\` 完成回复。只有确实需要向诉请者回问、且现有规程无法直接判责时，才调用 \`tellaskBack\`。`
    : `${tellaskerTag} has assigned you, via this ${kindLabel}, to handle the request content below. Once your reply content is ready, call \`${args.expectedReplyTool}\` to deliver it. Call \`tellaskBack\` only when you truly need to ask the tellasker back and existing SOP cannot directly identify another owner.`;
}

export function buildReplyObligationSuppressionGuideText(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      REPLY_SUPPRESSION_PREFIX_ZH,
      '本轮最新用户消息是真实用户插话；先按这条最新用户消息回答，让用户看到你已经接住了当前话题。',
      '原来的长线诉请、回复工具义务、技能/SOP 触发条件都已暂存；不要在回答当前用户消息前切回旧任务、旧工具流程或旧收口。',
      '只有当前用户消息本身需要，才使用工具；不要因为旧长线任务、旧技能提示或旧提醒项去调用工具。',
      '等当前用户插话已经得到可见回复后，运行时会再提醒你接回原来的长线。',
    ].join('\n');
  }
  return [
    REPLY_SUPPRESSION_PREFIX_EN,
    'The latest user message in this turn is a real user interjection; answer that latest user message first so the user can see you handled the current topic.',
    'The earlier long-line request, reply-tool obligation, and skill/SOP triggers are parked; do not switch back to the old task, old tool flow, or old closure before answering the current user message.',
    'Use tools only if the current user message itself requires them; do not call tools because of the earlier long-line task, old skill hints, or old reminders.',
    'After the current user interjection has a visible reply, runtime will remind you to resume the earlier long-line thread.',
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
  replyTargetAgentId?: string;
}): string {
  const prefix =
    args.language === 'zh' ? REPLY_TOOL_REMINDER_PREFIX_ZH : REPLY_TOOL_REMINDER_PREFIX_EN;
  return args.language === 'zh'
    ? [
        prefix,
        '',
        `你刚才已经产出了可作为回贴的内容，但还没调用 \`${args.directive.expectedReplyCallName}\`。`,
        '',
        buildReplyToolReminderLine(args),
        '不要依赖 direct-reply fallback；它只是运行时临时过渡兜底，不是正式回复机制。请现在调用正确的 reply 工具完成回复。',
      ].join('\n')
    : [
        prefix,
        '',
        `You already produced content that can be delivered as the reply, but you still have not called \`${args.directive.expectedReplyCallName}\`.`,
        '',
        buildReplyToolReminderLine(args),
        'Do not rely on direct-reply fallback; it is only a temporary runtime transition safeguard, not the formal reply mechanism. Call the correct reply tool now.',
      ].join('\n');
}

export function isReplyToolReminderPromptContent(content: string): boolean {
  return (
    content.startsWith(REPLY_TOOL_REMINDER_PREFIX_ZH) ||
    content.startsWith(REPLY_TOOL_REMINDER_PREFIX_EN)
  );
}

export function isStandaloneRuntimeGuidePromptContent(content: string): boolean {
  return (
    content.startsWith(REPLY_REASSERTION_PREFIX_ZH) ||
    content.startsWith(REPLY_REASSERTION_PREFIX_EN) ||
    content.startsWith(REPLY_SUPPRESSION_PREFIX_ZH) ||
    content.startsWith(REPLY_SUPPRESSION_PREFIX_EN)
  );
}
