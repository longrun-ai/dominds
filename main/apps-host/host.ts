#!/usr/bin/env node

import path from 'path';
import { pathToFileURL } from 'url';

import type {
  DomindsAppDialogReminderRequestBatch,
  DomindsAppDialogTargetRef,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolResult,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from '../apps/app-json';
import type { ChatMessage } from '../llm/client';
import { createLogger } from '../log';
import type { JsonValue } from '../tool';

import type {
  CreateDomindsAppHostFn,
  DomindsAppHostInstance,
  DomindsAppHostStartResult,
  DomindsAppReminderOwnerHandler,
  DomindsAppRunControlResult,
} from './app-host-contract';
import {
  parseAppsHostMessageFromKernel,
  type AppsHostKernelInitMessage,
  type AppsHostMessageToKernel,
} from './ipc-types';

const log = createLogger('apps-host');

const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function isToolCallOutput(value: unknown): value is DomindsAppHostToolResult['output'] {
  if (typeof value === 'string') return true;
  if (!isRecord(value)) return false;
  if (typeof value['content'] !== 'string') return false;
  const contentItems = value['contentItems'];
  return contentItems === undefined || Array.isArray(contentItems);
}

function parseReminderRequest(value: unknown): DomindsAppReminderApplyRequest {
  if (!isRecord(value)) throw new Error('Invalid app tool reminder request: expected object');
  const kind = value['kind'];
  const ownerRef = value['ownerRef'];
  if (typeof ownerRef !== 'string' || ownerRef.trim() === '') {
    throw new Error('Invalid app tool reminder request: ownerRef required');
  }
  if (kind === 'delete') {
    const meta = value['meta'];
    if (meta !== undefined && !isJsonValue(meta)) {
      throw new Error('Invalid app tool reminder request: delete.meta must be JSON-serializable');
    }
    return { kind: 'delete', ownerRef, meta };
  }
  if (kind === 'upsert') {
    const content = value['content'];
    if (typeof content !== 'string') {
      throw new Error('Invalid app tool reminder request: upsert.content must be string');
    }
    const meta = value['meta'];
    if (meta !== undefined && !isJsonValue(meta)) {
      throw new Error('Invalid app tool reminder request: upsert.meta must be JSON-serializable');
    }
    const positionRaw = value['position'];
    const position =
      positionRaw === undefined
        ? undefined
        : typeof positionRaw === 'number' && Number.isFinite(positionRaw)
          ? Math.floor(positionRaw)
          : null;
    if (position === null) {
      throw new Error('Invalid app tool reminder request: upsert.position must be finite number');
    }
    const echobackRaw = value['echoback'];
    const echoback =
      echobackRaw === undefined ? undefined : typeof echobackRaw === 'boolean' ? echobackRaw : null;
    if (echoback === null) {
      throw new Error('Invalid app tool reminder request: upsert.echoback must be boolean');
    }
    return { kind: 'upsert', ownerRef, content, meta, position, echoback };
  }
  throw new Error(`Invalid app tool reminder request kind: ${String(kind)}`);
}

function parseDialogTargetRef(value: unknown): DomindsAppDialogTargetRef {
  if (!isRecord(value)) throw new Error('Invalid dialog reminder target: expected object');
  const dialogId = value['dialogId'];
  if (typeof dialogId === 'string' && dialogId.trim() !== '') {
    return { dialogId };
  }
  const agentId = value['agentId'];
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error('Invalid dialog reminder target: agentId required when dialogId is absent');
  }
  const rootDialogIdRaw = value['rootDialogId'];
  const rootDialogId =
    rootDialogIdRaw === undefined
      ? undefined
      : typeof rootDialogIdRaw === 'string' && rootDialogIdRaw.trim() !== ''
        ? rootDialogIdRaw
        : null;
  if (rootDialogId === null) {
    throw new Error('Invalid dialog reminder target: rootDialogId must be non-empty string');
  }
  const sessionSlugRaw = value['sessionSlug'];
  const sessionSlug =
    sessionSlugRaw === undefined
      ? undefined
      : typeof sessionSlugRaw === 'string' && sessionSlugRaw.trim() !== ''
        ? sessionSlugRaw
        : null;
  if (sessionSlug === null) {
    throw new Error('Invalid dialog reminder target: sessionSlug must be non-empty string');
  }
  return { agentId, rootDialogId, sessionSlug };
}

