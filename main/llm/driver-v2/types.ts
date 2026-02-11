import type { Dialog, DialogID } from '../../dialog';
import type { LanguageCode } from '../../shared/types/language';
import type { DialogInterruptionReason, DialogRunState } from '../../shared/types/run-state';

export type DriverV2DriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
}>;

export type DriverV2SubdialogReplyTarget = {
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
};

export interface DriverV2HumanPrompt {
  content: string;
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
  origin?: 'user' | 'diligence_push';
  skipTaskdoc?: boolean;
  persistMode?: 'persist' | 'internal';
  subdialogReplyTarget?: DriverV2SubdialogReplyTarget;
}

export type DriverV2DriveCallOptions = {
  humanPrompt?: DriverV2HumanPrompt;
  waitInQue: boolean;
  driveOptions?: DriverV2DriveOptions;
};

export type DriverV2DriveScheduler = (dialog: Dialog, options: DriverV2DriveCallOptions) => void;
export type DriverV2DriveInvoker = (
  dialog: Dialog,
  options: DriverV2DriveCallOptions,
) => Promise<void>;

export type DriverV2DriveArgs = [
  dlg: Dialog,
  humanPrompt?: DriverV2HumanPrompt,
  waitInQue?: boolean,
  driveOptions?: DriverV2DriveOptions,
];

export type DriverV2DriveResult = Promise<void>;

export type DriverV2EmitSayingArgs = [dlg: Dialog, content: string];
export type DriverV2EmitSayingResult = Promise<void>;

export type DriverV2SupplyResponseArgs = [
  parentDialog: Dialog,
  subdialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
  status?: 'completed' | 'failed',
];
export type DriverV2SupplyResponseResult = Promise<void>;

export type DriverV2RunBackendResult = Promise<void>;

export type DriverV2RuntimeState = {
  driveCount: number;
  totalGenIterations: number;
  usedLegacyDriveCore: boolean;
  lastRunState?: DialogRunState;
  lastInterruptionReason?: DialogInterruptionReason;
};

export type DriverV2CoreResult = {
  lastAssistantSayingContent: string | null;
  interrupted: boolean;
};

export function createDriverV2RuntimeState(): DriverV2RuntimeState {
  return {
    driveCount: 0,
    totalGenIterations: 0,
    usedLegacyDriveCore: false,
  };
}
