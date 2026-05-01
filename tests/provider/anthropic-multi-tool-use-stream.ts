import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import YAML from 'yaml';

import type { ProviderConfig } from '../../main/llm/client';
import { readBuiltinDefaultsYamlRaw } from '../../main/llm/client';
import type { LlmBatchResult, LlmStreamReceiver } from '../../main/llm/gen';
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

  const sentinelLessTextToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  const sentinelLessTextToolUseWords: string[] = [];
  async function* sentinelLessTextRenderedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
        text: [
          '现在让我查看工作区状态，确认是否还有其他需要更新的内容：',
          'Tool name: list_dir',
          'Call ID: call_sentinel_less_text_tool',
          'Raw arguments, verbatim:',
          '<raw_arguments>',
          '{"path":"."}',
          '</raw_arguments>',
        ].join('\n'),
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    sentinelLessTextRenderedToolUseEvents(),
    {
      ...emptyToolReceiver,
      sayingChunk: async (chunk: string) => {
        sentinelLessTextToolUseWords.push(chunk);
      },
      funcCall: async (callId: string, name: string, args: string) => {
        sentinelLessTextToolUseCalls.push({ id: callId, name, args });
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
    sentinelLessTextToolUseWords.join('') ===
      '现在让我查看工作区状态，确认是否还有其他需要更新的内容：',
    `Expected prose before sentinel-less text-rendered tool call to remain saying, got ${JSON.stringify(sentinelLessTextToolUseWords.join(''))}`,
  );
  assert(
    sentinelLessTextToolUseCalls.length === 1 &&
      sentinelLessTextToolUseCalls[0]?.id === 'call_sentinel_less_text_tool' &&
      sentinelLessTextToolUseCalls[0].name === 'list_dir' &&
      sentinelLessTextToolUseCalls[0].args === '{"path":"."}',
    `Expected sentinel-less text-rendered tool metadata to become a tool call, got ${JSON.stringify(sentinelLessTextToolUseCalls)}`,
  );

  const inlineToolNameWords: string[] = [];
  const inlineToolNameCalls: Array<{ id: string; name: string; args: string }> = [];
  const inlineToolNameText =
    '普通说明里提到 Tool name: list_dir\nCall ID: call_inline_not_tool\nRaw arguments, verbatim:\n<raw_arguments>{"path":"."}</raw_arguments>';
  async function* inlineToolNameEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: { type: 'text_delta', text: inlineToolNameText },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    inlineToolNameEvents(),
    {
      ...emptyToolReceiver,
      sayingChunk: async (chunk: string) => {
        inlineToolNameWords.push(chunk);
      },
      funcCall: async (callId: string, name: string, args: string) => {
        inlineToolNameCalls.push({ id: callId, name, args });
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
    inlineToolNameCalls.length === 0 && inlineToolNameWords.join('') === inlineToolNameText,
    `Expected inline Tool name mention to remain saying text, got calls=${JSON.stringify(inlineToolNameCalls)} text=${JSON.stringify(inlineToolNameWords.join(''))}`,
  );

  const duplicateTextToolUseCalls: Array<{ id: string; name: string; args: string }> = [];
  async function* duplicateTextRenderedToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
        text: [
          'Function call emitted by the assistant.',
          'Tool name: read_file',
          'Call ID: call_reused_volcano_text_id',
          'Raw arguments, verbatim:',
          '<raw_arguments>{"path":"a.md"}</raw_arguments>',
          'Function call emitted by the assistant.',
          'Tool name: read_file',
          'Call ID: call_reused_volcano_text_id',
          'Raw arguments, verbatim:',
          '<raw_arguments>{"path":"b.md"}</raw_arguments>',
        ].join('\n'),
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    duplicateTextRenderedToolUseEvents(),
    {
      ...emptyToolReceiver,
      funcCall: async (callId: string, name: string, args: string) => {
        duplicateTextToolUseCalls.push({ id: callId, name, args });
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      knownFunctionCallIds: new Set(['call_reused_volcano_text_id']),
    },
  );
  assert(
    duplicateTextToolUseCalls.length === 2,
    `Expected 2 duplicate-id text-rendered tool calls, got ${duplicateTextToolUseCalls.length}`,
  );
  assert(
    duplicateTextToolUseCalls[0]?.id === 'call_reused_volcano_text_id_v1',
    `Expected first duplicate text-rendered call id to get _v1, got ${duplicateTextToolUseCalls[0]?.id ?? ''}`,
  );
  assert(
    duplicateTextToolUseCalls[1]?.id === 'call_reused_volcano_text_id_v2',
    `Expected second duplicate text-rendered call id to get _v2, got ${duplicateTextToolUseCalls[1]?.id ?? ''}`,
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

  const messageStopMixedFlushEventsSeen: string[] = [];
  async function* mixedTextThinkingWithoutBlockStopEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'thinking_delta',
        thinking:
          '思考先行\n<seed:tool_call><function name="mind_more"><parameter name="selector" string="true">progress</parameter></function></seed:tool_call>',
      },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '正文随后' },
    } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    mixedTextThinkingWithoutBlockStopEvents(),
    {
      ...emptyToolReceiver,
      thinkingStart: async () => {
        messageStopMixedFlushEventsSeen.push('thinkingStart');
      },
      thinkingChunk: async (chunk: string) => {
        messageStopMixedFlushEventsSeen.push(`thinking:${chunk}`);
      },
      thinkingFinish: async () => {
        messageStopMixedFlushEventsSeen.push('thinkingFinish');
      },
      sayingStart: async () => {
        messageStopMixedFlushEventsSeen.push('sayingStart');
      },
      sayingChunk: async (chunk: string) => {
        messageStopMixedFlushEventsSeen.push(`saying:${chunk}`);
      },
      sayingFinish: async () => {
        messageStopMixedFlushEventsSeen.push('sayingFinish');
      },
      funcCall: async (callId: string, name: string, args: string) => {
        messageStopMixedFlushEventsSeen.push(`func:${callId}:${name}:${args}`);
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 194,
    },
  );
  assert(
    messageStopMixedFlushEventsSeen.length === 7 &&
      messageStopMixedFlushEventsSeen[0] === 'thinkingStart' &&
      messageStopMixedFlushEventsSeen[1] === 'thinking:思考先行\n' &&
      messageStopMixedFlushEventsSeen[2] === 'thinkingFinish' &&
      messageStopMixedFlushEventsSeen[3]?.startsWith('func:call_volcano_seed_g194_') === true &&
      messageStopMixedFlushEventsSeen[3]?.endsWith(':mind_more:{"selector":"progress"}') === true &&
      messageStopMixedFlushEventsSeen[4] === 'sayingStart' &&
      messageStopMixedFlushEventsSeen[5] === 'saying:正文随后' &&
      messageStopMixedFlushEventsSeen[6] === 'sayingFinish',
    `Expected message_stop mixed flush to preserve block order, got ${JSON.stringify(messageStopMixedFlushEventsSeen)}`,
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

  const seedThinkingToolUseEventsSeen: string[] = [];
  async function* seedThinkingToolUseEvents(): AsyncIterable<MessageStreamEvent> {
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
      delta: {
        type: 'thinking_delta',
        thinking:
          '让我先更新差遣牒的 progress 章节。\n' +
          '<seed:tool_call><function name="mind_more"><parameter name="items" string="false">["- 2026-04-30 新增测试：read_self_monitoring_main_window_console_evidence (成功)"]</parameter><parameter name="sep" string="true">\\n</parameter><parameter name="selector" string="true">progress</parameter></function></seed:tool_call>',
      },
    } as unknown as MessageStreamEvent;
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    seedThinkingToolUseEvents(),
    {
      ...emptyToolReceiver,
      thinkingStart: async () => {
        seedThinkingToolUseEventsSeen.push('thinkingStart');
      },
      thinkingChunk: async (chunk: string) => {
        seedThinkingToolUseEventsSeen.push(`thinking:${chunk}`);
      },
      thinkingFinish: async () => {
        seedThinkingToolUseEventsSeen.push('thinkingFinish');
      },
      funcCall: async (callId: string, name: string, args: string) => {
        seedThinkingToolUseEventsSeen.push(`func:${callId}:${name}:${args}`);
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 192,
    },
  );
  assert(
    seedThinkingToolUseEventsSeen.length === 4 &&
      seedThinkingToolUseEventsSeen[0] === 'thinkingStart' &&
      seedThinkingToolUseEventsSeen[1] === 'thinking:让我先更新差遣牒的 progress 章节。\n' &&
      seedThinkingToolUseEventsSeen[2] === 'thinkingFinish' &&
      seedThinkingToolUseEventsSeen[3]?.startsWith('func:call_volcano_seed_g192_') === true &&
      seedThinkingToolUseEventsSeen[3]?.endsWith(
        ':mind_more:{"items":["- 2026-04-30 新增测试：read_self_monitoring_main_window_console_evidence (成功)"],"sep":"\\\\n","selector":"progress"}',
      ) === true,
    `Expected thinking seed tool use to become function call without leaking metadata, got ${JSON.stringify(seedThinkingToolUseEventsSeen)}`,
  );

  const splitSeedThinkingToolUseEventsSeen: string[] = [];
  async function* splitSeedThinkingToolUseEvents(): AsyncIterable<MessageStreamEvent> {
    yield {
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    } as unknown as MessageStreamEvent;
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as unknown as MessageStreamEvent;
    for (const thinking of [
      '先记录进度。\n<seed:tool_call><function name="mind_more"><parameter name="items" string="false">["split',
      '-delta"]</parameter><parameter name="selector" string="true">progress</parameter></function></seed:tool_call>',
      '\n继续思考。',
    ]) {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking,
        },
      } as unknown as MessageStreamEvent;
    }
    yield { type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent;
    yield { type: 'message_stop' } as unknown as MessageStreamEvent;
  }

  await consumeAnthropicStream(
    splitSeedThinkingToolUseEvents(),
    {
      ...emptyToolReceiver,
      thinkingStart: async () => {
        splitSeedThinkingToolUseEventsSeen.push('thinkingStart');
      },
      thinkingChunk: async (chunk: string) => {
        splitSeedThinkingToolUseEventsSeen.push(`thinking:${chunk}`);
      },
      thinkingFinish: async () => {
        splitSeedThinkingToolUseEventsSeen.push('thinkingFinish');
      },
      funcCall: async (callId: string, name: string, args: string) => {
        splitSeedThinkingToolUseEventsSeen.push(`func:${callId}:${name}:${args}`);
      },
    },
    {
      quirks: {
        normalizeLoneClosingBraceEmptyToolInputDelta: false,
        convertVolcanoTextToolUseBlocks: true,
      },
      genseq: 193,
    },
  );
  assert(
    splitSeedThinkingToolUseEventsSeen[0] === 'thinkingStart' &&
      splitSeedThinkingToolUseEventsSeen[1] === 'thinking:先记录进度。\n' &&
      splitSeedThinkingToolUseEventsSeen[2] === 'thinkingFinish' &&
      splitSeedThinkingToolUseEventsSeen[4] === 'thinkingStart',
    `Expected split thinking seed tool use to preserve ordered thinking/tool/thinking events, got ${JSON.stringify(splitSeedThinkingToolUseEventsSeen)}`,
  );
  assert(
    splitSeedThinkingToolUseEventsSeen.length === 7 &&
      splitSeedThinkingToolUseEventsSeen[3]?.startsWith('func:call_volcano_seed_g193_') === true &&
      splitSeedThinkingToolUseEventsSeen[3]?.endsWith(
        ':mind_more:{"items":["split-delta"],"selector":"progress"}',
      ) === true &&
      splitSeedThinkingToolUseEventsSeen[5] === 'thinking:\n继续思考。' &&
      splitSeedThinkingToolUseEventsSeen[6] === 'thinkingFinish',
    `Expected split thinking seed tool use to convert after block buffering, got ${JSON.stringify(splitSeedThinkingToolUseEventsSeen)}`,
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
    knownFunctionCallIds?: ReadonlySet<string>,
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
          knownFunctionCallIds,
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

  async function collectMockedProviderBatchMessages(
    provider: ProviderConfig,
    responseText: string,
    knownFunctionCallIds?: ReadonlySet<string>,
  ): Promise<LlmBatchResult['messages']> {
    const originalFetch = globalThis.fetch;
    const originalArkKey = process.env.ARK_API_KEY;
    try {
      process.env.ARK_API_KEY = 'test-key';
      globalThis.fetch = async (): Promise<Response> =>
        new Response(responseText, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      const result = await new AnthropicGen('anthropic-compatible').genMoreMessages(
        provider,
        { id: 'tester', name: 'tester', model: 'glm-5.1' },
        '',
        [],
        {
          dialogSelfId: 'self',
          dialogRootId: 'root',
          providerKey: 'volcano-engine-coding-plan',
          modelKey: 'glm-5.1',
          knownFunctionCallIds,
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
        1,
      );
      return result.messages;
    } finally {
      globalThis.fetch = originalFetch;
      if (originalArkKey === undefined) {
        delete process.env.ARK_API_KEY;
      } else {
        process.env.ARK_API_KEY = originalArkKey;
      }
    }
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

  const sentinelLessTextRenderedToolUseSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0},"content":[]}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"前置说明。\\nTool name: list_dir\\n"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Call ID: call_provider_sentinel_less_text_tool\\nRaw arguments, verbatim:\\n<raw_arguments>\\n{\\"path\\":\\".\\"}\\n</raw_arguments>"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const providerSentinelLessToolUseCalls = await collectMockedProviderFuncCalls(
    volcanoProvider,
    sentinelLessTextRenderedToolUseSse,
  );
  assert(
    providerSentinelLessToolUseCalls.length === 1 &&
      providerSentinelLessToolUseCalls[0]?.id === 'call_provider_sentinel_less_text_tool' &&
      providerSentinelLessToolUseCalls[0].name === 'list_dir' &&
      providerSentinelLessToolUseCalls[0].args === '{"path":"."}',
    `Expected provider-config sentinel-less text-rendered tool call to convert, got ${JSON.stringify(providerSentinelLessToolUseCalls)}`,
  );

  const batchTextRenderedToolUseBody = JSON.stringify({
    id: 'msg-batch-tool-use',
    type: 'message',
    role: 'assistant',
    model: 'glm-5.1',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: 'text',
        text: [
          '批量响应前置说明。',
          'Function call emitted by the assistant.',
          'Tool name: read_file',
          'Call ID: call_batch_reused_volcano_text_id',
          'Raw arguments, verbatim:',
          '<raw_arguments>{"path":"batch-a.md"}</raw_arguments>',
        ].join('\n'),
      },
    ],
  });
  const providerBatchMessages = await collectMockedProviderBatchMessages(
    volcanoProvider,
    batchTextRenderedToolUseBody,
    new Set(['call_batch_reused_volcano_text_id']),
  );
  assert(
    providerBatchMessages.length === 2 &&
      providerBatchMessages[0]?.type === 'saying_msg' &&
      providerBatchMessages[0].role === 'assistant' &&
      providerBatchMessages[0].content === '批量响应前置说明。\n' &&
      providerBatchMessages[1]?.type === 'func_call_msg' &&
      providerBatchMessages[1].id === 'call_batch_reused_volcano_text_id_v1' &&
      providerBatchMessages[1].name === 'read_file' &&
      providerBatchMessages[1].arguments === '{"path":"batch-a.md"}',
    `Expected batch text before text-rendered tool call to remain saying, got ${JSON.stringify(providerBatchMessages)}`,
  );

  const batchSentinelLessTextRenderedToolUseBody = JSON.stringify({
    id: 'msg-batch-sentinel-less-tool-use',
    type: 'message',
    role: 'assistant',
    model: 'glm-5.1',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: 'text',
        text: [
          '批量响应前置说明。',
          'Tool name: list_dir',
          'Call ID: call_batch_sentinel_less_text_tool',
          'Raw arguments, verbatim:',
          '<raw_arguments>{"path":"."}</raw_arguments>',
        ].join('\n'),
      },
    ],
  });
  const providerBatchSentinelLessMessages = await collectMockedProviderBatchMessages(
    volcanoProvider,
    batchSentinelLessTextRenderedToolUseBody,
  );
  assert(
    providerBatchSentinelLessMessages.length === 2 &&
      providerBatchSentinelLessMessages[0]?.type === 'saying_msg' &&
      providerBatchSentinelLessMessages[0].role === 'assistant' &&
      providerBatchSentinelLessMessages[0].content === '批量响应前置说明。' &&
      providerBatchSentinelLessMessages[1]?.type === 'func_call_msg' &&
      providerBatchSentinelLessMessages[1].id === 'call_batch_sentinel_less_text_tool' &&
      providerBatchSentinelLessMessages[1].name === 'list_dir' &&
      providerBatchSentinelLessMessages[1].arguments === '{"path":"."}',
    `Expected batch sentinel-less text-rendered tool call to convert, got ${JSON.stringify(providerBatchSentinelLessMessages)}`,
  );

  console.log('✓ Anthropic multi tool_use streaming test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
