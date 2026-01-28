import * as fs from 'fs';
import * as path from 'path';
import type { Dialog } from '../dialog';
import { createLogger } from '../log';
import { reconcileProblemsByPrefix, removeProblemsByPrefix, upsertProblem } from '../problems';
import type { WorkspaceProblem } from '../shared/types/problems';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Tool, ToolArguments } from '../tool';
import {
  getReminderOwner,
  registerTool,
  registerToolset,
  setToolsetMeta,
  toolsetsRegistry,
  toolsRegistry,
  unregisterTool,
  unregisterToolset,
} from '../tools/registry';
import type { McpServerConfig, McpStreamableHttpServerConfig, McpWorkspaceConfig } from './config';
import { parseMcpYaml } from './config';
import { McpSdkClient, type McpListedTool } from './sdk-client';
import { McpServerRuntime } from './server-runtime';
import {
  applyToolNameTransforms,
  decideToolExposure,
  isValidProviderToolName,
  TOOL_NAME_VALIDITY_RULE,
} from './tool-names';

const log = createLogger('mcp/supervisor');

const MCP_YAML_PATH = path.join('.minds', 'mcp.yaml');

type ServerState = {
  serverId: string;
  toolsetName: string;
  configFingerprint: string;
  cfg: McpServerConfig;
  listedTools: readonly McpListedTool[];
  dispatch: McpServerDispatch;
  tools: Tool[];
  ownedToolNames: Set<string>;
  problems: WorkspaceProblem[];
};

const serverStateById: Map<string, ServerState> = new Map();
const toolOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();
const toolsetOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();

type LeaseReminderMeta = Readonly<{
  kind: 'mcp_lease';
  serverId: string;
}>;

function makeLeaseReminderMeta(serverId: string): LeaseReminderMeta {
  return { kind: 'mcp_lease', serverId };
}

function isLeaseReminderMeta(value: unknown): value is LeaseReminderMeta {
  if (!isRecord(value) || Array.isArray(value)) return false;
  if (value.kind !== 'mcp_lease') return false;
  return typeof value.serverId === 'string' && value.serverId.trim().length > 0;
}

function ensureLeaseReminder(dlg: Dialog, serverId: string): void {
  for (const r of dlg.reminders) {
    if (!r.owner) continue;
    if (r.owner.name !== 'mcpLease') continue;
    const meta = r.meta;
    if (!isLeaseReminderMeta(meta)) continue;
    if (meta.serverId !== serverId) continue;
    return;
  }

  const owner = getReminderOwner('mcpLease');
  const content =
    `MCP toolset leased: ${serverId}\n\n` +
    `This MCP server is treated as non-stateless. When you are confident you won't need it again soon, release it:\n` +
    `mcp_release({"serverId":"${serverId}"})`;
  dlg.addReminder(content, owner, makeLeaseReminderMeta(serverId));
}

class McpServerDispatch {
  public readonly serverId: string;
  public readonly toolsetName: string;
  public readonly cfg: McpServerConfig;

  private readonly sharedRuntime: McpServerRuntime | undefined;
  private readonly leasesByDialogKey: Map<string, McpServerRuntime> = new Map();
  private readonly leaseInitByDialogKey: Map<string, Promise<McpServerRuntime>> = new Map();
  private readonly canceledLeaseDialogs: Set<string> = new Set();

  private stopRequested: boolean = false;

  constructor(params: {
    serverId: string;
    toolsetName: string;
    cfg: McpServerConfig;
    sharedRuntime?: McpServerRuntime;
  }) {
    this.serverId = params.serverId;
    this.toolsetName = params.toolsetName;
    this.cfg = params.cfg;
    this.sharedRuntime = params.sharedRuntime;
  }

  public hasLeaseForDialog(dialogKey: string): boolean {
    return this.leasesByDialogKey.has(dialogKey) || this.leaseInitByDialogKey.has(dialogKey);
  }

