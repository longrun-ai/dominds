/**
 * Inter-dialog formatting module (frontend twin).
 *
 * Naming + storage rules:
 * - "Record"/"_record" is reserved for persisted data records (source of truth).
 * - This module formats display/LLM content from structured fields only.
 * - Do not store formatted text inside persisted records; keep raw fields only.
 *
 * UI display contract:
 * - Display the record data only (mention list + tellask content).
 * - Call display (request/assignment): render mention list, then tellask content.
 * - Response display: render response body first, then original call site summary.
 * - Participant identity (from/to/responder) should live in bubble chrome, not inside content.
 */

import type { LanguageCode } from '../types/language';
import { markdownQuote } from './fmt';

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

export type TeammateResponseFormatInput = {
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  responderId: string;
  requesterId: string;
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  responseBody: string;
  language?: LanguageCode;
};

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

function buildSubdialogRoleHeader(input: SubdialogRoleHeaderInput): string {
  if (input.callName === 'freshBootsReasoning') {
    return '';
  }
  const requesterId = requireNonEmpty(input.fromAgentId, 'fromAgentId');
  return input.language === 'zh'
    ? `你是当前被诉请者对话（tellaskee dialog）的主理人；诉请者对话（tellasker dialog）为 @${requesterId}（当前发起本次诉请）。`
    : `You are the responder (tellaskee dialog) for this dialog; the tellasker dialog is @${requesterId} (the current caller).`;
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

export function formatAssignmentFromSupdialog(input: SubdialogAssignmentFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  requireNonEmpty(input.toAgentId, 'toAgentId');
  requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const roleHeader = buildSubdialogRoleHeader({
    callName: input.callName,
    fromAgentId: input.fromAgentId,
    language,
  });

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
            '- 系统规则：本支线对话为函数禁用模式，不允许任何函数调用（包括 `tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman`）。',
            '- 系统提示：不要受诉请正文中的定调、分析方向或维度清单约束；请聚焦总体目标，自由发挥并开辟新的分析切入角度。',
            '',
            '---',
          ].join('\n')
        : [
            '# Fresh Boots Reasoning (FBR) request',
            '',
            '- Constraint: this is a self-tellask FBR sideline dialog; reason independently and produce conclusions.',
            '- System rule: this sideline runs with function-calls disabled; do not emit any function call (including `tellaskBack` / `tellask` / `tellaskSessionless` / `askHuman`).',
            '- System prompt: do not be constrained by framing, analysis directions, or dimension checklists embedded in the tellask body; stay focused on the overall objective and open new analytical entry points freely.',
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
        ? '现在：'
        : `现在（${sessionSlug}）：`
      : sessionSlug === ''
        ? 'Now:'
        : `Now (${sessionSlug}):`;

  return `${roleHeader}\n\n${greeting}\n\n${markdownQuote(mentionLine)}\n${markdownQuote(tellaskContent)}\n`;
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const supMention = (() => {
    if (
      input.supdialogAssignment.callName === 'tellask' ||
      input.supdialogAssignment.callName === 'tellaskSessionless'
    ) {
      return markdownQuote(requireMentionLine(input.supdialogAssignment.mentionList ?? []));
    }
    return '';
  })();
  const hello =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.toAgentId, 'toAgentId')}，在处理 ${supMention} 以下任务期间（如下引文）：`
      : `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, while working on the following original task of ${supMention} (quoted following):`;
  const asking =
    language === 'zh'
      ? `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` 回问：`
      : `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` TellaskBack:`;

  const subMention = (() => {
    if (
      input.subdialogRequest.callName === 'tellask' ||
      input.subdialogRequest.callName === 'tellaskSessionless'
    ) {
      return markdownQuote(requireMentionLine(input.subdialogRequest.mentionList ?? []));
    }
    return '';
  })();

  return `${hello}\n\n${markdownQuote(requireNonEmpty(input.supdialogAssignment.tellaskContent, 'assignmentTellaskContent'))}\n\n${asking}\n\n${subMention ? `${subMention}\n` : ''}${markdownQuote(requireNonEmpty(input.subdialogRequest.tellaskContent, 'requestTellaskContent'))}\n`;
}

export function formatTeammateResponseContent(input: TeammateResponseFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');
  const isFbr = input.callName === 'freshBootsReasoning';

  if (isFbr) {
    const title = language === 'zh' ? '【扪心自问（FBR）支线对话回贴】' : '[FBR sideline response]';
    return `${title}\n\n${input.responseBody}\n`;
  }

  if (
    input.callName !== 'tellask' &&
    input.callName !== 'tellaskSessionless' &&
    input.callName !== 'tellaskBack'
  ) {
    throw new Error(`Unsupported callName for teammate response formatting: ${input.callName}`);
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

  return `${hello}\n\n${markdownQuote(input.responseBody)}\n\n${tail}\n\n${markdownQuote(tellaskContent)}\n`;
}
