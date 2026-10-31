import fs from 'fs/promises';
import assert from 'node:assert/strict';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import path from 'path';

import {
  MINIMAX_REASONING_DETAILS_API_QUIRK,
  MINIMAX_THINKING_TYPE_API_QUIRK,
  VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
} from '../../main/llm/api-quirks';
import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmInvalidFuncCall, LlmStreamReceiver } from '../../main/llm/gen';
import {
  buildOpenAiCompatibleExtraParamsForTest,
  consumeOpenAiCompatibleChatCompletionStreamForTest,
  OpenAiCompatibleGen,
  wrapOpenAiCompatibleRejectedRequestErrorForTest,
} from '../../main/llm/gen/openai-compatible';
import { Team } from '../../main/team';

import { compatiblePeerKey, wireCompletion, withCompatiblePeer } from '../helpers/compatible-peer';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-compatible-contract-');
function diagnostic(
  id: string,
  input: unknown,
  actual: unknown,
  scope = 'Real parser/configuration component. No provider request or driver/persistence repair is executed.',
) {
  evidence.record({
    id,
    scenario: id,
    businessValue:
      'Explain a concrete provider/protocol failure accurately while preserving supplied arguments, recovery identity and diagnostic evidence.',
    context: { input: JSON.stringify(input), scope },
    reviewQuestions: [
      'Does the actual diagnostic accurately describe the supplied failure, affected request/call and any available recovery or retained evidence without inventing provider execution, tool results or completion?',
    ],
    actualText: typeof actual === 'string' ? actual : JSON.stringify(actual, null, 2),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ChunkDeltaExtra = {
  reasoning_content?: string;
  reasoning_details?: unknown;
};

function chunk(args: {
  delta: ChatCompletionChunk.Choice.Delta & ChunkDeltaExtra;
  finishReason?: ChatCompletionChunk.Choice['finish_reason'];
}): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'kimi-k2.6',
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finishReason ?? null,
      },
    ],
  };
}

async function* stream(chunks: ChatCompletionChunk[]): AsyncIterable<ChatCompletionChunk> {
  for (const item of chunks) {
    yield item;
  }
}

function makeReceiver(events: string[], streamErrors: string[]): LlmStreamReceiver {
  return {
    thinkingStart: async () => {
      events.push('thinkingStart');
    },
    thinkingChunk: async (value) => {
      events.push(`thinking:${value}`);
    },
    thinkingFinish: async () => {
      events.push('thinkingFinish');
    },
    sayingStart: async () => {
      events.push('sayingStart');
    },
    sayingChunk: async (value) => {
      events.push(`saying:${value}`);
    },
    sayingFinish: async () => {
      events.push('sayingFinish');
    },
    funcCall: async (callId, name, args) => {
      events.push(`funcCall:${callId}:${name}:${args}`);
    },
    streamError: async (detail) => {
      streamErrors.push(detail);
    },
  };
}

function makeReceiverWithInvalidFuncCalls(
  events: string[],
  streamErrors: string[],
  invalidFuncCalls: LlmInvalidFuncCall[],
): LlmStreamReceiver {
  return {
    ...makeReceiver(events, streamErrors),
    invalidFuncCall: async (call) => {
      invalidFuncCalls.push(call);
    },
  };
}

