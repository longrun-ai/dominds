import { DialogID, type Dialog, type MainDialog } from '../../dialog';
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

function formatDriveError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === 'string' && error.stack.trim() !== ''
        ? { stack: error.stack }
        : {}),
    };
  }
  return { message: String(error) };
}

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

function hasOpenGenerationRecoveryTrigger(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
): boolean {
  return (
    latest?.nextStep.triggers.some((trigger) => trigger.kind === 'open_generation_recovery') ===
    true
  );
}

async function removeOpenGenerationRecoveryTriggers(dialog: Dialog): Promise<void> {
  await DialogPersistence.removeNextStepTriggers(
    dialog.id,
    (trigger) => trigger.kind === 'open_generation_recovery',
    dialog.status,
  );
}

async function listLiveDialogsWithDurableDriveWork(): Promise<
  Array<{
    rootDialog: MainDialog;
    dialog: Dialog;
  }>
> {
  const liveDialogs = globalDialogRegistry.consumeQueuedMainDialogs();
  const queued: Array<{
    rootDialog: MainDialog;
    dialog: Dialog;
  }> = [];

  for (const mainDialog of liveDialogs) {
    let wakeCuedDialogIds: readonly DialogID[];
    try {
      wakeCuedDialogIds = await DialogPersistence.loadWakeCuedDialogIds(
        mainDialog.id,
        mainDialog.status,
      );
    } catch (error: unknown) {
      log.error(
        'Backend driver skipped root because sideline wake cue storage could not be loaded',
        error,
        {
          rootId: mainDialog.id.rootId,
          selfId: mainDialog.id.selfId,
        },
      );
      continue;
    }
    const candidateDialogs: Dialog[] = [mainDialog];
    let hadCandidateInspectionError = false;
    let hadStalledCandidateForRoot = false;
    for (const wakeCuedDialogId of wakeCuedDialogIds) {
      let wakeCuedDialog: Dialog | undefined;
      try {
        wakeCuedDialog = await ensureDialogLoaded(mainDialog, wakeCuedDialogId, mainDialog.status);
      } catch (error: unknown) {
        hadCandidateInspectionError = true;
        log.error(
          'Backend driver failed to restore queued side dialog from sideline wake cue storage',
          error,
          {
            rootId: mainDialog.id.rootId,
            selfId: wakeCuedDialogId.selfId,
          },
        );
        continue;
      }
      if (wakeCuedDialog !== undefined) {
        candidateDialogs.push(wakeCuedDialog);
      } else {
        log.warn(
          'Backend driver could not restore queued side dialog; dropping wake cue entry',
          undefined,
          {
            rootId: mainDialog.id.rootId,
            selfId: wakeCuedDialogId.selfId,
          },
        );
        await DialogPersistence.removeWakeCueForDialog(wakeCuedDialogId, mainDialog.status);
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
        await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
        continue;
      }
      if (!latest) {
        continue;
      }
      await DialogPersistence.syncWakeCueForDialogLatest(dialog.id, latest, dialog.status);
      if (!hasDurableDriveWork(latest)) {
        continue;
      }
      const durableWorkFingerprint = DialogPersistence.buildBackendDriveDurableWorkFingerprint(
        latest,
        dialog.id.selfId === dialog.id.rootId ? wakeCuedDialogIds : [],
      );
      if (latest.backendDriveStall?.durableWorkFingerprint === durableWorkFingerprint) {
        hadStalledCandidateForRoot = true;
        log.warn('Backend driver skipped stalled durable work pending new facts', undefined, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          stallRecordId: latest.backendDriveStall.recordId,
        });
        continue;
      }
      hasQueuedCandidateForRoot = true;
      queued.push({
        rootDialog: mainDialog,
        dialog,
      });
    }
    if (!hasQueuedCandidateForRoot && !hadCandidateInspectionError && !hadStalledCandidateForRoot) {
      globalDialogRegistry.clearDriveWake(mainDialog.id.rootId, {
        source: 'kernel_driver_backend_loop',
        reason: 'no_durable_drive_work',
      });
      await DialogPersistence.removeRootDriveWakeTrigger(mainDialog.id, mainDialog.status);
    }
  }

  return queued;
}

