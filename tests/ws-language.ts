import { parseWebSocketMessage, type WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { configureDomindsSelfUpdate } from '../main/server/dominds-self-update';
import { setupWebSocketServer } from '../main/server/websocket-handler';

class WebSocketMessageQueue {
  private readonly messages: WebSocketMessage[] = [];
  private readonly waiters: Array<(message: WebSocketMessage) => void> = [];

  constructor(private readonly ws: WebSocket) {
    this.ws.on('message', (data: Buffer) => {
      const message = parseWebSocketMessage(data.toString('utf-8'));
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
        return;
      }
      this.messages.push(message);
    });
  }

  async waitForMessage(): Promise<WebSocketMessage> {
    const message = this.messages.shift();
    if (message) {
      return message;
    }
    return await new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      this.ws.once('error', onError);
      this.waiters.push((nextMessage) => {
        this.ws.off('error', onError);
        resolve(nextMessage);
      });
    });
  }

  async waitForMessageType<T extends WebSocketMessage['type']>(
    type: T,
  ): Promise<Extract<WebSocketMessage, { type: T }>> {
    for (;;) {
      const message = await this.waitForMessage();
      if (message.type === type) {
        return message as Extract<WebSocketMessage, { type: T }>;
      }
    }
  }
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
  configureDomindsSelfUpdate({
    host: '127.0.0.1',
    port,
    mode: 'development',
    closeWebSocketClients: () => undefined,
    stopServer: async () => undefined,
  });
  setupWebSocketServer(server, clients, { kind: 'disabled' }, 'zh', 'development');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = new WebSocketMessageQueue(ws);

  {
    const welcome = await messages.waitForMessageType('welcome');
    assert.equal(welcome.serverWorkLanguage, 'zh');
    assert.ok(Array.isArray(welcome.supportedLanguageCodes));
    assert.ok(welcome.supportedLanguageCodes.includes('en'));
    assert.ok(welcome.supportedLanguageCodes.includes('zh'));
    assert.equal(typeof welcome.runControlCountsSnapshotEpoch, 'string');
    assert.ok(welcome.runControlCountsSnapshotEpoch.length > 0);
    assert.equal(typeof welcome.timestamp, 'string');

    const counts = await messages.waitForMessageType('run_control_counts_evt');
    assert.equal(counts.snapshotEpoch, welcome.runControlCountsSnapshotEpoch);
    assert.ok(counts.snapshotSeq > 0);
    assert.equal(counts.proceeding, 0);
    assert.equal(counts.resumable, 0);
    assert.equal(typeof counts.timestamp, 'string');
  }

  ws.send(JSON.stringify({ type: 'set_ui_language', uiLanguage: 'en' }));
  {
    const msg = await messages.waitForMessageType('ui_language_set');
    assert.equal(msg.uiLanguage, 'en');
  }

  ws.send(JSON.stringify({ type: 'unknown_packet_type' }));
  {
    const msg = await messages.waitForMessageType('error');
    assert.equal(typeof msg.message, 'string');
  }

  ws.close();
  server.close();

  console.log('ws-language tests: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
