import type { ChatMessage } from '../../main/llm/client';
import { reconstructAnthropicContextWrapper } from '../../main/llm/gen/anthropic';

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

  assert(messages.length === 3, `Expected 3 projected turns, got ${messages.length}`);
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

  const orphanedCallContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 2,
      msgId: 'user-2',
      grammar: 'markdown',
      content: 'Earlier tool call was interrupted.',
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
      content: 'Please continue without that tool result.',
    },
  ];

  let threw = false;
  try {
    reconstructAnthropicContextWrapper(orphanedCallContext);
  } catch (err) {
    threw = true;
    const message = err instanceof Error ? err.message : String(err);
    assert(
      message.includes('unresolved persisted func_call_msg detected'),
      'Expected explicit unresolved func_call invariant error',
    );
    assert(message.includes('callId=call-orphan'), 'Expected callId in invariant error');
  }
  assert(threw, 'Expected orphaned func_call context reconstruction to fail loudly');

  console.log('✓ Anthropic context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
