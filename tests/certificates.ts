import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { main as certCliMain } from '../main/cli/cert';
import {
  createSelfSignedCertificate,
  findAutoHttpsCertificateForHost,
} from '../main/server/certificates';
import { isLanHttpsHost, resolveLanHttpsHostsForBindHost } from '../main/server/network-hosts';

const requireFn = createRequire(__filename);
const mutableOs = requireFn('node:os') as typeof os;

async function withTempCertsDir<T>(fn: (certsDirAbs: string) => Promise<T>): Promise<T> {
  const certsDirAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-certs-'));
  try {
    return await fn(certsDirAbs);
  } finally {
    await fs.rm(certsDirAbs, { recursive: true, force: true });
  }
}

async function testCreateAndFindMatchingCertificate(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const created = await createSelfSignedCertificate({
      host: '192.168.55.10',
      days: 3650,
      certsDirAbs,
    });
    assert.equal(created.host, '192.168.55.10');

    const lookup = await findAutoHttpsCertificateForHost({
      host: '192.168.55.10',
      certsDirAbs,
    });
    assert.equal(lookup.kind, 'found');
    if (lookup.kind !== 'found') return;
    assert.equal(lookup.certificate.certPath, created.certPath);
    assert.equal(lookup.certificate.keyPath, created.keyPath);
    assert.equal(lookup.certificate.matchedHost, '192.168.55.10');
    assert.equal(lookup.diagnostics.length, 0);
  });
}

async function testCreateCertificateWithDnsAndIpv6AltHosts(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const created = await createSelfSignedCertificate({
      host: '192.168.55.13',
      altHosts: ['dominds-test.lan', 'fd00::55'],
      days: 3650,
      certsDirAbs,
    });
    assert.deepEqual(created.hosts, ['192.168.55.13', 'dominds-test.lan', 'fd00::55']);

    for (const host of created.hosts) {
      const lookup = await findAutoHttpsCertificateForHost({ host, certsDirAbs });
      assert.equal(lookup.kind, 'found');
      if (lookup.kind !== 'found') continue;
      assert.equal(lookup.certificate.certPath, created.certPath);
      assert.equal(lookup.certificate.matchedHost, host);
      assert.equal(lookup.diagnostics.length, 0);
    }
  });
}

async function testCreateDoesNotRequireSystemOpenSsl(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const created = await createSelfSignedCertificate({
        host: '192.168.55.12',
        days: 3650,
        certsDirAbs,
      });
      const lookup = await findAutoHttpsCertificateForHost({
        host: '192.168.55.12',
        certsDirAbs,
      });
      assert.equal(lookup.kind, 'found');
      if (lookup.kind !== 'found') return;
      assert.equal(lookup.certificate.certPath, created.certPath);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
}

async function testLoopbackDoesNotEnableHttps(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '127.0.0.1',
          days: 3650,
          certsDirAbs,
        }),
      /must not be localhost, loopback, 127\.0\.0\.0\/8, 169\.254\.0\.0\/16, ::1, fe80::\/10, 0\.0\.0\.0, or ::/,
    );
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '0.0.0.0',
          days: 3650,
          certsDirAbs,
        }),
      /must not be localhost, loopback, 127\.0\.0\.0\/8, 169\.254\.0\.0\/16, ::1, fe80::\/10, 0\.0\.0\.0, or ::/,
    );
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '169.254.1.2',
          days: 3650,
          certsDirAbs,
        }),
      /169\.254\.0\.0\/16/,
    );
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: 'fe80::1',
          days: 3650,
          certsDirAbs,
        }),
      /fe80::\/10/,
    );

    const lookup = await findAutoHttpsCertificateForHost({
      host: '127.0.0.1',
      certsDirAbs,
    });
    assert.equal(lookup.kind, 'not_found');
    assert.equal(lookup.diagnostics.length, 0);
  });
}

async function testForceRequiredForExistingFiles(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    await createSelfSignedCertificate({
      host: '192.168.55.11',
      days: 3650,
      certsDirAbs,
    });

    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '192.168.55.11',
          days: 3650,
          certsDirAbs,
        }),
      /Refusing to overwrite existing certificate file/,
    );

    await createSelfSignedCertificate({
      host: '192.168.55.11',
      days: 3650,
      certsDirAbs,
      force: true,
    });
  });
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<readonly string[]> {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const lines: string[] = [];
  console.log = (...args: readonly unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  console.info = (...args: readonly unknown[]): void => {
    throw new Error(
      `Expected cert status --origin not to write info logs to stdout: ${String(args[0])}`,
    );
  };
  console.debug = (...args: readonly unknown[]): void => {
    throw new Error(
      `Expected cert status --origin not to write debug logs to stdout: ${String(args[0])}`,
    );
  };
  try {
    await fn();
    return lines;
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  }
}

class CapturedProcessExit extends Error {
  readonly code: string | number | null | undefined;

  constructor(code: string | number | null | undefined) {
    super(`process.exit(${String(code)})`);
    this.code = code;
  }
}

async function captureCliExit(fn: () => Promise<void>): Promise<{
  code: string | number | null | undefined;
  stderr: readonly string[];
}> {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;
  const stderr: string[] = [];
  console.error = (...args: readonly unknown[]): void => {
    stderr.push(args.map((arg) => String(arg)).join(' '));
  };
  console.log = (): void => {
    // Suppress help text during expected parse failures.
  };
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new CapturedProcessExit(code);
  }) as typeof process.exit;
  try {
    await fn();
  } catch (error: unknown) {
    if (error instanceof CapturedProcessExit) {
      return { code: error.code, stderr };
    }
    throw error;
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
  }
  throw new Error('Expected CLI to call process.exit');
}

