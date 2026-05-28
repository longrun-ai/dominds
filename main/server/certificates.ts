import { X509Certificate, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import type { CertificateExtension, CertificateField, SubjectAltNameEntry } from 'selfsigned';
import { generate as generateSelfSignedCertificate } from 'selfsigned';
import {
  isLanHttpsHost,
  normalizeNetworkHost,
  resolveDefaultLanHttpsHosts,
  resolveLanHttpsHostsForBindHost,
} from './network-hosts';

const CERT_EXTENSIONS = ['.crt', '.cert', '.pem'];
const KEY_SUFFIXES = ['.key.pem', '.key', '-key.pem'];
export const DEFAULT_SELF_SIGNED_CERT_DAYS = 3650;

export type HttpsCertificateMaterial = {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  matchedHost: string;
  matchedHostPriority: number;
  validTo: Date;
};

export type CertificateLookupEndpoint = Readonly<{
  bindHost: string;
  urlHost: string;
}>;

export type CertificateLookupDiagnostic =
  | {
      level: 'warn';
      code:
        | 'invalid_cert_file'
        | 'missing_key_file'
        | 'invalid_key_pair'
        | 'expired_or_not_yet_valid';
      message: string;
      certPath: string;
      keyPath?: string;
    }
  | {
      level: 'warn';
      code: 'multiple_matching_certs';
      message: string;
      host: string;
      certPaths: readonly string[];
    };

export type CertificateLookupResult =
  | {
      kind: 'found';
      certsDirAbs: string;
      endpoint: CertificateLookupEndpoint;
      certificate: HttpsCertificateMaterial;
      diagnostics: readonly CertificateLookupDiagnostic[];
    }
  | {
      kind: 'not_found';
      certsDirAbs: string;
      endpoint: CertificateLookupEndpoint;
      diagnostics: readonly CertificateLookupDiagnostic[];
    };

export type CreatedSelfSignedCertificate = {
  host: string;
  hosts: readonly string[];
  days: number;
  certsDirAbs: string;
  certPath: string;
  keyPath: string;
  metadataPath: string;
};

type CandidateCertificate = HttpsCertificateMaterial;

export function getDefaultDomindsCertsDir(): string {
  return path.join(os.homedir(), '.dominds', 'certs');
}

export async function findAutoHttpsCertificateForHost(params: {
  host: string;
  certsDirAbs?: string;
  now?: Date;
}): Promise<CertificateLookupResult> {
  const host = normalizeNetworkHost(params.host);
  const matchHosts = await resolveLanHttpsHostsForBindHost(host);
  const endpoint: CertificateLookupEndpoint = { bindHost: host, urlHost: matchHosts[0] ?? host };
  const certsDirAbs = params.certsDirAbs ?? getDefaultDomindsCertsDir();
  const now = params.now ?? new Date();
  const diagnostics: CertificateLookupDiagnostic[] = [];
  if (matchHosts.length === 0) {
    return { kind: 'not_found', certsDirAbs, endpoint, diagnostics };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(certsDirAbs);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return { kind: 'not_found', certsDirAbs, endpoint, diagnostics };
    }
    throw error;
  }

  const matches: CandidateCertificate[] = [];
  for (const entry of entries) {
    if (!isCertificateFilename(entry)) continue;

    const certPath = path.join(certsDirAbs, entry);
    const keyPath = await findKeyPathForCert({ certsDirAbs, certEntry: entry });
    if (keyPath === null) {
      diagnostics.push({
        level: 'warn',
        code: 'missing_key_file',
        message: `Certificate has no matching private key: ${certPath}`,
        certPath,
      });
      continue;
    }

    const loaded = await loadAndValidateCandidate({
      matchHosts,
      now,
      certPath,
      keyPath,
    });
    if (loaded.kind === 'match') {
      matches.push(loaded.certificate);
      continue;
    }
    if (loaded.kind === 'diagnostic') {
      diagnostics.push(loaded.diagnostic);
    }
  }

  if (matches.length === 0) {
    return { kind: 'not_found', certsDirAbs, endpoint, diagnostics };
  }

  matches.sort(
    (a, b) =>
      a.matchedHostPriority - b.matchedHostPriority || b.validTo.getTime() - a.validTo.getTime(),
  );
  if (matches.length > 1) {
    diagnostics.push({
      level: 'warn',
      code: 'multiple_matching_certs',
      message: `Multiple valid certificates match host '${host}'; using the best-priority match with the latest expiry.`,
      host,
      certPaths: matches.map((m) => m.certPath),
    });
  }

  return {
    kind: 'found',
    certsDirAbs,
    endpoint: { bindHost: host, urlHost: matches[0].matchedHost },
    certificate: matches[0],
    diagnostics,
  };
}

