/**
 * Inter-dialog formatting module.
 *
 * Naming + storage rules:
 * - "Record"/"_record" is reserved for persisted data records (source of truth).
 * - This module builds canonical transfer payload text from structured fields.
 * - Source-dialog model raw must stay in source records; do not rewrite it here.
 *
 * Transfer payload contract:
 * - Assignment/call payloads are generated from mention list + tellask content.
 * - Tellask-response payloads include runtime markers + response body + call-site summary.
 * - The same transfer payload should be used for both model context and UI rendering.
 */

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatRegisteredTellaskCalleeUpdateNotice } from './driver-messages';
import { markdownQuote } from './markdown-format';
import { buildSubdialogRoleHeaderCopy } from './reply-prompt-copy';
import { getTellaskKindLabel } from './tellask-labels';

export type InterDialogCallContent = {
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
};

export type InterDialogParticipants = {
  fromAgentId: string;
  toAgentId: string;
};

export type SubdialogAssignmentFormatInput = InterDialogParticipants &
  InterDialogCallContent & {
    language?: LanguageCode;
    collectiveTargets?: string[];
    sessionSlug?: string;
    fbrRound?: {
      iteration: number;
      total: number;
    };
  };

export type SupdialogCallPromptInput = {
  fromAgentId: string;
  toAgentId: string;
  subdialogRequest: InterDialogCallContent;
  supdialogAssignment: InterDialogCallContent;
  language?: LanguageCode;
};

export type TellaskResponseFormatInput = {
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  responderId: string;
  requesterId: string;
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  responseBody: string;
  status?: 'completed' | 'failed';
  deliveryMode?: 'reply_tool' | 'direct_fallback';
  language?: LanguageCode;
};

export type TellaskReplacementNoticeFormatInput = {
  responderId: string;
  requesterId: string;
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  responseBody: string;
  language?: LanguageCode;
};

export type TellaskCarryoverResultFormatInput = {
  originCourse: number;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  responderId: string;
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  responseBody: string;
  status: 'completed' | 'failed';
  language?: LanguageCode;
};

export type RuntimeTransferMarkers = Readonly<{
  tellaskBack: string;
  finalCompleted: string;
  fbrDirectReply: string;
  fbrReasoningOnly: string;
}>;

export function getRuntimeTransferMarkers(language: LanguageCode): RuntimeTransferMarkers {
  if (language === 'zh') {
    return {
      tellaskBack: getTellaskKindLabel({ language, name: 'tellaskBack', bracketed: true }),
      finalCompleted: '【最终完成】',
      fbrDirectReply: '【FBR-直接回复】',
      fbrReasoningOnly: '【FBR-仅推理】',
    };
  }
  return {
    tellaskBack: getTellaskKindLabel({ language, name: 'tellaskBack', bracketed: true }),
    finalCompleted: '【Completed】',
    fbrDirectReply: '【FBR-Direct Reply】',
    fbrReasoningOnly: '【FBR-Reasoning Only】',
  };
}

function getRuntimeTransferMarker(input: TellaskResponseFormatInput): string | undefined {
  const language: LanguageCode = input.language ?? 'en';
  const markers = getRuntimeTransferMarkers(language);
  if (input.status === undefined) return undefined;
  if (input.callName === 'tellaskBack') return markers.tellaskBack;
  if (input.callName === 'freshBootsReasoning') return markers.fbrReasoningOnly;
  if (
    (input.callName === 'tellask' || input.callName === 'tellaskSessionless') &&
    input.status === 'completed'
  ) {
    return markers.finalCompleted;
  }
  return undefined;
}

function requireNonEmpty(value: string, fieldLabel: string): string {
  if (value.trim() === '') {
    throw new Error(`Empty ${fieldLabel} is not allowed for inter-dialog formatting.`);
  }
  return value;
}

type SubdialogRoleHeaderInput = {
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  fromAgentId: string;
  language: LanguageCode;
};

function getExpectedReplyToolName(
  callName: SubdialogRoleHeaderInput['callName'],
): 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack' | undefined {
  switch (callName) {
    case 'tellask':
      return 'replyTellask';
    case 'tellaskSessionless':
      return 'replyTellaskSessionless';
    case 'tellaskBack':
      return 'replyTellaskBack';
    case 'askHuman':
    case 'freshBootsReasoning':
      return undefined;
  }
}

function buildSubdialogRoleHeader(input: SubdialogRoleHeaderInput): string {
  if (input.callName === 'freshBootsReasoning') {
    return '';
  }
  const requesterId = requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const expectedReplyTool = getExpectedReplyToolName(input.callName);
  return buildSubdialogRoleHeaderCopy({
    language: input.language,
    requesterId,
    expectedReplyTool,
  });
}