async function testVolcanoArkAllowsSegmentAlternation(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({ delta: { reasoning_content: '先想。' } }),
      chunk({ delta: { content: '先说。' } }),
      chunk({ delta: { reasoning_content: '再想。' } }),
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'shell_cmd', arguments: '{"command":' },
            },
          ],
        },
      }),
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              type: 'function',
              function: { arguments: '"ls"}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 7,
  });

  assert(
    events.join('|') ===
      'thinkingStart|thinking:先想。|thinkingFinish|sayingStart|saying:先说。|sayingFinish|thinkingStart|thinking:再想。|thinkingFinish|funcCall:call-1:shell_cmd:{"command":"ls"}',
    `unexpected events: ${events.join('|')}`,
  );
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testReasoningDetailsStreamingIsPreserved(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const providerData: unknown[] = [];
  const receiver: LlmStreamReceiver = {
    ...makeReceiver(events, streamErrors),
    thinkingFinish: async (_reasoning, data) => {
      events.push('thinkingFinish');
      providerData.push(data);
    },
  };

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          reasoning_details: [{ type: 'reasoning.text', text: 'think', index: 0 }],
        },
      }),
      chunk({
        delta: {
          reasoning_details: [{ type: 'reasoning.text', text: 'thinking', index: 0 }],
        },
      }),
      chunk({
        delta: {
          reasoning_details: [{ type: 'reasoning.text', text: ' deeply', index: 0 }],
        },
      }),
      chunk({ delta: { content: 'done' }, finishReason: 'stop' }),
    ]),
    receiver,
    genseq: 8,
  });

  assert(
    events.join('|') ===
      'thinkingStart|thinking:think|thinking:ing|thinking: deeply|thinkingFinish|sayingStart|saying:done|sayingFinish',
    `unexpected reasoning_details stream events: ${events.join('|')}`,
  );
  const saved = providerData[0];
  assert.ok(isRecord(saved));
  assert.deepEqual(saved.openai_compatible_reasoning_details, [
    { type: 'reasoning.text', text: 'thinking', index: 0 },
    { type: 'reasoning.text', text: ' deeply', index: 0 },
  ]);
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testGenericAllowsSegmentAlternation(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({ delta: { reasoning_content: 'thinking' } }),
      chunk({ delta: { content: 'content' }, finishReason: 'stop' }),
    ]),
    receiver,
    genseq: 8,
  });

  assert(
    events.join('|') ===
      'thinkingStart|thinking:thinking|thinkingFinish|sayingStart|saying:content|sayingFinish',
    `unexpected generic segment alternation events: ${events.join('|')}`,
  );
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testInvalidReasoningDetailsStreamPayloadIsLoud(): Promise<void> {
  const events: string[] = [],
    streamErrors: string[] = [];
  const input = [chunk({ delta: { reasoning_details: 'not-an-array' } })];
  let observed: Error | undefined;
  await assert.rejects(
    async () => {
      await consumeOpenAiCompatibleChatCompletionStreamForTest({
        stream: stream(input),
        receiver: makeReceiver(events, streamErrors),
        genseq: 17,
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      observed = error;
      return true;
    },
  );
  assert.ok(observed);
  assert.equal(streamErrors.length, 1);
  assert.deepEqual(events, []);
  diagnostic('invalid-reasoning-details', input, {
    error: `${observed.name}: ${observed.message}`,
    streamErrors,
  });
}

async function testMissingToolCallTypeIsTolerated(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              function: { name: 'shell_cmd', arguments: '{}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 9,
  });

  assert(events.join('|') === 'funcCall:call-1:shell_cmd:{}', `unexpected events: ${events}`);
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testMissingToolCallIdIsSynthesized(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          tool_calls: [
            {
              index: 2,
              type: 'function',
              function: { name: 'shell_cmd', arguments: '{}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 11,
  });

  assert(
    events.join('|') === 'funcCall:toolcall_11_2:shell_cmd:{}',
    `unexpected synthetic tool call id events: ${events.join('|')}`,
  );
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testEmptyStreamedToolCallPlaceholderIsIgnored(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          tool_calls: [
            {
              index: 2,
              type: 'function',
              function: {},
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 67,
  });

  assert(events.length === 0, `unexpected empty placeholder events: ${events.join('|')}`);
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testStreamedToolCallWithArgumentsMissingNameIsLoud(): Promise<void> {
  const events: string[] = [],
    streamErrors: string[] = [],
    invalid: LlmInvalidFuncCall[] = [];
  const input = [
    chunk({
      delta: { tool_calls: [{ index: 2, type: 'function', function: { arguments: '{}' } }] },
      finishReason: 'tool_calls',
    }),
  ];
  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream(input),
    receiver: makeReceiverWithInvalidFuncCalls(events, streamErrors, invalid),
    genseq: 67,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(streamErrors, []);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.provider, 'openai-compatible');
  assert.equal(invalid[0]?.callId, 'toolcall_67_2');
  assert.equal(invalid[0]?.toolCallIndex, 2);
  assert.equal(invalid[0]?.rawArgumentsText, '{}');
  diagnostic('missing-stream-name-with-hook', input, invalid);
}

async function testStreamedToolCallMissingNameWithoutRecoveryHookThrows(): Promise<void> {
  const events: string[] = [],
    streamErrors: string[] = [];
  const input = [
    chunk({
      delta: { tool_calls: [{ index: 2, type: 'function', function: { arguments: '{}' } }] },
      finishReason: 'tool_calls',
    }),
  ];
  let observed: Error | undefined;
  await assert.rejects(
    async () => {
      await consumeOpenAiCompatibleChatCompletionStreamForTest({
        stream: stream(input),
        receiver: makeReceiver(events, streamErrors),
        genseq: 67,
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      observed = error;
      return true;
    },
  );
  assert.ok(observed);
  assert.deepEqual(events, []);
  assert.equal(streamErrors.length, 1);
  diagnostic('missing-stream-name-without-hook', input, {
    error: `${observed.name}: ${observed.message}`,
    streamErrors,
  });
}

async function testInvalidToolArgumentsPassThroughToToolCall(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'shell_cmd', arguments: '[]' },
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 10,
  });

  assert(
    events.join('|') === 'funcCall:call-1:shell_cmd:[]',
    `unexpected invalid tool argument pass-through events: ${events.join('|')}`,
  );
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

function completion(args: { toolCalls?: unknown[]; reasoningDetails?: Record<string, unknown>[] }) {
  return wireCompletion(
    {
      role: 'assistant',
      content: null,
      refusal: null,
      ...(args.reasoningDetails !== undefined ? { reasoning_details: args.reasoningDetails } : {}),
      tool_calls: args.toolCalls ?? [],
    },
    'tool_calls',
  );
}
async function batchFromPeer(body: unknown, genseq: number) {
  return await withCompatiblePeer(body, async (peer) => {
    const provider: ProviderConfig = {
      name: 'batch-wire-fixture',
      apiType: 'openai-compatible',
      baseUrl: peer.baseUrl,
      apiKeyEnvVar: compatiblePeerKey,
      models: { 'kimi-k2.6': { name: 'fixture' } },
    };
    const result = await new OpenAiCompatibleGen().genMoreMessages(
      provider,
      new Team.Member({ id: 'tester', name: 'Tester', model: 'kimi-k2.6' }),
      '',
      [],
      {
        dialogSelfId: 'batch-wire',
        dialogRootId: 'batch-wire',
        providerKey: 'fixture',
        modelKey: 'kimi-k2.6',
      },
      makePromptContext(),
      genseq,
    );
    assert.equal(peer.requestCount, 1);
    assert.equal(peer.captured.length, 1);
    assert.equal(peer.captured[0]?.method, 'POST');
    assert.equal(peer.captured[0]?.url, '/v1/chat/completions');
    assert.equal(peer.captured[0]?.body.model, 'kimi-k2.6');
    return result;
  });
}

async function testBatchReasoningDetailsArePreserved(): Promise<void> {
  const details = [{ type: 'reasoning.text', text: 'batch thinking', index: 0 }];
  const result = await batchFromPeer(completion({ reasoningDetails: details }), 13);
  assert.ok(result.outputs);
  const thinking = result.outputs.find(
    (output) => output.kind === 'message' && output.message.type === 'thinking_msg',
  );
  assert.ok(thinking?.kind === 'message' && thinking.message.type === 'thinking_msg');
  assert.equal(thinking.message.content, details[0]?.text);
  assert.deepEqual(thinking.message.provider_data?.openai_compatible_reasoning_details, details);
  assert.equal(thinking.message.genseq, 13);
}

async function testBatchToolCallsUseOpenAiCompatibleRules(): Promise<void> {
  // Deliberately incomplete wire JSON is read by the real SDK, not cast to ChatCompletion.
  const toolCalls = [
    { index: 0, id: 'call-1', type: 'function', function: { name: 'shell_cmd', arguments: '[]' } },
    { index: 1, type: 'function', function: { name: 'shell_cmd', arguments: '{}' } },
    { index: 2, function: { name: 'shell_cmd', arguments: '{"ok":true}' } },
  ];
  const result = await batchFromPeer(completion({ toolCalls }), 12);
  const calls = result.messages.filter((message) => message.type === 'func_call_msg');
  assert.deepEqual(
    calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      genseq: call.genseq,
    })),
    [
      { id: 'call-1', name: 'shell_cmd', arguments: '[]', genseq: 12 },
      { id: 'toolcall_12_1', name: 'shell_cmd', arguments: '{}', genseq: 12 },
      { id: 'toolcall_12_2', name: 'shell_cmd', arguments: '{"ok":true}', genseq: 12 },
    ],
  );
}

async function testBatchToolCallMissingNameIsLoud(): Promise<void> {
  const body = completion({
    toolCalls: [
      { index: 0, id: 'call-1', type: 'function', function: { name: '', arguments: '{}' } },
    ],
  });
  const result = await batchFromPeer(body, 13);
  assert.ok(result.outputs);
  const invalid = result.outputs.find((output) => output.kind === 'invalid_func_call');
  assert.ok(invalid?.kind === 'invalid_func_call');
  assert.equal(invalid.call.callId, 'call-1');
  assert.equal(invalid.call.rawArgumentsText, '{}');
  assert.equal(result.messages.filter((message) => message.type === 'func_call_msg').length, 0);
  diagnostic(
    'missing-batch-name',
    body,
    invalid,
    'Real SDK and generator through a controlled local HTTP response. No vendor service, tool execution or driver recovery is established.',
  );
}

function requireProvider(provider: ProviderConfig | undefined): ProviderConfig {
  if (provider === undefined) {
    throw new Error('Expected provider');
  }
  return provider;
}

function makePromptContext(): ChatMessage[] {
  return [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'volcano-ark-config-test',
      content: 'hello',
      grammar: 'markdown',
    },
  ];
}

