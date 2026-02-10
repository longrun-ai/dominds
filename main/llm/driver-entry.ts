import {
  driveDialogStream as driveDialogStreamV2,
  emitSayingEvents as emitSayingEventsV2,
  restoreDialogHierarchy as restoreDialogHierarchyV2,
  runBackendDriver as runBackendDriverV2,
  supplyResponseToSupdialog as supplyResponseToSupdialogV2,
} from './driver-v2';

export type DriverEngineVersion = 'v2';
const ACTIVE_DRIVER_ENGINE: DriverEngineVersion = 'v2';

export function getActiveDriverEngine(): DriverEngineVersion {
  return ACTIVE_DRIVER_ENGINE;
}

export async function driveDialogStream(
  ...args: Parameters<typeof driveDialogStreamV2>
): ReturnType<typeof driveDialogStreamV2> {
  return await driveDialogStreamV2(...args);
}

export async function emitSayingEvents(
  ...args: Parameters<typeof emitSayingEventsV2>
): ReturnType<typeof emitSayingEventsV2> {
  return await emitSayingEventsV2(...args);
}

export async function supplyResponseToSupdialog(
  ...args: Parameters<typeof supplyResponseToSupdialogV2>
): ReturnType<typeof supplyResponseToSupdialogV2> {
  return await supplyResponseToSupdialogV2(...args);
}

export async function restoreDialogHierarchy(
  ...args: Parameters<typeof restoreDialogHierarchyV2>
): ReturnType<typeof restoreDialogHierarchyV2> {
  return await restoreDialogHierarchyV2(...args);
}

export function runBackendDriver(): ReturnType<typeof runBackendDriverV2> {
  return runBackendDriverV2();
}
