import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { shutdownAppsRuntime } from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer, type StartedServer } from '../main/server';
import { parseWebuiPortSpec } from '../main/server/port-selection';
import '../main/tools/builtins';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function writeMinimalRtws(rootAbs: string): Promise<void> {
  await writeText(
    path.join(rootAbs, '.minds', 'llm.yaml'),
    [
      'providers:',
      '  stub:',
      '    name: Stub',
      '    apiType: openai',
      '    baseUrl: https://example.invalid',
      '    apiKeyEnvVar: STUB_API_KEY',
      '    models:',
      '      fake_model: { name: "fake-model" }',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(rootAbs, '.minds', 'team.yaml'),
    [
      'member_defaults:',
      '  provider: stub',
      '  model: fake_model',
      'members:',
      '  tester:',
      '    name: Tester',
      '',
    ].join('\n'),
  );
}

async function closeTcpServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function bindTcpPort(port: number): Promise<net.Server> {
  return await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer();
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function boundPort(server: net.Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected TCP server to have an address with a port');
  }
  return address.port;
}

async function canBindPort(port: number): Promise<boolean> {
  try {
    const server = await bindTcpPort(port);
    await closeTcpServer(server);
    return true;
  } catch {
    return false;
  }
}

async function findOccupiedPortWithFreeNeighbor(direction: 'down' | 'up'): Promise<{
  blocker: net.Server;
  occupiedPort: number;
  expectedPort: number;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const blocker = await bindTcpPort(0);
    const occupiedPort = boundPort(blocker);
    const expectedPort = direction === 'down' ? occupiedPort - 1 : occupiedPort + 1;
    const inRange = expectedPort >= 1024 && expectedPort <= 65535;
    if (inRange && (await canBindPort(expectedPort))) {
      return { blocker, occupiedPort, expectedPort };
    }
    await closeTcpServer(blocker);
  }
  throw new Error(`Failed to find an occupied port with a free ${direction} neighbor`);
}

async function withTempRtws<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-webui-port-selection-'));
  try {
    await writeMinimalRtws(tmpRoot);
    process.chdir(tmpRoot);
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await shutdownAppsRuntime();
    stopMcpSupervisor();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testStrictPortDoesNotFallback(): Promise<void> {
  const blocker = await bindTcpPort(0);
  try {
    const occupiedPort = boundPort(blocker);
    await assert.rejects(
      () =>
        withTempRtws(async () => {
          let started: StartedServer | null = null;
          try {
            started = await startServer({
              port: occupiedPort,
              host: '127.0.0.1',
              mode: 'prod',
              startBackendDriver: false,
              strictPort: true,
            });
          } finally {
            if (started !== null) {
              await started.httpServer.stop();
            }
          }
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const code = (error as Error & { code?: unknown }).code;
        assert.equal(code, 'EADDRINUSE');
        return true;
      },
    );
  } finally {
    await closeTcpServer(blocker);
  }
}

function testPortSpecParsing(): void {
  assert.deepEqual(parseWebuiPortSpec('5678'), {
    port: 5678,
    strictPort: true,
    portAutoDirection: 'down',
  });
  assert.deepEqual(parseWebuiPortSpec('5678+'), {
    port: 5678,
    strictPort: false,
    portAutoDirection: 'up',
  });
  assert.deepEqual(parseWebuiPortSpec('5678-'), {
    port: 5678,
    strictPort: false,
    portAutoDirection: 'down',
  });
  assert.equal(parseWebuiPortSpec('5678++'), null);
  assert.equal(parseWebuiPortSpec('0'), null);
  assert.equal(parseWebuiPortSpec('65536'), null);
}

async function testAutoPortUp(): Promise<void> {
  const { blocker, occupiedPort, expectedPort } = await findOccupiedPortWithFreeNeighbor('up');
  try {
    await withTempRtws(async () => {
      const started = await startServer({
        port: occupiedPort,
        host: '127.0.0.1',
        mode: 'prod',
        startBackendDriver: false,
        strictPort: false,
        portAutoDirection: 'up',
      });
      try {
        assert.equal(started.port, expectedPort);
      } finally {
        await started.httpServer.stop();
      }
    });
  } finally {
    await closeTcpServer(blocker);
  }
}

async function testAutoPortDown(): Promise<void> {
  const { blocker, occupiedPort, expectedPort } = await findOccupiedPortWithFreeNeighbor('down');
  try {
    await withTempRtws(async () => {
      const started = await startServer({
        port: occupiedPort,
        host: '127.0.0.1',
        mode: 'prod',
        startBackendDriver: false,
        strictPort: false,
        portAutoDirection: 'down',
      });
      try {
        assert.equal(started.port, expectedPort);
      } finally {
        await started.httpServer.stop();
      }
    });
  } finally {
    await closeTcpServer(blocker);
  }
}

async function testDefaultPortIsAutoDown(): Promise<void> {
  let blocker: net.Server | null = null;
  try {
    blocker = await bindTcpPort(5666);
  } catch {
    blocker = null;
  }

  try {
    await withTempRtws(async () => {
      const started = await startServer({
        host: '127.0.0.1',
        mode: 'prod',
        startBackendDriver: false,
      });
      try {
        assert.ok(
          started.port < 5666,
          `expected default startup to fall below 5666, got ${started.port}`,
        );
      } finally {
        await started.httpServer.stop();
      }
    });
  } finally {
    if (blocker !== null) {
      await closeTcpServer(blocker);
    }
  }
}

async function main(): Promise<void> {
  testPortSpecParsing();
  await testStrictPortDoesNotFallback();
  await testAutoPortUp();
  await testAutoPortDown();
  await testDefaultPortIsAutoDown();
  console.log('webui-port-selection tests: ok');
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
