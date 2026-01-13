/**
 * Module: dialog-factory
 *
 * Factory for creating Dialog instances with proper type hierarchy.
 * Provides a single point of dialog creation to ensure consistent initialization.
 */
import { Dialog, DialogID, DialogInitParams, DialogStore, RootDialog, SubDialog } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
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
    const rootDialog = new RootDialog(dlgStore, taskDocPath, id, agentId, initialState);
    globalDialogRegistry.register(rootDialog);
    return rootDialog;
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
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
    },
    initialState?: DialogInitParams['initialState'],
  ): SubDialog {
    const generatedId = generateDialogID();
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);

    return new SubDialog(
      supdialog.dlgStore,
      supdialog,
      taskDocPath,
      subdialogId,
      targetAgentId,
      {
        headLine,
        callBody,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
      },
      options.topicId,
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
