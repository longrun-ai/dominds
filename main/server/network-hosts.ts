import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as os from 'node:os';
import { createLogger } from '../log';

const OUTBOUND_PROBE_HOST = 'github.com';
const OUTBOUND_PROBE_PORT = 443;
const OUTBOUND_PROBE_TIMEOUT_MS = 800;
const log = createLogger('network-hosts');

export function normalizeNetworkHost(host: string): string {
  const trimmed = host.trim();
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = stripIpv6ZoneId(unwrapped);
  const mappedIpv4 = parseIpv4MappedIpv6Host(withoutZone.toLowerCase());
  return mappedIpv4 ?? withoutZone;
}

export function isLanHttpsHost(host: string): boolean {
  const normalizedHost = normalizeNetworkHost(host).toLowerCase();
  if (normalizedHost === '' || normalizedHost === 'localhost' || normalizedHost === 'loopback') {
    return false;
  }
  const ipVersion = net.isIP(normalizedHost);
  if (ipVersion === 4) {
    return (
      normalizedHost !== '0.0.0.0' &&
      !normalizedHost.startsWith('127.') &&
      !isIpv4LinkLocalHost(normalizedHost)
    );
  }
  if (ipVersion === 6) {
    const mappedIpv4 = parseIpv4MappedIpv6Host(normalizedHost);
    if (mappedIpv4 !== null) {
      return isLanHttpsHost(mappedIpv4);
    }
    return (
      normalizedHost !== '::' &&
      normalizedHost !== '0:0:0:0:0:0:0:0' &&
      normalizedHost !== '::1' &&
      normalizedHost !== '0:0:0:0:0:0:0:1' &&
      !isIpv6LinkLocalHost(normalizedHost)
    );
  }
  return true;
}

export function resolveHttpUrlHostForBindHost(bindHost: string): string {
  const normalizedHost = normalizeNetworkHost(bindHost);
  if (
    normalizedHost === '0.0.0.0' ||
    normalizedHost === '::' ||
    normalizedHost === '0:0:0:0:0:0:0:0'
  ) {
    return 'localhost';
  }
  return normalizedHost;
}

export async function resolveLanHttpsHostsForBindHost(
  bindHost: string,
): Promise<readonly string[]> {
  const normalizedHost = normalizeNetworkHost(bindHost);
  log.info('Resolving LAN HTTPS certificate hosts', undefined, {
    bindHost,
    normalizedHost,
  });
  if (normalizedHost === '0.0.0.0') {
    return resolveBindAllLanHttpsHosts({
      bindHost: normalizedHost,
      families: ['ipv4'],
    });
  }
  if (normalizedHost === '::' || normalizedHost === '0:0:0:0:0:0:0:0') {
    return resolveBindAllLanHttpsHosts({
      bindHost: normalizedHost,
      families: ['ipv6', 'ipv4'],
    });
  }
  const accepted = isLanHttpsHost(normalizedHost);
  log.info('Resolved explicit LAN HTTPS certificate host', undefined, {
    bindHost,
    normalizedHost,
    accepted,
  });
  return accepted ? [normalizedHost] : [];
}

export async function resolveDefaultLanHttpsHosts(): Promise<readonly string[]> {
  return await resolveLanHttpsHostsForBindHost('::');
}

async function resolveBindAllLanHttpsHosts(params: {
  bindHost: string;
  families: readonly ('ipv4' | 'ipv6')[];
}): Promise<readonly string[]> {
  const rawCandidates: string[] = [];
  for (const family of params.families) {
    rawCandidates.push(...(await getUdpOutboundHosts(family)));
  }
  for (const family of params.families) {
    rawCandidates.push(...getNetworkInterfaceHosts(family));
  }
  const hostname = os.hostname();
  log.info('LAN HTTPS host detection hostname candidate', undefined, {
    method: 'os.hostname',
    host: hostname,
  });
  rawCandidates.push(hostname);

  const uniqueCandidates = uniqueHosts(rawCandidates);
  const acceptedHosts: string[] = [];
  const rejectedHosts: string[] = [];
  for (const host of uniqueCandidates) {
    if (isLanHttpsHost(host)) {
      acceptedHosts.push(host);
    } else {
      rejectedHosts.push(host);
    }
  }
  log.info('Resolved bind-all LAN HTTPS certificate hosts', undefined, {
    bindHost: params.bindHost,
    families: params.families,
    rawCandidates,
    uniqueCandidates,
    acceptedHosts,
    rejectedHosts,
  });
  return acceptedHosts;
}

