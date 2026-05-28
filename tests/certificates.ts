import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createSelfSignedCertificate,
  findAutoHttpsCertificateForHost,
} from '../main/server/certificates';
import { isLanHttpsHost } from '../main/server/network-hosts';

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

async function testLoopbackDoesNotEnableHttps(): Promise<void> {
  await withTempCertsDir(async (certsDirAbs) => {
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '127.0.0.1',
          days: 3650,
          certsDirAbs,
        }),
      /must not be localhost, loopback, 127\.0\.0\.0\/8, ::1, 0\.0\.0\.0, or ::/,
    );
    await assert.rejects(
      () =>
        createSelfSignedCertificate({
          host: '0.0.0.0',
          days: 3650,
          certsDirAbs,
        }),
      /must not be localhost, loopback, 127\.0\.0\.0\/8, ::1, 0\.0\.0\.0, or ::/,
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
  assert.equal(isLanHttpsHost('::ffff:192.168.55.10'), true);
  assert.equal(isLanHttpsHost('192.168.55.10'), true);
}

async function main(): Promise<void> {
  testLanHostFiltering();
  await testCreateAndFindMatchingCertificate();
  await testLoopbackDoesNotEnableHttps();
  await testForceRequiredForExistingFiles();
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
