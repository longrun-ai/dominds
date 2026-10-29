import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fsSync from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

import type {
  DomindsAppReminderOwnerApplyContext,
  DomindsAppReminderOwnerRenderContext,
  DomindsAppReminderOwnerUpdateContext,
  DomindsAppReminderRenderedMessage,
  DomindsKernelEndpoint,
} from '@longrun-ai/kernel/app-host-contract';
import {
  isJsonValue,
  parseDomindsAppInstallJson,
  type DomindsAppHostReminderUpdateResult,
  type DomindsAppHostToolResult,
  type DomindsAppInstallJson,
  type DomindsAppReminderApplyRequest,
  type DomindsAppReminderApplyResult,
  type DomindsAppReminderState,
} from '@longrun-ai/kernel/app-json';
import { createLogger } from '../log';
import type { ToolArguments } from '../tool';
import type {
  AppsHostKernelInitMessage,
  AppsHostKernelReminderApplyMessage,
  AppsHostKernelReminderRenderMessage,
  AppsHostKernelReminderUpdateMessage,
  AppsHostMessageFromKernel,
  AppsHostMessageToKernel,
} from './ipc-types';
import { parseAppsHostMessageFromKernel, parseAppsHostMessageToKernel } from './ipc-types';

const log = createLogger('apps-host-client');
const requireFn = createRequire(__filename);