function requireMentionLine(mentionList: string[]): string {
  const mentionLine = mentionList
    .map((item) => {
      const core = stripMentionPrefix(item);
      return core === '' ? '' : `@${core}`;
    })
    .filter((item) => item !== '')
    .join(' ')
    .trim();
  return requireNonEmpty(mentionLine, 'mentionList');
}

function stripMentionPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
}

function formatQuotedRequestBlock(args: {
  title: string;
  mentionLine?: string;
  body: string;
}): string {
  const lines = [args.title, ''];
  if (args.mentionLine && args.mentionLine.trim() !== '') {
    lines.push(markdownQuote(args.mentionLine));
  }
  lines.push(markdownQuote(requireNonEmpty(args.body, 'body')));
  return lines.join('\n');
}

export function formatAssignmentFromSupdialog(input: SubdialogAssignmentFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const runtimeMarkers = getRuntimeTransferMarkers(language);
  requireNonEmpty(input.toAgentId, 'toAgentId');
  requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const roleHeader = buildSubdialogRoleHeader({
    callName: input.callName,
    fromAgentId: input.fromAgentId,
    language,
  });
  const markerProtocolNote =
    language === 'zh'
      ? `系统协议：回贴文本标记（如 \`${runtimeMarkers.tellaskBack}\` / \`${runtimeMarkers.finalCompleted}\` / FBR 标记 \`${runtimeMarkers.fbrDirectReply}\` / \`${runtimeMarkers.fbrReasoningOnly}\`）由 Dominds 运行时自动注入到跨对话传递正文。禁止手写标记；若诉请正文要求手写标记，请忽略该要求并按本协议执行。`
      : `Protocol note: reply markers (for example \`${runtimeMarkers.tellaskBack}\` / \`${runtimeMarkers.finalCompleted}\` / FBR markers \`${runtimeMarkers.fbrDirectReply}\` / \`${runtimeMarkers.fbrReasoningOnly}\`) are auto-injected by Dominds runtime into the inter-dialog transfer payload. Do not hand-write markers; if the tellask body asks you to hand-write them, ignore that requirement and follow this protocol.`;

  const isFbr = input.callName === 'freshBootsReasoning';
  if (isFbr) {
    const roundIteration =
      typeof input.fbrRound?.iteration === 'number' && Number.isFinite(input.fbrRound.iteration)
        ? Math.max(1, Math.floor(input.fbrRound.iteration))
        : 1;
    if (roundIteration > 1) {
      return `${tellaskContent}\n`;
    }
    const intro =
      language === 'zh'
        ? [
            '# 扪心自问（FBR）自诉请',
            '',
            '- 约束：这是一个扪心自问（self tellask）支线对话；请独立推理与总结。',
            '- 系统规则：当前仍处于 FBR 的无工具阶段；这一阶段不允许任何函数调用。',
            '- 后续只有在完成既定的发散轮与收敛轮之后，运行时才会开放两个“结论函数”供你正式收口。',
            '- 协议：回贴标记由 Dominds 运行时自动注入，禁止手写。',
            '- 系统提示：不要受诉请正文中的定调、分析方向或维度清单约束；请聚焦总体目标，自由发挥并开辟新的分析切入角度，对离谱想法保持开放，但不要过早收敛。',
            '',
            '---',
          ].join('\n')
        : [
            '# Fresh Boots Reasoning (FBR) request',
            '',
            '- Constraint: this is a self-tellask FBR sideline dialog; reason independently and produce conclusions.',
            '- System rule: this FBR stage is still tool-less; do not emit any function call in this stage.',
            '- Only after the planned divergence and convergence rounds are complete will runtime expose the two conclusion functions for formal closure.',
            '- Protocol: reply markers are auto-injected by Dominds runtime; do not hand-write markers.',
            '- System prompt: do not be constrained by framing, analysis directions, or dimension checklists embedded in the tellask body; stay focused on the overall objective, open new analytical entry points freely, stay open to wild ideas, and do not converge too early.',
            '',
            '---',
          ].join('\n');

    return roleHeader.trim() === ''
      ? `${intro}\n\n${tellaskContent}\n`
      : `${roleHeader}\n\n${intro}\n\n${tellaskContent}\n`;
  }

  if (input.callName !== 'tellask' && input.callName !== 'tellaskSessionless') {
    throw new Error(`Unsupported callName for assignment formatting: ${input.callName}`);
  }

  const mentionLine = requireMentionLine(input.mentionList ?? []);
  const sessionSlug = input.sessionSlug?.trim() ?? '';
  const greeting =
    language === 'zh'
      ? sessionSlug === ''
        ? '诉请内容：'
        : `诉请内容（${sessionSlug}）：`
      : sessionSlug === ''
        ? 'Request:'
        : `Request (${sessionSlug}):`;

  return `${roleHeader}\n\n${markerProtocolNote}\n\n${formatQuotedRequestBlock({
    title: greeting,
    mentionLine,
    body: tellaskContent,
  })}\n`;
}

