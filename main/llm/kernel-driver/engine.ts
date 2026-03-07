import type { Dialog, DialogID } from '../../dialog';
import { driveDialogStreamCore as driveDialogStreamCoreInternal } from './drive';
import { emitSayingEvents } from './events';
import { executeDriveRound } from './flow';
import { supplyResponseToSupdialog as supplyResponseToSupdialogInternal } from './subdialog';
import type {
  KernelDriverCoreResult,
  KernelDriverDriveArgs,
  KernelDriverDriveCallOptions,
  KernelDriverDriveResult,
  KernelDriverEmitSayingArgs,
  KernelDriverEmitSayingResult,
  KernelDriverSupplyResponseArgs,
  KernelDriverSupplyResponseResult,
} from './types';
import { createKernelDriverRuntimeState } from './types';

function dispatchDrive(dialog: Dialog, options: KernelDriverDriveCallOptions): Promise<void> {
  if (options.humanPrompt) {
    return driveDialogStream(dialog, options.humanPrompt, options.waitInQue, options.driveOptions);
  }
  return driveDialogStream(dialog, undefined, options.waitInQue, options.driveOptions);
}

export async function driveDialogStream(
  ...driveArgs: KernelDriverDriveArgs
): KernelDriverDriveResult {
  const runtime = createKernelDriverRuntimeState();
  return await executeDriveRound({
    runtime,
    driveArgs,
    scheduleDrive: (dialog, options) => {
      void dispatchDrive(dialog, options);
    },
    driveDialog: async (dialog, options) => {
      await dispatchDrive(dialog, options);
    },
  });
}

export async function emitSayingEventsBridge(
  ...args: KernelDriverEmitSayingArgs
): KernelDriverEmitSayingResult {
  const [dlg, content] = args;
  return await emitSayingEvents(dlg, content);
}

export async function supplyResponseToSupdialog(
  ...args: KernelDriverSupplyResponseArgs
): KernelDriverSupplyResponseResult {
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
      void dispatchDrive(dialog, options);
    },
  });
}

export async function driveDialogStreamCore(
  dlg: Dialog,
  humanPrompt?: KernelDriverDriveArgs[1],
  driveOptions?: KernelDriverDriveArgs[3],
  callbacks?: {
    scheduleDrive: (dialog: Dialog, options: KernelDriverDriveCallOptions) => void;
    driveDialog: (dialog: Dialog, options: KernelDriverDriveCallOptions) => Promise<void>;
  },
): Promise<KernelDriverCoreResult> {
  return await driveDialogStreamCoreInternal(dlg, humanPrompt, driveOptions, callbacks);
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
      void dispatchDrive(dialog, options);
    },
  });
}
