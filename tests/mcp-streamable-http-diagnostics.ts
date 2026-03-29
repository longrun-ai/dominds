import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpSdkClient } from '../main/mcp/sdk-client';

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
  const server = http.createServer(handleRequest);
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
  const fixture = await startFixtureServer();
  try {
    let thrown: unknown;
    try {
      await McpSdkClient.connectStreamableHttp({
        serverId: 'broken-http',
        url: fixture.endpointUrl,
        headers: {},
      });
      assert.fail('connectStreamableHttp should fail when MCP endpoint returns HTTP 500');
    } catch (err: unknown) {
      thrown = err;
    }

    const errorText = thrown instanceof Error ? thrown.message : String(thrown);
    assert.match(errorText, /MCP streamable_http connect failed for server 'broken-http'/);
    assert.match(errorText, /endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(
      errorText,
      /Probe summary: POST http:\/\/127\.0\.0\.1:\d+\/mcp -> 500 Internal Server Error/,
    );
    assert.match(errorText, /body=<empty>/);
    assert.match(errorText, /GET http:\/\/127\.0\.0\.1:\d+\/health -> 200 OK/);
    assert.match(
      errorText,
      /Likely cause: the target process is up, but its MCP handler is failing server-side before returning a valid MCP response/,
    );
    assert.match(
      errorText,
      /Suggested next step: inspect the target app logs\/stderr around the failing POST/,
    );
    assert.match(errorText, /rerun mcp_restart\(\{"serverId":"broken-http"\}\)/);
  } finally {
    await closeServer(fixture.server);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
