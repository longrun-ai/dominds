/**
 * Inter-dialog formatting module (frontend twin).
 *
 * Naming + storage rules:
 * - "Record"/"_record" is reserved for persisted data records (source of truth).
 * - This module formats display/LLM content from structured fields only.
 * - Do not store formatted text inside persisted records; keep raw fields only.
 *
 * UI display contract:
 * - Display the record data only (headline + body).
 * - Call display (request/assignment): render headline, then body (no quote/divider).
 * - Response display: render the original tellask headline as a blockquote,
 *   then a horizontal divider (`---`), then the response body.
 * - Participant identity (from/to/responder) should live in bubble chrome, not inside content.
 *
 * LLM context contract:
 * - Use the same markdown record layout as the UI for the record data.
 * - Prepend a short natural-language narrative line that states:
 *   who is in what role (requester/responder/assignee) and what action occurred.
 * - Include the original tellask headline in the narrative for clarity.
 */

import type { LanguageCode } from '../types/language';
import { markdownQuote } from './fmt';

export type InterDialogCallContent = {
  tellaskHead: string;
  tellaskBody: string;
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
  responderId: string;
  requesterId: string;
  originalCallHeadLine: string;
  responseBody: string;
  language?: LanguageCode;
};

function requireNonEmpty(value: string, fieldLabel: string): string {
  if (value.trim() === '') {
    throw new Error(`Empty ${fieldLabel} is not allowed for inter-dialog formatting.`);
  }
  return value;
}

export function formatAssignmentFromSupdialog(input: SubdialogAssignmentFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const to = requireNonEmpty(input.toAgentId, 'toAgentId');
  const from = requireNonEmpty(input.fromAgentId, 'fromAgentId');
  const tellaskHead = requireNonEmpty(input.tellaskHead, 'tellaskHead');

  const isFbrSelfTellask = /^\s*@self\b/.test(tellaskHead);
  if (isFbrSelfTellask) {
    const intro =
      language === 'zh'
        ? [
            '# 扪心自问（FBR）自诉请',
            '',
            `- 诉请：\`${tellaskHead}\``,
            '- 约束：这是一个 FBR 支线对话；请以“初心视角”独立推理与总结。',
            '- 回问：仅当你需要澄清关键上下文时，允许 `!?@tellasker` 回问诉请者；除此之外不要发起任何队友诉请。',
            '- 重要：不要依赖诉请者对话历史；仅基于诉请正文（以及本支线对话自身的会话历史，如有）。',
            '',
            '---',
          ].join('\n')
        : [
            '# @self Fresh Boots Reasoning (FBR) request',
            '',
            `- Tellask: \`${tellaskHead}\``,
            '- Constraint: this is an FBR sideline dialog; reason independently from a “fresh boots” perspective.',
            '- TellaskBack: `!?@tellasker` is allowed only when you must clarify critical missing context; otherwise do not emit any tellasks.',
            '- Important: do not rely on the tellasker dialog history; use only the tellask body (and this sideline dialog’s own history, if any).',
            '',
            '---',
          ].join('\n');

    const body = input.tellaskBody ?? '';
    return `${intro}\n\n${body}\n`;
  }

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

  return `${greeting}

${markdownQuote(tellaskHead)}
${markdownQuote(input.tellaskBody)}
`;
}

function trimTrailingDots(value: string): string {
  let out = value;
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
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

  return `${hello}

${markdownQuote(requireNonEmpty(input.supdialogAssignment.tellaskHead, 'assignmentHeadLine'))}

${asking}

${markdownQuote(requireNonEmpty(input.subdialogRequest.tellaskHead, 'requestHeadLine'))}
${markdownQuote(input.subdialogRequest.tellaskBody)}
`;
}

export function formatTeammateResponseContent(input: TeammateResponseFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const originalCallHeadLine = requireNonEmpty(input.originalCallHeadLine, 'originalCallHeadLine');
  const isFbrSelfTellask = /^\s*@self\b/.test(originalCallHeadLine);

  if (isFbrSelfTellask) {
    const title =
      language === 'zh' ? '【扪心自问（FBR）支线对话回贴】' : '[FBR @self sideline response]';
    // Keep response body as plain markdown (no quote) to make it easy to read and integrate.
    return `${title}\n\n${input.responseBody}\n`;
  }

  const hello =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.requesterId, 'toAgentId')}，@${requireNonEmpty(input.responderId, 'fromAgentId')} 已回复：`
      : `Hi @${requireNonEmpty(input.requesterId, 'toAgentId')}, @${requireNonEmpty(input.responderId, 'fromAgentId')} provided response:`;
  const tail = language === 'zh' ? '针对原始诉请：' : 'regarding the original tellask:';

  return `${hello}

${markdownQuote(input.responseBody)}

${tail}

${markdownQuote(originalCallHeadLine)}
`;
}
