import assert from 'node:assert/strict';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import { assertInvalidProviderHistories, providerHistory } from '../helpers/provider-context';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-projection-openai-');
async function main() {
  const { user, thinking, saying, call, result, context } = providerHistory();
  const original = structuredClone(context);
  const input = await buildOpenAiRequestInputWrapper(context);
  assert.deepEqual(
    input.map((item) => item.type),
    ['message', 'reasoning', 'message', 'function_call', 'function_call_output'],
  );
  const [userItem, reasoning, assistant, toolCall, output] = input;
  assert.ok(userItem?.type === 'message');
  assert.equal(userItem.role, 'user');
  assert.equal(userItem.content, user.content);
  assert.ok(reasoning?.type === 'reasoning');
  assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: thinking.content }]);
  assert.ok(assistant?.type === 'message');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, saying.content);
  assert.ok(toolCall?.type === 'function_call');
  assert.equal(toolCall.call_id, call.id);
  assert.equal(toolCall.name, call.name);
  assert.equal(toolCall.arguments, call.arguments);
  assert.ok(output?.type === 'function_call_output');
  assert.equal(output.call_id, result.id);
  assert.equal(output.output, result.content);
  assert.deepEqual(context, original);
  const rawArguments = '{"command":\n"opaque:7ae2';
  const malformed = await buildOpenAiRequestInputWrapper([
    user,
    { ...call, arguments: rawArguments },
    result,
  ]);
  const malformedCall = malformed.find((item) => item.type === 'function_call');
  assert.ok(malformedCall?.type === 'function_call');
  assert.equal(malformedCall.arguments, rawArguments);
  const malformedResult = malformed.find((item) => item.type === 'function_call_output');
  assert.ok(malformedResult?.type === 'function_call_output');
  assert.equal(malformedResult.output, result.content);

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
  const parallel = await buildOpenAiRequestInputWrapper([user, call, second, secondResult, result]);
  const calls = parallel.filter((item) => item.type === 'function_call');
  const results = parallel.filter((item) => item.type === 'function_call_output');
  assert.deepEqual(
    calls.map((item) => [item.call_id, item.name, item.arguments]),
    [
      [call.id, call.name, call.arguments],
      [second.id, second.name, second.arguments],
    ],
  );
  assert.deepEqual(
    results.map((item) => [item.call_id, item.output]),
    [
      [result.id, result.content],
      [secondResult.id, secondResult.content],
    ],
  );
  assert.deepEqual(
    parallel.map((item) => item.type),
    ['message', 'function_call', 'function_call_output', 'function_call', 'function_call_output'],
  );
  await assertInvalidProviderHistories('openai', buildOpenAiRequestInputWrapper, evidence);
  await evidence.write();
  console.log('OpenAI history data, pairing and rejection: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
