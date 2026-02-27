import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fsSync from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { createLogger } from '../log';
import type { ToolArguments, ToolCallOutput } from '../tool';
import type { DomindsAppRunControlContext, DomindsAppRunControlResult } from './app-host-contract';

import type { DomindsAppInstallJsonV1 } from '../apps/app-json';
import type {
  AppsHostKernelInitMessage,
  AppsHostKernelRunControlApplyMessage,
  AppsHostMessageFromKernel,
  AppsHostMessageToKernel,
} from './ipc-types';

const log = createLogger('apps-host-client');
const requireFn = createRequire(__filename);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseMessageToKernel(v: unknown): AppsHostMessageToKernel {
  if (!isRecord(v)) throw new Error('Invalid IPC message from apps-host: expected object');
  const type = asString(v['type']);
  if (!type) throw new Error('Invalid IPC message from apps-host: missing type');
  if (type === 'ready') {
    const apps = v['apps'];
    if (!Array.isArray(apps)) throw new Error('Invalid ready message: apps must be array');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'log') {
    const level = asString(v['level']);
    const msg = asString(v['msg']);
    if (level !== 'info' && level !== 'warn' && level !== 'error') {
      throw new Error(`Invalid log message: level must be info|warn|error`);
    }
    if (!msg) throw new Error('Invalid log message: msg required');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'tool_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid tool_result message: callId required');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'run_control_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid run_control_result message: callId required');
    return v as unknown as AppsHostMessageToKernel;
  }
  throw new Error(`Invalid IPC message from apps-host: unknown type '${type}'`);
}

export type EnabledAppForHost = Readonly<{
  appId: string;
  runtimePort: number | null;
  installJson: DomindsAppInstallJsonV1;
}>;

export type AppsHostClient = Readonly<{
  callTool: (
    toolName: string,
    args: ToolArguments,
    ctx: Readonly<{ dialogId: string; callerId: string }>,
  ) => Promise<ToolCallOutput>;
  applyRunControl: (
    controlId: string,
    payload: DomindsAppRunControlContext,
  ) => Promise<DomindsAppRunControlResult>;
  shutdown: () => Promise<void>;
}>;

export type AppsHostReadyMessage = Extract<AppsHostMessageToKernel, { type: 'ready' }>;

