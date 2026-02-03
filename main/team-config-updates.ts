/**
 * Module: team-config-updates
 *
 * Best-effort broadcast when `.minds/team.yaml` changes so multi-tab WebUIs can refresh
 * their cached team config without polling.
 *
 * Notes:
 * - File watching is inherently best-effort (editors may write via rename; some platforms miss events).
 * - We use a polling fallback for reliability, mirroring the MCP supervisor pattern.
 */

import fs from 'fs';
import path from 'path';

import { createLogger } from './log';
import type { TeamConfigUpdatedMessage, WebSocketMessage } from './shared/types/wire';
import { formatUnifiedTimestamp } from './shared/utils/time';

const log = createLogger('team-config-updates');

const MINDS_DIR = '.minds';
const TEAM_YAML_BASENAME = 'team.yaml';
const TEAM_YAML_PATH = path.join(MINDS_DIR, TEAM_YAML_BASENAME);

type TeamYamlSig = {
  sig: string;
  exists: boolean;
};

function isFsErrWithCode(err: unknown): err is { code: string } {
  if (typeof err !== 'object' || err === null) return false;
  const maybe = (err as { code?: unknown }).code;
  return typeof maybe === 'string';
}

async function readTeamYamlSig(): Promise<TeamYamlSig> {
  try {
    const st = await fs.promises.stat(TEAM_YAML_PATH);
    if (!st.isFile()) {
      return { sig: `not_file/${st.size}/${st.mtimeMs}`, exists: false };
    }
    return { sig: `${st.size}/${st.mtimeMs}`, exists: true };
  } catch (err: unknown) {
    if (isFsErrWithCode(err) && err.code === 'ENOENT') {
      return { sig: 'missing', exists: false };
    }
    log.warn('Failed to stat .minds/team.yaml', err);
    return { sig: 'error', exists: false };
  }
}

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

export function setTeamConfigBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
}

function broadcast(msg: TeamConfigUpdatedMessage): void {
  const fn = broadcastToClients;
  if (!fn) return;
  try {
    fn(msg);
  } catch (err: unknown) {
    log.warn('Failed to broadcast team config update', err);
  }
}

let mindsDirWatcher: fs.FSWatcher | undefined;
let workspaceWatcher: fs.FSWatcher | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let lastSeenSig: string | undefined;
let watcherStarted = false;
let checkChain: Promise<void> = Promise.resolve();

function makeUpdateMessage(args: { exists: boolean; trigger: string }): TeamConfigUpdatedMessage {
  return {
    type: 'team_config_updated',
    path: TEAM_YAML_PATH,
    exists: args.exists,
    timestamp: formatUnifiedTimestamp(new Date()),
    trigger: args.trigger,
  };
}

async function checkAndMaybeBroadcast(trigger: string): Promise<void> {
  const state = await readTeamYamlSig();
  if (lastSeenSig === undefined) {
    // Initialize without broadcasting; clients load team config on boot anyway.
    lastSeenSig = state.sig;
    return;
  }
  if (state.sig === lastSeenSig) return;
  lastSeenSig = state.sig;
  broadcast(makeUpdateMessage({ exists: state.exists, trigger }));
}

function scheduleCheck(trigger: string): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  debounceTimer = setTimeout(() => {
    checkChain = checkChain
      .then(async () => await checkAndMaybeBroadcast(trigger))
      .catch((err: unknown) => {
        log.warn('Team config check failed', err);
      });
  }, 150);
}

async function ensureMindsDirWatcher(reason: string): Promise<void> {
  if (mindsDirWatcher) return;

  try {
    mindsDirWatcher = fs.watch(MINDS_DIR, { persistent: false }, (_event, filename) => {
      const name = filename ? filename.toString() : '';
      if (name !== '' && name !== TEAM_YAML_BASENAME) return;
      scheduleCheck(`minds.watch:${reason}`);
    });
    mindsDirWatcher.on('error', () => {
      if (mindsDirWatcher) {
        mindsDirWatcher.close();
        mindsDirWatcher = undefined;
      }
    });
  } catch {
    // ignore; polling still works
  }
}

export function startTeamConfigWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  checkChain = checkChain
    .then(async () => {
      const initial = await readTeamYamlSig();
      lastSeenSig = initial.sig;
    })
    .catch((err: unknown) => {
      log.warn('Initial team config signature read failed', err);
    });

  // Best-effort fast watcher.
  void ensureMindsDirWatcher('startup');

  // Watch workspace root for `.minds/` create/delete.
  try {
    workspaceWatcher = fs.watch('.', { persistent: false }, (_event, filename) => {
      const name = filename ? filename.toString() : '';
      if (name !== '' && name !== MINDS_DIR) return;
      void ensureMindsDirWatcher('workspace.watch');
      scheduleCheck('workspace.watch');
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

  // Polling fallback for reliability.
  pollTimer = setInterval(() => {
    void ensureMindsDirWatcher('poll');
    scheduleCheck('poll');
  }, 1500);
}

/**
 * Explicit notification hook for code paths that are known to mutate `.minds/team.yaml`.
 *
 * This is used for the setup flow so the UI updates immediately even if file watch is flaky.
 */
export function notifyTeamConfigUpdated(trigger: string): void {
  checkChain = checkChain
    .then(async () => {
      const state = await readTeamYamlSig();
      lastSeenSig = state.sig;
      broadcast(makeUpdateMessage({ exists: state.exists, trigger }));
    })
    .catch((err: unknown) => {
      log.warn('Failed to notify team config updated', err);
    });
}
