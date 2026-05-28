#!/usr/bin/env node

import { formatServerOrigin } from '../server/auth';
import {
  DEFAULT_SELF_SIGNED_CERT_DAYS,
  createSelfSignedCertificate,
  findAutoHttpsCertificateForHost,
} from '../server/certificates';

type CertAction = 'create' | 'status';

function printHelp(): void {
  console.log(`
Dominds certificate tools

Usage:
  dominds cert create [--host <host>] [--days <days>] [--force]
  dominds cert self-cert [--host <host>] [--days <days>] [--force]
  dominds cert status --host <host> [--port <port>] [--origin]

Options:
  --host <host>      Host name or IP address (default for create: detected non-loopback LAN hosts)
  --days <days>      Certificate validity in days (default: ${DEFAULT_SELF_SIGNED_CERT_DAYS})
  --force            Overwrite existing generated files
  --port <port>      Port for status --origin output
  --origin           Print only the effective origin, using https when a matching cert exists
  --help             Show this help message

Certificates live in ~/.dominds/certs/. A WebUI server automatically enables HTTPS when it finds
a certificate/key pair that matches the bind host or, for 0.0.0.0/::, a detected non-loopback LAN host.
`);
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const first = args[0];
  if (first === undefined || first === '--help' || first === '-h') {
    printHelp();
    return;
  }

  const action = parseAction(first);
  if (action === null) {
    console.error(`Error: Unknown cert subcommand '${first}'`);
    printHelp();
    process.exit(1);
  }

  const options = parseOptions(args.slice(1), action);
  if (options.kind === 'error') {
    console.error(`Error: ${options.message}`);
    printHelp();
    process.exit(1);
  }

  if (action === 'create') {
    const created = await createSelfSignedCertificate({
      host: options.host,
      altHosts: options.altHosts,
      days: options.days,
      force: options.force,
    });
    console.log(`Created self-signed certificate for ${created.host}`);
    console.log(`  hosts: ${created.hosts.join(', ')}`);
    console.log(`  cert: ${created.certPath}`);
    console.log(`  key:  ${created.keyPath}`);
    console.log(`  meta: ${created.metadataPath}`);
    console.log(`  days: ${created.days}`);
    return;
  }

  if (options.host === undefined) {
    console.error('Error: cert status requires --host <host>');
    printHelp();
    process.exit(1);
  }
  const lookup = await findAutoHttpsCertificateForHost({ host: options.host });
  if (options.origin) {
    if (options.port === undefined) {
      console.error('Error: cert status --origin requires --port <port>');
      process.exit(1);
    }
    console.log(
      formatServerOrigin({
        scheme: lookup.kind === 'found' ? 'https' : 'http',
        host: lookup.kind === 'found' ? lookup.certificate.matchedHost : lookup.endpoint.urlHost,
        port: options.port,
      }),
    );
    return;
  }

  for (const diagnostic of lookup.diagnostics) {
    console.warn(`warning: ${diagnostic.message}`);
  }
  if (lookup.kind === 'found') {
    console.log(`HTTPS certificate: found`);
    console.log(`  cert: ${lookup.certificate.certPath}`);
    console.log(`  key:  ${lookup.certificate.keyPath}`);
    console.log(`  matchedHost: ${lookup.certificate.matchedHost}`);
    console.log(`  validTo: ${lookup.certificate.validTo.toISOString()}`);
  } else {
    console.log(`HTTPS certificate: not found`);
    console.log(`  certsDir: ${lookup.certsDirAbs}`);
  }
}

function parseAction(value: string): CertAction | null {
  switch (value) {
    case 'create':
    case 'self-cert':
      return 'create';
    case 'status':
      return 'status';
    default:
      return null;
  }
}

type ParsedOptions =
  | {
      kind: 'ok';
      host?: string;
      days?: number;
      altHosts: readonly string[];
      force: boolean;
      port?: number;
      origin: boolean;
    }
  | { kind: 'error'; message: string };

function parseOptions(args: readonly string[], action: CertAction): ParsedOptions {
  let host: string | undefined;
  let days: number | undefined;
  const altHosts: string[] = [];
  let force = false;
  let port: number | undefined;
  let origin = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--host') {
      const next = args[i + 1];
      if (!next) return { kind: 'error', message: '--host requires a value' };
      if (host === undefined) host = next;
      else altHosts.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      if (host === undefined) host = value;
      else altHosts.push(value);
      continue;
    }
    if (arg === '--days') {
      const next = args[i + 1];
      const parsed = next === undefined ? null : parseInteger(next);
      if (parsed === null) return { kind: 'error', message: '--days requires an integer' };
      days = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--days=')) {
      const parsed = parseInteger(arg.slice('--days='.length));
      if (parsed === null) return { kind: 'error', message: '--days requires an integer' };
      days = parsed;
      continue;
    }
    if (arg === '--port') {
      const next = args[i + 1];
      const parsed = next === undefined ? null : parseInteger(next);
      if (parsed === null || parsed < 1 || parsed > 65535) {
        return { kind: 'error', message: '--port requires a valid TCP port' };
      }
      port = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const parsed = parseInteger(arg.slice('--port='.length));
      if (parsed === null || parsed < 1 || parsed > 65535) {
        return { kind: 'error', message: '--port requires a valid TCP port' };
      }
      port = parsed;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--origin') {
      origin = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith('-') && host === undefined && action === 'create') {
      host = arg;
      continue;
    }
    return { kind: 'error', message: `Unknown option '${arg}'` };
  }

  return { kind: 'ok', host, days, altHosts, force, port, origin };
}

function parseInteger(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
