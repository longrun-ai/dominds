import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { DomindsAppInstallJson } from '@longrun-ai/kernel/app-json';
import { writeAppText, writeLocalApp } from './app-fixture';

/** A real child factory reports entry and waits for an owned TCP release, with no timing oracle. */
export async function createAppFactoryGate() {
  const sockets = new Set<net.Socket>();
  const packets: unknown[] = [];
  let resolveEntered: (value: unknown) => void = () => undefined;
  let rejectEntered: (error: unknown) => void = () => undefined;
  const entered = new Promise<unknown>((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let data = '';
    socket.on('data', (chunk: string) => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const packet: unknown = JSON.parse(data.slice(0, end));
        packets.push(packet);
        resolveEntered(packet);
      } catch (error) {
        rejectEntered(error);
      }
      socket.removeAllListeners('data');
    });
    socket.once('error', rejectEntered);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    entered,
    packets,
    childSource: [
      "const socket = require('node:net').connect(" + address.port + ", '127.0.0.1');",
      'await new Promise((resolve, reject) => {',
      "  socket.once('error', reject);",
      "  socket.once('connect', () => socket.write(JSON.stringify({ kind: 'factory_entered', appId: ctx.appId, rtwsRootAbs: ctx.rtwsRootAbs, kernel: ctx.kernel }) + '\\n'));",
      "  let release = '';",
      "  socket.on('data', (chunk) => { release += chunk.toString(); if (release.includes('\\n')) { socket.end(); resolve(); } });",
      '});',
    ].join('\n'),
    release() {
      for (const socket of sockets) socket.end('continue\n');
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Supplied metadata and actual Node factory, while native resolution/hosting/IPC stay real. */
export async function writeHostedApp(
  rtws: string,
  id: string,
  factoryBody: string,
  toolNames: readonly string[] = ['probe_tool'],
): Promise<DomindsAppInstallJson> {
  const root = path.join(rtws, 'dominds-apps', ...id.split('/'));
  const base = await writeLocalApp(root, id);
  const supplied: DomindsAppInstallJson = {
    ...base,
    contributes: {
      toolsets: [
        {
          id: 'controlled_host_tools',
          descriptionI18n: { en: 'given-toolset-description', zh: 'given-toolset-description' },
          tools: toolNames.map((name) => ({
            name,
            description: 'given-tool-description',
            descriptionI18n: { en: 'given-tool-description', zh: 'given-tool-description' },
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          })),
        },
      ],
    },
  };
  await writeAppText(path.join(root, 'app-json.json'), JSON.stringify(supplied));
  await writeAppText(
    path.join(root, 'index.js'),
    'exports.main = async function (ctx) {\n' + factoryBody + '\n};\n',
  );
  return supplied;
}

export async function assertWebuiDelivered(baseUrl: string): Promise<void> {
  const response = await fetch(baseUrl + '/');
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await fs.readFile(path.resolve(__dirname, '../../webapp/dist/index.html')),
  );
}

/** An unfinished native transition must not become a process-zero test result. */
export function runHostScenario(scenario: () => Promise<void>): void {
  let complete = false;
  process.once('beforeExit', () => {
    if (!complete) {
      console.error('Host scenario exited before its completion boundary');
      process.exitCode = 1;
    }
  });
  scenario()
    .then(() => {
      complete = true;
    })
    .catch((error: unknown) => {
      complete = true;
      console.error(error);
      process.exitCode = 1;
    });
}
