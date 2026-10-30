import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import { getTellaskKindLabel } from './tellask-labels';

export const ACTIVE_REPLY_TOOL_PREFIX_EN = '[Dominds Tellask reply path]';
export const ACTIVE_REPLY_TOOL_PREFIX_ZH = '[Dominds 诉请回复路径]';
export const NO_ACTIVE_REPLY_PREFIX_EN = '[Dominds no Tellask reply needed]';
export const NO_ACTIVE_REPLY_PREFIX_ZH = '[Dominds 无需发送诉请回复]';
export const REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds Tellask reply remains pending]';
const LEGACY_REPLY_TOOL_REMINDER_PREFIX_EN = '[Dominds send the Tellask reply now]';
export const REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 诉请回复仍待完成]';
const LEGACY_REPLY_TOOL_REMINDER_PREFIX_ZH = '[Dominds 现在发送诉请回复]';
export const ANSWERING_REPLY_REMINDER_PREFIX_EN = '[Dominds Tellask reply still required]';
export const ANSWERING_REPLY_REMINDER_PREFIX_ZH = '[Dominds 仍需发送诉请回复]';
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

function buildReplyToolReminderLine(args: ReplyObligationCopyArgs): string {
  const toolName = args.directive.expectedReplyCallName;
  const replyTarget = formatReplyTargetAgentId(args.replyTargetAgentId, args.language);
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.directive.expectedReplyCallName,
    bracketed: true,
  });
  return args.language === 'zh'
    ? `${replyTarget} 还在等你完成${kindLabel}的诉请回复。最终内容准备好时，调用 \`${toolName}({ replyContent })\` 发送。`
    : `${replyTarget} is still waiting for your ${kindLabel} Tellask reply. When the final content is ready, call \`${toolName}({ replyContent })\` to send it.`;
}

// Business scenario: Dominds has a durable record that this dialog still owes a final reply to
// the requester. The model is not supposed to rediscover whether this is replyTellask,
// replyTellaskSessionless, or replyTellaskBack from old transcript text; that choice comes from
// the active request record. The copy therefore says Dominds already chose one path and names one
// tool. It also says "when final content is ready" because an active reply path is a delivery
// constraint, not a command to abandon necessary local work and close early.
export function buildActiveReplyToolNote(args: {
  language: LanguageCode;
  toolName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
}): string {
  if (args.language === 'zh') {
    return [
      ACTIVE_REPLY_TOOL_PREFIX_ZH,
      'Dominds 已经判断好：这轮如果要把最终结果回给诉请者，只能用下面这个工具。',
      `先把当前任务做对；等最终内容准备好时，调用 \`${args.toolName}\`。不要提前发送，也不要改用别的回复工具。`,
    ].join('\n');
  }
  return [
    ACTIVE_REPLY_TOOL_PREFIX_EN,
    'Dominds has already decided the Tellask reply path: if this turn sends the final result back to the tellasker, use only the tool below.',
    `Do the current task correctly first; when the final content is ready, call \`${args.toolName}\`. Do not send early or switch to another Tellask reply tool.`,
  ].join('\n');
}

// Business scenario: the dialog still owes a final answer to a requester, but this block is
// persistent context rather than a fresh user request. Without that distinction, models tend to
// treat the state block itself as an instruction to immediately reply or to re-open the original
// request as new work. Keep the wording simple: who is waiting, which request it is, and which
// exact tool sends the final content when the answer is actually ready.
export function buildActiveReplyObligationContextText(args: {
  language: LanguageCode;
  directive: TellaskReplyDirective;
}): string {
  if (args.language === 'zh') {
    return [
      '[Dominds 待发送诉请回复]',
      '这是 Dominds 状态，不是新的用户请求。',
      `要回给的对话：${args.directive.targetDialogId}`,
      `对应请求：${args.directive.targetCallId}`,
      `发送最终内容时调用：\`${args.directive.expectedReplyCallName}({ replyContent })\``,
      '',
      '原始诉请内容：',
      args.directive.tellaskContent,
    ].join('\n');
  }
  return [
    '[Dominds pending Tellask reply]',
    'This is Dominds state, not a new user request.',
    `Tellasker dialog: ${args.directive.targetDialogId}`,
    `Tellask callId: ${args.directive.targetCallId}`,
    `When sending the final content, call: \`${args.directive.expectedReplyCallName}({ replyContent })\``,
    '',
    'Original request content:',
    args.directive.tellaskContent,
  ].join('\n');
}

