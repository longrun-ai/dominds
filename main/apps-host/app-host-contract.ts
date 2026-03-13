import type {
  DomindsAppFrontendJson,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolHandler,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from '../apps/app-json';
import type { ChatMessage } from '../llm/client';
import type { LanguageCode } from '../shared/types/language';

export type DomindsAppRunControlContext = Readonly<{
  dialog: Readonly<{
    selfId: string;
    rootId: string;
  }>;
  agentId: string;
  taskDocPath: string;
  genIterNo: number;
  prompt?: Readonly<{
    content: string;
    msgId: string;
    grammar: 'markdown';
    userLanguageCode: LanguageCode;
    origin?: 'user' | 'diligence_push' | 'runtime';
  }>;
  source: 'drive_dlg_by_user_msg' | 'drive_dialog_by_user_answer';
  input: Readonly<Record<string, unknown>>;
  q4h?: Readonly<{
    questionId: string;
    continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
  }>;
}>;

export type DomindsAppRunControlResult = Readonly<
  | {
      kind: 'continue';
    }
  | { kind: 'reject'; errorText: string }
>;

export type DomindsAppRunControlHandler = (
  ctx: DomindsAppRunControlContext,
) => Promise<DomindsAppRunControlResult>;

export type DomindsAppReminderOwnerApplyContext = Readonly<{
  dialogId: string;
  ownedReminders: ReadonlyArray<DomindsAppReminderState>;
}>;

export type DomindsAppReminderOwnerUpdateContext = Readonly<{
  dialogId: string;
  reminder: DomindsAppReminderState;
}>;

export type DomindsAppReminderOwnerRenderContext = Readonly<{
  dialogId: string;
  reminder: DomindsAppReminderState;
  reminderNo: number;
  workLanguage: LanguageCode;
}>;

export type DomindsAppDynamicToolsetsContext = Readonly<{
  memberId: string;
  taskDocPath: string;
  dialogId?: string;
  rootDialogId?: string;
  agentId?: string;
  sessionSlug?: string;
}>;

export type DomindsAppReminderOwnerHandler = Readonly<{
  apply: (
    request: DomindsAppReminderApplyRequest,
    ctx: DomindsAppReminderOwnerApplyContext,
  ) => Promise<DomindsAppReminderApplyResult>;
  updateReminder: (
    ctx: DomindsAppReminderOwnerUpdateContext,
  ) => Promise<DomindsAppHostReminderUpdateResult>;
  renderReminder: (ctx: DomindsAppReminderOwnerRenderContext) => Promise<ChatMessage>;
}>;

export type DomindsAppDynamicToolsetsHandler = (
  ctx: DomindsAppDynamicToolsetsContext,
) => Promise<readonly string[]>;

export type DomindsAppHostStartResult = Readonly<{
  port: number;
  baseUrl: string;
  wsUrl: string | null;
}>;

export type DomindsAppHostInstance = Readonly<{
  tools: Readonly<Record<string, DomindsAppHostToolHandler>>;
  runControls?: Readonly<Record<string, DomindsAppRunControlHandler>>;
  reminderOwners?: Readonly<Record<string, DomindsAppReminderOwnerHandler>>;
  dynamicToolsets?: DomindsAppDynamicToolsetsHandler;
  start?: (
    params: Readonly<{ runtimePort: number | null; frontend?: DomindsAppFrontendJson }>,
  ) => Promise<DomindsAppHostStartResult>;
  shutdown?: () => Promise<void>;
}>;

export type CreateDomindsAppFn = (
  ctx: Readonly<{
    appId: string;
    rtwsRootAbs: string;
    rtwsAppDirAbs: string;
    packageRootAbs: string;
    kernel: Readonly<{ host: string; port: number }>;
    log: (
      level: 'info' | 'warn' | 'error',
      msg: string,
      data?: Readonly<Record<string, unknown>>,
    ) => void;
  }>,
) => DomindsAppHostInstance | Promise<DomindsAppHostInstance>;
