import type { DomindsAppFrontendJson, DomindsAppHostToolHandler } from '../apps/app-json';
import type { LanguageCode } from '../shared/types/language';

export type DomindsAppRunControlContext = Readonly<{
  dialog: Readonly<{
    selfId: string;
    rootId: string;
  }>;
  prompt: Readonly<{
    content: string;
    msgId: string;
    grammar: 'markdown';
    userLanguageCode: LanguageCode;
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
      prompt?: Readonly<{
        content?: string;
        msgId?: string;
        grammar?: 'markdown';
        userLanguageCode?: LanguageCode;
      }>;
    }
  | { kind: 'reject'; errorText: string }
>;

export type DomindsAppRunControlHandler = (
  ctx: DomindsAppRunControlContext,
) => Promise<DomindsAppRunControlResult>;

export type DomindsAppHostStartResult = Readonly<{
  port: number;
  baseUrl: string;
  wsUrl: string | null;
}>;

export type DomindsAppHostInstance = Readonly<{
  tools: Readonly<Record<string, DomindsAppHostToolHandler>>;
  runControls?: Readonly<Record<string, DomindsAppRunControlHandler>>;
  start?: (
    params: Readonly<{ runtimePort: number | null; frontend?: DomindsAppFrontendJson }>,
  ) => Promise<DomindsAppHostStartResult>;
  shutdown?: () => Promise<void>;
}>;

export type CreateDomindsAppHostFn = (
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
