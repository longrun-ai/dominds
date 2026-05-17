import { DialogID, type Dialog } from '../../dialog';
import { getStopRequestedReason, hasActiveRun } from '../../dialog-display-state';
import { hasDurableDriveWork } from '../../dialog-drive-work';
import { getRecoverableGenerationRunState } from '../../dialog-generation-run';
import { globalDialogRegistry, type DriveTriggerEvent } from '../../dialog-global-registry';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { doesInterruptionReasonRequireExplicitResume } from '../../dialog-interruption';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { findDomindsPersistenceFileError } from '../../persistence-errors';
import { driveDialogStream } from './engine';
import type { KernelDriverRunBackendResult } from './types';

function formatDriveTriggerForLog(trigger: DriveTriggerEvent): Record<string, unknown> {
  return {
    action: trigger.action,
    rootId: trigger.rootId,
    entryFound: trigger.entryFound,
    previousWakeQueued: trigger.previousWakeQueued,
    nextWakeQueued: trigger.nextWakeQueued,
    source: trigger.source,
    reason: trigger.reason,
    emittedAtMs: trigger.emittedAtMs,
  };
}

async function listLiveDialogsWithDurableDriveWork(): Promise<
  Array<{
    rootDialog: ReturnType<typeof globalDialogRegistry.getAll>[number];
    dialog: Dialog;
  }>
