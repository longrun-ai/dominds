import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import type {
  DialogDiligencePrompt,
  DialogPrompt,
  DialogRunControlSpec,
  DialogRuntimeGuidePrompt,
  DialogRuntimePrompt,
  DialogRuntimeReplyPrompt,
  DialogRuntimeSideDialogPrompt,
  DialogUserPrompt,
} from '@longrun-ai/kernel/types/drive-intent';
import type { Dialog, DialogID } from '../../dialog';

export type KernelDriverRunControl = DialogRunControlSpec;

export type KernelDriverDriveSource =
  | 'unspecified'
  | 'ws_user_message'
  | 'ws_user_answer'
  | 'ws_diligence_push'
  | 'ws_resume_dialog'
  | 'ws_resume_all'
  | 'kernel_driver_backend_loop'
  | 'kernel_driver_follow_up'
  | 'kernel_driver_sideDialog_init'
  | 'kernel_driver_sideDialog_resume'
  | 'kernel_driver_fbr_sideDialog_round'
  | 'kernel_driver_type_a_askerDialog_call'
  | 'kernel_driver_supply_response_parent_revive'
  | 'kernel_driver_idle_reminder_wake';

export type KernelDriverDriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
  noPromptSideDialogResumeEntitlement?:
    | Readonly<{
        ownerDialogId: string;
        reason: 'reply_tellask_back_delivered';
        sideDialogId?: string;
        callType?: 'A' | 'B' | 'C';
        callId?: string;
      }>
    | Readonly<{
        ownerDialogId: string;
        reason: 'replaced_pending_sideDialog_reply';
        sideDialogId?: string;
        callType?: 'A' | 'B' | 'C';
        callId?: string;
      }>
    | Readonly<{
        ownerDialogId: string;
        reason: 'resolved_pending_sideDialog_reply';
        sideDialogId?: string;
        callType?: 'A' | 'B' | 'C';
        callId?: string;
        callSiteCourse: number;
        callSiteGenseq: number;
        resolvedCallIds?: readonly string[];
        triggerCallId?: string;
      }>;
  runControl?: KernelDriverRunControl;
  source: KernelDriverDriveSource;
  reason: string;
}>;

export type KernelDriverSideDialogReplyTarget = {
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
};

type KernelDriverPromptWithRunControl<TPrompt extends DialogPrompt> = TPrompt & {
  runControl?: KernelDriverRunControl;
};

export type KernelDriverUserPrompt = KernelDriverPromptWithRunControl<DialogUserPrompt>;
export type KernelDriverDiligencePrompt = KernelDriverPromptWithRunControl<DialogDiligencePrompt>;
export type KernelDriverRuntimeGuidePrompt =
  KernelDriverPromptWithRunControl<DialogRuntimeGuidePrompt>;
export type KernelDriverRuntimeReplyPrompt =
  KernelDriverPromptWithRunControl<DialogRuntimeReplyPrompt>;
export type KernelDriverRuntimeSideDialogPrompt =
  KernelDriverPromptWithRunControl<DialogRuntimeSideDialogPrompt>;
export type KernelDriverRuntimePrompt = KernelDriverPromptWithRunControl<DialogRuntimePrompt>;
export type KernelDriverPrompt = KernelDriverPromptWithRunControl<DialogPrompt>;

export type KernelDriverDriveCallOptions =
  | Readonly<{
      humanPrompt: KernelDriverPrompt;
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
      humanPrompt: KernelDriverPrompt,
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
  sideDialogId: DialogID,
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
  lastAssistantReplyTarget?: KernelDriverSideDialogReplyTarget;
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
