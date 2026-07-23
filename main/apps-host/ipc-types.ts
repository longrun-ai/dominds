import type {
  DomindsAppReminderRenderedMessage,
  DomindsKernelEndpoint,
} from '@longrun-ai/kernel/app-host-contract';
import type {
  DomindsAppDialogReminderRequestBatch,
  DomindsAppHostReminderUpdateResult,
  DomindsAppInstallJson,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from '@longrun-ai/kernel/app-json';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { ToolArguments, ToolCallOutput } from '../tool';

export type AppsHostKernelInitMessage = Readonly<{
  type: 'init';
  rtwsRootAbs: string;
  kernel: DomindsKernelEndpoint;
  apps: ReadonlyArray<
    Readonly<{
      appId: string;
      runtimePort: number | null;
      installJson: DomindsAppInstallJson;
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
    mainDialogId: string;
    agentId: string;
    taskDocPath: string;
    sessionSlug?: string;
    callerId: string;
  }>;
}>;

export type AppsHostKernelReminderApplyMessage = Readonly<{
  type: 'reminder_apply';
  callId: string;
  appId: string;
  ownerRef: string;
  request: DomindsAppReminderApplyRequest;
  ctx: Readonly<{
    dialogId: string;
    ownedReminders: ReadonlyArray<DomindsAppReminderState>;
  }>;
}>;

export type AppsHostKernelReminderUpdateMessage = Readonly<{
  type: 'reminder_update';
  callId: string;
  appId: string;
  ownerRef: string;
  ctx: Readonly<{
    dialogId: string;
    reminder: DomindsAppReminderState;
  }>;
}>;

export type AppsHostKernelReminderRenderMessage = Readonly<{
  type: 'reminder_render';
  callId: string;
  appId: string;
  ownerRef: string;
  ctx: Readonly<{
    dialogId: string;
    reminder: DomindsAppReminderState;
    reminderId: string;
    workLanguage: LanguageCode;
  }>;
}>;

export type AppsHostKernelShutdownMessage = Readonly<{
  type: 'shutdown';
}>;

export type AppsHostMessageFromKernel =
  | AppsHostKernelInitMessage
  | AppsHostKernelToolCallMessage
  | AppsHostKernelReminderApplyMessage
  | AppsHostKernelReminderUpdateMessage
  | AppsHostKernelReminderRenderMessage
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
  } & (
    | Readonly<{
        ok: true;
        output: ToolCallOutput;
        reminderRequests?: ReadonlyArray<DomindsAppReminderApplyRequest>;
        dialogReminderRequests?: ReadonlyArray<DomindsAppDialogReminderRequestBatch>;
      }>
    | Readonly<{ ok: false; errorText: string }>
  )
>;

export type AppsHostReminderApplyResultMessage = Readonly<
  {
    type: 'reminder_apply_result';
    callId: string;
  } & (
    | Readonly<{ ok: true; result: DomindsAppReminderApplyResult }>
    | Readonly<{ ok: false; errorText: string }>
  )
>;

export type AppsHostReminderUpdateResultMessage = Readonly<
  {
    type: 'reminder_update_result';
    callId: string;
  } & (
    | Readonly<{ ok: true; result: DomindsAppHostReminderUpdateResult }>
    | Readonly<{ ok: false; errorText: string }>
  )
>;

export type AppsHostReminderRenderResultMessage = Readonly<
  {
    type: 'reminder_render_result';
    callId: string;
  } & (
    | Readonly<{ ok: true; message: DomindsAppReminderRenderedMessage }>
    | Readonly<{ ok: false; errorText: string }>
  )
>;

