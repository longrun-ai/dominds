import fs from 'fs';
import path from 'path';

import { Dialog, DialogID } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../dialog-instance-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';

type RestoreStatus = 'running' | 'completed' | 'archived';

type RestoreSummary = {
  totalMessages: number;
  totalCourses: number;
  completionStatus: 'incomplete' | 'complete' | 'failed';
};

export async function restoreDialogHierarchy(
  mainDialogId: string,
  status: RestoreStatus = 'running',
): Promise<{
  mainDialog: Dialog;
  sideDialogs: Map<string, Dialog>;
  summary: RestoreSummary;
}> {
  try {
    const mainDialogIdent = new DialogID(mainDialogId);
    const rootMeta = await DialogPersistence.loadMainDialogMetadata(mainDialogIdent, status);
    if (rootMeta?.askerDialogId) {
      throw new Error(
        `Expected root dialog ${mainDialogId} but found sideDialog metadata with askerDialogId: ${rootMeta.askerDialogId}`,
      );
    }

    const mainDialog = await getOrRestoreMainDialog(mainDialogId, status);
    if (!mainDialog) {
      throw new Error(
        `Failed to restore dialog hierarchy for ${mainDialogId} from status ${status}`,
      );
    }
    globalDialogRegistry.register(mainDialog);

    const sideDialogs = new Map<string, Dialog>();
    const rootPath = DialogPersistence.getMainDialogPath(mainDialogIdent, status);
    const sideDialogsPath = path.join(rootPath, 'sideDialogs');

    let allSideDialogIds: string[] = [];
    try {
      const entries = await fs.promises.readdir(sideDialogsPath, { withFileTypes: true });
      allSideDialogIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        log.warn(
          `Failed to read sideDialogs directory: ${sideDialogsPath}, returning empty array`,
          err,
        );
      }
      allSideDialogIds = [];
    }

    for (const sideDialogId of allSideDialogIds) {
      const restoredSideDialogId = new DialogID(sideDialogId, mainDialog.id.rootId);
      const dialog = await ensureDialogLoaded(mainDialog, restoredSideDialogId, status);
      if (dialog && dialog.id.selfId !== dialog.id.rootId) {
        sideDialogs.set(sideDialogId, dialog);
      }
    }

    let totalMessages = mainDialog.msgs.length;
    let totalCourses = mainDialog.currentCourse;
    for (const dialog of sideDialogs.values()) {
      totalMessages += dialog.msgs.length;
      if (dialog.currentCourse > totalCourses) {
        totalCourses = dialog.currentCourse;
      }
    }

    const summary: RestoreSummary = {
      totalMessages,
      totalCourses,
      completionStatus: 'incomplete',
    };

    return {
      mainDialog,
      sideDialogs,
      summary,
    };
  } catch (error) {
    log.error(`Failed to restore dialog hierarchy for ${mainDialogId}:`, error);
    throw error;
  }
}
