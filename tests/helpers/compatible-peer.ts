import assert from 'node:assert/strict';
import http from 'node:http';

export const compatiblePeerKey = 'DOMINDS_TEST_COMPATIBLE_PEER_KEY';
export type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  userAgent: string | undefined;
  body: Record<string, unknown>;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Wire responses are untrusted JSON, including deliberate protocol defects. They are
// never asserted to satisfy the SDK's stronger response type before the real SDK reads them.
export function wireCompletion(
  message: Record<string, unknown> = { role: 'assistant', content: 'ok' },
  finishReason = 'stop',
) {
  return {
    id: 'chatcmpl-local-peer',
    object: 'chat.completion',
    created: 1,
    model: 'peer-model',
    choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      completion_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 2,
    },
  };
}
export async function withCompatiblePeer<T>(
  response: unknown,
  run: (peer: {
    baseUrl: string;
    captured: CapturedRequest[];
    readonly requestCount: number;
  }) => Promise<T>,
  prefix = '/v1',
): Promise<T> {
  const captured: CapturedRequest[] = [],
    errors: unknown[] = [];
  let requestCount = 0;
  const server = http.createServer((request, reply) => {
    requestCount++;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', (error) => {
      errors.push(error);
      reply.destroy(error);
    });
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(isRecord(body));
        captured.push({
          method: request.method,
          url: request.url,
          userAgent: request.headers['user-agent'],
          body,
        });
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(response));
      } catch (error) {
        errors.push(error);
        reply.writeHead(500, { 'content-type': 'application/json' });
        reply.end(
          JSON.stringify({ error: { message: 'Controlled peer could not read the request' } }),
        );
      }
    });
  });
  server.on('error', (error) => errors.push(error));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const previous = process.env[compatiblePeerKey];
  process.env[compatiblePeerKey] = 'local-fixture-key';
  try {
    const value = await run({
      baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
      captured,
      get requestCount() {
        return requestCount;
      },
    });
    assert.deepEqual(errors, []);
    return value;
  } finally {
    if (previous === undefined) delete process.env[compatiblePeerKey];
    else process.env[compatiblePeerKey] = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
