import { Dialog, DialogID } from '../dialog';
import { getRecoverableGenerationRunState } from '../dialog-generation-run';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../dialog-instance-registry';
import { createLogger } from '../log';
import { DialogPersistence } from '../persistence';
import { findDomindsPersistenceFileError } from '../persistence-errors';

const log = createLogger('open-generation-recovery');

async function restoreDialogForOpenGenerationRecovery(
  dialogId: DialogID,
): Promise<Dialog | undefined> {
  const mainDialog = await getOrRestoreMainDialog(dialogId.rootId, 'running');
  if (!mainDialog) {
    return undefined;
  }
  if (dialogId.selfId === dialogId.rootId) {
    return mainDialog;
  }
  return await ensureDialogLoaded(mainDialog, dialogId, 'running');
}

async function recoverRootOpenGeneration(dialog: Dialog): Promise<void> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  const generationRunState = latest?.generationRunState;
  if (!generationRunState || generationRunState.kind !== 'open') {
    throw new Error(
      `open-generation recovery invariant violation: missing open generation state ` +
        `(rootId=${dialog.id.rootId}, selfId=${dialog.id.selfId})`,
    );
  }
  await DialogPersistence.upsertNextStepTrigger(
    dialog.id,
    {
      triggerId: `open-generation-recovery:${dialog.id.selfId}:${generationRunState.course}:${generationRunState.genseq}`,
      kind: 'open_generation_recovery',
      course: generationRunState.course,
      genseq: generationRunState.genseq,
      createdAt: generationRunState.openedAt,
    },
    dialog.status,
  );
  globalDialogRegistry.wakeDrive(dialog.id.rootId, {
    source: 'restart_recovery',
    reason: 'persisted_open_generation_recovery',
  });
}

async function recoverSideDialogOpenGeneration(dialog: Dialog): Promise<void> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  if (latest) {
    await DialogPersistence.syncWakeQueueForDialogLatest(dialog.id, latest, dialog.status);
  } else {
    await DialogPersistence.removeWakeQueueEntriesForDialog(dialog.id, dialog.status);
  }
  const rootId = new DialogID(dialog.id.rootId);
  const rootHasPendingNextStepTriggers = await DialogPersistence.hasPendingNextStepTriggers(
    rootId,
    dialog.status,
  );
  const wakeQueueEntries = await DialogPersistence.loadWakeQueueEntries(rootId, dialog.status);
  if (rootHasPendingNextStepTriggers || wakeQueueEntries.length > 0) {
    globalDialogRegistry.wakeDrive(dialog.id.rootId, {
      source: 'restart_recovery',
      reason: 'sideDialog_open_generation_recovered_more_work',
    });
  } else {
    globalDialogRegistry.clearDriveWake(dialog.id.rootId, {
      source: 'restart_recovery',
      reason: 'sideDialog_open_generation_recovered_idle',
    });
  }
}

export async function recoverOpenGenerationAfterRestart(): Promise<void> {
  const rootDialogIds = await DialogPersistence.listMainDialogIds('running');
  const dialogIds: DialogID[] = [];
  for (const rootDialogId of rootDialogIds) {
    dialogIds.push(rootDialogId);
    const wakeQueuedDialogIds = await DialogPersistence.loadWakeQueuedDialogIds(
      rootDialogId,
      'running',
    );
    dialogIds.push(...wakeQueuedDialogIds);
  }
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
      log.warn('Skipping malformed dialog during open-generation restart recovery', error, {
        dialogId: dialogId.valueOf(),
      });
      continue;
    }

    if (getRecoverableGenerationRunState(latest) === undefined) {
      continue;
    }

    try {
      const dialog = await restoreDialogForOpenGenerationRecovery(dialogId);
      if (!dialog) {
        log.warn('Open-generation restart recovery could not restore dialog', undefined, {
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
        await recoverRootOpenGeneration(dialog);
      } else {
        await recoverSideDialogOpenGeneration(dialog);
      }
    } catch (error: unknown) {
      log.error('Failed to recover open generation after restart', error, {
        rootId: dialogId.rootId,
        selfId: dialogId.selfId,
      });
    }
  }
}
