import { globalDialogRegistry, type DriveTriggerEvent } from '../../dialog-global-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { executeDriveRound } from './round';
import { emitSayingEvents as emitSayingEventsV2 } from './saying-events';
import { supplyResponseToSupdialogV2 } from './supdialog-response';
import {
  createDriverV2RuntimeState,
  type DriverV2DriveArgs,
  type DriverV2DriveResult,
  type DriverV2EmitSayingArgs,
  type DriverV2EmitSayingResult,
  type DriverV2RunBackendResult,
  type DriverV2SupplyResponseArgs,
  type DriverV2SupplyResponseResult,
} from './types';

export async function driveDialogStream(...driveArgs: DriverV2DriveArgs): DriverV2DriveResult {
  const runtime = createDriverV2RuntimeState();
  return await executeDriveRound({
    runtime,
    driveArgs,
    scheduleDrive: (dialog, options) => {
      void driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
    driveDialog: async (dialog, options) => {
      await driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
  });
}

export async function emitSayingEvents(...args: DriverV2EmitSayingArgs): DriverV2EmitSayingResult {
  const [dlg, content] = args;
  return await emitSayingEventsV2(dlg, content);
}

export async function supplyResponseToSupdialog(
  ...args: DriverV2SupplyResponseArgs
): DriverV2SupplyResponseResult {
  const [parentDialog, subdialogId, responseText, callType, callId, status] = args;
  return await supplyResponseToSupdialogV2({
    parentDialog,
    subdialogId,
    responseText,
    callType,
    callId,
    status,
    scheduleDrive: (dialog, options) => {
      void driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
  });
}

function formatDriveTriggerForLog(trigger: DriveTriggerEvent): Record<string, unknown> {
  return {
    action: trigger.action,
    rootId: trigger.rootId,
    entryFound: trigger.entryFound,
    previousNeedsDrive: trigger.previousNeedsDrive,
    nextNeedsDrive: trigger.nextNeedsDrive,
    source: trigger.source,
    reason: trigger.reason,
    emittedAtMs: trigger.emittedAtMs,
  };
}

async function driveQueuedDialogsOnce(): Promise<void> {
  const dialogsToDrive = globalDialogRegistry.getDialogsNeedingDrive();
  for (const rootDialog of dialogsToDrive) {
    try {
      const latest = await DialogPersistence.loadDialogLatest(rootDialog.id, 'running');
      const runStateKind = latest?.runState?.kind;
      if (runStateKind === 'interrupted' || runStateKind === 'proceeding_stop_requested') {
        globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId, {
          source: 'driver_v2_backend_loop',
          reason: `run_state_blocked:${runStateKind}`,
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
        continue;
      }

      if (!(await rootDialog.canDrive())) {
        continue;
      }

      await driveDialogStream(rootDialog, undefined, true);

      const status = await rootDialog.getSuspensionStatus();
      const shouldStayQueued = rootDialog.hasUpNext() || !status.canDrive;
      if (shouldStayQueued) {
        globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId, {
          source: 'driver_v2_backend_loop',
          reason: rootDialog.hasUpNext() ? 'post_drive_upnext_pending' : 'post_drive_suspended',
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, true, rootDialog.status);
      } else {
        globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId, {
          source: 'driver_v2_backend_loop',
          reason: 'post_drive_idle',
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
      }
      const lastTrigger = globalDialogRegistry.getLastDriveTrigger(rootDialog.id.rootId);
      const lastTriggerAgeMs =
        lastTrigger !== undefined ? Math.max(0, Date.now() - lastTrigger.emittedAtMs) : undefined;
      if (status.subdialogs) {
        log.info(`Dialog ${rootDialog.id.rootId} suspended, waiting for subdialogs`, undefined, {
          rootId: rootDialog.id.rootId,
          waitingQ4H: status.q4h,
          waitingSubdialogs: status.subdialogs,
          hasQueuedUpNext: rootDialog.hasUpNext(),
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousNeedsDrive: lastTrigger.previousNeedsDrive,
                nextNeedsDrive: lastTrigger.nextNeedsDrive,
              }
            : null,
        });
      }
      if (status.q4h) {
        log.info(`Dialog ${rootDialog.id.rootId} awaiting Q4H answer`, undefined, {
          rootId: rootDialog.id.rootId,
          waitingQ4H: status.q4h,
          waitingSubdialogs: status.subdialogs,
          hasQueuedUpNext: rootDialog.hasUpNext(),
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousNeedsDrive: lastTrigger.previousNeedsDrive,
                nextNeedsDrive: lastTrigger.nextNeedsDrive,
              }
            : null,
        });
      }
    } catch (err) {
      log.error(`Error driving dialog ${rootDialog.id.rootId}:`, err, undefined, {
        dialogId: rootDialog.id.rootId,
      });
    }
  }
}

export function runBackendDriver(): DriverV2RunBackendResult {
  return (async () => {
    while (true) {
      try {
        await driveQueuedDialogsOnce();

        const trigger = await globalDialogRegistry.waitForDriveTrigger();
        log.debug('Backend driver woke from drive trigger event', undefined, {
          trigger: formatDriveTriggerForLog(trigger),
        });
      } catch (loopErr) {
        log.error('Error in backend driver loop:', loopErr);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
}