export async function createSelfSignedCertificate(params: {
  host?: string;
  altHosts?: readonly string[];
  days?: number;
  certsDirAbs?: string;
  force?: boolean;
}): Promise<CreatedSelfSignedCertificate> {
  const hosts = normalizeCertificateHostsForCreate(
    params.host === undefined
      ? await resolveDefaultLanHttpsHosts()
      : [params.host, ...(params.altHosts ?? [])],
    { skipInvalidHosts: params.host === undefined },
  );
  const host = hosts[0];
  const days = normalizeDays(params.days ?? DEFAULT_SELF_SIGNED_CERT_DAYS);
  const certsDirAbs = params.certsDirAbs ?? getDefaultDomindsCertsDir();
  const basename = certificateBasenameForHosts(hosts);
  const certPath = path.join(certsDirAbs, `${basename}.crt.pem`);
  const keyPath = path.join(certsDirAbs, `${basename}.key.pem`);
  const metadataPath = path.join(certsDirAbs, `${basename}.json`);

  await fs.mkdir(certsDirAbs, { recursive: true, mode: 0o700 });
  if (params.force !== true) {
    await assertPathDoesNotExist(certPath);
    await assertPathDoesNotExist(keyPath);
    await assertPathDoesNotExist(metadataPath);
  }

  const writeFlag = params.force === true ? 'w' : 'wx';
  const san = buildSubjectAltName(hosts);
  const generated = await generateDomindsSelfSignedPem({ host, hosts, days });
  await fs.writeFile(keyPath, generated.keyPem, {
    encoding: 'utf8',
    mode: 0o600,
    flag: writeFlag,
  });
  await fs.writeFile(certPath, generated.certPem, {
    encoding: 'utf8',
    mode: 0o644,
    flag: writeFlag,
  });

  await fs.chmod(keyPath, 0o600);
  await fs.chmod(certPath, 0o644);
  const metadata = {
    kind: 'dominds_self_signed_cert',
    host,
    hosts,
    days,
    certPath,
    keyPath,
    createdAt: new Date().toISOString(),
    subjectAltName: san,
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
    flag: writeFlag,
  });
  await fs.chmod(metadataPath, 0o644);

  return { host, hosts, days, certsDirAbs, certPath, keyPath, metadataPath };
}

async function generateDomindsSelfSignedPem(params: {
  host: string;
  hosts: readonly string[];
  days: number;
}): Promise<{ certPem: string; keyPem: string }> {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + params.days * 24 * 60 * 60 * 1000);
  const attrs: CertificateField[] = [{ name: 'commonName', value: params.host }];
  const extensions: CertificateExtension[] = [
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: buildSubjectAltNameEntries(params.hosts) },
  ];

  const pems = await generateSelfSignedCertificate(attrs, {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions,
  });

  const certPem = pems.cert;
  const keyPem = pems.private;
  assertGeneratedCertificateMatchesRequest({ certPem, keyPem, hosts: params.hosts, notAfterDate });
  return { certPem, keyPem };
}

function buildSubjectAltNameEntries(hosts: readonly string[]): SubjectAltNameEntry[] {
  return hosts.map((host) => {
    if (net.isIP(host) !== 0) {
      return { type: 7, ip: host };
    }
    return { type: 2, value: host };
  });
}

