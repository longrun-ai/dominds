import type { ChatMessage, FuncCallMsg, FuncResultMsg } from '../client';

type ToolCallMsg = FuncCallMsg;
type ToolResultMsg = FuncResultMsg;

function isToolCallMsg(msg: ChatMessage | undefined): msg is ToolCallMsg {
  return msg?.type === 'func_call_msg';
}

function isToolResultMsg(msg: ChatMessage | undefined): msg is ToolResultMsg {
  return msg?.type === 'func_result_msg';
}

export function normalizeToolCallPairs(context: readonly ChatMessage[]): ChatMessage[] {
  // Providers differ in how strictly they validate tool call/result ordering. Dominds can
  // temporarily produce a block of calls followed by a block of results when tools run in
  // parallel, so we interleave obvious pairs here before provider projection.
  const out: ChatMessage[] = [];

  let i = 0;
  while (i < context.length) {
    const msg = context[i];
    if (!isToolCallMsg(msg)) {
      out.push(msg);
      i += 1;
      continue;
    }

    const calls: ToolCallMsg[] = [];
    while (i < context.length && isToolCallMsg(context[i])) {
      calls.push(context[i] as ToolCallMsg);
      i += 1;
    }

    const results: ToolResultMsg[] = [];
    while (i < context.length && isToolResultMsg(context[i])) {
      results.push(context[i] as ToolResultMsg);
      i += 1;
    }

    if (results.length === 0) {
      out.push(...calls);
      continue;
    }

    const resultsById = new Map<string, ToolResultMsg[]>();
    for (const result of results) {
      const existing = resultsById.get(result.id);
      if (existing) {
        existing.push(result);
      } else {
        resultsById.set(result.id, [result]);
      }
    }

    const used = new Set<ToolResultMsg>();
    for (const call of calls) {
      out.push(call);
      const queue = resultsById.get(call.id);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (next) {
          out.push(next);
          used.add(next);
        }
      }
    }

    for (const result of results) {
      if (!used.has(result)) {
        out.push(result);
      }
    }
  }

  return out;
}

export function hasAdjacentMatchingToolResult(
  context: readonly ChatMessage[],
  index: number,
): boolean {
  const current = context[index];
  const next = context[index + 1];
  return isToolCallMsg(current) && isToolResultMsg(next) && current.id === next.id;
}

export function hasAdjacentMatchingToolCall(
  context: readonly ChatMessage[],
  index: number,
): boolean {
  const previous = context[index - 1];
  const current = context[index];
  return isToolCallMsg(previous) && isToolResultMsg(current) && previous.id === current.id;
}

export function formatUnresolvedToolCallText(call: ToolCallMsg): string {
  const argumentsText = call.arguments.trim();
  if (argumentsText.length === 0 || argumentsText === '{}') {
    return `[unresolved_tool_call:${call.name}:${call.id}]`;
  }
  return `[unresolved_tool_call:${call.name}:${call.id}] arguments=${argumentsText}`;
}

export type ToolCallAdjacencyViolation =
  | Readonly<{
      kind: 'unresolved_call';
      index: number;
      callId: string;
      toolName: string;
    }>
  | Readonly<{
      kind: 'orphaned_result';
      index: number;
      callId: string;
      toolName: string;
    }>;

export function findFirstToolCallAdjacencyViolation(
  context: readonly ChatMessage[],
): ToolCallAdjacencyViolation | null {
  for (let index = 0; index < context.length; index += 1) {
    const msg = context[index];
    if (isToolCallMsg(msg) && !hasAdjacentMatchingToolResult(context, index)) {
      return {
        kind: 'unresolved_call',
        index,
        callId: msg.id,
        toolName: msg.name,
      };
    }
    if (isToolResultMsg(msg) && !hasAdjacentMatchingToolCall(context, index)) {
      return {
        kind: 'orphaned_result',
        index,
        callId: msg.id,
        toolName: msg.name,
      };
    }
  }
  return null;
}

export function sanitizeToolContextForProvider(context: readonly ChatMessage[]): Readonly<{
  messages: ChatMessage[];
  droppedViolations: ToolCallAdjacencyViolation[];
}> {
  const normalized = normalizeToolCallPairs(context);
  const sanitized: ChatMessage[] = [];
  const droppedViolations: ToolCallAdjacencyViolation[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const msg = normalized[index];
    if (isToolCallMsg(msg)) {
      const next = normalized[index + 1];
      if (isToolResultMsg(next) && next.id === msg.id) {
        sanitized.push(msg, next);
        index += 1;
        continue;
      }
      droppedViolations.push({
        kind: 'unresolved_call',
        index,
        callId: msg.id,
        toolName: msg.name,
      });
      continue;
    }

    if (isToolResultMsg(msg)) {
      droppedViolations.push({
        kind: 'orphaned_result',
        index,
        callId: msg.id,
        toolName: msg.name,
      });
      continue;
    }

    sanitized.push(msg);
  }

  return {
    messages: sanitized,
    droppedViolations,
  };
}

export function formatToolCallAdjacencyViolation(
  violation: ToolCallAdjacencyViolation,
  location: string,
): string {
  switch (violation.kind) {
    case 'unresolved_call':
      return (
        `${location}: unresolved persisted tool call message detected ` +
        `(callId=${violation.callId}, tool=${violation.toolName}, index=${violation.index}). ` +
        'This means a tool call was persisted without a matching tool result message.'
      );
    case 'orphaned_result':
      return (
        `${location}: orphaned persisted tool result message detected ` +
        `(callId=${violation.callId}, tool=${violation.toolName}, index=${violation.index}). ` +
        'This means a tool result was restored without the immediately preceding tool call message.'
      );
  }
}