async function expectOpenAiCompatibleRequestBuildError(args: {
  provider: ProviderConfig;
  agent: Team.Member;
  id: string;
}): Promise<void> {
  await withCompatiblePeer(wireCompletion(), async (peer) => {
    let observed: Error | undefined;
    await assert.rejects(
      async () => {
        await new OpenAiCompatibleGen().genMoreMessages(
          { ...args.provider, baseUrl: peer.baseUrl, apiKeyEnvVar: compatiblePeerKey },
          args.agent,
          '',
          [],
          {
            dialogSelfId: 'compatible-validation',
            dialogRootId: 'compatible-validation',
            providerKey: 'volcano-engine-coding-plan',
            modelKey: args.agent.model,
          },
          makePromptContext(),
          1,
        );
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        observed = error;
        return true;
      },
    );
    assert.ok(observed);
    assert.equal(peer.requestCount, 0);
    assert.deepEqual(peer.captured, []);
    diagnostic(
      args.id,
      { model: args.agent.model, parameters: args.agent.model_params },
      `${observed.name}: ${observed.message}`,
      'Actual request construction with controlled localhost peer and zero received requests. No vendor service.',
    );
  });
}

async function testBuiltinVolcanoArkCodingPlanProvider(): Promise<void> {
  const cfg = await LlmConfig.load();
  const provider = requireProvider(cfg.getProvider('volcano-engine-coding-plan'));
  assert(provider.apiType === 'openai-compatible', 'expected openai-compatible apiType');
  assert(
    Array.isArray(provider.apiQuirks) &&
      provider.apiQuirks.length === 2 &&
      provider.apiQuirks.includes('same-context-empty-response') &&
      provider.apiQuirks.includes(VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK),
    'expected Volcano Ark Coding Plan retry apiQuirks',
  );
  assert(
    provider.baseUrl === 'https://ark.cn-beijing.volces.com/api/coding/v3',
    `unexpected baseUrl: ${provider.baseUrl}`,
  );
  assert(
    !Object.prototype.hasOwnProperty.call(provider.models, 'ark-code-latest'),
    'ark-code-latest must not be a built-in Volcano Ark Coding Plan model',
  );
  assert(
    Object.prototype.hasOwnProperty.call(provider.models, 'minimax-m2.7'),
    'expected minimax-m2.7 concrete provider model key',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(provider.models, 'minimax-latest'),
    'floating minimax-latest key should not remain in Volcano Ark Coding Plan provider',
  );

  await expectOpenAiCompatibleRequestBuildError({
    provider,
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'kimi-k2.6',
      model_params: {
        'openai-compatible': {
          thinking: false,
          reasoning_effort: 'medium',
        },
      },
    }),
    id: 'volc-disabled-thinking-conflict',
  });
}

