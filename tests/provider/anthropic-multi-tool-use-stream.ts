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
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: true,
        convertVolcanoTextToolUseBlocks: false,
      },
    },
  );
  assert(
    quirkEmptyToolCalls.length === 1,
    `Expected 1 quirk-normalized empty tool call, got ${quirkEmptyToolCalls.length}`,
  );
  assert(
    quirkEmptyToolCalls[0]?.args === '{}',
    `Expected glm-via-volcano quirk to normalize lone } to {}, got ${quirkEmptyToolCalls[0]?.args ?? ''}`,
  );

  const textToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  const textToolUseWords: string[] = [];
  async function* textRenderedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: '我们看到有一个候选 conversation id。Function call emitted by the assistant.\nTool name: read_current_open_conversation_latest_result\n',
      },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'Call ID: call_94335603-9c44-44b4-a09e-4a4870da27d7\nRaw arguments, verbatim:\n<raw_arguments>\n{"expectedConversationId":"69e093e8-76b8-839a-9378-b65b801038b9","evidenceMaxItems":10}\n</raw_arguments>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    textRenderedToolUseEvents(),
    {
      ...emptyToolReceiver,
      sayingChunk: async (chunk: string) => {
        textToolUseWords.push(chunk);
      },
      funcCall: async (callId: string, name: string, args: string) => {
        textToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
    },
  );
  assert(
    textToolUseCalls.length === 1,
    `Expected 1 text-rendered tool call, got ${textToolUseCalls.length}`,
  );
  assert(
    textToolUseCalls[0]?.id === 'call_94335603-9c44-44b4-a09e-4a4870da27d7',
    `Expected converted call id, got ${textToolUseCalls[0]?.id ?? ''}`,
  );
  assert(
    textToolUseCalls[0]?.name === 'read_current_open_conversation_latest_result',
    `Expected converted tool name, got ${textToolUseCalls[0]?.name ?? ''}`,
  );
  assert(
    textToolUseCalls[0]?.args ===
      '{"expectedConversationId":"69e093e8-76b8-839a-9378-b65b801038b9","evidenceMaxItems":10}',
    `Expected converted raw args, got ${textToolUseCalls[0]?.args ?? ''}`,
  );
  assert(
    textToolUseWords.join('') === '我们看到有一个候选 conversation id。',
    `Expected only prose before text-rendered tool call to be emitted as saying, got ${JSON.stringify(textToolUseWords.join(''))}`,
  );

  const malformedTextToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  const malformedTextToolUseWords: string[] = [];
  async function* malformedTextRenderedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: 'Function call emitted by the assistant.\nTool name: read_current_open_conversation_latest_result\nCall ID: call_malformed_text_tool\nRaw arguments, verbatim:\n<raw_arguments>not-json</raw_arguments>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    malformedTextRenderedToolUseEvents(),
    {
      ...emptyToolReceiver,
      sayingChunk: async (chunk: string) => {
        malformedTextToolUseWords.push(chunk);
      },
      funcCall: async (callId: string, name: string, args: string) => {
        malformedTextToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
    },
  );
  assert(
    malformedTextToolUseCalls.length === 1,
    `Expected paired raw_arguments metadata to become a tool call even with malformed args, got ${malformedTextToolUseCalls.length} calls`,
  );
  assert(
    malformedTextToolUseCalls[0]?.args === 'not-json',
    `Expected malformed raw arguments to flow to normal tool-argument validation, got ${malformedTextToolUseCalls[0]?.args ?? ''}`,
  );
  assert(
    malformedTextToolUseWords.join('') === '',
    `Expected malformed text-rendered tool metadata itself not to be emitted as saying, got ${JSON.stringify(malformedTextToolUseWords.join(''))}`,
  );

  const messageStopFlushToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  async function* textRenderedToolUseWithoutBlockStopEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: 'Function call emitted by the assistant.\nTool name: read_current_open_conversation_latest_result\nCall ID: call_message_stop_flush\nRaw arguments, verbatim:\n<raw_arguments>{}</raw_arguments>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    textRenderedToolUseWithoutBlockStopEvents(),
    {
      ...emptyToolReceiver,
      funcCall: async (callId: string, name: string, args: string) => {
        messageStopFlushToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
    },
  );
  assert(
    messageStopFlushToolUseCalls.length === 1,
    `Expected message_stop to flush pending text-rendered tool call, got ${messageStopFlushToolUseCalls.length}`,
  );
  assert(
    messageStopFlushToolUseCalls[0]?.id === 'call_message_stop_flush',
    `Expected message_stop flushed call id, got ${messageStopFlushToolUseCalls[0]?.id ?? ''}`,
  );

  const textAroundToolUseEventsSeen: string[] = [];
  async function* textAroundToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: 'before Function call emitted by the assistant.\nTool name: read_current_open_conversation_latest_result\nCall ID: call_text_around\nRaw arguments, verbatim:\n<raw_arguments>{}</raw_arguments> after',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    textAroundToolUseEvents(),
    {
      ...emptyToolReceiver,
      sayingStart: async () => {
        textAroundToolUseEventsSeen.push('sayingStart');
      },
      sayingChunk: async (chunk: string) => {
        textAroundToolUseEventsSeen.push(`saying:${chunk}`);
      },
      sayingFinish: async () => {
        textAroundToolUseEventsSeen.push('sayingFinish');
      },
      funcCall: async (callId: string, name: string, args: string) => {
        textAroundToolUseEventsSeen.push(`func:${callId}:${name}:${args}`);
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
    },
  );
  assert(
    textAroundToolUseEventsSeen.join('|') ===
      'sayingStart|saying:before |sayingFinish|func:call_text_around:read_current_open_conversation_latest_result:{}|sayingStart|saying: after|sayingFinish',
    `Expected text/tool/text order to be preserved, got ${JSON.stringify(textAroundToolUseEventsSeen)}`,
  );

  const seedToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  const seedToolUseWords: string[] = [];
  async function* seedRenderedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text:
          '看起来行号范围有问题。让我直接在文件末尾添加新的测试记录。\n' +
          '<seed:tool_call><function name="prepare_file_append"><parameter name="path" string="true">chatgpt工具实操测试报告.md</parameter><parameter name="content" string="true">\n\n---\n\n### 测试工具 10: set_instance_window_max_parallel\n\n</parameter></function></seed:tool_call>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    seedRenderedToolUseEvents(),
    {
      ...emptyToolReceiver,
      sayingChunk: async (chunk: string) => {
        seedToolUseWords.push(chunk);
      },
      funcCall: async (callId: string, name: string, args: string) => {
        seedToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 183,
    },
  );
  assert(
    seedToolUseCalls.length === 1,
    `Expected 1 seed-rendered tool call, got ${seedToolUseCalls.length}`,
  );
  assert(
    seedToolUseCalls[0]?.id.startsWith('call_volcano_seed_g183_') === true,
    `Expected generated volcano seed call id with genseq, got ${seedToolUseCalls[0]?.id ?? ''}`,
  );
  assert(
    seedToolUseCalls[0]?.name === 'prepare_file_append',
    `Expected seed tool name, got ${seedToolUseCalls[0]?.name ?? ''}`,
  );
  assert(
    seedToolUseCalls[0]?.args ===
      '{"path":"chatgpt工具实操测试报告.md","content":"\\n\\n---\\n\\n### 测试工具 10: set_instance_window_max_parallel\\n\\n"}',
    `Expected seed tool args JSON, got ${seedToolUseCalls[0]?.args ?? ''}`,
  );
  assert(
    seedToolUseWords.join('') === '看起来行号范围有问题。让我直接在文件末尾添加新的测试记录。\n',
    `Expected seed metadata itself not to be emitted as saying, got ${JSON.stringify(seedToolUseWords.join(''))}`,
  );

  const seedTypedToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  async function* seedTypedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: '<seed:tool_call><function name="read_file"><parameter name="path" string="true">notes.md</parameter><parameter name="show_linenos" string="false">true</parameter><parameter name="max_lines" string="false">271</parameter></function></seed:tool_call>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    seedTypedToolUseEvents(),
    {
      ...emptyToolReceiver,
      funcCall: async (callId: string, name: string, args: string) => {
        seedTypedToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 184,
    },
  );
  assert(
    seedTypedToolUseCalls.length === 1,
    `Expected 1 typed seed-rendered tool call, got ${seedTypedToolUseCalls.length}`,
  );
  assert(
    seedTypedToolUseCalls[0]?.args === '{"path":"notes.md","show_linenos":true,"max_lines":271}',
    `Expected typed seed args JSON, got ${seedTypedToolUseCalls[0]?.args ?? ''}`,
  );
  assert(
    seedTypedToolUseCalls[0]?.id.startsWith('call_volcano_seed_g184_') === true,
    `Expected generated typed seed call id with genseq, got ${seedTypedToolUseCalls[0]?.id ?? ''}`,
  );

  const seedMultiBlockToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  async function* seedMultiBlockToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'text_delta',
        text: '<seed:tool_call><function name="read_file"><parameter name="path" string="true">same.md</parameter></function></seed:tool_call>',
      },
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
      delta: {
        type: 'text_delta',
        text: '<seed:tool_call><function name="read_file"><parameter name="path" string="true">same.md</parameter></function></seed:tool_call>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 1 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    seedMultiBlockToolUseEvents(),
    {
      ...emptyToolReceiver,
      funcCall: async (callId: string, name: string, args: string) => {
        seedMultiBlockToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 185,
    },
  );
  assert(
    seedMultiBlockToolUseCalls.length === 2,
    `Expected 2 multi-block seed tool calls, got ${seedMultiBlockToolUseCalls.length}`,
  );
  assert(
    seedMultiBlockToolUseCalls[0]?.id !== seedMultiBlockToolUseCalls[1]?.id,
    `Expected matching seed calls from distinct content blocks to get distinct call ids`,
  );
  assert(
    seedMultiBlockToolUseCalls.every((call) => call.id.startsWith('call_volcano_seed_g185_')),
    `Expected all multi-block seed call ids to include genseq 185`,
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
    responseText: string,
  ): Promise<Array<{ id: string; name: string; args: string }>> {
    const originalFetch = globalThis.fetch;
    const originalArkKey = process.env.ARK_API_KEY;
    const providerFuncCalls: Array<{ id: string; name: string; args: string }> = [];
    try {
      process.env.ARK_API_KEY = 'test-key';
      globalThis.fetch = async (): Promise<Response> =>
        new Response(responseText, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });

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

  const malformedEmptyToolInputSse = [
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
  ].join('\n');

  const providerFuncCalls = await collectMockedProviderFuncCalls(
    volcanoProvider,
    malformedEmptyToolInputSse,
  );
  assert(
    providerFuncCalls.length === 1,
    `Expected 1 provider-config quirk call, got ${providerFuncCalls.length}`,
  );
  assert(
    providerFuncCalls[0]?.args === '{}',
    `Expected built-in volcano provider to enable glm-via-volcano quirk, got ${providerFuncCalls[0]?.args ?? ''}`,
  );

  const multiQuirkProviderFuncCalls = await collectMockedProviderFuncCalls(
    {
      ...volcanoProvider,
      apiQuirks: ['xcode.best', 'glm-via-volcano', 'volcano-tool-use'],
    },
    malformedEmptyToolInputSse,
  );
  assert(
    multiQuirkProviderFuncCalls.length === 1,
    `Expected 1 multi-quirk provider call, got ${multiQuirkProviderFuncCalls.length}`,
  );
  assert(
    multiQuirkProviderFuncCalls[0]?.args === '{}',
    `Expected apiQuirks array to enable glm-via-volcano alongside other quirks, got ${multiQuirkProviderFuncCalls[0]?.args ?? ''}`,
  );

  const textRenderedToolUseSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0},"content":[]}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"前置说明。Function call emitted by the assistant.\\nTool name: read_current_open_conversation_latest_result\\n"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Call ID: call_text_provider_quirk\\nRaw arguments, verbatim:\\n<raw_arguments>\\n{\\"expectedConversationId\\":\\"69e093e8-76b8-839a-9378-b65b801038b9\\"}\\n</raw_arguments>"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const providerTextToolUseCalls = await collectMockedProviderFuncCalls(
    volcanoProvider,
    textRenderedToolUseSse,
  );
  assert(
    providerTextToolUseCalls.length === 1,
    `Expected 1 provider-config text-rendered tool call, got ${providerTextToolUseCalls.length}`,
  );
  assert(
    providerTextToolUseCalls[0]?.id === 'call_text_provider_quirk',
    `Expected built-in volcano provider to enable volcano-tool-use quirk, got call id ${providerTextToolUseCalls[0]?.id ?? ''}`,
  );
  assert(
    providerTextToolUseCalls[0]?.args ===
      '{"expectedConversationId":"69e093e8-76b8-839a-9378-b65b801038b9"}',
    `Expected built-in volcano provider to convert text-rendered tool args, got ${providerTextToolUseCalls[0]?.args ?? ''}`,
  );

  console.log('✓ Anthropic multi tool_use streaming test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
