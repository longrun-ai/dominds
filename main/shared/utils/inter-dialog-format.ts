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

import { markdownQuote } from './fmt';

export type InterDialogCallContent = {
  headLine: string;
  callBody: string;
};

export type InterDialogParticipants = {
  fromAgentId: string;
  toAgentId: string;
};

export type SubdialogAssignmentFormatInput = InterDialogParticipants & InterDialogCallContent;

export type SupdialogCallPromptInput = {
  fromAgentId: string;
  toAgentId: string;
  subdialogRequest: InterDialogCallContent;
  supdialogAssignment: InterDialogCallContent;
};

export type TeammateResponseFormatInput = {
  responderId: string;
  requesterId: string;
  originalCallHeadLine: string;
  responseBody: string;
};

function requireNonEmpty(value: string, fieldLabel: string): string {
  if (value.trim() === '') {
    throw new Error(`Empty ${fieldLabel} is not allowed for inter-dialog formatting.`);
  }
  return value;
}

export function formatAssignmentFromSupdialog(input: SubdialogAssignmentFormatInput): string {
  return `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, @${requireNonEmpty(input.fromAgentId, 'fromAgentId')} is asking you:

${markdownQuote(requireNonEmpty(input.headLine, 'headLine'))}
${markdownQuote(input.callBody)}
`;
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  return `Hi @${requireNonEmpty(input.toAgentId, 'toAgentId')}, during processing your original assignment:

${markdownQuote(requireNonEmpty(input.supdialogAssignment.headLine, 'assignmentHeadLine'))}
${markdownQuote(input.supdialogAssignment.callBody)}

\`@${requireNonEmpty(input.fromAgentId, 'fromAgentId')}\` is asking you:

${markdownQuote(requireNonEmpty(input.subdialogRequest.headLine, 'requestHeadLine'))}
${markdownQuote(input.subdialogRequest.callBody)}
`;
}

export function formatTeammateResponseContent(input: TeammateResponseFormatInput): string {
  return `Hi @${requireNonEmpty(input.requesterId, 'toAgentId')}, @${requireNonEmpty(input.responderId, 'fromAgentId')} provided response:

${markdownQuote(input.responseBody)}

to your original call:

${markdownQuote(requireNonEmpty(input.originalCallHeadLine, 'originalCallHeadLine'))}
`;
}
