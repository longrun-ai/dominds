import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
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

import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-server-certificates-');
const record = (
  id: string,
  scenario: string,
  actualText: string,
  context: Record<string, string | number | boolean>,
) =>
  evidence.record({
    id,
    scenario,
    businessValue:
      'An operator can create or renew the intended local certificate without losing existing material through a refused request, and can understand actual CLI recovery guidance.',
    context: {
      ...context,
      scope:
        'Actual local certificate/key files and native X509 validation; cert CLI module runs in-process with captured console/process.exit boundary. No root CLI process, browser trust, remote TLS client or live LAN reachability is established.',
    },
    reviewQuestions: [
      'Does the complete actual output accurately describe this supplied request, its observed file effects and a usable correction without claiming an operation that did not occur?',
    ],
    actualText,
  });
async function fileBytes(directory: string) {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(directory))
        .sort()
        .map(async (name) => [
          name,
          (await fs.readFile(path.join(directory, name))).toString('base64'),
        ]),
    ),
  );
}
async function validatePair(certPath: string, keyPath: string) {
  const cert = new X509Certificate(await fs.readFile(certPath));
  assert.equal(cert.checkPrivateKey(createPrivateKey(await fs.readFile(keyPath))), true);
  return cert;
}

const requireFn = createRequire(__filename);
const mutableOs = requireFn('node:os') as typeof os;

async function withTempCertsDir<T>(fn: (certsDirAbs: string) => Promise<T>): Promise<T> {
  const certsDirAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-certs-'));
  console.log('Owned certificate fixture: ' + certsDirAbs);
  const result = await fn(certsDirAbs);
  await fs.rm(certsDirAbs, { recursive: true, force: true }); // Failed evidence remains.
  return result;
}

