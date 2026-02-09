import {
  driveDialogStream as driveDialogStreamV1,
  emitSayingEvents as emitSayingEventsV1,
  runBackendDriver as runBackendDriverV1,
  supplyResponseToSupdialog as supplyResponseToSupdialogV1,
} from '../driver';

export type DriverV2ImplementationState = 'scaffold_only' | 'active';

// Stage-1 landing: v2 module exists and is wired via driver-entry.ts.
// Real v2 logic will replace these passthrough calls incrementally.
export const DRIVER_V2_IMPLEMENTATION_STATE: DriverV2ImplementationState = 'scaffold_only';

export async function driveDialogStream(
  ...args: Parameters<typeof driveDialogStreamV1>
): ReturnType<typeof driveDialogStreamV1> {
  return await driveDialogStreamV1(...args);
}

export async function emitSayingEvents(
  ...args: Parameters<typeof emitSayingEventsV1>
): ReturnType<typeof emitSayingEventsV1> {
  return await emitSayingEventsV1(...args);
}

export async function supplyResponseToSupdialog(
  ...args: Parameters<typeof supplyResponseToSupdialogV1>
): ReturnType<typeof supplyResponseToSupdialogV1> {
  return await supplyResponseToSupdialogV1(...args);
}

export function runBackendDriver(): ReturnType<typeof runBackendDriverV1> {
  return runBackendDriverV1();
}
