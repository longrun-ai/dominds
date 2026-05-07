import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';

import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import {
  buildOpenAiCompatibleExtraParamsForTest,
  chatCompletionToChatMessagesForTest,
  consumeOpenAiCompatibleChatCompletionStreamForTest,
  OpenAiCompatibleGen,
} from '../../main/llm/gen/openai-compatible';
import { Team } from '../../main/team';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type ChunkDeltaExtra = {
  reasoning_content?: string;
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
          tool_calls: args.toolCalls ?? [],
          refusal: null,
        },
      },
    ],
  };
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
  let caught = false;
  try {
    chatCompletionToChatMessagesForTest(
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
  } catch (error: unknown) {
    caught = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes('OPENAI-COMPATIBLE malformed batch tool call'),
      `unexpected batch tool call error: ${message}`,
    );
    assert(message.includes('missing tool function name'), `unexpected detail: ${message}`);
  }
  assert(caught, 'expected missing batch tool function name to throw');
}

function requireProvider(provider: ProviderConfig | undefined): ProviderConfig {
  if (provider === undefined) {
    throw new Error('Expected volcano-engine-coding-plan provider');
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
      provider.apiQuirks.length === 1 &&
      provider.apiQuirks[0] === 'same-context-empty-response',
    'expected only same-context-empty-response Volcano Ark Coding Plan apiQuirk',
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

function testOpenAiCompatibleExtraParams(): void {
  const extraParams = buildOpenAiCompatibleExtraParamsForTest({
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'kimi-k2.6',
    }),
    openAiParams: {
      reasoning_effort: 'medium',
    },
  });
  assert(
    extraParams.reasoning_effort === 'medium',
    'expected reasoning_effort to be preserved without thinking flag',
  );
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

async function main(): Promise<void> {
  await testVolcanoArkAllowsSegmentAlternation();
  await testGenericAllowsSegmentAlternation();
  await testMissingToolCallTypeIsTolerated();
  await testMissingToolCallIdIsSynthesized();
  await testInvalidToolArgumentsPassThroughToToolCall();
  testBatchToolCallsUseOpenAiCompatibleRules();
  testBatchToolCallMissingNameIsLoud();
  await testBuiltinVolcanoArkCodingPlanProvider();
  testOpenAiCompatibleExtraParams();
  console.log('✓ OpenAI-compatible Volcano Ark Coding Plan tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
