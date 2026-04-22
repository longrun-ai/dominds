import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fsSync from 'fs';
import { createRequire } from 'module';
import path from 'path';

import type {
  DomindsAppDynamicToolsetsContext,
  DomindsAppReminderOwnerApplyContext,
  DomindsAppReminderOwnerRenderContext,
  DomindsAppReminderOwnerUpdateContext,
  DomindsAppRunControlContext,
  DomindsAppRunControlResult,
} from '@longrun-ai/kernel/app-host-contract';
import type {
  DomindsAppDialogReminderRequestBatch,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolResult,
  DomindsAppInstallJson,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
} from '@longrun-ai/kernel/app-json';
import type { ChatMessage } from '../llm/client';
import { createLogger } from '../log';
import type { ToolArguments } from '../tool';
import type {
  AppsHostKernelDynamicToolsetsMessage,
  AppsHostKernelInitMessage,
  AppsHostKernelReminderApplyMessage,
  AppsHostKernelReminderRenderMessage,
  AppsHostKernelReminderUpdateMessage,
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

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
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
  if (type === 'dynamic_toolsets_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid dynamic_toolsets_result message: callId required');
    const ok = v['ok'];
    if (ok === true) {
      const toolsetIds = asStringArray(v['toolsetIds']);
      if (toolsetIds === null) {
        throw new Error('Invalid dynamic_toolsets_result message: toolsetIds must be string[]');
      }
      return { type, callId, ok: true, toolsetIds };
    }
    if (ok === false) {
      const errorText = asString(v['errorText']);
      if (!errorText) {
        throw new Error(
          'Invalid dynamic_toolsets_result message: errorText required when ok=false',
        );
      }
      return { type, callId, ok: false, errorText };
    }
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'reminder_apply_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid reminder_apply_result message: callId required');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'reminder_update_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid reminder_update_result message: callId required');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'reminder_render_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid reminder_render_result message: callId required');
    return v as unknown as AppsHostMessageToKernel;
  }
  if (type === 'run_control_result') {
    const callId = asString(v['callId']);
    if (!callId) throw new Error('Invalid run_control_result message: callId required');
    const ok = v['ok'];
    if (ok === true) {
      return {
        type,
        callId,
        ok: true,
        result: v['result'] as DomindsAppRunControlResult,
      };
    }
    if (ok === false) {
      const errorText = asString(v['errorText']);
      if (!errorText) {
        throw new Error('Invalid run_control_result message: errorText required when ok=false');
      }
      return { type, callId, ok: false, errorText };
    }
    return v as unknown as AppsHostMessageToKernel;
  }
  throw new Error(`Invalid IPC message from apps-host: unknown type '${type}'`);
}

export type EnabledAppForHost = Readonly<{
  appId: string;
  runtimePort: number | null;
  installJson: DomindsAppInstallJson;
  hostSourceVersion: string | null;
}>;

export type AppsHostClient = Readonly<{
  callTool: (
    toolName: string,
    args: ToolArguments,
    ctx: Readonly<{
      dialogId: string;
      mainDialogId: string;
      agentId: string;
      taskDocPath: string;
      sessionSlug?: string;
      callerId: string;
    }>,
  ) => Promise<DomindsAppHostToolResult>;
  listDynamicToolsets: (ctx: DomindsAppDynamicToolsetsContext) => Promise<readonly string[]>;
  applyRunControl: (
    controlId: string,
    payload: DomindsAppRunControlContext,
  ) => Promise<DomindsAppRunControlResult>;
  applyReminder: (
    appId: string,
    ownerRef: string,
    request: DomindsAppReminderApplyRequest,
    ctx: DomindsAppReminderOwnerApplyContext,
  ) => Promise<DomindsAppReminderApplyResult>;
  updateReminder: (
    appId: string,
    ownerRef: string,
    ctx: DomindsAppReminderOwnerUpdateContext,
  ) => Promise<DomindsAppHostReminderUpdateResult>;
  renderReminder: (
    appId: string,
    ownerRef: string,
    ctx: DomindsAppReminderOwnerRenderContext,
  ) => Promise<ChatMessage>;
  shutdown: () => Promise<void>;
}>;

