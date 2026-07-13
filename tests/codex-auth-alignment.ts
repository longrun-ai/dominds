import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  assertDomindsCodexProviderManagedChatGptAuth,
  assertDomindsCodexProviderManagedChatGptStoredAuth,
  AuthManager,
  ChatGptClient,
  CODEX_ACCESS_TOKEN_ENV_VAR,
  CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR,
  CODEX_OPEN_APP_URL,
  composeSuccessRedirect,
  createChatGptClientFromManager,
  createChatGptStartRequest,
  createExternalHeaderAuth,
  credentialsFromAuthState,
  DOMINDS_CODEX_PROVIDER_AUTH_POLICY,
  formatCodexFileAuthActionRequired,
  loadCodexPromptSync,
  normalizeAccountPlanType,
  oauthClientId,
  prepareCodexFileAuth,
  readAuthFile,
  resolveCodexPromptFilename,
  writeAuthFile,
  type AuthDotJson,
  type AuthState,
  type ExternalAuth,
} from '../codex-auth/src/index';

async function run(): Promise<void> {
  await withCodexAccessTokenUnsetAsync(async () => {
    testAgentIdentityRecordWithoutEmail();
    testAgentIdentityJwtWithoutEmail();
    testHeaderAuthCannotBePersisted();
    testAccountPlanTypeAliasesAndFutureValues();
    testDomindsCodexProviderManagedOauthBoundary();
    testDomindsCodexProviderAcceptsManagedFileAuth();
    testDomindsCodexProviderRejectsUnsupportedFileModes();
    testDomindsCodexProviderRejectsUnknownFutureFileMode();
    testDomindsCodexProviderRejectsEphemeralManagedAuth();
    testDomindsCodexProviderRejectsCodexAccessTokenOverride();
    await testDomindsCodexProviderRejectsInitialExternalAuth();
    await testDomindsCodexProviderRejectsRuntimeAuthChanges();
    await testExternalHeadersReachRequests();
    await testExternalHeaderAuthRotation();
    testOauthClientIdOverride();
    testHostedLoginSuccessRedirect();
    testGpt56PromptSelection();
  });
  console.log('codex-auth alignment tests: ok');
}

function testAccountPlanTypeAliasesAndFutureValues(): void {
  assert.equal(normalizeAccountPlanType('hc'), 'enterprise');
  assert.equal(normalizeAccountPlanType('education'), 'edu');
  assert.equal(normalizeAccountPlanType('future_usage_plan'), 'future_usage_plan');
}

async function testDomindsCodexProviderRejectsInitialExternalAuth(): Promise<void> {
  const externalAuth: ExternalAuth = {
    resolve: async () => createExternalHeaderAuth({ Authorization: 'Bearer external' }),
    refresh: async () => createExternalHeaderAuth({ Authorization: 'Bearer refreshed' }),
  };
  const manager = new AuthManager({ codexHome: makeCodexHome(), externalAuth });
  await assert.rejects(
    () =>
      createChatGptClientFromManager(manager, {
        validateAuthState: assertDomindsCodexProviderManagedChatGptAuth,
      }),
    /supports only managed ChatGPT OAuth file auth.*headers/,
  );
}

async function testDomindsCodexProviderRejectsRuntimeAuthChanges(): Promise<void> {
  const managed = managedChatGptAuthState();
  const cases: Array<{
    name: string;
    mutation:
      | { kind: 'stored'; changedAuth: AuthDotJson }
      | { kind: 'environment'; accessToken: string };
    expectedError: RegExp;
  }> = [
    {
      name: 'external ChatGPT tokens',
      mutation: {
        kind: 'stored',
        changedAuth: {
          auth_mode: 'chatgptAuthTokens',
          tokens: {
            id_token: managedIdToken(),
            access_token: 'external-access-test',
            refresh_token: 'external-refresh-test',
            account_id: 'account-test',
          },
        },
      },
      expectedError: /supports only managed ChatGPT OAuth file auth.*chatgptAuthTokens/,
    },
    {
      name: 'incomplete managed ChatGPT auth',
      mutation: {
        kind: 'stored',
        changedAuth: {
          ...managed.raw,
          tokens: {
            id_token: managed.tokens.idToken.raw_jwt,
            access_token: managed.tokens.accessToken,
            refresh_token: '',
            account_id: managed.tokens.accountId,
          },
        },
      },
      expectedError: /missing id_token, access_token, or refresh_token/,
    },
    {
      name: 'runtime CODEX_ACCESS_TOKEN override',
      mutation: { kind: 'environment', accessToken: 'at-runtime-test' },
      expectedError:
        /supports only managed ChatGPT OAuth file auth.*personal_access_token.*custom Dominds OpenAI Responses API provider.*feature request/,
    },
  ];

  for (const testCase of cases) {
    await assertRuntimeAuthRejection(testCase);
  }
}

