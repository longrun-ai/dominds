import net from 'node:net';

import type { DomindsAppInstallJsonV1 } from './app-json';
import type { AppsResolutionEntry } from './resolution-file';

const STABLE_PORT_RANGE_START = 43000;
const STABLE_PORT_RANGE_END = 49999;
const PORT_MAX = 65535;

function isPositivePort(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= PORT_MAX &&
    Number.isFinite(value)
  );
}

function hashAppId(appId: string): number {
  // FNV-1a 32-bit hash for deterministic port probing order.
  let hash = 0x811c9dc5;
  for (let i = 0; i < appId.length; i += 1) {
    hash ^= appId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function collectReservedPorts(
  existingApps: ReadonlyArray<AppsResolutionEntry>,
  appId: string,
): Set<number> {
  const reserved = new Set<number>();
  for (const app of existingApps) {
    if (app.id === appId) continue;
    if (isPositivePort(app.assignedPort)) {
      reserved.add(app.assignedPort);
    }
  }
  return reserved;
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();

    const finish = (ok: boolean): void => {
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
      resolve(ok);
    };

    server.once('error', () => {
      finish(false);
    });

    server.once('listening', () => {
      server.close(() => finish(true));
    });

    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

async function pickDeterministicAvailablePort(params: {
  appId: string;
  reservedPorts: ReadonlySet<number>;
}): Promise<number> {
  const rangeSize = STABLE_PORT_RANGE_END - STABLE_PORT_RANGE_START + 1;
  if (rangeSize <= 0) {
    throw new Error('Invalid stable app port range configuration');
  }
  const baseHash = hashAppId(params.appId);

  for (let i = 0; i < rangeSize; i += 1) {
    const candidate = STABLE_PORT_RANGE_START + ((baseHash + i) % rangeSize);
    if (params.reservedPorts.has(candidate)) continue;
    if (await canBindPort(candidate)) return candidate;
  }
  throw new Error(
    `Failed to allocate stable assignedPort for app '${params.appId}': no bindable port in ${STABLE_PORT_RANGE_START}-${STABLE_PORT_RANGE_END}`,
  );
}

/**
 * Resolve a stable non-zero assignedPort for an app frontend.
 *
 * - If the app has no frontend, returns null.
 * - If an existing assignedPort exists, validates no collisions and returns it.
 * - Otherwise, tries installJson.frontend.defaultPort when it is bindable.
 * - Falls back to a deterministic stable-range allocator.
 */
export async function resolveStableAssignedPort(params: {
  appId: string;
  installJson: DomindsAppInstallJsonV1;
  existingApps: ReadonlyArray<AppsResolutionEntry>;
  existingAssignedPort: number | null;
}): Promise<number | null> {
  if (!params.installJson.frontend) return null;

  const reservedPorts = collectReservedPorts(params.existingApps, params.appId);

  if (isPositivePort(params.existingAssignedPort)) {
    if (reservedPorts.has(params.existingAssignedPort)) {
      throw new Error(
        `Invalid apps resolution state: assignedPort ${params.existingAssignedPort} for '${params.appId}' collides with another resolved app`,
      );
    }
    return params.existingAssignedPort;
  }

  const defaultPort = params.installJson.frontend.defaultPort;
  if (
    isPositivePort(defaultPort) &&
    !reservedPorts.has(defaultPort) &&
    (await canBindPort(defaultPort))
  ) {
    return defaultPort;
  }

  return await pickDeterministicAvailablePort({
    appId: params.appId,
    reservedPorts,
  });
}
