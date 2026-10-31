import assert from 'node:assert/strict';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { MINIMAX_REASONING_DETAILS_API_QUIRK } from '../../main/llm/api-quirks';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import { assertInvalidProviderHistories, providerHistory } from '../helpers/provider-context';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-projection-compatible-');
function provider(apiQuirks: string[]): ProviderConfig {
  return {
    name: 'projection-fixture',
    apiType: 'openai-compatible',
    apiQuirks,
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnvVar: 'UNUSED_FIXTURE_KEY',
    models: {},
  };
}
function assistant(value: ChatCompletionMessageParam | undefined): asserts value is Extract<
  ChatCompletionMessageParam,
  { role: 'assistant' }
> & {
  reasoning_content?: unknown;
  reasoning_details?: unknown;
} {
  assert.ok(value?.role === 'assistant');
}
async function main() {
  const { user, thinking, saying, call, result, context } = providerHistory();
  const original = structuredClone(context);
  const messages = await buildOpenAiCompatibleRequestMessagesWrapper('', context);
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'assistant', 'tool'],
  );
  assert.equal(messages[0]?.content, user.content);
  const visible = messages[1];
  assistant(visible);
  assert.equal(visible.content, saying.content);
  assert.equal(visible.reasoning_content, thinking.content);
  const nativeCall = messages[2];
  assistant(nativeCall);
  assert.equal(nativeCall.reasoning_content, thinking.content);
  assert.equal(Object.hasOwn(nativeCall, 'content'), false);
  assert.deepEqual(nativeCall.tool_calls, [
    { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } },
  ]);
  const tool = messages[3];
  assert.ok(tool?.role === 'tool');
  assert.equal(tool.tool_call_id, result.id);
  assert.equal(tool.content, result.content);
  assert.deepEqual(context, original);
  const rawArguments = '{"command":\n"opaque:7ae2';
  const malformed = await buildOpenAiCompatibleRequestMessagesWrapper('', [
    user,
    { ...call, arguments: rawArguments },
    result,
  ]);
  const malformedCall = malformed[1];
  assistant(malformedCall);
  assert.deepEqual(malformedCall.tool_calls, [
    {
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: rawArguments },
    },
  ]);
  const malformedResult = malformed[2];
  assert.ok(malformedResult?.role === 'tool');
  assert.equal(malformedResult.tool_call_id, result.id);
  assert.equal(malformedResult.content, result.content);

  const disabled = await buildOpenAiCompatibleRequestMessagesWrapper('', context, {
    providerConfig: provider(['disable-assistant-tool-call-reasoning-content']),
  });
  const disabledCall = disabled[2];
  assistant(disabledCall);
  assert.equal(disabledCall.reasoning_content, undefined);
  assert.deepEqual(disabledCall.tool_calls, nativeCall.tool_calls);
  const disabledVisible = disabled[1];
  assistant(disabledVisible);
  assert.equal(disabledVisible.reasoning_content, thinking.content);
  assert.equal(disabledVisible.content, saying.content);

  const details = [{ type: 'reasoning.text', text: 'provider-detail-data:f340\n保留', index: 0 }];
  const detailsContext: ChatMessage[] = [
    user,
    {
      ...thinking,
      type: 'thinking_msg',
      role: 'assistant',
      provider_data: { openai_compatible_reasoning_details: details },
    },
    saying,
  ];
  const generic = await buildOpenAiCompatibleRequestMessagesWrapper('', detailsContext);
  const genericAssistant = generic[1];
  assistant(genericAssistant);
  assert.equal(genericAssistant.reasoning_content, thinking.content);
  const minimax = await buildOpenAiCompatibleRequestMessagesWrapper('', detailsContext, {
    providerConfig: provider([MINIMAX_REASONING_DETAILS_API_QUIRK]),
  });
  const preserved = minimax[1];
  assistant(preserved);
  assert.deepEqual(preserved.reasoning_details, details);
  assert.equal(preserved.content, saying.content);

  const second = {
    ...call,
    id: 'call-2',
    name: 'inspect_data',
    arguments: '{"selector":"second"}',
  };
  const secondResult = {
    ...result,
    id: second.id,
    name: second.name,
    content: 'second-result-data:316e',
  };
  const parallelContext: ChatMessage[] = [
    user,
    thinking,
    saying,
    call,
    second,
    secondResult,
    result,
  ];
  const parallel = await buildOpenAiCompatibleRequestMessagesWrapper('', parallelContext);
  const projectedCalls = parallel.flatMap((message) =>
    message.role === 'assistant' ? (message.tool_calls ?? []) : [],
  );
  const projectedResults = parallel.filter((message) => message.role === 'tool');
  assert.deepEqual(
    projectedCalls.map((item) => {
      assert.ok(item.type === 'function');
      return [item.id, item.function.name, item.function.arguments];
    }),
    [
      [call.id, call.name, call.arguments],
      [second.id, second.name, second.arguments],
    ],
  );
  assert.deepEqual(
    projectedResults.map((item) => [item.tool_call_id, item.content]),
    [
      [result.id, result.content],
      [secondResult.id, secondResult.content],
    ],
  );
  for (const message of parallel)
    if (message.role === 'assistant' && message.tool_calls) {
      assistant(message);
      assert.equal(message.reasoning_content, thinking.content);
    }
  await assertInvalidProviderHistories(
    'compatible',
    (input) => buildOpenAiCompatibleRequestMessagesWrapper('', input),
    evidence,
  );
  await evidence.write();
  console.log('Compatible history, reasoning options and rejection: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
