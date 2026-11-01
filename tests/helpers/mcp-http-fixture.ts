import assert from 'node:assert/strict';
import http from 'node:http';

/** Owned loopback protocol peer: the MCP SDK, supervisor and registry remain real. */
export async function startMcpHttpFixture() {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    status: number;
    body: string;
    responseBody: string;
  }> = [];
  let broken = false;
  const listedTool = {
    name: 'echo',
    description: 'Controlled local data echo.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      function respond(status: number, responseBody: string, type = 'application/json') {
        requests.push({ method: req.method, url: req.url, status, body, responseBody });
        res.writeHead(status, { 'content-type': type });
        res.end(responseBody);
      }
      if (req.method === 'GET' && req.url === '/health') {
        respond(200, JSON.stringify({ ok: true, phase: 'shell' }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        respond(405, '');
        return;
      }
      if (broken) {
        respond(500, '', 'text/plain');
        return;
      }
      const message: unknown = JSON.parse(body);
      assert.ok(message && typeof message === 'object' && 'method' in message);
      if (!('id' in message)) {
        respond(202, '');
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'owned-peer', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [listedTool] }
            : undefined;
      respond(
        200,
        JSON.stringify(
          result === undefined
            ? {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Unsupported fixture method' },
              }
            : { jsonrpc: '2.0', id: message.id, result },
        ),
      );
    })().catch((error) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpointUrl: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    listedTool,
    setBroken(value: boolean) {
      broken = value;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
