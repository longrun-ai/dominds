import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { computeAuthConfig, getHttpAuthCheck, getWebSocketAuthCheck } from '../main/server/auth';

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

  console.log('auth tests: ok');
}

run();
