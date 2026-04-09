import { parseWebSocketMessage, type WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { setupWebSocketServer } from '../main/server/websocket-handler';

function waitForMessage(ws: WebSocket): Promise<WebSocketMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      try {
        resolve(parseWebSocketMessage(data.toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    };
    ws.once('message', onMessage);
    ws.once('error', reject);
  });
}

async function run(): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  if (addr === null || typeof addr !== 'object') {
    throw new Error('Failed to bind http server');
  }
  const port = addr.port;

  const clients = new Set<WebSocket>();
  setupWebSocketServer(server, clients, { kind: 'disabled' }, 'zh');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  {
    const msg = await waitForMessage(ws);
    assert.equal(msg.type, 'welcome');
    if (msg.type !== 'welcome') {
      throw new Error(`Expected welcome message, got ${msg.type}`);
    }
    const welcome = msg;
    assert.equal(welcome.serverWorkLanguage, 'zh');
    assert.ok(Array.isArray(welcome.supportedLanguageCodes));
    assert.ok(welcome.supportedLanguageCodes.includes('en'));
    assert.ok(welcome.supportedLanguageCodes.includes('zh'));
    assert.equal(typeof welcome.timestamp, 'string');
  }

  ws.send(JSON.stringify({ type: 'set_ui_language', uiLanguage: 'en' }));
  {
    const msg = await waitForMessage(ws);
    assert.equal(msg.type, 'ui_language_set');
    assert.equal((msg as { uiLanguage?: unknown }).uiLanguage, 'en');
  }

  ws.send(JSON.stringify({ type: 'unknown_packet_type' }));
  {
    const msg = await waitForMessage(ws);
    assert.equal(msg.type, 'error');
    assert.equal(typeof (msg as { message?: unknown }).message, 'string');
  }

  ws.close();
  server.close();

  console.log('ws-language tests: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
