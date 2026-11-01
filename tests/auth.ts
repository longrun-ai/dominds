import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import {
  computeAuthConfig,
  formatAutoAuthUrl,
  formatServerOrigin,
  getHttpAuthCheck,
  getHttpAuthCheckAllowUrlParam,
  getWebSocketAuthCheck,
} from '../main/server/auth';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

function reqWithHeaders(headers: Record<string, string>): IncomingMessage {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.headers = headers;
  socket.destroy(); // An unconnected native request fixture owns no network handle.
  return request;
}

async function run(): Promise<void> {
  const evidence = semanticEvidenceCollector('dominds-server-auth-');
  {
    const auth = computeAuthConfig({ mode: 'development', env: { DOMINDS_AUTH_KEY: 'x' } });
    assert.deepEqual(auth, { kind: 'disabled' });
  }

  {
    const auth = computeAuthConfig({ mode: 'production', env: {} });
    assert.equal(auth.kind, 'enabled');
    assert.equal(auth.source, 'generated');
    assert.ok(auth.key.length > 0);
    assert.deepEqual(
      getHttpAuthCheck(reqWithHeaders({ authorization: 'Bearer ' + auth.key }), auth),
      { kind: 'ok' },
    );
    assert.deepEqual(
      getWebSocketAuthCheck(
        reqWithHeaders({ 'sec-websocket-protocol': 'dominds, dominds-auth.' + auth.key }),
        auth,
      ),
      { kind: 'ok' },
    );
  }

  {
    const auth = computeAuthConfig({ mode: 'production', env: { DOMINDS_AUTH_KEY: '' } });
    assert.deepEqual(auth, { kind: 'disabled' });
  }

  {
    const auth = computeAuthConfig({ mode: 'production', env: { DOMINDS_AUTH_KEY: 'abc' } });
    assert.deepEqual(auth, { kind: 'enabled', key: 'abc', source: 'env' });
  }

  {
    assert.throws(
      () => computeAuthConfig({ mode: 'production', env: { DOMINDS_AUTH_KEY: 'not token safe' } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        evidence.record({
          id: 'invalid-token-input',
          scenario:
            'Production startup is given an auth token containing spaces, which cannot travel as a WebSocket subprotocol token.',
          businessValue:
            'An operator learns why a configured shared key cannot be used consistently across HTTP and browser WebSocket authentication.',
          context: {
            mode: 'production',
            suppliedToken: 'not token safe',
            scope:
              'Actual configuration resolver only, no listening server, browser or cryptographic timing/entropy claim.',
          },
          reviewQuestions: [
            'Does the actual refusal accurately identify the invalid configured token and its transport constraint?',
          ],
          actualText: error.message,
        });
        return true;
      },
    );
  }

  {
    const auth = { kind: 'enabled', key: 'abc', source: 'env' } as const;
    assert.deepEqual(getHttpAuthCheck(reqWithHeaders({}), auth), {
      kind: 'unauthorized',
      reason: 'missing',
    });
    assert.deepEqual(getHttpAuthCheck(reqWithHeaders({ authorization: 'Bearer abc' }), auth), {
      kind: 'ok',
    });
    assert.deepEqual(getHttpAuthCheck(reqWithHeaders({ authorization: 'Bearer wrong' }), auth), {
      kind: 'unauthorized',
      reason: 'invalid',
    });
  }

  {
    const auth = { kind: 'enabled', key: 'abc', source: 'env' } as const;
    assert.deepEqual(
      getWebSocketAuthCheck(
        reqWithHeaders({ 'sec-websocket-protocol': `dominds, dominds-auth.abc` }),
        auth,
      ),
      { kind: 'ok' },
    );
    assert.deepEqual(
      getWebSocketAuthCheck(
        reqWithHeaders({ 'sec-websocket-protocol': `dominds, dominds-auth.wrong` }),
        auth,
      ),
      { kind: 'unauthorized', reason: 'invalid' },
    );
  }

  {
    assert.equal(
      formatServerOrigin({ scheme: 'http', host: 'localhost', port: 5666 }),
      'http://localhost:5666',
    );
    assert.equal(
      formatServerOrigin({ scheme: 'https', host: '192.168.1.10', port: 5667 }),
      'https://192.168.1.10:5667',
    );
    assert.equal(
      formatServerOrigin({ scheme: 'https', host: 'fd00::1', port: 5667 }),
      'https://[fd00::1]:5667',
    );
    assert.equal(
      formatAutoAuthUrl({ host: 'localhost', port: 5666, authKey: 'a b' }),
      'http://localhost:5666/?auth=a%20b',
    );
    assert.equal(
      formatAutoAuthUrl({
        scheme: 'https',
        host: '192.168.1.10',
        port: 5667,
        authKey: 'a b',
      }),
      'https://192.168.1.10:5667/?auth=a%20b',
    );
  }

  const enabled = { kind: 'enabled', key: 'given-auth-data-7c39', source: 'env' } as const;
  for (const check of [getHttpAuthCheck, getWebSocketAuthCheck]) {
    assert.deepEqual(check(reqWithHeaders({}), { kind: 'disabled' }), { kind: 'ok' });
    assert.deepEqual(check(reqWithHeaders({}), enabled), {
      kind: 'unauthorized',
      reason: 'missing',
    });
    assert.deepEqual(check(reqWithHeaders({ authorization: 'Basic invalid' }), enabled), {
      kind: 'unauthorized',
      reason: 'invalid',
    });
  }
  // A valid fallback must not override a supplied invalid Authorization header.
  assert.deepEqual(
    getWebSocketAuthCheck(
      reqWithHeaders({
        authorization: 'Bearer wrong',
        'sec-websocket-protocol': 'dominds, dominds-auth.' + enabled.key,
      }),
      enabled,
    ),
    { kind: 'unauthorized', reason: 'invalid' },
  );
  assert.deepEqual(
    getWebSocketAuthCheck(
      reqWithHeaders({
        authorization: 'Bearer ' + enabled.key,
        'sec-websocket-protocol': 'dominds, dominds-auth.wrong',
      }),
      enabled,
    ),
    { kind: 'ok' },
  );
  const url = new URL('http://localhost/?auth=' + enabled.key);
  assert.deepEqual(getHttpAuthCheckAllowUrlParam(reqWithHeaders({}), enabled, url), { kind: 'ok' });
  assert.deepEqual(
    getHttpAuthCheckAllowUrlParam(reqWithHeaders({ authorization: 'Bearer wrong' }), enabled, url),
    { kind: 'unauthorized', reason: 'invalid' },
  );
  await evidence.write();
  console.log('auth configuration, opaque token transport and header precedence: PASS');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
