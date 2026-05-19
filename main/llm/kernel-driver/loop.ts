import { DialogID, type Dialog, type MainDialog } from '../../dialog';
import { getStopRequestedReason, hasActiveRun } from '../../dialog-display-state';
import { hasDurableDriveWork } from '../../dialog-drive-work';
import { getRecoverableGenerationRunState } from '../../dialog-generation-run';
import { globalDialogRegistry, type DriveTriggerEvent } from '../../dialog-global-registry';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { isInterruptedDialogBlockedWithoutExplicitResume } from '../../dialog-interruption';
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
    previousDriveQueued: trigger.previousDriveQueued,
    nextDriveQueued: trigger.nextDriveQueued,
    source: trigger.source,
    reason: trigger.reason,
    emittedAtMs: trigger.emittedAtMs,
  };
}

type DialogLatestForBackendLoop = Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;

type OpenGenerationRecoveryClaim =
  | Readonly<{ status: 'claimed' }>
  | Readonly<{ status: 'stale'; latestAfterCleanup: DialogLatestForBackendLoop }>
  | Readonly<{ status: 'not_applicable' }>;

function wakeQueueHasEntriesForDialog(
  entries: Awaited<ReturnType<typeof DialogPersistence.loadWakeQueueEntries>>,
  dialogId: DialogID,
): boolean {
  return entries.some((entry) => entry.targetDialogId === dialogId.selfId);
}

function wakeQueueHasRootRuntimeWake(
  entries: Awaited<ReturnType<typeof DialogPersistence.loadWakeQueueEntries>>,
  dialogId: DialogID,
): boolean {
  if (dialogId.selfId !== dialogId.rootId) {
    return false;
  }
  return entries.some(
    (entry) => entry.kind === 'root_runtime_wake' && entry.targetDialogId === dialogId.selfId,
  );
}

async function removeOpenGenerationRecoveryTriggers(dialog: Dialog): Promise<void> {
  await DialogPersistence.removeNextStepTriggers(
    dialog.id,
    (trigger) => trigger.kind === 'open_generation_recovery',
    dialog.status,
  );
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  if (latest) {
    await DialogPersistence.syncWakeQueueForDialogLatest(dialog.id, latest, dialog.status);
  } else {
    await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
  }
}

