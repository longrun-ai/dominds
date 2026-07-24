import type {
  DomindsAppReminderRenderedMessage,
  DomindsKernelEndpoint,
} from '@longrun-ai/kernel/app-host-contract';
import {
  isJsonValue,
  parseDomindsAppInstallJson,
  type DomindsAppDialogReminderRequestBatch,
  type DomindsAppDialogTargetRef,
  type DomindsAppHostReminderUpdateResult,
  type DomindsAppInstallJson,
  type DomindsAppReminderApplyRequest,
  type DomindsAppReminderApplyResult,
  type DomindsAppReminderState,
  type JsonObject,
  type JsonValue,
} from '@longrun-ai/kernel/app-json';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  FuncResultContentItem,
  ToolResultImageArtifact,
} from '@longrun-ai/kernel/types/storage';
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

function asLanguageCode(v: unknown): LanguageCode | null {
  return v === 'zh' || v === 'en' ? v : null;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return value;
}

function parseLosslessJsonObject(v: unknown, at: string): JsonObject {
  if (!isJsonValue(v) || !isRecord(v)) {
    throw new Error(`Invalid ${at}: must be a lossless JSON object`);
  }
  return cloneJsonValue(v) as JsonObject;
}

function parseLosslessJsonValue(v: unknown, at: string): JsonValue {
  if (!isJsonValue(v)) {
    throw new Error(`Invalid ${at}: must be a lossless JSON value`);
  }
  return cloneJsonValue(v);
}

function parseMessageRecord(v: unknown, at: string): Record<string, unknown> {
  if (!isJsonValue(v)) {
    throw new Error(`Invalid ${at}: must be a lossless JSON value`);
  }
  if (!isRecord(v)) {
    throw new Error(`Invalid ${at}: expected object`);
  }
  return v;
}

function assertSupportedProperties(
  v: Readonly<Record<string, unknown>>,
  allowedProperties: ReadonlyArray<string>,
  at: string,
): void {
  const allowed = new Set(allowedProperties);
  const unsupported = Reflect.ownKeys(v)
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .map(String)
    .sort();
  if (unsupported.length > 0) {
    throw new Error(`Invalid ${at}: contains unsupported properties: ${unsupported.join(', ')}`);
  }
}