export type AppsHostReadyMessage = Extract<AppsHostMessageToKernel, { type: 'ready' }>;

type PendingCall = Readonly<{
  resolve: (out: DomindsAppHostToolResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingRunControlCall = Readonly<{
  resolve: (out: DomindsAppRunControlResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingDynamicToolsetsCall = Readonly<{
  resolve: (out: readonly string[]) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingReminderApplyCall = Readonly<{
  resolve: (out: DomindsAppReminderApplyResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingReminderUpdateCall = Readonly<{
  resolve: (out: DomindsAppHostReminderUpdateResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}>;

type PendingReminderRenderCall = Readonly<{
  resolve: (out: ChatMessage) => void;
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
  const pendingDynamicToolsets = new Map<string, PendingDynamicToolsetsCall>();
  const pendingRunControls = new Map<string, PendingRunControlCall>();
  const pendingReminderApplies = new Map<string, PendingReminderApplyCall>();
  const pendingReminderUpdates = new Map<string, PendingReminderUpdateCall>();
  const pendingReminderRenders = new Map<string, PendingReminderRenderCall>();
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
    for (const p of pendingDynamicToolsets.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingDynamicToolsets.clear();
    for (const p of pendingRunControls.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingRunControls.clear();
    for (const p of pendingReminderApplies.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingReminderApplies.clear();
    for (const p of pendingReminderUpdates.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingReminderUpdates.clear();
    for (const p of pendingReminderRenders.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    pendingReminderRenders.clear();
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
        if (msg.ok) {
          p.resolve({
            output: msg.output,
            reminderRequests: msg.reminderRequests,
            dialogReminderRequests: msg.dialogReminderRequests as
              | ReadonlyArray<DomindsAppDialogReminderRequestBatch>
              | undefined,
          });
        } else p.reject(new Error(msg.errorText));
        return;
      }
      if (msg.type === 'dynamic_toolsets_result') {
        const p = pendingDynamicToolsets.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected dynamic_toolsets_result for unknown callId: ${msg.callId}`);
        }
        pendingDynamicToolsets.delete(msg.callId);
        clearTimeout(p.timeout);
        if (!msg.ok) {
          p.reject(new Error(msg.errorText));
          return;
        }
        p.resolve(msg.toolsetIds);
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
        return;
      }
      if (msg.type === 'reminder_apply_result') {
        const p = pendingReminderApplies.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected reminder_apply_result for unknown callId: ${msg.callId}`);
        }
        pendingReminderApplies.delete(msg.callId);
        clearTimeout(p.timeout);
        if (!msg.ok) {
          p.reject(new Error(msg.errorText));
          return;
        }
        p.resolve(msg.result);
        return;
      }
      if (msg.type === 'reminder_update_result') {
        const p = pendingReminderUpdates.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected reminder_update_result for unknown callId: ${msg.callId}`);
        }
        pendingReminderUpdates.delete(msg.callId);
        clearTimeout(p.timeout);
        if (!msg.ok) {
          p.reject(new Error(msg.errorText));
          return;
        }
        p.resolve(msg.result);
        return;
      }
      if (msg.type === 'reminder_render_result') {
        const p = pendingReminderRenders.get(msg.callId);
        if (!p) {
          throw new Error(`Unexpected reminder_render_result for unknown callId: ${msg.callId}`);
        }
        pendingReminderRenders.delete(msg.callId);
        clearTimeout(p.timeout);
        if (!msg.ok) {
          p.reject(new Error(msg.errorText));
          return;
        }
        p.resolve(msg.message);
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
    return await new Promise<DomindsAppHostToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error(`apps-host tool call timed out: tool=${toolName} callId=${callId}`));
      }, 60_000);
      pendingTools.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const listDynamicToolsets: AppsHostClient['listDynamicToolsets'] = async (ctx) => {
    if (!ready) {
      throw new Error('apps-host is not ready yet (dynamicToolsets)');
    }
    const callId = randomUUID();
    const msg: AppsHostKernelDynamicToolsetsMessage = {
      type: 'dynamic_toolsets',
      callId,
      ctx,
    };
    return await new Promise<readonly string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingDynamicToolsets.delete(callId);
        reject(new Error(`apps-host dynamic toolsets call timed out: callId=${callId}`));
      }, 60_000);
      pendingDynamicToolsets.set(callId, { resolve, reject, timeout });
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

  const applyReminder: AppsHostClient['applyReminder'] = async (appId, ownerRef, request, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (reminderOwner=${appId}/${ownerRef})`);
    }
    const callId = randomUUID();
    const msg: AppsHostKernelReminderApplyMessage = {
      type: 'reminder_apply',
      callId,
      appId,
      ownerRef,
      request,
      ctx,
    };
    return await new Promise<DomindsAppReminderApplyResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingReminderApplies.delete(callId);
        reject(
          new Error(
            `apps-host reminder apply timed out: owner=${appId}/${ownerRef} callId=${callId}`,
          ),
        );
      }, 60_000);
      pendingReminderApplies.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const updateReminder: AppsHostClient['updateReminder'] = async (appId, ownerRef, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (reminderOwner=${appId}/${ownerRef})`);
    }
    const callId = randomUUID();
    const msg: AppsHostKernelReminderUpdateMessage = {
      type: 'reminder_update',
      callId,
      appId,
      ownerRef,
      ctx,
    };
    return await new Promise<DomindsAppHostReminderUpdateResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingReminderUpdates.delete(callId);
        reject(
          new Error(
            `apps-host reminder update timed out: owner=${appId}/${ownerRef} callId=${callId}`,
          ),
        );
      }, 60_000);
      pendingReminderUpdates.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const renderReminder: AppsHostClient['renderReminder'] = async (appId, ownerRef, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (reminderOwner=${appId}/${ownerRef})`);
    }
    const callId = randomUUID();
    const msg: AppsHostKernelReminderRenderMessage = {
      type: 'reminder_render',
      callId,
      appId,
      ownerRef,
      ctx,
    };
    return await new Promise<ChatMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingReminderRenders.delete(callId);
        reject(
          new Error(
            `apps-host reminder render timed out: owner=${appId}/${ownerRef} callId=${callId}`,
          ),
        );
      }, 60_000);
      pendingReminderRenders.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const shutdown: AppsHostClient['shutdown'] = async () => {
    const awaitChildExit = (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const cleanup = (): void => {
          child.off('exit', onExit);
          child.off('error', onError);
          clearTimeout(timeout);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onExit = (): void => {
          finish();
        };
        const onError = (): void => {
          finish();
        };
        const timeout = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch (err: unknown) {
            log.warn(
              'Failed to SIGTERM timed-out apps-host during shutdown',
              err instanceof Error ? err : new Error(String(err)),
            );
          }
          finish();
        }, 5_000);
        child.once('exit', onExit);
        child.once('error', onError);
      });
    };

    try {
      child.send({ type: 'shutdown' } satisfies AppsHostMessageFromKernel);
    } catch (err: unknown) {
      log.warn(
        'Failed to send shutdown to apps-host',
        err instanceof Error ? err : new Error(String(err)),
      );
      try {
        child.kill('SIGTERM');
      } catch (killErr: unknown) {
        log.warn(
          'Failed to SIGTERM apps-host after shutdown send failure',
          killErr instanceof Error ? killErr : new Error(String(killErr)),
        );
      }
    }
    failAllPending(new Error('apps-host shutdown'));
    await awaitChildExit();
  };

  if (!readyMsg) {
    throw new Error('apps-host: internal error (readyMsg missing after readyPromise resolved)');
  }
  return {
    client: {
      callTool,
      listDynamicToolsets,
      applyRunControl,
      applyReminder,
      updateReminder,
      renderReminder,
      shutdown,
    },
    ready: readyResult,
  };
}
