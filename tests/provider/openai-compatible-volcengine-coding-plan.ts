import fs from 'fs/promises';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import os from 'os';
import path from 'path';

import {
  MINIMAX_REASONING_DETAILS_API_QUIRK,
  MINIMAX_THINKING_TYPE_API_QUIRK,
  VOLCENGINE_INVALID_PARAMETER_AGGRESSIVE_RETRY_API_QUIRK,
} from '../../main/llm/api-quirks';
import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import {
  buildOpenAiCompatibleExtraParamsForTest,
  chatCompletionToBatchOutputsForTest,
  chatCompletionToChatMessagesForTest,
  consumeOpenAiCompatibleChatCompletionStreamForTest,
  OpenAiCompatibleGen,
  wrapOpenAiCompatibleRejectedRequestErrorForTest,
} from '../../main/llm/gen/openai-compatible';
import { Team } from '../../main/team';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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
  invalidFuncCalls: string[],
): LlmStreamReceiver {
  return {
    ...makeReceiver(events, streamErrors),
    invalidFuncCall: async (call) => {
      invalidFuncCalls.push(
        `${call.provider}:${call.callId}:${String(call.toolCallIndex)}:${call.rawArgumentsText ?? ''}`,
      );
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
  assert(
    typeof saved === 'object' &&
      saved !== null &&
      Array.isArray((saved as Record<string, unknown>)['openai_compatible_reasoning_details']),
    'expected reasoning_details to be preserved in provider_data',
  );
  const savedDetails = (saved as Record<string, unknown>)['openai_compatible_reasoning_details'];
  assert(
    Array.isArray(savedDetails) && savedDetails.length === 2,
    'expected cumulative snapshot then delta reasoning_details to both be preserved',
  );
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
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);
  let threw = false;

  try {
    await consumeOpenAiCompatibleChatCompletionStreamForTest({
      stream: stream([
        chunk({
          delta: {
            reasoning_details: 'not-an-array',
          },
        }),
      ]),
      receiver,
      genseq: 17,
    });
  } catch (error: unknown) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes('invalid reasoning_details stream payload'),
      `expected invalid reasoning_details error, got ${message}`,
    );
  }

  assert(threw, 'expected invalid reasoning_details stream payload to throw');
  assert(
    streamErrors.join('|').includes('invalid reasoning_details stream payload'),
    'expected stream_error event for invalid reasoning_details payload',
  );
  assert(events.length === 0, `unexpected stream events: ${events.join('|')}`);
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
  const events: string[] = [];
  const streamErrors: string[] = [];
  const invalidFuncCalls: string[] = [];
  const receiver = makeReceiverWithInvalidFuncCalls(events, streamErrors, invalidFuncCalls);

  await consumeOpenAiCompatibleChatCompletionStreamForTest({
    stream: stream([
      chunk({
        delta: {
          tool_calls: [
            {
              index: 2,
              type: 'function',
              function: { arguments: '{}' },
            },
          ],
        },
        finishReason: 'tool_calls',
      }),
    ]),
    receiver,
    genseq: 67,
  });

  assert(events.length === 0, `unexpected missing-name events: ${events.join('|')}`);
  assert(
    invalidFuncCalls.join('|') === 'openai-compatible:toolcall_67_2:2:{}',
    `unexpected invalid func calls: ${invalidFuncCalls.join('|')}`,
  );
  assert(
    streamErrors.length === 0,
    `provider should leave stream_error_evt emission to invalidFuncCall receiver, got: ${streamErrors.join('|')}`,
  );
}

async function testStreamedToolCallMissingNameWithoutRecoveryHookThrows(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);
  let caught = false;

  try {
    await consumeOpenAiCompatibleChatCompletionStreamForTest({
      stream: stream([
        chunk({
          delta: {
            tool_calls: [
              {
                index: 2,
                type: 'function',
                function: { arguments: '{}' },
              },
            ],
          },
          finishReason: 'tool_calls',
        }),
      ]),
      receiver,
      genseq: 67,
    });
  } catch (error: unknown) {
    caught = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(
        'OPENAI-COMPATIBLE missing streamed tool function name for callId=toolcall_67_2',
      ),
      `unexpected missing-name throw: ${message}`,
    );
  }

  assert(caught, 'expected missing streamed tool name without recovery hook to throw');
  assert(events.length === 0, `unexpected missing-name events: ${events.join('|')}`);
  assert(
    streamErrors
      .join('|')
      .includes('OPENAI-COMPATIBLE missing streamed tool function name for callId=toolcall_67_2'),
    `expected fallback stream error for missing tool name, got: ${streamErrors.join('|')}`,
  );
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