async function testBuiltinMiniMaxProvidersUseOpenAiCompatibleReasoningDetails(): Promise<void> {
  const cfg = await LlmConfig.load();
  for (const providerKey of [
    'minimaxi.com-token-plan',
    'minimaxi.com',
    'minimax.io-token-plan',
    'minimax.io',
  ]) {
    const provider = requireProvider(cfg.getProvider(providerKey));
    assert(provider.apiType === 'openai-compatible', `${providerKey} should use openai-compatible`);
    assert(
      provider.baseUrl.endsWith('/v1'),
      `${providerKey} should point at the OpenAI-compatible /v1 endpoint`,
    );
    assert(
      Array.isArray(provider.apiQuirks) &&
        provider.apiQuirks.includes(MINIMAX_REASONING_DETAILS_API_QUIRK),
      `${providerKey} should enable MiniMax reasoning_details preservation`,
    );
    const option = provider.model_param_options?.['openai-compatible']?.reasoning_split;
    assert.ok(option?.type === 'boolean');
    assert.equal(option.default, true);
  }
}

function testOpenAiCompatibleExtraParams(): void {
  const extraParams = buildOpenAiCompatibleExtraParamsForTest({
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'kimi-k2.6',
    }),
    openAiParams: {
      reasoning_effort: 'medium',
      reasoning_split: true,
    },
  });
  assert(
    extraParams.reasoning_effort === 'medium',
    'expected reasoning_effort to be preserved without thinking flag',
  );
  assert(extraParams.reasoning_split === true, 'expected reasoning_split to be preserved');
  assert(extraParams.thinking === undefined, 'expected no implicit thinking payload');

  const thinkingParams = buildOpenAiCompatibleExtraParamsForTest({
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'generic-model',
    }),
    openAiParams: {
      thinking: true,
    },
  });
  assert(
    isRecord(thinkingParams.thinking) && thinkingParams.thinking.type === 'enabled',
    'expected generic openai-compatible thinking=true payload',
  );

  const thinkingObject = { type: 'enabled', budget_tokens: 2048 };
  const thinkingObjectParams = buildOpenAiCompatibleExtraParamsForTest({
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'generic-model',
    }),
    openAiParams: {
      thinking: thinkingObject,
    },
  });
  assert(
    isRecord(thinkingObjectParams.thinking),
    'expected generic openai-compatible thinking object to pass through unchanged',
  );

  const minimaxQuirkParams = buildOpenAiCompatibleExtraParamsForTest({
    providerConfig: {
      name: 'MiniMax Test',
      apiType: 'openai-compatible',
      apiQuirks: [MINIMAX_REASONING_DETAILS_API_QUIRK],
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnvVar: 'MINIMAX_API_KEY',
      models: { 'MiniMax-M2.7': { name: 'MiniMax M2.7' } },
    },
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'MiniMax-M2.7',
    }),
    openAiParams: {},
  });
  assert(
    minimaxQuirkParams.reasoning_split === true,
    'expected MiniMax reasoning_details quirk to enable reasoning_split by default',
  );

  // Shared MiniMax fixture: both MiniMax quirks enabled, used by the three regressions below.
  const minimaxProviderConfig: ProviderConfig = {
    name: 'MiniMax Test',
    apiType: 'openai-compatible',
    apiQuirks: [MINIMAX_REASONING_DETAILS_API_QUIRK, MINIMAX_THINKING_TYPE_API_QUIRK],
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    models: { 'MiniMax-M2.7': { name: 'MiniMax M2.7' } },
  };
  const minimaxAgent = new Team.Member({
    id: 'tester',
    name: 'Tester',
    model: 'MiniMax-M2.7',
  });

  // Regression: MiniMax rejects `thinking.type: 'enabled'`; boolean true must serialize as
  // `adaptive` when the `minimax-thinking-type` quirk is enabled.
  const minimaxThinkingBoolParams = buildOpenAiCompatibleExtraParamsForTest({
    providerConfig: minimaxProviderConfig,
    agent: minimaxAgent,
    openAiParams: { thinking: true },
  });
  assert(
    isRecord(minimaxThinkingBoolParams.thinking) &&
      minimaxThinkingBoolParams.thinking.type === 'adaptive',
    `expected MiniMax thinking=true to serialize as type=adaptive, got ${JSON.stringify(
      minimaxThinkingBoolParams.thinking,
    )}`,
  );

  // Regression: object form `{ type: 'enabled' }` must also be normalized to `adaptive`,
  // and other fields (e.g. `budget_tokens`) must be preserved.
  const minimaxThinkingObjectParams = buildOpenAiCompatibleExtraParamsForTest({
    providerConfig: minimaxProviderConfig,
    agent: minimaxAgent,
    openAiParams: { thinking: { type: 'enabled', budget_tokens: 2048 } },
  });
  const minimaxThinkingObj = minimaxThinkingObjectParams.thinking;
  assert(
    isRecord(minimaxThinkingObj) && minimaxThinkingObj['type'] === 'adaptive',
    `expected MiniMax thinking object to be normalized to type=adaptive, got ${JSON.stringify(
      minimaxThinkingObj,
    )}`,
  );
  assert(
    isRecord(minimaxThinkingObj) && minimaxThinkingObj['budget_tokens'] === 2048,
    'expected normalization to preserve other thinking fields (e.g. budget_tokens)',
  );

  // Regression: boolean false must still map to `disabled` for MiniMax.
  const minimaxThinkingFalseParams = buildOpenAiCompatibleExtraParamsForTest({
    providerConfig: minimaxProviderConfig,
    agent: minimaxAgent,
    openAiParams: { thinking: false },
  });
  assert(
    isRecord(minimaxThinkingFalseParams.thinking) &&
      minimaxThinkingFalseParams.thinking.type === 'disabled',
    'expected MiniMax thinking=false to serialize as type=disabled',
  );

  assert.deepEqual(thinkingObjectParams.thinking, thinkingObject);
  assert.deepEqual(thinkingObject, { type: 'enabled', budget_tokens: 2048 });
  let disabledObjectConflict = false;
  try {
    buildOpenAiCompatibleExtraParamsForTest({
      agent: new Team.Member({
        id: 'tester',
        name: 'Tester',
        model: 'generic-model',
      }),
      openAiParams: {
        thinking: { type: 'disabled' },
        reasoning_effort: 'medium',
      },
    });
  } catch (error: unknown) {
    disabledObjectConflict = true;
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(
      'generic-disabled-thinking-conflict',
      { thinking: { type: 'disabled' }, reasoning_effort: 'medium' },
      message,
    );
  }
  assert(
    disabledObjectConflict,
    'expected disabled thinking object to conflict with reasoning_effort',
  );
}

