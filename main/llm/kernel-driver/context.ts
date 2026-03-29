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
  runtimeGuideMsgs?: readonly ChatMessage[];
}>;

export type DriveTailContextParts = Readonly<{
  renderedReminders: readonly ChatMessage[];
}>;

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
  if (Array.isArray(parts.runtimeGuideMsgs) && parts.runtimeGuideMsgs.length > 0) {
    next.push(...parts.runtimeGuideMsgs);
  }
  return next;
}

function hasUserPromptLikeAnchor(source: readonly ChatMessage[]): boolean {
  for (const msg of source) {
    if (!msg) continue;
    if (
      (msg.type === 'prompting_msg' ||
        msg.type === 'environment_msg' ||
        msg.type === 'tellask_carryover_result_msg') &&
      msg.role === 'user'
    ) {
      return true;
    }
  }
  return false;
}

export function appendDriveTailContext(
  source: readonly ChatMessage[],
  parts: DriveTailContextParts,
): ChatMessage[] {
  if (hasUserPromptLikeAnchor(source)) {
    return [...source, ...parts.renderedReminders];
  }
  return [...source, ...parts.renderedReminders];
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