function completion(args: {
  toolCalls?: NonNullable<ChatCompletion.Choice['message']['tool_calls']>;
  reasoningDetails?: Array<{ type: string; text: string; [key: string]: string | number }>;
}): ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'kimi-k2.6',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          ...(args.reasoningDetails !== undefined
            ? { reasoning_details: args.reasoningDetails }
            : {}),
          tool_calls: args.toolCalls ?? [],
          refusal: null,
        },
      },
    ],
  };
}

function testBatchReasoningDetailsArePreserved(): void {
  const outputs = chatCompletionToBatchOutputsForTest(
    completion({
      reasoningDetails: [{ type: 'reasoning.text', text: 'batch thinking', index: 0 }],
    }),
    13,
  );
  const thinkingOutput = outputs.find(
    (output) => output.kind === 'message' && output.message.type === 'thinking_msg',
  );
  assert(thinkingOutput !== undefined, 'expected batch reasoning_details thinking message');
  assert(
    thinkingOutput.kind === 'message' && thinkingOutput.message.type === 'thinking_msg',
    'expected batch output to be a thinking message',
  );
  assert(
    thinkingOutput.message.content === 'batch thinking',
    'expected batch reasoning_details text to become thinking content',
  );
  assert(
    Array.isArray(thinkingOutput.message.provider_data?.['openai_compatible_reasoning_details']),
    'expected batch reasoning_details to be preserved in provider_data',
  );
}

function testBatchToolCallsUseOpenAiCompatibleRules(): void {
  const messages = chatCompletionToChatMessagesForTest(
    completion({
      toolCalls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'shell_cmd', arguments: '[]' },
        },
        {
          index: 1,
          type: 'function',
          function: { name: 'shell_cmd', arguments: '{}' },
        },
        {
          index: 2,
          function: { name: 'shell_cmd', arguments: '{"ok":true}' },
        },
      ],
    }),
    12,
  );
  const funcCalls = messages.filter((msg) => msg.type === 'func_call_msg');
  assert(funcCalls.length === 3, `expected three batch tool calls, got ${funcCalls.length}`);
  assert(
    funcCalls[0]?.id === 'call-1' && funcCalls[0].arguments === '[]',
    'expected batch arguments to pass through without object validation',
  );
  assert(
    funcCalls[1]?.id === 'toolcall_12_1' && funcCalls[2]?.id === 'toolcall_12_2',
    `expected missing batch ids to be synthesized, got ${funcCalls.map((msg) => msg.id).join('|')}`,
  );
}