async function buildOpenAiCompatibleRejectedRequestTestInput(): Promise<{
  agent: Team.Member;
  provider: ProviderConfig;
  upstream: Error & { status?: number; statusCode?: number; code?: string };
}> {
  const cfg = await LlmConfig.load();
  const provider = requireProvider(cfg.getProvider('volcano-engine-coding-plan'));
  const agent = new Team.Member({
    id: 'tester',
    name: 'Tester',
    model: 'kimi-k2.6',
  });
  const upstream: Error & { status?: number; statusCode?: number; code?: string } = new Error(
    '400 A parameter specified in the request is not valid Request id: test-request',
  );
  upstream.status = 400;
  upstream.statusCode = 400;
  upstream.code = 'InvalidParameter';
  return { agent, provider, upstream };
}

function buildOpenAiCompatibleRejectedRequestContext(): {
  dialogSelfId: string;
  dialogRootId: string;
  providerKey: string;
  modelKey: string;
} {
  return {
    dialogSelfId: 'tests/provider/openai-compatible-volcengine-coding-plan',
    dialogRootId: 'tests/provider/openai-compatible-volcengine-coding-plan',
    providerKey: 'volcano-engine-coding-plan',
    modelKey: 'kimi-k2.6',
  };
}

async function testOpenAiCompatibleRejectedRequestKeepsFailureClassification(): Promise<void> {
  const { agent, provider, upstream } = await buildOpenAiCompatibleRejectedRequestTestInput();
  const debugRoot = path.join(process.cwd(), 'compatible-rejected-capture');
  await fs.mkdir(debugRoot, { recursive: true });
  const payload = {
    model: 'kimi-k2.6',
    messages: [{ role: 'user', content: 'payload-data:8ae4' }],
    metadata: { opaque: ['data:934d', 2] },
  };
  const previous = process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
  try {
    process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = debugRoot;
    const wrapped = await wrapOpenAiCompatibleRejectedRequestErrorForTest({
      error: upstream,
      providerConfig: provider,
      agent,
      requestContext: buildOpenAiCompatibleRejectedRequestContext(),
      genseq: 43,
      requestKind: 'stream',
      payload,
    });
    const failure = new OpenAiCompatibleGen().classifyFailure(wrapped);
    assert.ok(failure?.kind === 'rejected');
    assert.equal(failure.status, 400);
    assert.equal(failure.code, 'InvalidParameter');
    assert.ok(wrapped instanceof Error && isRecord(wrapped));
    assert.equal(wrapped.cause, upstream);
    assert.equal(wrapped.status, 400);
    assert.equal(wrapped.code, 'InvalidParameter');
    assert.ok(typeof wrapped.requestPayloadPath === 'string');
    const relative = path.relative(debugRoot, wrapped.requestPayloadPath);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.split(path.sep).includes('..'), false);
    assert.deepEqual(JSON.parse(await fs.readFile(wrapped.requestPayloadPath, 'utf8')), payload);
    diagnostic(
      'rejected-with-retained-payload',
      {
        upstream: { message: upstream.message, status: upstream.status, code: upstream.code },
        payload,
        payloadPath: wrapped.requestPayloadPath,
      },
      { error: wrapped.message, failure },
      'Actual rejected-error enrichment, local disk capture and classifier only. No provider request or backend restart. Payload remains in CLI-owned rtws for retained evidence.',
    );
  } finally {
    if (previous === undefined) delete process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
    else process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = previous;
  }
}