  public releaseLeaseForDialog(dialogKey: string): boolean {
    const init = this.leaseInitByDialogKey.get(dialogKey);
    if (init) {
      this.canceledLeaseDialogs.add(dialogKey);
      // Best-effort: allow the in-flight connect to complete, then immediately stop it.
      void init
        .then((rt) => rt.requestStop({ forceKillAfterMs: 3_000 }))
        .catch(() => {
          // ignore
        });
      this.leaseInitByDialogKey.delete(dialogKey);
    }

    const existing = this.leasesByDialogKey.get(dialogKey);
    if (!existing) return false;
    this.leasesByDialogKey.delete(dialogKey);
    existing.requestStop({ forceKillAfterMs: 3_000 });
    return true;
  }

  public requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.sharedRuntime) {
      this.sharedRuntime.requestStop({ forceKillAfterMs: 3_000 });
    }
    for (const rt of this.leasesByDialogKey.values()) {
      rt.requestStop({ forceKillAfterMs: 3_000 });
    }
    for (const [dialogKey, init] of this.leaseInitByDialogKey.entries()) {
      this.canceledLeaseDialogs.add(dialogKey);
      void init
        .then((rt) => rt.requestStop({ forceKillAfterMs: 3_000 }))
        .catch(() => {
          // ignore
        });
    }
  }

  public async callToolForDialog(
    dlg: Dialog,
    mcpToolName: string,
    args: ToolArguments,
  ): Promise<string> {
    if (this.cfg.truelyStateless) {
      if (!this.sharedRuntime) {
        throw new Error(`MCP server '${this.serverId}' missing shared runtime`);
      }
      return await this.sharedRuntime.callTool(mcpToolName, args);
    }

    const dialogKey = dlg.id.key();
    const existing = this.leasesByDialogKey.get(dialogKey);
    if (existing) {
      return await existing.callTool(mcpToolName, args);
    }

    if (this.stopRequested) {
      const oneShot = await this.connectNewLeaseRuntime();
      oneShot.requestStop({ forceKillAfterMs: 3_000 });
      return await oneShot.callTool(mcpToolName, args);
    }

    let init = this.leaseInitByDialogKey.get(dialogKey);
    if (!init) {
      this.canceledLeaseDialogs.delete(dialogKey);
      init = (async () => {
        try {
          const rt = await this.connectNewLeaseRuntime();
          this.finalizeLeaseForDialog(dialogKey, rt);
          return rt;
        } catch (err) {
          this.leaseInitByDialogKey.delete(dialogKey);
          this.canceledLeaseDialogs.delete(dialogKey);
          throw err;
        }
      })();
      this.leaseInitByDialogKey.set(dialogKey, init);
    }

    const runtime = await init;
    this.attachLeaseReminder(dlg);
    return await runtime.callTool(mcpToolName, args);
  }

  private async connectNewLeaseRuntime(): Promise<McpServerRuntime> {
    const serverId = this.serverId;
    const client =
      this.cfg.transport === 'stdio'
        ? await McpSdkClient.connectStdio({
            serverId,
            command: this.cfg.command,
            args: this.cfg.args,
            env: buildChildEnv(this.cfg, serverId),
            cwd: process.cwd(),
          })
        : await McpSdkClient.connectStreamableHttp({
            serverId,
            url: this.cfg.url,
            headers: buildHttpHeaders(this.cfg, serverId),
            sessionId: this.cfg.sessionId,
          });

    const runtime = new McpServerRuntime({
      serverId: this.serverId,
      toolsetName: this.toolsetName,
      client,
    });

    return runtime;
  }

  public finalizeLeaseForDialog(dialogKey: string, runtime: McpServerRuntime): void {
    this.leaseInitByDialogKey.delete(dialogKey);
    if (this.canceledLeaseDialogs.has(dialogKey)) {
      this.canceledLeaseDialogs.delete(dialogKey);
      runtime.requestStop({ forceKillAfterMs: 3_000 });
      return;
    }
    if (this.stopRequested) {
      runtime.requestStop({ forceKillAfterMs: 3_000 });
      return;
    }
    this.leasesByDialogKey.set(dialogKey, runtime);
  }

  public attachLeaseReminder(dlg: Dialog): void {
    if (this.cfg.truelyStateless) return;
    ensureLeaseReminder(dlg, this.serverId);
  }
}

export function isMcpToolsetLeasedToDialog(serverId: string, dialogKey: string): boolean {
  const state = serverStateById.get(serverId);
  if (!state) return false;
  return state.dispatch.hasLeaseForDialog(dialogKey);
}

