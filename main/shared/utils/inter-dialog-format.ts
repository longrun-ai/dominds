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

export type InterDialogCallContent = {
  headLine: string;
  body: string;
};

export type InterDialogParticipants = {
  fromAgentId: string;
  toAgentId: string;
};

export type SubdialogAssignmentFormatInput = InterDialogParticipants & InterDialogCallContent;

export type SupdialogCallPromptInput = {
  fromAgentId: string;
  toAgentId: string;
  request: InterDialogCallContent;
  assignment: InterDialogCallContent;
};

export type TeammateResponseFormatInput = {
  responderId: string;
  requesterId: string;
  callHeadLine: string;
  responseBody: string;
};

function requireNonEmpty(value: string, fieldLabel: string): string {
  if (value.trim() === '') {
    throw new Error(`Empty ${fieldLabel} is not allowed for inter-dialog formatting.`);
  }
  return value;
}

export function formatInterDialogCallMarkdown(content: InterDialogCallContent): string {
  const headLine = requireNonEmpty(content.headLine, 'call headLine');
  const body = content.body;
  if (body.trim() === '') {
    return headLine;
  }
  return `${headLine}\n\n${body}`;
}

export function formatInterDialogResponseMarkdown(
  callHeadLine: string,
  responseBody: string,
): string {
  const headLine = requireNonEmpty(callHeadLine, 'call headLine');
  const body = requireNonEmpty(responseBody, 'responseBody');
  return `> ${headLine}\n---\n${body}`;
}

function formatParticipantLine(fromAgentId: string, toAgentId: string): string {
  const from = requireNonEmpty(fromAgentId, 'fromAgentId');
  const to = requireNonEmpty(toAgentId, 'toAgentId');
  return `@${from} -> @${to}`;
}

export function formatSubdialogAssignmentForModel(input: SubdialogAssignmentFormatInput): string {
  const headerLine = formatParticipantLine(input.fromAgentId, input.toAgentId);
  const headLine = requireNonEmpty(input.headLine, 'call headLine');
  const narrative = `Request: @${input.fromAgentId} (requester) asked @${input.toAgentId} (assignee) to handle "${headLine}".`;
  const record = formatInterDialogCallMarkdown({
    headLine: input.headLine,
    body: input.body,
  });
  return `${headerLine}\n${narrative}\n${record}`;
}

export function formatSubdialogUserPrompt(input: SubdialogAssignmentFormatInput): string {
  return formatSubdialogAssignmentForModel(input);
}

export function formatSupdialogCallPrompt(input: SupdialogCallPromptInput): string {
  const headerLine = formatParticipantLine(input.fromAgentId, input.toAgentId);
  const requestHeadLine = requireNonEmpty(input.request.headLine, 'request headLine');
  const assignmentHeadLine = requireNonEmpty(input.assignment.headLine, 'assignment headLine');
  const requestNarrative = `Request: @${input.fromAgentId} (requester) asked @${input.toAgentId} (responder) "${requestHeadLine}".`;
  const assignmentNarrative = `Assignment context: @${input.toAgentId} (requester) previously asked @${input.fromAgentId} (assignee) "${assignmentHeadLine}".`;
  const request = formatInterDialogCallMarkdown(input.request);
  const assignment = formatInterDialogCallMarkdown(input.assignment);
  return `${headerLine}\n${requestNarrative}\n${request}\n---\n${assignmentNarrative}\n${assignment}`;
}

export function formatTeammateResponseNarrative(
  responderId: string,
  requesterId: string,
  callHeadLine: string,
): string {
  const responder = requireNonEmpty(responderId, 'responderId');
  const requester = requireNonEmpty(requesterId, 'requesterId');
  const headLine = requireNonEmpty(callHeadLine, 'call headLine');
  return `Response: @${responder} (responder) replied to @${requester} (requester) about "${headLine}".`;
}

export function formatTeammateResponseContent(input: TeammateResponseFormatInput): string {
  const responderId = requireNonEmpty(input.responderId, 'responderId');
  const requesterId = requireNonEmpty(input.requesterId, 'requesterId');
  const headerLine = `@${responderId}`;
  const narrative = formatTeammateResponseNarrative(responderId, requesterId, input.callHeadLine);
  const record = formatInterDialogResponseMarkdown(input.callHeadLine, input.responseBody);
  return `${headerLine}\n${narrative}\n${record}`;
}