async function testOpenAiCompatibleRejectedRequestSurvivesDebugCaptureFailure(): Promise<void> {
  const { agent, provider, upstream } = await buildOpenAiCompatibleRejectedRequestTestInput();
  const file = path.join(process.cwd(), 'compatible-capture-not-directory');
  await fs.writeFile(file, 'not a directory');
  const payload = {
    model: 'kimi-k2.6',
    messages: [{ role: 'user', content: 'payload-data:f812' }],
  };
  const previous = process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
  try {
    process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = file;
    const wrapped = await wrapOpenAiCompatibleRejectedRequestErrorForTest({
      error: upstream,
      providerConfig: provider,
      agent,
      requestContext: buildOpenAiCompatibleRejectedRequestContext(),
      genseq: 44,
      requestKind: 'stream',
      payload,
    });
    const failure = new OpenAiCompatibleGen().classifyFailure(wrapped);
    assert.ok(failure?.kind === 'rejected');
    assert.equal(failure.status, 400);
    assert.equal(failure.code, 'InvalidParameter');
    assert.ok(wrapped instanceof Error && isRecord(wrapped));
    assert.equal(wrapped.cause, upstream);
    assert.ok(typeof wrapped.debugCaptureError === 'string');
    assert.equal(wrapped.requestPayloadPath, undefined);
    diagnostic(
      'rejected-capture-io-failure',
      {
        upstream: { message: upstream.message, status: upstream.status, code: upstream.code },
        captureRootIsRegularFile: true,
        payload,
      },
      { error: wrapped.message, debugCaptureError: wrapped.debugCaptureError, failure },
      'Actual error enrichment, regular-file capture failure and classifier. Source file/rtws retained on failure by CLI; no provider request.',
    );
  } finally {
    if (previous === undefined) delete process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
    else process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = previous;
  }
}