export function releaseMcpToolsetLeaseForDialog(
  serverId: string,
  dialogKey: string,
): { ok: true; released: boolean } | { ok: false; errorText: string } {
  const state = serverStateById.get(serverId);
  if (!state) {
    return { ok: false, errorText: `MCP server '${serverId}' is not loaded` };
  }
  if (state.cfg.truelyStateless) {
    return { ok: true, released: false };
  }
  const released = state.dispatch.releaseLeaseForDialog(dialogKey);
  return { ok: true, released };
}

let mindsDirWatcher: fs.FSWatcher | undefined;
let workspaceWatcher: fs.FSWatcher | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let lastSeenMtimeMs: number | undefined;
let reloadChain: Promise<void> = Promise.resolve();

export function startMcpSupervisor(): void {
  reloadChain = reloadChain
    .then(async () => await reloadNow('startup'))
    .catch((err) => {
      log.warn('MCP initial load failed', err);
    });

  // Best-effort file watch (fast feedback). `.minds/` may be wiped/recreated during a dev session,
  // so watcher setup must be resilient and re-attempted at runtime.
  void ensureMindsDirWatcher('startup');

  // Watch workspace root for `.minds/` create/delete. This improves responsiveness when `.minds/`
  // appears/disappears without requiring a full polling interval.
  try {
    workspaceWatcher = fs.watch('.', { persistent: false }, (_event, filename) => {
      const name = filename ? filename.toString() : '';
      if (name !== '' && name !== path.dirname(MCP_YAML_PATH)) return;
      void ensureMindsDirWatcher('workspace.watch');
    });
    workspaceWatcher.on('error', () => {
      if (workspaceWatcher) {
        workspaceWatcher.close();
        workspaceWatcher = undefined;
      }
    });
  } catch {
    // ignore; polling still works
  }

  // Polling fallback for reliability (editors that write via rename, platforms where watch misses).
  pollTimer = setInterval(() => {
    void maybePollReload();
    void ensureMindsDirWatcher('poll');
  }, 1500);
}

export function stopMcpSupervisor(): void {
  if (mindsDirWatcher) {
    mindsDirWatcher.close();
    mindsDirWatcher = undefined;
  }
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = undefined;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

export function requestMcpServerRestart(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  return new Promise((resolve) => {
    reloadChain = reloadChain
      .then(async () => {
        try {
          const res = await restartServerNow(serverId);
          resolve(res);
        } catch (err: unknown) {
          const errorText = err instanceof Error ? err.message : String(err);
          log.warn(`MCP server restart failed`, err, { serverId });
          resolve({ ok: false, errorText });
        }
      })
      .catch((err: unknown) => {
        const errorText = err instanceof Error ? err.message : String(err);
        log.warn(`MCP server restart enqueue failed`, err, { serverId });
        resolve({ ok: false, errorText });
      });
  });
}

async function ensureMindsDirWatcher(reason: string): Promise<void> {
  let st: fs.Stats | null = null;
  try {
    st = await fs.promises.stat(path.dirname(MCP_YAML_PATH));
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // `.minds/` may not exist; treat as normal and ensure watcher is detached.
      if (mindsDirWatcher) {
        mindsDirWatcher.close();
        mindsDirWatcher = undefined;
      }
      return;
    }
    return;
  }

  if (!st.isDirectory()) {
    if (mindsDirWatcher) {
      mindsDirWatcher.close();
      mindsDirWatcher = undefined;
    }
    return;
  }

  if (mindsDirWatcher) return;

  try {
    mindsDirWatcher = fs.watch(
      path.dirname(MCP_YAML_PATH),
      { persistent: false },
      (_event, filename) => {
        if (filename && filename.toString() !== path.basename(MCP_YAML_PATH)) return;
        scheduleReload(`minds.watch (${reason})`);
      },
    );
    mindsDirWatcher.on('error', () => {
      // Directory may be wiped/recreated; drop watcher and let polling recreate it.
      if (mindsDirWatcher) {
        mindsDirWatcher.close();
        mindsDirWatcher = undefined;
      }
    });
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // `.minds/` disappeared between stat and watch; normal in dev.
      return;
    }
    // Non-fatal; polling still works.
    log.warn('Failed to start fs.watch for MCP config; polling only', err);
  }
}

