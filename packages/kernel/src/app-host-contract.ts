import type {
  DomindsAppFrontendJson,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolHandler,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from './app-json';
import type { ChatMessage } from './types/chat-message';
import type { LanguageCode } from './types/language';

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

export type DomindsAppRunControlMemberRef = Readonly<{
  memberId: string;
  roleIds?: readonly string[];
}>;

export type DomindsAppRunControlOwnerRef =
  | Readonly<{ kind: 'human' }>
  | Readonly<{
      kind: 'member';
      memberId: string;
      roleIds?: readonly string[];
    }>;

export type DomindsAppRunControlTargetRef = Readonly<{
  kind: 'taskdoc' | 'phase' | 'gate' | 'change' | 'role' | 'member';
  id: string;
  title?: string;
}>;

export type DomindsAppRunControlAwaitMembersBlock = Readonly<{
  blockKind: 'await_members';
  owner: DomindsAppRunControlOwnerRef;
  targetRef: DomindsAppRunControlTargetRef;
  title: string;
  promptSummary: string;
  waitingFor: readonly DomindsAppRunControlMemberRef[];
}>;

export type DomindsAppRunControlAwaitHumanBlock = Readonly<{
  blockKind: 'await_human';
  owner: DomindsAppRunControlOwnerRef;
  targetRef: DomindsAppRunControlTargetRef;
  title: string;
  promptSummary: string;
  question?: string;
  optionsSummary?: readonly string[];
}>;

export type DomindsAppRunControlActionClass = 'input' | 'select' | 'confirm';

export type DomindsAppRunControlAwaitAppActionBlock = Readonly<{
  blockKind: 'await_app_action';
  actionClass: DomindsAppRunControlActionClass;
  actionId: string;
  owner: DomindsAppRunControlOwnerRef;
  resolutionMode: 'explicit_continue' | 'auto_resume';
  targetRef: DomindsAppRunControlTargetRef;
  title: string;
  promptSummary: string;
  optionsSummary?: readonly string[];
}>;

export type DomindsAppRunControlBlock =
  | DomindsAppRunControlAwaitMembersBlock
  | DomindsAppRunControlAwaitHumanBlock
  | DomindsAppRunControlAwaitAppActionBlock;

export type DomindsAppRunControlRecoveryAction = Readonly<{
  actionId: 'continue';
  promptSummary: string;
}>;

export type DomindsAppRunControlResult =
  | Readonly<{
      kind: 'allow';
      recoveryAction?: DomindsAppRunControlRecoveryAction;
    }>
  | Readonly<{ kind: 'reject'; errorText: string }>
  | Readonly<{
      kind: 'block';
      block: DomindsAppRunControlBlock;
    }>;
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
  reminderId: string;
  workLanguage: LanguageCode;
}>;

export type DomindsAppDynamicToolsetsContext = Readonly<{
  memberId: string;
  taskDocPath: string;
  dialogId?: string;
  mainDialogId?: string;
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
  // Apps extend Dominds by registering callbacks at explicit kernel control points.
  // These callbacks are authoritative only for their own control point semantics; they do not
  // mutate MCP registry/lease state or other kernel protocols by side effect.
  tools: Readonly<Record<string, DomindsAppHostToolHandler>>;
  runControls?: Readonly<Record<string, DomindsAppRunControlHandler>>;
  reminderOwners?: Readonly<Record<string, DomindsAppReminderOwnerHandler>>;
  // Tool availability is an app control point. The callback returns app-specific dynamic toolset
  // decisions for a concrete context; it is not an app-owned global registry.
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