export async function driveQueuedDialogsOnce(): Promise<void> {
  const dialogsToDrive = await listLiveDialogsWithDurableDriveWork();
  for (const { rootDialog, dialog } of dialogsToDrive) {
    try {
      let latestForDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      if (!hasDurableDriveWork(latestForDrive)) {
        await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
        continue;
      }
      if (
        hasOpenGenerationRecoveryTrigger(latestForDrive) &&
        getRecoverableGenerationRunState(latestForDrive) === undefined
      ) {
        await removeOpenGenerationRecoveryTriggers(dialog);
        latestForDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
        if (!latestForDrive || !hasDurableDriveWork(latestForDrive)) {
          if (dialog.id.selfId === dialog.id.rootId) {
            globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
              source: 'kernel_driver_backend_loop',
              reason: 'stale_open_generation_recovery',
            });
            await DialogPersistence.removeRootDriveWakeTrigger(dialog.id, dialog.status);
          }
          await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
          continue;
        }
      }
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
        if (dialog.id.selfId === dialog.id.rootId) {
          await DialogPersistence.removeRootDriveWakeTrigger(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
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
        if (dialog.id.selfId === dialog.id.rootId) {
          await DialogPersistence.removeRootDriveWakeTrigger(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
        continue;
      }
      if (!currentResumeInProgressGeneration && !(await dialog.canDrive())) {
        continue;
      }

      await driveDialogStream(dialog, undefined, true, {
        source: 'kernel_driver_backend_loop',
        reason: dialog.id.selfId === dialog.id.rootId ? 'root_drive_wake' : 'sideline_wake_cue',
        ...(currentResumeInProgressGeneration ? { resumeInProgressGeneration: true } : {}),
      });

      const status = await dialog.getSuspensionStatus();
      const latestAfterDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      if (latestAfterDrive) {
        await DialogPersistence.syncWakeCueForDialogLatest(
          dialog.id,
          latestAfterDrive,
          dialog.status,
        );
      }
      const stillHasDurableWork = hasDurableDriveWork(latestAfterDrive);
      const shouldStayQueued = dialog.hasUpNext() || !status.canDrive || stillHasDurableWork;
      if (shouldStayQueued) {
        const canRetryImmediately = dialog.hasUpNext() || (status.canDrive && stillHasDurableWork);
        if (canRetryImmediately) {
          globalDialogRegistry.wakeDrive(rootDialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: dialog.hasUpNext()
              ? 'post_drive_upnext_pending'
              : 'post_drive_durable_work_pending',
          });
          if (dialog.id.selfId === dialog.id.rootId) {
            await DialogPersistence.upsertRootDriveWakeTrigger(
              dialog.id,
              dialog.hasUpNext() ? 'post_drive_upnext_pending' : 'post_drive_durable_work_pending',
              dialog.status,
            );
          }
        } else {
          log.debug(
            'Backend driver left durable work parked until the blocking state changes',
            undefined,
            {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              waitingQ4H: status.q4h,
              backgroundCalleeDialogs: status.backgroundCalleeDialogs,
              stillHasDurableWork,
            },
          );
        }
      } else {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'post_drive_idle',
          });
          await DialogPersistence.removeRootDriveWakeTrigger(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeCueForDialog(dialog.id, dialog.status);
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
        const latestAfterError = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
        if (latestAfterError) {
          await DialogPersistence.syncWakeCueForDialogLatest(
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
        const wakeCuedDialogIds = await DialogPersistence.loadWakeCuedDialogIds(
          rootId,
          dialog.status,
        );
        if (rootHasPendingNextStepTriggers || wakeCuedDialogIds.length > 0) {
          const durableWorkFingerprint = DialogPersistence.buildBackendDriveDurableWorkFingerprint(
            latestAfterError,
            dialog.id.selfId === dialog.id.rootId ? wakeCuedDialogIds : [],
          );
          const record = await DialogPersistence.appendBackendDriveStallRecord(
            dialog.id,
            {
              dialogId: dialog.id.valueOf(),
              rootId: dialog.id.rootId,
              selfId: dialog.id.selfId,
              status: dialog.status,
              reason: 'backend_drive_error',
              durableWorkFingerprint,
              latestSummary:
                latestAfterError === null
                  ? null
                  : {
                      currentCourse: latestAfterError.currentCourse,
                      status: latestAfterError.status,
                      generating: latestAfterError.generating ?? false,
                      displayState: latestAfterError.displayState ?? null,
                      executionMarker: latestAfterError.executionMarker ?? null,
                      generationRunState: latestAfterError.generationRunState ?? null,
                      nextStepTriggerCount: latestAfterError.nextStep.triggers.length,
                      pendingRuntimePromptMsgId:
                        latestAfterError.pendingRuntimePrompt?.msgId ?? null,
                      replyDelivery: latestAfterError.replyDelivery ?? null,
                      userWait: latestAfterError.userWait ?? null,
                      sideDialogFinalResponse: latestAfterError.sideDialogFinalResponse ?? null,
                    },
              error: formatDriveError(err),
              context: {
                rootHasPendingNextStepTriggers,
                wakeCuedDialogCount: wakeCuedDialogIds.length,
              },
            },
            dialog.status,
          );
          log.warn('Backend driver persisted stalled durable work after drive error', undefined, {
            dialogId: dialog.id.valueOf(),
            rootId: dialog.id.rootId,
            selfId: dialog.id.selfId,
            stallRecordId: record.recordId,
            rootHasPendingNextStepTriggers,
            wakeCuedDialogCount: wakeCuedDialogIds.length,
          });
        }
      } catch (stallErr: unknown) {
        log.error('Failed to persist backend drive stall after drive error', stallErr, {
          dialogId: dialog.id.valueOf(),
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
        });
      }
    }
  }
}

function isBackendDriverAborted(options: { abortSignal?: AbortSignal } | undefined): boolean {
  return options?.abortSignal?.aborted === true;
}

export function runBackendDriver(options?: {
  abortSignal?: AbortSignal;
}): KernelDriverRunBackendResult {
  return (async () => {
    const abortListener = (): void => {
      globalDialogRegistry.wakeDrive('__kernel_driver_abort__', {
        source: 'kernel_driver_backend_loop',
        reason: 'abort_signal',
      });
    };
    options?.abortSignal?.addEventListener('abort', abortListener, { once: true });
    try {
      while (!isBackendDriverAborted(options)) {
        try {
          await driveQueuedDialogsOnce();
          if (isBackendDriverAborted(options)) {
            break;
          }

          const trigger = await globalDialogRegistry.waitForDriveTrigger();
          log.debug('Backend driver woke from drive trigger event', undefined, {
            trigger: formatDriveTriggerForLog(trigger),
          });
        } catch (loopErr) {
          if (isBackendDriverAborted(options)) {
            break;
          }
          log.error('Error in backend driver loop:', loopErr);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', abortListener);
    }
  })();
}
