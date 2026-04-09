import net from 'node:net';

import type { DomindsAppInstallJson } from '@longrun-ai/kernel/app-json';
import type { AppsResolutionEntry } from './resolution-file';

const STABLE_PORT_RANGE_START = 43000;
const STABLE_PORT_RANGE_END = 49999;
const PORT_MAX = 65535;

export type AssignedPortResolutionReason =
  | 'no_frontend'
  | 'kept_existing'
  | 'selected_default'
  | 'allocated_stable_range'
  | 'reassigned_from_existing_conflict'
  | 'reassigned_from_existing_unbindable';

export type AssignedPortResolution = Readonly<{
  assignedPort: number | null;
  reason: AssignedPortResolutionReason;
}>;

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
 * - If an existing assignedPort exists, keeps it when still valid/bindable.
 * - If existing assignedPort collides or is not bindable, reassigns deterministically.
 * - Otherwise, tries installJson.frontend.defaultPort when it is bindable.
 * - Falls back to a deterministic stable-range allocator.
 */
export async function resolveStableAssignedPort(params: {
  appId: string;
  installJson: DomindsAppInstallJson;
  existingApps: ReadonlyArray<AppsResolutionEntry>;
  existingAssignedPort: number | null;
}): Promise<number | null> {
  const resolved = await resolveStableAssignedPortWithReason(params);
  return resolved.assignedPort;
}

export async function resolveStableAssignedPortWithReason(params: {
  appId: string;
  installJson: DomindsAppInstallJson;
  existingApps: ReadonlyArray<AppsResolutionEntry>;
  existingAssignedPort: number | null;
}): Promise<AssignedPortResolution> {
  if (!params.installJson.frontend) {
    return { assignedPort: null, reason: 'no_frontend' };
  }

  const reservedPorts = collectReservedPorts(params.existingApps, params.appId);

  if (isPositivePort(params.existingAssignedPort)) {
    if (reservedPorts.has(params.existingAssignedPort)) {
      return {
        assignedPort: await pickDeterministicAvailablePort({
          appId: params.appId,
          reservedPorts,
        }),
        reason: 'reassigned_from_existing_conflict',
      };
    }
    if (!(await canBindPort(params.existingAssignedPort))) {
      return {
        assignedPort: await pickDeterministicAvailablePort({
          appId: params.appId,
          reservedPorts,
        }),
        reason: 'reassigned_from_existing_unbindable',
      };
    }
    return { assignedPort: params.existingAssignedPort, reason: 'kept_existing' };
  }

  const defaultPort = params.installJson.frontend.defaultPort;
  if (
    isPositivePort(defaultPort) &&
    !reservedPorts.has(defaultPort) &&
    (await canBindPort(defaultPort))
  ) {
    return { assignedPort: defaultPort, reason: 'selected_default' };
  }

  return {
    assignedPort: await pickDeterministicAvailablePort({
      appId: params.appId,
      reservedPorts,
    }),
    reason: 'allocated_stable_range',
  };
}