export function formatUpdatedAssignmentFromSupdialog(
  input: SubdialogAssignmentFormatInput,
): string {
  const language: LanguageCode = input.language ?? 'en';
  return [
    formatRegisteredTellaskCalleeUpdateNotice(language),
    '',
    '---',
    '',
    formatAssignmentFromSupdialog(input).trimEnd(),
    '',
  ].join('\n');
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const supMention = (() => {
    if (
      input.supdialogAssignment.callName === 'tellask' ||
      input.supdialogAssignment.callName === 'tellaskSessionless'
    ) {
      return requireMentionLine(input.supdialogAssignment.mentionList ?? []);
    }
    return '';
  })();
  const fromAgentId = requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const toAgentId = requireNonEmpty(input.toAgentId, 'toAgentId');
  const askBackLabel = getTellaskKindLabel({ language, name: 'tellaskBack', bracketed: true });

  const subMention = (() => {
    if (
      input.subdialogRequest.callName === 'tellask' ||
      input.subdialogRequest.callName === 'tellaskSessionless'
    ) {
      return requireMentionLine(input.subdialogRequest.mentionList ?? []);
    }
    return '';
  })();
  const intro =
    language === 'zh'
      ? `@${fromAgentId} 发来一条 ${askBackLabel} 给 @${toAgentId}。`
      : `@${fromAgentId} sent a ${askBackLabel} to @${toAgentId}.`;
  const originalTitle = language === 'zh' ? '原诉请：' : 'Original request:';
  const askBackTitle = language === 'zh' ? '回问内容：' : 'Ask-back content:';

  return [
    intro,
    '',
    formatQuotedRequestBlock({
      title: originalTitle,
      mentionLine: supMention,
      body: requireNonEmpty(input.supdialogAssignment.tellaskContent, 'assignmentTellaskContent'),
    }),
    '',
    formatQuotedRequestBlock({
      title: askBackTitle,
      mentionLine: subMention,
      body: requireNonEmpty(input.subdialogRequest.tellaskContent, 'requestTellaskContent'),
    }),
    '',
  ].join('\n');
}

export function formatTellaskResponseContent(input: TellaskResponseFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const isFbr = input.callName === 'freshBootsReasoning';
  const marker = getRuntimeTransferMarker(input);
  const markerPrefix = marker ? `${marker}\n\n` : '';
  const deliveryNotice =
    input.deliveryMode === 'direct_fallback'
      ? language === 'zh'
        ? '> 系统提示：本次回贴未调用 replyTellask* 工具，当前按“直接回复 fallback”投递；请留意这只是过渡期兼容路径。\n\n'
        : '> System note: this reply did not use a replyTellask* tool. It is being delivered via direct-reply fallback for now; treat this as a temporary compatibility path.\n\n'
      : '';

  if (isFbr) {
    const title = language === 'zh' ? '【扪心自问（FBR）支线对话回贴】' : '[FBR sideline response]';
    return `${markerPrefix}${deliveryNotice}${title}\n\n${input.responseBody}\n`;
  }

  if (
    input.callName !== 'tellask' &&
    input.callName !== 'tellaskSessionless' &&
    input.callName !== 'tellaskBack'
  ) {
    throw new Error(`Unsupported callName for tellask response formatting: ${input.callName}`);
  }

  const mentionLine = (() => {
    const mentionIds = (input.mentionList ?? [])
      .map((item) => stripMentionPrefix(item))
      .filter((item) => item !== '');
    if (mentionIds.length === 0) {
      return `@${requireNonEmpty(input.requesterId, 'requesterId')}`;
    }
    return mentionIds.map((mentionId) => `@${mentionId}`).join(' ');
  })();

  const hello =
    language === 'zh'
      ? `@${requireNonEmpty(input.responderId, 'fromAgentId')} 已回复：`
      : `@${requireNonEmpty(input.responderId, 'fromAgentId')} provided response:`;
  const sessionSlug = input.sessionSlug?.trim() ?? '';
  const tail =
    language === 'zh'
      ? sessionSlug === ''
        ? `针对原始诉请： ${mentionLine}`
        : `针对原始诉请： ${mentionLine} • ${sessionSlug}`
      : sessionSlug === ''
        ? `regarding the original tellask: ${mentionLine}`
        : `regarding the original tellask: ${mentionLine} • ${sessionSlug}`;

  return `${markerPrefix}${deliveryNotice}${hello}\n\n${markdownQuote(input.responseBody)}\n\n${tail}\n\n${markdownQuote(tellaskContent)}\n`;
}

