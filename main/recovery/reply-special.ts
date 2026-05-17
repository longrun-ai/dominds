import { Dialog, DialogID } from '../dialog';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../dialog-instance-registry';
import { driveDialogStream } from '../llm/kernel-driver';
import { recoverPendingReplyDelivery } from '../llm/kernel-driver/tellask-special';
import type {
  KernelDriverDriveCallOptions,
  KernelDriverDriveResult,
} from '../llm/kernel-driver/types';
import { createLogger } from '../log';
import { DialogPersistence } from '../persistence';

const log = createLogger('reply-special-recovery');
const inFlightReplyRecoveryByDialog = new Map<string, Promise<number>>();

function dispatchDrive(
  dialog: Dialog,
  options: KernelDriverDriveCallOptions,
): KernelDriverDriveResult {
  if (options.humanPrompt !== undefined) {
    return driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
  }
  return driveDialogStream(dialog, undefined, options.waitInQue, options.driveOptions);
}

export async function recoverPendingReplyTellaskCallsForDialog(dialog: Dialog): Promise<number> {
  const dialogKey = dialog.id.valueOf();
  const existing = inFlightReplyRecoveryByDialog.get(dialogKey);
  if (existing) {
    return await existing;
  }

  // This helper is reserved for execution-oriented flows only (restart recovery, resume, and
  // dead-sideDialog remediation). Those flows are allowed to have side effects and may legitimately
  // unblock downstream dialogs, so reply recovery keeps normal immediate drive behavior here.
  // Pure read/display flows must not call into this helper.
  const recoveryPromise = (async () => {
    const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    const replyDelivery = latest?.replyDelivery;
    if (
      !replyDelivery ||
      (replyDelivery.status !== 'pending' && replyDelivery.toolResultStatus !== 'pending')
    ) {
      return 0;
    }
    return await recoverPendingReplyDelivery({
      dlg: dialog,
      replyDelivery,
      callbacks: {
        scheduleDrive: (scheduledDialog, options) => {
          void dispatchDrive(scheduledDialog, options);
        },
        driveDialog: async (scheduledDialog, options) => {
          return await dispatchDrive(scheduledDialog, options);
        },
      },
    });
  })();
  inFlightReplyRecoveryByDialog.set(dialogKey, recoveryPromise);

  try {
    return await recoveryPromise;
  } finally {
    if (inFlightReplyRecoveryByDialog.get(dialogKey) === recoveryPromise) {
      inFlightReplyRecoveryByDialog.delete(dialogKey);
    }
  }
}

async function dialogNeedsReplyRecovery(dialogId: DialogID): Promise<boolean> {
  const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
  return (
    latest?.replyDelivery?.status === 'pending' ||
    latest?.replyDelivery?.toolResultStatus === 'pending'
  );
}

async function listReplyRecoveryCandidateDialogIds(): Promise<readonly DialogID[]> {
  const rootDialogIds = await DialogPersistence.listMainDialogIds('running');
  const candidates: DialogID[] = [];
  const seen = new Set<string>();
  for (const rootDialogId of rootDialogIds) {
    const rootKey = rootDialogId.key();
    if (!seen.has(rootKey)) {
      seen.add(rootKey);
      candidates.push(rootDialogId);
    }
    const watchedDialogIds = await DialogPersistence.loadDriveWatchedDialogIds(
      rootDialogId,
      'running',
    );
    for (const watchedDialogId of watchedDialogIds) {
      const watchedKey = watchedDialogId.key();
      if (seen.has(watchedKey)) {
        continue;
      }
      seen.add(watchedKey);
      candidates.push(watchedDialogId);
    }
  }
  return candidates;
}

export async function recoverPendingReplyTellaskCallsAfterRestart(): Promise<void> {
  const dialogIds = await listReplyRecoveryCandidateDialogIds();
  for (const dialogId of dialogIds) {
    try {
      // Startup recovery is also execution-oriented: if a persisted replyTellask* was left
      // half-finished by process crash, finish delivery before normal backend driving proceeds.
      if (!(await dialogNeedsReplyRecovery(dialogId))) {
        continue;
      }
      const mainDialog = await getOrRestoreMainDialog(dialogId.rootId, 'running');
      if (!mainDialog) {
        continue;
      }
      const dialog =
        dialogId.selfId === dialogId.rootId
          ? mainDialog
          : await ensureDialogLoaded(mainDialog, dialogId, 'running');
      if (!dialog) {
        continue;
      }
      await recoverPendingReplyTellaskCallsForDialog(dialog);
    } catch (err) {
      log.error('Failed to recover pending replyTellask* delivery during restart recovery', err, {
        rootId: dialogId.rootId,
        selfId: dialogId.selfId,
      });
    }
  }
}