async function assertRuntimeAuthRejection(testCase: {
  name: string;
  mutation:
    | { kind: 'stored'; changedAuth: AuthDotJson }
    | { kind: 'environment'; accessToken: string };
  expectedError: RegExp;
}): Promise<void> {
  const codexHome = makeCodexHome();
  const initialAuth = managedChatGptAuthState().raw;
  writeAuthFile(codexHome, initialAuth);
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    switch (testCase.mutation.kind) {
      case 'stored':
        writeAuthFile(codexHome, testCase.mutation.changedAuth);
        break;
      case 'environment':
        process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = testCase.mutation.accessToken;
        break;
      default: {
        const _exhaustive: never = testCase.mutation;
        throw new Error(`Unhandled runtime auth mutation: ${JSON.stringify(_exhaustive)}`);
      }
    }
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":"unauthorized"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server address is unavailable');
    }
    const manager = new AuthManager({
      codexHome,
      validateStoredAuth: assertDomindsCodexProviderManagedChatGptStoredAuth,
      validateAuthState: assertDomindsCodexProviderManagedChatGptAuth,
    });
    const client = await createChatGptClientFromManager(manager, {
      baseUrl: `http://127.0.0.1:${address.port}/backend-api/`,
      useEnvProxy: false,
      validateAuthState: assertDomindsCodexProviderManagedChatGptAuth,
    });
    const payload = createChatGptStartRequest({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      conversationId: '00000000-0000-4000-8000-000000000001',
      userText: 'test',
    });
    await assert.rejects(() => client.responses(payload), testCase.expectedError);
    assert.equal(
      requestCount,
      1,
      `${testCase.name} must be rejected before a retry request is sent`,
    );
    switch (testCase.mutation.kind) {
      case 'stored':
        assert.deepEqual(
          readAuthFile(codexHome),
          testCase.mutation.changedAuth,
          `${testCase.name} must not be normalized or rewritten before rejection`,
        );
        break;
      case 'environment':
        assert.deepEqual(
          readAuthFile(codexHome),
          initialAuth,
          `${testCase.name} must not rewrite the managed auth file`,
        );
        break;
      default: {
        const _exhaustive: never = testCase.mutation;
        throw new Error(`Unhandled runtime auth mutation: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } finally {
    delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function testDomindsCodexProviderRejectsUnknownFutureFileMode(): void {
  withCodexAccessTokenUnset(() => {
    const codexHome = makeCodexHome();
    const rawAuth = `${JSON.stringify({ auth_mode: 'futureAuthMode', credential: 'test' }, null, 2)}\n`;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), rawAuth, 'utf8');
    const result = prepareCodexFileAuth({ codexHome });
    assert.equal(result.kind, 'action_required');
    if (result.kind !== 'action_required') {
      throw new Error('expected an unknown future auth mode to require action');
    }
    const formatted = formatCodexFileAuthActionRequired(result);
    assert.match(formatted, /unknown auth\.json mode/);
    assert.match(formatted, /custom Dominds OpenAI Responses API provider/);
    assert.match(formatted, /submit a Dominds feature request/);

    assert.throws(
      () =>
        new AuthManager({
          codexHome,
          validateStoredAuth: assertDomindsCodexProviderManagedChatGptStoredAuth,
        }),
      /unknown auth\.json mode.*custom Dominds OpenAI Responses API provider.*feature request/,
    );
    assert.equal(
      fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'),
      rawAuth,
      'rejected unknown stored auth must not be normalized or rewritten',
    );
  });
}

function testDomindsCodexProviderAcceptsManagedFileAuth(): void {
  withCodexAccessTokenUnset(() => {
    const managedHome = makeCodexHome();
    writeAuthFile(managedHome, managedChatGptAuthState().raw);
    assert.equal(prepareCodexFileAuth({ codexHome: managedHome }).kind, 'ready');
  });
}

function testDomindsCodexProviderRejectsEphemeralManagedAuth(): void {
  const codexHome = makeCodexHome();
  const managed = managedChatGptAuthState().raw;
  writeAuthFile(codexHome, managed);
  writeAuthFile(codexHome, managed, 'ephemeral');
  assert.throws(
    () =>
      new AuthManager({
        codexHome,
        validateStoredAuth: assertDomindsCodexProviderManagedChatGptStoredAuth,
      }),
    /supports only managed ChatGPT OAuth file auth.*chatgpt from the ephemeral auth store.*custom Dominds OpenAI Responses API provider.*feature request/,
  );
}

function testDomindsCodexProviderManagedOauthBoundary(): void {
  const managed = managedChatGptAuthState();
  assert.doesNotThrow(() => assertDomindsCodexProviderManagedChatGptAuth(managed));

  const rejected: AuthState[] = [
    {
      mode: 'api_key',
      apiKey: 'sk-test',
      raw: { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' },
    },
    {
      ...managed,
      mode: 'chatgpt_auth_tokens',
    },
    {
      ...managed,
      tokens: { ...managed.tokens, refreshToken: '' },
    },
    createExternalHeaderAuth({ Authorization: 'Bearer external' }),
    {
      mode: 'agent_identity',
      agentIdentity: agentIdentityRecord(),
      agentIdentityRecord: agentIdentityRecord(),
      raw: { auth_mode: 'agentIdentity', agent_identity: agentIdentityRecord() },
    },
    {
      mode: 'personal_access_token',
      personalAccessToken: 'at-test',
      raw: { personal_access_token: 'at-test' },
    },
    {
      mode: 'bedrock_api_key',
      bedrockApiKey: { api_key: 'bedrock-test', region: 'us-east-1' },
      raw: {
        auth_mode: 'bedrockApiKey',
        bedrock_api_key: { api_key: 'bedrock-test', region: 'us-east-1' },
      },
    },
  ];
  for (const auth of rejected) {
    assert.throws(
      () => assertDomindsCodexProviderManagedChatGptAuth(auth),
      new RegExp(DOMINDS_CODEX_PROVIDER_AUTH_POLICY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
}

function testDomindsCodexProviderRejectsUnsupportedFileModes(): void {
  const cases: AuthDotJson[] = [
    { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' },
    {
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: managedIdToken(),
        access_token: 'access-test',
        refresh_token: '',
        account_id: 'account-test',
      },
    },
    {
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: managedIdToken(),
        access_token: 'access-test',
        refresh_token: 'refresh-test',
        account_id: 'account-test',
      },
    },
    { auth_mode: 'headers' },
    { auth_mode: 'agentIdentity', agent_identity: agentIdentityRecord() },
    { personal_access_token: 'at-test' },
    {
      auth_mode: 'bedrockApiKey',
      bedrock_api_key: { api_key: 'bedrock-test', region: 'us-east-1' },
    },
  ];

  withCodexAccessTokenUnset(() => {
    for (const auth of cases) {
      const codexHome = makeCodexHome();
      writeAuthFile(codexHome, auth);
      const result = prepareCodexFileAuth({ codexHome });
      assert.equal(result.kind, 'action_required');
      if (result.kind !== 'action_required') {
        throw new Error('expected unsupported auth to require action');
      }
      const formatted = formatCodexFileAuthActionRequired(result);
      assert.match(formatted, /supports only managed ChatGPT OAuth file auth/);
      assert.match(formatted, /custom Dominds OpenAI Responses API provider/);
      assert.match(formatted, /submit a Dominds feature request/);
    }
  });
}

function testDomindsCodexProviderRejectsCodexAccessTokenOverride(): void {
  const previous = process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  try {
    const cases = [
      { value: 'at-environment-test', detected: 'personalAccessToken' },
      { value: 'agent-identity-jwt-test', detected: 'agentIdentity' },
    ];
    for (const testCase of cases) {
      const codexHome = makeCodexHome();
      writeAuthFile(codexHome, managedChatGptAuthState().raw);
      process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = testCase.value;
      const result = prepareCodexFileAuth({ codexHome });
      assert.equal(result.kind, 'action_required');
      if (result.kind !== 'action_required') {
        throw new Error('expected CODEX_ACCESS_TOKEN to be rejected');
      }
      assert.match(result.message, new RegExp(`${testCase.detected} via CODEX_ACCESS_TOKEN`));
      assert.ok(result.steps.some((step) => step.includes(`Unset ${CODEX_ACCESS_TOKEN_ENV_VAR}`)));
    }
  } finally {
    if (previous === undefined) {
      delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    } else {
      process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = previous;
    }
  }
}

function testAgentIdentityRecordWithoutEmail(): void {
  const codexHome = makeCodexHome();
  writeAuthFile(codexHome, {
    auth_mode: 'agentIdentity',
    agent_identity: {
      agent_runtime_id: 'runtime_test',
      agent_private_key: 'private_key_test',
      account_id: 'account_test',
      chatgpt_user_id: 'user_test',
      plan_type: 'plus',
      chatgpt_account_is_fedramp: false,
      task_id: 'task_test',
    },
  });

  const auth = new AuthManager({ codexHome }).authCached();
  assert.equal(auth?.mode, 'agent_identity');
  if (auth?.mode !== 'agent_identity') {
    throw new Error('expected agent identity auth');
  }
  assert.equal(auth.agentIdentityRecord.email, undefined);
  assert.equal(auth.agentIdentityRecord.task_id, 'task_test');
}

function managedChatGptAuthState(): Extract<AuthState, { mode: 'chatgpt' }> {
  const idToken = managedIdToken();
  return {
    mode: 'chatgpt',
    tokens: {
      idToken: {
        chatgpt_account_id: 'account-test',
        chatgpt_account_is_fedramp: false,
        raw_jwt: idToken,
      },
      accessToken: 'access-test',
      refreshToken: 'refresh-test',
      accountId: 'account-test',
    },
    raw: {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: idToken,
        access_token: 'access-test',
        refresh_token: 'refresh-test',
        account_id: 'account-test',
      },
      last_refresh: new Date().toISOString(),
    },
  };
}

function managedIdToken(): string {
  return makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-test',
      chatgpt_account_is_fedramp: false,
    },
  });
}

function agentIdentityRecord(): Extract<AuthDotJson['agent_identity'], object> {
  return {
    agent_runtime_id: 'runtime-test',
    agent_private_key: 'private-key-test',
    account_id: 'account-test',
    chatgpt_user_id: 'user-test',
    plan_type: 'plus',
    chatgpt_account_is_fedramp: false,
    task_id: 'task-test',
  };
}

function testAgentIdentityJwtWithoutEmail(): void {
  const codexHome = makeCodexHome();
  const agentIdentity = makeJwt({
    agent_runtime_id: 'runtime_test',
    agent_private_key: 'private_key_test',
    account_id: 'account_test',
    chatgpt_user_id: 'user_test',
    plan_type: 'plus',
    chatgpt_account_is_fedramp: false,
  });
  writeAuthFile(codexHome, {
    auth_mode: 'agentIdentity',
    agent_identity: agentIdentity,
  });

  const auth = new AuthManager({ codexHome }).authCached();
  assert.equal(auth?.mode, 'agent_identity');
  if (auth?.mode !== 'agent_identity') {
    throw new Error('expected agent identity auth');
  }
  assert.equal(auth.agentIdentityRecord.email, undefined);
}

function testHeaderAuthCannotBePersisted(): void {
  const codexHome = makeCodexHome();
  writeAuthFile(codexHome, { auth_mode: 'headers' });
  assert.throws(
    () => new AuthManager({ codexHome }),
    /externally provided header auth cannot be loaded from auth\.json/,
  );
}

async function testExternalHeaderAuthRotation(): Promise<void> {
  let resolveCount = 0;
  let refreshCount = 0;
  const externalAuth: ExternalAuth = {
    resolve: async () => {
      resolveCount += 1;
      return createExternalHeaderAuth({ Authorization: `Bearer resolved-${resolveCount}` });
    },
    refresh: async () => {
      refreshCount += 1;
      return createExternalHeaderAuth({ Authorization: 'Bearer second' });
    },
  };
  const manager = new AuthManager({ codexHome: makeCodexHome(), externalAuth });

  const first = await manager.auth();
  assert.equal(resolveCount, 1);
  assert.equal(first?.mode, 'headers');
  if (!first) {
    throw new Error('expected external header auth');
  }
  assert.deepEqual(credentialsFromAuthState(first), {
    kind: 'headers',
    headers: { Authorization: 'Bearer resolved-1' },
  });

  const second = await manager.auth();
  assert.equal(resolveCount, 2, 'external auth resolution should remain authoritative');
  assert.deepEqual(second, {
    mode: 'headers',
    headers: { Authorization: 'Bearer resolved-2' },
  });

  await manager.refreshExternalAuthForUnauthorized();
  assert.equal(refreshCount, 1);
  assert.deepEqual(manager.authCached(), {
    mode: 'headers',
    headers: { Authorization: 'Bearer second' },
  });
}

async function testExternalHeadersReachRequests(): Promise<void> {
  let receivedHeaders: http.IncomingHttpHeaders | undefined;
  const server = http.createServer((request, response) => {
    receivedHeaders = request.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server address is unavailable');
    }
    const client = new ChatGptClient(
      {
        kind: 'headers',
        headers: {
          Authorization: 'Bearer external',
          'x-external-auth': 'enabled',
        },
      },
      {
        baseUrl: `http://127.0.0.1:${address.port}/`,
        originator: 'codex-auth-test',
        userAgent: 'codex-auth-test',
        useEnvProxy: false,
      },
    );
    const response = await client.request('models', { method: 'GET' });
    await response.text();
    assert.equal(receivedHeaders?.authorization, 'Bearer external');
    assert.equal(receivedHeaders?.['x-external-auth'], 'enabled');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function testOauthClientIdOverride(): void {
  const previous = process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR];
  try {
    process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR] = 'client_override';
    assert.equal(oauthClientId(), 'client_override');
  } finally {
    if (previous === undefined) {
      delete process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR];
    } else {
      process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR] = previous;
    }
  }
}

