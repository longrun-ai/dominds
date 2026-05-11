import type { ChatMessage } from '../client';

export type DriveBaseContextParts = Readonly<{
  prependedContextMessages: readonly ChatMessage[];
  memories: readonly ChatMessage[];
  taskDocMsg?: ChatMessage;
  coursePrefixMsgs: readonly ChatMessage[];
  historicalDialogMsgsForContext: readonly ChatMessage[];
  currentTurnDialogMsgsForContext: readonly ChatMessage[];
}>;

export type DrivePostTurnContextParts = Readonly<{
  sideDialogResponseContextMsgs?: readonly ChatMessage[];
}>;

export type DriveTailContextParts = Readonly<{
  renderedReminders: readonly ChatMessage[];
  activeReplyObligationContext: readonly ChatMessage[];
  runtimeGuideMsgs: readonly ChatMessage[];
}>;

export function appendDrivePostTurnContext(
  base: readonly ChatMessage[],
  parts: DrivePostTurnContextParts,
): ChatMessage[] {
  const next: ChatMessage[] = [...base];
  if (
    Array.isArray(parts.sideDialogResponseContextMsgs) &&
    parts.sideDialogResponseContextMsgs.length > 0
  ) {
    next.push(...parts.sideDialogResponseContextMsgs);
  }
  return next;
}

export function assembleDriveContextMessages(args: {
  base: DriveBaseContextParts;
  postTurn: DrivePostTurnContextParts;
  tail: DriveTailContextParts;
}): ChatMessage[] {
  const baseMsgs = [
    ...args.base.prependedContextMessages,
    ...args.base.memories,
    ...(args.base.taskDocMsg ? [args.base.taskDocMsg] : []),
    ...args.base.coursePrefixMsgs,
    ...args.base.historicalDialogMsgsForContext,
    ...args.tail.renderedReminders,
    ...args.tail.activeReplyObligationContext,
    ...args.tail.runtimeGuideMsgs,
    ...args.base.currentTurnDialogMsgsForContext,
  ];
  return appendDrivePostTurnContext(baseMsgs, args.postTurn);
}
