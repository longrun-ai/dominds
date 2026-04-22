/**
 * Module: dialog-factory
 *
 * Factory for creating Dialog instances with proper type hierarchy.
 * Provides a single point of dialog creation to ensure consistent initialization.
 */
import {
  buildSideDialogAskerStack,
  Dialog,
  DialogID,
  DialogInitParams,
  DialogStore,
  MainDialog,
  SideDialog,
} from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { generateDialogID } from './utils/id';

/**
 * Factory for creating Dialog instances.
 * Abstracts the creation of MainDialog and SideDialog with proper type hierarchy.
 */
export class DialogFactory {
  /**
   * Create a new MainDialog instance.
   */
  static createMainDialog(
    dlgStore: DialogStore,
    taskDocPath: string,
    agentId: string,
    id?: DialogID,
    initialState?: DialogInitParams['initialState'],
  ): MainDialog {
    const mainDialog = new MainDialog(dlgStore, taskDocPath, id, agentId, initialState);
    globalDialogRegistry.register(mainDialog);
    return mainDialog;
  }

  /**
   * Create a new SideDialog instance.
   */
  static createSideDialog(
    callerDialog: Dialog,
    taskDocPath: string,
    targetAgentId: string,
    mentionList: string[] | undefined,
    tellaskContent: string,
    options: {
      callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      sessionSlug?: string;
      collectiveTargets?: string[];
      effectiveFbrEffort?: number;
    },
    initialState?: DialogInitParams['initialState'],
  ): SideDialog {
    const generatedId = generateDialogID();
    const mainDialog =
      callerDialog instanceof MainDialog
        ? callerDialog
        : callerDialog instanceof SideDialog
          ? callerDialog.mainDialog
          : (() => {
              throw new Error(
                `createSideDialog invariant violation: unsupported caller dialog type (${callerDialog.constructor.name})`,
              );
            })();
    const sideDialogId = new DialogID(generatedId, mainDialog.id.rootId);

    return new SideDialog(
      callerDialog.dlgStore,
      mainDialog,
      taskDocPath,
      sideDialogId,
      targetAgentId,
      buildSideDialogAskerStack({
        askerDialogId: options.callerDialogId,
        assignment: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          callerDialogId: options.callerDialogId,
          callId: options.callId,
          collectiveTargets: options.collectiveTargets,
          effectiveFbrEffort: options.effectiveFbrEffort,
        },
      }),
      options.sessionSlug,
      initialState,
    );
  }

  /**
   * Check if a dialog is a MainDialog.
   */
  static isMainDialog(dialog: Dialog): dialog is MainDialog {
    return dialog instanceof MainDialog;
  }

  /**
   * Check if a dialog is a SideDialog.
   */
  static isSideDialog(dialog: Dialog): dialog is SideDialog {
    return dialog instanceof SideDialog;
  }
}
