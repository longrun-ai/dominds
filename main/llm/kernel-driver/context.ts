import type { ChatMessage } from '../client';

export type DriveBaseContextParts = Readonly<{
  prependedContextMessages: readonly ChatMessage[];
  memories: readonly ChatMessage[];
  taskDocMsg?: ChatMessage;
  coursePrefixMsgs: readonly ChatMessage[];
  historicalDialogMsgsForContext: readonly ChatMessage[];
  currentTurnDialogMsgsForContext: readonly ChatMessage[];
}>;

export type DriveTailContextParts = Readonly<{
  renderedReminders: readonly ChatMessage[];
  activeReplyObligationContext: readonly ChatMessage[];
  runtimeGuideMsgs: readonly ChatMessage[];
}>;

export function assembleDriveContextMessages(args: {
  base: DriveBaseContextParts;
  tail: DriveTailContextParts;
}): ChatMessage[] {
  return [
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
}