function assertGeneratedCertificateMatchesRequest(params: {
  certPem: string;
  keyPem: string;
  hosts: readonly string[];
  notAfterDate: Date;
}): void {
  const cert = new X509Certificate(params.certPem);
  for (const host of params.hosts) {
    if (!certificateMatchesHost(cert, host)) {
      throw new Error(`Generated self-signed certificate does not include requested host: ${host}`);
    }
  }
  const validToMs = Date.parse(cert.validTo);
  if (!Number.isFinite(validToMs)) {
    throw new Error('Generated self-signed certificate has an invalid validTo date');
  }
  if (validToMs > params.notAfterDate.getTime() + 1000) {
    throw new Error('Generated self-signed certificate validity exceeds requested --days value');
  }
  tls.createSecureContext({ cert: params.certPem, key: params.keyPem });
}

function normalizeCertificateHostsForCreate(
  rawHosts: readonly string[],
  options: Readonly<{ skipInvalidHosts: boolean }>,
): readonly string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const rawHost of rawHosts) {
    const hostCandidates = getCertificateMatchHostsForCreateHost(rawHost);
    for (const host of hostCandidates) {
      const validation = validateCertificateHost(host);
      if (validation.kind === 'invalid') {
        if (options.skipInvalidHosts) continue;
        throw new Error(validation.message);
      }
      const key = host.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hosts.push(host);
    }
  }
  if (hosts.length === 0) {
    throw new Error(
      options.skipInvalidHosts
        ? 'No certificate-valid non-loopback LAN host was detected; provide --host explicitly'
        : '--host must be provided at least once',
    );
  }
  return hosts;
}

function getCertificateMatchHostsForCreateHost(rawHost: string): readonly string[] {
  const host = normalizeNetworkHost(rawHost);
  return [host];
}

function normalizeDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 36500) {
    throw new Error('--days must be an integer in [1, 36500]');
  }
  return days;
}

function validateCertificateHost(
  host: string,
): { kind: 'valid' } | { kind: 'invalid'; message: string } {
  if (host === '') {
    return { kind: 'invalid', message: '--host must not be empty' };
  }
  if (host.includes('/')) {
    return {
      kind: 'invalid',
      message: '--host must be an exact DNS name or IP address; CIDR/IP ranges are not valid',
    };
  }
  if (!isLanHttpsHost(host)) {
    return {
      kind: 'invalid',
      message:
        '--host must not be localhost, loopback, 127.0.0.0/8, 169.254.0.0/16, ::1, fe80::/10, 0.0.0.0, or ::',
    };
  }
  if (net.isIP(host) !== 0) return { kind: 'valid' };
  if (!isValidDnsHost(host)) {
    return {
      kind: 'invalid',
      message: '--host must be a DNS name, an IPv4 address, or an IPv6 address',
    };
  }
  return { kind: 'valid' };
}

function isValidDnsHost(host: string): boolean {
  if (host.length > 253) return false;
  const trimmed = host.endsWith('.') ? host.slice(0, -1) : host;
  if (trimmed === '') return false;
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false;
  }
  return true;
}