function parseDialogReminderRequestBatch(value: unknown): DomindsAppDialogReminderRequestBatch {
  if (!isRecord(value)) throw new Error('Invalid dialog reminder request batch: expected object');
  const reminderRequestsRaw = value['reminderRequests'];
  if (!Array.isArray(reminderRequestsRaw)) {
    throw new Error('Invalid dialog reminder request batch: reminderRequests must be an array');
  }
  return {
    target: parseDialogTargetRef(value['target']),
    reminderRequests: reminderRequestsRaw.map((request) => parseReminderRequest(request)),
  };
}

function isReminderState(value: unknown): value is DomindsAppReminderState {
  if (!isRecord(value)) return false;
  if (typeof value['content'] !== 'string') return false;
  const meta = value['meta'];
  if (meta !== undefined && !isJsonValue(meta)) return false;
  const echoback = value['echoback'];
  return echoback === undefined || typeof echoback === 'boolean';
}

function isReminderApplyResult(value: unknown): value is DomindsAppReminderApplyResult {
  if (!isRecord(value)) return false;
  const treatment = value['treatment'];
  if (treatment === 'noop') return true;
  if (treatment === 'add') {
    const position = value['position'];
    return (
      isReminderState(value['reminder']) &&
      (position === undefined || (typeof position === 'number' && Number.isFinite(position)))
    );
  }
  if (treatment === 'update') {
    return (
      typeof value['ownedIndex'] === 'number' &&
      Number.isFinite(value['ownedIndex']) &&
      isReminderState(value['reminder'])
    );
  }
  if (treatment === 'delete') {
    return typeof value['ownedIndex'] === 'number' && Number.isFinite(value['ownedIndex']);
  }
  return false;
}

function isReminderUpdateResult(value: unknown): value is DomindsAppHostReminderUpdateResult {
  if (!isRecord(value)) return false;
  const treatment = value['treatment'];
  if (treatment === 'drop' || treatment === 'keep') {
    return true;
  }
  if (treatment !== 'update') return false;
  if (typeof value['updatedContent'] !== 'string') return false;
  const updatedMeta = value['updatedMeta'];
  return updatedMeta === undefined || isJsonValue(updatedMeta);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  if (typeof value['type'] !== 'string') return false;
  if (typeof value['role'] !== 'string') return false;
  return true;
}

function normalizeToolResult(value: unknown): DomindsAppHostToolResult {
  if (isToolCallOutput(value)) {
    return { output: value };
  }
  if (!isRecord(value)) {
    throw new Error('Invalid app tool result: expected ToolCallOutput or structured object');
  }
  const output = value['output'];
  if (!isToolCallOutput(output)) {
    throw new Error('Invalid app tool result: output must be ToolCallOutput');
  }
  const reminderRequestsRaw = value['reminderRequests'];
  if (reminderRequestsRaw !== undefined && !Array.isArray(reminderRequestsRaw)) {
    throw new Error('Invalid app tool result: reminderRequests must be an array');
  }
  const dialogReminderRequestsRaw = value['dialogReminderRequests'];
  if (dialogReminderRequestsRaw !== undefined && !Array.isArray(dialogReminderRequestsRaw)) {
    throw new Error('Invalid app tool result: dialogReminderRequests must be an array');
  }
  return {
    output,
    reminderRequests:
      reminderRequestsRaw === undefined
        ? undefined
        : reminderRequestsRaw.map((request) => parseReminderRequest(request)),
    dialogReminderRequests:
      dialogReminderRequestsRaw === undefined
        ? undefined
        : dialogReminderRequestsRaw.map((batch) => parseDialogReminderRequestBatch(batch)),
  };
}

