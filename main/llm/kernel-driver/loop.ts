import { getStopRequestedReason, hasActiveRun } from '../../dialog-display-state';
import { globalDialogRegistry, type DriveTriggerEvent } from '../../dialog-global-registry';
import { doesInterruptionReasonRequireExplicitResume } from '../../dialog-interruption';
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
  for (const mainDialog of dialogsToDrive) {
    try {
      const latest = await DialogPersistence.loadDialogLatest(mainDialog.id, 'running');
      const executionMarker = latest?.executionMarker;
      const stopRequested = getStopRequestedReason(mainDialog.id);
      const interruptedRequiresExplicitResume =
        executionMarker?.kind === 'interrupted' &&
        doesInterruptionReasonRequireExplicitResume(executionMarker.reason);
      if (interruptedRequiresExplicitResume || stopRequested !== undefined) {
        globalDialogRegistry.markNotNeedingDrive(mainDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: interruptedRequiresExplicitResume
            ? 'execution_marker_blocked:interrupted'
            : `stop_requested:${stopRequested}`,
        });
        await DialogPersistence.setNeedsDrive(mainDialog.id, false, mainDialog.status);
        continue;
      }

      if (hasActiveRun(mainDialog.id)) {
        log.debug(
          'Backend driver deferred queued root drive because dialog already has an active run',
          undefined,
          {
            dialogId: mainDialog.id.valueOf(),
            rootId: mainDialog.id.rootId,
          },
        );
        globalDialogRegistry.noteActiveRunBlockedQueuedDrive(mainDialog.id.rootId);
        continue;
      }

      if (!(await mainDialog.canDrive())) {
        continue;
      }

      await driveDialogStream(mainDialog, undefined, true, {
        source: 'kernel_driver_backend_loop',
        reason: 'global_dialog_registry_needs_drive',
      });

      const status = await mainDialog.getSuspensionStatus();
      const shouldStayQueued = mainDialog.hasUpNext() || !status.canDrive;
      if (shouldStayQueued) {
        globalDialogRegistry.markNeedsDrive(mainDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: mainDialog.hasUpNext() ? 'post_drive_upnext_pending' : 'post_drive_suspended',
        });
        await DialogPersistence.setNeedsDrive(mainDialog.id, true, mainDialog.status);
      } else {
        globalDialogRegistry.markNotNeedingDrive(mainDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: 'post_drive_idle',
        });
        await DialogPersistence.setNeedsDrive(mainDialog.id, false, mainDialog.status);
      }
      const lastTrigger = globalDialogRegistry.getLastDriveTrigger(mainDialog.id.rootId);
      const lastTriggerAgeMs =
        lastTrigger !== undefined ? Math.max(0, Date.now() - lastTrigger.emittedAtMs) : undefined;
      if (status.sideDialogs) {
        log.debug(`Dialog ${mainDialog.id.rootId} suspended, waiting for sideDialogs`, undefined, {
          rootId: mainDialog.id.rootId,
          waitingQ4H: status.q4h,
          waitingSideDialogs: status.sideDialogs,
          hasQueuedUpNext: mainDialog.hasUpNext(),
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
        log.debug(`Dialog ${mainDialog.id.rootId} awaiting Q4H answer`, undefined, {
          rootId: mainDialog.id.rootId,
          waitingQ4H: status.q4h,
          waitingSideDialogs: status.sideDialogs,
          hasQueuedUpNext: mainDialog.hasUpNext(),
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
      log.error(`Error driving dialog ${mainDialog.id.rootId}:`, err, undefined, {
        dialogId: mainDialog.id.rootId,
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
