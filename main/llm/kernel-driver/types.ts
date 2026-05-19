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
import type {
  CallSiteCourseNo,
  CallSiteGenseqNo,
  DialogBusinessContinuation,
} from '@longrun-ai/kernel/types/storage';
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
  | 'kernel_driver_supply_response_caller_revive'
  | 'kernel_driver_idle_reminder_wake';

export type KernelDriverDriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
  resumeInProgressGeneration?: boolean;
  /**
   * Business continuation identity for no-prompt driver iterations.
   *
   * This is deliberately part of the drive contract instead of being rediscovered from old
   * transcript/assignment records. A continuation must tell the next iteration what business
   * obligation it is continuing, or the driver treats it as no business continuation.
   *
   * Keep continuation decisions local to the concrete business handler. Do not add generic
   * "already consumed", fingerprint, or catch-all can-drive logic here; this type is a routing
   * contract, not a place to merge unrelated continuation semantics.
   */
  businessContinuation?: DialogBusinessContinuation;
  runControl?: KernelDriverRunControl;
  source: KernelDriverDriveSource;
  reason: string;
}>;

export type KernelDriverCalleeReplyTarget = {
  callerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
  callSiteCourse: CallSiteCourseNo;
  callSiteGenseq: CallSiteGenseqNo;
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
) => Promise<KernelDriverCoreResult | void>;
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

export type KernelDriverDriveResult = Promise<KernelDriverCoreResult | void>;

export type KernelDriverEmitSayingArgs = [dlg: Dialog, content: string];
export type KernelDriverEmitSayingResult = Promise<void>;

export type KernelDriverSupplyResponseArgs = [
  callerDialog: Dialog,
  sideDialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
  status?: 'completed' | 'failed',
  calleeResponseRef?: {
    course: number;
    genseq: number;
  },
  directFallbackSource?: 'saying' | 'thinking_only',
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
  lastAssistantThinkingContent: string | null;
  lastAssistantThinkingGenseq: number | null;
  lastFunctionCallGenseq: number | null;
  lastAssistantReplyTarget?: KernelDriverCalleeReplyTarget;
  lastBusinessContinuation: DialogBusinessContinuation;
  fbrConclusion?: {
    responseText: string;
    responseGenseq: number;
    replyResolutionCallId: string;
  };
};

export function createKernelDriverRuntimeState(): KernelDriverRuntimeState {
  return {
    driveCount: 0,
    totalGenIterations: 0,
    usedLegacyDriveCore: false,
  };
}
