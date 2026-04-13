import { getStopRequestedReason, hasActiveRun } from '../../dialog-display-state';
import { globalDialogRegistry, type DriveTriggerEvent } from '../../dialog-global-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { driveDialogStream } from './engine';
import type { KernelDriverRunBackendResult } from './types';

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
      const executionMarker = latest?.executionMarker;
      const stopRequested = getStopRequestedReason(rootDialog.id);
      if (executionMarker?.kind === 'interrupted' || stopRequested !== undefined) {
        globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason:
            executionMarker?.kind === 'interrupted'
              ? 'execution_marker_blocked:interrupted'
              : `stop_requested:${stopRequested}`,
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
        continue;
      }

      if (hasActiveRun(rootDialog.id)) {
        log.debug(
          'Backend driver deferred queued root drive because dialog already has an active run',
          undefined,
          {
            dialogId: rootDialog.id.valueOf(),
            rootId: rootDialog.id.rootId,
          },
        );
        globalDialogRegistry.noteActiveRunBlockedQueuedDrive(rootDialog.id.rootId);
        continue;
      }

      if (!(await rootDialog.canDrive())) {
        continue;
      }

      await driveDialogStream(rootDialog, undefined, true, {
        source: 'kernel_driver_backend_loop',
        reason: 'global_dialog_registry_needs_drive',
      });

      const status = await rootDialog.getSuspensionStatus();
      const shouldStayQueued = rootDialog.hasUpNext() || !status.canDrive;
      if (shouldStayQueued) {
        globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: rootDialog.hasUpNext() ? 'post_drive_upnext_pending' : 'post_drive_suspended',
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, true, rootDialog.status);
      } else {
        globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: 'post_drive_idle',
        });
        await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
      }
      const lastTrigger = globalDialogRegistry.getLastDriveTrigger(rootDialog.id.rootId);
      const lastTriggerAgeMs =
        lastTrigger !== undefined ? Math.max(0, Date.now() - lastTrigger.emittedAtMs) : undefined;
      if (status.subdialogs) {
        log.debug(`Dialog ${rootDialog.id.rootId} suspended, waiting for subdialogs`, undefined, {
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
        log.debug(`Dialog ${rootDialog.id.rootId} awaiting Q4H answer`, undefined, {
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

export function runBackendDriver(): KernelDriverRunBackendResult {
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
