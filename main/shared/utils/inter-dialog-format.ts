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
 * - Response display: render the original call headline as a blockquote,
 *   then a horizontal divider (`---`), then the response body.
 * - Participant identity (from/to/responder) should live in bubble chrome, not inside content.
 *
 * LLM context contract:
 * - Use the same markdown record layout as the UI for the record data.
 * - Prepend a short natural-language narrative line that states:
 *   who is in what role (requester/responder/assignee) and what action occurred.
 * - Include the original call headline in the narrative for clarity.
 */

import type { LanguageCode } from '../types/language';
import { markdownQuote } from './fmt';

export type InterDialogCallContent = {
  headLine: string;
  callBody: string;
};

export type InterDialogParticipants = {
  fromAgentId: string;
  toAgentId: string;
};

export type SubdialogAssignmentFormatInput = InterDialogParticipants &
  InterDialogCallContent & { language?: LanguageCode };

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
  const greeting =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.toAgentId, 'toAgentId')}，我是 @${requireNonEmpty(input.fromAgentId, 'fromAgentId')}, 现在：`
      : `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, this is @${requireNonEmpty(input.fromAgentId, 'fromAgentId')} speaking, now:`;

  return `${greeting}

${markdownQuote(requireNonEmpty(input.headLine, 'headLine'))}
${markdownQuote(input.callBody)}
`;
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const hello =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.toAgentId, 'toAgentId')}，在处理你最初诉请期间：`
      : `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, during processing your original assignment:`;
  const asking =
    language === 'zh'
      ? `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` 诉请你：`
      : `\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` is asking you:`;

  return `${hello}

${markdownQuote(requireNonEmpty(input.supdialogAssignment.headLine, 'assignmentHeadLine'))}
${markdownQuote(input.supdialogAssignment.callBody)}

${asking}

${markdownQuote(requireNonEmpty(input.subdialogRequest.headLine, 'requestHeadLine'))}
${markdownQuote(input.subdialogRequest.callBody)}
`;
}

export function formatTeammateResponseContent(input: TeammateResponseFormatInput): string {
  const language: LanguageCode = input.language ?? 'en';
  const hello =
    language === 'zh'
      ? `你好 @${requireNonEmpty(input.requesterId, 'toAgentId')}，@${requireNonEmpty(input.responderId, 'fromAgentId')} 已回复：`
      : `Hi @${requireNonEmpty(input.requesterId, 'toAgentId')}, @${requireNonEmpty(input.responderId, 'fromAgentId')} provided response:`;
  const tail = language === 'zh' ? '针对你最初的诉请：' : 'to your original call:';

  return `${hello}

${markdownQuote(input.responseBody)}

${tail}

${markdownQuote(requireNonEmpty(input.originalCallHeadLine, 'originalCallHeadLine'))}
`;
}
