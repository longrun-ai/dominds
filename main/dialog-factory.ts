/**
 * Module: dialog-factory
 *
 * Factory for creating Dialog instances with proper type hierarchy.
 * Provides a single point of dialog creation to ensure consistent initialization.
 */
import { Dialog, DialogID, DialogInitParams, DialogStore, RootDialog, SubDialog } from './dialog';
import { generateDialogID } from './utils/id';

/**
 * Factory for creating Dialog instances.
 * Abstracts the creation of RootDialog and SubDialog with proper type hierarchy.
 */
export class DialogFactory {
  /**
   * Create a new RootDialog instance.
   */
  static createRootDialog(
    dlgStore: DialogStore,
    taskDocPath: string,
    agentId: string,
    id?: DialogID,
    initialState?: DialogInitParams['initialState'],
  ): RootDialog {
    return new RootDialog(dlgStore, taskDocPath, id, agentId, initialState);
  }

  /**
   * Create a new SubDialog instance.
   */
  static createSubDialog(
    supdialog: RootDialog,
    taskDocPath: string,
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string },
    initialState?: DialogInitParams['initialState'],
  ): SubDialog {
    const generatedId = generateDialogID();
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);

    return new SubDialog(
      supdialog,
      taskDocPath,
      subdialogId,
      targetAgentId,
      {
        headLine,
        callBody,
        originRole: options?.originRole ?? 'assistant',
        originMemberId: options?.originMemberId,
      },
      initialState,
    );
  }

  /**
   * Check if a dialog is a RootDialog.
   */
  static isRootDialog(dialog: Dialog): dialog is RootDialog {
    return dialog instanceof RootDialog;
  }

  /**
   * Check if a dialog is a SubDialog.
   */
  static isSubDialog(dialog: Dialog): dialog is SubDialog {
    return dialog instanceof SubDialog;
  }
}