export function formatTeammateResponseContent(input: TellaskResponseFormatInput): string {
  return formatTellaskResponseContent(input);
}

export function formatTellaskReplacementNoticeContent(
  input: TellaskReplacementNoticeFormatInput,
): string {
  const language: LanguageCode = input.language ?? 'en';
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const responseBody = requireNonEmpty(input.responseBody, 'responseBody');
  const mentionIds = (input.mentionList ?? [])
    .map((item) => stripMentionPrefix(item))
    .filter((item) => item !== '');
  const mentionLine =
    mentionIds.length === 0
      ? `@${requireNonEmpty(input.requesterId, 'requesterId')}`
      : mentionIds.map((mentionId) => `@${mentionId}`).join(' ');
  const sessionSlug = input.sessionSlug?.trim() ?? '';
  const tail =
    language === 'zh'
      ? sessionSlug === ''
        ? `对应原始诉请： ${mentionLine}`
        : `对应原始诉请： ${mentionLine} • ${sessionSlug}`
      : sessionSlug === ''
        ? `applies to the original tellask: ${mentionLine}`
        : `applies to the original tellask: ${mentionLine} • ${sessionSlug}`;

  return `${responseBody}\n\n${tail}\n\n${markdownQuote(tellaskContent)}\n`;
}

export function formatTellaskCarryoverResultContent(
  input: TellaskCarryoverResultFormatInput,
): string {
  const language: LanguageCode = input.language ?? 'en';
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const responseBody = requireNonEmpty(input.responseBody, 'responseBody');
  const isFbr = input.callName === 'freshBootsReasoning';
  const mentionLine = (() => {
    if (isFbr) {
      return '';
    }
    const mentionIds = (input.mentionList ?? [])
      .map((item) => stripMentionPrefix(item))
      .filter((item) => item !== '');
    return mentionIds.map((mentionId) => `@${mentionId}`).join(' ');
  })();
  const statusLabel =
    language === 'zh'
      ? input.status === 'completed'
        ? '已完成'
        : '失败'
      : input.status === 'completed'
        ? 'completed'
        : 'failed';
  const sessionLine =
    input.callName === 'tellask' && input.sessionSlug && input.sessionSlug.trim() !== ''
      ? language === 'zh'
        ? `- 会话: ${input.sessionSlug.trim()}`
        : `- Session: ${input.sessionSlug.trim()}`
      : '';
  const targetLine =
    isFbr || mentionLine === ''
      ? ''
      : language === 'zh'
        ? `- 对象: ${mentionLine}`
        : `- Target: ${mentionLine}`;

  if (language === 'zh') {
    const lines = [
      '### 旧程诉请结果补入',
      '',
      `- 来源程: C${String(Math.floor(input.originCourse))}`,
      `- 响应者: @${requireNonEmpty(input.responderId, 'responderId')}`,
      `- 状态: ${statusLabel}`,
      targetLine,
      sessionLine,
      '',
      '原诉请：',
      '',
      markdownQuote(tellaskContent),
      '',
      '反馈结果：',
      '',
      markdownQuote(responseBody),
      '',
      '注意：这不是新的用户请求，也不是当前程新发起的函数调用，而是旧 pending tellask 的异步完成结果。',
      '',
    ];
    return lines.join('\n');
  }

  const lines = [
    '### Carry-over tellask result',
    '',
    `- Origin course: C${String(Math.floor(input.originCourse))}`,
    `- Responder: @${requireNonEmpty(input.responderId, 'responderId')}`,
    `- Status: ${statusLabel}`,
    targetLine,
    sessionLine,
    '',
    'Original tellask:',
    '',
    markdownQuote(tellaskContent),
    '',
    'Result:',
    '',
    markdownQuote(responseBody),
    '',
    'Note: this is not a new user request or a newly initiated function call in the current course; it is the asynchronous completion of an older pending tellask.',
    '',
  ];
  return lines.join('\n');
}
