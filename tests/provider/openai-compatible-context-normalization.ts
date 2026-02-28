import type { ChatMessage } from 'dominds/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from 'dominds/llm/gen/openai-compatible';

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

  const assistantMsg = messages[1];
  assert(isRecord(assistantMsg), 'Expected assistant message to be an object');
  assert(assistantMsg.role === 'assistant', 'Expected assistant message role to be assistant');
  assert(typeof assistantMsg.content === 'string', 'Expected assistant content to be string');
  assert(
    assistantMsg.content === 'Calling tool now.',
    'Expected saying content to remain standalone',
  );
  assert(
    typeof assistantMsg.reasoning_content === 'string' &&
      assistantMsg.reasoning_content === 'I should use a tool.',
    'Expected thinking content to map to assistant.reasoning_content',
  );

  const toolCallMsg = messages[2];
  assert(isRecord(toolCallMsg), 'Expected tool call message to be an object');
  assert(toolCallMsg.role === 'assistant', 'Expected tool call message role to be assistant');
  assert(Array.isArray(toolCallMsg.tool_calls), 'Expected tool_calls to be an array');
  assert(toolCallMsg.tool_calls.length === 1, 'Expected exactly one tool call');
  const call = toolCallMsg.tool_calls[0];
  assert(isRecord(call), 'Expected tool call to be an object');
  assert(call.id === 'call-1', 'Expected tool call id to match');
  assert(call.type === 'function', 'Expected tool call type to be function');
  assert(isRecord(call.function), 'Expected tool call function to be an object');
  assert(call.function.name === 'shell_cmd', 'Expected function name to match');
  assert(typeof call.function.arguments === 'string', 'Expected function arguments to be string');

  const toolMsg = messages[3];
  assert(isRecord(toolMsg), 'Expected tool message to be an object');
  assert(toolMsg.role === 'tool', 'Expected tool message role to be tool');
  assert(toolMsg.tool_call_id === 'call-1', 'Expected tool_call_id to match call id');

  console.log('✓ OpenAI-compatible context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
