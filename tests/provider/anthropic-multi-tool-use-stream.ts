import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import nativeAssert from 'node:assert/strict';

import type { LlmStreamReceiver } from '../../main/llm/gen';
import { consumeAnthropicStream } from '../../main/llm/gen/anthropic';
import { anthropicMessageStart } from '../helpers/anthropic-stream';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type CapturedFuncCall = Readonly<{ id: string; name: string; args: string }>;

function createReceiver(args: {
  funcCalls: CapturedFuncCall[];
  sayingChunks?: string[];
  thinkingChunks?: string[];
}): LlmStreamReceiver {
  return {
    thinkingStart: async () => {},
    thinkingChunk: async (chunk: string) => {
      nativeAssert.ok(args.thinkingChunks, 'Unexpected thinking output');
      args.thinkingChunks.push(chunk);
    },
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk: string) => {
      nativeAssert.ok(args.sayingChunks, 'Unexpected saying output');
      args.sayingChunks.push(chunk);
    },
    sayingFinish: async () => {},
    funcCall: async (callId: string, name: string, callArgs: string) => {
      args.funcCalls.push({ id: callId, name, args: callArgs });
    },
    streamError: async (detail) => {
      throw new Error(detail);
    },
  };
}

async function testMultipleToolUseBlocks(): Promise<void> {
  const funcCalls: CapturedFuncCall[] = [];

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield anthropicMessageStart();
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        caller: { type: 'direct' },
        id: 'call-1',
        name: 'tool_a',
        input: {},
      },
    };
    yield {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        caller: { type: 'direct' },
        id: 'call-2',
        name: 'tool_b',
        input: {},
      },
    };
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
    };
    yield {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"y":2}' },
    };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'content_block_stop', index: 1 };
    yield { type: 'message_stop' };
  }

  await consumeAnthropicStream(events(), createReceiver({ funcCalls }));

  nativeAssert.deepEqual(funcCalls, [
    { id: 'call-1', name: 'tool_a', args: '{"x":1}' },
    { id: 'call-2', name: 'tool_b', args: '{"y":2}' },
  ]);
}

async function testMalformedToolInputIsPreserved(): Promise<void> {
  const funcCalls: CapturedFuncCall[] = [];

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield anthropicMessageStart();
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        caller: { type: 'direct' },
        id: 'call-empty',
        name: 'tool_empty',
        input: {},
      },
    };
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '}' },
    };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }

  await consumeAnthropicStream(events(), createReceiver({ funcCalls }));

  assert(funcCalls.length === 1, `Expected 1 empty tool call, got ${funcCalls.length}`);
  assert(
    funcCalls[0]?.args === '}',
    `Expected malformed tool delta to remain raw for tool feedback, got ${funcCalls[0]?.args ?? ''}`,
  );
}

async function testTextRenderedToolMetadataRemainsText(): Promise<void> {
  const funcCalls: CapturedFuncCall[] = [];
  const sayingChunks: string[] = [];
  const text = [
    'Function call emitted by the assistant.',
    'Tool name: read_file',
    'Call ID: call_text_tool',
    'Raw arguments, verbatim:',
    '<raw_arguments>{"path":"a.md"}</raw_arguments>',
  ].join('\n');

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield anthropicMessageStart();
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    };
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }

  await consumeAnthropicStream(events(), createReceiver({ funcCalls, sayingChunks }));

  assert(
    funcCalls.length === 0,
    `Expected no text-rendered tool conversion, got ${funcCalls.length}`,
  );
  assert(
    sayingChunks.join('') === text,
    `Expected text-rendered tool metadata to remain saying text, got ${JSON.stringify(sayingChunks.join(''))}`,
  );
}

async function main(): Promise<void> {
  await testMultipleToolUseBlocks();
  await testMalformedToolInputIsPreserved();
  await testTextRenderedToolMetadataRemainsText();
  console.log('✓ Anthropic multi tool_use streaming test passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
