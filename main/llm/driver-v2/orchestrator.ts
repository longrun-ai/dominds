import { globalDialogRegistry } from '../../dialog-global-registry';
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

export function runBackendDriver(): DriverV2RunBackendResult {
  return (async () => {
    while (true) {
      try {
        const dialogsToDrive = globalDialogRegistry.getDialogsNeedingDrive();
        for (const rootDialog of dialogsToDrive) {
          try {
            const latest = await DialogPersistence.loadDialogLatest(rootDialog.id, 'running');
            const runStateKind = latest?.runState?.kind;
            if (runStateKind === 'interrupted' || runStateKind === 'proceeding_stop_requested') {
              globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId);
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
              globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId);
              await DialogPersistence.setNeedsDrive(rootDialog.id, true, rootDialog.status);
            } else {
              globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId);
              await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
            }
            if (status.subdialogs) {
              log.info(`Dialog ${rootDialog.id.rootId} suspended, waiting for subdialogs`);
            }
            if (status.q4h) {
              log.info(`Dialog ${rootDialog.id.rootId} awaiting Q4H answer`);
            }
          } catch (err) {
            log.error(`Error driving dialog ${rootDialog.id.rootId}:`, err, undefined, {
              dialogId: rootDialog.id.rootId,
            });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (loopErr) {
        log.error('Error in backend driver loop:', loopErr);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
}