function send(msg: AppsHostMessageToKernel): void {
  if (typeof process.send !== 'function') {
    throw new Error(
      `apps-host: process.send is not available; must be started with child_process.fork (msg=${JSON.stringify(msg)})`,
    );
  }
  process.send(msg);
}

type RunningApp = Readonly<{
  appId: string;
  host: DomindsAppHostInstance;
  frontend: DomindsAppHostStartResult | null;
}>;

const runningApps = new Map<string, RunningApp>();
const toolHandlers = new Map<
  string,
  Readonly<{ appId: string; fn: DomindsAppHostInstance['tools'][string] }>
>();
const runControlHandlers = new Map<
  string,
  Readonly<{ appId: string; fn: NonNullable<DomindsAppHostInstance['runControls']>[string] }>
>();
const reminderOwnerHandlers = new Map<
  string,
  Readonly<{ appId: string; ownerRef: string; fn: DomindsAppReminderOwnerHandler }>
>();

function buildReminderOwnerHandlerKey(appId: string, ownerRef: string): string {
  return `${appId}::${ownerRef}`;
}

function pickExportedFactory(
  mod: unknown,
  exportName: string,
  moduleAbs: string,
): CreateDomindsAppHostFn {
  if (isRecord(mod) && typeof mod[exportName] === 'function') {
    return mod[exportName] as unknown as CreateDomindsAppHostFn;
  }
  if (
    isRecord(mod) &&
    isRecord(mod['default']) &&
    typeof mod['default'][exportName] === 'function'
  ) {
    return mod['default'][exportName] as unknown as CreateDomindsAppHostFn;
  }
  throw new Error(`Invalid app host module exports (${moduleAbs}): missing export '${exportName}'`);
}

