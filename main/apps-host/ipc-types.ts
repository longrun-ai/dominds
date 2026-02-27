import type { DomindsAppInstallJsonV1 } from '../apps/app-json';
import type { LanguageCode } from '../shared/types/language';
import type { ToolArguments, ToolCallOutput } from '../tool';

export type AppsHostKernelInitMessage = Readonly<{
  type: 'init';
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
  apps: ReadonlyArray<
    Readonly<{
      appId: string;
      runtimePort: number | null;
      installJson: DomindsAppInstallJsonV1;
    }>
  >;
}>;

export type AppsHostKernelToolCallMessage = Readonly<{
  type: 'tool_call';
  callId: string;
  toolName: string;
  args: ToolArguments;
  ctx: Readonly<{
    dialogId: string;
    callerId: string;
  }>;
}>;

export type AppsHostKernelRunControlApplyMessage = Readonly<{
  type: 'run_control_apply';
  callId: string;
  controlId: string;
  payload: Readonly<{
    dialog: Readonly<{
      selfId: string;
      rootId: string;
    }>;
    genIterNo: number;
    prompt?: Readonly<{
      content: string;
      msgId: string;
      grammar: 'markdown';
      userLanguageCode: LanguageCode;
      origin?: 'user' | 'diligence_push';
    }>;
    source: 'drive_dlg_by_user_msg' | 'drive_dialog_by_user_answer';
    input: Readonly<Record<string, unknown>>;
    q4h?: Readonly<{
      questionId: string;
      continuationType: 'answer' | 'followup' | 'retry' | 'new_message';
    }>;
  }>;
}>;

export type AppsHostKernelShutdownMessage = Readonly<{
  type: 'shutdown';
}>;

export type AppsHostMessageFromKernel =
  | AppsHostKernelInitMessage
  | AppsHostKernelToolCallMessage
  | AppsHostKernelRunControlApplyMessage
  | AppsHostKernelShutdownMessage;

export type AppsHostReadyMessage = Readonly<{
  type: 'ready';
  apps: ReadonlyArray<
    Readonly<{
      appId: string;
      frontend: Readonly<{ port: number; baseUrl: string; wsUrl: string | null }> | null;
    }>
  >;
}>;

export type AppsHostLogMessage = Readonly<{
  type: 'log';
  level: 'info' | 'warn' | 'error';
  msg: string;
  appId: string | null;
  data?: Readonly<Record<string, unknown>>;
}>;

export type AppsHostToolResultMessage = Readonly<
  {
    type: 'tool_result';
    callId: string;
  } & (Readonly<{ ok: true; output: ToolCallOutput }> | Readonly<{ ok: false; errorText: string }>)
>;

export type AppsHostRunControlResultMessage = Readonly<
  {
    type: 'run_control_result';
    callId: string;
  } & (
    | Readonly<{
        ok: true;
        result:
          | Readonly<{
              kind: 'continue';
            }>
          | Readonly<{ kind: 'reject'; errorText: string }>;
      }>
    | Readonly<{ ok: false; errorText: string }>
  )
>;

export type AppsHostMessageToKernel =
  | AppsHostReadyMessage
  | AppsHostLogMessage
  | AppsHostToolResultMessage
  | AppsHostRunControlResultMessage;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : null;
}

