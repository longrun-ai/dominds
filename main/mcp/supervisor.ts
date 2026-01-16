import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../log';
import { reconcileProblemsByPrefix, removeProblemsByPrefix, upsertProblem } from '../problems';
import type { WorkspaceProblem } from '../shared/types/problems';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Tool } from '../tool';
import {
  registerTool,
  registerToolset,
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
  runtime: McpServerRuntime;
  tools: Tool[];
  ownedToolNames: Set<string>;
  problems: WorkspaceProblem[];
};

const serverStateById: Map<string, ServerState> = new Map();
const toolOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();
const toolsetOwnerByName: Map<string, { kind: 'mcp'; serverId: string }> = new Map();

let watcher: fs.FSWatcher | undefined;
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

  // Best-effort file watch (fast feedback). Use directory watch so create/delete works too.
  try {
    watcher = fs.watch(path.dirname(MCP_YAML_PATH), { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== path.basename(MCP_YAML_PATH)) return;
      scheduleReload('fs.watch');
    });
  } catch (err) {
    log.warn('Failed to start fs.watch for MCP config; polling only', err);
  }

  // Polling fallback for reliability (editors that write via rename, platforms where watch misses).
  pollTimer = setInterval(() => {
    void maybePollReload();
  }, 1500);
}

export function stopMcpSupervisor(): void {
  if (watcher) {
    watcher.close();
    watcher = undefined;
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
      await applyWorkspaceConfig({ version: 1, servers: {} }, [], `missing file (${reason})`);
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
  await applyWorkspaceConfig(parsed.config, parsed.invalidServers, reason);
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

  const desiredToolsetName = `mcp_${serverId}`;
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
    existing.runtime.requestStop({ forceKillAfterMs: 3_000 });
  }

  registerServer(res.state);
  serverStateById.set(serverId, res.state);
  reconcileProblemsByPrefix(problemPrefixForServer(serverId), res.state.problems);
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
  reason: string,
): Promise<void> {
  log.info(`Applying MCP workspace config (${reason})`);

  const invalidIds = new Set(invalidServers.map((s) => s.serverId));
  const desiredIds = new Set([...Object.keys(config.servers), ...invalidIds]);

  // Remove deleted servers first.
  for (const [serverId, state] of serverStateById.entries()) {
    if (desiredIds.has(serverId)) continue;
    unregisterServer(state);
    state.runtime.requestStop();
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
  const serverIds = Object.keys(config.servers).sort((a, b) => a.localeCompare(b));
  for (const serverId of serverIds) {
    const serverCfg = config.servers[serverId];
    if (!serverCfg) continue;

    const desiredToolsetName = `mcp_${serverId}`;
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
        existing.runtime.requestStop();
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
    const rebuilt = buildToolsForServer(serverCfg, existing.runtime, existing.runtime.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: desiredToolsetName,
      configFingerprint: fingerprint,
      runtime: existing.runtime,
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
    const changed = reconcileCollisionDependentRegistrations(config, serverIds);
    if (!changed) break;
  }
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

    const rebuilt = buildToolsForServer(serverCfg, existing.runtime, existing.runtime.listedTools);
    const next: ServerState = {
      serverId,
      toolsetName: existing.toolsetName,
      configFingerprint: fingerprint,
      runtime: existing.runtime,
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
    const runtime = new McpServerRuntime({ serverId, toolsetName, client, listedTools });

    const build = buildToolsForServer(cfg, runtime, listedTools);

    const state: ServerState = {
      serverId,
      toolsetName,
      configFingerprint: fingerprint,
      runtime,
      tools: build.tools,
      ownedToolNames: build.ownedToolNames,
      problems: build.problems,
    };
    return { ok: true, state };
  } catch (err: unknown) {
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
  runtime: McpServerRuntime,
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

    const func = runtime.makeFuncTool({
      domindsToolName: domindsName,
      mcpToolName: originalName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
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
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          env: sortedEntries(cfg.env),
          tools: cfg.tools,
          transform: cfg.transform,
        }
      : {
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
