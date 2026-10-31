import assert from 'node:assert/strict';

import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { LlmConfig } from '../../main/llm/client';
import type { LlmBatchResult } from '../../main/llm/gen';
import { OpenAiCompatibleGen } from '../../main/llm/gen/openai-compatible';
import { DOMINDS_RUNNING_VERSION } from '../../main/server/dominds-running-version';
import { Team } from '../../main/team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../../main/tool';

import {
  compatiblePeerKey,
  wireCompletion,
  withCompatiblePeer,
  type CapturedRequest,
} from '../helpers/compatible-peer';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-compatible-kimi-');

function makePromptContext(): ChatMessage[] {
  return [
    {
      type: 'prompting_msg',
      role: 'user',
      genseq: 1,
      msgId: 'kimi-code-config-test',
      content: 'hello',
      grammar: 'markdown',
    },
  ];
}

async function makeProvider(baseUrl: string): Promise<ProviderConfig> {
  const config = await LlmConfig.load();
  const builtin = config.getProvider('kimi-code');
  assert.ok(builtin);
  return { ...builtin, baseUrl, apiKeyEnvVar: compatiblePeerKey };
}

function makeAgent(
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>,
): Team.Member {
  return new Team.Member({
    id: 'tester',
    name: 'Tester',
    model: 'kimi-for-coding',
    model_params: {
      'openai-compatible': openAiCompatibleParams,
    },
  });
}

async function captureKimiCodeExchange(
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>,
  funcTools: FuncTool[] = [],
): Promise<{ request: CapturedRequest; result: LlmBatchResult }> {
  return await withCompatiblePeer(
    wireCompletion(),
    async (peer) => {
      const provider = await makeProvider(peer.baseUrl);
      const result = await new OpenAiCompatibleGen().genMoreMessages(
        provider,
        makeAgent(openAiCompatibleParams),
        '',
        funcTools,
        {
          dialogSelfId: 'dialog-self',
          dialogRootId: 'dialog-root',
          providerKey: 'kimi-code',
          modelKey: 'kimi-for-coding',
          promptCacheKey: 'dialog-self:c3',
        },
        makePromptContext(),
        1,
      );
      assert.equal(peer.requestCount, 1);
      assert.equal(peer.captured.length, 1);
      return { request: peer.captured[0]!, result };
    },
    '/coding/v1',
  );
}

async function captureKimiCodeRequest(
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>,
  funcTools: FuncTool[] = [],
): Promise<CapturedRequest> {
  const exchange = await captureKimiCodeExchange(openAiCompatibleParams, funcTools);
  return exchange.request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function testBuiltinKimiCodeProvider(): Promise<void> {
  const cfg = await LlmConfig.load();
  const provider = cfg.getProvider('kimi-code');
  assert(provider !== undefined, 'expected built-in kimi-code provider');
  assert.equal(provider.apiType, 'openai-compatible');
  assert.deepEqual(provider.apiQuirks, ['kimi-code', 'kimi-cli-cloak']);
  assert.equal(provider.baseUrl, 'https://api.kimi.com/coding/v1');
  assert.equal(provider.apiKeyEnvVar, 'KIMI_CODE_API_KEY');
  assert.deepEqual(Object.keys(provider.models), ['kimi-for-coding']);
  assert.equal(provider.models['kimi-for-coding']?.supports_tool_choice, false);
  const thinkingOption = provider.model_param_options?.['openai-compatible']?.thinking;
  assert.equal(thinkingOption?.type, 'enum');
  assert.deepEqual(thinkingOption?.type === 'enum' ? thinkingOption.values : undefined, [
    'auto',
    'off',
    'low',
    'medium',
    'high',
  ]);
}

async function testKimiCodeAutoThinkingPayload(): Promise<void> {
  const { request, result } = await captureKimiCodeExchange({ thinking: 'auto' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/coding/v1/chat/completions');
  assert.equal(request.userAgent, `KimiCLI/Dominds/${DOMINDS_RUNNING_VERSION}`);
  assert.equal(request.body.model, 'kimi-for-coding');
  assert.equal(request.body.prompt_cache_key, 'dialog-self:c3');
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'thinking'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'tool_choice'), false);
  assert.equal(request.body.parallel_tool_calls, true);
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0]?.type === 'saying_msg');
  assert.equal(result.messages[0].content, 'ok');
  assert.equal(result.llmGenModel, 'peer-model');
  assert.deepEqual(result.usage, {
    kind: 'available',
    promptTokens: 1,
    completionTokens: 1,
    reasoningTokens: 1,
    totalTokens: 2,
  });
}

async function testKimiCodeThinkingHighPayload(): Promise<void> {
  const request = await captureKimiCodeRequest({ thinking: 'high' });
  assert.deepEqual(request.body.thinking, { type: 'enabled' });
  assert.equal(request.body.reasoning_effort, 'high');
  assert.equal(request.body.prompt_cache_key, 'dialog-self:c3');
}

async function testKimiCodeThinkingOffPayload(): Promise<void> {
  const request = await captureKimiCodeRequest({ thinking: 'off' });
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort'), false);
}

