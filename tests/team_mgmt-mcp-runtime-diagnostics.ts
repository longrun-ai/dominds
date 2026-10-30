#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { Dialog } from '../main/dialog';
import { clearProblems, getProblemsSnapshot } from '../main/problems';
import { Team } from '../main/team';
import { teamMgmtValidateMcpCfgTool } from '../main/tools/team_mgmt';
import { writeSemanticEvidence, type SemanticEvidence } from './helpers/semantic-evidence';

const AUTH_ENV = 'DOMINDS_TEST_MCP_VALIDATE_AUTH_TOKEN';
const AUTH_TOKEN = 'validate-token';
const EXPECTED_AUTH_HEADER = `Bearer ${AUTH_TOKEN}`;

const requests: Array<{
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  status: number;
}> = [];
function handleFixtureRequest(req: IncomingMessage, res: ServerResponse): void {
  res.once('finish', () =>
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      status: res.statusCode,
    }),
  );
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
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  async function validate(id: string, dlg: Dialog, caller: Team.Member): Promise<void> {
    for (const language of ['en', 'zh'] as const) {
      const result = await teamMgmtValidateMcpCfgTool.call(
        { ...dlg, getLastUserLanguageCode: () => language } as Dialog,
        caller,
        {},
      );
      assert.equal(result.outcome, 'failure');
      if (semantic)
        cases.push({
          id: id + '-' + language,
          scenario:
            id === 'runtime-unavailable'
              ? 'An authenticated MCP POST returns HTTP 500 while the same process health endpoint returns 200.'
              : 'The configured Authorization header prefix is a number rather than a string.',
          businessValue:
            'Diagnose the failing protocol boundary without blaming credentials or claiming the whole process is down when the evidence says otherwise.',
          context: {
            language,
            mcpYaml: await fs.readFile('.minds/mcp.yaml', 'utf8'),
            observedRequests: JSON.stringify(requests),
            problems: JSON.stringify(getProblemsSnapshot().problems),
          },
          reviewQuestions: [
            'Does the complete output accurately identify the endpoint or invalid field and the supplied observations?',
            'Is the likely-cause statement qualified and does the repair advice follow the evidence rather than invent a diagnosis?',
            'Are static header errors distinguished from a reachable process whose MCP handler fails?',
          ],
          actualText: result.content,
        });
    }
  }
  clearProblems({ source: 'mcp' });
  const previousAuthEnv = process.env[AUTH_ENV];
  process.env[AUTH_ENV] = AUTH_TOKEN;
  try {
    {
      const tmpDir = process.cwd();
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
        await validate('runtime-unavailable', dlg, caller);
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'POST' &&
              request.url === '/mcp' &&
              request.authorization === EXPECTED_AUTH_HEADER &&
              request.status === 500,
          ),
        );
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'GET' && request.url === '/health' && request.status === 200,
          ),
        );

        const problem = getProblemsSnapshot().problems.find(
          (entry) => entry.kind === 'mcp_server_error' && entry.detail.serverId === 'broken_http',
        );
        assert.ok(problem, 'runtime MCP failure should be written into Problems');
        assert.equal(problem.severity, 'info');
        await fs.writeFile('.minds/mcp.yaml', 'version: 1\nservers: {}\n');
        const repaired = await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});
        assert.equal(repaired.outcome, 'success');
        const resolved = getProblemsSnapshot().problems.find((entry) => entry.id === problem.id);
        assert.equal(
          resolved?.resolved,
          true,
          'removing a never-loaded server resolves its runtime failure',
        );
      } finally {
        await closeServer(fixture.server);
      }
    }

    clearProblems({ source: 'mcp' });

    {
      const tmpDir = process.cwd();
      const fixture = await startFixtureServer();
      try {
        await fs.writeFile(
          path.join(tmpDir, '.minds', 'mcp.yaml'),
          [
            'version: 1',
            'servers:',
            '  invalid_header:',
            '    truely-stateless: true',
            '    transport: streamable_http',
            `    url: ${fixture.endpointUrl}`,
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
        const requestCount = requests.length;
        await validate('invalid-header', dlg, caller);
        assert.equal(
          requests.length,
          requestCount,
          'invalid headers are rejected before connecting',
        );
        const problem = getProblemsSnapshot().problems.find(
          (entry) =>
            entry.kind === 'mcp_server_error' && entry.detail.serverId === 'invalid_header',
        );
        assert.ok(problem);
        assert.equal(problem.severity, 'error');
      } finally {
        await closeServer(fixture.server);
      }
    }
  } finally {
    if (previousAuthEnv === undefined) {
      delete process.env[AUTH_ENV];
    } else {
      process.env[AUTH_ENV] = previousAuthEnv;
    }
  }

  if (semantic) await writeSemanticEvidence(cases, 'dominds-mcp-runtime-guidance-');
  else console.log('MCP runtime diagnostics behavior tests passed');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt mcp runtime diagnostics tests: failed: ${message}`);
  process.exit(1);
});
