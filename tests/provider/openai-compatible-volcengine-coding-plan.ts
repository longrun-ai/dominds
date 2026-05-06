import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import { LlmStreamErrorEmittedError, type LlmStreamReceiver } from '../../main/llm/gen';
import {
  buildOpenAiCompatibleExtraParamsForTest,
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

async function expectStreamError(run: () => Promise<void>, expected: string): Promise<void> {
  let caught = false;
  try {
    await run();
  } catch (error: unknown) {
    caught = true;
    assert(error instanceof LlmStreamErrorEmittedError, 'expected LlmStreamErrorEmittedError');
    assert(
      error.message.includes(expected),
      `expected error to include ${expected}, got ${error.message}`,
    );
  }
  assert(caught, 'expected stream error to be thrown');
}

async function testVolcengineAllowsSegmentAlternation(): Promise<void> {
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
    isVolcengineCodingPlan: true,
  });

  assert(
    events.join('|') ===
      'thinkingStart|thinking:先想。|thinkingFinish|sayingStart|saying:先说。|sayingFinish|thinkingStart|thinking:再想。|thinkingFinish|funcCall:call-1:shell_cmd:{"command":"ls"}',
    `unexpected events: ${events.join('|')}`,
  );
  assert(streamErrors.length === 0, `unexpected stream errors: ${streamErrors.join('|')}`);
}

async function testGenericStillReportsOverlap(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await expectStreamError(async () => {
    await consumeOpenAiCompatibleChatCompletionStreamForTest({
      stream: stream([
        chunk({ delta: { reasoning_content: 'thinking' } }),
        chunk({ delta: { content: 'content' }, finishReason: 'stop' }),
      ]),
      receiver,
      genseq: 8,
      isVolcengineCodingPlan: false,
    });
  }, 'stream overlap violation');
  assert(
    streamErrors.some((detail) => detail.includes('stream overlap violation')),
    'generic openai-compatible stream should report overlap',
  );
  assert(streamErrors.length === 1, `expected one stream error, got ${streamErrors.join('|')}`);
}

async function testVolcengineRequiresToolCallType(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await expectStreamError(async () => {
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
      isVolcengineCodingPlan: true,
    });
  }, 'missing streamed tool call type=function');
  assert(
    streamErrors.some((detail) => detail.includes('missing streamed tool call type=function')),
    'expected stream error detail for missing tool call type',
  );
}

async function testVolcengineRequiresObjectToolArguments(): Promise<void> {
  const events: string[] = [];
  const streamErrors: string[] = [];
  const receiver = makeReceiver(events, streamErrors);

  await expectStreamError(async () => {
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
      isVolcengineCodingPlan: true,
    });
  }, 'expected JSON object');
  assert(
    streamErrors.some((detail) => detail.includes('expected JSON object')),
    'expected stream error detail for non-object tool arguments',
  );
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
      msgId: 'volcengine-config-test',
      content: 'hello',
      grammar: 'markdown',
    },
  ];
}

async function expectRequestBuildError(args: {
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

async function testBuiltinVolcengineCodingPlanProvider(): Promise<void> {
  const cfg = await LlmConfig.load();
  const provider = requireProvider(cfg.getProvider('volcano-engine-coding-plan'));
  assert(provider.apiType === 'openai-compatible', 'expected openai-compatible apiType');
  assert(
    provider.apiQuirks === 'volcengine-coding-plan',
    'expected volcengine-coding-plan apiQuirks',
  );
  assert(
    provider.baseUrl === 'https://ark.cn-beijing.volces.com/api/coding/v3',
    `unexpected baseUrl: ${provider.baseUrl}`,
  );
  assert(
    !Object.prototype.hasOwnProperty.call(provider.models, 'ark-code-latest'),
    'ark-code-latest must not be a built-in Volcano Coding Plan model',
  );
  assert(
    Object.prototype.hasOwnProperty.call(provider.models, 'minimax-m2.7'),
    'expected minimax-m2.7 concrete provider model key',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(provider.models, 'minimax-latest'),
    'floating minimax-latest key should not remain in Volcano Coding Plan provider',
  );

  await expectRequestBuildError({
    provider,
    agent: new Team.Member({ id: 'tester', name: 'Tester', model: 'ark-code-latest' }),
    expected: 'only supports concrete Coding Plan model names',
  });

  await expectRequestBuildError({
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
    expected: 'thinking=false conflicts with reasoning_effort=medium',
  });
}

async function testThinkingParamRequiresVolcengineQuirk(): Promise<void> {
  const provider: ProviderConfig = {
    name: 'Generic OpenAI Compatible',
    apiType: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnvVar: 'GENERIC_OPENAI_COMPATIBLE_TEST_KEY',
    models: {
      'generic-model': {
        name: 'Generic Model',
      },
    },
  };
  await expectRequestBuildError({
    provider,
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'generic-model',
      model_params: {
        'openai-compatible': {
          thinking: true,
        },
      },
    }),
    expected: 'requires apiQuirks=volcengine-coding-plan',
  });
}

async function testReasoningEffortRequiresVolcengineQuirk(): Promise<void> {
  const provider: ProviderConfig = {
    name: 'Generic OpenAI Compatible',
    apiType: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnvVar: 'GENERIC_OPENAI_COMPATIBLE_TEST_KEY',
    models: {
      'generic-model': {
        name: 'Generic Model',
      },
    },
  };
  await expectRequestBuildError({
    provider,
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'generic-model',
      model_params: {
        'openai-compatible': {
          reasoning_effort: 'medium',
        },
      },
    }),
    expected: 'model_params.openai-compatible.reasoning_effort',
  });
}

async function testReasoningEffortRequiresThinkingCapableModel(): Promise<void> {
  const provider: ProviderConfig = {
    name: 'Volcano Test Provider',
    apiType: 'openai-compatible',
    apiQuirks: 'volcengine-coding-plan',
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnvVar: 'VOLCENGINE_TEST_KEY',
    models: {
      'plain-model': {
        name: 'Plain Model',
      },
    },
  };
  await expectRequestBuildError({
    provider,
    agent: new Team.Member({
      id: 'tester',
      name: 'Tester',
      model: 'plain-model',
      model_params: {
        'openai-compatible': {
          reasoning_effort: 'medium',
        },
      },
    }),
    expected: 'supports_thinking=true',
  });
}

async function testVolcengineAllowsReasoningEffortWithoutThinkingFlag(): Promise<void> {
  const cfg = await LlmConfig.load();
  const provider = requireProvider(cfg.getProvider('volcano-engine-coding-plan'));
  const extraParams = buildOpenAiCompatibleExtraParamsForTest({
    providerConfig: provider,
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
}

async function main(): Promise<void> {
  await testVolcengineAllowsSegmentAlternation();
  await testGenericStillReportsOverlap();
  await testVolcengineRequiresToolCallType();
  await testVolcengineRequiresObjectToolArguments();
  await testBuiltinVolcengineCodingPlanProvider();
  await testThinkingParamRequiresVolcengineQuirk();
  await testReasoningEffortRequiresVolcengineQuirk();
  await testReasoningEffortRequiresThinkingCapableModel();
  await testVolcengineAllowsReasoningEffortWithoutThinkingFlag();
  console.log('✓ OpenAI-compatible Volcano Coding Plan quirk tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
