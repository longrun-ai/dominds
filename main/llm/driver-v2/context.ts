import type { ChatMessage } from '../client';

export type DriveBaseContextParts = Readonly<{
  prependedContextMessages: readonly ChatMessage[];
  memories: readonly ChatMessage[];
  taskDocMsg?: ChatMessage;
  coursePrefixMsgs: readonly ChatMessage[];
  dialogMsgsForContext: readonly ChatMessage[];
}>;

export type DriveEphemeralContextParts = Readonly<{
  subdialogResponseContextMsgs?: readonly ChatMessage[];
  internalDrivePromptMsg?: ChatMessage;
}>;

export type DriveTailContextParts = Readonly<{
  renderedReminders: readonly ChatMessage[];
  languageGuideMsg: ChatMessage;
}>;

function findLastUserPromptLikeIndex(msgs: readonly ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (
      msg &&
      (msg.type === 'prompting_msg' || msg.type === 'environment_msg') &&
      msg.role === 'user'
    ) {
      return i;
    }
  }
  return -1;
}

function insertBeforeLastUserPromptLike(
  msgs: readonly ChatMessage[],
  toInsert: readonly ChatMessage[],
): ChatMessage[] {
  if (toInsert.length === 0) return [...msgs];
  const next = [...msgs];
  const insertIndex = findLastUserPromptLikeIndex(next);
  if (insertIndex >= 0) {
    next.splice(insertIndex, 0, ...toInsert);
  } else {
    next.push(...toInsert);
  }
  return next;
}

export function buildDriveBaseContextMessages(parts: DriveBaseContextParts): ChatMessage[] {
  return [
    ...parts.prependedContextMessages,
    ...parts.memories,
    ...(parts.taskDocMsg ? [parts.taskDocMsg] : []),
    ...parts.coursePrefixMsgs,
    ...parts.dialogMsgsForContext,
  ];
}

export function appendDriveEphemeralContext(
  base: readonly ChatMessage[],
  parts: DriveEphemeralContextParts,
): ChatMessage[] {
  const next: ChatMessage[] = [...base];
  if (
    Array.isArray(parts.subdialogResponseContextMsgs) &&
    parts.subdialogResponseContextMsgs.length > 0
  ) {
    next.push(...parts.subdialogResponseContextMsgs);
  }
  if (parts.internalDrivePromptMsg) {
    next.push(parts.internalDrivePromptMsg);
  }
  return next;
}

export function appendDriveTailContext(
  source: readonly ChatMessage[],
  parts: DriveTailContextParts,
): ChatMessage[] {
  const withReminders = insertBeforeLastUserPromptLike(source, parts.renderedReminders);
  return insertBeforeLastUserPromptLike(withReminders, [parts.languageGuideMsg]);
}

export function assembleDriveContextMessages(args: {
  base: DriveBaseContextParts;
  ephemeral: DriveEphemeralContextParts;
  tail: DriveTailContextParts;
}): ChatMessage[] {
  const baseMsgs = buildDriveBaseContextMessages(args.base);
  const withEphemeral = appendDriveEphemeralContext(baseMsgs, args.ephemeral);
  return appendDriveTailContext(withEphemeral, args.tail);
}