async function claimOpenGenerationRecoveryForBackendLoop(args: {
  dialog: Dialog;
  latest: DialogLatestForBackendLoop;
}): Promise<OpenGenerationRecoveryClaim> {
  if (!args.latest) {
    return { status: 'not_applicable' };
  }
  if (getRecoverableGenerationRunState(args.latest) !== undefined) {
    return { status: 'claimed' };
  }
  const hasRecoveryTrigger = args.latest.nextStep.triggers.some(
    (trigger) => trigger.kind === 'open_generation_recovery',
  );
  if (!hasRecoveryTrigger) {
    return { status: 'not_applicable' };
  }
  await removeOpenGenerationRecoveryTriggers(args.dialog);
  return {
    status: 'stale',
    latestAfterCleanup: await DialogPersistence.loadDialogLatest(
      args.dialog.id,
      args.dialog.status,
    ),
  };
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
    let wakeQueueEntries: Awaited<ReturnType<typeof DialogPersistence.loadWakeQueueEntries>>;
    try {
      wakeQueueEntries = await DialogPersistence.loadWakeQueueEntries(
        mainDialog.id,
        mainDialog.status,
      );
    } catch (error: unknown) {
      log.error('Backend driver skipped root because wake queue could not be loaded', error, {
        rootId: mainDialog.id.rootId,
        selfId: mainDialog.id.selfId,
      });
      continue;
    }
    const wakeQueueTargetDialogIds = [
      ...new Set(
        wakeQueueEntries
          .map((entry) => entry.targetDialogId)
          .filter((selfId) => selfId !== mainDialog.id.rootId),
      ),
    ].map((selfId) => new DialogID(selfId, mainDialog.id.rootId));
    const candidateDialogs: Dialog[] = [mainDialog];
    let hadCandidateInspectionError = false;
    let hadStalledCandidateForRoot = false;
    for (const wakeQueueTargetDialogId of wakeQueueTargetDialogIds) {
      let wakeQueueTargetDialog: Dialog | undefined;
      try {
        wakeQueueTargetDialog = await ensureDialogLoaded(
          mainDialog,
          wakeQueueTargetDialogId,
          mainDialog.status,
        );
      } catch (error: unknown) {
        hadCandidateInspectionError = true;
        log.error('Backend driver failed to restore Wake Queue target side dialog', error, {
          rootId: mainDialog.id.rootId,
          selfId: wakeQueueTargetDialogId.selfId,
        });
        continue;
      }
      if (wakeQueueTargetDialog !== undefined) {
        candidateDialogs.push(wakeQueueTargetDialog);
      } else {
        log.warn(
          'Backend driver could not restore Wake Queue target side dialog; dropping wake queue entries',
          undefined,
          {
            rootId: mainDialog.id.rootId,
            selfId: wakeQueueTargetDialogId.selfId,
          },
        );
        await DialogPersistence.removeWakeQueueEntriesForDialog(
          wakeQueueTargetDialogId,
          mainDialog.status,
        );
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
        await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
        continue;
      }
      if (!latest) {
        continue;
      }
      await DialogPersistence.syncWakeQueueForDialogLatest(dialog.id, latest, dialog.status);
      const hasRootRuntimeWake = wakeQueueHasRootRuntimeWake(wakeQueueEntries, dialog.id);
      if (!hasDurableDriveWork(latest) && !hasRootRuntimeWake) {
        continue;
      }
      const durableWorkFingerprint = DialogPersistence.buildBackendDriveDurableWorkFingerprint(
        latest,
        dialog.id.selfId === dialog.id.rootId ? wakeQueueEntries : [],
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
      globalDialogRegistry.clearRootDriveQueue(mainDialog.id.rootId, {
        source: 'kernel_driver_backend_loop',
        reason: 'no_durable_drive_work',
      });
      await DialogPersistence.removeRootRuntimeWake(mainDialog.id, mainDialog.status);
    }
  }

  return queued;
}

