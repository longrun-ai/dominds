import assert from 'node:assert/strict';

import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

import type { ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { AnthropicGen, consumeAnthropicStream } from '../../main/llm/gen/anthropic';

const MOCK_ANTHROPIC_COMPATIBLE_PROVIDER: ProviderConfig = {
  name: 'Mock Anthropic Compatible',
  apiType: 'anthropic-compatible',
  baseUrl: 'https://example.test/anthropic',
  apiKeyEnvVar: 'ARK_API_KEY',
  models: {
    'glm-5.1': {},
  },
};

function makeReceiver(streamErrors: string[]): LlmStreamReceiver {
  return {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async () => {},
    sayingFinish: async () => {},
    funcCall: async () => {},
    streamError: async (detail: string) => {
      streamErrors.push(detail);
    },
  };
}

async function runMockedAnthropicCompatibleStream(
  response: Response,
  streamErrors: string[],
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalArkKey = process.env.ARK_API_KEY;
  try {
    process.env.ARK_API_KEY = 'test-key';
    globalThis.fetch = async (): Promise<Response> => response;

    await new AnthropicGen('anthropic-compatible').genToReceiver(
      MOCK_ANTHROPIC_COMPATIBLE_PROVIDER,
      { id: 'tester', name: 'tester', model: 'glm-5.1' },
      '',
      [],
      {
        dialogSelfId: 'self',
        dialogRootId: 'root',
        providerKey: 'mock-anthropic-compatible',
        modelKey: 'glm-5.1',
      },
      [
        {
          type: 'prompting_msg',
          role: 'user',
          genseq: 1,
          msgId: 'user-1',
          grammar: 'markdown',
          content: 'hello',
        },
      ],
      makeReceiver(streamErrors),
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalArkKey === undefined) {
      delete process.env.ARK_API_KEY;
    } else {
      process.env.ARK_API_KEY = originalArkKey;
    }
  }
}

async function verifyReadErrorEmitsStreamError(): Promise<void> {
  const streamErrors: string[] = [];

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
    throw new SyntaxError(`Unexpected token '}', "}" is not valid JSON`);
  }

  await assert.rejects(
    async () => consumeAnthropicStream(events(), makeReceiver(streamErrors)),
    /Unexpected token/u,
  );
  assert.equal(streamErrors.length, 1, 'expected read failure to emit one stream_error');
  assert.match(streamErrors[0] ?? '', /ANTH stream read failed: Unexpected token/u);
}

async function verifyIncompleteMessageLifecycleFails(): Promise<void> {
  const streamErrors: string[] = [];

  async function* events(): AsyncIterable<MessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'partial reasoning' },
    } as unknown as MessageStreamEvent;
  }

  await assert.rejects(
    async () => consumeAnthropicStream(events(), makeReceiver(streamErrors)),
    /ANTH incomplete stream/u,
  );
  assert.equal(streamErrors.length, 1, 'expected incomplete stream to emit one stream_error');
  assert.match(streamErrors[0] ?? '', /messageStarted=true/u);
  assert.match(streamErrors[0] ?? '', /messageStopped=false/u);
}

async function verifyRawSseInvalidJsonDataFailsLoudly(): Promise<void> {
  const streamErrors: string[] = [];
  await assert.rejects(
    async () =>
      runMockedAnthropicCompatibleStream(
        new Response(['event: content_block_delta', 'data: }', ''].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
        streamErrors,
      ),
    /Anthropic-compatible SSE data is not valid JSON/u,
  );

  assert.equal(streamErrors.length, 1, 'expected raw SSE parse failure to emit one stream_error');
  assert.match(streamErrors[0] ?? '', /ANTH stream read failed/u);
  assert.match(streamErrors[0] ?? '', /SSE data is not valid JSON/u);
}

async function verifyRawSseWithoutDataFramesFailsLoudly(): Promise<void> {
  const streamErrors: string[] = [];
  await assert.rejects(
    async () =>
      runMockedAnthropicCompatibleStream(
        new Response('{"error":"not actually an SSE stream"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        streamErrors,
      ),
    /without any data frames/u,
  );

  assert.equal(
    streamErrors.length,
    1,
    'expected missing-data-frame failure to emit one stream_error',
  );
  assert.match(streamErrors[0] ?? '', /ANTH stream read failed/u);
  assert.match(streamErrors[0] ?? '', /without any data frames/u);
}

async function verifyInvalidGenseqFailsBeforeStreamRead(): Promise<void> {
  const streamErrors: string[] = [];
  let streamRead = false;

  async function* events(): AsyncIterable<MessageStreamEvent> {
    streamRead = true;
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
  }

  await assert.rejects(
    async () => consumeAnthropicStream(events(), makeReceiver(streamErrors), { genseq: 0 }),
    /Invalid Anthropic stream genseq/u,
  );
  assert.equal(streamRead, false, 'expected invalid genseq to fail before reading provider stream');
  assert.equal(streamErrors.length, 0, 'expected invalid caller genseq to avoid stream_error');
}

async function main(): Promise<void> {
  await verifyReadErrorEmitsStreamError();
  await verifyIncompleteMessageLifecycleFails();
  await verifyRawSseInvalidJsonDataFailsLoudly();
  await verifyRawSseWithoutDataFramesFailsLoudly();
  await verifyInvalidGenseqFailsBeforeStreamRead();
  console.log('provider anthropic-stream-errors: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`provider anthropic-stream-errors: FAIL\n${message}`);
  process.exit(1);
});
