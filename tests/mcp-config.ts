import assert from 'node:assert/strict';

import { parseMcpYaml } from '../main/mcp/config';
import { buildHttpHeaders } from '../main/mcp/supervisor';

const AUTH_ENV = 'DOMINDS_TEST_MCP_AUTH_TOKEN';
const RAW_ENV = 'DOMINDS_TEST_MCP_RAW_HEADER';

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    const next = updates[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function main(): void {
  const parsed = parseMcpYaml(`
version: 1
servers:
  http:
    truely-stateless: true
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    headers:
      Authorization:
        prefix: "Bearer "
        env: ${AUTH_ENV}
      X-Raw:
        env: ${RAW_ENV}
      X-Literal: dominds
`);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const cfg = parsed.config.servers.http;
  assert.equal(cfg?.transport, 'streamable_http');
  if (!cfg || cfg.transport !== 'streamable_http') return;

  assert.deepEqual(cfg.headers.Authorization, {
    kind: 'from_env',
    prefix: 'Bearer ',
    env: AUTH_ENV,
  });
  assert.deepEqual(cfg.headers['X-Raw'], { kind: 'from_env', prefix: '', env: RAW_ENV });
  assert.deepEqual(cfg.headers['X-Literal'], { kind: 'literal', value: 'dominds' });

  withEnv(
    {
      [AUTH_ENV]: 'MENTORTRIAL42',
      [RAW_ENV]: 'raw-token',
    },
    () => {
      assert.deepEqual(buildHttpHeaders(cfg, 'http'), {
        Authorization: 'Bearer MENTORTRIAL42',
        'X-Raw': 'raw-token',
        'X-Literal': 'dominds',
      });
    },
  );

  withEnv({ [AUTH_ENV]: undefined, [RAW_ENV]: 'raw-token' }, () => {
    assert.throws(
      () => buildHttpHeaders(cfg, 'http'),
      /missing required host env var 'DOMINDS_TEST_MCP_AUTH_TOKEN' \(for headers.Authorization\)/,
    );
  });

  const invalid = parseMcpYaml(`
version: 1
servers:
  http:
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
    headers:
      Authorization:
        prefix: 42
        env: ${AUTH_ENV}
`);

  assert.equal(invalid.ok, true);
  if (!invalid.ok) return;
  assert.equal(invalid.invalidServers.length, 1);
  assert.match(invalid.invalidServers[0]?.errorText ?? '', /headers\.Authorization\.prefix/);

  const disabled = parseMcpYaml(`
version: 1
servers:
  disabled_http:
    enabled: false
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
`);

  assert.equal(disabled.ok, true);
  if (!disabled.ok) return;
  assert.deepEqual(Object.keys(disabled.config.servers), []);
  assert.deepEqual(disabled.serverIdsInYamlOrder, ['disabled_http']);
  assert.deepEqual(disabled.validServerIdsInYamlOrder, []);
  assert.deepEqual(disabled.disabledServerIdsInYamlOrder, ['disabled_http']);

  const badEnabled = parseMcpYaml(`
version: 1
servers:
  bad_enabled:
    enabled: "false"
    transport: streamable_http
    url: http://127.0.0.1:3000/mcp
`);
  assert.equal(badEnabled.ok, true);
  if (!badEnabled.ok) return;
  assert.deepEqual(badEnabled.invalidServers, [
    {
      serverId: 'bad_enabled',
      errorText: 'Invalid mcp.yaml: servers.bad_enabled.enabled must be a boolean',
    },
  ]);

  console.log('mcp config tests: ok');
}

main();
