import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

import type { LlmStreamReceiver } from 'dominds/llm/gen';
import { consumeAnthropicStream } from 'dominds/llm/gen/anthropic';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const sayingSegments: string[] = [];
  let currentSaying = '';
  let sayingStartCount = 0;
  let sayingFinishCount = 0;

  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {
      sayingStartCount += 1;
      currentSaying = '';
    },
    sayingChunk: async (chunk: string) => {
      currentSaying += chunk;
    },
    sayingFinish: async () => {
      sayingFinishCount += 1;
      sayingSegments.push(currentSaying);
    },
    funcCall: async () => {},
  };

  async function* events(): AsyncIterable<MessageStreamEvent> {
    // Message 1: split text blocks; indentation at the start of later blocks must be preserved.
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;

    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'function foo(\n' },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;

    yield {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '  a: string,\n  b: number,\n)' },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 1 } as unknown as MessageStreamEvent;

    yield { type: 'message_stop' } as unknown as MessageStreamEvent;

    // Message 2: whitespace-only output should still be delivered verbatim.
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '   ' },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(events(), receiver);

  assert(sayingStartCount === 2, `Expected 2 sayingStart, got ${sayingStartCount}`);
  assert(sayingFinishCount === 2, `Expected 2 sayingFinish, got ${sayingFinishCount}`);
  assert(sayingSegments.length === 2, `Expected 2 saying segments, got ${sayingSegments.length}`);

  const expected = 'function foo(\n  a: string,\n  b: number,\n)';
  assert(
    sayingSegments[0] === expected,
    `Expected saying content to preserve indentation. Got:\n${JSON.stringify(sayingSegments[0])}`,
  );
  assert(
    sayingSegments[1] === '   ',
    `Expected whitespace-only output to be preserved. Got:\n${JSON.stringify(sayingSegments[1])}`,
  );

  console.log('✓ Anthropic whitespace test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
