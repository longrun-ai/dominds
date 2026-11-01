import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AuthManager,
  CODEX_ACCESS_TOKEN_ENV_VAR,
  CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR,
  CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
  RefreshTokenError,
  readAuthFile,
  tryRefreshToken,
  withAuthRefreshFileLock,
  writeAuthFile,
} from '../codex-auth/src/index';

import {
  captureAsyncAuthError,
  makeAuthProfile as makeCodexHome,
  makeAuthJwt as makeJwt,
} from './helpers/auth-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-codex-auth-refresh-');
const requests: Array<{
  url: string;
  expectedRefreshToken: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}> = [];
const endpoint = 'https://auth.test/oauth/token';
function diagnostic(
  id: string,
  scenario: string,
  error: Error,
  context: Record<string, string | number | boolean>,
) {
  evidence.record({
    id,
    scenario,
    businessValue:
      'A caller must distinguish a transient outage from exhausted refresh credentials and choose a recovery action without losing stored state.',
    context,
    reviewQuestions: [
      'Does the complete diagnostic accurately convey the supplied failure and give usable recovery guidance without misclassifying it?',
    ],
    actualText: error.message,
  });
}

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ACCOUNT_ID = 'acct_test';

async function run(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1');
  const originalAccessToken = process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR];
  process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR] = 'controlled-client-id';
  const originalRefreshUrl = process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR];
  process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] = endpoint;

  try {
    await testConcurrentRefreshesShareSingleRequest();
    await testFileLockRereadsDiskAndSkipsRefresh();
    await testStaleFileLockIsCleanedBeforeAcquire();
    await testStaleLockFileIsCleanedBeforeAcquire();
    await testFreshReaperLockBlocksAcquire();
    await testActiveLocalOwnerBlocksStaleCleanup();
    await testLockReleaseDoesNotRemoveReplacementOwner();
    await testExpiredTokenRefreshesOnAuth();
    await testNearExpiryTransientRefreshFailureUsesOldToken();
    await testExpiredTransientRefreshFailureFails();
    await testStructuredPermanentRefreshErrorOnNon401();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccessToken === undefined) delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    else process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = originalAccessToken;
    if (originalClientId === undefined)
      delete process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR];
    else process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR] = originalClientId;
    if (originalRefreshUrl === undefined) {
      delete process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR];
    } else {
      process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] = originalRefreshUrl;
    }
  }

  for (const request of requests) {
    assert.equal(request.url, endpoint);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.ok(typeof request.body === 'string');
    const body: unknown = JSON.parse(request.body);
    assert.ok(
      body &&
        typeof body === 'object' &&
        'client_id' in body &&
        'grant_type' in body &&
        'refresh_token' in body,
    );
    assert.equal(body.client_id, 'controlled-client-id');
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, request.expectedRefreshToken);
  }
  await evidence.write();
  console.log('codex-auth refresh tests: ok');
}

async function testConcurrentRefreshesShareSingleRequest(): Promise<void> {
  const codexHome = makeCodexHome();
  const oldAccess = makeAccessToken('old-access', 60);
  const newAccess = makeAccessToken('new-access', 3600);
  const newId = makeIdToken();
  writeManagedAuth(codexHome, oldAccess, 'old-refresh');

  let requestCount = 0;
  let markEntered: () => void = () => {
    throw new Error('request gate not initialized');
  };
  let releaseResponse: () => void = () => {
    throw new Error('response gate not initialized');
  };
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  installFetchMock('old-refresh', async () => {
    requestCount += 1;
    markEntered();
    await release;
    return jsonResponse(200, {
      id_token: newId,
      access_token: newAccess,
      refresh_token: 'new-refresh',
    });
  });

  const managers = [
    new AuthManager({ codexHome }),
    new AuthManager({ codexHome }),
    new AuthManager({ codexHome }),
  ];
  const running = Promise.all(managers.map((manager) => manager.auth()));
  await entered;
  releaseResponse();
  await running;

  assert.equal(requestCount, 1, 'concurrent refreshes should call the token endpoint once');
  assert.deepEqual(
    managers.map((manager) => manager.getToken()),
    [newAccess, newAccess, newAccess],
  );
  assert.equal(readAuthFile(codexHome)?.tokens?.refresh_token, 'new-refresh');
  assert.equal(fs.existsSync(path.join(codexHome, 'auth-refresh.lock')), false);
}