> {
  const liveDialogs = globalDialogRegistry.getAll();
  const queued: Array<{
    rootDialog: ReturnType<typeof globalDialogRegistry.getAll>[number];
    dialog: Dialog;
  }> = [];

  for (const mainDialog of liveDialogs) {
    let watchedDialogIds: readonly DialogID[];
    try {
      watchedDialogIds = await DialogPersistence.loadDriveWatchedDialogIds(
        mainDialog.id,
        mainDialog.status,
      );
    } catch (error: unknown) {
      log.error('Backend driver skipped root because drive-watch could not be loaded', error, {
        rootId: mainDialog.id.rootId,
        selfId: mainDialog.id.selfId,
      });
      continue;
    }
    const candidateDialogs: Dialog[] = [mainDialog];
    let hadCandidateInspectionError = false;
    for (const watchedDialogId of watchedDialogIds) {
      let watchedDialog: Dialog | undefined;
      try {
        watchedDialog = await ensureDialogLoaded(mainDialog, watchedDialogId, mainDialog.status);
      } catch (error: unknown) {
        hadCandidateInspectionError = true;
        log.error('Backend driver failed to restore watched side dialog', error, {
          rootId: mainDialog.id.rootId,
          selfId: watchedDialogId.selfId,
        });
        continue;
      }
      if (watchedDialog !== undefined) {
        candidateDialogs.push(watchedDialog);
      } else {
        log.warn(
          'Backend driver could not restore watched side dialog; dropping watch entry',
          undefined,
          {
            rootId: mainDialog.id.rootId,
            selfId: watchedDialogId.selfId,
          },
        );
        await DialogPersistence.removeDriveWatchForDialog(watchedDialogId, mainDialog.status);
      }
    }

    let hasQueuedCandidateForRoot = false;
    for (const dialog of candidateDialogs) {
      let latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
      try {
        latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      } catch (error: unknown) {
        if (!findDomindsPersistenceFileError(error)) {
          hadCandidateInspectionError = true;
          log.error('Backend driver failed to inspect dialog latest snapshot', error, {
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          });
          continue;
        }
        log.warn('Backend driver skipped malformed dialog latest snapshot', error, {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
        await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
        continue;
      }
      if (!latest) {
        continue;
      }
      await DialogPersistence.syncDriveWatchForDialogLatest(dialog.id, latest, dialog.status);
      if (!hasDurableDriveWork(latest)) {
        continue;
      }
      hasQueuedCandidateForRoot = true;
      queued.push({
        rootDialog: mainDialog,
        dialog,
      });
    }
    if (!hasQueuedCandidateForRoot && !hadCandidateInspectionError) {
      globalDialogRegistry.clearDriveWake(mainDialog.id.rootId, {
        source: 'kernel_driver_backend_loop',
        reason: 'no_durable_drive_work',
      });
      await DialogPersistence.setBackendQueueDrive(
        mainDialog.id,
        false,
        'no_durable_drive_work',
        mainDialog.status,
      );
    }
  }

  return queued;
}

async function reassertLiveRootWakeForDurableWork(): Promise<void> {
  for (const mainDialog of globalDialogRegistry.getAll()) {
    try {
      const rootHasPendingNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(
        mainDialog.id,
        mainDialog.status,
      );
      const watchedDialogIds = await DialogPersistence.loadDriveWatchedDialogIds(
        mainDialog.id,
        mainDialog.status,
      );
      if (!rootHasPendingNextStepTriggers && watchedDialogIds.length === 0) {
        continue;
      }
      globalDialogRegistry.wakeDrive(mainDialog.id.rootId, {
        source: 'kernel_driver_backend_loop',
        reason: rootHasPendingNextStepTriggers
          ? 'root_next_step_still_pending'
          : 'drive_watch_still_pending',
      });
    } catch (error: unknown) {
      log.error('Backend driver failed to reassert root wake for durable work', error, {
        rootId: mainDialog.id.rootId,
        selfId: mainDialog.id.selfId,
      });
    }
  }
}

export async function driveQueuedDialogsOnce(): Promise<void> {
  const dialogsToDrive = await listLiveDialogsWithDurableDriveWork();
  for (const { rootDialog, dialog } of dialogsToDrive) {
    try {
      const latestForDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      if (!hasDurableDriveWork(latestForDrive)) {
        await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
        continue;
      }
      const currentHasPendingNextStepTriggers =
        (latestForDrive?.nextStep?.triggers.length ?? 0) > 0;
      const currentResumeInProgressGeneration =
        getRecoverableGenerationRunState(latestForDrive) !== undefined;
      const currentHasBackendDurableWork = hasDurableDriveWork(latestForDrive);
      const executionMarker = latestForDrive?.executionMarker;
      const stopRequested = getStopRequestedReason(dialog.id);
      const interruptedRequiresExplicitResume =
        executionMarker?.kind === 'interrupted' &&
        doesInterruptionReasonRequireExplicitResume(executionMarker.reason);
      if (interruptedRequiresExplicitResume || stopRequested !== undefined) {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: interruptedRequiresExplicitResume
              ? 'execution_marker_blocked:interrupted'
              : `stop_requested:${stopRequested}`,
          });
        }
        await DialogPersistence.setBackendQueueDrive(
          dialog.id,
          false,
          interruptedRequiresExplicitResume
            ? 'execution_marker_blocked_interrupted'
            : `stop_requested_${stopRequested}`,
          dialog.status,
        );
        await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
        continue;
      }

      if (hasActiveRun(dialog.id)) {
        log.debug(
          'Backend driver deferred queued dialog drive because dialog already has an active run',
          undefined,
          {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
          },
        );
        globalDialogRegistry.noteActiveRunBlockedQueuedDrive(dialog.id.rootId);
        continue;
      }

      if (!currentHasBackendDurableWork) {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'missing_durable_drive_work',
          });
        }
        await DialogPersistence.setBackendQueueDrive(
          dialog.id,
          false,
          'missing_durable_drive_work',
          dialog.status,
        );
        await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
        continue;
      }
      if (!currentResumeInProgressGeneration && !(await dialog.canDrive())) {
        continue;
      }

      await driveDialogStream(dialog, undefined, true, {
        source: 'kernel_driver_backend_loop',
        reason:
          dialog.id.selfId === dialog.id.rootId
            ? 'global_dialog_registry_needs_drive'
            : 'drive_watch_index_needs_drive',
        ...(currentResumeInProgressGeneration ? { resumeInProgressGeneration: true } : {}),
      });

      const status = await dialog.getSuspensionStatus();
      const latestAfterDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      if (latestAfterDrive) {
        await DialogPersistence.syncDriveWatchForDialogLatest(
          dialog.id,
          latestAfterDrive,
          dialog.status,
        );
      }
      const stillHasDurableWork = hasDurableDriveWork(latestAfterDrive);
      const shouldStayQueued = dialog.hasUpNext() || !status.canDrive || stillHasDurableWork;
      if (shouldStayQueued) {
        globalDialogRegistry.wakeDrive(rootDialog.id.rootId, {
          source: 'kernel_driver_backend_loop',
          reason: dialog.hasUpNext()
            ? 'post_drive_upnext_pending'
            : stillHasDurableWork
              ? 'post_drive_durable_work_pending'
              : 'post_drive_suspended',
        });
        if (dialog.id.selfId === dialog.id.rootId) {
          await DialogPersistence.setBackendQueueDrive(
            dialog.id,
            true,
            dialog.hasUpNext()
              ? 'post_drive_upnext_pending'
              : stillHasDurableWork
                ? 'post_drive_durable_work_pending'
                : 'post_drive_suspended',
            dialog.status,
          );
        }
      } else {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'post_drive_idle',
          });
          await DialogPersistence.setBackendQueueDrive(
            dialog.id,
            false,
            'post_drive_idle',
            dialog.status,
          );
        }
        await DialogPersistence.removeDriveWatchForDialog(dialog.id, dialog.status);
      }
      const lastTrigger = globalDialogRegistry.getLastDriveTrigger(dialog.id.rootId);
      const lastTriggerAgeMs =
        lastTrigger !== undefined ? Math.max(0, Date.now() - lastTrigger.emittedAtMs) : undefined;
      if (status.backgroundCalleeDialogs) {
        log.debug(`Dialog ${dialog.id.valueOf()} has background callee dialogs`, undefined, {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          waitingQ4H: status.q4h,
          backgroundCalleeDialogs: status.backgroundCalleeDialogs,
          hasQueuedUpNext: dialog.hasUpNext(),
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousWakeQueued: lastTrigger.previousWakeQueued,
                nextWakeQueued: lastTrigger.nextWakeQueued,
              }
            : null,
        });
      }
      if (status.q4h) {
        log.debug(`Dialog ${dialog.id.valueOf()} awaiting Q4H answer`, undefined, {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          waitingQ4H: status.q4h,
          backgroundCalleeDialogs: status.backgroundCalleeDialogs,
          hasQueuedUpNext: dialog.hasUpNext(),
          lastDriveTrigger: lastTrigger
            ? {
                action: lastTrigger.action,
                source: lastTrigger.source,
                reason: lastTrigger.reason,
                emittedAtMs: lastTrigger.emittedAtMs,
                ageMs: lastTriggerAgeMs,
                entryFound: lastTrigger.entryFound,
                previousWakeQueued: lastTrigger.previousWakeQueued,
                nextWakeQueued: lastTrigger.nextWakeQueued,
              }
            : null,
        });
      }
    } catch (err) {
      log.error(`Error driving dialog ${dialog.id.valueOf()}:`, err, undefined, {
        dialogId: dialog.id.valueOf(),
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
      });
      try {
        const latestAfterError = await DialogPersistence.loadDialogLatest(
          dialog.id,
          dialog.status,
        );
        if (latestAfterError) {
          await DialogPersistence.syncDriveWatchForDialogLatest(
            dialog.id,
            latestAfterError,
            dialog.status,
          );
        }
        const rootId = new DialogID(dialog.id.rootId);
        const rootHasPendingNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(
          rootId,
          dialog.status,
        );
        const watchedDialogIds = await DialogPersistence.loadDriveWatchedDialogIds(
          rootId,
          dialog.status,
        );
        if (rootHasPendingNextStepTriggers || watchedDialogIds.length > 0) {
          globalDialogRegistry.wakeDrive(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'drive_error_durable_work_pending',
          });
        }
      } catch (requeueErr: unknown) {
        log.error('Failed to requeue durable work after backend drive error', requeueErr, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
      }
    }
  }
  await reassertLiveRootWakeForDurableWork();
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
