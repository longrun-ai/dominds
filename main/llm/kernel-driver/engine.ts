import type { Dialog, DialogID } from '../../dialog';
import { driveDialogStreamCoreV2 } from '../driver-v2/core';
import { emitSayingEvents } from './events';
import { executeDriveRound } from './flow';
import { supplyResponseToSupdialog as supplyResponseToSupdialogInternal } from './subdialog';
import type {
  DriverV2CoreResult,
  DriverV2DriveArgs,
  DriverV2DriveResult,
  DriverV2EmitSayingArgs,
  DriverV2EmitSayingResult,
  DriverV2SupplyResponseArgs,
  DriverV2SupplyResponseResult,
} from './types';
import { createDriverV2RuntimeState } from './types';

export async function driveDialogStream(...driveArgs: DriverV2DriveArgs): DriverV2DriveResult {
  const runtime = createDriverV2RuntimeState();
  return await executeDriveRound({
    runtime,
    driveArgs,
    scheduleDrive: (dialog, options) => {
      void driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
    driveDialog: async (dialog, options) => {
      await driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
  });
}

export async function emitSayingEventsBridge(
  ...args: DriverV2EmitSayingArgs
): DriverV2EmitSayingResult {
  const [dlg, content] = args;
  return await emitSayingEvents(dlg, content);
}

export async function supplyResponseToSupdialog(
  ...args: DriverV2SupplyResponseArgs
): DriverV2SupplyResponseResult {
  const [parentDialog, subdialogId, responseText, callType, callId, status, calleeResponseRef] =
    args;
  return await supplyResponseToSupdialogInternal({
    parentDialog,
    subdialogId,
    responseText,
    callType,
    callId,
    status,
    calleeResponseRef,
    scheduleDrive: (dialog, options) => {
      void driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
  });
}

export async function driveDialogStreamCore(
  dlg: Dialog,
  humanPrompt?: DriverV2DriveArgs[1],
  driveOptions?: DriverV2DriveArgs[3],
  callbacks?: {
    scheduleDrive: (
      dialog: Dialog,
      options: {
        humanPrompt?: DriverV2DriveArgs[1];
        waitInQue: boolean;
        driveOptions?: DriverV2DriveArgs[3];
      },
    ) => void;
    driveDialog: (
      dialog: Dialog,
      options: {
        humanPrompt?: DriverV2DriveArgs[1];
        waitInQue: boolean;
        driveOptions?: DriverV2DriveArgs[3];
      },
    ) => Promise<void>;
  },
): Promise<DriverV2CoreResult> {
  return await driveDialogStreamCoreV2(dlg, humanPrompt, driveOptions, callbacks);
}

export async function supplyResponseToSubdialogBridge(
  parentDialog: Dialog,
  subdialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
  status?: 'completed' | 'failed',
  calleeResponseRef?: { course: number; genseq: number },
): Promise<void> {
  await supplyResponseToSupdialogInternal({
    parentDialog,
    subdialogId,
    responseText,
    callType,
    callId,
    status,
    calleeResponseRef,
    scheduleDrive: (dialog, options) => {
      void driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
    },
  });
}
