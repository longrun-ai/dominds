import { parseWebSocketMessage, type WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { configureDomindsSelfUpdate } from '../main/server/dominds-self-update';
import { setupWebSocketServer } from '../main/server/websocket-handler';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

class WebSocketMessageQueue {
  private readonly messages: WebSocketMessage[] = [];
  private readonly waiters: Array<{
    resolve: (message: WebSocketMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure?: Error;
  constructor(ws: WebSocket) {
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    };
    ws.on('error', fail);
    ws.on('close', () =>
      fail(new Error('Owned WebSocket closed before the requested protocol message')),
    );
    ws.on('message', (data: Buffer) => {
      try {
        const message = parseWebSocketMessage(data.toString('utf8'));
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async waitForMessage(): Promise<WebSocketMessage> {
    if (this.failure) throw this.failure;
    const queued = this.messages.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async waitForMessageType<T extends WebSocketMessage['type']>(
    type: T,
  ): Promise<Extract<WebSocketMessage, { type: T }>> {
    for (;;) {
      const message = await this.waitForMessage();
      if (message.type === type) return message as Extract<WebSocketMessage, { type: T }>;
      if (message.type === 'error') throw new Error(message.message);
    }
  }
}
async function run() {
  const evidence = semanticEvidenceCollector('dominds-server-ws-language-');
  await withTempRtws(async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const clients = new Set<WebSocket>();
    configureDomindsSelfUpdate({
      host: '127.0.0.1',
      port: address.port,
      mode: 'development',
      closeWebSocketClients: () => undefined,
      stopServer: async () => undefined,
    });
    setupWebSocketServer(server, clients, { kind: 'disabled' }, 'zh', 'development');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const messages = new WebSocketMessageQueue(ws);
    try {
      const welcome = await messages.waitForMessageType('welcome');
      assert.equal(welcome.serverWorkLanguage, 'zh');
      assert.ok(Array.isArray(welcome.supportedLanguageCodes));
      assert.ok(welcome.supportedLanguageCodes.includes('en'));
      assert.ok(welcome.supportedLanguageCodes.includes('zh'));
      assert.equal(typeof welcome.runControlCountsSnapshotEpoch, 'string');
      assert.ok(welcome.runControlCountsSnapshotEpoch.length > 0);
      assert.ok(Number.isFinite(Date.parse(welcome.timestamp)));
      const counts = await messages.waitForMessageType('run_control_counts_evt');
      assert.equal(counts.snapshotEpoch, welcome.runControlCountsSnapshotEpoch);
      assert.ok(counts.snapshotSeq > 0);
      assert.equal(counts.proceeding, 0);
      assert.equal(counts.resumable, 0);
      assert.ok(Number.isFinite(Date.parse(counts.timestamp)));
      ws.send(JSON.stringify({ type: 'set_ui_language', uiLanguage: 'en' }));
      assert.equal((await messages.waitForMessageType('ui_language_set')).uiLanguage, 'en');
      for (const [id, packet] of [
        ['unknown-packet', { type: 'unknown_packet_type' }],
        [
          'unsupported-language',
          { type: 'set_ui_language', uiLanguage: 'unsupported-language-data' },
        ],
        ['nonstring-language', { type: 'set_ui_language', uiLanguage: 123 }],
      ] as const) {
        ws.send(JSON.stringify(packet));
        const response = await messages.waitForMessageType('error');
        evidence.record({
          id,
          scenario:
            'A real local WebSocket receives this invalid packet after a successful English UI-language acknowledgment.',
          businessValue:
            'Invalid requests have understandable diagnostics and leave the connection usable for valid language selection.',
          context: {
            suppliedPacket: JSON.stringify(packet),
            initialServerLanguage: 'zh',
            lastAcknowledgedUiLanguage: 'en',
            receivedType: response.type,
            scope:
              'Actual local HTTP upgrade, native ws client, public packet parser/handler and protocol responses with authentication disabled. No browser UI, real dialog language mutation, human interaction or provider call is established.',
          },
          reviewQuestions: [
            'Does the complete actual diagnostic accurately explain this supplied invalid request and avoid claiming an unsupported operation succeeded?',
          ],
          actualText: response.message,
        });
        // A subsequent valid request proves the same connection still processes input.
        ws.send(JSON.stringify({ type: 'set_ui_language', uiLanguage: 'en' }));
        assert.equal((await messages.waitForMessageType('ui_language_set')).uiLanguage, 'en');
      }
      ws.send(JSON.stringify({ type: 'set_ui_language', uiLanguage: 'zh' }));
      assert.equal((await messages.waitForMessageType('ui_language_set')).uiLanguage, 'zh');
      const closed = once(ws, 'close');
      ws.close();
      await closed;
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        const closed = once(ws, 'close');
        ws.terminate();
        await closed;
      }
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  await evidence.write();
  console.log(
    'Actual welcome/count epoch, language acknowledgments and invalid-packet recovery: PASS',
  );
}
run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