async function testCreateAndFindMatchingCertificate(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    const created = await createSelfSignedCertificate({
      host: '192.168.55.10',
      days: 3650,
      certsDirAbs,
    });
    assert.equal(created.host, '192.168.55.10');
    const native = await validatePair(created.certPath, created.keyPath);
    assert.ok(native.checkIP('192.168.55.10'));
    assert.equal(native.checkIP('192.168.55.99'), undefined);

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

    const native = await validatePair(created.certPath, created.keyPath);
    assert.ok(native.checkIP('192.168.55.13'));
    assert.ok(native.checkHost('dominds-test.lan'));
    assert.ok(native.checkIP('fd00::55'));
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
    for (const [index, host] of ['127.0.0.1', '0.0.0.0', '169.254.1.2', 'fe80::1'].entries()) {
      const before = await fileBytes(certsDirAbs);
      let detail = '';
      await assert.rejects(
        () => createSelfSignedCertificate({ host, days: 3650, certsDirAbs }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          detail = error.message;
          return true;
        },
      );
      assert.deepEqual(await fileBytes(certsDirAbs), before);
      record(
        'invalid-host-' + index,
        'A supplied loopback, bind-all or link-local host is refused for certificate creation.',
        detail,
        { host, days: 3650, certificateFilesUnchanged: true },
      );
    }

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
    const first = await createSelfSignedCertificate({
      host: '192.168.55.11',
      days: 3650,
      certsDirAbs,
    });
    const old = await validatePair(first.certPath, first.keyPath);
    const before = await fileBytes(certsDirAbs);
    let detail = '';
    await assert.rejects(
      () => createSelfSignedCertificate({ host: '192.168.55.11', days: 30, certsDirAbs }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        detail = error.message;
        return true;
      },
    );
    assert.deepEqual(await fileBytes(certsDirAbs), before);
    record(
      'existing-certificate-refused',
      'An otherwise valid request tries to replace a real certificate/key/metadata bundle without force.',
      detail,
      { host: '192.168.55.11', requestedDays: 30, existingDays: 3650, filesUnchanged: true },
    );
    const renewed = await createSelfSignedCertificate({
      host: '192.168.55.11',
      days: 30,
      certsDirAbs,
      force: true,
    });
    const current = await validatePair(renewed.certPath, renewed.keyPath);
    assert.ok(current.checkIP('192.168.55.11'));
    assert.notDeepEqual(current.raw, old.raw);
    assert.ok(Date.parse(current.validTo) < Date.parse(old.validTo));
    assert.deepEqual((await fs.readdir(certsDirAbs)).sort(), Object.keys(before));
    const metadata: unknown = JSON.parse(await fs.readFile(renewed.metadataPath, 'utf8'));
    assert.ok(typeof metadata === 'object' && metadata !== null && 'days' in metadata);
    assert.equal(metadata.days, 30);
    const lookup = await findAutoHttpsCertificateForHost({ host: '192.168.55.11', certsDirAbs });
    assert.equal(lookup.kind, 'found');
    if (lookup.kind === 'found') assert.equal(lookup.certificate.certPath, renewed.certPath);
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
  stdout: readonly string[];
}> {
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;
  const stderr: string[] = [];
  const stdout: string[] = [];
  console.error = (...args: readonly unknown[]): void => {
    stderr.push(args.map((arg) => String(arg)).join(' '));
  };
  console.log = (...args: readonly unknown[]): void => {
    stdout.push(args.map((arg) => String(arg)).join(' '));
  };
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new CapturedProcessExit(code);
  }) as typeof process.exit;
  try {
    await fn();
  } catch (error: unknown) {
    if (error instanceof CapturedProcessExit) {
      return { code: error.code, stderr, stdout };
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
    const detectedHosts = await resolveLanHttpsHostsForBindHost('::');
    const detectedUrlHosts = detectedHosts.map(
      (host) => new URL('http://' + (host.includes(':') ? '[' + host + ']' : host)).hostname,
    );
    const lines = await captureConsoleLog(async () => {
      await certCliMain(['status', '--port', '5666', '--origin'], { certsDirAbs });
    });
    assert.equal(lines.length, 1);
    const origin = new URL(lines[0]!);
    assert.equal(origin.protocol, 'http:');
    assert.ok(
      (detectedUrlHosts.length ? detectedUrlHosts : ['localhost']).includes(origin.hostname),
      'The default machine origin uses an actually detected host, with localhost only as the no-host fallback',
    );
    assert.equal(origin.port, '5666');
    assert.equal(origin.pathname, '/');
    assert.equal(origin.search, '');
    assert.equal(origin.hash, '');
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
      record(
        'cli-created-certificate',
        'The in-process cert CLI creates an actual 30-day certificate with no system executable PATH.',
        lines.join('\n'),
        {
          args: JSON.stringify(['create', '--host', '192.168.55.15', '--days', '30']),
          host: '192.168.55.15',
          scopeDetail:
            'Success is verified by actual native certificate/key files, not this receipt sentence.',
        },
      );

      const lookup = await findAutoHttpsCertificateForHost({
        host: '192.168.55.15',
        certsDirAbs,
      });
      assert.equal(lookup.kind, 'found');
      if (lookup.kind === 'found') {
        const native = await validatePair(lookup.certificate.certPath, lookup.certificate.keyPath);
        assert.ok(native.checkIP('192.168.55.15'));
      }
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
    const cases = [
      ['self-cert'],
      ['create', '--port', '5666'],
      ['create', '--origin'],
      ['status', '--days', '30'],
      ['status', '--force'],
      ['status', '--host', '192.168.55.10', '--host', '192.168.55.11'],
    ];
    for (const [index, args] of cases.entries()) {
      const before = await fileBytes(certsDirAbs);
      const exit = await captureCliExit(async () => {
        await certCliMain(args, { certsDirAbs });
      });
      assert.equal(exit.code, 1);
      assert.deepEqual(await fileBytes(certsDirAbs), before);
      record(
        'cli-invalid-options-' + index,
        'The in-process cert CLI refuses this supplied subcommand/option combination, preserving certificate files.',
        JSON.stringify({ stderr: exit.stderr, stdout: exit.stdout }, null, 2),
        { args: JSON.stringify(args), exitCode: 1, filesUnchanged: true },
      );
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
  await withTempRtws(async () => {
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
  });
  await evidence.write();
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
