import type { LanguageCode } from './language';
import type { TellaskReplyDirective } from './storage';

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

export type DialogSubdialogReplyTarget = Readonly<{
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
}>;

export type DialogPrompt = Readonly<{
  content: string;
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
  origin: 'user' | 'diligence_push' | 'runtime';
  // When present, this prompt is only continuation glue for an already-persisted askHuman answer.
  q4hAnswerCallId?: string;
  tellaskReplyDirective?: TellaskReplyDirective;
  skipTaskdoc?: boolean;
  subdialogReplyTarget?: DialogSubdialogReplyTarget;
}>;

export type DriveIntent =
  | Readonly<{
      kind: 'prompt';
      prompt: DialogPrompt;
      runControl?: DialogRunControlSpec;
    }>
  | Readonly<{
      kind: 'new_course';
      prompt: DialogPrompt;
      reason?: string;
      runControl?: DialogRunControlSpec;
    }>;
