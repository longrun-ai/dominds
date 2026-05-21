import { exec, spawn } from 'child_process';
import fsPromises from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import type { DomindsRuntimeMode, DomindsSelfUpdateStatus } from '@longrun-ai/kernel/types';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import { createLogger } from '../log';
import { DOMINDS_RUNNING_VERSION } from './dominds-running-version';

const execAsync = promisify(exec);
const log = createLogger('dominds-self-update');
const BACKGROUND_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LATEST_VERSION_CHECK_TIMEOUT_MS = 15_000;
const RESTART_PORT_RELEASE_TIMEOUT_MS = 15_000;
const RESTART_PORT_PROBE_INTERVAL_MS = 150;
const COMMAND_OUTPUT_LOG_LIMIT = 2_000;

type ServerMode = 'development' | 'production';
type DomindsSelfUpdateRunKind = 'disabled' | 'npm_global' | 'npx_latest';
type DomindsSelfUpdateAction = 'none' | 'install' | 'restart';
type DomindsSelfUpdateBusy = 'idle' | 'installing' | 'restarting';
type DomindsSelfUpdateReason =
  | 'dev_mode'
  | 'latest_check_failed'
  | 'install_available'
  | 'restart_required'
  | 'restart_available_via_npx'
  | null;

type RuntimeConfig = Readonly<{
  host: string;
  port: number;
  mode: ServerMode;
  stopServer: () => Promise<void>;
}>;

type LatestObservation =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'ok'; latestVersion: string; checkedAt: string }>
  | Readonly<{ kind: 'error'; errorText: string; checkedAt: string }>;

type LatestQueryResult = Exclude<LatestObservation, Readonly<{ kind: 'unknown' }>>;

type CommandFailureDiagnostics = Readonly<{
  message: string;
  cmd: string | null;
  code: string | number | null;
  signal: string | null;
  killed: boolean | null;
  stdout: string;
  stderr: string;
  cwd: string;
  pathEnv: string | null;
}>;

type RestartState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'restart_required'; installedVersion: string; globalCommandAbs: string }>
  | Readonly<{ kind: 'restarting'; targetVersion: string | null }>;

type RestartStdioMode = 'inherit' | 'ignore';

const IDLE_RESTART_STATE: RestartState = { kind: 'idle' };

let runtimeConfig: RuntimeConfig | null = null;
let latestObservation: LatestObservation = { kind: 'unknown' };
let backgroundCheckTimer: ReturnType<typeof setTimeout> | null = null;
let installPromise: Promise<DomindsSelfUpdateStatus> | null = null;
let restartPromise: Promise<DomindsSelfUpdateStatus> | null = null;
let restartState: RestartState = IDLE_RESTART_STATE;
let broadcastStatusUpdate: ((status: DomindsSelfUpdateStatus) => void) | null = null;

function normalizeVersionString(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function splitNumericParts(raw: string): number[] | null {
  const cleaned = normalizeVersionString(raw).split('+')[0]?.split('-')[0]?.trim() ?? '';
  if (cleaned === '') return null;
  const parts = cleaned.split('.');
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    parsed.push(Number(part));
  }
  return parsed;
}

function compareVersions(a: string, b: string): number | null {
  const aParts = splitNumericParts(a);
  const bParts = splitNumericParts(b);
  if (aParts === null || bParts === null) return null;
  const maxLength = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLength; i++) {
    const aValue = aParts[i] ?? 0;
    const bValue = bParts[i] ?? 0;
    if (aValue > bValue) return 1;
    if (aValue < bValue) return -1;
  }
  return 0;
}

function detectRunKind(mode: ServerMode): DomindsSelfUpdateRunKind {
  if (mode !== 'production') return 'disabled';
  const scriptPath = (process.argv[1] ?? '').replace(/\\/g, '/');
  if (scriptPath.includes('/_npx/') && scriptPath.includes('/node_modules/dominds/')) {
    return 'npx_latest';
  }
  return 'npm_global';
}

function hasInteractiveConsole(): boolean {
  return Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
}

function getRestartHelperStdio(): RestartStdioMode {
  return hasInteractiveConsole() ? 'inherit' : 'ignore';
}

function getRestartPortProbeHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function truncateCommandOutput(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length <= COMMAND_OUTPUT_LOG_LIMIT) return raw;
  return `${raw.slice(0, COMMAND_OUTPUT_LOG_LIMIT)}...[truncated ${raw.length - COMMAND_OUTPUT_LOG_LIMIT} chars]`;
}

function formatPathEnvExcerpt(pathEnv: string | null): string | null {
  if (pathEnv === null || pathEnv.trim() === '') return null;
  const parts = pathEnv.split(path.delimiter).filter((part) => part.trim() !== '');
  if (parts.length === 0) return null;
  const visibleParts = parts.slice(0, 8);
  const preview = visibleParts.join(path.delimiter);
  if (parts.length <= visibleParts.length) return preview;
  return `${preview}${path.delimiter}...[+${parts.length - visibleParts.length} more]`;
}

function getErrorProp(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

function extractCommandFailureDiagnostics(error: unknown): CommandFailureDiagnostics {
  const code = getErrorProp(error, 'code');
  const signal = getErrorProp(error, 'signal');
  const killed = getErrorProp(error, 'killed');
  const cmd = getErrorProp(error, 'cmd');
  return {
    message: error instanceof Error ? error.message : String(error),
    cmd: typeof cmd === 'string' && cmd.trim() !== '' ? cmd : null,
    code: typeof code === 'string' || typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' && signal.trim() !== '' ? signal : null,
    killed: typeof killed === 'boolean' ? killed : null,
    stdout: truncateCommandOutput(getErrorProp(error, 'stdout')),
    stderr: truncateCommandOutput(getErrorProp(error, 'stderr')),
    cwd: process.cwd(),
    pathEnv: typeof process.env.PATH === 'string' ? process.env.PATH : null,
  };
}

function formatCommandFailureForUi(diagnostics: CommandFailureDiagnostics): string {
  const lines: string[] = [diagnostics.message];
  if (diagnostics.cmd !== null) {
    lines.push(`cmd: ${diagnostics.cmd}`);
  }
  if (diagnostics.code !== null) {
    lines.push(`exit: ${String(diagnostics.code)}`);
  }
  if (diagnostics.signal !== null) {
    lines.push(`signal: ${diagnostics.signal}`);
  }
  lines.push(`cwd: ${diagnostics.cwd}`);

  if (diagnostics.stderr !== '') {
    lines.push(`stderr: ${diagnostics.stderr}`);
    return lines.join('\n');
  }
  if (diagnostics.stdout !== '') {
    lines.push(`stdout: ${diagnostics.stdout}`);
    return lines.join('\n');
  }

  const pathEnvExcerpt = formatPathEnvExcerpt(diagnostics.pathEnv);
  if (pathEnvExcerpt !== null) {
    lines.push(`PATH: ${pathEnvExcerpt}`);
  }

  const lowerMessage = diagnostics.message.toLowerCase();
  if (
    diagnostics.code === 'ENOENT' ||
    lowerMessage.includes('not recognized as an internal or external command') ||
    lowerMessage.includes('spawn npm enoent')
  ) {
    lines.push('hint: npm is not available to the server process on PATH');
  } else if (
    lowerMessage.includes('econn') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('certificate') ||
    lowerMessage.includes('self signed') ||
    lowerMessage.includes('registry')
  ) {
    lines.push('hint: this looks like a registry, network, proxy, or certificate problem');
  } else if (
    diagnostics.code === 1 &&
    diagnostics.stderr === '' &&
    diagnostics.stdout === ''
  ) {
    lines.push('hint: npm exited without output; check registry access and npm config in the same shell');
  }

  return lines.join('\n');
}

async function queryLatestVersion(): Promise<LatestQueryResult> {
  const checkedAt = formatUnifiedTimestamp(new Date());
  try {
    const { stdout } = await execAsync('npm view dominds version --json', {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: LATEST_VERSION_CHECK_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    if (trimmed === '') {
      log.warn('Dominds latest-version check returned empty stdout', undefined, { checkedAt });
      return {
        kind: 'error',
        errorText: 'npm view dominds version returned empty stdout',
        checkedAt,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      parsed = trimmed;
    }
    const latestVersion = typeof parsed === 'string' ? parsed.trim() : '';
    if (latestVersion === '') {
      log.warn('Dominds latest-version check returned an invalid payload', undefined, {
        checkedAt,
        stdout: trimmed,
      });
      return {
        kind: 'error',
        errorText: `npm view dominds version returned non-string output: ${trimmed}`,
        checkedAt,
      };
    }
    return { kind: 'ok', latestVersion, checkedAt };
  } catch (error: unknown) {
    const diagnostics = extractCommandFailureDiagnostics(error);
    const errorText =
      error instanceof Error && error.name === 'AbortError'
        ? 'npm view dominds version timed out'
        : formatCommandFailureForUi(diagnostics);
    log.warn('Dominds latest-version check failed', error, { checkedAt, errorText, diagnostics });
    return {
      kind: 'error',
      errorText,
      checkedAt,
    };
  }
}

async function resolveGlobalDomindsCommandAbs(): Promise<string> {
  const { stdout } = await execAsync('npm prefix -g', {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const prefix = stdout.trim();
  if (prefix === '') {
    throw new Error('npm prefix -g returned empty output');
  }
  const commandAbs =
    process.platform === 'win32'
      ? path.join(prefix, 'dominds.cmd')
      : path.join(prefix, 'bin', 'dominds');
  await fsPromises.access(commandAbs);
  return commandAbs;
}

function clearBackgroundCheckTimer(): void {
  if (backgroundCheckTimer === null) return;
  clearTimeout(backgroundCheckTimer);
  backgroundCheckTimer = null;
}

function scheduleBackgroundCheck(delayMs: number): void {
  clearBackgroundCheckTimer();
  if (runtimeConfig === null || runtimeConfig.mode !== 'production') return;
  backgroundCheckTimer = setTimeout(() => {
    void runBackgroundCheck();
  }, delayMs);
}

function getRunningVersion(): string {
  return DOMINDS_RUNNING_VERSION;
}

function publishStatusUpdateSoon(): void {
  if (broadcastStatusUpdate === null) return;
  void getDomindsSelfUpdateStatus()
    .then((status) => {
      const publish = broadcastStatusUpdate;
      if (publish === null) return;
      publish(status);
    })
    .catch((error: unknown) => {
      log.warn('Failed to publish Dominds self-update status', error);
    });
}

async function runBackgroundCheck(): Promise<void> {
  try {
    if (runtimeConfig === null || runtimeConfig.mode !== 'production') return;
    if (restartState.kind === 'restart_required' || restartState.kind === 'restarting') return;
    latestObservation = await queryLatestVersion();
    publishStatusUpdateSoon();
  } catch (error: unknown) {
    log.error('Dominds background latest-version check failed', error);
  } finally {
    scheduleBackgroundCheck(BACKGROUND_CHECK_INTERVAL_MS);
  }
}

export async function checkLatestDomindsVersionNow(): Promise<DomindsSelfUpdateStatus> {
  const cfg = assertRuntimeConfig();
  if (cfg.mode !== 'production') {
    return await getDomindsSelfUpdateStatus();
  }
  if (installPromise !== null || restartPromise !== null) {
    return await getDomindsSelfUpdateStatus();
  }
  if (restartState.kind === 'restart_required' || restartState.kind === 'restarting') {
    return await getDomindsSelfUpdateStatus();
  }
  latestObservation = await queryLatestVersion();
  publishStatusUpdateSoon();
  scheduleBackgroundCheck(BACKGROUND_CHECK_INTERVAL_MS);
  return await getDomindsSelfUpdateStatus();
}

function assertRuntimeConfig(): RuntimeConfig {
  if (runtimeConfig === null) {
    throw new Error('Dominds self-update runtime is not configured');
  }
  return runtimeConfig;
}

function buildStatus(params: {
  currentVersion: string;
  installedVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  mode: DomindsRuntimeMode;
  runKind: DomindsSelfUpdateRunKind;
  action: DomindsSelfUpdateAction;
  busy: DomindsSelfUpdateBusy;
  reason: DomindsSelfUpdateReason;
  message: string | null;
  targetVersion: string | null;
}): DomindsSelfUpdateStatus {
  return {
    enabled: params.mode === 'production' && params.runKind !== 'disabled',
    mode: params.mode,
    currentVersion: params.currentVersion,
    installedVersion: params.installedVersion,
    latestVersion: params.latestVersion,
    checkedAt: params.checkedAt,
    runKind: params.runKind,
    action: params.action,
    busy: params.busy,
    reason: params.reason,
    message: params.message,
    targetVersion: params.targetVersion,
  };
}

export function configureDomindsSelfUpdate(params: {
  host: string;
  port: number;
  mode: ServerMode;
  stopServer: () => Promise<void>;
}): void {
  runtimeConfig = {
    host: params.host,
    port: params.port,
    mode: params.mode,
    stopServer: params.stopServer,
  };
  latestObservation = { kind: 'unknown' };
  restartState = IDLE_RESTART_STATE;
  clearBackgroundCheckTimer();
  if (params.mode === 'production') {
    scheduleBackgroundCheck(BACKGROUND_CHECK_INTERVAL_MS);
  }
}

export function setDomindsSelfUpdateBroadcaster(
  next: ((status: DomindsSelfUpdateStatus) => void) | null,
): void {
  broadcastStatusUpdate = next;
}

export async function getDomindsSelfUpdateStatus(): Promise<DomindsSelfUpdateStatus> {
  const cfg = assertRuntimeConfig();
  const runningVersion = getRunningVersion();
  const runKind = detectRunKind(cfg.mode);
  if (runKind === 'disabled') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: null,
      checkedAt: null,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason: 'dev_mode',
      message: 'Self-update is disabled in development mode',
      targetVersion: null,
    });
  }

  if (restartState.kind === 'restart_required') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: restartState.installedVersion,
      latestVersion:
        latestObservation.kind === 'ok'
          ? latestObservation.latestVersion
          : restartState.installedVersion,
      checkedAt: latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'restart',
      busy: 'idle',
      reason: 'restart_required',
      message: 'Latest Dominds is installed and waiting for restart',
      targetVersion: restartState.installedVersion,
    });
  }

  if (restartState.kind === 'restarting') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: restartState.targetVersion ?? runningVersion,
      latestVersion: restartState.targetVersion,
      checkedAt: latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'restart',
      busy: 'restarting',
      reason: 'restart_required',
      message: 'Dominds restart is in progress',
      targetVersion: restartState.targetVersion,
    });
  }

  if (installPromise !== null) {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.kind === 'ok' ? latestObservation.latestVersion : null,
      checkedAt: latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'install',
      busy: 'installing',
      reason: 'install_available',
      message: 'Dominds installation is in progress',
      targetVersion: latestObservation.kind === 'ok' ? latestObservation.latestVersion : null,
    });
  }

  if (restartPromise !== null) {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.kind === 'ok' ? latestObservation.latestVersion : null,
      checkedAt: latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'restart',
      busy: 'restarting',
      reason: 'restart_required',
      message: 'Dominds restart is in progress',
      targetVersion: latestObservation.kind === 'ok' ? latestObservation.latestVersion : null,
    });
  }

  if (latestObservation.kind === 'unknown') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: null,
      checkedAt: null,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason: null,
      message: null,
      targetVersion: null,
    });
  }

  if (latestObservation.kind === 'error') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: null,
      checkedAt: latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason: 'latest_check_failed',
      message: latestObservation.errorText,
      targetVersion: null,
    });
  }

  const comparison = compareVersions(runningVersion, latestObservation.latestVersion);
  const hasUpdate =
    comparison !== null ? comparison < 0 : runningVersion !== latestObservation.latestVersion;
  if (!hasUpdate) {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.latestVersion,
      checkedAt: latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason: null,
      message: null,
      targetVersion: null,
    });
  }

  if (runKind === 'npx_latest') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.latestVersion,
      checkedAt: latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'restart',
      busy: 'idle',
      reason: 'restart_available_via_npx',
      message: 'Restart to relaunch Dominds via npx latest',
      targetVersion: latestObservation.latestVersion,
    });
  }

  return buildStatus({
    currentVersion: runningVersion,
    installedVersion: runningVersion,
    latestVersion: latestObservation.latestVersion,
    checkedAt: latestObservation.checkedAt,
    mode: cfg.mode,
    runKind,
    action: 'install',
    busy: 'idle',
    reason: 'install_available',
    message: 'Latest Dominds is available on npm registry',
    targetVersion: latestObservation.latestVersion,
  });
}

