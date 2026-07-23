import type { LanguageCode } from './language';
import type {
  DialogCalleeReplyTarget,
  FuncResultContentItem,
  TellaskReplyDirective,
} from './storage';
export type { DialogCalleeReplyTarget } from './storage';

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
    calleeDialogReplyTarget?: undefined;
  }>;

export type DialogDiligencePrompt = DialogPromptBase &
  Readonly<{
    origin: 'diligence_push';
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective?: undefined;
    skipTaskdoc?: undefined;
    calleeDialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeGuidePrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective?: undefined;
    calleeDialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeReplyPrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective: TellaskReplyDirective;
    calleeDialogReplyTarget?: undefined;
  }>;

export type DialogRuntimeSideDialogPrompt = DialogRuntimePromptCommon &
  Readonly<{
    q4hAnswerCallId?: undefined;
    tellaskReplyDirective: TellaskReplyDirective;
    calleeDialogReplyTarget: DialogCalleeReplyTarget;
  }>;

export type DialogRuntimePrompt =
  | DialogRuntimeGuidePrompt
  | DialogRuntimeReplyPrompt
  | DialogRuntimeSideDialogPrompt;

export type DialogPrompt = DialogUserPrompt | DialogDiligencePrompt | DialogRuntimePrompt;

type DialogQueuedPromptStateCommon = Readonly<{
  prompt: string;
  contentItems?: FuncResultContentItem[];
  msgId: string;
  grammar?: 'markdown';
  userLanguageCode?: LanguageCode;
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
    tellaskReplyDirective: DialogRuntimeSideDialogPrompt['tellaskReplyDirective'];
    skipTaskdoc?: boolean;
    calleeDialogReplyTarget: DialogRuntimeSideDialogPrompt['calleeDialogReplyTarget'];
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

export type DialogQueuedNewCourseRuntimeSideDialogState = DialogQueuedPromptStateCommon &
  Readonly<{
    kind: 'new_course_runtime_sideDialog';
    origin: 'runtime';
    tellaskReplyDirective: DialogRuntimeSideDialogPrompt['tellaskReplyDirective'];
    skipTaskdoc?: boolean;
    calleeDialogReplyTarget: DialogRuntimeSideDialogPrompt['calleeDialogReplyTarget'];
  }>;

export type DialogQueuedPromptState =
  | DialogQueuedUserGenerationBoundaryState
  | DialogQueuedDeferredQ4HAnswerState
  | DialogQueuedRegisteredAssignmentUpdateState
  | DialogQueuedNewCourseRuntimeGuideState
  | DialogQueuedNewCourseRuntimeReplyState
  | DialogQueuedNewCourseRuntimeSideDialogState;

export type DriveIntent =
  | Readonly<{
      kind: 'prompt';
      prompt: DialogPrompt;
    }>
  | Readonly<{
      kind: 'new_course';
      prompt: DialogRuntimePrompt;
      reason?: string;
    }>;
