/**
 * Module: dialog-factory
 *
 * Factory for creating Dialog instances with proper type hierarchy.
 * Provides a single point of dialog creation to ensure consistent initialization.
 */
import type { CallSiteCourseNo, CallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
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
    askerDialog: Dialog,
    taskDocPath: string,
    targetAgentId: string,
    mentionList: string[] | undefined,
    tellaskContent: string,
    options: {
      callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      originMemberId: string;
      askerDialogId: string;
      callId: string;
      callSiteCourse: CallSiteCourseNo;
      callSiteGenseq: CallSiteGenseqNo;
      sessionSlug?: string;
      collectiveTargets?: string[];
      effectiveFbrEffort?: number;
    },
    initialState?: DialogInitParams['initialState'],
  ): SideDialog {
    const generatedId = generateDialogID();
    const mainDialog =
      askerDialog instanceof MainDialog
        ? askerDialog
        : askerDialog instanceof SideDialog
          ? askerDialog.mainDialog
          : (() => {
              throw new Error(
                `createSideDialog invariant violation: unsupported asker type (${askerDialog.constructor.name})`,
              );
            })();
    const sideDialogId = new DialogID(generatedId, mainDialog.id.rootId);

    return new SideDialog(
      askerDialog.dlgStore,
      mainDialog,
      taskDocPath,
      sideDialogId,
      targetAgentId,
      buildSideDialogAskerStack({
        askerDialogId: options.askerDialogId,
        assignment: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          askerDialogId: options.askerDialogId,
          callId: options.callId,
          callSiteCourse: options.callSiteCourse,
          callSiteGenseq: options.callSiteGenseq,
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