async function withPatchedDetectedHostname<T>(hostname: string, fn: () => Promise<T>): Promise<T> {
  const originalHostname = mutableOs.hostname;
  const originalNetworkInterfaces = mutableOs.networkInterfaces;
  mutableOs.hostname = (): string => hostname;
  mutableOs.networkInterfaces = (): ReturnType<typeof os.networkInterfaces> => ({});
  try {
    return await fn();
  } finally {
    mutableOs.hostname = originalHostname;
    mutableOs.networkInterfaces = originalNetworkInterfaces;
  }
}

async function testCertStatusDefaultsToDetectedHosts(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const lines = await captureConsoleLog(async () => {
      await certCliMain(['status', '--port', '5666', '--origin'], { certsDirAbs });
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^http:\/\/.+:5666$/);
  });
}

async function testCertCliCreateDoesNotRequireSystemOpenSsl(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const lines = await captureConsoleLog(async () => {
        await certCliMain(['create', '--host', '192.168.55.15', '--days', '30'], {
          certsDirAbs,
        });
      });
      assert.equal(lines[0], 'Created self-signed certificate for 192.168.55.15');

      const lookup = await findAutoHttpsCertificateForHost({
        host: '192.168.55.15',
        certsDirAbs,
      });
      assert.equal(lookup.kind, 'found');
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
}

async function testCertCliRejectsInvalidSubcommandOptions(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const cases: ReadonlyArray<Readonly<{ args: readonly string[]; message: RegExp }>> = [
      { args: ['self-cert'], message: /Unknown cert subcommand 'self-cert'/ },
      { args: ['create', '--port', '5666'], message: /--port is only valid for cert status/ },
      { args: ['create', '--origin'], message: /--origin is only valid for cert status/ },
      { args: ['status', '--days', '30'], message: /--days is only valid for cert create/ },
      { args: ['status', '--force'], message: /--force is only valid for cert create/ },
      {
        args: ['status', '--host', '192.168.55.10', '--host', '192.168.55.11'],
        message: /--host can only be repeated for cert create/,
      },
    ];
    for (const item of cases) {
      const exit = await captureCliExit(async () => {
        await certCliMain(item.args, { certsDirAbs });
      });
      assert.equal(exit.code, 1);
      assert.ok(exit.stderr.length > 0);
      assert.match(exit.stderr[0], item.message);
    }
  });
}

function testLanHostFiltering(): void {
  assert.equal(isLanHttpsHost('localhost'), false);
  assert.equal(isLanHttpsHost('loopback'), false);
  assert.equal(isLanHttpsHost('127.0.0.1'), false);
  assert.equal(isLanHttpsHost('127.9.8.7'), false);
  assert.equal(isLanHttpsHost('::1'), false);
  assert.equal(isLanHttpsHost('::ffff:127.0.0.1'), false);
  assert.equal(isLanHttpsHost('::ffff:0.0.0.0'), false);
  assert.equal(isLanHttpsHost('0.0.0.0'), false);
  assert.equal(isLanHttpsHost('::'), false);
  assert.equal(isLanHttpsHost('169.254.1.2'), false);
  assert.equal(isLanHttpsHost('fe80::1'), false);
  assert.equal(isLanHttpsHost('::ffff:192.168.55.10'), true);
  assert.equal(isLanHttpsHost('192.168.55.10'), true);
}

async function testDetectedHostsExcludeSimpleHostname(): Promise<void> {
  await withPatchedDetectedHostname('cymp', async () => {
    const hosts = await resolveLanHttpsHostsForBindHost('0.0.0.0');
    assert.equal(hosts.includes('cymp'), false);
  });
}

async function testDetectedHostsIncludeQualifiedHostname(): Promise<void> {
  await withPatchedDetectedHostname('cymp.lan', async () => {
    const hosts = await resolveLanHttpsHostsForBindHost('0.0.0.0');
    assert.equal(hosts.includes('cymp.lan'), true);
  });
}

async function main(): Promise<void> {
  testLanHostFiltering();
  await testDetectedHostsExcludeSimpleHostname();
  await testDetectedHostsIncludeQualifiedHostname();
  await testCreateAndFindMatchingCertificate();
  await testCreateCertificateWithDnsAndIpv6AltHosts();
  await testCreateDoesNotRequireSystemOpenSsl();
  await testLoopbackDoesNotEnableHttps();
  await testForceRequiredForExistingFiles();
  await testCertStatusDefaultsToDetectedHosts();
  await testCertCliCreateDoesNotRequireSystemOpenSsl();
  await testCertCliRejectsInvalidSubcommandOptions();
  console.log('certificates tests: ok');
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