// Business scenario: a Side Dialog has enough information to finish the assigned work. At that
// point `tellaskBack` is still only for asking the requester a question; it must not be used as a
// final delivery path. Dominds may already name the precise reply tool from durable state, so the
// model should not choose among reply variants by memory or by guessing from the original
// assignment.
export function buildSideDialogCompletionRule(language: LanguageCode): string {
  return language === 'zh'
    ? '当前支线已完成并能给出最终交付时：先专注把当前任务做对；若 Dominds 点名了精确回复工具，就只在发送最终内容时调用那个工具，不要改用别的回复工具，也不要用 `tellaskBack` 发送最终结果。'
    : 'If the current Side Dialog is complete and can deliver the final result: focus on finishing the actual task first; if Dominds names an exact Tellask reply tool, call that tool only when sending the final content, do not switch to another Tellask reply tool, and do not use `tellaskBack` for final delivery.';
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
    ? `${tellaskerTag} 已通过${kindLabel}安排你处理下述诉请内容。等你准备好最终诉请回复后，调用 \`${args.expectedReplyTool}\` 发回去。只有确实需要向诉请者回问、且现有规程无法直接判责时，才调用 \`tellaskBack\`。`
    : `${tellaskerTag} has assigned you, via this ${kindLabel}, to handle the request content below. When the final Tellask reply is ready, call \`${args.expectedReplyTool}\` to send it back. Call \`tellaskBack\` only when you truly need to ask the tellasker back and existing SOP cannot directly identify another owner.`;
}

// Business scenario: a real user interjected while a longer-running requester reply was still
// open. The current user message wins the immediate turn; the older reply task remains ordinary
// durable state for later drive logic. The model-facing copy must not ask the model to decide
// whether the old request or the new user message wins; Dominds already decided. It also must not
// ban tools generally: tools are fine when the current user message itself needs them, but old
// request/reminder context must not pull the model back into earlier handoff work before the
// visible user answer.
export function buildReplyObligationSuppressionGuideText(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      REPLY_SUPPRESSION_PREFIX_ZH,
      '本轮最新用户消息是真实用户插话；先按这条最新用户消息回答，让用户看到你已经接住了当前话题。',
      '原来的长线诉请、诉请回复任务、技能/SOP 触发条件都不能抢在当前用户消息前面；不要在回答当前用户消息前切回旧任务、旧工具流程或旧收口。',
      '只有当前用户消息本身需要，才使用工具；不要因为旧长线任务、旧技能提示或旧提醒项去调用工具。',
      '当前用户插话得到可见回复后，Dominds 会按已有回复义务、续推和普通驱动规则继续处理后续状态。',
    ].join('\n');
  }
  return [
    REPLY_SUPPRESSION_PREFIX_EN,
    'The latest user message in this turn is a real user interjection; answer that latest user message first so the user can see you handled the current topic.',
    'The earlier long-line request, Tellask reply task, and skill/SOP triggers must not jump ahead of the current user message; do not switch back to the old task, old tool flow, or old closure before answering the current user message.',
    'Use tools only if the current user message itself requires them; do not call tools because of the earlier long-line task, old skill hints, or old reminders.',
    'After the current user interjection has a visible reply, Dominds will continue according to the existing reply obligation, diligence push, and normal drive rules.',
  ].join('\n');
}

