import type { ChatMessage } from '../../main/llm/client';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';

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

function isReasoningItem(
  value: unknown,
): value is { type: 'reasoning'; summary: ReadonlyArray<unknown> } {
  return isRecord(value) && value.type === 'reasoning' && Array.isArray(value.summary);
}

function isAssistantMessageItem(
  value: unknown,
): value is { type: 'message'; role: 'assistant'; content: string } {
  return (
    isRecord(value) &&
    value.type === 'message' &&
    value.role === 'assistant' &&
    typeof value.content === 'string'
  );
}

function requireReasoningItem(value: unknown): {
  type: 'reasoning';
  summary: ReadonlyArray<unknown>;
} {
  if (!isReasoningItem(value)) {
    throw new Error('Expected thinking item to map to reasoning');
  }
  return value;
}

function requireAssistantMessageItem(value: unknown): {
  type: 'message';
  role: 'assistant';
  content: string;
} {
  if (!isAssistantMessageItem(value)) {
    throw new Error('Expected assistant item to be message');
  }
  return value;
}

function requireSummaryTextItem(value: unknown): { type: 'summary_text'; text: string } {
  if (!isRecord(value) || value.type !== 'summary_text' || typeof value.text !== 'string') {
    throw new Error('Expected reasoning summary item to be summary_text');
  }
  return value as { type: 'summary_text'; text: string };
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

  const input = await buildOpenAiRequestInputWrapper(context);
  const types = input.map(getItemType);

  assert(
    types.join(',') === 'message,reasoning,message,function_call,function_call_output',
    `Unexpected input item types: ${types.join(',')}`,
  );

  const reasoningItem = requireReasoningItem(input[1]);
  assert(reasoningItem.summary.length === 1, 'Expected one reasoning summary item');
  const summary0 = requireSummaryTextItem(reasoningItem.summary[0]);
  assert(
    summary0.text === 'I should use a tool.',
    'Expected reasoning text to match thinking content',
  );

  const assistantMsg = requireAssistantMessageItem(input[2]);
  assert(
    assistantMsg.content === 'Calling tool now.',
    'Expected assistant content to stay as saying',
  );

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
    await buildOpenAiRequestInputWrapper(orphanedCallContext);
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

  console.log('✓ OpenAI context normalization test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