async function testKimiCodeReasoningEffortPayload(): Promise<void> {
  const request = await captureKimiCodeRequest({ reasoning_effort: 'low' });
  assert.deepEqual(request.body.thinking, { type: 'enabled' });
  assert.equal(request.body.reasoning_effort, 'low');
}

async function testKimiCodeExplicitParallelToolCallsPayload(): Promise<void> {
  const request = await captureKimiCodeRequest({ thinking: 'auto', parallel_tool_calls: false });
  assert.equal(request.body.parallel_tool_calls, false);
}

async function testKimiCodeNormalizesToolSchemaPropertyTypes(): Promise<void> {
  const parameters = {
    type: 'object',
    properties: {
      truncateMode: {
        description: 'How to truncate long outputs.',
        enum: ['smart', 'full', 'none'],
      },
      retryCount: {
        enum: [1, 2, 3],
      },
      nested: {
        properties: {
          mode: {
            const: 'fast',
          },
        },
      },
      either: {
        anyOf: [{ enum: ['a', 'b'] }, { type: 'integer' }],
      },
    },
  } as const;
  const originalSchema = structuredClone(parameters);
  const tool: FuncTool = {
    type: 'func',
    name: 'read_context',
    description: 'Read context.',
    parameters,
    async call(_dlg, _caller, _args: ToolArguments): Promise<ToolCallOutput> {
      return { outcome: 'success', content: 'ok' };
    },
  };
  const request = await captureKimiCodeRequest({ thinking: 'auto' }, [tool]);
  assert(Array.isArray(request.body.tools), 'expected tools in Kimi Code request');
  const firstTool = request.body.tools[0];
  assert(isRecord(firstTool), 'expected first tool object');
  const firstFunction = firstTool.function;
  assert(isRecord(firstFunction), 'expected first tool function object');
  const requestParameters = firstFunction.parameters;
  assert(isRecord(requestParameters), 'expected first tool parameters object');
  assert.equal(request.body.tools.length, 1);
  assert.equal(firstTool.type, 'function');
  assert.equal(firstFunction.name, tool.name);
  assert.equal(firstFunction.description, tool.description);
  assert.deepEqual(requestParameters, {
    ...parameters,
    properties: {
      truncateMode: { ...parameters.properties.truncateMode, type: 'string' },
      retryCount: { ...parameters.properties.retryCount, type: 'integer' },
      nested: {
        ...parameters.properties.nested,
        type: 'object',
        properties: { mode: { ...parameters.properties.nested.properties.mode, type: 'string' } },
      },
      either: { anyOf: [{ enum: ['a', 'b'], type: 'string' }, { type: 'integer' }] },
    },
  });
  assert.deepEqual(parameters, originalSchema);
}

async function expectKimiCodeRequestBuildError(args: {
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>;
  id: string;
}): Promise<void> {
  await withCompatiblePeer(
    wireCompletion(),
    async (peer) => {
      const provider = await makeProvider(peer.baseUrl);
      let observed: Error | undefined;
      await assert.rejects(
        async () => {
          await new OpenAiCompatibleGen().genMoreMessages(
            provider,
            makeAgent(args.openAiCompatibleParams),
            '',
            [],
            {
              dialogSelfId: 'kimi-validation',
              dialogRootId: 'kimi-validation',
              providerKey: 'kimi-code',
              modelKey: 'kimi-for-coding',
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
      evidence.record({
        id: args.id,
        scenario:
          'Kimi request construction rejects conflicting or unsupported supplied reasoning parameters before contacting the local peer.',
        businessValue:
          'Reject unusable provider configuration before consuming a request and explain which input needs correction.',
        context: {
          parameters: JSON.stringify(args.openAiCompatibleParams),
          requestsReceived: peer.requestCount,
          scope:
            'Real SDK request construction with a controlled local HTTP peer. No vendor service is contacted.',
        },
        reviewQuestions: [
          'Does the actual refusal describe these supplied options accurately and give a useful correction without pretending a provider request ran?',
        ],
        actualText: `${observed.name}: ${observed.message}`,
      });
    },
    '/coding/v1',
  );
}

async function testKimiCodeValidation(): Promise<void> {
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'medium', reasoning_effort: 'high' },
    id: 'medium-high-conflict',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'off', reasoning_effort: 'low' },
    id: 'off-low-conflict',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'auto', reasoning_effort: 'low' },
    id: 'auto-low-conflict',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { reasoning_effort: 'xhigh' },
    id: 'unsupported-xhigh',
  });
}

async function main(): Promise<void> {
  await testBuiltinKimiCodeProvider();
  await testKimiCodeAutoThinkingPayload();
  await testKimiCodeThinkingHighPayload();
  await testKimiCodeThinkingOffPayload();
  await testKimiCodeReasoningEffortPayload();
  await testKimiCodeExplicitParallelToolCallsPayload();
  await testKimiCodeNormalizesToolSchemaPropertyTypes();
  await testKimiCodeValidation();
  await evidence.write();
  console.log('OpenAI-compatible Kimi Code tests: PASS');
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