function scheduleReload(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    reloadChain = reloadChain
      .then(async () => await reloadNow(reason))
      .catch((err) => {
        log.warn('MCP reload failed', err);
      });
  }, 200);
}

async function maybePollReload(): Promise<void> {
  let mtimeMs: number | undefined;
  try {
    const st = await fs.promises.stat(MCP_YAML_PATH);
    mtimeMs = st.mtimeMs;
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      mtimeMs = 0;
    } else {
      return;
    }
  }
  if (lastSeenMtimeMs === undefined || mtimeMs !== lastSeenMtimeMs) {
    lastSeenMtimeMs = mtimeMs;
    scheduleReload('poll');
  }
}

async function reloadNow(reason: string): Promise<void> {
  let rawText: string;
  try {
    rawText = await fs.promises.readFile(MCP_YAML_PATH, 'utf8');
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // Deletion is treated as empty config.
      await applyWorkspaceConfig(
        { version: 1, servers: {} },
        [],
        [],
        [],
        `missing file (${reason})`,
      );
      clearWorkspaceConfigProblem();
      return;
    }
    upsertWorkspaceConfigProblem(`Failed to read ${MCP_YAML_PATH}: ${String(err)}`);
    return;
  }

  const parsed = parseMcpYaml(rawText);
  if (!parsed.ok) {
    upsertWorkspaceConfigProblem(parsed.errorText);
    return;
  }

  clearWorkspaceConfigProblem();
  await applyWorkspaceConfig(
    parsed.config,
    parsed.invalidServers,
    parsed.serverIdsInYamlOrder,
    parsed.validServerIdsInYamlOrder,
    reason,
  );
}

async function restartServerNow(
  serverId: string,
): Promise<{ ok: true } | { ok: false; errorText: string }> {
  let rawText: string;
  try {
    rawText = await fs.promises.readFile(MCP_YAML_PATH, 'utf8');
  } catch (err: unknown) {
    const code = isRecord(err) && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT') {
      // Deletion is treated as empty config, so restart cannot proceed.
      clearWorkspaceConfigProblem();
      return { ok: false, errorText: `Cannot restart '${serverId}': ${MCP_YAML_PATH} is missing` };
    }
    upsertWorkspaceConfigProblem(`Failed to read ${MCP_YAML_PATH}: ${String(err)}`);
    return { ok: false, errorText: `Failed to read ${MCP_YAML_PATH}: ${String(err)}` };
  }

  const parsed = parseMcpYaml(rawText);
  if (!parsed.ok) {
    upsertWorkspaceConfigProblem(parsed.errorText);
    return { ok: false, errorText: parsed.errorText };
  }

  clearWorkspaceConfigProblem();

  const invalid = parsed.invalidServers.find((s) => s.serverId === serverId);
  if (invalid) {
    upsertProblem({
      kind: 'mcp_server_error',
      source: 'mcp',
      id: `${problemPrefixForServer(serverId)}server_error`,
      severity: 'error',
      timestamp: formatUnifiedTimestamp(new Date()),
      message: `MCP server '${serverId}' failed to parse config`,
      detail: { serverId, errorText: invalid.errorText },
    });
    return { ok: false, errorText: invalid.errorText };
  }

  const serverCfg = parsed.config.servers[serverId];
  if (!serverCfg) {
    return {
      ok: false,
      errorText: `MCP server '${serverId}' is not configured in ${MCP_YAML_PATH}`,
    };
  }

  const desiredToolsetName = serverId;
  const fingerprint = fingerprintServerConfig(serverCfg);
  const existing = serverStateById.get(serverId);

  const res = await tryBuildServerState(serverCfg, desiredToolsetName, fingerprint);
  if (!res.ok) {
    upsertProblem({
      kind: 'mcp_server_error',
      source: 'mcp',
      id: `${problemPrefixForServer(serverId)}server_error`,
      severity: 'error',
      timestamp: formatUnifiedTimestamp(new Date()),
      message: `MCP server '${serverId}' failed to (re)start`,
      detail: { serverId, errorText: res.errorText },
    });
    return { ok: false, errorText: res.errorText };
  }

  removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);

  if (existing) {
    unregisterServer(existing);
    existing.dispatch.requestStop();
  }

  registerServer(res.state);
  serverStateById.set(serverId, res.state);
  reconcileProblemsByPrefix(problemPrefixForServer(serverId), res.state.problems);
  reorderMcpToolsetsInRegistry(parsed.serverIdsInYamlOrder);
  return { ok: true };
}