export async function installLatestDominds(): Promise<DomindsSelfUpdateStatus> {
  const cfg = assertRuntimeConfig();
  if (cfg.mode !== 'production') {
    throw new Error('Dominds self-update install is disabled in development mode');
  }
  const runKind = detectRunKind(cfg.mode);
  if (runKind !== 'npm_global') {
    throw new Error(`Install action is not supported for runKind=${runKind}`);
  }
  if (restartState.kind === 'restart_required') {
    return await getDomindsSelfUpdateStatus();
  }
  if (restartState.kind === 'restarting') {
    return await getDomindsSelfUpdateStatus();
  }
  if (installPromise !== null) {
    return await getDomindsSelfUpdateStatus();
  }

  installPromise = (async () => {
    const runningVersion = getRunningVersion();
    const latest = await queryLatestVersion();
    latestObservation = latest;
    if (latest.kind === 'error') {
      throw new Error(latest.errorText);
    }
    const comparison = compareVersions(runningVersion, latest.latestVersion);
    const hasUpdate =
      comparison !== null ? comparison < 0 : runningVersion !== latest.latestVersion;
    if (!hasUpdate) {
      throw new Error('No installable Dominds update is currently available');
    }
    await execAsync('npm i -g dominds@latest', {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    const globalCommandAbs = await resolveGlobalDomindsCommandAbs();
    restartState = {
      kind: 'restart_required',
      installedVersion: latest.latestVersion,
      globalCommandAbs,
    };
    return await getDomindsSelfUpdateStatus();
  })()
    .catch((error: unknown) => {
      const latestVersion =
        latestObservation.kind === 'ok' ? latestObservation.latestVersion : null;
      const checkedAt = latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt;
      log.error('Dominds version install failed', error, {
        runKind,
        currentVersion: getRunningVersion(),
        latestVersion,
        checkedAt,
      });
      throw error;
    })
    .finally(() => {
      installPromise = null;
      publishStatusUpdateSoon();
    });

  publishStatusUpdateSoon();
  return await installPromise;
}

function buildRestartArgs(cfg: RuntimeConfig): string[] {
  return ['webui', '-p', String(cfg.port), '-h', cfg.host, '--mode', 'prod', '--nobrowser'];
}

function spawnDetachedRestartHelper(params: {
  command: string;
  args: readonly string[];
  cwd: string;
  host: string;
  port: number;
}): void {
  const stdioMode = getRestartHelperStdio();
  const helperPayload = JSON.stringify({
    command: params.command,
    args: [...params.args],
    cwd: params.cwd,
    host: getRestartPortProbeHost(params.host),
    port: params.port,
    probeIntervalMs: RESTART_PORT_PROBE_INTERVAL_MS,
    portReleaseTimeoutMs: RESTART_PORT_RELEASE_TIMEOUT_MS,
    stdioMode,
  });
  const helperScript = [
    "const net = require('net');",
    "const { spawn } = require('child_process');",
    'const payload = JSON.parse(process.argv[1]);',
    'const detached = payload.stdioMode !== "inherit" || process.platform === "win32";',
    'function isPortBusy() {',
    '  return new Promise((resolve) => {',
    '    const socket = net.createConnection({ host: payload.host, port: payload.port });',
    '    let settled = false;',
    '    const finish = (busy) => {',
    '      if (settled) return;',
    '      settled = true;',
    '      socket.destroy();',
    '      resolve(busy);',
    '    };',
    '    socket.once("connect", () => finish(true));',
    '    socket.once("error", () => finish(false));',
    '    socket.setTimeout(1000, () => finish(true));',
    '  });',
    '}',
    'async function waitForPortRelease() {',
    '  const deadline = Date.now() + payload.portReleaseTimeoutMs;',
    '  let consecutiveIdle = 0;',
    '  while (Date.now() < deadline) {',
    '    if (await isPortBusy()) {',
    '      consecutiveIdle = 0;',
    '      await new Promise((resolve) => setTimeout(resolve, payload.probeIntervalMs));',
    '      continue;',
    '    }',
    '    consecutiveIdle += 1;',
    '    if (consecutiveIdle >= 2) return;',
    '    await new Promise((resolve) => setTimeout(resolve, payload.probeIntervalMs));',
    '  }',
    '}',
    '(async () => {',
    '  try {',
    '    await waitForPortRelease();',
    "    const child = spawn(payload.command, payload.args, { cwd: payload.cwd, env: process.env, detached, stdio: payload.stdioMode, shell: process.platform === 'win32' });",
    '    if (detached) child.unref();',
    '    process.exit(0);',
    '  } catch (error) {',
    '    console.error(error instanceof Error ? error.message : String(error));',
    '    process.exit(1);',
    '  }',
    '})();',
  ].join('\n');
  const helper = spawn(process.execPath, ['-e', helperScript, helperPayload], {
    cwd: params.cwd,
    env: process.env,
    detached: stdioMode !== 'inherit' || process.platform === 'win32',
    stdio: stdioMode,
  });
  if (stdioMode !== 'inherit' || process.platform === 'win32') {
    helper.unref();
  }
}

async function stopAndExitForRestart(): Promise<void> {
  const cfg = assertRuntimeConfig();
  await cfg.stopServer();
  process.exit(0);
}

export async function restartDomindsIntoLatest(): Promise<DomindsSelfUpdateStatus> {
  const cfg = assertRuntimeConfig();
  if (cfg.mode !== 'production') {
    throw new Error('Dominds restart is disabled in development mode');
  }
  if (restartPromise !== null) {
    return await getDomindsSelfUpdateStatus();
  }
  if (restartState.kind === 'restarting') {
    return await getDomindsSelfUpdateStatus();
  }

  restartPromise = (async () => {
    const status = await getDomindsSelfUpdateStatus();
    if (status.action !== 'restart') {
      throw new Error('No restartable Dominds update is currently available');
    }

    const runKind = detectRunKind(cfg.mode);
    const args = buildRestartArgs(cfg);
    let command: string;
    const previousRestartRequiredState =
      restartState.kind === 'restart_required' ? restartState : null;

    if (runKind === 'npx_latest') {
      command = 'npx';
      args.unshift('dominds@latest');
      args.unshift('-y');
    } else if (previousRestartRequiredState !== null) {
      command = previousRestartRequiredState.globalCommandAbs;
    } else {
      throw new Error('Dominds restart requires a completed install or an npx latest session');
    }

    restartState = { kind: 'restarting', targetVersion: status.targetVersion };
    publishStatusUpdateSoon();
    try {
      spawnDetachedRestartHelper({
        command,
        args,
        cwd: process.cwd(),
        host: cfg.host,
        port: cfg.port,
      });
      setImmediate(() => {
        void stopAndExitForRestart().catch((error: unknown) => {
          log.error('Failed to stop Dominds server during restart', error);
          if (runKind === 'npm_global' && previousRestartRequiredState !== null) {
            restartState = previousRestartRequiredState;
            publishStatusUpdateSoon();
            return;
          }
          restartState = IDLE_RESTART_STATE;
          publishStatusUpdateSoon();
        });
      });
    } catch (error) {
      if (previousRestartRequiredState !== null) {
        restartState = previousRestartRequiredState;
      } else {
        restartState = IDLE_RESTART_STATE;
      }
      publishStatusUpdateSoon();
      throw error;
    }

    return await getDomindsSelfUpdateStatus();
  })()
    .catch((error: unknown) => {
      const statusSnapshot = restartState.kind === 'restarting' ? restartState : null;
      log.error('Dominds version restart failed', error, {
        runKind: detectRunKind(cfg.mode),
        restartState: statusSnapshot,
      });
      throw error;
    })
    .finally(() => {
      restartPromise = null;
      publishStatusUpdateSoon();
    });

  return await restartPromise;
}
