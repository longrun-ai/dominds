import type { ChatMessage } from '../client';

export type DriveBaseContextParts = Readonly<{
  prependedContextMessages: readonly ChatMessage[];
  memories: readonly ChatMessage[];
  taskDocMsg?: ChatMessage;
  coursePrefixMsgs: readonly ChatMessage[];
  dialogMsgsForContext: readonly ChatMessage[];
}>;

export type DriveEphemeralContextParts = Readonly<{
  sideDialogResponseContextMsgs?: readonly ChatMessage[];
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
    Array.isArray(parts.sideDialogResponseContextMsgs) &&
    parts.sideDialogResponseContextMsgs.length > 0
  ) {
    next.push(...parts.sideDialogResponseContextMsgs);
  }
  if (Array.isArray(parts.runtimeGuideMsgs) && parts.runtimeGuideMsgs.length > 0) {
    next.push(...parts.runtimeGuideMsgs);
  }
  return next;
}

export function assembleDriveContextMessages(args: {
  base: DriveBaseContextParts;
  ephemeral: DriveEphemeralContextParts;
  tail: DriveTailContextParts;
}): ChatMessage[] {
  const baseMsgs = [
    ...args.base.prependedContextMessages,
    ...args.base.memories,
    ...(args.base.taskDocMsg ? [args.base.taskDocMsg] : []),
    ...args.base.coursePrefixMsgs,
    ...args.tail.renderedReminders,
    ...args.base.dialogMsgsForContext,
  ];
  return appendDriveEphemeralContext(baseMsgs, args.ephemeral);
}