function upsertWorkspaceConfigProblem(errorText: string): void {
  upsertProblem({
    kind: 'mcp_workspace_config_error',
    source: 'mcp',
    id: 'mcp/workspace_config_error',
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: 'MCP workspace config error',
    detail: { filePath: MCP_YAML_PATH, errorText },
  });
}

function clearWorkspaceConfigProblem(): void {
  removeProblemsByPrefix('mcp/workspace_config_error');
}

async function applyWorkspaceConfig(
  config: McpWorkspaceConfig,
  invalidServers: ReadonlyArray<{ serverId: string; errorText: string }>,
  serverIdsInYamlOrder: ReadonlyArray<string>,
  validServerIdsInYamlOrder: ReadonlyArray<string>,
  reason: string,
): Promise<void> {
  log.info(`Applying MCP workspace config (${reason})`);

  const invalidIds = new Set(invalidServers.map((s) => s.serverId));
  const desiredIds = new Set([...Object.keys(config.servers), ...invalidIds]);

  // Remove deleted servers first.
  for (const [serverId, state] of serverStateById.entries()) {
    if (desiredIds.has(serverId)) continue;
    unregisterServer(state);
    state.dispatch.requestStop();
    serverStateById.delete(serverId);
    removeProblemsByPrefix(problemPrefixForServer(serverId));
  }

  // Surface invalid server config errors (while keeping last-known-good runtimes registered).
  for (const s of invalidServers) {
    upsertProblem({
      kind: 'mcp_server_error',
      source: 'mcp',
      id: `${problemPrefixForServer(s.serverId)}server_error`,
      severity: 'error',
      timestamp: formatUnifiedTimestamp(new Date()),
      message: `MCP server '${s.serverId}' failed to parse config`,
      detail: { serverId: s.serverId, errorText: s.errorText },
    });
  }

  // Apply desired servers independently (deterministic order).
  for (const serverId of validServerIdsInYamlOrder) {
    const serverCfg = config.servers[serverId];
    if (!serverCfg) continue;

    const desiredToolsetName = serverId;
    const fingerprint = fingerprintServerConfig(serverCfg);
    const existing = serverStateById.get(serverId);

    if (!existing || existing.configFingerprint !== fingerprint) {
      const res = await tryBuildServerState(serverCfg, desiredToolsetName, fingerprint);
      if (!res.ok) {
        // Keep last-known-good registration, but surface per-server error.
        upsertProblem({
          kind: 'mcp_server_error',
          source: 'mcp',
          id: `${problemPrefixForServer(serverId)}server_error`,
          severity: 'error',
          timestamp: formatUnifiedTimestamp(new Date()),
          message: `MCP server '${serverId}' failed to (re)load`,
          detail: { serverId, errorText: res.errorText },
        });
        continue;
      }

      // Successful start: replace old runtime/tools.
      removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);
      if (existing) {
        unregisterServer(existing);
        existing.dispatch.requestStop();
      }
      registerServer(res.state);
      serverStateById.set(serverId, res.state);
      reconcileProblemsByPrefix(problemPrefixForServer(serverId), res.state.problems);
      continue;
    }

    // Config unchanged, but recompute desired tool registration to:
    // - auto-clear disappeared problems
    // - re-attempt registering tools that were previously skipped due to collisions
    removeProblemsByPrefix(`${problemPrefixForServer(serverId)}server_error`);
    const rebuilt = buildToolsForServer(serverCfg, existing.dispatch, existing.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: desiredToolsetName,
      configFingerprint: fingerprint,
      cfg: existing.cfg,
      listedTools: existing.listedTools,
      dispatch: existing.dispatch,
      tools: rebuilt.tools,
      ownedToolNames: rebuilt.ownedToolNames,
      problems: rebuilt.problems,
    };

    const sameTools = setsEqual(existing.ownedToolNames, next.ownedToolNames);
    if (!sameTools) {
      unregisterServer(existing);
      registerServer(next);
      serverStateById.set(serverId, next);
    }

    reconcileProblemsByPrefix(problemPrefixForServer(serverId), next.problems);
  }

  // Second pass: after all adds/updates, re-run collision resolution so earlier servers can pick up
  // tools that become available due to later server changes in the same reload cycle.
  for (let i = 0; i < 2; i++) {
    const changed = reconcileCollisionDependentRegistrations(config, validServerIdsInYamlOrder);
    if (!changed) break;
  }

  reorderMcpToolsetsInRegistry(serverIdsInYamlOrder);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function reconcileCollisionDependentRegistrations(
  config: McpWorkspaceConfig,
  serverIds: readonly string[],
): boolean {
  let changedAny = false;

  for (const serverId of serverIds) {
    const serverCfg = config.servers[serverId];
    if (!serverCfg) continue;
    const fingerprint = fingerprintServerConfig(serverCfg);
    const existing = serverStateById.get(serverId);
    if (!existing) continue;
    if (existing.configFingerprint !== fingerprint) continue; // handled by spawn/update path

    const rebuilt = buildToolsForServer(serverCfg, existing.dispatch, existing.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: existing.toolsetName,
      configFingerprint: fingerprint,
      cfg: existing.cfg,
      listedTools: existing.listedTools,
      dispatch: existing.dispatch,
      tools: rebuilt.tools,
      ownedToolNames: rebuilt.ownedToolNames,
      problems: rebuilt.problems,
    };

    const sameTools = setsEqual(existing.ownedToolNames, next.ownedToolNames);
    if (!sameTools) {
      unregisterServer(existing);
      registerServer(next);
      serverStateById.set(serverId, next);
      changedAny = true;
    }

    reconcileProblemsByPrefix(problemPrefixForServer(serverId), next.problems);
  }

  return changedAny;
}

