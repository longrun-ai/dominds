import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  parseCmdRunnerRequestLine,
  parseCmdRunnerResponseLine,
  type CmdRunnerRequest,
  type CmdRunnerResponse,
} from '../../main/tools/cmd-runner-protocol';

type Observation = { request: CmdRunnerRequest; response: Promise<CmdRunnerResponse> };
/** Transparent owned IPC peer: capture the actual adapter request/runner response.
 * No synthetic runner response or assumption that observing a request means its
 * waiter has been installed. The controlled child produces ongoing output.
 */
export async function observeRunner(endpoint: string) {
  const name = 'dm-observe-' + randomUUID().slice(0, 8);
  const observedEndpoint =
    process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  const sockets = new Set<net.Socket>();
  let next: ((value: Observation) => void) | undefined;
  const server = net.createServer((client) => {
    const upstream = net.createConnection(endpoint);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    let requestBuffer = '';
    let responseBuffer = '';
    let resolveResponse: ((response: CmdRunnerResponse) => void) | undefined;
    let rejectResponse: ((error: Error) => void) | undefined;
    client.setEncoding('utf8');
    upstream.setEncoding('utf8');
    client.on('data', (chunk) => {
      requestBuffer += chunk;
      if (!requestBuffer.includes('\n')) return;
      const line = requestBuffer.slice(0, requestBuffer.indexOf('\n'));
      requestBuffer = '';
      const request = parseCmdRunnerRequestLine(line);
      const response = new Promise<CmdRunnerResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      // The adapter uses one request per connection. Forward its exact frame.
      upstream.write(line + '\n');
      if (request.type === 'get_output' && request.waitForNewOutput) {
        if (!next) {
          client.destroy(new Error('Missing wait observation consumer'));
          return;
        }
        const consumer = next;
        next = undefined;
        consumer({ request, response });
      }
      void response.catch(() => {});
    });
    upstream.on('data', (chunk) => {
      responseBuffer += chunk;
      const end = responseBuffer.indexOf('\n');
      if (end < 0) return;
      const line = responseBuffer.slice(0, end);
      responseBuffer = '';
      resolveResponse?.(parseCmdRunnerResponseLine(line));
      client.end(line + '\n');
    });
    upstream.once('close', () =>
      rejectResponse?.(new Error('Owned runner connection closed before response')),
    );
  });
  server.listen(observedEndpoint);
  await once(server, 'listening');
  return {
    endpoint: observedEndpoint,
    nextWait() {
      if (next) throw new Error('Only one controlled wait can be observed at a time');
      return new Promise<Observation>((resolve) => {
        next = resolve;
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (process.platform !== 'win32') await fs.rm(observedEndpoint, { force: true });
    },
  };
}
