import type {
  DomindsAppFrontendJson,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolHandler,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from './app-json';
import type { LanguageCode } from './types/language';

export type DomindsKernelEndpoint = Readonly<{
  scheme: 'http' | 'https';
  host: string;
  port: number;
}>;

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

export type DomindsAppReminderRenderedMessage = Readonly<{
  content: string;
}>;

export type DomindsAppReminderOwnerHandler = Readonly<{
  apply: (
    request: DomindsAppReminderApplyRequest,
    ctx: DomindsAppReminderOwnerApplyContext,
  ) => Promise<DomindsAppReminderApplyResult>;
  updateReminder: (
    ctx: DomindsAppReminderOwnerUpdateContext,
  ) => Promise<DomindsAppHostReminderUpdateResult>;
  // Kernel wraps rendered reminder content as an environment reminder before LLM injection.
  // Return reminder text only; do not use this hook for dialog actions.
  renderReminder: (
    ctx: DomindsAppReminderOwnerRenderContext,
  ) => Promise<DomindsAppReminderRenderedMessage>;
}>;

export type DomindsAppHostStartResult = Readonly<{
  port: number;
  baseUrl: string;
  wsUrl: string | null;
}>;

export type DomindsAppHostInstance = Readonly<{
  tools: Readonly<Record<string, DomindsAppHostToolHandler>>;
  reminderOwners?: Readonly<Record<string, DomindsAppReminderOwnerHandler>>;
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
    kernel: DomindsKernelEndpoint;
    log: (
      level: 'info' | 'warn' | 'error',
      msg: string,
      data?: Readonly<Record<string, unknown>>,
    ) => void;
  }>,
) => DomindsAppHostInstance | Promise<DomindsAppHostInstance>;