function registerServer(state: ServerState): void {
  for (const t of state.tools) {
    registerTool(t);
    toolOwnerByName.set(t.name, { kind: 'mcp', serverId: state.serverId });
  }
  registerToolset(state.toolsetName, state.tools);
  setToolsetMeta(state.toolsetName, {
    source: 'mcp',
    descriptionI18n: {
      en: `MCP server: ${state.serverId}`,
      zh: `MCP 服务器：${state.serverId}`,
    },
  });
  toolsetOwnerByName.set(state.toolsetName, { kind: 'mcp', serverId: state.serverId });
}

function unregisterServer(state: ServerState): void {
  // Unregister toolset first so Team.Member.listTools doesn't resolve stale tools.
  if (toolsetOwnerByName.get(state.toolsetName)?.serverId === state.serverId) {
    unregisterToolset(state.toolsetName);
    toolsetOwnerByName.delete(state.toolsetName);
  }
  for (const toolName of state.ownedToolNames) {
    if (toolOwnerByName.get(toolName)?.serverId !== state.serverId) continue;
    unregisterTool(toolName);
    toolOwnerByName.delete(toolName);
  }
}

function reorderMcpToolsetsInRegistry(serverIdsInYamlOrder: ReadonlyArray<string>): void {
  const desiredToolsetNames = serverIdsInYamlOrder;

  const currentEntries = Array.from(toolsetsRegistry.entries());
  const nonMcpEntries: Array<[string, Tool[]]> = [];
  const mcpToolsetsByName = new Map<string, Tool[]>();
  const mcpToolsetNamesInCurrentOrder: string[] = [];

  for (const [toolsetName, tools] of currentEntries) {
    const owner = toolsetOwnerByName.get(toolsetName);
    if (owner?.kind === 'mcp') {
      mcpToolsetsByName.set(toolsetName, tools);
      mcpToolsetNamesInCurrentOrder.push(toolsetName);
      continue;
    }
    nonMcpEntries.push([toolsetName, tools]);
  }

  const reordered: Array<[string, Tool[]]> = [...nonMcpEntries];
  const placed = new Set<string>();

  for (const toolsetName of desiredToolsetNames) {
    const tools = mcpToolsetsByName.get(toolsetName);
    if (!tools) continue;
    reordered.push([toolsetName, tools]);
    placed.add(toolsetName);
  }

  for (const toolsetName of mcpToolsetNamesInCurrentOrder) {
    if (placed.has(toolsetName)) continue;
    const tools = mcpToolsetsByName.get(toolsetName);
    if (!tools) continue;
    reordered.push([toolsetName, tools]);
  }

  toolsetsRegistry.clear();
  for (const [toolsetName, tools] of reordered) {
    toolsetsRegistry.set(toolsetName, tools);
  }
}