async function testFileLockRereadsDiskAndSkipsRefresh(): Promise<void> {
  const codexHome = makeCodexHome();
  const oldAccess = makeAccessToken('old-access', 60);
  const newAccess = makeAccessToken('lock-refreshed-access', 3600);
  writeManagedAuth(codexHome, oldAccess, 'old-refresh');

  let requestCount = 0;
  installFetchMock('old-refresh', async () => {
    requestCount += 1;
    return jsonResponse(200, {
      id_token: makeIdToken(),
      access_token: makeAccessToken('unexpected-access', 3600),
      refresh_token: 'unexpected-refresh',
    });
  });

  const manager = new AuthManager({ codexHome });
  let refreshPromise: Promise<void> | undefined;
  await withAuthRefreshFileLock(codexHome, async () => {
    refreshPromise = manager.refreshTokenFromAuthority();
    writeManagedAuth(codexHome, newAccess, 'lock-refreshed-token');
  });
  if (!refreshPromise) {
    throw new Error('refresh promise was not started');
  }
  await refreshPromise;

  assert.equal(requestCount, 0, 'refresh should be skipped when the locked file changed first');
  assert.equal(manager.getToken(), newAccess);
  assert.equal(readAuthFile(codexHome)?.tokens?.refresh_token, 'lock-refreshed-token');
  assert.equal(fs.existsSync(path.join(codexHome, 'auth-refresh.lock')), false);
}

async function testStaleFileLockIsCleanedBeforeAcquire(): Promise<void> {
  const owners = [
    { pid: 1, hostname: 'stale-host', createdAt: new Date(0).toISOString() },
    {
      lockId: 'complete-stale-foreign-owner',
      pid: 1,
      hostname: 'stale-host',
      createdAt: new Date(0).toISOString(),
    },
  ];
  for (const owner of owners) {
    const codexHome = makeCodexHome();
    const lockPath = path.join(codexHome, 'auth-refresh.lock');
    const reaperLockPath = lockPath + '.reaper';
    const ownerPath = path.join(lockPath, 'owner.json');
    fs.mkdirSync(lockPath);
    fs.mkdirSync(reaperLockPath);
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
    const staleTime = new Date(Date.now() - 3 * 60 * 1000);
    for (const file of [ownerPath, lockPath, reaperLockPath])
      fs.utimesSync(file, staleTime, staleTime);
    let acquired = false;
    await withAuthRefreshFileLock(codexHome, async () => {
      acquired = true;
      const current: unknown = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      assert.ok(
        current &&
          typeof current === 'object' &&
          'pid' in current &&
          'hostname' in current &&
          'lockId' in current,
      );
      assert.equal(current.pid, process.pid);
      assert.equal(current.hostname, os.hostname());
      assert.ok(typeof current.lockId === 'string' && current.lockId.length > 0);
    });
    assert.equal(acquired, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(reaperLockPath), false);
  }
}

async function testStaleLockFileIsCleanedBeforeAcquire(): Promise<void> {
  const codexHome = makeCodexHome();
  const lockPath = path.join(codexHome, 'auth-refresh.lock');
  fs.writeFileSync(lockPath, 'stale lock file', { encoding: 'utf8', mode: 0o600 });
  const staleTime = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  let acquired = false;
  await withAuthRefreshFileLock(codexHome, async () => {
    acquired = true;
  });

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
}

async function testFreshReaperLockBlocksAcquire(): Promise<void> {
  const codexHome = makeCodexHome();
  const lockPath = path.join(codexHome, 'auth-refresh.lock');
  const reaperLockPath = `${lockPath}.reaper`;
  fs.mkdirSync(reaperLockPath);

  let acquired = false;
  const acquirePromise = withAuthRefreshFileLock(codexHome, async () => {
    acquired = true;
  });
  assert.equal(acquired, false, 'fresh reaper lock should block new refresh lock acquisition');
  assert.equal(fs.existsSync(reaperLockPath), true, 'a fresh reaper cannot be removed');
  assert.equal(
    fs.existsSync(lockPath),
    false,
    'the refresh lock cannot be claimed while the reaper is present',
  );
  fs.rmSync(reaperLockPath, { recursive: true, force: true });
  await acquirePromise;

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
}

async function testActiveLocalOwnerBlocksStaleCleanup(): Promise<void> {
  const codexHome = makeCodexHome();
  const lockPath = path.join(codexHome, 'auth-refresh.lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({
      lockId: 'active-local-lock',
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(0).toISOString(),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const staleTime = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(ownerPath, staleTime, staleTime);
  fs.utimesSync(lockPath, staleTime, staleTime);

  const originalOwner = fs.readFileSync(ownerPath, 'utf8');
  let acquired = false;
  const acquirePromise = withAuthRefreshFileLock(codexHome, async () => {
    acquired = true;
  });
  assert.equal(
    fs.readFileSync(ownerPath, 'utf8'),
    originalOwner,
    'a live local owner must retain its lock record',
  );
  assert.equal(acquired, false, 'active local owner should prevent stale lock cleanup');
  fs.rmSync(lockPath, { recursive: true, force: true });
  await acquirePromise;

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
}

async function testLockReleaseDoesNotRemoveReplacementOwner(): Promise<void> {
  const codexHome = makeCodexHome();
  const lockPath = path.join(codexHome, 'auth-refresh.lock');
  const replacementOwner = {
    lockId: 'replacement-lock',
    pid: 123,
    hostname: 'replacement-host',
    createdAt: new Date().toISOString(),
  };

  await withAuthRefreshFileLock(codexHome, async () => {
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(replacementOwner), {
      encoding: 'utf8',
      mode: 0o600,
    });
  });

  assert.equal(fs.existsSync(lockPath), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as unknown,
    replacementOwner,
  );
  fs.rmSync(lockPath, { recursive: true, force: true });
}

