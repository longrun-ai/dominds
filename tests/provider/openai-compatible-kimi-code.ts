import assert from 'assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';

import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { LlmConfig } from '../../main/llm/client';
import { OpenAiCompatibleGen } from '../../main/llm/gen/openai-compatible';
import { Team } from '../../main/team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../../main/tool';

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  userAgent: string | undefined;
  body: Record<string, unknown>;
};

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

function makeProvider(baseUrl: string): ProviderConfig {
  return {
    name: 'Kimi Code Test',
    apiType: 'openai-compatible',
    apiQuirks: ['kimi-code'],
    baseUrl,
    apiKeyEnvVar: 'KIMI_CODE_API_KEY',
    models: {
      'kimi-for-coding': {
        name: 'Kimi For Coding',
        supports_tool_choice: false,
      },
    },
  };
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

async function withCaptureServer<T>(
  run: (args: { baseUrl: string; captured: CapturedRequest[] }) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      const body: unknown = rawBody.trim().length > 0 ? JSON.parse(rawBody) : {};
      assert(typeof body === 'object' && body !== null && !Array.isArray(body));
      captured.push({
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
        body: body as Record<string, unknown>,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'chatcmpl-kimi-code-test',
          object: 'chat.completion',
          created: 1,
          model: 'kimi-for-coding',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}/coding/v1`;

  try {
    return await run({ baseUrl, captured });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function captureKimiCodeRequest(
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>,
  funcTools: FuncTool[] = [],
): Promise<CapturedRequest> {
  const previousApiKey = process.env.KIMI_CODE_API_KEY;
  process.env.KIMI_CODE_API_KEY = 'test-kimi-code-key';
  try {
    return await withCaptureServer(async ({ baseUrl, captured }) => {
      const provider = makeProvider(baseUrl);
      const agent = makeAgent(openAiCompatibleParams);
      await new OpenAiCompatibleGen().genMoreMessages(
        provider,
        agent,
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
      assert.equal(captured.length, 1);
      return captured[0];
    });
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.KIMI_CODE_API_KEY;
    } else {
      process.env.KIMI_CODE_API_KEY = previousApiKey;
    }
  }
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
  const request = await captureKimiCodeRequest({ thinking: 'auto' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/coding/v1/chat/completions');
  assert.match(request.userAgent ?? '', /^Dominds\/[^ ]+$/);
  assert.equal(request.userAgent?.startsWith('KimiCLI/'), false);
  assert.equal(request.userAgent?.startsWith('OpenAI/JS'), false);
  assert.equal(request.body.model, 'kimi-for-coding');
  assert.equal(request.body.prompt_cache_key, 'dialog-self:c3');
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'thinking'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'tool_choice'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'parallel_tool_calls'), false);
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
  const requestProperties = requestParameters.properties;
  assert(isRecord(requestProperties), 'expected first tool properties object');
  const truncateMode = requestProperties.truncateMode;
  assert(isRecord(truncateMode), 'expected truncateMode property object');
  assert.equal(truncateMode.type, 'string');
  const retryCount = requestProperties.retryCount;
  assert(isRecord(retryCount), 'expected retryCount property object');
  assert.equal(retryCount.type, 'integer');
  const nested = requestProperties.nested;
  assert(isRecord(nested), 'expected nested property object');
  assert.equal(nested.type, 'object');
  const nestedProperties = nested.properties;
  assert(isRecord(nestedProperties), 'expected nested properties object');
  const nestedMode = nestedProperties.mode;
  assert(isRecord(nestedMode), 'expected nested mode property object');
  assert.equal(nestedMode.type, 'string');
  const either = requestProperties.either;
  assert(isRecord(either), 'expected either property object');
  assert.equal(
    Object.prototype.hasOwnProperty.call(either, 'type'),
    false,
    'Kimi Code schema normalization must not add a top-level type to combinator properties',
  );
  assert(Array.isArray(either.anyOf), 'expected anyOf branches');
  assert.equal(either.anyOf.length, 2, 'expected two anyOf branches');
  const firstBranch = either.anyOf[0];
  assert(isRecord(firstBranch), 'expected first anyOf branch object');
  assert.equal(firstBranch.type, 'string');
  assert.equal(
    Object.prototype.hasOwnProperty.call(parameters.properties.truncateMode, 'type'),
    false,
    'Kimi Code schema normalization must not mutate the source tool schema',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(parameters.properties.nested, 'type'),
    false,
    'Kimi Code nested schema normalization must not mutate the source tool schema',
  );
}

async function expectKimiCodeRequestBuildError(args: {
  openAiCompatibleParams: NonNullable<Team.ModelParams['openai-compatible']>;
  expected: string;
}): Promise<void> {
  let caught = false;
  try {
    await captureKimiCodeRequest(args.openAiCompatibleParams);
  } catch (error: unknown) {
    caught = true;
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(args.expected));
  }
  assert.equal(caught, true, 'expected Kimi Code request build to fail before network success');
}

async function testKimiCodeValidation(): Promise<void> {
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'medium', reasoning_effort: 'high' },
    expected: 'thinking=medium conflicts with reasoning_effort=high',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'off', reasoning_effort: 'low' },
    expected: 'thinking=off conflicts with reasoning_effort=low',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { thinking: 'auto', reasoning_effort: 'low' },
    expected: 'thinking=auto conflicts with reasoning_effort=low',
  });
  await expectKimiCodeRequestBuildError({
    openAiCompatibleParams: { reasoning_effort: 'xhigh' },
    expected: 'reasoning_effort=xhigh is not supported',
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
  console.log('✓ OpenAI-compatible Kimi Code tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