async function tryBuildServerState(
  cfg: McpServerConfig,
  toolsetName: string,
  fingerprint: string,
): Promise<{ ok: true; state: ServerState } | { ok: false; errorText: string }> {
  const serverId = cfg.serverId;

  // Toolset-name collisions should prevent committing this server.
  const existingToolset = toolsetsRegistry.get(toolsetName);
  const existingOwner = toolsetOwnerByName.get(toolsetName);
  if (existingToolset && (!existingOwner || existingOwner.serverId !== serverId)) {
    return { ok: false, errorText: `Toolset name collision: ${toolsetName}` };
  }

  let client: McpSdkClient | undefined;
  let sharedRuntime: McpServerRuntime | undefined;
  try {
    client =
      cfg.transport === 'stdio'
        ? await McpSdkClient.connectStdio({
            serverId,
            command: cfg.command,
            args: cfg.args,
            env: buildChildEnv(cfg, serverId),
            cwd: process.cwd(),
          })
        : await McpSdkClient.connectStreamableHttp({
            serverId,
            url: cfg.url,
            headers: buildHttpHeaders(cfg, serverId),
            sessionId: cfg.sessionId,
          });

    const listedTools = await client.listTools();
    if (cfg.truelyStateless) {
      sharedRuntime = new McpServerRuntime({ serverId, toolsetName, client });
      client = undefined;
    } else {
      await client.close();
      client = undefined;
    }

    const dispatch = new McpServerDispatch({ serverId, toolsetName, cfg, sharedRuntime });
    const build = buildToolsForServer(cfg, dispatch, listedTools);

    const state: ServerState = {
      serverId,
      toolsetName,
      configFingerprint: fingerprint,
      cfg,
      listedTools,
      dispatch,
      tools: build.tools,
      ownedToolNames: build.ownedToolNames,
      problems: build.problems,
    };
    return { ok: true, state };
  } catch (err: unknown) {
    if (sharedRuntime) {
      sharedRuntime.requestStop({ forceKillAfterMs: 3_000 });
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    return { ok: false, errorText: err instanceof Error ? err.message : String(err) };
  }
}

function buildToolsForServer(
  cfg: McpServerConfig,
  dispatch: McpServerDispatch,
  listedTools: readonly McpListedTool[],
): { tools: Tool[]; ownedToolNames: Set<string>; problems: WorkspaceProblem[] } {
  const serverId = cfg.serverId;
  const problems: WorkspaceProblem[] = [];
  const tools: Tool[] = [];
  const ownedToolNames = new Set<string>();
  const seenDomindsNames = new Set<string>();

  for (const tool of listedTools) {
    const originalName = tool.name;

    if (!isValidProviderToolName(originalName)) {
      log.warn(`Rejecting MCP tool with invalid name`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_invalid_name',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_invalid_name/${originalName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name is invalid and was rejected`,
        detail: { serverId, toolName: originalName, rule: TOOL_NAME_VALIDITY_RULE },
      });
      continue;
    }

    const exposure = decideToolExposure(originalName, cfg.tools);
    if (exposure.kind === 'blacklisted') {
      log.warn(`MCP tool not registered (blacklisted)`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_blacklisted',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_blacklisted/${originalName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool was excluded by blacklist`,
        detail: { serverId, toolName: originalName, pattern: exposure.pattern },
      });
      continue;
    }
    if (exposure.kind === 'not_whitelisted') {
      log.warn(`MCP tool not registered (not whitelisted)`, undefined, {
        serverId,
        toolName: originalName,
      });
      problems.push({
        kind: 'mcp_tool_not_whitelisted',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_not_whitelisted/${originalName}`,
        severity: 'info',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool was excluded by whitelist-only mode`,
        detail: { serverId, toolName: originalName, pattern: exposure.pattern },
      });
      continue;
    }

    const domindsName = applyToolNameTransforms(originalName, cfg.transform);
    if (!isValidProviderToolName(domindsName)) {
      log.warn(`Rejecting MCP tool after transforms due to invalid Dominds tool name`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_invalid_name',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_invalid_name/${originalName}/transformed`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `Dominds tool name produced by transforms is invalid and was rejected`,
        detail: { serverId, toolName: domindsName, rule: TOOL_NAME_VALIDITY_RULE },
      });
      continue;
    }

    if (seenDomindsNames.has(domindsName)) {
      log.warn(`Skipping MCP tool due to within-server name collision`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_collision',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_collision/${domindsName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name collision (after transforms)`,
        detail: { serverId, toolName: originalName, domindsToolName: domindsName },
      });
      continue;
    }

    const existingTool = toolsRegistry.get(domindsName);
    const existingOwner = toolOwnerByName.get(domindsName);
    const canReplace = existingOwner?.serverId === serverId;
    if (existingTool && !canReplace) {
      log.warn(`Skipping MCP tool due to global name collision`, undefined, {
        serverId,
        toolName: originalName,
        domindsToolName: domindsName,
      });
      problems.push({
        kind: 'mcp_tool_collision',
        source: 'mcp',
        id: `${problemPrefixForServer(serverId)}tool_collision/${domindsName}`,
        severity: 'warning',
        timestamp: formatUnifiedTimestamp(new Date()),
        message: `MCP tool name collision with existing tool`,
        detail: { serverId, toolName: originalName, domindsToolName: domindsName },
      });
      continue;
    }

    const func: Tool = {
      type: 'func',
      name: domindsName,
      description: tool.description,
      parameters: tool.inputSchema,
      argsValidation: 'passthrough',
      call: async (dlg, _caller, args: ToolArguments) => {
        return await dispatch.callToolForDialog(dlg, originalName, args);
      },
    };
    tools.push(func);
    ownedToolNames.add(domindsName);
    seenDomindsNames.add(domindsName);
  }

  return { tools, ownedToolNames, problems };
}