async function getUdpOutboundHosts(kind: 'ipv4' | 'ipv6'): Promise<readonly string[]> {
  const host = await getUdpOutboundHost(kind);
  return host === null ? [] : [host];
}

async function getUdpOutboundHost(kind: 'ipv4' | 'ipv6'): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    log.info('LAN HTTPS host detection UDP probe start', undefined, {
      method: 'udp_outbound_probe',
      family: kind,
      remoteHost: OUTBOUND_PROBE_HOST,
      remotePort: OUTBOUND_PROBE_PORT,
      timeoutMs: OUTBOUND_PROBE_TIMEOUT_MS,
    });
    const socket = dgram.createSocket(kind === 'ipv4' ? 'udp4' : 'udp6');
    let settled = false;
    const finish = (host: string | null, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners('error');
      socket.close();
      const normalizedHost = host === null ? null : normalizeNetworkHost(host);
      log.info('LAN HTTPS host detection UDP probe finish', undefined, {
        method: 'udp_outbound_probe',
        family: kind,
        reason,
        host,
        normalizedHost,
      });
      resolve(normalizedHost);
    };
    const timeout = setTimeout(() => {
      finish(null, 'timeout');
    }, OUTBOUND_PROBE_TIMEOUT_MS);
    timeout.unref();
    socket.once('error', (error: Error) => {
      log.info('LAN HTTPS host detection UDP probe error', error, {
        method: 'udp_outbound_probe',
        family: kind,
      });
      finish(null, 'error');
    });
    socket.connect(OUTBOUND_PROBE_PORT, OUTBOUND_PROBE_HOST, () => {
      const address = socket.address();
      if (typeof address === 'string') {
        finish(null, 'non_ip_socket_address');
        return;
      }
      finish(address.address, 'connected');
    });
  });
}

function getNetworkInterfaceHosts(kind: 'ipv4' | 'ipv6'): readonly string[] {
  const hosts: string[] = [];
  const families = os.networkInterfaces();
  const inspectedInterfaces: Array<
    Readonly<{
      name: string;
      address: string;
      family: string;
      internal: boolean;
      acceptedFamily: boolean;
    }>
  > = [];
  for (const [name, entries] of Object.entries(families)) {
    if (entries === undefined) continue;
    for (const entry of entries) {
      const acceptedFamily =
        !entry.internal &&
        ((kind === 'ipv4' && entry.family === 'IPv4') ||
          (kind === 'ipv6' && entry.family === 'IPv6'));
      inspectedInterfaces.push({
        name,
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
        acceptedFamily,
      });
      if (acceptedFamily && kind === 'ipv4') {
        hosts.push(entry.address);
      }
      if (acceptedFamily && kind === 'ipv6') {
        hosts.push(stripIpv6ZoneId(entry.address));
      }
    }
  }
  log.info('LAN HTTPS host detection networkInterfaces result', undefined, {
    method: 'os.networkInterfaces',
    family: kind,
    hosts,
    inspectedInterfaces,
  });
  return hosts;
}

function uniqueHosts(rawHosts: readonly string[]): readonly string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const rawHost of rawHosts) {
    const host = normalizeNetworkHost(rawHost);
    if (host === '') continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push(host);
  }
  return hosts;
}

function stripIpv6ZoneId(address: string): string {
  const zoneIndex = address.indexOf('%');
  return zoneIndex === -1 ? address : address.slice(0, zoneIndex);
}

function isIpv4LinkLocalHost(host: string): boolean {
  return host.startsWith('169.254.');
}

function isIpv6LinkLocalHost(host: string): boolean {
  return (
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  );
}

function parseIpv4MappedIpv6Host(host: string): string | null {
  const dottedQuadIndex = host.lastIndexOf(':');
  if (dottedQuadIndex === -1) return null;
  const dottedQuad = host.slice(dottedQuadIndex + 1);
  if (net.isIP(dottedQuad) !== 4) return null;
  const prefix = host.slice(0, dottedQuadIndex).toLowerCase();
  return prefix === '::ffff' || prefix === '0:0:0:0:0:ffff' ? dottedQuad : null;
}