function asNullableNumber(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function asLanguageCode(v: unknown): LanguageCode | null {
  return v === 'zh' || v === 'en' ? v : null;
}

export function parseAppsHostMessageFromKernel(v: unknown): AppsHostMessageFromKernel {
  if (!isRecord(v)) throw new Error('Invalid IPC message from kernel: expected object');
  const type = asString(v['type']);
  if (!type) throw new Error('Invalid IPC message from kernel: missing type');
  if (type === 'shutdown') return { type: 'shutdown' };

  if (type === 'init') {
    const rtwsRootAbs = asString(v['rtwsRootAbs']);
    const kernel = v['kernel'];
    const apps = v['apps'];
    if (!rtwsRootAbs) throw new Error('Invalid init message: rtwsRootAbs required');
    if (!isRecord(kernel)) throw new Error('Invalid init message: kernel must be object');
    const host = asString(kernel['host']);
    const portRaw = kernel['port'];
    const port =
      typeof portRaw === 'number' && Number.isFinite(portRaw) ? Math.floor(portRaw) : null;
    if (!host) throw new Error('Invalid init message: kernel.host required');
    if (port === null || port < 0)
      throw new Error('Invalid init message: kernel.port must be non-negative number');
    if (!Array.isArray(apps)) throw new Error('Invalid init message: apps must be array');
    const parsedApps: AppsHostKernelInitMessage['apps'] = apps.map((a, idx) => {
      if (!isRecord(a)) throw new Error(`Invalid init message: apps[${idx}] must be object`);
      const appId = asString(a['appId']);
      const runtimePortRaw = asNullableNumber(a['runtimePort']);
      const runtimePort =
        runtimePortRaw === null
          ? null
          : runtimePortRaw !== null && Number.isFinite(runtimePortRaw)
            ? Math.floor(runtimePortRaw)
            : null;
      if (!appId) throw new Error(`Invalid init message: apps[${idx}].appId required`);
      if (runtimePort !== null && runtimePort < 0) {
        throw new Error(
          `Invalid init message: apps[${idx}].runtimePort must be non-negative number|null`,
        );
      }
      const installJson = a['installJson'];
      if (!isRecord(installJson))
        throw new Error(`Invalid init message: apps[${idx}].installJson must be object`);
      return { appId, runtimePort, installJson: installJson as unknown as DomindsAppInstallJsonV1 };
    });
    return { type: 'init', rtwsRootAbs, kernel: { host, port }, apps: parsedApps };
  }

  if (type === 'tool_call') {
    const callId = asString(v['callId']);
    const toolName = asString(v['toolName']);
    const args = v['args'];
    const ctx = v['ctx'];
    if (!callId) throw new Error('Invalid tool_call message: callId required');
    if (!toolName) throw new Error('Invalid tool_call message: toolName required');
    if (!isRecord(args)) throw new Error('Invalid tool_call message: args must be object');
    if (!isRecord(ctx)) throw new Error('Invalid tool_call message: ctx must be object');
    const dialogId = asString(ctx['dialogId']);
    const callerId = asString(ctx['callerId']);
    if (!dialogId) throw new Error('Invalid tool_call message: ctx.dialogId required');
    if (!callerId) throw new Error('Invalid tool_call message: ctx.callerId required');
    return {
      type: 'tool_call',
      callId,
      toolName,
      args: args as ToolArguments,
      ctx: { dialogId, callerId },
    };
  }

  if (type === 'run_control_apply') {
    const callId = asString(v['callId']);
    const controlId = asString(v['controlId']);
    const payload = v['payload'];
    if (!callId) throw new Error('Invalid run_control_apply message: callId required');
    if (!controlId) throw new Error('Invalid run_control_apply message: controlId required');
    if (!isRecord(payload))
      throw new Error('Invalid run_control_apply message: payload must be object');
    const dialog = payload['dialog'];
    const prompt = payload['prompt'];
    const genIterNoRaw = payload['genIterNo'];
    const source = asString(payload['source']);
    const input = payload['input'];
    if (!isRecord(dialog)) throw new Error('Invalid run_control_apply payload: dialog required');
    const genIterNo =
      typeof genIterNoRaw === 'number' && Number.isFinite(genIterNoRaw)
        ? Math.max(0, Math.floor(genIterNoRaw))
        : null;
    if (genIterNo === null) {
      throw new Error('Invalid run_control_apply payload: genIterNo required');
    }
    if (source !== 'drive_dlg_by_user_msg' && source !== 'drive_dialog_by_user_answer') {
      throw new Error('Invalid run_control_apply payload: source invalid');
    }
    if (!isRecord(input))
      throw new Error('Invalid run_control_apply payload: input must be object');

    const dialogSelfId = asString(dialog['selfId']);
    const dialogRootId = asString(dialog['rootId']);
    if (!dialogSelfId || !dialogRootId) {
      throw new Error('Invalid run_control_apply payload: dialog.selfId/rootId required');
    }

    const promptParsed = (() => {
      if (prompt === undefined) return undefined;
      if (!isRecord(prompt)) {
        throw new Error('Invalid run_control_apply payload: prompt must be object');
      }
      const content = asString(prompt['content']);
      const msgId = asString(prompt['msgId']);
      const grammar = asString(prompt['grammar']);
      const userLanguageCode = asLanguageCode(prompt['userLanguageCode']);
      const originRaw = asString(prompt['origin']);
      const origin: 'user' | 'diligence_push' | undefined =
        originRaw === 'user' || originRaw === 'diligence_push' ? originRaw : undefined;
      if (!content) throw new Error('Invalid run_control_apply payload: prompt.content required');
      if (!msgId) throw new Error('Invalid run_control_apply payload: prompt.msgId required');
      if (grammar !== 'markdown') {
        throw new Error("Invalid run_control_apply payload: prompt.grammar must be 'markdown'");
      }
      if (!userLanguageCode) {
        throw new Error('Invalid run_control_apply payload: prompt.userLanguageCode must be zh|en');
      }
      return {
        content,
        msgId,
        grammar: 'markdown' as const,
        userLanguageCode,
        origin,
      };
    })();

    const q4hRaw = payload['q4h'];
    const q4h = (() => {
      if (q4hRaw === undefined) return undefined;
      if (!isRecord(q4hRaw))
        throw new Error('Invalid run_control_apply payload: q4h must be object');
      const questionId = asString(q4hRaw['questionId']);
      const continuationTypeRaw = asString(q4hRaw['continuationType']);
      if (!questionId) {
        throw new Error('Invalid run_control_apply payload: q4h.questionId required');
      }
      if (
        continuationTypeRaw !== 'answer' &&
        continuationTypeRaw !== 'followup' &&
        continuationTypeRaw !== 'retry' &&
        continuationTypeRaw !== 'new_message'
      ) {
        throw new Error('Invalid run_control_apply payload: q4h.continuationType invalid');
      }
      const continuationType: 'answer' | 'followup' | 'retry' | 'new_message' = continuationTypeRaw;
      return { questionId, continuationType };
    })();

    return {
      type: 'run_control_apply',
      callId,
      controlId,
      payload: {
        dialog: {
          selfId: dialogSelfId,
          rootId: dialogRootId,
        },
        genIterNo,
        prompt: promptParsed,
        source,
        input: input as Readonly<Record<string, unknown>>,
        q4h,
      },
    };
  }

  throw new Error(`Invalid IPC message from kernel: unknown type '${type}'`);
}