// Local output may be a completed answer, a preliminary candidate or only internal thinking.
// The durable obligation identifies the recipient/tool; it does not prove that work is ready.
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
        '你仍欠诉请者一份正式回复。普通文本或内部思考本身不构成向对方交付。',
        '',
        buildReplyToolReminderLine(args),
        '若最终内容尚未准备好，请继续当前任务并先处理未解决的失败。不要把中间候选或内部思考当作最终回复发送。',
      ].join('\n')
    : [
        prefix,
        '',
        'A formal reply to the requester remains pending. Local plain text or internal thinking does not itself deliver that reply.',
        '',
        buildReplyToolReminderLine(args),
        'If the final content is not ready, continue the current task and handle outstanding failures first. Do not send preliminary work or internal thinking as the final reply.',
      ].join('\n');
}

// Business scenario: the model produced structured `answering` (or called `answerHuman`) while a
// Side Dialog still owes a formal reply to its requester. A2H is a human-attention answer or status
// record; it is intentionally not the requester delivery channel. Keep this as a reply-tool
// reminder so a later plain-text answer can use the same direct-fallback recovery semantics as
// ordinary reminders.
export function buildAnsweringReplyReminderText(args: {
  language: LanguageCode;
  directive: TellaskReplyDirective;
  replyTargetAgentId?: string;
}): string {
  const prefix =
    args.language === 'zh'
      ? ANSWERING_REPLY_REMINDER_PREFIX_ZH
      : ANSWERING_REPLY_REMINDER_PREFIX_EN;
  const replyTarget = formatReplyTargetAgentId(args.replyTargetAgentId, args.language);
  const kindLabel = getTellaskKindLabel({
    language: args.language,
    name: args.directive.expectedReplyCallName,
    bracketed: true,
  });
  return args.language === 'zh'
    ? [
        prefix,
        '',
        '`answering` / `answerHuman` 只会记录给人类看的 A2H 答复或状态说明，不会把正式诉请回复送达诉请者。',
        '',
        `${replyTarget} 还在等你完成${kindLabel}的诉请回复。若最终内容已经准备好，请现在调用 \`${args.directive.expectedReplyCallName}({ replyContent })\` 发送；不要用 \`answering\` 或 \`answerHuman\` 代替向诉请者发送诉请回复。`,
      ].join('\n')
    : [
        prefix,
        '',
        '`answering` / `answerHuman` only records an A2H answer or status for the human. It does not deliver the formal Tellask reply to the tellasker.',
        '',
        `${replyTarget} is still waiting for your ${kindLabel} Tellask reply. If the final content is ready, call \`${args.directive.expectedReplyCallName}({ replyContent })\` now; do not use \`answering\` or \`answerHuman\` as the Tellask reply path.`,
      ].join('\n');
}

// Earlier serialized runtime queues used these tags. Recognize their delivery state while
// rendering current guidance; old queue data must not create another reminder round on upgrade.
export function isLegacyReplyToolReminderPromptContent(content: string): boolean {
  return (
    content.startsWith(LEGACY_REPLY_TOOL_REMINDER_PREFIX_ZH) ||
    content.startsWith(LEGACY_REPLY_TOOL_REMINDER_PREFIX_EN)
  );
}

export function isReplyToolReminderPromptContent(content: string): boolean {
  return (
    isLegacyReplyToolReminderPromptContent(content) ||
    content.startsWith(REPLY_TOOL_REMINDER_PREFIX_ZH) ||
    content.startsWith(REPLY_TOOL_REMINDER_PREFIX_EN) ||
    content.startsWith(ANSWERING_REPLY_REMINDER_PREFIX_ZH) ||
    content.startsWith(ANSWERING_REPLY_REMINDER_PREFIX_EN)
  );
}

export function isStandaloneRuntimeGuidePromptContent(content: string): boolean {
  return (
    content.startsWith(REPLY_SUPPRESSION_PREFIX_ZH) ||
    content.startsWith(REPLY_SUPPRESSION_PREFIX_EN)
  );
}
