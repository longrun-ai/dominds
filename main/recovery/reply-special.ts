import { Dialog, DialogID } from '../dialog';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import { driveDialogStream } from '../llm/kernel-driver';
import { recoverPendingReplyTellaskCalls } from '../llm/kernel-driver/tellask-special';
import type { KernelDriverDriveCallOptions } from '../llm/kernel-driver/types';
import { createLogger } from '../log';
import { DialogPersistence } from '../persistence';

const log = createLogger('reply-special-recovery');
const inFlightReplyRecoveryByDialog = new Map<string, Promise<number>>();

function dispatchDrive(dialog: Dialog, options: KernelDriverDriveCallOptions): Promise<void> {
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
  // dead-subdialog remediation). Those flows are allowed to have side effects and may legitimately
  // unblock downstream dialogs, so reply recovery keeps normal immediate drive behavior here.
  // Pure read/display flows must not call into this helper.
  const recoveryPromise = recoverPendingReplyTellaskCalls({
    dlg: dialog,
    callbacks: {
      scheduleDrive: (scheduledDialog, options) => {
        void dispatchDrive(scheduledDialog, options);
      },
      driveDialog: async (scheduledDialog, options) => {
        await dispatchDrive(scheduledDialog, options);
      },
    },
  });
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
  if (!latest) {
    return false;
  }
  const currentCourse = Math.floor(latest.currentCourse);
  const events = await DialogPersistence.loadCourseEvents(dialogId, currentCourse, 'running');
  const funcResultIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'func_result_record') {
      const callId = event.id.trim();
      if (callId !== '') {
        funcResultIds.add(callId);
      }
      continue;
    }
  }
  return events.some((event) => {
    if (event.type !== 'tellask_special_call_record') {
      return false;
    }
    if (
      event.name !== 'replyTellask' &&
      event.name !== 'replyTellaskSessionless' &&
      event.name !== 'replyTellaskBack'
    ) {
      return false;
    }
    return !funcResultIds.has(event.id.trim());
  });
}

export async function recoverPendingReplyTellaskCallsAfterRestart(): Promise<void> {
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    try {
      // Startup recovery is also execution-oriented: if a persisted replyTellask* was left
      // half-finished by process crash, finish delivery before normal backend driving proceeds.
      if (!(await dialogNeedsReplyRecovery(dialogId))) {
        continue;
      }
      const rootDialog = await getOrRestoreRootDialog(dialogId.rootId, 'running');
      if (!rootDialog) {
        continue;
      }
      const dialog =
        dialogId.selfId === dialogId.rootId
          ? rootDialog
          : await ensureDialogLoaded(rootDialog, dialogId, 'running');
      if (!dialog) {
        continue;
      }
      await recoverPendingReplyTellaskCallsForDialog(dialog);
    } catch (err) {
      log.error('Failed to recover pending replyTellask* call during restart scan', err, {
        rootId: dialogId.rootId,
        selfId: dialogId.selfId,
      });
    }
  }
}
