import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import type { Dialog, DialogID } from '../../dialog';

export type KernelDriverRunControl = Readonly<{
  controlId: string;
  input: Readonly<Record<string, unknown>>;
  source: 'drive_dlg_by_user_msg' | 'drive_dialog_by_user_answer';
  q4h?: Readonly<{
    questionId: string;
    continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
  }>;
}>;

export type KernelDriverDriveSource =
  | 'unspecified'
  | 'ws_user_message'
  | 'ws_user_answer'
  | 'ws_diligence_push'
  | 'ws_resume_dialog'
  | 'ws_resume_all'
  | 'kernel_driver_backend_loop'
  | 'kernel_driver_follow_up'
  | 'kernel_driver_subdialog_init'
  | 'kernel_driver_subdialog_resume'
  | 'kernel_driver_fbr_subdialog_round'
  | 'kernel_driver_type_a_supdialog_call'
  | 'kernel_driver_supply_response_parent_revive';

export type KernelDriverDriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
  resolvedPendingTellaskReply?: Readonly<{
    ownerDialogId: string;
    subdialogId: string;
    callType: 'A' | 'B' | 'C';
    callId: string;
  }>;
  runControl?: KernelDriverRunControl;
  source: KernelDriverDriveSource;
  reason: string;
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
  tellaskReplyDirective?: TellaskReplyDirective;
  origin: 'user' | 'diligence_push' | 'runtime';
  skipTaskdoc?: boolean;
  subdialogReplyTarget?: KernelDriverSubdialogReplyTarget;
  runControl?: KernelDriverRunControl;
}

export type KernelDriverDriveCallOptions =
  | Readonly<{
      humanPrompt: KernelDriverHumanPrompt;
      waitInQue: boolean;
      driveOptions?: KernelDriverDriveOptions;
    }>
  | Readonly<{
      humanPrompt?: undefined;
      waitInQue: boolean;
      driveOptions: KernelDriverDriveOptions;
    }>;

export type KernelDriverDriveScheduler = (
  dialog: Dialog,
  options: KernelDriverDriveCallOptions,
) => void;
export type KernelDriverDriveInvoker = (
  dialog: Dialog,
  options: KernelDriverDriveCallOptions,
) => Promise<void>;
export type KernelDriverDriveCallbacks = Readonly<{
  scheduleDrive: KernelDriverDriveScheduler;
  driveDialog: KernelDriverDriveInvoker;
}>;

export type KernelDriverDriveArgs =
  | readonly [
      dlg: Dialog,
      humanPrompt: KernelDriverHumanPrompt,
      waitInQue: boolean,
      driveOptions?: KernelDriverDriveOptions,
    ]
  | readonly [
      dlg: Dialog,
      humanPrompt: undefined,
      waitInQue: boolean,
      driveOptions: KernelDriverDriveOptions,
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
  lastDisplayState?: DialogDisplayState;
  lastInterruptionReason?: DialogInterruptionReason;
};

export type KernelDriverCoreResult = {
  lastAssistantSayingContent: string | null;
  lastAssistantSayingGenseq: number | null;
  lastFunctionCallGenseq: number | null;
  lastAssistantReplyTarget?: KernelDriverSubdialogReplyTarget;
  fbrConclusion?: {
    responseText: string;
    responseGenseq: number;
  };
};

export function createKernelDriverRuntimeState(): KernelDriverRuntimeState {
  return {
    driveCount: 0,
    totalGenIterations: 0,
    usedLegacyDriveCore: false,
  };
}
