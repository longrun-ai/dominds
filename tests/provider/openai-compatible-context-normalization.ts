import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function getRole(value: unknown): string {
  if (!isRecord(value)) return 'unknown';
  const role = value.role;
  return typeof role === 'string' ? role : 'unknown';
}

function isAssistantReasoningMessage(
  value: unknown,
): value is { role: 'assistant'; content: string; reasoning_content: string } {
  return (
    isRecord(value) &&
    value.role === 'assistant' &&
    typeof value.content === 'string' &&
    typeof value.reasoning_content === 'string'
  );
}

function isAssistantToolCallMessage(value: unknown): value is {
  role: 'assistant';
  tool_calls: ReadonlyArray<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
} {
  if (!isRecord(value) || value.role !== 'assistant' || !Array.isArray(value.tool_calls)) {
    return false;
  }
  return value.tool_calls.every((call) => {
    return (
      isRecord(call) &&
      typeof call.id === 'string' &&
      typeof call.type === 'string' &&
      isRecord(call.function) &&
      typeof call.function.name === 'string' &&
      typeof call.function.arguments === 'string'
    );
  });
}

function isToolMessage(value: unknown): value is { role: 'tool'; tool_call_id: string } {
  return isRecord(value) && value.role === 'tool' && typeof value.tool_call_id === 'string';
}

function requireAssistantReasoningMessage(value: unknown): {
  role: 'assistant';
  content: string;
  reasoning_content: string;
} {
  if (!isAssistantReasoningMessage(value)) {
    throw new Error('Expected assistant message to be an object');
  }
  return value;
}

function requireAssistantToolCallMessage(value: unknown): {
  role: 'assistant';
  tool_calls: ReadonlyArray<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
} {
  if (!isAssistantToolCallMessage(value)) {
    throw new Error('Expected tool call message to be an object');
  }
  return value;
}

function requireToolMessage(value: unknown): { role: 'tool'; tool_call_id: string } {
  if (!isToolMessage(value)) {
    throw new Error('Expected tool message to be an object');
  }
  return value;
}

async function main() {
  const context: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'user-1',
      grammar: 'markdown',
      content: 'Run `ls -la` via tool.',
    },
    {
      type: 'thinking_msg',
      role: 'assistant',
      genseq: 1,
      content: 'I should use a tool.',
    },
    {
      type: 'saying_msg',
      role: 'assistant',
      genseq: 1,
      content: 'Calling tool now.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 1,
      id: 'call-1',
      name: 'shell_cmd',
      arguments: JSON.stringify({ command: 'ls -la' }),
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 1,
      id: 'call-1',
      name: 'shell_cmd',
      content: 'ok',
    },
  ];

  const messages = await buildOpenAiCompatibleRequestMessagesWrapper('', context, {
    reasoningContentMode: true,
  });
  const roles = messages.map(getRole);

  assert(
    roles.join(',') === 'user,assistant,assistant,tool',
    `Unexpected roles: ${roles.join(',')}`,
  );

  const assistantMsg = requireAssistantReasoningMessage(messages[1]);
  assert(
    assistantMsg.content === 'Calling tool now.',
    'Expected saying content to remain standalone',
  );
  assert(
    typeof assistantMsg.reasoning_content === 'string' &&
      assistantMsg.reasoning_content === 'I should use a tool.',
    'Expected thinking content to map to assistant.reasoning_content',
  );

  const toolCallMsg = requireAssistantToolCallMessage(messages[2]);
  assert(toolCallMsg.tool_calls.length === 1, 'Expected exactly one tool call');
  const call = toolCallMsg.tool_calls[0];
  assert(isRecord(call), 'Expected tool call to be an object');
  assert(call.id === 'call-1', 'Expected tool call id to match');
  assert(call.type === 'function', 'Expected tool call type to be function');
  assert(isRecord(call.function), 'Expected tool call function to be an object');
  assert(call.function.name === 'shell_cmd', 'Expected function name to match');
  assert(typeof call.function.arguments === 'string', 'Expected function arguments to be string');

  const toolMsg = requireToolMessage(messages[3]);
  assert(toolMsg.tool_call_id === 'call-1', 'Expected tool_call_id to match call id');

  const orphanedCallContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 2,
      msgId: 'user-2',
      grammar: 'markdown',
      content: 'Tool call was interrupted.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 2,
      id: 'call-orphan',
      name: 'shell_cmd',
      arguments: JSON.stringify({ command: 'cat missing.txt' }),
    },
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 3,
      msgId: 'user-3',
      grammar: 'markdown',
      content: 'Continue normally.',
    },
  ];

  let threw = false;
  try {
    await buildOpenAiCompatibleRequestMessagesWrapper('', orphanedCallContext, {
      reasoningContentMode: true,
    });
  } catch (err) {
    threw = true;
    const message = err instanceof Error ? err.message : String(err);
    assert(
      message.includes('unresolved persisted func_call_msg detected'),
      'Expected explicit unresolved func_call invariant error',
    );
    assert(message.includes('callId=call-orphan'), 'Expected callId in invariant error');
  }
  assert(threw, 'Expected orphaned func_call provider projection to fail loudly');

  console.log('✓ OpenAI-compatible context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
