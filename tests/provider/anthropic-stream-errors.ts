import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import assert from 'node:assert/strict';
import type { ProviderConfig } from '../../main/llm/client';
import type { LlmStreamReceiver } from '../../main/llm/gen';
import { AnthropicGen, consumeAnthropicStream } from '../../main/llm/gen/anthropic';
import { Team } from '../../main/team';
import { anthropicMessageStart } from '../helpers/anthropic-stream';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const provider: ProviderConfig = {
  name: 'Supplied local Anthropic-compatible peer',
  apiType: 'anthropic-compatible',
  baseUrl: 'https://example.test/anthropic',
  apiKeyEnvVar: 'DOMINDS_TEST_ANTHROPIC_STREAM_KEY',
  models: { 'supplied-model-id': {} },
};
const evidence = semanticEvidenceCollector('dominds-provider-stream-errors-');
function receiver() {
  const errors: string[] = [];
  const thinking: string[] = [];
  let thinkingFinished = 0;
  const callbacks: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async (chunk) => {
      thinking.push(chunk);
    },
    thinkingFinish: async () => {
      thinkingFinished++;
    },
    sayingStart: async () => {},
    sayingChunk: async () => {},
    sayingFinish: async () => {},
    funcCall: async () => {},
    streamError: async (detail) => {
      errors.push(detail);
    },
  };
  return { callbacks, errors, thinking, thinkingFinished: () => thinkingFinished };
}
async function failed(
  id: string,
  scenario: string,
  run: () => Promise<unknown>,
  capture: ReturnType<typeof receiver>,
  expected?: Error,
) {
  let rejection: unknown;
  try {
    await run();
  } catch (error: unknown) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error, 'The actual operation must reject');
  if (rejection instanceof assert.AssertionError) throw rejection; // A fixture assertion is not an expected provider failure.
  if (expected)
    assert.equal(rejection, expected, 'The upstream read failure must retain its identity');
  evidence.record({
    id,
    scenario,
    businessValue:
      'A broken provider stream is reported once and cannot silently finish as a complete response.',
    context: {
      errorCount: capture.errors.length,
      thinkingData: JSON.stringify(capture.thinking),
      thinkingFinishCount: capture.thinkingFinished(),
      scope:
        'Actual stream consumer or compatible raw-SSE generator with intercepted fetch. No real vendor, SDK streaming transport, dialog persistence, UI delivery or recovery is established.',
    },
    reviewQuestions: [
      'Do the complete actual thrown error and receiver diagnostics accurately distinguish the supplied failure and avoid claiming a complete response?',
    ],
    actualText: JSON.stringify(
      { thrownError: rejection.message, receiverDiagnostics: capture.errors },
      null,
      2,
    ),
  });
}
async function mocked(response: Response, capture: ReturnType<typeof receiver>) {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env[provider.apiKeyEnvVar];
  let requests = 0;
  try {
    process.env[provider.apiKeyEnvVar] = 'supplied-local-key';
    globalThis.fetch = async (url, init) => {
      requests++;
      assert.equal(new URL(String(url)).hostname, 'example.test');
      assert.equal(init?.method, 'POST');
      assert.equal(typeof init?.body, 'string');
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(typeof body === 'object' && body !== null && 'model' in body && 'stream' in body);
      assert.equal(body.model, 'supplied-model-id');
      assert.equal(body.stream, true);
      return response;
    };
    await new AnthropicGen('anthropic-compatible').genToReceiver(
      provider,
      new Team.Member({ id: 'tester', name: 'Supplied tester', model: 'supplied-model-id' }),
      '',
      [],
      {
        dialogSelfId: 'self',
        dialogRootId: 'root',
        providerKey: 'local-peer',
        modelKey: 'supplied-model-id',
      },
      [
        {
          type: 'prompting_msg',
          role: 'user',
          genseq: 1,
          msgId: 'user-1',
          grammar: 'markdown',
          content: 'given-user-data:53cd',
        },
      ],
      capture.callbacks,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env[provider.apiKeyEnvVar];
    else process.env[provider.apiKeyEnvVar] = oldKey;
    assert.equal(
      requests,
      1,
      'Exercise one actual intercepted request, without a network fallback',
    );
  }
}
async function main() {
  const read = receiver();
  const readError = new SyntaxError('supplied-invalid-json-data: }');
  let finalized = false;
  async function* broken(): AsyncIterable<MessageStreamEvent> {
    try {
      yield anthropicMessageStart();
      throw readError;
    } finally {
      finalized = true;
    }
  }
  await failed(
    'read-error',
    'The supplied async iterator throws its actual SyntaxError after message_start.',
    () => consumeAnthropicStream(broken(), read.callbacks),
    read,
    readError,
  );
  assert.equal(read.errors.length, 1);
  assert.equal(finalized, true);

  const partial = receiver();
  async function* incomplete(): AsyncIterable<MessageStreamEvent> {
    yield anthropicMessageStart();
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    };
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'supplied-partial-data:8b19' },
    };
  }
  await failed(
    'incomplete-lifecycle',
    'Thinking data arrives but the iterator ends without content/message stop events.',
    () => consumeAnthropicStream(incomplete(), partial.callbacks),
    partial,
  );
  assert.equal(partial.errors.length, 1);
  assert.deepEqual(partial.thinking, ['supplied-partial-data:8b19']);
  assert.equal(partial.thinkingFinished(), 0);

  for (const [id, body, contentType] of [
    ['invalid-sse-json', 'event: content_block_delta\ndata: }\n\n', 'text/event-stream'],
    ['no-sse-frames', '{"error":"supplied-non-sse-body-data:37b2"}', 'application/json'],
  ] as const) {
    const capture = receiver();
    await failed(
      id,
      'An intercepted successful HTTP response supplies malformed SSE JSON or no SSE data frames: ' +
        body,
      () =>
        mocked(
          new Response(body, { status: 200, headers: { 'content-type': contentType } }),
          capture,
        ),
      capture,
    );
    assert.equal(capture.errors.length, 1);
  }
  const invalid = receiver();
  let streamRead = false;
  async function* unread(): AsyncIterable<MessageStreamEvent> {
    streamRead = true;
    yield anthropicMessageStart();
  }
  await failed(
    'invalid-genseq',
    'The caller supplies generation0; reject before iterating and do not blame a provider stream that was never read.',
    () => consumeAnthropicStream(unread(), invalid.callbacks, { genseq: 0 }),
    invalid,
  );
  assert.equal(streamRead, false);
  assert.deepEqual(invalid.errors, []);
  await evidence.write();
  console.log('Native stream failure propagation, incomplete lifecycle and raw SSE refusal: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