async function main(): Promise<void> {
  await testVolcanoArkAllowsSegmentAlternation();
  await testReasoningDetailsStreamingIsPreserved();
  await testGenericAllowsSegmentAlternation();
  await testInvalidReasoningDetailsStreamPayloadIsLoud();
  await testMissingToolCallTypeIsTolerated();
  await testMissingToolCallIdIsSynthesized();
  await testEmptyStreamedToolCallPlaceholderIsIgnored();
  await testStreamedToolCallWithArgumentsMissingNameIsLoud();
  await testStreamedToolCallMissingNameWithoutRecoveryHookThrows();
  await testInvalidToolArgumentsPassThroughToToolCall();
  await testBatchReasoningDetailsArePreserved();
  await testBatchToolCallsUseOpenAiCompatibleRules();
  await testBatchToolCallMissingNameIsLoud();
  await testBuiltinVolcanoArkCodingPlanProvider();
  await testBuiltinMiniMaxProvidersUseOpenAiCompatibleReasoningDetails();
  testOpenAiCompatibleExtraParams();
  await testOpenAiCompatibleRejectedRequestKeepsFailureClassification();
  await testOpenAiCompatibleRejectedRequestSurvivesDebugCaptureFailure();
  await evidence.write();
  console.log('OpenAI-compatible stream, batch and parameter contracts: PASS');
}

// Preserve the suite's existing60s bound and prevent an unfinished async parser from
// exiting zero when it has no live handles. Completion includes all evidence writes.
const watchdog = setTimeout(() => {
  throw new Error('Compatible case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
