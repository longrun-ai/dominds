import {
  driveDialogStream as driveDialogStreamFromOrchestrator,
  emitSayingEvents as emitSayingEventsFromOrchestrator,
  runBackendDriver as runBackendDriverFromOrchestrator,
  supplyResponseToSupdialog as supplyResponseToSupdialogFromOrchestrator,
} from './orchestrator';
import { restoreDialogHierarchy as restoreDialogHierarchyFromRestore } from './restore-dialog-hierarchy';
import type {
  DriverV2DriveArgs,
  DriverV2DriveResult,
  DriverV2EmitSayingArgs,
  DriverV2EmitSayingResult,
  DriverV2RunBackendResult,
  DriverV2SupplyResponseArgs,
  DriverV2SupplyResponseResult,
} from './types';

export type DriverV2ImplementationState = 'scaffold_only' | 'active';

export const DRIVER_V2_IMPLEMENTATION_STATE: DriverV2ImplementationState = 'active';

export async function driveDialogStream(...args: DriverV2DriveArgs): DriverV2DriveResult {
  return await driveDialogStreamFromOrchestrator(...args);
}

export async function emitSayingEvents(...args: DriverV2EmitSayingArgs): DriverV2EmitSayingResult {
  return await emitSayingEventsFromOrchestrator(...args);
}

export async function supplyResponseToSupdialog(
  ...args: DriverV2SupplyResponseArgs
): DriverV2SupplyResponseResult {
  return await supplyResponseToSupdialogFromOrchestrator(...args);
}

export function runBackendDriver(): DriverV2RunBackendResult {
  return runBackendDriverFromOrchestrator();
}

export async function restoreDialogHierarchy(
  ...args: Parameters<typeof restoreDialogHierarchyFromRestore>
): ReturnType<typeof restoreDialogHierarchyFromRestore> {
  return await restoreDialogHierarchyFromRestore(...args);
}
