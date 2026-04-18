import type {
  ToolAvailabilityUpdatedMessage,
  WebSocketMessage,
} from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { createLogger } from './log';
import { computeGlobalToolRegistryRevision } from './tool-availability';

const log = createLogger('tool-availability-updates');

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;
let lastRegistryRevision: string | undefined;

export function setToolAvailabilityBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
  lastRegistryRevision = computeGlobalToolRegistryRevision();
}

export function clearToolAvailabilityBroadcaster(): void {
  broadcastToClients = undefined;
  lastRegistryRevision = undefined;
}

function broadcast(msg: ToolAvailabilityUpdatedMessage): void {
  const fn = broadcastToClients;
  if (!fn) {
    return;
  }
  try {
    fn(msg);
  } catch (error: unknown) {
    log.warn('Failed to broadcast tool-availability update', error);
  }
}

export function notifyToolAvailabilityBindingChanged(trigger: string): void {
  broadcast({
    type: 'tool_availability_updated',
    reason: 'member_binding_changed',
    timestamp: formatUnifiedTimestamp(new Date()),
    trigger,
  });
}

export function notifyToolAvailabilityRuntimeLeaseChanged(trigger: string): void {
  broadcast({
    type: 'tool_availability_updated',
    reason: 'runtime_lease_changed',
    timestamp: formatUnifiedTimestamp(new Date()),
    trigger,
  });
}

export function notifyToolAvailabilityRegistryMaybeChanged(args: {
  reason: 'registry_changed';
  trigger: string;
}): void {
  const nextRevision = computeGlobalToolRegistryRevision();
  if (lastRegistryRevision === nextRevision) {
    return;
  }
  lastRegistryRevision = nextRevision;
  broadcast({
    type: 'tool_availability_updated',
    reason: args.reason,
    timestamp: formatUnifiedTimestamp(new Date()),
    trigger: args.trigger,
  });
}
