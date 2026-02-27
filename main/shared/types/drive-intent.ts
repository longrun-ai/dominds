import type { LanguageCode } from './language';

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

export type DialogPrompt = Readonly<{
  content: string;
  msgId: string;
  grammar: 'markdown';
  userLanguageCode?: LanguageCode;
  origin?: 'user' | 'diligence_push';
  q4hAnswerCallIds?: string[];
  skipTaskdoc?: boolean;
  subdialogReplyTarget?: DialogSubdialogReplyTarget;
}>;

export type DialogSubdialogReplyTarget = Readonly<{
  ownerDialogId: string;
  callType: 'A' | 'B' | 'C';
  callId: string;
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