function testHostedLoginSuccessRedirect(): void {
  const idToken = makeJwt({
    'https://api.openai.com/auth': {
      completed_platform_onboarding: true,
      is_org_owner: true,
    },
  });
  const accessToken = makeJwt({
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
  });
  const redirect = composeSuccessRedirect(1455, 'https://auth.openai.com', idToken, accessToken, {
    kind: 'hosted',
    appBrand: 'codex',
  });
  assert.equal(redirect.kind, 'hosted');
  assert.equal(redirect.url, `${CODEX_OPEN_APP_URL}?source=login&app_brand=codex`);

  const needsSetupToken = makeJwt({
    'https://api.openai.com/auth': {
      completed_platform_onboarding: false,
      is_org_owner: true,
    },
  });
  const setupRedirect = composeSuccessRedirect(
    1455,
    'https://auth.openai.com',
    needsSetupToken,
    accessToken,
    { kind: 'hosted', appBrand: 'codex' },
  );
  assert.equal(setupRedirect.kind, 'local');
  assert.match(setupRedirect.url, /^http:\/\/localhost:1455\/success\?/);
}

function testGpt56PromptSelection(): void {
  assert.equal(resolveCodexPromptFilename('gpt-5.6'), 'gpt-5.6-sol_prompt.md');
  assert.equal(resolveCodexPromptFilename('gpt-5.6-sol'), 'gpt-5.6-sol_prompt.md');
  assert.equal(resolveCodexPromptFilename('gpt-5.6-terra'), 'gpt-5.6_prompt.md');
  assert.equal(resolveCodexPromptFilename('gpt-5.6-luna'), 'gpt-5.6_prompt.md');
  const sol = loadCodexPromptSync('gpt-5.6-sol');
  const terra = loadCodexPromptSync('gpt-5.6-terra');
  const luna = loadCodexPromptSync('gpt-5.6-luna');
  assert.ok(sol);
  assert.ok(terra);
  assert.equal(luna, terra);
  assert.notEqual(sol, terra);
}

function makeCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-codex-auth-alignment-'));
}

function withCodexAccessTokenUnset(work: () => void): void {
  const previous = process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  try {
    delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    work();
  } finally {
    if (previous === undefined) {
      delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    } else {
      process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = previous;
    }
  }
}

async function withCodexAccessTokenUnsetAsync(work: () => Promise<void>): Promise<void> {
  const previous = process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
  try {
    delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    await work();
  } finally {
    if (previous === undefined) {
      delete process.env[CODEX_ACCESS_TOKEN_ENV_VAR];
    } else {
      process.env[CODEX_ACCESS_TOKEN_ENV_VAR] = previous;
    }
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson(payload)}.sig`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

void run();
