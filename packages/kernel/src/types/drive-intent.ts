import type { LanguageCode } from './language';
import type {
  DialogSubdialogReplyTarget,
  FuncResultContentItem,
  TellaskReplyDirective,
} from './storage';
export type { DialogSubdialogReplyTarget } from './storage';

export type DialogRunControlSource =
  | 'drive_dlg_by_user_msg'
  | 'drive_dialog_by_user_answer'
  | 'start_new_course';

export type DialogRunControlSpec = Readonly<{
  controlId: string;
  input: Readonly<Record<string, unknown>>;
  source: DialogRunControlSource;
  q4h?: Readonly<{
    questionId: string;
    continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
  }>;
}>;

type DialogPromptBase = Readonly<{
  content: string;
  contentItems?: FuncResultContentItem[];
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
}>;

type DialogUserPromptCommon = DialogPromptBase &
  Readonly<{
    origin: 'user';
    // When present, this prompt is only continuation glue for an already-persisted askHuman answer.
    q4hAnswerCallId?: string;
  }>;

type DialogRuntimePromptCommon = DialogPromptBase &
  Readonly<{
    origin: 'runtime';
    skipTaskdoc?: boolean;
  }>;

export type DialogUserPrompt = DialogUserPromptCommon &
  Readonly<{
    tellaskReplyDirective?: undefined;
    skipTaskdoc?: undefined;
    subdialogReplyTarget?: undefined;
  }>;

export type DialogDiligencePrompt = DialogPromptBase &
  Readonly<{
    origin: 'diligence_push';
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective?: undefined;
    skipTaskdoc?: undefined;
    subdialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeGuidePrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective?: undefined;
    subdialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeReplyPrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective: TellaskReplyDirective;
    subdialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeSubdialogPrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective: TellaskReplyDirective;
    subdialogReplyTarget: DialogSubdialogReplyTarget;
  }>;

export type DialogRuntimePrompt =
  | DialogRuntimeGuidePrompt
  | DialogRuntimeReplyPrompt
  | DialogRuntimeSubdialogPrompt;

export type DialogPrompt = DialogUserPrompt | DialogDiligencePrompt | DialogRuntimePrompt;

type DialogQueuedPromptStateCommon = Readonly<{
  prompt: string;
  contentItems?: FuncResultContentItem[];
  msgId: string;
  grammar?: 'markdown';
  userLanguageCode?: LanguageCode;
  runControl?: DialogRunControlSpec;
}>;

export type DialogQueuedUserGenerationBoundaryState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'user_generation_boundary';
    origin: 'user';
    q4hAnswerCallId?: string;
  }>;

export type DialogQueuedDeferredQ4HAnswerState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'deferred_q4h_answer';
    origin: 'user';
    q4hAnswerCallId?: string;
  }>;

export type DialogQueuedRegisteredAssignmentUpdateState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'registered_assignment_update';
    origin: 'runtime';
    tellaskReplyDirective: DialogRuntimeSubdialogPrompt['tellaskReplyDirective'];
    skipTaskdoc?: boolean;
    subdialogReplyTarget: DialogRuntimeSubdialogPrompt['subdialogReplyTarget'];
  }>;

export type DialogQueuedNewCourseRuntimeGuideState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'new_course_runtime_guide';
    origin: 'runtime';
    skipTaskdoc?: boolean;
  }>;

export type DialogQueuedNewCourseRuntimeReplyState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'new_course_runtime_reply';
    origin: 'runtime';
    tellaskReplyDirective: DialogRuntimeReplyPrompt['tellaskReplyDirective'];
    skipTaskdoc?: boolean;
  }>;

export type DialogQueuedNewCourseRuntimeSubdialogState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'new_course_runtime_subdialog';
    origin: 'runtime';
    tellaskReplyDirective: DialogRuntimeSubdialogPrompt['tellaskReplyDirective'];
    skipTaskdoc?: boolean;
    subdialogReplyTarget: DialogRuntimeSubdialogPrompt['subdialogReplyTarget'];
  }>;

export type DialogQueuedPromptState =
  | DialogQueuedUserGenerationBoundaryState
  | DialogQueuedDeferredQ4HAnswerState
  | DialogQueuedRegisteredAssignmentUpdateState
  | DialogQueuedNewCourseRuntimeGuideState
  | DialogQueuedNewCourseRuntimeReplyState
  | DialogQueuedNewCourseRuntimeSubdialogState;

export type DriveIntent =
  | Readonly<{
      kind: 'prompt';
      prompt: DialogPrompt;
      runControl?: DialogRunControlSpec;
    }>
  | Readonly<{
      kind: 'new_course';
      prompt: DialogRuntimePrompt;
      reason?: string;
      runControl?: DialogRunControlSpec;
    }>;