function assertJsonValueForIpc(value: unknown, label: string): void {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be a lossless JSON value`);
  }
}

function buildReminderStateForIpc(
  state: DomindsAppReminderState,
  label: string,
): DomindsAppReminderState {
  if (state.meta !== undefined) {
    assertJsonValueForIpc(state.meta, `${label}.meta`);
  }
  return {
    content: state.content,
    ...(state.meta === undefined ? {} : { meta: state.meta }),
    ...(state.echoback === undefined ? {} : { echoback: state.echoback }),
    ...(state.renderMode === undefined ? {} : { renderMode: state.renderMode }),
  };
}

function buildReminderApplyRequestForIpc(
  request: DomindsAppReminderApplyRequest,
  label: string,
): DomindsAppReminderApplyRequest {
  if (request.meta !== undefined) {
    assertJsonValueForIpc(request.meta, `${label}.meta`);
  }
  if (request.kind === 'delete') {
    return {
      kind: request.kind,
      ownerRef: request.ownerRef,
      ...(request.meta === undefined ? {} : { meta: request.meta }),
    };
  }
  return {
    kind: request.kind,
    ownerRef: request.ownerRef,
    content: request.content,
    ...(request.meta === undefined ? {} : { meta: request.meta }),
    ...(request.position === undefined ? {} : { position: request.position }),
    ...(request.echoback === undefined ? {} : { echoback: request.echoback }),
    ...(request.renderMode === undefined ? {} : { renderMode: request.renderMode }),
  };
}

function buildInstallJsonForIpc(
  installJson: DomindsAppInstallJson,
  appId: string,
): DomindsAppInstallJson {
  const parsed = parseDomindsAppInstallJson(installJson);
  if (!parsed.ok) {
    throw new Error(`Invalid apps-host install json for '${appId}': ${parsed.errorText}`);
  }
  return parsed.json;
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
  ) => Promise<DomindsAppReminderRenderedMessage>;
  shutdown: () => Promise<void>;
}>;

export type AppsHostReadyMessage = Extract<AppsHostMessageToKernel, { type: 'ready' }>;

type PendingCall = Readonly<{
  resolve: (out: DomindsAppHostToolResult) => void;
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
  resolve: (out: DomindsAppReminderRenderedMessage) => void;
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
    return {
      ok: true,
      scriptAbs: tsCandidate,
      execArgv: ['--import', pathToFileURL(tsxLoaderAbs).href],
    };
  }
  return {
    ok: false,
    errorText: `Cannot find apps-host entrypoint at ${distCandidate} or ${tsCandidate}`,
  };
}

export async function startAppsHost(params: {
  rtwsRootAbs: string;
  kernel: DomindsKernelEndpoint;
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
    clearTimeout(readyTimeout);
    readyReject?.(err);
    failAllPending(err);
  });

  child.on('message', (raw: unknown) => {
    try {
      const msg = parseAppsHostMessageToKernel(raw);
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
            ...(msg.reminderRequests === undefined
              ? {}
              : { reminderRequests: msg.reminderRequests }),
            ...(msg.dialogReminderRequests === undefined
              ? {}
              : { dialogReminderRequests: msg.dialogReminderRequests }),
          });
        } else p.reject(new Error(msg.errorText));
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
    kernel: {
      scheme: params.kernel.scheme,
      host: params.kernel.host,
      port: params.kernel.port,
    },
    apps: params.apps.map((app) => ({
      appId: app.appId,
      runtimePort: app.runtimePort,
      installJson: buildInstallJsonForIpc(app.installJson, app.appId),
    })),
  };
  child.send(parseAppsHostMessageFromKernel(initMsg));

  const readyResult = await readyPromise;

  const callTool: AppsHostClient['callTool'] = async (toolName, args, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (tool=${toolName})`);
    }
    assertJsonValueForIpc(args, `apps-host tool arguments for '${toolName}'`);
    const callId = randomUUID();
    const msg = parseAppsHostMessageFromKernel({
      type: 'tool_call',
      callId,
      toolName,
      args,
      ctx: {
        dialogId: ctx.dialogId,
        mainDialogId: ctx.mainDialogId,
        agentId: ctx.agentId,
        taskDocPath: ctx.taskDocPath,
        ...(ctx.sessionSlug === undefined ? {} : { sessionSlug: ctx.sessionSlug }),
        callerId: ctx.callerId,
      },
    } satisfies AppsHostMessageFromKernel);
    return await new Promise<DomindsAppHostToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error(`apps-host tool call timed out: tool=${toolName} callId=${callId}`));
      }, 60_000);
      pendingTools.set(callId, { resolve, reject, timeout });
      child.send(msg);
    });
  };

  const applyReminder: AppsHostClient['applyReminder'] = async (appId, ownerRef, request, ctx) => {
    if (!ready) {
      throw new Error(`apps-host is not ready yet (reminderOwner=${appId}/${ownerRef})`);
    }
    if (request.meta !== undefined) {
      assertJsonValueForIpc(
        request.meta,
        `apps-host reminder apply request meta for '${appId}/${ownerRef}'`,
      );
    }
    if (
      request.kind === 'upsert' &&
      request.position !== undefined &&
      (!Number.isFinite(request.position) || Object.is(request.position, -0))
    ) {
      throw new Error(
        `apps-host reminder apply request position for '${appId}/${ownerRef}' must be a lossless finite number`,
      );
    }
    for (const [index, reminder] of ctx.ownedReminders.entries()) {
      if (reminder.meta !== undefined) {
        assertJsonValueForIpc(
          reminder.meta,
          `apps-host reminder apply context ownedReminders[${index}].meta for '${appId}/${ownerRef}'`,
        );
      }
    }
    const callId = randomUUID();
    const msg = parseAppsHostMessageFromKernel({
      type: 'reminder_apply',
      callId,
      appId,
      ownerRef,
      request: buildReminderApplyRequestForIpc(
        request,
        `apps-host reminder apply request for '${appId}/${ownerRef}'`,
      ),
      ctx: {
        dialogId: ctx.dialogId,
        ownedReminders: ctx.ownedReminders.map((reminder, index) =>
          buildReminderStateForIpc(
            reminder,
            `apps-host reminder apply context ownedReminders[${index}] for '${appId}/${ownerRef}'`,
          ),
        ),
      },
    } satisfies AppsHostKernelReminderApplyMessage);
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
    if (ctx.reminder.meta !== undefined) {
      assertJsonValueForIpc(
        ctx.reminder.meta,
        `apps-host reminder update context meta for '${appId}/${ownerRef}'`,
      );
    }
    const callId = randomUUID();
    const msg = parseAppsHostMessageFromKernel({
      type: 'reminder_update',
      callId,
      appId,
      ownerRef,
      ctx: {
        dialogId: ctx.dialogId,
        reminder: buildReminderStateForIpc(
          ctx.reminder,
          `apps-host reminder update context for '${appId}/${ownerRef}'`,
        ),
      },
    } satisfies AppsHostKernelReminderUpdateMessage);
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
    if (ctx.reminder.meta !== undefined) {
      assertJsonValueForIpc(
        ctx.reminder.meta,
        `apps-host reminder render context meta for '${appId}/${ownerRef}'`,
      );
    }
    const callId = randomUUID();
    const msg = parseAppsHostMessageFromKernel({
      type: 'reminder_render',
      callId,
      appId,
      ownerRef,
      ctx: {
        dialogId: ctx.dialogId,
        reminder: buildReminderStateForIpc(
          ctx.reminder,
          `apps-host reminder render context for '${appId}/${ownerRef}'`,
        ),
        reminderId: ctx.reminderId,
        workLanguage: ctx.workLanguage,
      },
    } satisfies AppsHostKernelReminderRenderMessage);
    return await new Promise<DomindsAppReminderRenderedMessage>((resolve, reject) => {
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
      child.send(parseAppsHostMessageFromKernel({ type: 'shutdown' }));
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
      applyReminder,
      updateReminder,
      renderReminder,
      shutdown,
    },
    ready: readyResult,
  };
}