type PendingCall = Readonly<{
  resolve: (out: ToolCallOutput) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingRunControlCall = Readonly<{
  resolve: (out: DomindsAppRunControlResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

function resolveAppsHostEntrypointAbs():
  | { ok: true; scriptAbs: string; execArgv: string[] }
  | { ok: false; errorText: string } {
  // Prefer compiled JS in dist/ when available.
  // When running via tsx in dev-server, fall back to main/apps-host/host.ts with tsx loader.
  const distCandidate = path.resolve(__dirname, 'host.js');
  if (fsSync.existsSync(distCandidate)) {
    return { ok: true, scriptAbs: distCandidate, execArgv: [] };
  }
  const tsCandidate = path.resolve(__dirname, 'host.ts');
  if (fsSync.existsSync(tsCandidate)) {
    const tsxLoaderAbs = requireFn.resolve('tsx');
    return { ok: true, scriptAbs: tsCandidate, execArgv: ['--import', tsxLoaderAbs] };
  }
  return {
    ok: false,
    errorText: `Cannot find apps-host entrypoint at ${distCandidate} or ${tsCandidate}`,
  };
}

export async function startAppsHost(params: {
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
  apps: ReadonlyArray<EnabledAppForHost>;
}): Promise<Readonly<{ client: AppsHostClient; ready: AppsHostReadyMessage }>> {
  const entry = resolveAppsHostEntrypointAbs();
  if (!entry.ok) throw new Error(entry.errorText);

  const child: ChildProcess = fork(entry.scriptAbs, [], {
    execArgv: entry.execArgv,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  if (!child.send) {
    throw new Error('Failed to start apps-host: child process has no IPC channel');
  }

  const pendingTools = new Map<string, PendingCall>();
  const pendingRunControls = new Map<string, PendingRunControlCall>();
  let ready = false;
  let readyMsg: AppsHostReadyMessage | null = null;

  let readyResolve: ((msg: AppsHostReadyMessage) => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<AppsHostReadyMessage>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimeout = setTimeout(() => {
    readyReject?.(new Error('apps-host init timed out waiting for ready message'));
  }, 30_000);

  const failAllPending = (err: Error): void => {
    for (const p of pendingTools.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingTools.clear();
    for (const p of pendingRunControls.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingRunControls.clear();
  };

  child.on('exit', (code, signal) => {
    const err = new Error(`apps-host exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    readyReject?.(err);
    failAllPending(err);
  });

  child.on('message', (raw: unknown) => {
    try {
      const msg = parseMessageToKernel(raw);
      if (msg.type === 'log') {
        const prefix = msg.appId ? `[${msg.appId}]` : '';
        if (msg.level === 'info') log.info(`apps-host ${prefix} ${msg.msg}`, undefined, msg.data);
        else if (msg.level === 'warn')
          log.warn(`apps-host ${prefix} ${msg.msg}`, undefined, msg.data);
        else log.error(`apps-host ${prefix} ${msg.msg}`, undefined, msg.data);
        return;
      }
      if (msg.type === 'ready') {
        ready = true;
        readyMsg = msg;
        clearTimeout(readyTimeout);
        readyResolve?.(msg);
        log.info(`apps-host ready (${msg.apps.length} apps)`);
        return;
      }
      if (msg.type === 'tool_result') {
        const p = pendingTools.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected tool_result for unknown callId: ${msg.callId}`);
        }
        pendingTools.delete(msg.callId);
        clearTimeout(p.timeout);
        if (msg.ok) p.resolve(msg.output);
        else p.reject(new Error(msg.errorText));
        return;
      }
      if (msg.type === 'run_control_result') {
        const p = pendingRunControls.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected run_control_result for unknown callId: ${msg.callId}`);
        }
        pendingRunControls.delete(msg.callId);
        clearTimeout(p.timeout);
        if (!msg.ok) {
          p.reject(new Error(msg.errorText));
          return;
        }
        p.resolve(msg.result);
      }
    } catch (err: unknown) {
      log.error(
        'Failed to handle message from apps-host',
        err instanceof Error ? err : new Error(String(err)),
      );
      failAllPending(err instanceof Error ? err : new Error(String(err)));
      readyReject?.(err instanceof Error ? err : new Error(String(err)));
      child.kill('SIGTERM');
    }
  });

  const initMsg: AppsHostKernelInitMessage = {
    type: 'init',
    rtwsRootAbs: params.rtwsRootAbs,
    kernel: params.kernel,
    apps: params.apps,
  };
  child.send(initMsg);

  const readyResult = await readyPromise;

  const callTool: AppsHostClient['callTool'] = async (toolName, args, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (tool=${toolName})`);
    }
    const callId = randomUUID();
    const msg: AppsHostMessageFromKernel = { type: 'tool_call', callId, toolName, args, ctx };
    return await new Promise<ToolCallOutput>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error(`apps-host tool call timed out: tool=${toolName} callId=${callId}`));
      }, 60_000);
      pendingTools.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const applyRunControl: AppsHostClient['applyRunControl'] = async (controlId, payload) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (runControl=${controlId})`);
    }
    const callId = randomUUID();
    const msg: AppsHostKernelRunControlApplyMessage = {
      type: 'run_control_apply',
      callId,
      controlId,
      payload,
    };
    return await new Promise<DomindsAppRunControlResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRunControls.delete(callId);
        reject(
          new Error(`apps-host run control timed out: runControl=${controlId} callId=${callId}`),
        );
      }, 60_000);
      pendingRunControls.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const shutdown: AppsHostClient['shutdown'] = async () => {
    try {
      child.send({ type: 'shutdown' } satisfies AppsHostMessageFromKernel);
    } catch (err: unknown) {
      log.warn(
        'Failed to send shutdown to apps-host',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    failAllPending(new Error('apps-host shutdown'));
  };

  if (!readyMsg) {
    throw new Error('apps-host: internal error (readyMsg missing after readyPromise resolved)');
  }
  return { client: { callTool, applyRunControl, shutdown }, ready: readyResult };
}