function buildChildEnv(cfg: McpServerConfig, serverId: string): Record<string, string> {
  if (cfg.transport !== 'stdio') {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  for (const [k, v] of Object.entries(cfg.env)) {
    switch (v.kind) {
      case 'literal':
        env[k] = v.value;
        break;
      case 'from_env': {
        const val = process.env[v.env];
        if (val === undefined) {
          throw new Error(
            `MCP server '${serverId}' missing required host env var '${v.env}' (for env.${k})`,
          );
        }
        env[k] = val;
        break;
      }
      default: {
        const _exhaustive: never = v;
        throw new Error(`Invalid env mapping kind: ${String(_exhaustive)}`);
      }
    }
  }
  return env;
}

function fingerprintServerConfig(cfg: McpServerConfig): string {
  const obj =
    cfg.transport === 'stdio'
      ? {
          truelyStateless: cfg.truelyStateless,
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          env: sortedEntries(cfg.env),
          tools: cfg.tools,
          transform: cfg.transform,
        }
      : {
          truelyStateless: cfg.truelyStateless,
          transport: cfg.transport,
          url: cfg.url,
          headers: sortedEntries(cfg.headers),
          sessionId: cfg.sessionId ?? null,
          tools: cfg.tools,
          transform: cfg.transform,
        };
  return JSON.stringify(obj);
}

function problemPrefixForServer(serverId: string): string {
  return `mcp/server/${serverId}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildHttpHeaders(
  cfg: McpStreamableHttpServerConfig,
  serverId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) {
    switch (v.kind) {
      case 'literal':
        headers[k] = v.value;
        break;
      case 'from_env': {
        const val = process.env[v.env];
        if (val === undefined) {
          throw new Error(
            `MCP server '${serverId}' missing required host env var '${v.env}' (for headers.${k})`,
          );
        }
        headers[k] = val;
        break;
      }
      default: {
        const _exhaustive: never = v;
        throw new Error(`Invalid header mapping kind: ${String(_exhaustive)}`);
      }
    }
  }
  return headers;
}

function sortedEntries<T extends { kind: string }>(
  obj: Record<string, T>,
): ReadonlyArray<readonly [string, T]> {
  return Object.entries(obj)
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}
