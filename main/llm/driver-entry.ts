import {
  driveDialogStream as driveDialogStreamV1,
  emitSayingEvents as emitSayingEventsV1,
  runBackendDriver as runBackendDriverV1,
  supplyResponseToSupdialog as supplyResponseToSupdialogV1,
} from './driver';
import {
  driveDialogStream as driveDialogStreamV2,
  emitSayingEvents as emitSayingEventsV2,
  runBackendDriver as runBackendDriverV2,
  supplyResponseToSupdialog as supplyResponseToSupdialogV2,
} from './driver-v2';

export type DriverEngineVersion = 'v1' | 'v2';

function resolveActiveDriverEngine(): DriverEngineVersion {
  const raw = process.env.DOMINDS_DRIVER_ENGINE;
  if (raw === undefined) {
    return 'v2';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'v2') {
    return 'v2';
  }
  if (normalized === 'v1') {
    return 'v1';
  }
  throw new Error(`Invalid DOMINDS_DRIVER_ENGINE=${JSON.stringify(raw)} (expected "v1" or "v2")`);
}

// Single switch point for rollout/tests.
const ACTIVE_DRIVER_ENGINE: DriverEngineVersion = resolveActiveDriverEngine();

export function getActiveDriverEngine(): DriverEngineVersion {
  return ACTIVE_DRIVER_ENGINE;
}

export async function driveDialogStream(
  ...args: Parameters<typeof driveDialogStreamV1>
): ReturnType<typeof driveDialogStreamV1> {
  if (ACTIVE_DRIVER_ENGINE === 'v2') {
    return await driveDialogStreamV2(...args);
  }
  return await driveDialogStreamV1(...args);
}

export async function emitSayingEvents(
  ...args: Parameters<typeof emitSayingEventsV1>
): ReturnType<typeof emitSayingEventsV1> {
  if (ACTIVE_DRIVER_ENGINE === 'v2') {
    return await emitSayingEventsV2(...args);
  }
  return await emitSayingEventsV1(...args);
}

export async function supplyResponseToSupdialog(
  ...args: Parameters<typeof supplyResponseToSupdialogV1>
): ReturnType<typeof supplyResponseToSupdialogV1> {
  if (ACTIVE_DRIVER_ENGINE === 'v2') {
    return await supplyResponseToSupdialogV2(...args);
  }
  return await supplyResponseToSupdialogV1(...args);
}

export function runBackendDriver(): ReturnType<typeof runBackendDriverV1> {
  if (ACTIVE_DRIVER_ENGINE === 'v2') {
    return runBackendDriverV2();
  }
  return runBackendDriverV1();
}
