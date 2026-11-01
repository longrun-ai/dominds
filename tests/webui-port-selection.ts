import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { withTempRtws as withManagedRtws } from './kernel-driver/helpers';

import { shutdownAppsRuntime } from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer, type StartedServer } from '../main/server';
import {
  createSelfSignedCertificate,
  findAutoHttpsCertificateForHost,
} from '../main/server/certificates';
import { resolveLanHttpsHostsForBindHost } from '../main/server/network-hosts';
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

async function bindTcpPort(port: number, host: string = '127.0.0.1'): Promise<net.Server> {
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
    server.listen({ host, port, exclusive: true });
  });
}

function boundPort(server: net.Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected TCP server to have an address with a port');
  }
  return address.port;
}

async function canBindPort(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  try {
    const server = await bindTcpPort(port, host);
    await closeTcpServer(server);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') return false;
    throw error;
  }
}

async function getFreeTcpPort(host: string = '127.0.0.1'): Promise<number> {
  const server = await bindTcpPort(0, host);
  try {
    return boundPort(server);
  } finally {
    await closeTcpServer(server);
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

async function findOccupiedPortWithTwoFreeNeighbors(direction: 'down' | 'up'): Promise<{
  blocker: net.Server;
  occupiedPort: number;
  expectedHttpPort: number;
  expectedHttpsPort: number;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const blocker = await bindTcpPort(0, '0.0.0.0');
    const occupiedPort = boundPort(blocker);
    const expectedHttpPort = direction === 'down' ? occupiedPort - 1 : occupiedPort + 1;
    const expectedHttpsPort = direction === 'down' ? expectedHttpPort - 1 : expectedHttpPort + 1;
    const inRange =
      expectedHttpPort >= 1024 &&
      expectedHttpPort <= 65535 &&
      expectedHttpsPort >= 1024 &&
      expectedHttpsPort <= 65535;
    if (
      inRange &&
      (await canBindPort(expectedHttpPort, '0.0.0.0')) &&
      (await canBindPort(expectedHttpsPort, '0.0.0.0'))
    ) {
      return { blocker, occupiedPort, expectedHttpPort, expectedHttpsPort };
    }
    await closeTcpServer(blocker);
  }
  throw new Error(`Failed to find an occupied port with two free ${direction} neighbors`);
}

async function findFreePortWithOccupiedNextPort(): Promise<{
  blocker: net.Server;
  expectedHttpPort: number;
  expectedHttpsPort: number;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const blocker = await bindTcpPort(0, '0.0.0.0');
    const occupiedPort = boundPort(blocker);
    const expectedHttpPort = occupiedPort - 1;
    const expectedHttpsPort = occupiedPort + 1;
    const inRange = expectedHttpPort >= 1024 && expectedHttpsPort <= 65535;
    if (
      inRange &&
      (await canBindPort(expectedHttpPort, '0.0.0.0')) &&
      (await canBindPort(expectedHttpsPort, '0.0.0.0'))
    ) {
      return { blocker, expectedHttpPort, expectedHttpsPort };
    }
    await closeTcpServer(blocker);
  }
  throw new Error('Failed to find a free HTTP port around an occupied HTTPS candidate port');
}

async function withTempCertsDir<T>(fn: (certsDirAbs: string) => Promise<T>): Promise<T> {
  const certsDirAbs = await fs.mkdtemp(path.join(process.cwd(), 'webui-cert-data-'));
  console.log('Owned startup certificate fixture: ' + certsDirAbs);
  const result = await fn(certsDirAbs);
  await fs.rm(certsDirAbs, { recursive: true, force: true });
  return result;
}

async function createBindAllHttpsCert(certsDirAbs: string): Promise<string> {
  const hosts = await resolveLanHttpsHostsForBindHost('0.0.0.0');
  for (const host of hosts) {
    // Supplied host structure determines eligibility; never classify a rejection by prose.
    if (net.isIP(host) === 0 && !host.includes('.')) continue;
    await createSelfSignedCertificate({ host, certsDirAbs });
    return host;
  }
  throw new Error('Expected at least one certificate-valid non-loopback LAN host for HTTPS test');
}

