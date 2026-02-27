import fs from 'fs';
import path from 'path';

import { Dialog, DialogID } from '../../dialog';
import { globalDialogRegistry } from '../../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../../dialog-instance-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';

type RestoreStatus = 'running' | 'completed' | 'archived';

type RestoreSummary = {
  totalMessages: number;
  totalCourses: number;
  completionStatus: 'incomplete' | 'complete' | 'failed';
};

export async function restoreDialogHierarchy(
  rootDialogId: string,
  status: RestoreStatus = 'running',
): Promise<{
  rootDialog: Dialog;
  subdialogs: Map<string, Dialog>;
  summary: RestoreSummary;
}> {
  try {
    const rootDialogIdent = new DialogID(rootDialogId);
    const rootMeta = await DialogPersistence.loadRootDialogMetadata(rootDialogIdent, status);
    if (rootMeta?.supdialogId) {
      throw new Error(
        `Expected root dialog ${rootDialogId} but found subdialog metadata with supdialogId: ${rootMeta.supdialogId}`,
      );
    }

    const rootDialog = await getOrRestoreRootDialog(rootDialogId, status);
    if (!rootDialog) {
      throw new Error(
        `Failed to restore dialog hierarchy for ${rootDialogId} from status ${status}`,
      );
    }
    globalDialogRegistry.register(rootDialog);

    const subdialogs = new Map<string, Dialog>();
    const rootPath = DialogPersistence.getRootDialogPath(rootDialogIdent, status);
    const subdialogsPath = path.join(rootPath, 'subdialogs');

    let allSubdialogIds: string[] = [];
    try {
      const entries = await fs.promises.readdir(subdialogsPath, { withFileTypes: true });
      allSubdialogIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        log.warn(
          `Failed to read subdialogs directory: ${subdialogsPath}, returning empty array`,
          err,
        );
      }
      allSubdialogIds = [];
    }

    for (const subdialogId of allSubdialogIds) {
      const restoredSubdialogId = new DialogID(subdialogId, rootDialog.id.rootId);
      const dialog = await ensureDialogLoaded(rootDialog, restoredSubdialogId, status);
      if (dialog && dialog.id.selfId !== dialog.id.rootId) {
        subdialogs.set(subdialogId, dialog);
      }
    }

    let totalMessages = rootDialog.msgs.length;
    let totalCourses = rootDialog.currentCourse;
    for (const dialog of subdialogs.values()) {
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
      rootDialog,
      subdialogs,
      summary,
    };
  } catch (error) {
    log.error(`Failed to restore dialog hierarchy for ${rootDialogId}:`, error);
    throw error;
  }
}
