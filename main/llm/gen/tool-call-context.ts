import type { ChatMessage, FuncCallMsg, FuncResultMsg } from '../client';

export function normalizeToolCallPairs(context: readonly ChatMessage[]): ChatMessage[] {
  // Providers differ in how strictly they validate tool call/result ordering. Dominds can
  // temporarily produce a block of calls followed by a block of results when tools run in
  // parallel, so we interleave obvious pairs here before provider projection.
  const out: ChatMessage[] = [];

  let i = 0;
  while (i < context.length) {
    const msg = context[i];
    if (msg.type !== 'func_call_msg') {
      out.push(msg);
      i += 1;
      continue;
    }

    const calls: FuncCallMsg[] = [];
    while (i < context.length && context[i].type === 'func_call_msg') {
      calls.push(context[i] as FuncCallMsg);
      i += 1;
    }

    const results: FuncResultMsg[] = [];
    while (i < context.length && context[i].type === 'func_result_msg') {
      results.push(context[i] as FuncResultMsg);
      i += 1;
    }

    if (results.length === 0) {
      out.push(...calls);
      continue;
    }

    const resultsById = new Map<string, FuncResultMsg[]>();
    for (const result of results) {
      const existing = resultsById.get(result.id);
      if (existing) {
        existing.push(result);
      } else {
        resultsById.set(result.id, [result]);
      }
    }

    const used = new Set<FuncResultMsg>();
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
  return (
    current?.type === 'func_call_msg' && next?.type === 'func_result_msg' && current.id === next.id
  );
}

export function hasAdjacentMatchingToolCall(
  context: readonly ChatMessage[],
  index: number,
): boolean {
  const previous = context[index - 1];
  const current = context[index];
  return (
    previous?.type === 'func_call_msg' &&
    current?.type === 'func_result_msg' &&
    previous.id === current.id
  );
}

export function formatUnresolvedToolCallText(call: FuncCallMsg): string {
  const argumentsText = call.arguments.trim();
  if (argumentsText.length === 0 || argumentsText === '{}') {
    return `[unresolved_tool_call:${call.name}:${call.id}]`;
  }
  return `[unresolved_tool_call:${call.name}:${call.id}] arguments=${argumentsText}`;
}

type ToolCallAdjacencyViolation =
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
    if (msg.type === 'func_call_msg' && !hasAdjacentMatchingToolResult(context, index)) {
      return {
        kind: 'unresolved_call',
        index,
        callId: msg.id,
        toolName: msg.name,
      };
    }
    if (msg.type === 'func_result_msg' && !hasAdjacentMatchingToolCall(context, index)) {
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

export function formatToolCallAdjacencyViolation(
  violation: ToolCallAdjacencyViolation,
  location: string,
): string {
  switch (violation.kind) {
    case 'unresolved_call':
      return (
        `${location}: unresolved persisted func_call_msg detected ` +
        `(callId=${violation.callId}, tool=${violation.toolName}, index=${violation.index}). ` +
        'This means a tool call was persisted without a matching func_result_msg.'
      );
    case 'orphaned_result':
      return (
        `${location}: orphaned persisted func_result_msg detected ` +
        `(callId=${violation.callId}, tool=${violation.toolName}, index=${violation.index}). ` +
        'This means a tool result was restored without the immediately preceding func_call_msg.'
      );
  }
}