async function withTempRtws(fn: () => Promise<void>): Promise<void> {
  await withManagedRtws(async (root) => {
    await writeMinimalRtws(root);
    try {
      await fn();
    } finally {
      await shutdownAppsRuntime();
      stopMcpSupervisor();
    }
  });
}
function assertBoundHttpPort(started: StartedServer, expected: number) {
  assert.equal(started.port, expected);
  const address = started.httpServer.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.port, expected);
}
async function assertTlsListener(started: StartedServer, certsDirAbs: string) {
  assert.ok(started.httpsServer && started.httpsPort && started.httpsUrlHost);
  const address = started.httpsServer.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.port, started.httpsPort);
  const lookup = await findAutoHttpsCertificateForHost({ host: started.httpsUrlHost, certsDirAbs });
  assert.equal(lookup.kind, 'found');
  if (lookup.kind !== 'found') throw new Error('Expected actual startup certificate');
  const ca = await fs.readFile(lookup.certificate.certPath);
  const peerHost = started.httpsUrlHost;
  // Trust only this owned certificate and verify its advertised host while connecting locally.
  const socket = tls.connect({
    host: '127.0.0.1',
    port: started.httpsPort,
    ca,
    checkServerIdentity: (_host, peer) => tls.checkServerIdentity(peerHost, peer),
  });
  try {
    await once(socket, 'secureConnect');
    assert.equal(socket.authorized, true);
    assert.deepEqual(socket.getPeerCertificate().raw, new X509Certificate(ca).raw);
  } finally {
    socket.destroy();
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
        assertBoundHttpPort(started, expectedPort);
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
        assertBoundHttpPort(started, expectedPort);
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
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
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
        assertBoundHttpPort(started, started.port);
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

async function testStrictPortDisablesBuiltInHttps(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    await createBindAllHttpsCert(certsDirAbs);
    const port = await getFreeTcpPort('0.0.0.0');
    await withTempRtws(async () => {
      const started = await startServer({
        port,
        host: '0.0.0.0',
        mode: 'prod',
        certsDirAbs,
        startBackendDriver: false,
        strictPort: true,
      });
      try {
        assertBoundHttpPort(started, port);
        assert.equal(started.httpsServer, undefined);
        assert.equal(started.httpsPort, undefined);
      } finally {
        await started.httpServer.stop();
      }
    });
  });
}

async function testAutoPortStartsAdjacentHttps(): Promise<void> {
  const { blocker, occupiedPort, expectedHttpPort, expectedHttpsPort } =
    await findOccupiedPortWithTwoFreeNeighbors('up');
  try {
    await withTempCertsDir(async (certsDirAbs) => {
      const certHost = await createBindAllHttpsCert(certsDirAbs);
      await withTempRtws(async () => {
        const started = await startServer({
          port: occupiedPort,
          host: '0.0.0.0',
          mode: 'prod',
          certsDirAbs,
          startBackendDriver: false,
          strictPort: false,
          portAutoDirection: 'up',
        });
        try {
          assertBoundHttpPort(started, expectedHttpPort);
          assert.equal(started.httpsPort, expectedHttpsPort);
          assert.equal(started.httpsUrlHost, certHost);
          await assertTlsListener(started, certsDirAbs);
        } finally {
          await started.httpServer.stop();
        }
      });
    });
  } finally {
    await closeTcpServer(blocker);
  }
}

async function testHttpsPortSkipsOccupiedAdjacentPort(): Promise<void> {
  const { blocker, expectedHttpPort, expectedHttpsPort } = await findFreePortWithOccupiedNextPort();
  try {
    await withTempCertsDir(async (certsDirAbs) => {
      await createBindAllHttpsCert(certsDirAbs);
      await withTempRtws(async () => {
        const started = await startServer({
          port: expectedHttpPort,
          host: '0.0.0.0',
          mode: 'prod',
          certsDirAbs,
          startBackendDriver: false,
          strictPort: false,
          portAutoDirection: 'up',
        });
        try {
          assertBoundHttpPort(started, expectedHttpPort);
          assert.equal(started.httpsPort, expectedHttpsPort);
          await assertTlsListener(started, certsDirAbs);
        } finally {
          await started.httpServer.stop();
        }
      });
    });
  } finally {
    await closeTcpServer(blocker);
  }
}

async function main(): Promise<void> {
  testPortSpecParsing();
  await testStrictPortDoesNotFallback();
  await testAutoPortUp();
  await testAutoPortDown();
  await testDefaultPortIsAutoDown();
  await testStrictPortDisablesBuiltInHttps();
  await testAutoPortStartsAdjacentHttps();
  await testHttpsPortSkipsOccupiedAdjacentPort();
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