function parseRequiredString(v: unknown, at: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Invalid ${at}: required`);
  }
  return v;
}

function parsePort(v: unknown, at: string, minimum: 0 | 1): number {
  if (
    typeof v !== 'number' ||
    !Number.isInteger(v) ||
    v < minimum ||
    v > 65_535 ||
    Object.is(v, -0)
  ) {
    throw new Error(`Invalid ${at}: must be an integer between ${minimum} and 65535`);
  }
  return v;
}

function parseNonNegativeInteger(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || Object.is(v, -0)) {
    throw new Error(`Invalid ${at}: must be a non-negative integer`);
  }
  return v;
}

function parseLosslessFiniteNumber(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Object.is(v, -0)) {
    throw new Error(`Invalid ${at}: must be a lossless finite number`);
  }
  return v;
}

function parseReminderState(v: unknown, at: string): DomindsAppReminderState {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  assertSupportedProperties(v, ['content', 'meta', 'echoback', 'renderMode'], at);
  const content = asString(v['content']);
  if (content === null) throw new Error(`Invalid ${at}.content: required`);
  const metaRaw = v['meta'];
  const meta = metaRaw === undefined ? undefined : parseLosslessJsonValue(metaRaw, `${at}.meta`);
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
    content,
    ...(metaRaw === undefined ? {} : { meta }),
    ...(echobackRaw === undefined ? {} : { echoback }),
    ...(renderModeRaw === undefined ? {} : { renderMode }),
  };
}

function parseReminderApplyRequest(v: unknown, at: string): DomindsAppReminderApplyRequest {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const kind = v['kind'];
  const ownerRef = parseRequiredString(v['ownerRef'], `${at}.ownerRef`);

  if (kind === 'upsert') {
    assertSupportedProperties(
      v,
      ['kind', 'ownerRef', 'content', 'meta', 'position', 'echoback', 'renderMode'],
      at,
    );
    const content = asString(v['content']);
    if (content === null) throw new Error(`Invalid ${at}.content: required`);
    const metaRaw = v['meta'];
    const meta = metaRaw === undefined ? undefined : parseLosslessJsonValue(metaRaw, `${at}.meta`);
    const positionRaw = v['position'];
    const position =
      positionRaw === undefined
        ? undefined
        : parseLosslessFiniteNumber(positionRaw, `${at}.position`);
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
      ...(metaRaw === undefined ? {} : { meta }),
      ...(positionRaw === undefined ? {} : { position }),
      ...(echobackRaw === undefined ? {} : { echoback }),
      ...(renderModeRaw === undefined ? {} : { renderMode }),
    };
  }

  if (kind === 'delete') {
    assertSupportedProperties(v, ['kind', 'ownerRef', 'meta'], at);
    const metaRaw = v['meta'];
    const meta = metaRaw === undefined ? undefined : parseLosslessJsonValue(metaRaw, `${at}.meta`);
    return {
      kind: 'delete',
      ownerRef,
      ...(metaRaw === undefined ? {} : { meta }),
    };
  }

  throw new Error(`Invalid ${at}.kind: unsupported value ${String(kind)}`);
}

export function parseAppsHostMessageFromKernel(v: unknown): AppsHostMessageFromKernel {
  if (!isJsonValue(v)) {
    throw new Error('Invalid IPC message from kernel: must be a lossless JSON value');
  }
  if (!isRecord(v)) throw new Error('Invalid IPC message from kernel: expected object');
  const type = asString(v['type']);
  if (!type) throw new Error('Invalid IPC message from kernel: missing type');
  if (type === 'shutdown') {
    assertSupportedProperties(v, ['type'], 'shutdown message');
    return { type: 'shutdown' };
  }

  if (type === 'init') {
    assertSupportedProperties(v, ['type', 'rtwsRootAbs', 'kernel', 'apps'], 'init message');
    const rtwsRootAbs = asString(v['rtwsRootAbs']);
    const kernel = v['kernel'];
    const apps = v['apps'];
    if (!rtwsRootAbs) throw new Error('Invalid init message: rtwsRootAbs required');
    if (!isRecord(kernel)) throw new Error('Invalid init message: kernel must be object');
    assertSupportedProperties(kernel, ['scheme', 'host', 'port'], 'init message.kernel');
    const scheme = kernel['scheme'];
    const host = asString(kernel['host']);
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('Invalid init message: kernel.scheme must be http|https');
    }
    if (!host) throw new Error('Invalid init message: kernel.host required');
    const port = parsePort(kernel['port'], 'init message.kernel.port', 0);
    if (!Array.isArray(apps)) throw new Error('Invalid init message: apps must be array');
    const parsedApps: AppsHostKernelInitMessage['apps'] = apps.map((a, idx) => {
      if (!isRecord(a)) throw new Error(`Invalid init message: apps[${idx}] must be object`);
      assertSupportedProperties(
        a,
        ['appId', 'runtimePort', 'installJson'],
        `init message.apps[${idx}]`,
      );
      const appId = parseRequiredString(a['appId'], `init message.apps[${idx}].appId`);
      const runtimePortRaw = a['runtimePort'];
      const runtimePort =
        runtimePortRaw === null
          ? null
          : parsePort(runtimePortRaw, `init message.apps[${idx}].runtimePort`, 0);
      const installJsonRaw = a['installJson'];
      const parsedInstallJson = parseDomindsAppInstallJson(installJsonRaw);
      if (!parsedInstallJson.ok) {
        throw new Error(
          `Invalid init message: apps[${idx}].installJson: ${parsedInstallJson.errorText}`,
        );
      }
      if (parsedInstallJson.json.appId !== appId) {
        throw new Error(
          `Invalid init message: apps[${idx}].appId '${appId}' does not match installJson.appId '${parsedInstallJson.json.appId}'`,
        );
      }
      const installJson = parseLosslessJsonObject(
        parsedInstallJson.json,
        `init message.apps[${idx}].installJson`,
      ) as unknown as DomindsAppInstallJson;
      return { appId, runtimePort, installJson };
    });
    return { type: 'init', rtwsRootAbs, kernel: { scheme, host, port }, apps: parsedApps };
  }

  if (type === 'tool_call') {
    assertSupportedProperties(
      v,
      ['type', 'callId', 'toolName', 'args', 'ctx'],
      'tool_call message',
    );
    const callId = parseRequiredString(v['callId'], 'tool_call message.callId');
    const toolName = parseRequiredString(v['toolName'], 'tool_call message.toolName');
    const args = parseLosslessJsonObject(v['args'], 'tool_call message.args');
    const ctx = v['ctx'];
    if (!isRecord(ctx)) throw new Error('Invalid tool_call message: ctx must be object');
    assertSupportedProperties(
      ctx,
      ['dialogId', 'mainDialogId', 'agentId', 'taskDocPath', 'sessionSlug', 'callerId'],
      'tool_call message.ctx',
    );
    const dialogId = parseRequiredString(ctx['dialogId'], 'tool_call message.ctx.dialogId');
    const mainDialogId = parseRequiredString(
      ctx['mainDialogId'],
      'tool_call message.ctx.mainDialogId',
    );
    const agentId = parseRequiredString(ctx['agentId'], 'tool_call message.ctx.agentId');
    const taskDocPath = parseRequiredString(
      ctx['taskDocPath'],
      'tool_call message.ctx.taskDocPath',
    );
    const sessionSlugRaw = ctx['sessionSlug'];
    const sessionSlug =
      sessionSlugRaw === undefined
        ? undefined
        : parseRequiredString(sessionSlugRaw, 'tool_call message.ctx.sessionSlug');
    const callerId = parseRequiredString(ctx['callerId'], 'tool_call message.ctx.callerId');
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
        ...(sessionSlugRaw === undefined ? {} : { sessionSlug }),
        callerId,
      },
    };
  }

  if (type === 'reminder_apply') {
    assertSupportedProperties(
      v,
      ['type', 'callId', 'appId', 'ownerRef', 'request', 'ctx'],
      'reminder_apply message',
    );
    const callId = parseRequiredString(v['callId'], 'reminder_apply message.callId');
    const appId = parseRequiredString(v['appId'], 'reminder_apply message.appId');
    const ownerRef = parseRequiredString(v['ownerRef'], 'reminder_apply message.ownerRef');
    const request = v['request'];
    const ctx = v['ctx'];
    if (!isRecord(ctx)) throw new Error('Invalid reminder_apply message: ctx must be object');
    assertSupportedProperties(ctx, ['dialogId', 'ownedReminders'], 'reminder_apply message.ctx');
    const dialogId = parseRequiredString(ctx['dialogId'], 'reminder_apply message.ctx.dialogId');
    const ownedRemindersRaw = ctx['ownedReminders'];
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
    assertSupportedProperties(
      v,
      ['type', 'callId', 'appId', 'ownerRef', 'ctx'],
      'reminder_update message',
    );
    const callId = parseRequiredString(v['callId'], 'reminder_update message.callId');
    const appId = parseRequiredString(v['appId'], 'reminder_update message.appId');
    const ownerRef = parseRequiredString(v['ownerRef'], 'reminder_update message.ownerRef');
    const ctx = v['ctx'];
    if (!isRecord(ctx)) throw new Error('Invalid reminder_update message: ctx must be object');
    assertSupportedProperties(ctx, ['dialogId', 'reminder'], 'reminder_update message.ctx');
    const dialogId = parseRequiredString(ctx['dialogId'], 'reminder_update message.ctx.dialogId');
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
    assertSupportedProperties(
      v,
      ['type', 'callId', 'appId', 'ownerRef', 'ctx'],
      'reminder_render message',
    );
    const callId = parseRequiredString(v['callId'], 'reminder_render message.callId');
    const appId = parseRequiredString(v['appId'], 'reminder_render message.appId');
    const ownerRef = parseRequiredString(v['ownerRef'], 'reminder_render message.ownerRef');
    const ctx = v['ctx'];
    if (!isRecord(ctx)) throw new Error('Invalid reminder_render message: ctx must be object');
    assertSupportedProperties(
      ctx,
      ['dialogId', 'reminder', 'reminderId', 'workLanguage'],
      'reminder_render message.ctx',
    );
    const dialogId = parseRequiredString(ctx['dialogId'], 'reminder_render message.ctx.dialogId');
    const reminderId = parseRequiredString(
      ctx['reminderId'],
      'reminder_render message.ctx.reminderId',
    );
    const workLanguage = asLanguageCode(ctx['workLanguage']);
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

function parseToolResultImageArtifact(v: unknown, at: string): ToolResultImageArtifact {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  assertSupportedProperties(v, ['rootId', 'selfId', 'status', 'relPath'], at);
  const rootId = parseRequiredString(v['rootId'], `${at}.rootId`);
  const selfId = parseRequiredString(v['selfId'], `${at}.selfId`);
  const status = v['status'];
  if (status !== 'running' && status !== 'completed' && status !== 'archived') {
    throw new Error(`Invalid ${at}.status: must be running|completed|archived`);
  }
  const relPath = parseRequiredString(v['relPath'], `${at}.relPath`);
  return { rootId, selfId, status, relPath };
}

function parseFuncResultContentItem(v: unknown, at: string): FuncResultContentItem {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const type = v['type'];
  if (type === 'input_text') {
    assertSupportedProperties(v, ['type', 'text'], at);
    const text = asString(v['text']);
    if (text === null) throw new Error(`Invalid ${at}.text: must be string`);
    return { type, text };
  }
  if (type === 'input_image') {
    assertSupportedProperties(v, ['type', 'mimeType', 'byteLength', 'artifact'], at);
    const mimeType = parseRequiredString(v['mimeType'], `${at}.mimeType`);
    const byteLength = parseNonNegativeInteger(v['byteLength'], `${at}.byteLength`);
    return {
      type,
      mimeType,
      byteLength,
      artifact: parseToolResultImageArtifact(v['artifact'], `${at}.artifact`),
    };
  }
  throw new Error(`Invalid ${at}.type: must be input_text|input_image`);
}

function parseToolCallOutput(v: unknown, at: string): ToolCallOutput {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  assertSupportedProperties(v, ['content', 'outcome', 'contentItems'], at);
  const content = asString(v['content']);
  if (content === null) throw new Error(`Invalid ${at}.content: must be string`);
  const outcome = v['outcome'];
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial_failure') {
    throw new Error(`Invalid ${at}.outcome: must be success|failure|partial_failure`);
  }
  const contentItemsRaw = v['contentItems'];
  if (contentItemsRaw !== undefined && !Array.isArray(contentItemsRaw)) {
    throw new Error(`Invalid ${at}.contentItems: must be array`);
  }
  const contentItems =
    contentItemsRaw === undefined
      ? undefined
      : contentItemsRaw.map((item, index) =>
          parseFuncResultContentItem(item, `${at}.contentItems[${index}]`),
        );
  return {
    content,
    outcome,
    ...(contentItemsRaw === undefined ? {} : { contentItems }),
  };
}

function parseDialogTargetRef(v: unknown, at: string): DomindsAppDialogTargetRef {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const dialogIdRaw = v['dialogId'];
  if (dialogIdRaw !== undefined) {
    assertSupportedProperties(v, ['dialogId'], at);
    return { dialogId: parseRequiredString(dialogIdRaw, `${at}.dialogId`) };
  }

  assertSupportedProperties(v, ['mainDialogId', 'agentId', 'sessionSlug'], at);
  const agentId = parseRequiredString(v['agentId'], `${at}.agentId`);
  const mainDialogIdRaw = v['mainDialogId'];
  const mainDialogId =
    mainDialogIdRaw === undefined
      ? undefined
      : parseRequiredString(mainDialogIdRaw, `${at}.mainDialogId`);
  const sessionSlugRaw = v['sessionSlug'];
  const sessionSlug =
    sessionSlugRaw === undefined
      ? undefined
      : parseRequiredString(sessionSlugRaw, `${at}.sessionSlug`);
  return {
    agentId,
    ...(mainDialogIdRaw === undefined ? {} : { mainDialogId }),
    ...(sessionSlugRaw === undefined ? {} : { sessionSlug }),
  };
}

function parseDialogReminderRequestBatch(
  v: unknown,
  at: string,
): DomindsAppDialogReminderRequestBatch {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  assertSupportedProperties(v, ['target', 'reminderRequests'], at);
  const reminderRequestsRaw = v['reminderRequests'];
  if (!Array.isArray(reminderRequestsRaw)) {
    throw new Error(`Invalid ${at}.reminderRequests: must be array`);
  }
  return {
    target: parseDialogTargetRef(v['target'], `${at}.target`),
    reminderRequests: reminderRequestsRaw.map((request, index) =>
      parseReminderApplyRequest(request, `${at}.reminderRequests[${index}]`),
    ),
  };
}

function parseReminderApplyResult(v: unknown, at: string): DomindsAppReminderApplyResult {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const treatment = v['treatment'];
  if (treatment === 'noop') {
    assertSupportedProperties(v, ['treatment'], at);
    return { treatment };
  }
  if (treatment === 'add') {
    assertSupportedProperties(v, ['treatment', 'reminder', 'position'], at);
    const positionRaw = v['position'];
    const position =
      positionRaw === undefined
        ? undefined
        : parseLosslessFiniteNumber(positionRaw, `${at}.position`);
    return {
      treatment,
      reminder: parseReminderState(v['reminder'], `${at}.reminder`),
      ...(positionRaw === undefined ? {} : { position }),
    };
  }
  if (treatment === 'update') {
    assertSupportedProperties(v, ['treatment', 'ownedIndex', 'reminder'], at);
    return {
      treatment,
      ownedIndex: parseNonNegativeInteger(v['ownedIndex'], `${at}.ownedIndex`),
      reminder: parseReminderState(v['reminder'], `${at}.reminder`),
    };
  }
  if (treatment === 'delete') {
    assertSupportedProperties(v, ['treatment', 'ownedIndex'], at);
    return {
      treatment,
      ownedIndex: parseNonNegativeInteger(v['ownedIndex'], `${at}.ownedIndex`),
    };
  }
  throw new Error(`Invalid ${at}.treatment: unsupported value ${String(treatment)}`);
}

function parseReminderUpdateResult(v: unknown, at: string): DomindsAppHostReminderUpdateResult {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  const treatment = v['treatment'];
  if (treatment === 'drop' || treatment === 'keep') {
    assertSupportedProperties(v, ['treatment'], at);
    return { treatment };
  }
  if (treatment === 'update') {
    assertSupportedProperties(v, ['treatment', 'updatedContent', 'updatedMeta'], at);
    const updatedContent = asString(v['updatedContent']);
    if (updatedContent === null) {
      throw new Error(`Invalid ${at}.updatedContent: must be string`);
    }
    const updatedMetaRaw = v['updatedMeta'];
    const updatedMeta =
      updatedMetaRaw === undefined
        ? undefined
        : parseLosslessJsonValue(updatedMetaRaw, `${at}.updatedMeta`);
    return {
      treatment,
      updatedContent,
      ...(updatedMetaRaw === undefined ? {} : { updatedMeta }),
    };
  }
  throw new Error(`Invalid ${at}.treatment: unsupported value ${String(treatment)}`);
}

function parseReminderRenderedMessage(v: unknown, at: string): DomindsAppReminderRenderedMessage {
  if (!isRecord(v)) throw new Error(`Invalid ${at}: expected object`);
  assertSupportedProperties(v, ['content'], at);
  const content = asString(v['content']);
  if (content === null) throw new Error(`Invalid ${at}.content: must be string`);
  return { content };
}

export function parseAppsHostMessageToKernel(v: unknown): AppsHostMessageToKernel {
  const message = parseMessageRecord(v, 'IPC message from apps-host');
  const type = asString(message['type']);
  if (!type) throw new Error('Invalid IPC message from apps-host: missing type');

  if (type === 'ready') {
    assertSupportedProperties(message, ['type', 'apps'], 'ready message');
    const appsRaw = message['apps'];
    if (!Array.isArray(appsRaw)) throw new Error('Invalid ready message: apps must be array');
    const apps: AppsHostReadyMessage['apps'] = appsRaw.map((app, index) => {
      if (!isRecord(app)) throw new Error(`Invalid ready message.apps[${index}]: expected object`);
      assertSupportedProperties(app, ['appId', 'frontend'], `ready message.apps[${index}]`);
      const appId = parseRequiredString(app['appId'], `ready message.apps[${index}].appId`);
      const frontendRaw = app['frontend'];
      if (frontendRaw === null) return { appId, frontend: null };
      if (!isRecord(frontendRaw)) {
        throw new Error(`Invalid ready message.apps[${index}].frontend: expected object|null`);
      }
      assertSupportedProperties(
        frontendRaw,
        ['port', 'baseUrl', 'wsUrl'],
        `ready message.apps[${index}].frontend`,
      );
      const port = parsePort(frontendRaw['port'], `ready message.apps[${index}].frontend.port`, 1);
      const baseUrl = parseRequiredString(
        frontendRaw['baseUrl'],
        `ready message.apps[${index}].frontend.baseUrl`,
      );
      const wsUrlRaw = frontendRaw['wsUrl'];
      const wsUrl =
        wsUrlRaw === null
          ? null
          : parseRequiredString(wsUrlRaw, `ready message.apps[${index}].frontend.wsUrl`);
      return { appId, frontend: { port, baseUrl, wsUrl } };
    });
    return { type, apps };
  }

  if (type === 'log') {
    assertSupportedProperties(message, ['type', 'level', 'msg', 'appId', 'data'], 'log message');
    const level = message['level'];
    if (level !== 'info' && level !== 'warn' && level !== 'error') {
      throw new Error('Invalid log message.level: must be info|warn|error');
    }
    const msg = parseRequiredString(message['msg'], 'log message.msg');
    const appIdRaw = message['appId'];
    const appId = appIdRaw === null ? null : parseRequiredString(appIdRaw, 'log message.appId');
    const dataRaw = message['data'];
    const data =
      dataRaw === undefined ? undefined : parseLosslessJsonObject(dataRaw, 'log message.data');
    return {
      type,
      level,
      msg,
      appId,
      ...(dataRaw === undefined ? {} : { data }),
    };
  }

  if (type === 'tool_result') {
    const callId = parseRequiredString(message['callId'], 'tool_result message.callId');
    const ok = message['ok'];
    if (ok === false) {
      assertSupportedProperties(
        message,
        ['type', 'callId', 'ok', 'errorText'],
        'tool_result message',
      );
      const errorText = parseRequiredString(message['errorText'], 'tool_result message.errorText');
      return { type, callId, ok, errorText };
    }
    if (ok !== true) throw new Error('Invalid tool_result message.ok: must be boolean');
    assertSupportedProperties(
      message,
      ['type', 'callId', 'ok', 'output', 'reminderRequests', 'dialogReminderRequests'],
      'tool_result message',
    );
    const reminderRequestsRaw = message['reminderRequests'];
    if (reminderRequestsRaw !== undefined && !Array.isArray(reminderRequestsRaw)) {
      throw new Error('Invalid tool_result message.reminderRequests: must be array');
    }
    const reminderRequests =
      reminderRequestsRaw === undefined
        ? undefined
        : reminderRequestsRaw.map((request, index) =>
            parseReminderApplyRequest(request, `tool_result message.reminderRequests[${index}]`),
          );
    const dialogReminderRequestsRaw = message['dialogReminderRequests'];
    if (dialogReminderRequestsRaw !== undefined && !Array.isArray(dialogReminderRequestsRaw)) {
      throw new Error('Invalid tool_result message.dialogReminderRequests: must be array');
    }
    const dialogReminderRequests =
      dialogReminderRequestsRaw === undefined
        ? undefined
        : dialogReminderRequestsRaw.map((batch, index) =>
            parseDialogReminderRequestBatch(
              batch,
              `tool_result message.dialogReminderRequests[${index}]`,
            ),
          );
    return {
      type,
      callId,
      ok,
      output: parseToolCallOutput(message['output'], 'tool_result message.output'),
      ...(reminderRequestsRaw === undefined ? {} : { reminderRequests }),
      ...(dialogReminderRequestsRaw === undefined ? {} : { dialogReminderRequests }),
    };
  }

  if (type === 'reminder_apply_result') {
    const callId = parseRequiredString(message['callId'], 'reminder_apply_result message.callId');
    const ok = message['ok'];
    if (ok === false) {
      assertSupportedProperties(
        message,
        ['type', 'callId', 'ok', 'errorText'],
        'reminder_apply_result message',
      );
      const errorText = parseRequiredString(
        message['errorText'],
        'reminder_apply_result message.errorText',
      );
      return { type, callId, ok, errorText };
    }
    if (ok !== true) throw new Error('Invalid reminder_apply_result message.ok: must be boolean');
    assertSupportedProperties(
      message,
      ['type', 'callId', 'ok', 'result'],
      'reminder_apply_result message',
    );
    return {
      type,
      callId,
      ok,
      result: parseReminderApplyResult(message['result'], 'reminder_apply_result message.result'),
    };
  }

  if (type === 'reminder_update_result') {
    const callId = parseRequiredString(message['callId'], 'reminder_update_result message.callId');
    const ok = message['ok'];
    if (ok === false) {
      assertSupportedProperties(
        message,
        ['type', 'callId', 'ok', 'errorText'],
        'reminder_update_result message',
      );
      const errorText = parseRequiredString(
        message['errorText'],
        'reminder_update_result message.errorText',
      );
      return { type, callId, ok, errorText };
    }
    if (ok !== true) throw new Error('Invalid reminder_update_result message.ok: must be boolean');
    assertSupportedProperties(
      message,
      ['type', 'callId', 'ok', 'result'],
      'reminder_update_result message',
    );
    return {
      type,
      callId,
      ok,
      result: parseReminderUpdateResult(message['result'], 'reminder_update_result message.result'),
    };
  }

  if (type === 'reminder_render_result') {
    const callId = parseRequiredString(message['callId'], 'reminder_render_result message.callId');
    const ok = message['ok'];
    if (ok === false) {
      assertSupportedProperties(
        message,
        ['type', 'callId', 'ok', 'errorText'],
        'reminder_render_result message',
      );
      const errorText = parseRequiredString(
        message['errorText'],
        'reminder_render_result message.errorText',
      );
      return { type, callId, ok, errorText };
    }
    if (ok !== true) throw new Error('Invalid reminder_render_result message.ok: must be boolean');
    assertSupportedProperties(
      message,
      ['type', 'callId', 'ok', 'message'],
      'reminder_render_result message',
    );
    return {
      type,
      callId,
      ok,
      message: parseReminderRenderedMessage(
        message['message'],
        'reminder_render_result message.message',
      ),
    };
  }

  throw new Error(`Invalid IPC message from apps-host: unknown type '${type}'`);
}
