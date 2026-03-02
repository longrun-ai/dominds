import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

import type { LlmStreamReceiver } from 'dominds/llm/gen';
import { consumeAnthropicStream } from 'dominds/llm/gen/anthropic';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const funcCalls: Array<{ id: string; name: string; args: string }> = [];
  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async () => {},
    sayingFinish: async () => {},
    funcCall: async (callId: string, name: string, args: string) => {
      funcCalls.push({ id: callId, name, args });
    },
    streamError: async () => {},
  };

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;

    // Simulate Anthropic-compatible providers that stream multiple tool_use blocks by index.
    // The wrapper must not collapse these into a single funcCall.
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call-1', name: 'tool_a', input: {} },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call-2', name: 'tool_b', input: {} },
    } as unknown as MessageStreamEvent;

    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"y":2}' },
    } as unknown as MessageStreamEvent;

    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 1 } as unknown as MessageStreamEvent;

    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(events(), receiver);

  assert(funcCalls.length === 2, `Expected 2 func calls, got ${funcCalls.length}`);
  assert(funcCalls[0]?.id === 'call-1', `Expected first call id=call-1, got ${funcCalls[0]?.id}`);
  assert(funcCalls[1]?.id === 'call-2', `Expected second call id=call-2, got ${funcCalls[1]?.id}`);

  const firstArgs = JSON.parse(funcCalls[0]?.args ?? '{}') as unknown;
  const secondArgs = JSON.parse(funcCalls[1]?.args ?? '{}') as unknown;
  assert(
    typeof firstArgs === 'object' &&
      firstArgs !== null &&
      !Array.isArray(firstArgs) &&
      'x' in firstArgs,
    `Expected first call args to include x, got ${funcCalls[0]?.args ?? ''}`,
  );
  assert(
    typeof secondArgs === 'object' &&
      secondArgs !== null &&
      !Array.isArray(secondArgs) &&
      'y' in secondArgs,
    `Expected second call args to include y, got ${funcCalls[1]?.args ?? ''}`,
  );

  console.log('✓ Anthropic multi tool_use streaming test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