function testBatchToolCallMissingNameIsLoud(): void {
  const outputs = chatCompletionToBatchOutputsForTest(
    completion({
      toolCalls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: '', arguments: '{}' },
        },
      ],
    }),
    13,
  );
  const invalid = outputs.find((output) => output.kind === 'invalid_func_call');
  assert(invalid !== undefined, 'expected missing batch tool function name to be surfaced loudly');
  assert(
    invalid.call.detail === 'OPENAI-COMPATIBLE missing tool function name for callId=call-1',
    `unexpected invalid batch tool call detail: ${invalid.call.detail}`,
  );
  assert(invalid.call.rawArgumentsText === '{}', 'expected raw arguments to be preserved');
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
  expected: string;
}): Promise<void> {
  const previous = process.env[args.provider.apiKeyEnvVar];
  process.env[args.provider.apiKeyEnvVar] = 'test-key';
  try {
    let caught = false;
    try {
      await new OpenAiCompatibleGen().genMoreMessages(
        args.provider,
        args.agent,
        '',
        [],
        {
          dialogSelfId: 'tests/provider/openai-compatible-volcengine-coding-plan',
          dialogRootId: 'tests/provider/openai-compatible-volcengine-coding-plan',
          providerKey: 'volcano-engine-coding-plan',
          modelKey: args.agent.model,
        },
        makePromptContext(),
        1,
      );
    } catch (error: unknown) {
      caught = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(
        message.includes(args.expected),
        `expected request build error to include ${args.expected}, got ${message}`,
      );
    }
    assert(caught, 'expected request build to fail before network call');
  } finally {
    if (previous === undefined) {
      delete process.env[args.provider.apiKeyEnvVar];
    } else {
      process.env[args.provider.apiKeyEnvVar] = previous;
    }
  }
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
    expected: 'thinking disabled conflicts with reasoning_effort=medium',
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
    assert(
      provider.model_param_options?.['openai-compatible']?.reasoning_split?.default === true,
      `${providerKey} should advertise reasoning_split=true`,
    );
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
    thinkingParams.thinking?.type === 'enabled',
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
    thinkingObjectParams.thinking === thinkingObject,
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
    minimaxThinkingBoolParams.thinking?.type === 'adaptive',
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
    minimaxThinkingFalseParams.thinking?.type === 'disabled',
    'expected MiniMax thinking=false to serialize as type=disabled',
  );

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
    assert(
      message.includes('thinking disabled conflicts with reasoning_effort=medium'),
      `unexpected disabled thinking conflict error: ${message}`,
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
  const gen = new OpenAiCompatibleGen();

  const debugRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-openai-compatible-400-'));
  const previousRejectedDir = process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
  try {
    process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = debugRoot;
    const wrapped = await wrapOpenAiCompatibleRejectedRequestErrorForTest({
      error: upstream,
      providerConfig: provider,
      agent,
      requestContext: buildOpenAiCompatibleRejectedRequestContext(),
      genseq: 43,
      requestKind: 'stream',
      payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'ping' }] },
    });

    const failure = gen.classifyFailure(wrapped);
    assert(failure?.kind === 'rejected', `expected rejected failure, got ${failure?.kind}`);
    assert(failure.status === 400, `expected status=400, got ${String(failure.status)}`);
    assert(
      failure.code === 'InvalidParameter',
      `expected InvalidParameter code, got ${String(failure.code)}`,
    );
    assert(
      failure.message.includes('requestPayloadPath='),
      'expected enriched rejected failure message to include requestPayloadPath',
    );
    assert(
      !failure.message.includes('requestPayload={'),
      'rejected failure message should not inline the full request payload',
    );

    const wrappedError = wrapped as Error & { requestPayloadPath?: string };
    assert(
      wrappedError.requestPayloadPath !== undefined,
      'expected wrapped error to carry requestPayloadPath',
    );
    const payloadText = await fs.readFile(wrappedError.requestPayloadPath, 'utf-8');
    const payloadJson: unknown = JSON.parse(payloadText);
    assert(
      typeof payloadJson === 'object' &&
        payloadJson !== null &&
        'model' in payloadJson &&
        payloadJson.model === 'kimi-k2.6',
      'expected debug payload file to preserve request model',
    );
    assert(
      typeof payloadJson === 'object' &&
        payloadJson !== null &&
        'messages' in payloadJson &&
        Array.isArray(payloadJson.messages) &&
        payloadJson.messages.length === 1,
      'expected debug payload file to preserve request messages',
    );
  } finally {
    if (previousRejectedDir === undefined) {
      delete process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
    } else {
      process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = previousRejectedDir;
    }
    await fs.rm(debugRoot, { recursive: true, force: true });
  }
}

async function testOpenAiCompatibleRejectedRequestSurvivesDebugCaptureFailure(): Promise<void> {
  const { agent, provider, upstream } = await buildOpenAiCompatibleRejectedRequestTestInput();
  const gen = new OpenAiCompatibleGen();

  const debugRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-openai-compatible-400-'));
  const debugFile = path.join(debugRoot, 'not-dir');
  await fs.writeFile(debugFile, 'not a directory', 'utf-8');
  const previousRejectedDir = process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
  try {
    process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = debugFile;
    const wrapped = await wrapOpenAiCompatibleRejectedRequestErrorForTest({
      error: upstream,
      providerConfig: provider,
      agent,
      requestContext: buildOpenAiCompatibleRejectedRequestContext(),
      genseq: 44,
      requestKind: 'stream',
      payload: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'ping' }] },
    });

    const failure = gen.classifyFailure(wrapped);
    assert(
      failure?.kind === 'rejected',
      `expected rejected failure after capture failure, got ${failure?.kind}`,
    );
    assert(failure.status === 400, `expected status=400, got ${String(failure.status)}`);
    assert(
      failure.message.includes('debugCaptureError='),
      'expected debugCaptureError when rejected request capture cannot be written',
    );
  } finally {
    if (previousRejectedDir === undefined) {
      delete process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR;
    } else {
      process.env.DOMINDS_OPENAI_COMPAT_REJECTED_DIR = previousRejectedDir;
    }
    await fs.rm(debugRoot, { recursive: true, force: true });
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
  testBatchReasoningDetailsArePreserved();
  testBatchToolCallsUseOpenAiCompatibleRules();
  testBatchToolCallMissingNameIsLoud();
  await testBuiltinVolcanoArkCodingPlanProvider();
  await testBuiltinMiniMaxProvidersUseOpenAiCompatibleReasoningDetails();
  testOpenAiCompatibleExtraParams();
  await testOpenAiCompatibleRejectedRequestKeepsFailureClassification();
  await testOpenAiCompatibleRejectedRequestSurvivesDebugCaptureFailure();
  console.log('✓ OpenAI-compatible Volcano Ark Coding Plan tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