async function testExpiredTokenRefreshesOnAuth(): Promise<void> {
  const codexHome = makeCodexHome();
  const newAccess = makeAccessToken('fresh-access', 3600);
  writeManagedAuth(codexHome, makeAccessToken('expired-access', -60), 'expired-refresh');

  let requestCount = 0;
  installFetchMock('expired-refresh', async () => {
    requestCount += 1;
    return jsonResponse(200, {
      id_token: makeIdToken(),
      access_token: newAccess,
      refresh_token: 'fresh-refresh',
    });
  });

  const manager = new AuthManager({ codexHome });
  await manager.auth();

  assert.equal(requestCount, 1);
  assert.equal(manager.getToken(), newAccess);
  assert.equal(readAuthFile(codexHome)?.tokens?.refresh_token, 'fresh-refresh');
}

async function testNearExpiryTransientRefreshFailureUsesOldToken(): Promise<void> {
  const codexHome = makeCodexHome();
  const oldAccess = makeAccessToken('near-expiry-access', 60);
  writeManagedAuth(codexHome, oldAccess, 'near-expiry-refresh');

  let requestCount = 0;
  installFetchMock('near-expiry-refresh', async () => {
    requestCount += 1;
    return jsonResponse(500, { error: { message: 'try again later' } });
  });

  const manager = new AuthManager({ codexHome });
  const auth = await manager.auth();

  assert.equal(requestCount, 1);
  assert.equal(auth?.mode, 'chatgpt');
  assert.equal(manager.getToken(), oldAccess);
  assert.equal(readAuthFile(codexHome)?.tokens?.refresh_token, 'near-expiry-refresh');
}

async function testExpiredTransientRefreshFailureFails(): Promise<void> {
  const codexHome = makeCodexHome();
  writeManagedAuth(codexHome, makeAccessToken('expired-access', -60), 'expired-refresh');

  let requestCount = 0;
  installFetchMock('expired-refresh', async () => {
    requestCount += 1;
    return jsonResponse(503, { error: { message: 'temporarily unavailable' } });
  });

  const manager = new AuthManager({ codexHome });
  const before = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8');
  const error = await captureAsyncAuthError(() => manager.auth());
  assert.ok(error instanceof RefreshTokenError);
  assert.equal(error.kind, 'transient');
  assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), before);
  diagnostic(
    'expired-transient-refresh',
    'An expired access token encounters a controlled HTTP503 refresh failure; it cannot be used as fallback.',
    error,
    {
      httpStatus: 503,
      requestCount,
      authFileBefore: before,
      authFileAfter: fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
    },
  );
  assert.equal(requestCount, 1);
}

async function testStructuredPermanentRefreshErrorOnNon401(): Promise<void> {
  installFetchMock('reused-refresh-token', async () =>
    jsonResponse(400, {
      error: {
        code: 'refresh_token_reused',
        message: 'refresh token reused',
      },
    }),
  );

  const error = await captureAsyncAuthError(() => tryRefreshToken('reused-refresh-token'));
  assert.ok(error instanceof RefreshTokenError);
  assert.equal(error.kind, 'permanent');
  assert.equal(error.reason, 'exhausted');
  diagnostic(
    'reused-refresh-credential',
    'The controlled refresh endpoint returns HTTP400 with machine error code refresh_token_reused.',
    error,
    { httpStatus: 400, errorCode: 'refresh_token_reused' },
  );
}

function installFetchMock(expectedRefreshToken: string, handler: FetchHandler): void {
  globalThis.fetch = async (input, init) => {
    requests.push({
      expectedRefreshToken,
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return handler(input, init);
  };
}

function writeManagedAuth(codexHome: string, accessToken: string, refreshToken: string): void {
  writeAuthFile(codexHome, {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: makeIdToken(),
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: ACCOUNT_ID,
    },
    last_refresh: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function makeAccessToken(label: string, expiresInSeconds: number): string {
  return makeJwt({
    label,
    exp: Math.floor((Date.now() + expiresInSeconds * 1000) / 1000),
  });
}

function makeIdToken(): string {
  return makeJwt({
    email: 'test@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_user_id: 'user_test',
      chatgpt_plan_type: 'plus',
      chatgpt_account_is_fedramp: false,
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function main() {
  const inherited = process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  try {
    process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = 'at-controlled-inherited-input';
    await run();
    assert.equal(
      process.env[CODEX_ACCESS_TOKEN_ENV_VAR],
      'at-controlled-inherited-input',
      'the owned input must be restored after managed-profile checks',
    );
  } finally {
    if (inherited === undefined) delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    else process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = inherited;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
