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
  InterDialogCallContent & { language?: LanguageCode; collectiveTargets?: string[] };

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

function trimTrailingDots(value: string): string {
  let out = value;
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

function requireMentionLine(mentionList: string[]): string {
  const mentionLine = mentionList.join(' ').trim();
  return requireNonEmpty(mentionLine, 'mentionList');
}

export function formatAssignmentFromSupdialog(input: SubdialogAssignmentFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const to = requireNonEmpty(input.toAgentId, 'toAgentId');
  const from = requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const tellaskContent = requireNonEmpty(input.tellaskContent, 'tellaskContent');

  const isFbr = input.callName === 'freshBootsReasoning';
  if (isFbr) {
    const intro =
      language === 'zh'
        ? [
            '# 扪心自问（FBR）自诉请',
            '',
            '- 约束：这是一个 FBR 支线对话；请以“初心视角”独立推理与总结。',
            '- 回问：若当前回合函数工具可用，且你需要澄清关键上下文，可使用 `tellaskBack` 回问上游；否则不要发起任何诉请。',
            '- 重要：不要依赖诉请者对话历史；仅基于诉请正文（以及本支线对话自身的会话历史，如有）。',
            '',
            '---',
          ].join('\n')
        : [
            '# Fresh Boots Reasoning (FBR) request',
            '',
            '- Constraint: this is an FBR sideline dialog; reason independently from a “fresh boots” perspective.',
            '- TellaskBack: if function tools are enabled for this turn and you must clarify critical missing context, use `tellaskBack`; otherwise do not emit tellasks.',
            '- Important: do not rely on the tellasker dialog history; use only the tellask body (and this sideline dialog’s own history, if any).',
            '',
            '---',
          ].join('\n');

    return `${intro}\n\n${tellaskContent}\n`;
  }

  if (input.callName !== 'tellask' && input.callName !== 'tellaskSessionless') {
    throw new Error(`Unsupported callName for assignment formatting: ${input.callName}`);
  }

  const mentionLine = requireMentionLine(input.mentionList ?? []);
  const rawTargets =
    input.collectiveTargets && input.collectiveTargets.length > 0 ? input.collectiveTargets : [to];
  const cleanedTargets = rawTargets.map(trimTrailingDots).filter((t) => t.trim() !== '');
  const uniqueTargets = Array.from(new Set(cleanedTargets));
  if (!uniqueTargets.includes(to)) {
    uniqueTargets.unshift(to);
  }
  const isCollective = uniqueTargets.length >= 2;

  const greeting = (() => {
    if (!isCollective) {
      return language === 'zh'
        ? `你好 @${to}，我是 @${from}, 现在：`
        : `Hi @${to}, this is @${from} speaking, now:`;
    }

    const targetsText = uniqueTargets.map((id) => `@${id}`).join(', ');
    return language === 'zh'
      ? `你好 @${to}，我是 @${from}。这是一项集体诉请（collective assignment），同时发给：${targetsText}。请作为其中一员并行推进，必要时与其他队友对齐：`
      : `Hi @${to}, this is @${from}. This is a collective assignment sent to: ${targetsText}. Please proceed in parallel as one of the assignees and coordinate with other teammates when needed:`;
  })();

  return `${greeting}\n\n${markdownQuote(mentionLine)}\n${markdownQuote(tellaskContent)}\n`;
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const hello =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.toAgentId, 'toAgentId')}，在处理以下任务期间（如下引文）：`
      : `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, while working on the following original task:`;
  const asking =
    language === 'zh'
      ? `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` 回问：`
      : `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` TellaskBack:`;

  const supMention = (() => {
    if (
      input.supdialogAssignment.callName === 'tellask' ||
      input.supdialogAssignment.callName === 'tellaskSessionless'
    ) {
      return markdownQuote(requireMentionLine(input.supdialogAssignment.mentionList ?? []));
    }
    return '';
  })();
  const subMention = (() => {
    if (
      input.subdialogRequest.callName === 'tellask' ||
      input.subdialogRequest.callName === 'tellaskSessionless'
    ) {
      return markdownQuote(requireMentionLine(input.subdialogRequest.mentionList ?? []));
    }
    return '';
  })();

  return `${hello}\n\n${supMention ? `${supMention}\n` : ''}${markdownQuote(requireNonEmpty(input.supdialogAssignment.tellaskContent, 'assignmentTellaskContent'))}\n\n${asking}\n\n${subMention ? `${subMention}\n` : ''}${markdownQuote(requireNonEmpty(input.subdialogRequest.tellaskContent, 'requestTellaskContent'))}\n`;
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

  const mentionLine =
    input.callName === 'tellask' || input.callName === 'tellaskSessionless'
      ? requireMentionLine(input.mentionList ?? [])
      : '';

  const hello =
    language === 'zh'
      ? `@${requireNonEmpty(input.responderId, 'fromAgentId')} 已回复：`
      : `@${requireNonEmpty(input.responderId, 'fromAgentId')} provided response:`;
  const tail = language === 'zh' ? '针对原始诉请：' : 'regarding the original tellask:';

  return `${hello}\n\n${markdownQuote(input.responseBody)}\n\n${tail}\n\n${mentionLine ? `${markdownQuote(mentionLine)}\n` : ''}${markdownQuote(tellaskContent)}\n`;
}
