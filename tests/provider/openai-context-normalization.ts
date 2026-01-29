import type { ChatMessage } from 'dominds/llm/client';
import { buildOpenAiRequestInputWrapper } from 'dominds/llm/gen/openai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function getItemType(value: unknown): string {
  if (!isRecord(value)) return 'unknown';
  const t = value.type;
  return typeof t === 'string' ? t : 'unknown';
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

  const input = buildOpenAiRequestInputWrapper(context);
  const types = input.map(getItemType);

  assert(
    types.join(',') === 'message,message,function_call,function_call_output',
    `Unexpected input item types: ${types.join(',')}`,
  );

  const assistantMsg = input[1];
  assert(isRecord(assistantMsg), 'Expected assistant message to be an object');
  assert(assistantMsg.type === 'message', 'Expected assistant item to be message');
  assert(assistantMsg.role === 'assistant', 'Expected assistant message role to be assistant');
  assert(typeof assistantMsg.content === 'string', 'Expected assistant content to be string');
  assert(
    assistantMsg.content.includes('I should use a tool.') &&
      assistantMsg.content.includes('Calling tool now.'),
    'Expected adjacent assistant messages to be merged',
  );

  console.log('✓ OpenAI context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