function validateHostInstance(host: unknown, appId: string): DomindsAppHostInstance {
  if (!isRecord(host)) throw new Error(`Invalid app host instance for '${appId}': expected object`);
  const tools = host['tools'];
  if (!isRecord(tools))
    throw new Error(`Invalid app host instance for '${appId}': tools must be an object`);
  const start = host['start'];
  const shutdown = host['shutdown'];
  if (start !== undefined && typeof start !== 'function') {
    throw new Error(`Invalid app host instance for '${appId}': start must be a function`);
  }
  if (shutdown !== undefined && typeof shutdown !== 'function') {
    throw new Error(`Invalid app host instance for '${appId}': shutdown must be a function`);
  }
  const runControls = host['runControls'];
  if (runControls !== undefined && !isRecord(runControls)) {
    throw new Error(`Invalid app host instance for '${appId}': runControls must be an object`);
  }
  const reminderOwners = host['reminderOwners'];
  if (reminderOwners !== undefined && !isRecord(reminderOwners)) {
    throw new Error(`Invalid app host instance for '${appId}': reminderOwners must be an object`);
  }
  const toolFns: Record<string, unknown> = tools;
  for (const [name, fn] of Object.entries(toolFns)) {
    if (typeof fn !== 'function') {
      throw new Error(
        `Invalid app host instance for '${appId}': tools['${name}'] must be a function`,
      );
    }
  }
  if (runControls !== undefined) {
    const runControlFns = runControls as Record<string, unknown>;
    for (const [name, fn] of Object.entries(runControlFns)) {
      if (typeof fn !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': runControls['${name}'] must be a function`,
        );
      }
    }
  }
  if (reminderOwners !== undefined) {
    const reminderOwnerFns = reminderOwners as Record<string, unknown>;
    for (const [ownerRef, handler] of Object.entries(reminderOwnerFns)) {
      if (!isRecord(handler)) {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'] must be an object`,
        );
      }
      if (typeof handler['apply'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].apply must be a function`,
        );
      }
      if (typeof handler['updateReminder'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].updateReminder must be a function`,
        );
      }
      if (typeof handler['renderReminder'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].renderReminder must be a function`,
        );
      }
    }
  }
  return host as unknown as DomindsAppHostInstance;
}

function isValidRunControlResult(result: unknown): result is DomindsAppRunControlResult {
  if (!isRecord(result)) return false;
  if (result['kind'] === 'reject') {
    return typeof result['errorText'] === 'string' && result['errorText'].trim() !== '';
  }
  if (result['kind'] !== 'continue') return false;
  return true;
}

async function initOnce(msg: AppsHostKernelInitMessage): Promise<void> {
  for (const app of msg.apps) {
    if (runningApps.has(app.appId)) {
      throw new Error(`apps-host: duplicate appId in init: '${app.appId}'`);
    }
    const moduleAbs = path.resolve(
      app.installJson.package.rootAbs,
      app.installJson.host.moduleRelPath,
    );
    const mod = await dynamicImport(pathToFileURL(moduleAbs).href);
    const factory = pickExportedFactory(mod, app.installJson.host.exportName, moduleAbs);
    const appId = app.appId;
    const rtwsAppDirAbs = path.resolve(msg.rtwsRootAbs, '.apps', appId);
    const host = validateHostInstance(
      await factory({
        appId,
        rtwsRootAbs: msg.rtwsRootAbs,
        rtwsAppDirAbs,
        packageRootAbs: app.installJson.package.rootAbs,
        kernel: msg.kernel,
        log: (level, text, data) => {
          send({ type: 'log', level, msg: text, appId, data });
        },
      }),
      appId,
    );

    for (const [toolName, fn] of Object.entries(host.tools)) {
      if (toolHandlers.has(toolName)) {
        const existing = toolHandlers.get(toolName);
        throw new Error(
          `apps-host: duplicate tool name '${toolName}' between apps '${existing?.appId ?? 'unknown'}' and '${appId}'`,
        );
      }
      toolHandlers.set(toolName, { appId, fn });
    }
    if (host.runControls) {
      for (const [controlId, fn] of Object.entries(host.runControls)) {
        if (runControlHandlers.has(controlId)) {
          const existing = runControlHandlers.get(controlId);
          throw new Error(
            `apps-host: duplicate run-control id '${controlId}' between apps '${existing?.appId ?? 'unknown'}' and '${appId}'`,
          );
        }
        runControlHandlers.set(controlId, { appId, fn });
      }
    }
    if (host.reminderOwners) {
      for (const [ownerRef, fn] of Object.entries(host.reminderOwners)) {
        const handlerKey = buildReminderOwnerHandlerKey(appId, ownerRef);
        if (reminderOwnerHandlers.has(handlerKey)) {
          throw new Error(`apps-host: duplicate reminder owner '${ownerRef}' for app '${appId}'`);
        }
        reminderOwnerHandlers.set(handlerKey, { appId, ownerRef, fn });
      }
    }

    let frontend: DomindsAppHostStartResult | null = null;
    if (app.installJson.frontend) {
      if (!host.start) {
        throw new Error(
          `apps-host: app '${appId}' declares frontend but host instance has no start()`,
        );
      }
      frontend = await host.start({
        runtimePort: app.runtimePort,
        frontend: app.installJson.frontend,
      });
    }

    runningApps.set(appId, { appId, host, frontend });
    send({
      type: 'log',
      level: 'info',
      msg: frontend
        ? `App started (frontend port=${frontend.port} baseUrl=${frontend.baseUrl})`
        : `App loaded`,
      appId,
    });
  }

  send({
    type: 'ready',
    apps: [...runningApps.values()].map((a) => ({
      appId: a.appId,
      frontend: a.frontend
        ? { port: a.frontend.port, baseUrl: a.frontend.baseUrl, wsUrl: a.frontend.wsUrl }
        : null,
    })),
  });
}

async function shutdownAll(): Promise<void> {
  for (const app of runningApps.values()) {
    try {
      if (app.host.shutdown) await app.host.shutdown();
    } catch (err: unknown) {
      send({
        type: 'log',
        level: 'error',
        msg: `App shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        appId: app.appId,
      });
    }
  }
}

