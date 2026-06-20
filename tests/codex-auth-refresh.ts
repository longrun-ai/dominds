import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AuthManager,
  CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
  RefreshTokenError,
  readAuthFile,
  tryRefreshToken,
  withAuthRefreshFileLock,
  writeAuthFile,
} from '../codex-auth/src/index';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ACCOUNT_ID = 'acct_test';

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalRefreshUrl = process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR];
  process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] = 'https://auth.test/oauth/token';

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
    if (originalRefreshUrl === undefined) {
      delete process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR];
    } else {
      process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] = originalRefreshUrl;
    }
  }

  console.log('codex-auth refresh tests: ok');
}

async function testConcurrentRefreshesShareSingleRequest(): Promise<void> {
  const codexHome = makeCodexHome();
  const oldAccess = makeAccessToken('old-access', 60);
  const newAccess = makeAccessToken('new-access', 3600);
  const newId = makeIdToken();
  writeManagedAuth(codexHome, oldAccess, 'old-refresh');

  let requestCount = 0;
  installFetchMock(async () => {
    requestCount += 1;
    await sleep(50);
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
  await Promise.all(managers.map((manager) => manager.auth()));

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
  installFetchMock(async () => {
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
    await sleep(50);
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
  const codexHome = makeCodexHome();
  const lockPath = path.join(codexHome, 'auth-refresh.lock');
  const reaperLockPath = `${lockPath}.reaper`;
  const ownerPath = path.join(lockPath, 'owner.json');
  fs.mkdirSync(lockPath);
  fs.mkdirSync(reaperLockPath);
  fs.writeFileSync(
    ownerPath,
    JSON.stringify({ pid: 1, hostname: 'stale-host', createdAt: new Date(0).toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const staleTime = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(ownerPath, staleTime, staleTime);
  fs.utimesSync(lockPath, staleTime, staleTime);
  fs.utimesSync(reaperLockPath, staleTime, staleTime);

  let acquired = false;
  await withAuthRefreshFileLock(codexHome, async () => {
    acquired = true;
  });

  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(reaperLockPath), false);
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
  await sleep(20);
  assert.equal(acquired, false, 'fresh reaper lock should block new refresh lock acquisition');
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

  let acquired = false;
  const acquirePromise = withAuthRefreshFileLock(codexHome, async () => {
    acquired = true;
  });
  await sleep(150);
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
  installFetchMock(async () => {
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
  installFetchMock(async () => {
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
  installFetchMock(async () => {
    requestCount += 1;
    return jsonResponse(503, { error: { message: 'temporarily unavailable' } });
  });

  const manager = new AuthManager({ codexHome });
  await assert.rejects(
    () => manager.auth(),
    (error: unknown) =>
      error instanceof RefreshTokenError && error.kind === 'transient' && /503/.test(error.message),
  );
  assert.equal(requestCount, 1);
}

async function testStructuredPermanentRefreshErrorOnNon401(): Promise<void> {
  installFetchMock(async () =>
    jsonResponse(400, {
      error: {
        code: 'refresh_token_reused',
        message: 'refresh token reused',
      },
    }),
  );

  await assert.rejects(
    () => tryRefreshToken('reused-refresh-token'),
    (error: unknown) =>
      error instanceof RefreshTokenError &&
      error.kind === 'permanent' &&
      error.reason === 'exhausted',
  );
}

function installFetchMock(handler: FetchHandler): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
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

function makeCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-codex-auth-'));
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

function makeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson(payload)}.sig`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void run();
