import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import YAML from 'yaml';

import type { ProviderConfig } from '../../main/llm/client';
import { readBuiltinDefaultsYamlRaw } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { AnthropicGen, consumeAnthropicStream } from '../../main/llm/gen/anthropic';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object at ${at}`);
  }
  return value as Record<string, unknown>;
}

function asProviderConfig(value: unknown, at: string): ProviderConfig {
  const record = asRecord(value, at);
  assert(typeof record.name === 'string', `Expected ${at}.name to be a string`);
  assert(
    record.apiType === 'anthropic-compatible',
    `Expected ${at}.apiType to be anthropic-compatible`,
  );
  assert(typeof record.baseUrl === 'string', `Expected ${at}.baseUrl to be a string`);
  assert(typeof record.apiKeyEnvVar === 'string', `Expected ${at}.apiKeyEnvVar to be a string`);
  asRecord(record.models, `${at}.models`);
  return record as ProviderConfig;
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

  const emptyToolCalls: Array<{ id: string; name: string; args: string }> = [];
  const emptyToolReceiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async () => {},
    sayingFinish: async () => {},
    funcCall: async (callId: string, name: string, args: string) => {
      emptyToolCalls.push({ id: callId, name, args });
    },
    streamError: async () => {},
  };

  async function* emptyInputWithMalformedDelta(): AsyncIterable<MessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call-empty', name: 'tool_empty', input: {} },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '}' },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(emptyInputWithMalformedDelta(), emptyToolReceiver);
  assert(emptyToolCalls.length === 1, `Expected 1 empty tool call, got ${emptyToolCalls.length}`);
  assert(
    emptyToolCalls[0]?.args === '}',
    `Expected malformed empty-tool delta to preserve raw arguments for tool feedback, got ${emptyToolCalls[0]?.args ?? ''}`,
  );

  const quirkEmptyToolCalls: Array<{ id: string; name: string; args: string }> = [];
  await consumeAnthropicStream(
    emptyInputWithMalformedDelta(),
    {
      ...emptyToolReceiver,
      funcCall: async (callId: string, name: string, args: string) => {
        quirkEmptyToolCalls.push({ id: callId, name, args });
      },
    },
    undefined,
    undefined,
    { normalizeLoneClosingBraceEmptyToolInputDelta: true },
  );
  assert(
    quirkEmptyToolCalls.length === 1,
    `Expected 1 quirk-normalized empty tool call, got ${quirkEmptyToolCalls.length}`,
  );
  assert(
    quirkEmptyToolCalls[0]?.args === '{}',
    `Expected glm-via-volcano quirk to normalize lone } to {}, got ${quirkEmptyToolCalls[0]?.args ?? ''}`,
  );

  const defaultsRaw = await readBuiltinDefaultsYamlRaw();
  const parsedDefaults = asRecord(YAML.parse(defaultsRaw), 'defaults.yaml');
  const defaultProviders = asRecord(parsedDefaults.providers, 'defaults.yaml.providers');
  const volcanoProvider = asProviderConfig(
    defaultProviders['volcano-engine-coding-plan'],
    'defaults.yaml.providers.volcano-engine-coding-plan',
  );

  async function collectMockedProviderFuncCalls(
    provider: ProviderConfig,
  ): Promise<Array<{ id: string; name: string; args: string }>> {
    const originalFetch = globalThis.fetch;
    const originalArkKey = process.env.ARK_API_KEY;
    const providerFuncCalls: Array<{ id: string; name: string; args: string }> = [];
    try {
      process.env.ARK_API_KEY = 'test-key';
      globalThis.fetch = async (): Promise<Response> =>
        new Response(
          [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0},"content":[]}}',
            '',
            'event: content_block_start',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-provider-quirk","name":"tool_empty","input":{}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}',
            '',
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":0}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );

      await new AnthropicGen('anthropic-compatible').genToReceiver(
        provider,
        { id: 'tester', name: 'tester', model: 'glm-5.1' },
        '',
        [],
        {
          dialogSelfId: 'self',
          dialogRootId: 'root',
          providerKey: 'volcano-engine-coding-plan',
          modelKey: 'glm-5.1',
        },
        [
          {
            type: 'prompting_msg',
            role: 'user',
            genseq: 1,
            msgId: 'user-1',
            grammar: 'markdown',
            content: 'call a tool',
          },
        ],
        {
          ...emptyToolReceiver,
          funcCall: async (callId: string, name: string, args: string) => {
            providerFuncCalls.push({ id: callId, name, args });
          },
        },
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
    return providerFuncCalls;
  }

  const providerFuncCalls = await collectMockedProviderFuncCalls(volcanoProvider);
  assert(
    providerFuncCalls.length === 1,
    `Expected 1 provider-config quirk call, got ${providerFuncCalls.length}`,
  );
  assert(
    providerFuncCalls[0]?.args === '{}',
    `Expected built-in volcano provider to enable glm-via-volcano quirk, got ${providerFuncCalls[0]?.args ?? ''}`,
  );

  const multiQuirkProviderFuncCalls = await collectMockedProviderFuncCalls({
    ...volcanoProvider,
    apiQuirks: ['xcode.best', 'glm-via-volcano'],
  });
  assert(
    multiQuirkProviderFuncCalls.length === 1,
    `Expected 1 multi-quirk provider call, got ${multiQuirkProviderFuncCalls.length}`,
  );
  assert(
    multiQuirkProviderFuncCalls[0]?.args === '{}',
    `Expected apiQuirks array to enable glm-via-volcano alongside other quirks, got ${multiQuirkProviderFuncCalls[0]?.args ?? ''}`,
  );

  console.log('✓ Anthropic multi tool_use streaming test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