export async function driveQueuedDialogsOnce(): Promise<void> {
  const dialogsToDrive = await listLiveDialogsWithDurableDriveWork();
  for (const { rootDialog, dialog } of dialogsToDrive) {
    try {
      let latestForDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      let wakeQueueEntriesForRoot = await DialogPersistence.loadWakeQueueEntries(
        rootDialog.id,
        rootDialog.status,
      );
      const hasRootRuntimeWake = wakeQueueHasRootRuntimeWake(wakeQueueEntriesForRoot, dialog.id);
      if (!hasDurableDriveWork(latestForDrive) && !hasRootRuntimeWake) {
        await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
        continue;
      }
      let openGenerationRecoveryClaim = await claimOpenGenerationRecoveryForBackendLoop({
        dialog,
        latest: latestForDrive,
      });
      if (openGenerationRecoveryClaim.status === 'stale') {
        latestForDrive = openGenerationRecoveryClaim.latestAfterCleanup;
        if (!latestForDrive || !hasDurableDriveWork(latestForDrive)) {
          if (dialog.id.selfId === dialog.id.rootId) {
            globalDialogRegistry.clearRootDriveQueue(dialog.id.rootId, {
              source: 'kernel_driver_backend_loop',
              reason: 'stale_open_generation_recovery',
            });
            await DialogPersistence.removeRootRuntimeWake(dialog.id, dialog.status);
          }
          await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
          continue;
        }
        openGenerationRecoveryClaim = await claimOpenGenerationRecoveryForBackendLoop({
          dialog,
          latest: latestForDrive,
        });
      }
      const currentResumeInProgressGeneration = openGenerationRecoveryClaim.status === 'claimed';
      const currentHasBackendDurableWork = hasDurableDriveWork(latestForDrive);
      wakeQueueEntriesForRoot = await DialogPersistence.loadWakeQueueEntries(
        rootDialog.id,
        rootDialog.status,
      );
      const currentHasRootRuntimeWake = wakeQueueHasRootRuntimeWake(
        wakeQueueEntriesForRoot,
        dialog.id,
      );
      const executionMarker = latestForDrive?.executionMarker;
      const stopRequested = getStopRequestedReason(dialog.id);
      const interruptedBlockedWithoutExplicitResume =
        isInterruptedDialogBlockedWithoutExplicitResume(executionMarker, false);
      if (interruptedBlockedWithoutExplicitResume || stopRequested !== undefined) {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearRootDriveQueue(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: interruptedBlockedWithoutExplicitResume
              ? 'execution_marker_blocked:interrupted'
              : `stop_requested:${stopRequested}`,
          });
        }
        if (dialog.id.selfId === dialog.id.rootId) {
          await DialogPersistence.removeRootRuntimeWake(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
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

      if (!currentHasBackendDurableWork && !currentHasRootRuntimeWake) {
        if (dialog.id.selfId === dialog.id.rootId) {
          globalDialogRegistry.clearRootDriveQueue(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'missing_durable_drive_work',
          });
        }
        if (dialog.id.selfId === dialog.id.rootId) {
          await DialogPersistence.removeRootRuntimeWake(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
        continue;
      }
      if (
        !currentHasBackendDurableWork ||
        (!currentResumeInProgressGeneration && !(await dialog.canDrive()))
      ) {
        continue;
      }

      await driveDialogStream(dialog, undefined, true, {
        source: 'kernel_driver_backend_loop',
        reason: dialog.id.selfId === dialog.id.rootId ? 'root_runtime_wake' : 'wake_queue',
        ...(currentResumeInProgressGeneration ? { resumeInProgressGeneration: true } : {}),
      });

      const status = await dialog.getSuspensionStatus();
      const latestAfterDrive = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
      if (latestAfterDrive) {
        await DialogPersistence.syncWakeQueueForDialogLatest(
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
          globalDialogRegistry.queueRootDrive(rootDialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: dialog.hasUpNext()
              ? 'post_drive_upnext_pending'
              : 'post_drive_durable_work_pending',
          });
          if (dialog.id.selfId === dialog.id.rootId) {
            await DialogPersistence.upsertRootRuntimeWake(
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
          globalDialogRegistry.clearRootDriveQueue(dialog.id.rootId, {
            source: 'kernel_driver_backend_loop',
            reason: 'post_drive_idle',
          });
          await DialogPersistence.removeRootRuntimeWake(dialog.id, dialog.status);
        }
        await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
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
                previousDriveQueued: lastTrigger.previousDriveQueued,
                nextDriveQueued: lastTrigger.nextDriveQueued,
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
                previousDriveQueued: lastTrigger.previousDriveQueued,
                nextDriveQueued: lastTrigger.nextDriveQueued,
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
          await DialogPersistence.syncWakeQueueForDialogLatest(
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
        const wakeQueueEntries = await DialogPersistence.loadWakeQueueEntries(
          rootId,
          dialog.status,
        );
        if (rootHasPendingNextStepTriggers || wakeQueueEntries.length > 0) {
          const durableWorkFingerprint = DialogPersistence.buildBackendDriveDurableWorkFingerprint(
            latestAfterError,
            dialog.id.selfId === dialog.id.rootId ? wakeQueueEntries : [],
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
                wakeQueueEntryCount: wakeQueueEntries.length,
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
            wakeQueueEntryCount: wakeQueueEntries.length,
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
      globalDialogRegistry.queueRootDrive('__kernel_driver_abort__', {
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
