import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as os from 'node:os';

const OUTBOUND_PROBE_HOST = 'github.com';
const OUTBOUND_PROBE_PORT = 443;
const OUTBOUND_PROBE_TIMEOUT_MS = 800;

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
    return normalizedHost !== '0.0.0.0' && !normalizedHost.startsWith('127.');
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
      normalizedHost !== '0:0:0:0:0:0:0:1'
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
  if (normalizedHost === '0.0.0.0') {
    return uniqueHosts([
      ...(await getUdpOutboundHosts('ipv4')),
      ...getNetworkInterfaceHosts('ipv4'),
      os.hostname(),
    ]).filter(isLanHttpsHost);
  }
  if (normalizedHost === '::' || normalizedHost === '0:0:0:0:0:0:0:0') {
    return uniqueHosts([
      ...(await getUdpOutboundHosts('ipv6')),
      ...(await getUdpOutboundHosts('ipv4')),
      ...getNetworkInterfaceHosts('ipv6'),
      ...getNetworkInterfaceHosts('ipv4'),
      os.hostname(),
    ]).filter(isLanHttpsHost);
  }
  return isLanHttpsHost(normalizedHost) ? [normalizedHost] : [];
}

export async function resolveDefaultLanHttpsHosts(): Promise<readonly string[]> {
  return await resolveLanHttpsHostsForBindHost('::');
}

async function getUdpOutboundHosts(kind: 'ipv4' | 'ipv6'): Promise<readonly string[]> {
  const host = await getUdpOutboundHost(kind);
  return host === null ? [] : [host];
}

async function getUdpOutboundHost(kind: 'ipv4' | 'ipv6'): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket(kind === 'ipv4' ? 'udp4' : 'udp6');
    let settled = false;
    const finish = (host: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners('error');
      socket.close();
      resolve(host === null ? null : normalizeNetworkHost(host));
    };
    const timeout = setTimeout(() => {
      finish(null);
    }, OUTBOUND_PROBE_TIMEOUT_MS);
    timeout.unref();
    socket.once('error', () => {
      finish(null);
    });
    socket.connect(OUTBOUND_PROBE_PORT, OUTBOUND_PROBE_HOST, () => {
      const address = socket.address();
      if (typeof address === 'string') {
        finish(null);
        return;
      }
      finish(address.address);
    });
  });
}

function getNetworkInterfaceHosts(kind: 'ipv4' | 'ipv6'): readonly string[] {
  const hosts: string[] = [];
  const families = os.networkInterfaces();
  for (const entries of Object.values(families)) {
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (kind === 'ipv4' && entry.family === 'IPv4') {
        hosts.push(entry.address);
      }
      if (kind === 'ipv6' && entry.family === 'IPv6') {
        hosts.push(stripIpv6ZoneId(entry.address));
      }
    }
  }
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

function parseIpv4MappedIpv6Host(host: string): string | null {
  const dottedQuadIndex = host.lastIndexOf(':');
  if (dottedQuadIndex === -1) return null;
  const dottedQuad = host.slice(dottedQuadIndex + 1);
  if (net.isIP(dottedQuad) !== 4) return null;
  const prefix = host.slice(0, dottedQuadIndex).toLowerCase();
  return prefix === '::ffff' || prefix === '0:0:0:0:0:ffff' ? dottedQuad : null;
}