async function assertPathDoesNotExist(filePathAbs: string): Promise<void> {
  try {
    await fs.access(filePathAbs);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing certificate file: ${filePathAbs}`);
}

function certificateBasenameForHosts(hosts: readonly string[]): string {
  const host = hosts[0];
  const safeHost = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const digest = createHash('sha256').update(hosts.join('\0')).digest('hex').slice(0, 8);
  return `dominds-${safeHost || 'host'}-${digest}`;
}

function buildSubjectAltName(hosts: readonly string[]): string {
  return hosts
    .map((host) => {
      const ipVersion = net.isIP(host);
      return ipVersion !== 0 ? `IP:${host}` : `DNS:${host}`;
    })
    .join(',');
}

function isCertificateFilename(filename: string): boolean {
  return CERT_EXTENSIONS.some((ext) => filename.endsWith(ext)) && !isKeyFilename(filename);
}

function isKeyFilename(filename: string): boolean {
  return KEY_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

async function findKeyPathForCert(params: {
  certsDirAbs: string;
  certEntry: string;
}): Promise<string | null> {
  const baseNames = certBaseNameVariants(params.certEntry);
  for (const baseName of baseNames) {
    for (const suffix of KEY_SUFFIXES) {
      const keyPath = path.join(params.certsDirAbs, `${baseName}${suffix}`);
      try {
        await fs.access(keyPath);
        return keyPath;
      } catch (error: unknown) {
        if (isNodeErrorWithCode(error, 'ENOENT')) continue;
        throw error;
      }
    }
  }
  return null;
}

function certBaseNameVariants(certEntry: string): readonly string[] {
  const variants: string[] = [];
  for (const ext of CERT_EXTENSIONS) {
    if (certEntry.endsWith(ext)) {
      variants.push(certEntry.slice(0, -ext.length));
    }
  }
  if (certEntry.endsWith('.crt.pem')) {
    variants.push(certEntry.slice(0, -'.crt.pem'.length));
  }
  return Array.from(new Set(variants));
}

async function loadAndValidateCandidate(params: {
  matchHosts: readonly string[];
  now: Date;
  certPath: string;
  keyPath: string;
}): Promise<
  | { kind: 'match'; certificate: CandidateCertificate }
  | { kind: 'no_match' }
  | { kind: 'diagnostic'; diagnostic: CertificateLookupDiagnostic }
> {
  let certPem: string;
  let keyPem: string;
  let cert: X509Certificate;
  try {
    certPem = await fs.readFile(params.certPath, 'utf8');
    keyPem = await fs.readFile(params.keyPath, 'utf8');
    cert = new X509Certificate(certPem);
  } catch (error: unknown) {
    return {
      kind: 'diagnostic',
      diagnostic: {
        level: 'warn',
        code: 'invalid_cert_file',
        message: `Invalid certificate file '${params.certPath}': ${formatUnknownError(error)}`,
        certPath: params.certPath,
        keyPath: params.keyPath,
      },
    };
  }

  const matchedHost = findCertificateMatchedHost(cert, params.matchHosts);
  if (matchedHost === null) {
    return { kind: 'no_match' };
  }

  if (!certificateIsCurrentlyValid(cert, params.now)) {
    return {
      kind: 'diagnostic',
      diagnostic: {
        level: 'warn',
        code: 'expired_or_not_yet_valid',
        message: `Certificate is not currently valid: ${params.certPath}`,
        certPath: params.certPath,
        keyPath: params.keyPath,
      },
    };
  }

  try {
    tls.createSecureContext({ cert: certPem, key: keyPem });
  } catch (error: unknown) {
    return {
      kind: 'diagnostic',
      diagnostic: {
        level: 'warn',
        code: 'invalid_key_pair',
        message: `Certificate and private key do not form a valid TLS pair: ${formatUnknownError(error)}`,
        certPath: params.certPath,
        keyPath: params.keyPath,
      },
    };
  }

  return {
    kind: 'match',
    certificate: {
      cert: certPem,
      key: keyPem,
      certPath: params.certPath,
      keyPath: params.keyPath,
      matchedHost: matchedHost.host,
      matchedHostPriority: matchedHost.priority,
      validTo: new Date(Date.parse(cert.validTo)),
    },
  };
}

function certificateIsCurrentlyValid(cert: X509Certificate, now: Date): boolean {
  const validFromMs = Date.parse(cert.validFrom);
  const validToMs = Date.parse(cert.validTo);
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) {
    return false;
  }
  const nowMs = now.getTime();
  return validFromMs <= nowMs && nowMs <= validToMs;
}

function findCertificateMatchedHost(
  cert: X509Certificate,
  matchHosts: readonly string[],
): { host: string; priority: number } | null {
  for (let i = 0; i < matchHosts.length; i += 1) {
    const host = matchHosts[i];
    if (certificateMatchesHost(cert, host)) {
      return { host, priority: i };
    }
  }
  return null;
}

function certificateMatchesHost(cert: X509Certificate, host: string): boolean {
  const normalizedHost = normalizeNetworkHost(host);
  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion !== 0) {
    return cert.checkIP(normalizedHost) !== undefined;
  }
  return cert.checkHost(normalizedHost) !== undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
