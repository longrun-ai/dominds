import type { Dialog, DialogID } from '../../dialog';
import type { LanguageCode } from '../../shared/types/language';
import type { DialogInterruptionReason, DialogRunState } from '../../shared/types/run-state';

export type KernelDriverRunControl = Readonly<{
  controlId: string;
  input: Readonly<Record<string, unknown>>;
  source: 'drive_dlg_by_user_msg' | 'drive_dialog_by_user_answer';
  q4h?: Readonly<{
    questionId: string;
    continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
  }>;
}>;

export type KernelDriverDriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
  runControl?: KernelDriverRunControl;
}>;

export type KernelDriverSubdialogReplyTarget = {
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
};

export interface KernelDriverHumanPrompt {
  content: string;
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
  q4hAnswerCallIds?: string[];
  origin?: 'user' | 'diligence_push';
  skipTaskdoc?: boolean;
  subdialogReplyTarget?: KernelDriverSubdialogReplyTarget;
  runControl?: KernelDriverRunControl;
}

export type KernelDriverDriveCallOptions = {
  humanPrompt?: KernelDriverHumanPrompt;
  waitInQue: boolean;
  driveOptions?: KernelDriverDriveOptions;
};

export type KernelDriverDriveScheduler = (
  dialog: Dialog,
  options: KernelDriverDriveCallOptions,
) => void;
export type KernelDriverDriveInvoker = (
  dialog: Dialog,
  options: KernelDriverDriveCallOptions,
) => Promise<void>;

export type KernelDriverDriveArgs = [
  dlg: Dialog,
  humanPrompt?: KernelDriverHumanPrompt,
  waitInQue?: boolean,
  driveOptions?: KernelDriverDriveOptions,
];

export type KernelDriverDriveResult = Promise<void>;

export type KernelDriverEmitSayingArgs = [dlg: Dialog, content: string];
export type KernelDriverEmitSayingResult = Promise<void>;

export type KernelDriverSupplyResponseArgs = [
  parentDialog: Dialog,
  subdialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
  status?: 'completed' | 'failed',
  calleeResponseRef?: {
    course: number;
    genseq: number;
  },
];
export type KernelDriverSupplyResponseResult = Promise<void>;

export type KernelDriverRunBackendResult = Promise<void>;

export type KernelDriverRuntimeState = {
  driveCount: number;
  totalGenIterations: number;
  usedLegacyDriveCore: boolean;
  lastRunState?: DialogRunState;
  lastInterruptionReason?: DialogInterruptionReason;
};

export type KernelDriverCoreResult = {
  lastAssistantSayingContent: string | null;
  lastAssistantSayingGenseq: number | null;
  lastFunctionCallGenseq: number | null;
};

export function createKernelDriverRuntimeState(): KernelDriverRuntimeState {
  return {
    driveCount: 0,
    totalGenIterations: 0,
    usedLegacyDriveCore: false,
  };
}
