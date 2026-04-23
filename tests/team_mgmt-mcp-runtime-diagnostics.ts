#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Dialog } from '../main/dialog';
import { clearProblems, getProblemsSnapshot } from '../main/problems';
import { Team } from '../main/team';
import { teamMgmtValidateMcpCfgTool } from '../main/tools/team_mgmt';

const AUTH_ENV = 'DOMINDS_TEST_MCP_VALIDATE_AUTH_TOKEN';
const AUTH_TOKEN = 'validate-token';
const EXPECTED_AUTH_HEADER = `Bearer ${AUTH_TOKEN}`;

async function withTempRtws(run: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-mcp-runtime-'));
  const oldCwd = process.cwd();
  try {
    await fs.mkdir(path.join(tmpDir, '.minds'), { recursive: true });
    process.chdir(tmpDir);
    await run(tmpDir);
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function handleFixtureRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({ ok: true, phase: 'shell' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    req.resume();
    if (req.headers.authorization !== EXPECTED_AUTH_HEADER) {
      res.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('missing auth');
      return;
    }
    res.writeHead(500, {
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end();
    return;
  }

  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
}

async function startFixtureServer(): Promise<{
  server: http.Server;
  endpointUrl: string;
}> {
  const server = http.createServer(handleFixtureRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as AddressInfo).port;
  return {
    server,
    endpointUrl: `http://127.0.0.1:${port}/mcp`,
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  clearProblems({ source: 'mcp' });
  const previousAuthEnv = process.env[AUTH_ENV];
  process.env[AUTH_ENV] = AUTH_TOKEN;
  try {
    await withTempRtws(async (tmpDir) => {
      const fixture = await startFixtureServer();
      try {
        await fs.writeFile(
          path.join(tmpDir, '.minds', 'mcp.yaml'),
          [
            'version: 1',
            'servers:',
            '  broken_http:',
            '    truely-stateless: true',
            '    transport: streamable_http',
            `    url: ${fixture.endpointUrl}`,
            '    headers:',
            '      Authorization:',
            '        prefix: "Bearer "',
            `        env: ${AUTH_ENV}`,
            '    tools: { whitelist: [], blacklist: [] }',
            '    transform: []',
            '',
          ].join('\n'),
          'utf8',
        );

        const dlg = {
          getLastUserLanguageCode: () => 'en' as const,
        } as unknown as Dialog;
        const caller = new Team.Member({ id: 'tester', name: 'Tester' });
        const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

        assert.ok(
          out.includes('mcp.yaml Validation Failed'),
          'validate tool should fail when runtime MCP server is unavailable',
        );
        assert.ok(
          out.includes('endpoint: http://127.0.0.1:'),
          'validate tool should surface the failing MCP endpoint URL',
        );
        assert.ok(
          out.includes('Probe summary: POST http://127.0.0.1:') &&
            out.includes('-> 500 Internal Server Error'),
          'validate tool should surface the POST probe result',
        );
        assert.ok(
          out.includes('GET http://127.0.0.1:') && out.includes('-> 200 OK'),
          'validate tool should surface the health probe result',
        );
        assert.ok(
          out.includes(
            'Likely cause: the target process is up, but its MCP handler is failing server-side before returning a valid MCP response',
          ),
          'validate tool should surface the likely cause in plain language',
        );
        assert.ok(
          out.includes(
            'Suggested next step: inspect the target app logs/stderr around the failing POST',
          ),
          'validate tool should surface the next repair step in plain language',
        );

        const problem = getProblemsSnapshot().problems.find(
          (entry) => entry.kind === 'mcp_server_error' && entry.detail.serverId === 'broken_http',
        );
        assert.ok(problem, 'runtime MCP failure should be written into Problems');
        assert.equal(
          problem.detailTextI18n?.zh?.includes('MCP streamable_http 连接失败'),
          true,
          'runtime MCP problem should include a real zh detail text',
        );
        assert.equal(
          problem.detailTextI18n?.en?.includes(
            "MCP streamable_http connect failed for server 'broken_http'",
          ),
          true,
          'runtime MCP problem should include the matching en detail text',
        );
      } finally {
        await closeServer(fixture.server);
      }
    });

    clearProblems({ source: 'mcp' });

    await withTempRtws(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, '.minds', 'mcp.yaml'),
        [
          'version: 1',
          'servers:',
          '  invalid_header:',
          '    truely-stateless: true',
          '    transport: streamable_http',
          '    url: http://127.0.0.1:3000/mcp',
          '    headers:',
          '      Authorization:',
          '        prefix: 42',
          `        env: ${AUTH_ENV}`,
          '    tools: { whitelist: [], blacklist: [] }',
          '    transform: []',
          '',
        ].join('\n'),
        'utf8',
      );

      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      } as unknown as Dialog;
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = (await teamMgmtValidateMcpCfgTool.call(dlg, caller, {})).content;

      assert.ok(
        out.includes('mcp.yaml Validation Failed'),
        'validate tool should fail when prefixed header config is invalid',
      );
      assert.ok(
        out.includes('servers.invalid_header.headers.Authorization.prefix must be a string'),
        'validate tool should report the precise invalid prefixed header path',
      );
    });
  } finally {
    if (previousAuthEnv === undefined) {
      delete process.env[AUTH_ENV];
    } else {
      process.env[AUTH_ENV] = previousAuthEnv;
    }
  }

  console.log('team_mgmt mcp runtime diagnostics tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt mcp runtime diagnostics tests: failed: ${message}`);
  process.exit(1);
});