let initialized = false;
process.on('message', (raw: unknown) => {
  (async () => {
    const msg = parseAppsHostMessageFromKernel(raw);
    switch (msg.type) {
      case 'init':
        if (initialized) throw new Error('apps-host: init called more than once');
        initialized = true;
        await initOnce(msg);
        return;
      case 'tool_call': {
        const found = toolHandlers.get(msg.toolName);
        if (!found) {
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown tool: ${msg.toolName}`,
          });
          return;
        }
        try {
          const result = normalizeToolResult(await found.fn(msg.args, msg.ctx));
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: true,
            output: result.output,
            reminderRequests: result.reminderRequests,
            dialogReminderRequests: result.dialogReminderRequests,
          });
        } catch (err: unknown) {
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'run_control_apply': {
        const found = runControlHandlers.get(msg.controlId);
        if (!found) {
          send({
            type: 'run_control_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown run control: ${msg.controlId}`,
          });
          return;
        }
        try {
          const result = await found.fn(msg.payload);
          if (!isValidRunControlResult(result)) {
            send({
              type: 'run_control_result',
              callId: msg.callId,
              ok: false,
              errorText: `Invalid run control result shape: ${msg.controlId}`,
            });
            return;
          }
          send({ type: 'run_control_result', callId: msg.callId, ok: true, result });
        } catch (err: unknown) {
          send({
            type: 'run_control_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_apply': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_apply_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const result = await found.fn.apply(msg.request, msg.ctx);
          if (!isReminderApplyResult(result)) {
            send({
              type: 'reminder_apply_result',
              callId: msg.callId,
              ok: false,
              errorText: `Invalid reminder apply result shape: ${msg.appId}/${msg.ownerRef}`,
            });
            return;
          }
          send({ type: 'reminder_apply_result', callId: msg.callId, ok: true, result });
        } catch (err: unknown) {
          send({
            type: 'reminder_apply_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_update': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_update_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const result = await found.fn.updateReminder(msg.ctx);
          if (!isReminderUpdateResult(result)) {
            send({
              type: 'reminder_update_result',
              callId: msg.callId,
              ok: false,
              errorText: `Invalid reminder update result shape: ${msg.appId}/${msg.ownerRef}`,
            });
            return;
          }
          send({ type: 'reminder_update_result', callId: msg.callId, ok: true, result });
        } catch (err: unknown) {
          send({
            type: 'reminder_update_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_render': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_render_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const message = await found.fn.renderReminder(msg.ctx);
          if (!isChatMessage(message)) {
            send({
              type: 'reminder_render_result',
              callId: msg.callId,
              ok: false,
              errorText: `Invalid reminder render result shape: ${msg.appId}/${msg.ownerRef}`,
            });
            return;
          }
          send({ type: 'reminder_render_result', callId: msg.callId, ok: true, message });
        } catch (err: unknown) {
          send({
            type: 'reminder_render_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'shutdown':
        await shutdownAll();
        process.exit(0);
        return;
      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `apps-host: unreachable msg type '${(_exhaustive as unknown as { type: string }).type}'`,
        );
      }
    }
  })().catch((err: unknown) => {
    const errorText = err instanceof Error ? err.stack || err.message : String(err);
    try {
      send({
        type: 'log',
        level: 'error',
        msg: `apps-host fatal error: ${errorText}`,
        appId: null,
      });
    } catch {
      // ignore
    }
    log.error('apps-host fatal error', err instanceof Error ? err : new Error(String(err)));
    void shutdownAll().finally(() => process.exit(1));
  });
});

process.on('SIGTERM', () => {
  void shutdownAll().finally(() => process.exit(0));
});
