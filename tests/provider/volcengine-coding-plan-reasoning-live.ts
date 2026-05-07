import type { ReasoningPayload } from '@longrun-ai/kernel/types/storage';

import type { ChatMessage } from '../../main/llm/client';
import { LlmConfig, type ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { generatorsRegistry } from '../../main/llm/gen/registry';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';

type Capture = {
  events: string[];
  thinkingChunkCount: number;
  sayingChunkCount: number;
  thinkingText: string;
  thinkingReasoning?: ReasoningPayload;
  currentThinkingText: string;
  currentThinkingReasoning?: ReasoningPayload;
  sayingText: string;
  currentSayingText: string;
  calls: Array<{ id: string; name: string; args: string }>;
  messages: ChatMessage[];
  streamErrors: string[];
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeCapture(): Capture {
  return {
    events: [],
    thinkingChunkCount: 0,
    sayingChunkCount: 0,
    thinkingText: '',
    currentThinkingText: '',
    sayingText: '',
    currentSayingText: '',
    calls: [],
    messages: [],
    streamErrors: [],
  };
}

function makeReceiver(capture: Capture): LlmStreamReceiver {
  return {
    thinkingStart: async () => {
      capture.events.push('thinkingStart');
      capture.currentThinkingText = '';
      capture.currentThinkingReasoning = undefined;
    },
    thinkingChunk: async (chunk) => {
      capture.thinkingChunkCount += 1;
      capture.thinkingText += chunk;
      capture.currentThinkingText += chunk;
    },
    thinkingFinish: async (reasoning) => {
      capture.events.push('thinkingFinish');
      capture.thinkingReasoning = reasoning;
      capture.currentThinkingReasoning = reasoning;
      if (capture.currentThinkingText.length > 0 || reasoning !== undefined) {
        capture.messages.push({
          type: 'thinking_msg',
          role: 'assistant',
          genseq: 0,
          content: capture.currentThinkingText,
          reasoning,
        });
      }
      capture.currentThinkingText = '';
      capture.currentThinkingReasoning = undefined;
    },
    sayingStart: async () => {
      capture.events.push('sayingStart');
      capture.currentSayingText = '';
    },
    sayingChunk: async (chunk) => {
      capture.sayingChunkCount += 1;
      capture.sayingText += chunk;
      capture.currentSayingText += chunk;
    },
    sayingFinish: async () => {
      capture.events.push('sayingFinish');
      if (capture.currentSayingText.length > 0) {
        capture.messages.push({
          type: 'saying_msg',
          role: 'assistant',
          genseq: 0,
          content: capture.currentSayingText,
        });
      }
      capture.currentSayingText = '';
    },
    funcCall: async (id, name, args) => {
      capture.events.push(`funcCall:${name}`);
      capture.calls.push({ id, name, args });
      capture.messages.push({
        type: 'func_call_msg',
        role: 'assistant',
        genseq: 0,
        id,
        name,
        arguments: args,
      });
    },
    streamError: async (detail) => {
      capture.events.push('streamError');
      capture.streamErrors.push(detail);
    },
  };
}

function echoTool(): FuncTool {
  return {
    type: 'func',
    name: 'tool_echo',
    description: 'Echo a short string value.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    call: async () => {
      throw new Error('tool_echo should not execute in live reasoning test');
    },
  };
}

function getGen(provider: ProviderConfig) {
  const gen = generatorsRegistry.get(provider.apiType);
  if (!gen) throw new Error(`generator '${provider.apiType}' not registered`);
  return gen;
}

function makeAgent(model: string): Team.Member {
  return new Team.Member({
    id: 'volc-reasoning-live',
    name: 'Volc Reasoning Live',
    provider: 'volcano-engine-coding-plan',
    model,
    model_params: {
      'openai-compatible': {
        temperature: 0,
        thinking: true,
        parallel_tool_calls: false,
      },
    },
  });
}

async function runGen(args: {
  provider: ProviderConfig;
  model: string;
  context: ChatMessage[];
  tools: FuncTool[];
  genseq: number;
}): Promise<Capture> {
  const capture = makeCapture();
  await getGen(args.provider).genToReceiver(
    args.provider,
    makeAgent(args.model),
    'You are a concise test assistant. Use tools exactly when requested.',
    args.tools,
    {
      dialogSelfId: 'tests/provider/volcengine-coding-plan-reasoning-live',
      dialogRootId: 'tests/provider/volcengine-coding-plan-reasoning-live',
      providerKey: 'volcano-engine-coding-plan',
      modelKey: args.model,
    },
    args.context,
    makeReceiver(capture),
    args.genseq,
  );
  return capture;
}

function buildAssistantMessagesFromCapture(capture: Capture, genseq: number): ChatMessage[] {
  return capture.messages.map((message) => ({ ...message, genseq }));
}

async function testDeepSeekThinking(provider: ProviderConfig): Promise<void> {
  const model = 'deepseek-v3.2';
  const startedAt = Date.now();
  const capture = await runGen({
    provider,
    model,
    tools: [],
    genseq: 11,
    context: [
      {
        type: 'prompting_msg',
        role: 'user',
        genseq: 11,
        msgId: 'deepseek-thinking-live',
        grammar: 'markdown',
        content: 'Think briefly, then answer exactly: DEEPSEEK_DONE',
      },
    ],
  });
  const elapsedMs = Date.now() - startedAt;
  const result = {
    model,
    elapsedMs,
    thinkingChars: capture.thinkingText.length,
    thinkingChunkCount: capture.thinkingChunkCount,
    sayingText: capture.sayingText,
    sayingChunkCount: capture.sayingChunkCount,
    events: capture.events,
    streamErrors: capture.streamErrors,
  };
  console.log(JSON.stringify({ deepseekThinking: result }));
  assert(capture.streamErrors.length === 0, 'deepseek thinking produced stream errors');
  assert(capture.thinkingText.length > 0, 'deepseek-v3.2 did not emit reasoning_content');
  assert(
    capture.sayingText.includes('DEEPSEEK_DONE'),
    `deepseek-v3.2 final text mismatch: ${capture.sayingText}`,
  );
}

async function testAlternatingThinking(provider: ProviderConfig): Promise<void> {
  const model = 'minimax-m2.7';
  const firstUser: ChatMessage = {
    type: 'prompting_msg',
    role: 'user',
    genseq: 21,
    msgId: 'alternating-thinking-tool-live',
    grammar: 'markdown',
    content:
      'Think briefly, then call tool_echo with value="phase1". Do not provide the final answer yet.',
  };

  const firstStartedAt = Date.now();
  const first = await runGen({
    provider,
    model,
    tools: [echoTool()],
    genseq: 21,
    context: [firstUser],
  });
  const firstElapsedMs = Date.now() - firstStartedAt;
  assert(first.streamErrors.length === 0, 'alternating first turn produced stream errors');
  assert(first.thinkingText.length > 0, 'alternating first turn did not emit thinking');
  assert(first.calls.length === 1, `expected one tool call, got ${String(first.calls.length)}`);

  const firstCall = first.calls[0];
  const contextAfterTool: ChatMessage[] = [
    firstUser,
    ...buildAssistantMessagesFromCapture(first, 21),
    {
      type: 'func_result_msg',
      role: 'tool',
      genseq: 21,
      id: firstCall.id,
      name: firstCall.name,
      content: 'tool_echo returned phase1. Now think briefly and answer exactly: ALT_DONE',
    },
  ];

  const secondStartedAt = Date.now();
  const second = await runGen({
    provider,
    model,
    tools: [echoTool()],
    genseq: 22,
    context: contextAfterTool,
  });
  const secondElapsedMs = Date.now() - secondStartedAt;
  const result = {
    model,
    first: {
      elapsedMs: firstElapsedMs,
      thinkingChars: first.thinkingText.length,
      thinkingChunkCount: first.thinkingChunkCount,
      sayingText: first.sayingText,
      sayingChunkCount: first.sayingChunkCount,
      callCount: first.calls.length,
      calls: first.calls,
      events: first.events,
      streamErrors: first.streamErrors,
    },
    second: {
      elapsedMs: secondElapsedMs,
      thinkingChars: second.thinkingText.length,
      thinkingChunkCount: second.thinkingChunkCount,
      sayingText: second.sayingText,
      sayingChunkCount: second.sayingChunkCount,
      callCount: second.calls.length,
      calls: second.calls,
      events: second.events,
      streamErrors: second.streamErrors,
    },
  };
  console.log(JSON.stringify({ alternatingThinking: result }));
  assert(second.streamErrors.length === 0, 'alternating second turn produced stream errors');
  assert(second.thinkingText.length > 0, 'alternating second turn did not emit thinking');
  assert(
    second.sayingText.includes('ALT_DONE'),
    `alternating second turn final text mismatch: ${second.sayingText}`,
  );
}

async function main(): Promise<void> {
  const provider = (await LlmConfig.load()).getProvider('volcano-engine-coding-plan');
  if (!provider) throw new Error('provider volcano-engine-coding-plan not found');
  if (!process.env[provider.apiKeyEnvVar]) {
    throw new Error(`missing ${provider.apiKeyEnvVar}`);
  }

  await testDeepSeekThinking(provider);
  await testAlternatingThinking(provider);
  console.log('✓ Volcano Ark Coding Plan reasoning live tests passed');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
