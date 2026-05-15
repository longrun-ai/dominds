import { Dialog, DialogID } from '../dialog';
import { isRecoverableGeneratingLatest } from '../dialog-display-state';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../dialog-instance-registry';
import { driveDialogStream } from '../llm/kernel-driver';
import { createLogger } from '../log';
import { DialogPersistence } from '../persistence';
import { findDomindsPersistenceFileError } from '../persistence-errors';

const log = createLogger('proceeding-drive-recovery');

async function restoreDialogForProceedingDrive(dialogId: DialogID): Promise<Dialog | undefined> {
  const mainDialog = await getOrRestoreMainDialog(dialogId.rootId, 'running');
  if (!mainDialog) {
    return undefined;
  }
  if (dialogId.selfId === dialogId.rootId) {
    return mainDialog;
  }
  return await ensureDialogLoaded(mainDialog, dialogId, 'running');
}

async function recoverRootProceedingDrive(dialog: Dialog): Promise<void> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  const generationRunState = latest?.generationRunState;
  if (!generationRunState || generationRunState.kind !== 'open') {
    throw new Error(
      `proceeding-drive recovery invariant violation: missing open generation state ` +
        `(rootId=${dialog.id.rootId}, selfId=${dialog.id.selfId})`,
    );
  }
  await DialogPersistence.mutateDialogLatest(
    dialog.id,
    (previous) => ({
      kind: 'patch',
      patch: {
        needsDrive: true,
        nextStep: {
          triggers: [
            ...(previous.nextStep?.triggers.filter(
              (trigger) => trigger.kind !== 'open_generation_recovery',
            ) ?? []),
            {
              triggerId: `open-generation-recovery:${dialog.id.selfId}:${generationRunState.course}:${generationRunState.genseq}`,
              kind: 'open_generation_recovery',
              course: generationRunState.course,
              genseq: generationRunState.genseq,
            },
          ],
        },
      },
    }),
    dialog.status,
  );
  globalDialogRegistry.markNeedsDrive(dialog.id.rootId, {
    source: 'restart_recovery',
    reason: 'persisted_drive_in_progress',
  });
}

async function recoverSideDialogProceedingDrive(dialog: Dialog): Promise<void> {
  await driveDialogStream(dialog, undefined, true, {
    source: 'kernel_driver_sideDialog_resume',
    reason: 'restart_recovery:persisted_drive_in_progress',
    resumeInProgressGeneration: true,
  });
}

export async function recoverProceedingDrivesAfterRestart(): Promise<void> {
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  const recoveredRootIds = new Set<string>();
  const recoveredDialogKeys = new Set<string>();

  for (const dialogId of dialogIds) {
    let latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
    try {
      latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    } catch (error: unknown) {
      if (!findDomindsPersistenceFileError(error)) {
        throw error;
      }
      log.warn('Skipping malformed dialog during proceeding-drive restart recovery', error, {
        dialogId: dialogId.valueOf(),
      });
      continue;
    }

    if (!isRecoverableGeneratingLatest(latest)) {
      continue;
    }

    try {
      const dialog = await restoreDialogForProceedingDrive(dialogId);
      if (!dialog) {
        log.warn('Proceeding-drive restart recovery could not restore dialog', undefined, {
          rootId: dialogId.rootId,
          selfId: dialogId.selfId,
        });
        continue;
      }

      const dialogKey = dialog.id.key();
      if (recoveredDialogKeys.has(dialogKey)) {
        continue;
      }
      recoveredDialogKeys.add(dialogKey);

      if (dialog.id.selfId === dialog.id.rootId) {
        if (recoveredRootIds.has(dialog.id.rootId)) {
          continue;
        }
        recoveredRootIds.add(dialog.id.rootId);
        await recoverRootProceedingDrive(dialog);
      } else {
        await recoverSideDialogProceedingDrive(dialog);
      }
    } catch (error: unknown) {
      log.error('Failed to recover proceeding drive after restart', error, {
        rootId: dialogId.rootId,
        selfId: dialogId.selfId,
      });
    }
  }
}
