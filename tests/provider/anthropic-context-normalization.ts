import type { ChatMessage } from 'dominds/llm/client';
import { reconstructAnthropicContextWrapper } from 'dominds/llm/gen/anthropic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function extractBlockTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => (isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown'))
    .filter((t) => t.length > 0);
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

  const messages = reconstructAnthropicContextWrapper(context);

  // Anthropic-compatible endpoints often require strict role alternation.
  for (let i = 1; i < messages.length; i++) {
    assert(messages[i - 1].role !== messages[i].role, 'Found consecutive messages with same role');
  }

  assert(messages.length === 3, `Expected 3 merged messages, got ${messages.length}`);
  assert(messages[0].role === 'user', 'Expected first message to be user');
  assert(messages[1].role === 'assistant', 'Expected second message to be assistant');
  assert(messages[2].role === 'user', 'Expected third message to be user (tool_result)');

  const assistantTypes = extractBlockTypes(messages[1].content);
  assert(
    assistantTypes.includes('tool_use'),
    'Expected assistant message to include tool_use block',
  );

  const userTypes = extractBlockTypes(messages[2].content);
  assert(userTypes.includes('tool_result'), 'Expected user message to include tool_result block');

  console.log('✓ Anthropic context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
