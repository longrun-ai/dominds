#!/usr/bin/env node

import path from 'path';
import { pathToFileURL } from 'url';

import { createLogger } from '../log';

import type {
  CreateDomindsAppHostFn,
  DomindsAppHostInstance,
  DomindsAppHostStartResult,
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
          const output = await found.fn(msg.args, msg.ctx);
          send({ type: 'tool_result', callId: msg.callId, ok: true, output });
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
