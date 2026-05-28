import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  computeAuthConfig,
  formatAutoAuthUrl,
  formatServerOrigin,
  getHttpAuthCheck,
  getWebSocketAuthCheck,
} from '../main/server/auth';

function reqWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function run(): void {
  {
    const auth = computeAuthConfig({ mode: 'development', env: { DOMINDS_AUTH_KEY: 'x' } });
    assert.deepEqual(auth, { kind: 'disabled' });
  }

  {
    const auth = computeAuthConfig({ mode: 'production', env: {} });
    assert.equal(auth.kind, 'enabled');
    assert.equal(auth.source, 'generated');
    assert.ok(auth.key.length > 0);
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
      /DOMINDS_AUTH_KEY must be a plain-text token-safe string/i,
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

  console.log('auth tests: ok');
}

run();