export type AppsHostMessageToKernel =
  | AppsHostReadyMessage
  | AppsHostLogMessage
  | AppsHostToolResultMessage
  | AppsHostReminderApplyResultMessage
  | AppsHostReminderUpdateResultMessage
  | AppsHostReminderRenderResultMessage;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
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

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function isJsonValue(value: unknown): boolean {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function parseReminderState(v: unknown, at: string): DomindsAppReminderState {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const content = asString(v['content']);
  if (content === null) throw new Error(`Invalid ${at}.content: required`);
  const metaRaw = v['meta'];
  if (metaRaw !== undefined && !isJsonValue(metaRaw)) {
    throw new Error(`Invalid ${at}.meta: must be JSON-serializable`);
  }
  const echobackRaw = v['echoback'];
  const echoback =
    echobackRaw === undefined ? undefined : typeof echobackRaw === 'boolean' ? echobackRaw : null;
  if (echoback === null) throw new Error(`Invalid ${at}.echoback: must be boolean`);
  const renderModeRaw = v['renderMode'];
  const renderMode =
    renderModeRaw === undefined
      ? undefined
      : renderModeRaw === 'plain' || renderModeRaw === 'markdown'
        ? renderModeRaw
        : null;
  if (renderMode === null) throw new Error(`Invalid ${at}.renderMode: must be plain|markdown`);
  return { content, meta: metaRaw as DomindsAppReminderState['meta'], echoback, renderMode };
}

function parseReminderApplyRequest(v: unknown, at: string): DomindsAppReminderApplyRequest {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const kind = v['kind'];
  const ownerRef = asString(v['ownerRef']);
  if (!ownerRef) throw new Error(`Invalid ${at}.ownerRef: required`);

  if (kind === 'upsert') {
    const content = asString(v['content']);
    if (content === null) throw new Error(`Invalid ${at}.content: required`);
    const metaRaw = v['meta'];
    if (metaRaw !== undefined && !isJsonValue(metaRaw)) {
      throw new Error(`Invalid ${at}.meta: must be JSON-serializable`);
    }
    const positionRaw = v['position'];
    const position =
      positionRaw === undefined
        ? undefined
        : typeof positionRaw === 'number' && Number.isFinite(positionRaw)
          ? Math.floor(positionRaw)
          : null;
    if (position === null) throw new Error(`Invalid ${at}.position: must be finite number`);
    const echobackRaw = v['echoback'];
    const echoback =
      echobackRaw === undefined ? undefined : typeof echobackRaw === 'boolean' ? echobackRaw : null;
    if (echoback === null) throw new Error(`Invalid ${at}.echoback: must be boolean`);
    const renderModeRaw = v['renderMode'];
    const renderMode =
      renderModeRaw === undefined
        ? undefined
        : renderModeRaw === 'plain' || renderModeRaw === 'markdown'
          ? renderModeRaw
          : null;
    if (renderMode === null) throw new Error(`Invalid ${at}.renderMode: must be plain|markdown`);
    return {
      kind: 'upsert',
      ownerRef,
      content,
      meta: metaRaw as DomindsAppReminderApplyRequest['meta'],
      position,
      echoback,
      renderMode,
    };
  }

  if (kind === 'delete') {
    const metaRaw = v['meta'];
    if (metaRaw !== undefined && !isJsonValue(metaRaw)) {
      throw new Error(`Invalid ${at}.meta: must be JSON-serializable`);
    }
    return { kind: 'delete', ownerRef, meta: metaRaw as DomindsAppReminderApplyRequest['meta'] };
  }

  throw new Error(`Invalid ${at}.kind: unsupported value ${String(kind)}`);
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
    const scheme = kernel['scheme'];
    const host = asString(kernel['host']);
    const portRaw = kernel['port'];
    const port =
      typeof portRaw === 'number' && Number.isFinite(portRaw) ? Math.floor(portRaw) : null;
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('Invalid init message: kernel.scheme must be http|https');
    }
    if (!host) throw new Error('Invalid init message: kernel.host required');
    if (port === null || port < 0) {
      throw new Error('Invalid init message: kernel.port must be non-negative number');
    }
    if (!Array.isArray(apps)) throw new Error('Invalid init message: apps must be array');
    const parsedApps: AppsHostKernelInitMessage['apps'] = apps.map((a, idx) => {
      if (!isRecord(a)) throw new Error(`Invalid init message: apps[${idx}] must be object`);
      const appId = asString(a['appId']);
      const runtimePortRaw = asNullableNumber(a['runtimePort']);
      const runtimePort =
        runtimePortRaw === null
          ? null
          : Number.isFinite(runtimePortRaw)
            ? Math.floor(runtimePortRaw)
            : null;
      if (!appId) throw new Error(`Invalid init message: apps[${idx}].appId required`);
      if (runtimePort !== null && runtimePort < 0) {
        throw new Error(
          `Invalid init message: apps[${idx}].runtimePort must be non-negative number|null`,
        );
      }
      const installJson = a['installJson'];
      if (!isRecord(installJson)) {
        throw new Error(`Invalid init message: apps[${idx}].installJson must be object`);
      }
      return { appId, runtimePort, installJson: installJson as DomindsAppInstallJson };
    });
    return { type: 'init', rtwsRootAbs, kernel: { scheme, host, port }, apps: parsedApps };
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
    const mainDialogId = asString(ctx['mainDialogId']);
    const agentId = asString(ctx['agentId']);
    const taskDocPath = asString(ctx['taskDocPath']);
    const sessionSlugRaw = ctx['sessionSlug'];
    const sessionSlug =
      sessionSlugRaw === undefined
        ? undefined
        : typeof sessionSlugRaw === 'string'
          ? sessionSlugRaw
          : null;
    const callerId = asString(ctx['callerId']);
    if (!dialogId) throw new Error('Invalid tool_call message: ctx.dialogId required');
    if (!mainDialogId) throw new Error('Invalid tool_call message: ctx.mainDialogId required');
    if (!agentId) throw new Error('Invalid tool_call message: ctx.agentId required');
    if (!taskDocPath) throw new Error('Invalid tool_call message: ctx.taskDocPath required');
    if (sessionSlugRaw !== undefined && !sessionSlug) {
      throw new Error('Invalid tool_call message: ctx.sessionSlug must be string when present');
    }
    if (!callerId) throw new Error('Invalid tool_call message: ctx.callerId required');
    const normalizedSessionSlug = sessionSlug ?? undefined;
    return {
      type: 'tool_call',
      callId,
      toolName,
      args: args as ToolArguments,
      ctx: {
        dialogId,
        mainDialogId,
        agentId,
        taskDocPath,
        sessionSlug: normalizedSessionSlug,
        callerId,
      },
    };
  }

  if (type === 'reminder_apply') {
    const callId = asString(v['callId']);
    const appId = asString(v['appId']);
    const ownerRef = asString(v['ownerRef']);
    const request = v['request'];
    const ctx = v['ctx'];
    if (!callId) throw new Error('Invalid reminder_apply message: callId required');
    if (!appId) throw new Error('Invalid reminder_apply message: appId required');
    if (!ownerRef) throw new Error('Invalid reminder_apply message: ownerRef required');
    if (!isRecord(ctx)) throw new Error('Invalid reminder_apply message: ctx must be object');
    const dialogId = asString(ctx['dialogId']);
    const ownedRemindersRaw = ctx['ownedReminders'];
    if (!dialogId) throw new Error('Invalid reminder_apply message: ctx.dialogId required');
    if (!Array.isArray(ownedRemindersRaw)) {
      throw new Error('Invalid reminder_apply message: ctx.ownedReminders must be array');
    }
    return {
      type: 'reminder_apply',
      callId,
      appId,
      ownerRef,
      request: parseReminderApplyRequest(request, 'reminder_apply.request'),
      ctx: {
        dialogId,
        ownedReminders: ownedRemindersRaw.map((item, index) =>
          parseReminderState(item, `reminder_apply.ctx.ownedReminders[${index}]`),
        ),
      },
    };
  }

  if (type === 'reminder_update') {
    const callId = asString(v['callId']);
    const appId = asString(v['appId']);
    const ownerRef = asString(v['ownerRef']);
    const ctx = v['ctx'];
    if (!callId) throw new Error('Invalid reminder_update message: callId required');
    if (!appId) throw new Error('Invalid reminder_update message: appId required');
    if (!ownerRef) throw new Error('Invalid reminder_update message: ownerRef required');
    if (!isRecord(ctx)) throw new Error('Invalid reminder_update message: ctx must be object');
    const dialogId = asString(ctx['dialogId']);
    if (!dialogId) throw new Error('Invalid reminder_update message: ctx.dialogId required');
    return {
      type: 'reminder_update',
      callId,
      appId,
      ownerRef,
      ctx: {
        dialogId,
        reminder: parseReminderState(ctx['reminder'], 'reminder_update.ctx.reminder'),
      },
    };
  }

  if (type === 'reminder_render') {
    const callId = asString(v['callId']);
    const appId = asString(v['appId']);
    const ownerRef = asString(v['ownerRef']);
    const ctx = v['ctx'];
    if (!callId) throw new Error('Invalid reminder_render message: callId required');
    if (!appId) throw new Error('Invalid reminder_render message: appId required');
    if (!ownerRef) throw new Error('Invalid reminder_render message: ownerRef required');
    if (!isRecord(ctx)) throw new Error('Invalid reminder_render message: ctx must be object');
    const dialogId = asString(ctx['dialogId']);
    const reminderId = asString(ctx['reminderId']);
    const workLanguage = asLanguageCode(ctx['workLanguage']);
    if (!dialogId) throw new Error('Invalid reminder_render message: ctx.dialogId required');
    if (!reminderId) {
      throw new Error('Invalid reminder_render message: ctx.reminderId required');
    }
    if (!workLanguage) throw new Error('Invalid reminder_render message: ctx.workLanguage invalid');
    return {
      type: 'reminder_render',
      callId,
      appId,
      ownerRef,
      ctx: {
        dialogId,
        reminder: parseReminderState(ctx['reminder'], 'reminder_render.ctx.reminder'),
        reminderId,
        workLanguage,
      },
    };
  }

  throw new Error(`Invalid IPC message from kernel: unknown type '${type}'`);
}
