import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import type {
  DialogDiligencePrompt,
  DialogPrompt,
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
  | 'kernel_driver_business_continuation'
  | 'kernel_driver_idle_reminder_wake';

export type KernelDriverDriveOptions = Readonly<{
  suppressDiligencePush?: boolean;
  allowResumeFromInterrupted?: boolean;
  resumeInProgressGeneration?: boolean;
  /**
   * Business continuation identity for continuation-driven driver iterations.
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

export type KernelDriverUserPrompt = DialogUserPrompt;
export type KernelDriverDiligencePrompt = DialogDiligencePrompt;
export type KernelDriverRuntimeGuidePrompt = DialogRuntimeGuidePrompt;
export type KernelDriverRuntimeReplyPrompt = DialogRuntimeReplyPrompt;
export type KernelDriverRuntimeSideDialogPrompt = DialogRuntimeSideDialogPrompt;
export type KernelDriverRuntimePrompt = DialogRuntimePrompt;
export type KernelDriverPrompt = DialogPrompt;

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
  callId: string,
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
  lastDisplayState?: DialogDisplayState;
  lastInterruptionReason?: DialogInterruptionReason;
};

export type KernelDriverCoreResult = {
  lastAssistantSayingContent: string | null;
  lastAssistantSayingGenseq: number | null;
  lastAssistantThinkingContent: string | null;
  lastAssistantThinkingGenseq: number | null;
  lastAssistantAnsweringContent: string | null;
  lastAssistantAnsweringGenseq: number | null;
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
  };
}
