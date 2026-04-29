import type { ChatMessage } from '../../main/llm/client';
import {
  reconstructAnthropicContextWrapper,
  reconstructAnthropicContextWrapperAsync,
} from '../../main/llm/gen/anthropic';

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

function findContentBlock(content: unknown, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((block): block is Record<string, unknown> => {
    return isRecord(block) && block.type === type;
  });
}

function findTextBlockText(content: unknown): string | undefined {
  const block = findContentBlock(content, 'text');
  if (block === undefined || typeof block.text !== 'string') return undefined;
  return block.text;
}

function allTextBlockText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
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
  assert(messages[2].role === 'user', 'Expected third message to be user (function result)');

  const assistantTypes = extractBlockTypes(messages[1].content);
  assert(
    assistantTypes.includes('text'),
    'Expected assistant function call history to be projected as text',
  );
  assert(
    findContentBlock(messages[1].content, 'tool_use') === undefined,
    'Expected provider projection to avoid parsing raw arguments into native tool_use input',
  );
  const assistantText = allTextBlockText(messages[1].content);
  assert(
    assistantText.includes('"command":"ls -la"'),
    'Expected assistant function call text to preserve raw arguments',
  );

  const userTypes = extractBlockTypes(messages[2].content);
  assert(userTypes.includes('text'), 'Expected function result history to be projected as text');
  assert(
    findContentBlock(messages[2].content, 'tool_result') === undefined,
    'Expected provider projection to avoid native tool_result replay without native tool_use',
  );

  const malformedToolCallContext: ChatMessage[] = [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 2,
      msgId: 'user-malformed',
      grammar: 'markdown',
      content: 'Call a tool with malformed arguments.',
    },
    {
      type: 'func_call_msg',
      role: 'assistant',
      genseq: 2,
      id: 'call-malformed',
      name: 'shell_cmd',
      arguments: '{"command":',
    },
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 2,
      id: 'call-malformed',
      name: 'shell_cmd',
      content: 'Invalid arguments: Arguments must be valid JSON: Unexpected end of JSON input',
    },
  ];

  const malformedMessages = await reconstructAnthropicContextWrapperAsync(malformedToolCallContext);
  assert(
    malformedMessages.length === 3,
    `Expected malformed call context to project 3 turns, got ${malformedMessages.length}`,
  );
  assert(
    malformedMessages[1].role === 'assistant',
    'Expected malformed call correction context to remain assistant-authored',
  );
  const malformedCallText = findTextBlockText(malformedMessages[1].content);
  assert(
    malformedCallText !== undefined && malformedCallText.includes('{"command":'),
    'Expected malformed call correction context to preserve raw arguments verbatim',
  );
  assert(
    findContentBlock(malformedMessages[1].content, 'tool_use') === undefined,
    'Expected malformed call to avoid native tool_use projection',
  );
  assert(
    malformedMessages[2].role === 'user',
    'Expected malformed call failure result to be projected as user context',
  );
  const malformedResultText = findTextBlockText(malformedMessages[2].content);
  assert(
    malformedResultText !== undefined && malformedResultText.includes('Invalid arguments:'),
    'Expected malformed call failure result to be visible to the next model round',
  );
  assert(
    findContentBlock(malformedMessages[2].content, 'tool_result') === undefined,
    'Expected malformed call failure to avoid native tool_result projection',
  );

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
      message.includes('unresolved persisted tool call message detected'),
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
